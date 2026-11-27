// hacomono 連携の共通処理（外部のライブラリに頼らない部分だけ。Deno でも Node でも動く）
//   ・Webhook の署名の確認（HMAC-SHA256）
//   ・hacomono Admin API の呼び出し（会員の検索・契約プランの取得・プラン一覧）
//   ・契約プランから「アプリのプラン」と「利用できる期限」を決める
// 仕様の出典：hacomono for Developers（Admin API 2.0.0 / Webhook スタートガイド）

// ---------- Webhook の署名 ----------
// ヘッダー X-Webhook-Event：{"timestamp":…, "nonce":"…", "signature_algorithm":"HMAC-SHA256", "signature":"…"}
// 署名＝ HMAC-SHA256(シークレット, `${本文}:${timestamp}:${nonce}`) の16進文字列
export type SignatureResult = { ok: true } | { ok: false; reason: string };

const enc = new TextEncoder();

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 長さが同じなら、どこで違っても同じ時間で比べる（署名を推測されないように）
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(body: string, header: string | null, secret: string, nowMs = Date.now(), maxAgeSec = 300): Promise<SignatureResult> {
  if (!header) return { ok: false, reason: "署名のヘッダーがありません" };
  let h: { timestamp?: number | string; nonce?: string; signature_algorithm?: string; signature?: string };
  try { h = JSON.parse(header); } catch { return { ok: false, reason: "署名のヘッダーを読めません" }; }
  if (!h.signature || h.timestamp === undefined || !h.nonce) return { ok: false, reason: "署名の項目が足りません" };
  if (h.signature_algorithm && h.signature_algorithm.toUpperCase() !== "HMAC-SHA256") return { ok: false, reason: "署名の方式が違います" };
  // timestamp は秒（ミリ秒で来た場合にも対応）
  let ts = Number(h.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp が数字ではありません" };
  if (ts > 1e12) ts = Math.floor(ts / 1000);
  if (Math.abs(nowMs / 1000 - ts) > maxAgeSec) return { ok: false, reason: "timestamp が古すぎます" };
  const expected = await hmacHex(secret, `${body}:${h.timestamp}:${h.nonce}`);
  if (!sameText(expected, String(h.signature).toLowerCase())) return { ok: false, reason: "署名が一致しません" };
  return { ok: true };
}

// ---------- Admin API ----------
export type HMember = { id: number; status?: number; mail_address?: string; first_name?: string; last_name?: string; is_suspend?: boolean };
export type HMemberPlan = {
  id: number; member_id: number; plan_id: number; contract_group_no?: number;
  contracted_at?: string | null; start_date?: string | null; end_date?: string | null; withdrawal_requested_at?: string | null;
};
export type HPlan = { id: number; code?: string; name?: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class HacomonoError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

export class HacomonoClient {
  readonly base: string;
  private token: string;
  private fetcher: FetchLike;
  constructor(brand: string, token: string, fetcher: FetchLike = fetch, base?: string) {
    if (!/^[a-z0-9-]+$/i.test(brand)) throw new HacomonoError("ブランドコードの形が正しくありません");
    this.base = base ?? `https://${brand}.admin.egw.hacomono.app/api/v2`;
    this.token = token;
    this.fetcher = fetcher;
  }

  // 書き込み1秒2回・読み取り1秒10回の上限があるため、429（上限超え）のときは少し待ってやり直す
  private async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    const url = new URL(this.base + path);
    if (query) url.searchParams.set("query", JSON.stringify(query));
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetcher(url.toString(), {
        headers: { Authorization: `Bearer ${this.token}`, "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
      });
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
      const text = await res.text();
      let body: { data?: T; errors?: { code?: string; message?: string }[] } = {};
      try { body = text ? JSON.parse(text) : {}; } catch { /* JSON 以外 */ }
      if (!res.ok) {
        const msg = body.errors?.map((e) => e.message || e.code).filter(Boolean).join(" / ") || text.slice(0, 120);
        throw new HacomonoError(`hacomono API エラー（${res.status}）${msg ? `：${msg}` : ""}`, res.status);
      }
      return (body.data ?? ({} as T)) as T;
    }
  }

  // メールアドレスで会員を探す（大文字・小文字の違いは無視して、完全に一致するものだけ）
  async findMemberByEmail(email: string): Promise<HMember[]> {
    const want = email.trim().toLowerCase();
    const tries = [...new Set([email.trim(), want])];
    for (const q of tries) {
      const data = await this.get<{ members?: { list?: HMember[] } }>("/member/members", { mail_address: q });
      const hit = (data.members?.list ?? []).filter((m) => (m.mail_address ?? "").trim().toLowerCase() === want);
      if (hit.length) return hit;
    }
    return [];
  }

  async getMember(id: number): Promise<HMember> {
    const data = await this.get<{ member?: HMember }>(`/member/members/${id}`);
    if (!data.member) throw new HacomonoError("会員が見つかりません", 404);
    return data.member;
  }

  async getMemberPlans(id: number): Promise<HMemberPlan[]> {
    const data = await this.get<{ member_plans?: HMemberPlan[] | { list?: HMemberPlan[] } }>(`/member/members/${id}/plans`);
    const mp = data.member_plans;
    return Array.isArray(mp) ? mp : mp?.list ?? [];
  }

  // プランの一覧（設定画面で、hacomono のプランとアプリのプランを結びつけるために使う）
  async listPlans(): Promise<HPlan[]> {
    const out: HPlan[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.get<{ plans?: { list?: HPlan[]; total_page?: number } }>("/master/plans", { page });
      out.push(...(data.plans?.list ?? []));
      if (!data.plans?.total_page || page >= data.plans.total_page) break;
    }
    return out;
  }
}

// ---------- 契約プラン → アプリのプランと利用できる期限 ----------
// map：hacomono のプランID → { アプリのプラン, 期間（月数。月額のプランは null）}
export type PlanMapRow = { hacomono_plan_id: number; app_plan: string; months: number | null };
export type AccessDecision =
  | { kind: "none"; reason: string }                                    // オンラインのプランの契約がない（アプリは触らない）
  // fixedEnd：終わりが決まっている（解約済み・期間のプラン）。false のときは「続いている間は延ばす」期限
  | { kind: "active"; plan: string; accessUntil: string; fixedEnd: boolean; memberPlanId: number; reason: string }
  | { kind: "ended"; plan: string; accessUntil: string; memberPlanId: number; reason: string };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
// その月の末日（m は 1〜12。13以上・0以下は年をまたいで数える）
export function endOfMonth(y: number, m: number): string {
  const d = new Date(Date.UTC(y, m, 0)); // 翌月の0日＝その月の末日
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
const parts = (date: string) => date.slice(0, 10).split("-").map(Number) as [number, number, number];
// 日本時間の今日（yyyy-MM-dd）
export function jstToday(now = Date.now()): string {
  const d = new Date(now + 9 * 3600 * 1000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function decideAccess(member: Pick<HMember, "status">, plans: HMemberPlan[], map: PlanMapRow[], today: string): AccessDecision {
  const byId = new Map(map.map((r) => [Number(r.hacomono_plan_id), r]));
  const online = plans.filter((p) => byId.has(Number(p.plan_id)) && p.start_date);
  if (!online.length) return { kind: "none", reason: "オンラインのプランの契約がありません" };
  // 会員が「無効」「退会」なら、契約があっても使えないものとして扱う
  const memberOff = member.status === 2 || member.status === 4;
  const started = online.filter((p) => (p.start_date as string) <= today);
  const live = memberOff ? [] : started.filter((p) => !p.end_date || p.end_date >= today);
  const pick = (list: HMemberPlan[]) => [...list].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0];

  if (live.length) {
    const p = pick(live);
    const row = byId.get(Number(p.plan_id))!;
    let accessUntil: string;
    if (row.months) {
      // 期間のプラン（UCAN）：受講期限は「開始月から数えて 月数＋1 か月目の月末」（最後の月の分の動画を送れるように）
      const [y, m] = parts(p.start_date as string);
      accessUntil = endOfMonth(y, m + row.months);
    } else if (p.end_date) {
      // 月額のプランで終了日が決まっている（解約の手続き済み）：終了日まで
      accessUntil = p.end_date.slice(0, 10);
    } else {
      // 月額のプランで続いている：来月の末日まで（毎日の確認で、続いている間は延び続ける）
      const [y, m] = parts(today);
      accessUntil = endOfMonth(y, m + 1);
    }
    const fixedEnd = !!row.months || !!p.end_date;
    return { kind: "active", plan: row.app_plan, accessUntil, fixedEnd, memberPlanId: p.id, reason: p.end_date ? `契約中（${p.end_date.slice(0, 10)} まで）` : "契約中" };
  }

  // まだ始まっていない契約だけ：アプリは触らない（開始日になったら、毎日の確認で使えるようになる）
  if (!started.length && !memberOff) {
    const next = [...online].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0];
    return { kind: "none", reason: `契約の開始日（${String(next.start_date).slice(0, 10)}）前です` };
  }
  // 契約が終わっている（または会員が無効・退会）
  const ended = pick(started.length ? started : online);
  const row = byId.get(Number(ended.plan_id))!;
  const yesterday = addDays(today, -1);
  const until = ended.end_date && ended.end_date.slice(0, 10) < today ? ended.end_date.slice(0, 10) : yesterday;
  const reason = memberOff ? `hacomono の会員が${member.status === 4 ? "退会" : "無効"}になっています` : "契約が終了しています";
  return { kind: "ended", plan: row.app_plan, accessUntil: until, memberPlanId: ended.id, reason };
}
