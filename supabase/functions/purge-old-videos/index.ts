// 保存期間（3か月）を過ぎたお客様の動画ファイルを削除する
//   ・コーチがまだ確認していない動画（status = pending）と、お気に入りの動画は削除しない
// あわせて、削除を申し込んでから30日が過ぎたアカウントを、動画・記録ごと完全に削除する
// あわせて、どの提出にも使われていない動画ファイル（アップロード後に送信されなかったもの）を、24時間後に削除する
// 実行の結果は job_runs に記録する（管理画面に表示。失敗があれば ok = false）
// 1日1回、データベースの定期実行（pg_cron）から呼び出す。手順は docs/SETUP.md を参照。
// デプロイ時は JWT 検証を無効にする: supabase functions deploy purge-old-videos --no-verify-jwt
// （代わりに CRON_SECRET で呼び出し元を確認している）
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

const JOB = "purge-old-videos";
const BUCKET = "swing-videos";
const LESSON_BUCKET = "lesson-videos"; // コーチの解説動画（レッスンとして見返せるよう、半年で削除）
const LESSON_RETENTION_MONTHS = 6;
const RETENTION_MONTHS = 3;
const BATCH = 100;
const DELETE_AFTER_DAYS = 30;
const ORPHAN_AFTER_MS = 24 * 3600 * 1000; // 使われていないファイルは、アップロードから24時間たってから削除
const ORPHAN_MAX_PER_RUN = 500;            // 1回に削除する使われていないファイルの上限（念のため）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Db = SupabaseClient;

const errText = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e)).slice(0, 200);

// 削除の申し込みから30日が過ぎたアカウントを削除する
async function purgeAccounts(db: Db, failures: string[]): Promise<number> {
  const cutoff = new Date(Date.now() - DELETE_AFTER_DAYS * 86400000).toISOString();
  const { data: members, error } = await db.from("profiles").select("id, stripe_customer_id")
    .lt("deletion_requested_at", cutoff).neq("role", "admin").limit(20);
  if (error) throw error;
  let count = 0;
  for (const m of (members ?? []) as { id: string; stripe_customer_id: string | null }[]) {
    try {
      // 念のため、続いている月額の契約があれば止める（通常は削除の前に解約済み）
      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (m.stripe_customer_id && stripeKey) {
        const res = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${m.stripe_customer_id}&status=all&limit=20`, {
          headers: { Authorization: `Bearer ${stripeKey}` },
        });
        if (!res.ok) throw new Error(`Stripe の契約を確認できませんでした（${res.status}）`);
        const subs = (await res.json()).data ?? [];
        for (const s of subs) {
          if (!["canceled", "incomplete_expired"].includes(s.status)) {
            const del = await fetch(`https://api.stripe.com/v1/subscriptions/${s.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${stripeKey}` } });
            if (!del.ok) throw new Error(`Stripe の契約を止められませんでした（${del.status}）`);
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
      failures.push(`アカウント削除に失敗（${m.id.slice(0, 8)}）：${errText(e)}`);
    }
  }
  return count;
}

// どの提出（submissions.video_path）にも使われていない動画ファイルを削除する
//   ・会員ID（UUID）のフォルダの中だけを見る。アップロードから24時間たっていないものは残す
//   ・提出に使われているファイルは、動画の削除済み・未削除にかかわらず絶対に削除しない
async function purgeOrphans(db: Db): Promise<number> {
  const cutoff = Date.now() - ORPHAN_AFTER_MS;
  const folders: string[] = [];
  for (let offset = 0; ; offset += BATCH) {
    const { data, error } = await db.storage.from(BUCKET).list("", { limit: BATCH, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    for (const f of data ?? []) {
      if (!f.id && UUID_RE.test(f.name)) folders.push(f.name); // id がないものがフォルダ
    }
    if (!data || data.length < BATCH) break;
  }

  let removed = 0;
  for (const folder of folders) {
    // 先に一覧をすべて読んでから削除する（読みながら消すと、ページの位置がずれて読み飛ばすため）
    const old: string[] = [];
    for (let offset = 0; ; offset += BATCH) {
      const { data, error } = await db.storage.from(BUCKET).list(folder, { limit: BATCH, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      for (const f of data ?? []) {
        if (!f.id || f.name.startsWith(".")) continue; // フォルダ・.emptyFolderPlaceholder など
        const t = Date.parse(f.created_at ?? "");
        if (Number.isFinite(t) && t < cutoff) old.push(`${folder}/${f.name}`);
      }
      if (!data || data.length < BATCH) break;
    }
    for (let i = 0; i < old.length; i += BATCH) {
      const chunk = old.slice(i, i + BATCH);
      const { data: refs, error } = await db.from("submissions").select("video_path").in("video_path", chunk);
      if (error) throw error;
      const used = new Set((refs ?? []).map((r) => r.video_path as string));
      const orphans = chunk.filter((p) => !used.has(p)).slice(0, ORPHAN_MAX_PER_RUN - removed);
      if (!orphans.length) continue;
      const { error: re } = await db.storage.from(BUCKET).remove(orphans);
      if (re) throw re;
      removed += orphans.length;
      if (removed >= ORPHAN_MAX_PER_RUN) return removed;
    }
  }
  return removed;
}

async function recordRun(db: Db, ok: boolean, detail: string) {
  const { error } = await db.from("job_runs").insert({ job: JOB, ok, detail: detail.slice(0, 2000) });
  if (error) console.error("実行の記録を保存できませんでした", error);
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
  let coachDeleted = 0;
  let orphans = 0;
  let accounts = 0;
  const failures: string[] = [];

  // 1. 削除を申し込んで30日が過ぎたアカウント（1人ずつ。失敗しても次の人・次の処理へ進む）
  try {
    accounts = await purgeAccounts(db, failures);
  } catch (e) {
    console.error(e);
    failures.push(`アカウント削除の確認に失敗：${errText(e)}`);
  }

  // 2. 保存期間（3か月）を過ぎた動画（コーチが確認済みのものだけ。確認待ち・お気に入りは残す）
  try {
    for (;;) {
      const { data: rows, error } = await db
        .from("submissions")
        .select("id, video_path")
        .is("video_deleted_at", null)
        .is("favorite_at", null) // 会員がお気に入りにした動画（3つまで）は消さない
        .eq("status", "reviewed") // まだ確認していない（返信していない）動画は消さない
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
  } catch (e) {
    console.error(e);
    failures.push(`古い動画の削除に失敗：${errText(e)}`);
  }

  // 3. コーチの解説動画（レッスンを送ってから半年）
  try {
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
      if (error) throw error;
      if (!rows?.length) break;
      const { error: removeError } = await db.storage.from(LESSON_BUCKET).remove(rows.map((r) => r.coach_video_path));
      if (removeError) throw removeError;
      const { error: updateError } = await db
        .from("lessons")
        .update({ coach_video_deleted_at: new Date().toISOString() })
        .in("id", rows.map((r) => r.id));
      if (updateError) throw updateError;
      coachDeleted += rows.length;
      if (rows.length < BATCH) break;
    }
  } catch (e) {
    console.error(e);
    failures.push(`解説動画の削除に失敗：${errText(e)}`);
  }

  // 4. どの提出にも使われていない動画ファイル（24時間以上前のもの）
  try {
    orphans = await purgeOrphans(db);
  } catch (e) {
    console.error(e);
    failures.push(`使われていないファイルの削除に失敗：${errText(e)}`);
  }

  const ok = failures.length === 0;
  const summary = `動画 ${deleted}件・解説動画 ${coachDeleted}件・使われていないファイル ${orphans}件・アカウント ${accounts}件を削除`;
  await recordRun(db, ok, ok ? summary : `${summary}／失敗 ${failures.length}件：${failures.join("／")}`);

  const body = { deleted: deleted + coachDeleted, orphans, accounts, ...(ok ? {} : { error: "一部の削除に失敗しました", failures }) };
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
