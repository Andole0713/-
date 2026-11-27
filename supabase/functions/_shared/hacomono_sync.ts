// 1人の会員について、hacomono の契約を見て、アプリのプランと利用できる期限を合わせる
//   hacomono-sync（毎日の確認・スタッフの「今すぐ確認」）と hacomono-webhook（hacomono からの知らせ）の両方から使う
// db は Supabase のサービスロールのクライアント（RLS を通らない）。型は呼び出し側に合わせて緩くしている
import { decideAccess, HacomonoClient, type HMember, type PlanMapRow } from "./hacomono.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
export type Profile = { id: string; email: string | null; plan: string | null; access_until: string | null; role?: string | null };
export type SyncResult = { memberId: string; status: "active" | "ended" | "none" | "error" | "unlinked"; detail: string; changed: boolean };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function loadPlanMap(db: Db): Promise<PlanMapRow[]> {
  const { data, error } = await db.from("hacomono_plan_map").select("hacomono_plan_id, app_plan, months");
  if (error) throw error;
  return (data ?? []) as PlanMapRow[];
}

async function saveLink(db: Db, memberId: string, patch: Record<string, unknown>) {
  await db.from("hacomono_links").update({ ...patch, synced_at: new Date().toISOString() }).eq("member_id", memberId);
}

// アプリの会員に結びつく hacomono の会員を決める（結びつきがなければ、メールアドレスで探して結ぶ）
async function resolveHacomonoMember(db: Db, client: HacomonoClient, profile: Profile, hint?: number): Promise<{ id: number } | { error: string; status: SyncResult["status"] }> {
  const { data: link } = await db.from("hacomono_links").select("hacomono_member_id").eq("member_id", profile.id).maybeSingle();
  if (link?.hacomono_member_id) return { id: Number(link.hacomono_member_id) };
  let id = hint;
  if (!id) {
    if (!profile.email) return { error: "アプリにメールアドレスがありません", status: "unlinked" };
    const found = await client.findMemberByEmail(profile.email);
    if (!found.length) return { error: "hacomono に同じメールアドレスの会員がいません", status: "unlinked" };
    if (found.length > 1) return { error: "hacomono に同じメールアドレスの会員が複数います（スタッフが手動で結んでください）", status: "error" };
    id = found[0].id;
  }
  // すでに別のアプリ会員と結ばれている hacomono 会員なら、結ばない
  const { data: other } = await db.from("hacomono_links").select("member_id").eq("hacomono_member_id", id).maybeSingle();
  if (other && other.member_id !== profile.id) return { error: "この hacomono 会員は、別のアプリ会員と結ばれています", status: "error" };
  const { error } = await db.from("hacomono_links").insert({ member_id: profile.id, hacomono_member_id: id, linked_by: "email" });
  if (error && !String(error.message).includes("duplicate")) return { error: `結びつきを保存できませんでした：${error.message}`, status: "error" };
  return { id };
}

export async function syncMember(db: Db, client: HacomonoClient, map: PlanMapRow[], profile: Profile, today: string, hint?: number): Promise<SyncResult> {
  const base = { memberId: profile.id, changed: false };
  try {
    if (profile.role === "admin") return { ...base, status: "none", detail: "スタッフのアカウントは対象外です" };
    const r = await resolveHacomonoMember(db, client, profile, hint);
    if ("error" in r) return { ...base, status: r.status, detail: r.error };
    const member: HMember = await client.getMember(r.id);
    const plans = await client.getMemberPlans(r.id);
    const d = decideAccess(member, plans, map, today);

    if (d.kind === "none") {
      await saveLink(db, profile.id, { status: "none", detail: d.reason });
      return { ...base, status: "none", detail: d.reason };
    }

    const patch: Record<string, unknown> = {};
    if (d.kind === "active") {
      if (profile.plan !== d.plan) patch.plan = d.plan;
      // 終わりが決まっていれば、その日にする。続いている月額のプランは、スタッフが長めに設定していれば短くしない
      const cur = profile.access_until;
      if (d.fixedEnd ? cur !== d.accessUntil : !cur || cur < d.accessUntil) patch.access_until = d.accessUntil;
    } else {
      // 契約が終わっている：利用できる期限を、終わった日までに縮める（延ばすことはしない）
      if (!profile.access_until || profile.access_until > d.accessUntil) patch.access_until = d.accessUntil;
    }
    if (Object.keys(patch).length) {
      const { error } = await db.from("profiles").update(patch).eq("id", profile.id);
      if (error) throw error;
    }
    // 申込み（hacomono で手続きを済ませた）を確認済みにする
    if (d.kind === "active") {
      await db.from("plan_applications").update({ confirmed_at: new Date().toISOString() }).eq("member_id", profile.id).is("confirmed_at", null);
    }
    const detail = `${d.reason}（アプリ：${d.plan}・${d.accessUntil}まで）`;
    await saveLink(db, profile.id, { status: d.kind, detail });
    return { ...base, status: d.kind, detail, changed: Object.keys(patch).length > 0 };
  } catch (e) {
    const detail = errText(e);
    await saveLink(db, profile.id, { status: "error", detail }).catch(() => {});
    return { ...base, status: "error", detail };
  }
}

// hacomono の会員ID から、アプリの会員を探す（結びつき → なければメールアドレス）
export async function profileForHacomonoMember(db: Db, client: HacomonoClient, hacomonoId: number): Promise<Profile | null> {
  const cols = "id, email, plan, access_until, role";
  const { data: link } = await db.from("hacomono_links").select("member_id").eq("hacomono_member_id", hacomonoId).maybeSingle();
  if (link?.member_id) {
    const { data } = await db.from("profiles").select(cols).eq("id", link.member_id).maybeSingle();
    return data ?? null;
  }
  const m = await client.getMember(hacomonoId);
  const email = (m.mail_address ?? "").trim();
  if (!email) return null;
  // メールアドレスは大文字・小文字を区別せずに探す（% と _ は文字としてそのまま扱う）
  const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data } = await db.from("profiles").select(cols).ilike("email", pattern).limit(2);
  return data?.length === 1 ? data[0] : null;
}
