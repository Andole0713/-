// スタッフへのまとめメール（1日2回：11:00・17:00 日本時間）
// 新しく届いた動画・返信目標（48時間）を過ぎた動画・コンシェルジュのお返事待ち・動画の取り消し依頼・結果が未入力の面談の数を、
// スタッフ（profiles.role = 'admin'、メールあり・お知らせメールを止めていない人）に送る。どれも0件なら送らない。
// データベースの定期実行（pg_cron）から呼び出す。手順は docs/SETUP.md を参照。
// デプロイ時は JWT 検証を無効にする: supabase functions deploy staff-digest --no-verify-jwt
// （代わりに CRON_SECRET で呼び出し元を確認している）
import { db, requireEnv, sendMail } from "../_shared/mail.ts";

const REPLY_TARGET_H = 48; // 動画の返信目標（app.js の REPLY_TARGET_H と同じ）
const MEETING_MIN = 20; // 面談の長さが入っていないときの長さ
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

type Client = ReturnType<typeof db>;
type Msg = { member_id: string; from_staff: boolean; is_auto: boolean | null; created_at: string };

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== requireEnv("CRON_SECRET")) return new Response("unauthorized", { status: 401 });
  const client = db();
  try {
    const now = Date.now();
    // 前回のまとめを送った日時（はじめては12時間前から）
    const { data: last } = await client.from("staff_digests").select("sent_at").order("sent_at", { ascending: false }).limit(1);
    const since = last?.[0]?.sent_at ?? new Date(now - 12 * HOUR).toISOString();

    const head = { count: "exact" as const, head: true };
    const [newVideos, overdue, cancelReq, meetings, ccWait] = await Promise.all([
      client.from("submissions").select("id", head).gt("created_at", since),
      client.from("submissions").select("id", head).eq("status", "pending").lt("created_at", new Date(now - REPLY_TARGET_H * HOUR).toISOString()),
      client.from("submissions").select("id", head).eq("status", "pending").not("cancel_requested_at", "is", null),
      client.from("meetings").select("scheduled_at, duration_min").eq("status", "scheduled")
        .gte("scheduled_at", new Date(now - 45 * DAY).toISOString()).lt("scheduled_at", new Date(now).toISOString()),
      conciergePending(client),
    ]);
    for (const r of [newVideos, overdue, cancelReq, meetings]) if (r.error) throw r.error;
    // 結果が未入力の面談：始まる時刻＋面談の長さを過ぎても「予定」のまま（アプリと同じ決まり）
    const lateMeetings = (meetings.data ?? []).filter((m) => new Date(m.scheduled_at).getTime() + (m.duration_min || MEETING_MIN) * 60000 < now).length;

    const counts = {
      new_videos: newVideos.count ?? 0,
      overdue_videos: overdue.count ?? 0,
      concierge_waiting: ccWait,
      cancel_requests: cancelReq.count ?? 0,
      late_meetings: lateMeetings,
    };
    if (Object.values(counts).every((n) => n === 0)) {
      await logRun(client, true, "すべて0件のため送っていません");
      return Response.json({ sent: 0, skipped: "all zero", counts });
    }

    const { data: staff, error: staffErr } = await client.from("profiles").select("name, email")
      .eq("role", "admin").eq("email_notify", true).not("email", "is", null);
    if (staffErr) throw staffErr;

    const line = (label: string, n: number, unit: string) => `・${label}：${n}${unit}${n ? "" : "（なし）"}`;
    const lines = [
      "スタッフ向けのまとめです。",
      line("前回のまとめから新しく届いた動画", counts.new_videos, "本"),
      line(`返信目標（${REPLY_TARGET_H}時間）を過ぎた動画`, counts.overdue_videos, "本"),
      line("コンシェルジュサポートのお返事待ち", counts.concierge_waiting, "件"),
      line("動画の取り消し依頼", counts.cancel_requests, "件"),
      line("結果が未入力の面談", counts.late_meetings, "件"),
      "くわしくは、管理画面の「やること」で確認してください。",
    ];
    let sent = 0;
    const failed: string[] = [];
    for (const s of staff ?? []) {
      try {
        await sendMail({ to: s.email!, name: s.name || "スタッフ", subject: "スタッフ向けのまとめ（やること）", lines, button: "やることを開く", path: "#/admin/dashboard" });
        sent++;
      } catch (e) {
        console.error(e);
        failed.push(s.email!);
      }
    }
    if (sent) await client.from("staff_digests").insert({ counts });
    await logRun(client, failed.length === 0, `送信 ${sent}件・失敗 ${failed.length}件 ${JSON.stringify(counts)}`);
    return Response.json({ sent, failed: failed.length, counts });
  } catch (e) {
    console.error(e);
    await logRun(client, false, String((e as Error)?.message ?? e).slice(0, 500));
    return Response.json({ error: "まとめを作れませんでした" }, { status: 500 });
  }
});

// コンシェルジュサポートのお返事待ちの数（アプリの ccPending と同じ決まり）
// 会員の最後の連絡が、スタッフの最後の返信（自動の連絡は数えない）と「対応不要」にした日時より新しい会員
async function conciergePending(client: Client): Promise<number> {
  const msgs: Msg[] = [];
  const from = new Date(Date.now() - 60 * DAY).toISOString();
  for (let i = 0; i < 200; i++) {
    const { data, error } = await client.from("concierge_messages").select("member_id, from_staff, is_auto, created_at")
      .gte("created_at", from).order("created_at").range(i * 1000, i * 1000 + 999);
    if (error) throw error;
    msgs.push(...((data ?? []) as Msg[]));
    if (!data || data.length < 1000) break;
  }
  const { data: threads } = await client.from("concierge_threads").select("member_id, done_at");
  const done = new Map((threads ?? []).filter((t) => t.done_at).map((t) => [t.member_id as string, new Date(t.done_at).getTime()]));
  const lastMember = new Map<string, number>();
  const lastStaff = new Map<string, number>();
  for (const m of msgs) {
    if (m.is_auto) continue;
    (m.from_staff ? lastStaff : lastMember).set(m.member_id, new Date(m.created_at).getTime());
  }
  let n = 0;
  for (const [id, t] of lastMember) if (t > Math.max(lastStaff.get(id) ?? 0, done.get(id) ?? 0)) n++;
  return n;
}

// 自動の処理の記録（job_runs がない環境では何もしない）
async function logRun(client: Client, ok: boolean, detail: string) {
  try {
    await client.from("job_runs").insert({ job: "staff-digest", ok, detail });
  } catch { /* noop */ }
}
