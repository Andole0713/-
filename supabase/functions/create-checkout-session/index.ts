// 会員がプランを選んだときに Stripe の決済ページ（Checkout）を作成する
import {
  adminClient,
  CHECKOUT_PLANS,
  corsHeaders,
  ensureStripeCustomer,
  getUser,
  json,
  type Plan,
  PLANS,
  priceIdForPlan,
  siteUrl,
  stripe,
} from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const user = await getUser(req);
    if (!user) return json(req, { error: "ログインが必要です" }, 401);

    const { plan } = await req.json().catch(() => ({}));
    if (!PLANS.includes(plan)) return json(req, { error: "プランが正しくありません" }, 400);
    if (!CHECKOUT_PLANS.includes(plan)) {
      return json(req, { error: "このプランは LINE またはお電話でお申し込みください" }, 400);
    }

    const { data: profile } = await adminClient()
      .from("profiles")
      .select("subscription_status")
      .eq("id", user.id)
      .single();
    if (profile && ["active", "trialing", "past_due"].includes(profile.subscription_status)) {
      return json(req, { error: "すでに契約中です。プラン変更は「契約・お支払い」から行ってください" }, 409);
    }

    const customer = await ensureStripeCustomer(user);

    // 二重の契約を防ぐ：Stripe 上に終わっていない契約（支払い未完了・一時停止なども含む）があれば作らない
    const subs = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
    const open = subs.data.filter((s) => !["canceled", "incomplete_expired"].includes(s.status));
    if (open.length) {
      const pending = open.every((s) => s.status === "incomplete");
      return json(req, {
        error: pending
          ? "前回のお申し込みのお支払いが完了していません。しばらくしてから、もう一度お試しください"
          : "すでに契約中です。プラン変更は「契約・お支払い」から行ってください",
      }, 409);
    }
    // 開いたままの決済ページ（別のタブ・前回の操作）は無効にしてから作り直す（両方で支払われないように）
    const sessions = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 });
    for (const s of sessions.data) {
      try {
        await stripe.checkout.sessions.expire(s.id);
      } catch (e) {
        console.warn("決済ページを無効にできませんでした", s.id, e);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: priceIdForPlan(plan as Plan), quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
      locale: "ja",
      success_url: `${siteUrl()}/?checkout=success`,
      cancel_url: `${siteUrl()}/?checkout=cancel`,
    });

    return json(req, { url: session.url });
  } catch (e) {
    console.error(e);
    return json(req, { error: "決済ページを作成できませんでした" }, 500);
  }
});
