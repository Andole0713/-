// 面談の前日に、会員へお知らせメールを送る
// 1日1回、データベースの定期実行（pg_cron）から呼び出す。手順は docs/SETUP.md を参照。
// デプロイ時は JWT 検証を無効にする: supabase functions deploy meeting-reminders --no-verify-jwt
// （代わりに CRON_SECRET で呼び出し元を確認している）
// 面談ごとに送った日時（meetings.reminded_at）を残すので、同じ面談に二重には送らない。
// 日時を変えた面談は、アプリ側で reminded_at を空に戻すので、新しい日時でもう一度送る。
import { db, jstWhen, requireEnv, sendMail } from "../_shared/mail.ts";

const JST = 9 * 60 * 60 * 1000;

type Member = { name: string; email: string | null; email_notify: boolean };
type Row = {
  id: string;
  scheduled_at: string;
  duration_min: number | null;
  join_url: string | null;
  join_info: string | null;
  pre_at: string | null;
  profiles: Member | null;
};

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== requireEnv("CRON_SECRET")) return new Response("unauthorized", { status: 401 });

  // 日本時間で「明日」の 0:00〜24:00
  const nowJst = new Date(Date.now() + JST);
  const start = new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() + 1) - JST);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const client = db();
  // 会員の「次回の面談」（profiles.next_meeting_at）は古いままのことがあるので、面談の予定を直接見る
  const { data, error } = await client
    .from("meetings")
    .select("id, scheduled_at, duration_min, join_url, join_info, pre_at, profiles!member_id(name, email, email_notify)")
    .eq("status", "scheduled")
    .is("reminded_at", null)
    .gte("scheduled_at", start.toISOString())
    .lt("scheduled_at", end.toISOString())
    .order("scheduled_at");
  if (error) {
    console.error(error);
    await logRun(client, false, `読み込みに失敗：${error.message}`);
    return new Response(JSON.stringify({ error: "読み込みに失敗しました" }), { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const m of (data ?? []) as unknown as Row[]) {
    const p = m.profiles;
    if (!p?.email || !p.email_notify) { skipped++; continue; }
    const info = (m.join_info || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const preOpen = !m.pre_at;
    try {
      await sendMail({
        to: p.email,
        name: p.name,
        subject: "明日はオンライン面談の日です",
        lines: [
          "明日はオンライン面談の日です。",
          `日時：${jstWhen(m.scheduled_at)}〜${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(new Date(m.scheduled_at).getTime() + (m.duration_min || 20) * 60000))}（${m.duration_min || 20}分）`,
          ...(m.join_url ? [`参加リンク（Zoom）：${m.join_url}`] : []),
          ...info,
          ...(m.join_url ? ["開始5分前から入室できます。"] : ["参加の方法は、会員ページの「次回の面談」をご確認ください。"]),
          ...(preOpen
            ? ["面談の前に、事前アンケート（3分ほど）へのご回答をお願いします。下のボタンから答えられます。"]
            : ["事前アンケートへのご回答、ありがとうございました。"]),
          "日時の変更は、hacomono またはLINEでご連絡ください。",
        ],
        button: preOpen ? "事前アンケートに答える" : "会員ページを開く",
        path: preOpen ? `#/meeting-pre/${m.id}` : "#/home",
      });
      await client.from("meetings").update({ reminded_at: new Date().toISOString() }).eq("id", m.id);
      sent++;
    } catch (e) {
      console.error(e);
      failed.push(m.id);
    }
  }
  await logRun(client, failed.length === 0, `送信 ${sent}件・送らない ${skipped}件・失敗 ${failed.length}件`);
  return new Response(JSON.stringify({ sent, skipped, failed: failed.length }), { headers: { "Content-Type": "application/json" } });
});

// 自動の処理の記録（job_runs がない環境では何もしない）
async function logRun(client: ReturnType<typeof db>, ok: boolean, detail: string) {
  try {
    await client.from("job_runs").insert({ job: "meeting-reminders", ok, detail });
  } catch { /* noop */ }
}
