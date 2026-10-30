// 保存期間（3か月）を過ぎたお客様の動画ファイルを削除する
// あわせて、削除を申し込んでから30日が過ぎたアカウントを、動画・記録ごと完全に削除する
// 1日1回、データベースの定期実行（pg_cron）から呼び出す。手順は docs/SETUP.md を参照。
// デプロイ時は JWT 検証を無効にする: supabase functions deploy purge-old-videos --no-verify-jwt
// （代わりに CRON_SECRET で呼び出し元を確認している）
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const BUCKET = "swing-videos";
const LESSON_BUCKET = "lesson-videos"; // コーチの解説動画（レッスンとして見返せるよう、半年で削除）
const LESSON_RETENTION_MONTHS = 6;
const RETENTION_MONTHS = 3;
const BATCH = 100;
const DELETE_AFTER_DAYS = 30;

type Db = ReturnType<typeof createClient>;

// 削除の申し込みから30日が過ぎたアカウントを削除する
async function purgeAccounts(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - DELETE_AFTER_DAYS * 86400000).toISOString();
  const { data: members, error } = await db.from("profiles").select("id, stripe_customer_id")
    .lt("deletion_requested_at", cutoff).neq("role", "admin").limit(20);
  if (error) throw error;
  let count = 0;
  for (const m of members ?? []) {
    try {
      // 念のため、続いている月額の契約があれば止める（通常は削除の前に解約済み）
      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (m.stripe_customer_id && stripeKey) {
        const res = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${m.stripe_customer_id}&status=all&limit=20`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        const subs = (await res.json()).data ?? [];
        for (const s of subs) {
          if (!["canceled", "incomplete_expired"].includes(s.status)) {
            await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${stripeKey}` } });
          }
        }
      }
      // 動画ファイル（会員ごとのフォルダ）をすべて削除（送った動画・コーチの解説動画）
      for (const bucket of [BUCKET, LESSON_BUCKET]) {
        for (;;) {
          const { data: files, error: le } = await db.storage.from(bucket).list(m.id, { limit: BATCH });
          if (le) throw le;
          if (!files?.length) break;
          const { error: re } = await db.storage.from(bucket).remove(files.map((f) => `${m.id}/${f.name}`));
          if (re) throw re;
          if (files.length < BATCH) break;
        }
      }
      // 再登録のときに分かるよう、メールアドレスのハッシュだけ残してから削除（記録はすべて一緒に消える）
      const { error: fe } = await db.rpc("remember_former_member", { p_member: m.id });
      if (fe) throw fe;
      const { error: de } = await db.auth.admin.deleteUser(m.id);
      if (de) throw de;
      count++;
    } catch (e) {
      console.error(`アカウントを削除できませんでした: ${m.id}`, e);
    }
  }
  return count;
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== requireEnv("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

  const db = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  let deleted = 0;
  let accounts = 0;
  try {
    accounts = await purgeAccounts(db);
    for (;;) {
      const { data: rows, error } = await db
        .from("submissions")
        .select("id, video_path")
        .is("video_deleted_at", null)
        .lt("created_at", cutoff.toISOString())
        .order("created_at")
        .limit(BATCH);
      if (error) throw error;
      if (!rows?.length) break;

      const { error: removeError } = await db.storage.from(BUCKET).remove(rows.map((r) => r.video_path));
      if (removeError) throw removeError;

      const { error: updateError } = await db
        .from("submissions")
        .update({ video_deleted_at: new Date().toISOString() })
        .in("id", rows.map((r) => r.id));
      if (updateError) throw updateError;

      deleted += rows.length;
      if (rows.length < BATCH) break;
    }
    // コーチの解説動画（レッスンを送ってから半年）。データベースが未更新なら何もしない
    const lessonCutoff = new Date();
    lessonCutoff.setMonth(lessonCutoff.getMonth() - LESSON_RETENTION_MONTHS);
    for (;;) {
      const { data: rows, error } = await db
        .from("lessons")
        .select("id, coach_video_path")
        .not("coach_video_path", "is", null)
        .is("coach_video_deleted_at", null)
        .lt("created_at", lessonCutoff.toISOString())
        .order("created_at")
        .limit(BATCH);
      if (error) { console.warn("解説動画の削除をスキップしました", error.message); break; }
      if (!rows?.length) break;
      const { error: removeError } = await db.storage.from(LESSON_BUCKET).remove(rows.map((r) => r.coach_video_path));
      if (removeError) throw removeError;
      const { error: updateError } = await db
        .from("lessons")
        .update({ coach_video_deleted_at: new Date().toISOString() })
        .in("id", rows.map((r) => r.id));
      if (updateError) throw updateError;
      deleted += rows.length;
      if (rows.length < BATCH) break;
    }
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "削除に失敗しました", deleted, accounts }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ deleted, accounts }), { headers: { "Content-Type": "application/json" } });
});
