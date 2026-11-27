// hacomono の契約を見て、アプリのプランと利用できる期限を合わせる
//   ・毎日1回、データベースの定期実行（pg_cron）から呼ぶ：{ "mode": "all" }（Authorization: Bearer <CRON_SECRET> で確認）
//   ・スタッフの画面から呼ぶ（ログイン中の管理者だけ）：
//       { "mode": "status" }                     … 設定の状態
//       { "mode": "plans" }                      … hacomono のプラン一覧と、今の対応
//       { "mode": "member", "member_id": "…" }   … 1人だけ今すぐ確認
//       { "mode": "link", "member_id": "…", "hacomono_member_id": 123 } … スタッフが手動で結ぶ（そのあと確認）
//       { "mode": "all" }                        … 全員を今すぐ確認
// 必要な環境変数：HACOMONO_BRAND（ブランドコード）・HACOMONO_API_TOKEN・CRON_SECRET・SITE_URL
//   （SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY は Supabase が自動で設定）
// デプロイ：supabase functions deploy hacomono-sync --no-verify-jwt（呼び出し元はこの中で確認する）
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { HacomonoClient, jstToday } from "../_shared/hacomono.ts";
import { loadPlanMap, syncMember, type Profile, type SyncResult } from "../_shared/hacomono_sync.ts";

const JOB = "hacomono-sync";
const MAX_PER_RUN = 300;       // 1回で確認する人数の上限（時間切れにならないように。残りは次の回）
const PAUSE_MS = 150;          // hacomono の読み取りの上限（1秒10回）に余裕を持たせる

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

function client(): HacomonoClient {
  if (!env("HACOMONO_BRAND") || !env("HACOMONO_API_TOKEN")) throw new Error("hacomono の接続情報（HACOMONO_BRAND・HACOMONO_API_TOKEN）がまだ設定されていません");
  return new HacomonoClient(env("HACOMONO_BRAND"), env("HACOMONO_API_TOKEN"));
}

const PROFILE_COLS = "id, email, plan, access_until, role";

async function runAll(): Promise<{ checked: number; changed: number; errors: number; results: SyncResult[] }> {
  const c = client();
  const map = await loadPlanMap(db);
  if (!map.length) throw new Error("hacomono のプランとアプリのプランの対応がまだ設定されていません");
  const today = jstToday();
  // 結びついている会員は全員、まだの会員はメールアドレスで探す（確認したのが古い順）
  const { data: links } = await db.from("hacomono_links").select("member_id, synced_at");
  const syncedAt = new Map((links ?? []).map((l: { member_id: string; synced_at: string | null }) => [l.member_id, l.synced_at ?? ""]));
  const { data: profiles, error } = await db.from("profiles").select(PROFILE_COLS).neq("role", "admin").is("deletion_requested_at", null);
  if (error) throw error;
  const list = ((profiles ?? []) as Profile[])
    .sort((a, b) => String(syncedAt.get(a.id) ?? "").localeCompare(String(syncedAt.get(b.id) ?? "")))
    .slice(0, MAX_PER_RUN);
  const results: SyncResult[] = [];
  for (const p of list) {
    results.push(await syncMember(db, c, map, p, today));
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  return {
    checked: results.length,
    changed: results.filter((r) => r.changed).length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() });
  if (req.method !== "POST") return reply({ error: "POST で呼び出してください" }, 405);
  // 毎日の定期実行は、ヘッダー（Authorization: Bearer <CRON_SECRET> または x-cron-secret）で確かめる
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const fromCron = sameText(req.headers.get("x-cron-secret") ?? "", env("CRON_SECRET")) || sameText(bearer, env("CRON_SECRET"));
  if (!fromCron && !(await isAdmin(req))) return reply({ error: "この操作はできません" }, 403);
  let body: { mode?: string; member_id?: string; hacomono_member_id?: number } = {};
  try { body = await req.json(); } catch { /* 空 */ }
  const mode = fromCron ? "all" : body.mode ?? "status";

  try {
    if (mode === "status") {
      const [{ count: links }, { data: map }, { data: last }] = await Promise.all([
        db.from("hacomono_links").select("member_id", { count: "exact", head: true }),
        db.from("hacomono_plan_map").select("hacomono_plan_id"),
        db.from("job_runs").select("ran_at, ok, detail").eq("job", JOB).order("ran_at", { ascending: false }).limit(1),
      ]);
      return reply({
        configured: { brand: !!env("HACOMONO_BRAND"), token: !!env("HACOMONO_API_TOKEN"), webhookSecret: !!env("HACOMONO_WEBHOOK_SECRET"), cron: !!env("CRON_SECRET") },
        links: links ?? 0, mapped: map?.length ?? 0, lastRun: last?.[0] ?? null,
      });
    }
    if (mode === "plans") {
      const plans = await client().listPlans();
      const { data: map } = await db.from("hacomono_plan_map").select("hacomono_plan_id, app_plan, months");
      return reply({ plans: plans.map((p) => ({ id: p.id, code: p.code ?? "", name: p.name ?? "" })), map: map ?? [] });
    }
    if (mode === "member" || mode === "link") {
      if (!body.member_id) return reply({ error: "会員が指定されていません" }, 400);
      const { data: p } = await db.from("profiles").select(PROFILE_COLS).eq("id", body.member_id).maybeSingle();
      if (!p) return reply({ error: "会員が見つかりません" }, 404);
      const c = client();
      if (mode === "link") {
        const hid = Number(body.hacomono_member_id);
        if (!Number.isInteger(hid) || hid <= 0) return reply({ error: "hacomono の会員IDが正しくありません" }, 400);
        await c.getMember(hid); // 存在を確かめる
        const { data: other } = await db.from("hacomono_links").select("member_id").eq("hacomono_member_id", hid).maybeSingle();
        if (other && other.member_id !== p.id) return reply({ error: "この hacomono 会員は、別のアプリ会員と結ばれています" }, 409);
        const { error } = await db.from("hacomono_links").upsert({ member_id: p.id, hacomono_member_id: hid, linked_by: "staff", linked_at: new Date().toISOString() });
        if (error) throw error;
      }
      const map = await loadPlanMap(db);
      const r = await syncMember(db, c, map, p as Profile, jstToday());
      return reply(r);
    }
    if (mode === "all") {
      const r = await runAll();
      const detail = `確認 ${r.checked}人・変更 ${r.changed}人・エラー ${r.errors}件`;
      await db.from("job_runs").insert({ job: JOB, ok: r.errors === 0, detail });
      return reply({ ...r, detail, results: fromCron ? undefined : r.results });
    }
    return reply({ error: "mode が正しくありません" }, 400);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    if (mode === "all") await db.from("job_runs").insert({ job: JOB, ok: false, detail: msg });
    return reply({ error: msg }, 500);
  }
});
