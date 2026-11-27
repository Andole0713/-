// hacomono からの知らせ（Webhook）を受け取る
//   ・署名（HMAC-SHA256）を確かめ、一致しないものは処理しない
//   ・同じ知らせ（同じ ID）は1回だけ処理する
//   ・契約・会員登録・プロフィールの知らせ → その会員の契約を確かめて、アプリのプランと期限を合わせる
//   ・予約の知らせ → いまは記録だけ（「次回の面談」への反映は、予約の方式が決まってから）
//   ・hacomono は 200〜299 が返らないと最大10回送り直すため、署名が正しければ、処理に失敗しても 200 を返す
//     （失敗は hacomono_events に記録し、毎日の確認 hacomono-sync で取り戻す）
// 必要な環境変数：HACOMONO_WEBHOOK_SECRET（hacomono の管理画面で Webhook を作ると表示されるシークレット）・HACOMONO_BRAND・HACOMONO_API_TOKEN
// デプロイ：supabase functions deploy hacomono-webhook --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { HacomonoClient, jstToday, verifyWebhook } from "../_shared/hacomono.ts";
import { loadPlanMap, profileForHacomonoMember, syncMember } from "../_shared/hacomono_sync.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ok = (text = "ok") => new Response(text, { status: 200 });

// 会員の契約に関わる知らせ
const MEMBER_EVENTS = new Set([
  "SYSTEM_AUTH_SIGNUP", "MEMBER_MEMBER_UPDATE", "MEMBER_MEMBER_PLAN_CREATE", "MEMBER_MEMBER_CHANGE_PLAN",
  "MEMBER_MEMBER_PLAN_UPDATE", "MEMBER_MEMBER_PLAN_DELETE", "PURCHASE_PURCHASE_PLAN",
]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = env("HACOMONO_WEBHOOK_SECRET");
  if (!secret) return new Response("not configured", { status: 503 });
  const body = await req.text();
  const v = await verifyWebhook(body, req.headers.get("X-Webhook-Event"), secret);
  if (!v.ok) return new Response(v.reason, { status: 401 });

  let ev: { id?: number; type?: string; payload?: { member_id?: number | null } } = {};
  try { ev = JSON.parse(body); } catch { return ok("ignored: not json"); }
  const id = Number(ev.id);
  const type = String(ev.type ?? "");
  const hid = Number(ev.payload?.member_id) || null;
  if (!Number.isFinite(id)) return ok("ignored: no id");

  // 同じ知らせが2回目以降なら何もしない
  const { data: seen } = await db.from("hacomono_events").select("processed_at").eq("id", id).maybeSingle();
  if (seen?.processed_at) return ok("duplicate");
  if (!seen) await db.from("hacomono_events").insert({ id, type, hacomono_member_id: hid });

  let result = "記録のみ";
  try {
    if (type === "TEST_TEST") result = "送信テストを受け取りました";
    else if (MEMBER_EVENTS.has(type) && hid) {
      if (!env("HACOMONO_BRAND") || !env("HACOMONO_API_TOKEN")) throw new Error("hacomono の接続情報がまだ設定されていません");
      const client = new HacomonoClient(env("HACOMONO_BRAND"), env("HACOMONO_API_TOKEN"));
      const profile = await profileForHacomonoMember(db, client, hid);
      if (!profile) result = "アプリに結びつく会員がいません（同じメールアドレスの登録なし）";
      else {
        const map = await loadPlanMap(db);
        const r = await syncMember(db, client, map, profile, jstToday(), hid);
        result = `${r.status}：${r.detail}`;
      }
    } else if (type.startsWith("SCHEDULE_RESERVATION_")) result = "予約の知らせ（いまは記録のみ）";
  } catch (e) {
    result = `エラー：${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
  }
  await db.from("hacomono_events").update({ processed_at: new Date().toISOString(), result: result.slice(0, 500) }).eq("id", id);
  return ok();
});
