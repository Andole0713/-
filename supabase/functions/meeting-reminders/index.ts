// 面談の前日に、会員へお知らせメールを送る
// 1日1回、データベースの定期実行（pg_cron）から呼び出す。手順は docs/SETUP.md を参照。
// デプロイ時は JWT 検証を無効にする: supabase functions deploy meeting-reminders --no-verify-jwt
// （代わりに CRON_SECRET で呼び出し元を確認している）
import { db, jstWhen, requireEnv, sendMail } from "../_shared/mail.ts";

const JST = 9 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== requireEnv("CRON_SECRET")) return new Response("unauthorized", { status: 401 });

  // 日本時間で「明日」の 0:00〜24:00
  const nowJst = new Date(Date.now() + JST);
  const start = new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() + 1) - JST);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const client = db();
  const { data: rows, error } = await client
    .from("profiles")
    .select("id, name, email, next_meeting_at, meeting_reminded_for")
    .eq("email_notify", true)
    .not("email", "is", null)
    .gte("next_meeting_at", start.toISOString())
    .lt("next_meeting_at", end.toISOString());
  if (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "読み込みに失敗しました" }), { status: 500 });
  }

  let sent = 0;
  const failed: string[] = [];
  for (const p of rows ?? []) {
    if (p.meeting_reminded_for && new Date(p.meeting_reminded_for).getTime() === new Date(p.next_meeting_at).getTime()) continue;
    try {
      await sendMail({
        to: p.email,
        name: p.name,
        subject: "明日はオンライン面談の日です",
        lines: [
          "明日はオンライン面談の日です。",
          `日時：${jstWhen(p.next_meeting_at)}`,
          "時間になりましたら、ご案内した方法でご参加ください。日時の変更はLINEでご連絡ください。",
        ],
        button: "会員ページを開く",
        path: "#/home",
      });
      await client.from("profiles").update({ meeting_reminded_for: p.next_meeting_at }).eq("id", p.id);
      sent++;
    } catch (e) {
      console.error(e);
      failed.push(p.id);
    }
  }
  return new Response(JSON.stringify({ sent, failed: failed.length }), { headers: { "Content-Type": "application/json" } });
});
