// お知らせメールの送信（Resend を使用）。Stripe を使わない処理からも読み込めるよう、common.ts とは分けている。
// 必要な環境変数: RESEND_API_KEY, MAIL_FROM（例: All Time Golf <info@example.com>）, SITE_URL
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

export const SCHOOL_NAME = "All Time Golf";

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export function db(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

// 会員ページの URL（末尾のスラッシュなし）。例: https://andole0713.github.io/-/app
export const siteUrl = () => requireEnv("SITE_URL").replace(/\/+$/, "");

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));

// 日本時間の「10/12（日）19:30」
export function jstWhen(iso: string): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}/${get("day")}（${get("weekday")}）${get("hour")}:${get("minute")}`;
}

type Mail = { to: string; name: string; subject: string; lines: string[]; button: string; path: string };

export async function sendMail(m: Mail): Promise<void> {
  const url = `${siteUrl()}/${m.path}`;
  const text = [`${m.name || "会員"}様`, "", ...m.lines, "", `${m.button}：${url}`, "", "―", SCHOOL_NAME,
    "※このメールは送信専用です。お知らせが不要な場合は、会員ページの「アカウント」から停止できます。"].join("\n");
  const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1b231e;line-height:1.8">
  <div style="background:#0f1712;color:#e2cc9a;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:bold;letter-spacing:.08em">${SCHOOL_NAME}</div>
  <div style="border:1px solid #e6dfd2;border-top:0;border-radius:0 0 12px 12px;padding:20px">
    <p>${esc(m.name || "会員")}様</p>
    ${m.lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join("")}
    <p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;background:#c8a96a;color:#0f1712;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">${esc(m.button)}</a></p>
    <p style="font-size:12px;color:#6b726c">※このメールは送信専用です。お知らせが不要な場合は、会員ページの「アカウント」から停止できます。</p>
  </div></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: requireEnv("MAIL_FROM"), to: [m.to], subject: `【${SCHOOL_NAME}】${m.subject}`, text, html }),
  });
  if (!res.ok) throw new Error(`メール送信に失敗しました (${res.status}): ${await res.text()}`);
}
