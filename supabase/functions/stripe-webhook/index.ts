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

  // Web（カスタマーポータル）で解約すると、期間の終わりに終了する予約が入る
  const cancelAtSec = subscription.cancel_at ?? (subscription.cancel_at_period_end ? periodEnd : null);
  const cancelAt = subscription.status === "canceled" || !cancelAtSec ? null : new Date(cancelAtSec * 1000).toISOString();

  const update: Record<string, unknown> = {
    stripe_customer_id: customerId,
    subscription_id: subscription.id,
    subscription_status: subscription.status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at: cancelAt,
  };
  const plan = planForPriceId(item?.price?.id);
  if (plan) update.plan = plan;

  const db = adminClient();
  let { data: before } = await db.from("profiles").select("id, subscription_id, subscription_status, cancel_at")
    .eq("stripe_customer_id", customerId).maybeSingle();
  if (!before) {
    // 顧客 ID がまだ保存されていない場合は metadata の user_id で紐づける
    const userId = subscription.metadata?.user_id;
    if (!userId) throw new Error(`会員が見つかりません: ${customerId}`);
    ({ data: before } = await db.from("profiles").select("id, subscription_id, subscription_status, cancel_at").eq("id", userId).maybeSingle());
    if (!before) throw new Error(`会員が見つかりません: ${userId}`);
  }
  // 以前の契約の通知（解約済みの古い契約など）で、今の契約の情報を上書きしない
  if (before.subscription_id && before.subscription_id !== subscription.id && subscription.status === "canceled") return;

  const { error } = await db.from("profiles").update(update).eq("id", before.id);
  if (error) throw error;

  await noticeCancel(db, before, subscription, cancelAt);
}

// 解約・解約の取り消しがあったら、管理画面にお知らせを出す
const fmt = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
const REASONS: Record<string, string> = {
  too_expensive: "料金が高い", missing_features: "欲しい機能がない", switched_service: "ほかのサービスに変えた",
  unused: "あまり使っていない", customer_service: "対応への不満", too_complex: "使い方が難しい",
  low_quality: "品質への不満", other: "その他",
};
async function noticeCancel(
  db: ReturnType<typeof adminClient>,
  before: { id: string; subscription_status: string | null; cancel_at: string | null },
  subscription: Stripe.Subscription,
  cancelAt: string | null,
) {
  const d = subscription.cancellation_details;
  const why = [d?.feedback ? REASONS[d.feedback] ?? d.feedback : "", d?.comment ?? ""].filter(Boolean).join("／");
  let kind = "";
  let detail = "";
  if (subscription.status === "canceled" && before.subscription_status !== "canceled") {
    kind = "canceled";
    detail = "契約が終了しました" + (why ? `（理由：${why}）` : "");
  } else if (cancelAt && !before.cancel_at) {
    kind = "cancel_scheduled";
    detail = `Webで解約しました。${fmt(cancelAt)} まで利用できます` + (why ? `（理由：${why}）` : "");
  } else if (!cancelAt && before.cancel_at && subscription.status !== "canceled") {
    kind = "cancel_withdrawn";
    detail = "解約を取り消し、契約を続けることになりました";
  }
  if (!kind) return;
  const { error } = await db.rpc("add_member_notice", { p_member: before.id, p_kind: kind, p_detail: detail });
  if (error) console.error("お知らせを保存できませんでした", error);
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
