// 会員が「契約・お支払い」を開いたときに Stripe カスタマーポータルを作成する
// （カード変更・プラン変更・解約・領収書の確認ができる）
import { corsHeaders, ensureStripeCustomer, getUser, json, siteUrl, stripe } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  try {
    const user = await getUser(req);
    if (!user) return json(req, { error: "ログインが必要です" }, 401);

    const customer = await ensureStripeCustomer(user);
    const session = await stripe.billingPortal.sessions.create({
      customer,
      locale: "ja",
      return_url: `${siteUrl()}/?view=account`,
    });

    return json(req, { url: session.url });
  } catch (e) {
    console.error(e);
    return json(req, { error: "お支払いページを開けませんでした" }, 500);
  }
});
