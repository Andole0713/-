// Stripe からの通知（Webhook）を受け取り、会員の契約状態を更新する
// デプロイ時は JWT 検証を無効にする: supabase functions deploy stripe-webhook --no-verify-jwt
import Stripe from "npm:stripe@17.7.0";
import { adminClient, planForPriceId, requireEnv, stripe } from "../_shared/common.ts";

const webhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function syncSubscription(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
  // API バージョンによって current_period_end の場所が異なるため両方を見る
  const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;

  const update: Record<string, unknown> = {
    stripe_customer_id: customerId,
    subscription_id: subscription.id,
    subscription_status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  };
  const plan = planForPriceId(item?.price?.id);
  if (plan) update.plan = plan;

  const db = adminClient();
  const { data, error } = await db
    .from("profiles")
    .update(update)
    .eq("stripe_customer_id", customerId)
    .select("id");
  if (error) throw error;

  // 顧客 ID がまだ保存されていない場合は metadata の user_id で紐づける
  if (!data?.length) {
    const userId = subscription.metadata?.user_id;
    if (!userId) throw new Error(`会員が見つかりません: ${customerId}`);
    const { error: e2 } = await db.from("profiles").update(update).eq("id", userId);
    if (e2) throw e2;
  }
}

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    console.error("署名の検証に失敗しました", e);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          const id = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          await syncSubscription(await stripe.subscriptions.retrieve(id));
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        // 通知の順序が前後しても最新状態になるよう、Stripe から取り直す
        await syncSubscription(await stripe.subscriptions.retrieve(event.data.object.id));
        break;
      default:
        break;
    }
  } catch (e) {
    console.error(e);
    // 500 を返すと Stripe が自動で再送してくれる
    return new Response("webhook handler failed", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
