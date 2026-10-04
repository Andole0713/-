// コーチがレッスンを保存したときに、会員へ「新しいレッスンが届きました」とメールで知らせる
// 管理者のログイン情報で呼び出す（会員ページの管理画面から自動で呼ばれる）
import { db, requireEnv, sendMail, siteUrl } from "../_shared/mail.ts";

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

    const { lesson_id } = await req.json().catch(() => ({}));
    if (typeof lesson_id !== "string") return json({ error: "レッスンが指定されていません" }, 400);
    const { data: lesson } = await client
      .from("lessons")
      .select("id, title, point, profiles(name, email, email_notify)")
      .eq("id", lesson_id)
      .single();
    const member = lesson?.profiles as { name: string; email: string | null; email_notify: boolean } | null;
    if (!lesson || !member) return json({ error: "レッスンが見つかりません" }, 404);
    if (!member.email || !member.email_notify) return json({ sent: false, reason: "お知らせメール停止中" });

    await sendMail({
      to: member.email,
      name: member.name,
      subject: "新しいレッスンが届きました",
      lines: [
        "コーチから新しいレッスンが届きました。",
        `「${lesson.title}」`,
        ...(lesson.point ? [`今回の診断：${lesson.point}`] : []),
        "解説動画とフィードバックを会員ページでご確認ください。",
      ],
      button: "レッスンを見る",
      path: `#/lesson/${lesson.id}`,
    });
    return json({ sent: true });
  } catch (e) {
    console.error(e);
    return json({ error: "メールを送信できませんでした" }, 500);
  }
});
