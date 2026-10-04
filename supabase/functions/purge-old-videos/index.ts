// 保存期間（3か月）を過ぎたお客様の動画ファイルを削除する
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
const RETENTION_MONTHS = 3;
const BATCH = 100;

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
  try {
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
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "削除に失敗しました", deleted }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ deleted }), { headers: { "Content-Type": "application/json" } });
});
