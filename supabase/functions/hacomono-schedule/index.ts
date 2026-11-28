// hacomono のスタッフシフトと予約を読んで、オンライン面談を受けられる時間（meeting_availability）を作り直す
//   ・定期実行（pg_cron、15分ごと）から呼ぶ：Authorization: Bearer <CRON_SECRET>
//   ・スタッフの画面の「今すぐ hacomono から読み込む」から呼ぶ（ログイン中の管理者だけ）
// 流れ：
//   1. スタッフの画面で登録した A・B のスタッフコード（IN0001 など）を、hacomono のスタッフID に直す
//   2. 今日から受付の最後の日（20日からは翌月末）まで、1日ずつスケジュールを読む
//   3. A・B のどちらかが出勤していて空いている :55 を、プロ・コーチごとに書く
// 必要な環境変数：HACOMONO_BRAND・HACOMONO_API_TOKEN・CRON_SECRET・SITE_URL（任意：HACOMONO_STUDIO_ID）
// デプロイ：supabase functions deploy hacomono-schedule --no-verify-jwt（呼び出し元はこの中で確認する）
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { HacomonoClient, jstToday } from "../_shared/hacomono.ts";
import { availabilityForDay, type Coach } from "../_shared/hacomono_schedule.ts";

const JOB = "hacomono-schedule";
const PAUSE_MS = 150;   // 読み取りの上限（1秒10回）に余裕を持たせる

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

function cors(): Record<string, string> {
  let origin = "*";
  try { origin = new URL(env("SITE_URL")).origin; } catch { /* 未設定 */ }
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(), "Content-Type": "application/json" } });

function sameText(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function isAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return false;
  const { data: p } = await db.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  return p?.role === "admin";
}

function addDay(d: string, n: number): string {
  const [y, m, x] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10);
}

async function run(): Promise<{ days: number; slots: number; coaches: number; unknown: string[] }> {
  if (!env("HACOMONO_BRAND") || !env("HACOMONO_API_TOKEN")) throw new Error("hacomono の接続情報（HACOMONO_BRAND・HACOMONO_API_TOKEN）がまだ設定されていません");
  const c = new HacomonoClient(env("HACOMONO_BRAND"), env("HACOMONO_API_TOKEN"));
  const studioId = Number(env("HACOMONO_STUDIO_ID")) || undefined;

  // 1. スタッフコード → スタッフID
  const { data: settings, error } = await db.from("staff_settings").select("staff_id, hacomono_instructor_codes");
  if (error) throw error;
  const withCodes = (settings ?? []).filter((s: { hacomono_instructor_codes: string[] | null }) => (s.hacomono_instructor_codes ?? []).length);
  if (!withCodes.length) throw new Error("hacomono のスタッフコード（A・B）が、まだどのスタッフにも登録されていません");
  const byCode = new Map((await c.listInstructors()).map((i) => [String(i.code ?? "").trim().toUpperCase(), Number(i.id)]));
  const unknown: string[] = [];
  const coaches: Coach[] = [];
  for (const s of withCodes as { staff_id: string; hacomono_instructor_codes: string[] }[]) {
    const ids: number[] = [];
    for (const code of s.hacomono_instructor_codes) {
      const id = byCode.get(code.trim().toUpperCase());
      if (id) ids.push(id); else unknown.push(code);
    }
    await db.from("staff_settings").update({ hacomono_instructor_ids: ids }).eq("staff_id", s.staff_id);
    if (ids.length) coaches.push({ staff_id: s.staff_id, instructor_ids: ids });
  }

  // アプリが hacomono に入れたオンライン面談の予約（店舗の予約として数えない）
  const { data: own } = await db.from("meetings").select("hacomono_reservation_id").not("hacomono_reservation_id", "is", null).neq("status", "canceled");
  const ownIds = new Set((own ?? []).map((m: { hacomono_reservation_id: number }) => Number(m.hacomono_reservation_id)));

  // 2・3. 1日ずつ読んで、その日の分を入れ替える
  const today = jstToday();
  const { data: until } = await db.rpc("meeting_open_until", { p_today: today });
  const last = String(until ?? addDay(today, 31));
  let days = 0, slots = 0;
  for (let d = today; d <= last; d = addDay(d, 1)) {
    const schedule = await c.getChoiceSchedule(d, studioId);
    // 先に新しい分を書いてから、その日の古い分を消す（途中で予約の画面が空にならないように）
    const stamp = new Date().toISOString();
    const rows = availabilityForDay(d, schedule, coaches, ownIds).map((r) => ({ ...r, synced_at: stamp }));
    const from = new Date(`${d}T00:00:00+09:00`).toISOString();
    const to = new Date(`${addDay(d, 1)}T00:00:00+09:00`).toISOString();
    if (rows.length) {
      const up = await db.from("meeting_availability").upsert(rows, { onConflict: "staff_id,slot_at" });
      if (up.error) throw up.error;
    }
    const del = await db.from("meeting_availability").delete().gte("slot_at", from).lt("slot_at", to).lt("synced_at", stamp);
    if (del.error) throw del.error;
    days++; slots += rows.length;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  // 過ぎた分・受付の最後の日より後の分は消す
  await db.from("meeting_availability").delete().lt("slot_at", new Date(`${today}T00:00:00+09:00`).toISOString());
  await db.from("meeting_availability").delete().gte("slot_at", new Date(`${addDay(last, 1)}T00:00:00+09:00`).toISOString());
  return { days, slots, coaches: coaches.length, unknown };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return reply({ error: "POST で呼び出してください" }, 405);
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const fromCron = sameText(req.headers.get("x-cron-secret") ?? "", env("CRON_SECRET")) || sameText(bearer, env("CRON_SECRET"));
  if (!fromCron && !(await isAdmin(req))) return reply({ error: "この操作はできません" }, 403);
  try {
    const r = await run();
    const detail = `${r.days}日分・受けられる時間 ${r.slots}件（プロ・コーチ ${r.coaches}人）${r.unknown.length ? `・見つからないスタッフコード：${r.unknown.join("、")}` : ""}`;
    await db.from("job_runs").insert({ job: JOB, ok: r.unknown.length === 0, detail });
    return reply({ ...r, detail });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await db.from("job_runs").insert({ job: JOB, ok: false, detail: msg });
    return reply({ error: msg }, 500);
  }
});
