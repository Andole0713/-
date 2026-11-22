// スタッフがコンシェルジュサポートで連絡したときに、会員へ「連絡が届きました」とメールで知らせる
// 管理者のログイン情報で呼び出す（管理画面で送ると自動で呼ばれる）。
// 同じ会員には1時間に1通まで（concierge_messages.emailed_at で確認）。お知らせメールを止めている会員には送らない。
// デプロイ: supabase functions deploy notify-concierge
import { db, requireEnv, sendMail, siteUrl } from "../_shared/mail.ts";

const THROTTLE_MS = 60 * 60 * 1000;

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": new URL(siteUrl()).origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    requireEnv("RESEND_API_KEY");
    const client = db();
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const { data: auth } = token ? await client.auth.getUser(token) : { data: { user: null } };
    if (!auth.user) return json({ error: "ログインが必要です" }, 401);
    const { data: me } = await client.from("profiles").select("role").eq("id", auth.user.id).single();
    if (me?.role !== "admin") return json({ error: "管理者のみ実行できます" }, 403);

    const { message_id } = await req.json().catch(() => ({}));
    if (typeof message_id !== "string") return json({ error: "連絡が指定されていません" }, 400);
    const { data: msg } = await client
      .from("concierge_messages")
      .select("id, member_id, from_staff, emailed_at, profiles!member_id(name, email, email_notify)")
      .eq("id", message_id)
      .single();
    const member = msg?.profiles as { name: string; email: string | null; email_notify: boolean } | null;
    if (!msg || !member) return json({ error: "連絡が見つかりません" }, 404);
    if (!msg.from_staff) return json({ error: "スタッフからの連絡ではありません" }, 400);
    if (msg.emailed_at) return json({ sent: false, reason: "この連絡はメールで知らせ済みです" });
    if (!member.email || !member.email_notify) return json({ sent: false, reason: "この会員はお知らせメールを止めています" });

    // 1時間以内に、この会員へメールで知らせていたら送らない（続けて送ったときにメールが何通も届かないように）
    const { count } = await client
      .from("concierge_messages")
      .select("id", { count: "exact", head: true })
      .eq("member_id", msg.member_id)
      .gte("emailed_at", new Date(Date.now() - THROTTLE_MS).toISOString());
    if ((count ?? 0) > 0) return json({ sent: false, reason: "1時間以内にメールで知らせているため、メールは送っていません" });

    await sendMail({
      to: member.email,
      name: member.name,
      subject: "コンシェルジュサポートに連絡が届きました",
      lines: [
        "コンシェルジュサポートに、スタッフから連絡が届きました。",
        "内容は会員ページの「コンシェルジュサポート」でご確認ください。",
      ],
      button: "連絡を見る",
      path: "#/concierge",
    });
    await client.from("concierge_messages").update({ emailed_at: new Date().toISOString() }).eq("id", msg.id);
    return json({ sent: true });
  } catch (e) {
    console.error(e);
    return json({ error: "メールを送信できませんでした" }, 500);
  }
});
