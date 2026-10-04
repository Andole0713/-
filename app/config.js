// ===== 会員サイトの設定 =====
// Supabase の「Project Settings → API」に表示される値を貼り付けてください。
// anon key は公開して問題ない鍵です（データはデータベース側の RLS で守られています）。
// service_role key は絶対にここへ書かないでください。

export const SUPABASE_URL = 'https://xputqvfiowxbwnhagjop.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwdXRxdmZpb3d4YnduaGFnam9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNzMxOTAsImV4cCI6MjEwNjY0OTE5MH0.BKsCv6AEVNWINJGme8Z7iBfUMzqfUEKsSq42-Zsow-A';

export const SCHOOL_NAME = 'All Time Golf';

// プラン表示（料金は Stripe 側の価格と一致させてください）
// checkout: true のプランだけ、サイト上でクレジットカード決済できます。
// false のプランは LINE・電話での申し込みになります。
export const PLANS = [
  {
    id: 'SUBSCRIPTION',
    name: 'サブスクリプション制',
    en: 'Subscription',
    lead: 'いつでも、どこでも、継続的に。毎月の面談でPGAプロがあなたのゴルフをサポートします。',
    target: '初級〜上級者（メインは中級〜上級者）',
    payment: '1か月ごとの月額制（最低4か月）',
    price: '料金は近日公開',
    features: ['課題動画 毎月2本・練習ドリル 毎月2本', 'AI見本動画', '月1回・25分のオンライン面談', '簡易カルテでスイングレベルを見える化'],
    monthly: { submissions: 2, meetings: 1 },
    checkout: true,
    recommended: true,
  },
  {
    id: 'YOUCAN',
    name: 'ユーキャン制',
    en: 'You Can',
    lead: 'カリキュラムを順番に進める通信教育型。月ごとの課題をクリアしながら、12か月で体系的に上達します。',
    target: '初心者〜初級者',
    payment: '12か月・一括払い',
    price: '料金は近日公開',
    features: ['毎月の課題動画・練習ドリル', '提出動画へのPGAプロの添削', '年4回程度のオンライン面談'],
    checkout: false,
  },
];

// お問い合わせ先（サイト上で決済しないプランの申し込みに使用）
export const CONTACT = {
  tel: '0527004909',
  telDisplay: '052-700-4909',
  hours: '11:00〜20:00',
  lineUrl: 'https://lin.ee/ssvLEAZ',
};
