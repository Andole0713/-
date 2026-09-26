import Stripe from "npm:stripe@17.7.0";
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.49.4";

export const PLANS = ["SUBSCRIPTION", "YOUCAN"] as const;
export type Plan = (typeof PLANS)[number];
// サイト上でカード決済（Stripe の月額課金）ができるプラン
export const CHECKOUT_PLANS: readonly Plan[] = ["SUBSCRIPTION"];

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export const stripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
  httpClient: Stripe.createFetchHttpClient(),
});

// プラン名 ⇔ Stripe の価格 ID
export function priceIdForPlan(plan: Plan): string {
  return requireEnv(`STRIPE_PRICE_${plan}`);
}

export function planForPriceId(priceId: string | undefined): Plan | null {
  if (!priceId) return null;
  return PLANS.find((p) => Deno.env.get(`STRIPE_PRICE_${p}`) === priceId) ?? null;
}

// サービスロール（RLS を通さない）クライアント。サーバー側でのみ使う。
export function adminClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

// リクエストの Authorization ヘッダーからログインユーザーを取得
export async function getUser(req: Request): Promise<User | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error) return null;
  return data.user;
}

// サイト URL（決済後の戻り先）。末尾のスラッシュは付けない。
export function siteUrl(): string {
  return requireEnv("SITE_URL").replace(/\/+$/, "");
}

export function corsHeaders(_req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": new URL(siteUrl()).origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// ユーザーに紐づく Stripe 顧客 ID を取得（なければ作成して保存）
export async function ensureStripeCustomer(user: User): Promise<string> {
  const db = adminClient();
  const { data: profile, error } = await db
    .from("profiles")
    .select("stripe_customer_id, name")
    .eq("id", user.id)
    .single();
  if (error) throw error;
  if (profile.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await stripe.customers.create(
    { email: user.email, name: profile.name || undefined, metadata: { user_id: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  const { error: updateError } = await db
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", user.id);
  if (updateError) throw updateError;
  return customer.id;
}
