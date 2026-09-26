// ===== 会員サイトの設定 =====
// Supabase の「Project Settings → API」に表示される値を貼り付けてください。
// anon key は公開して問題ない鍵です（データはデータベース側の RLS で守られています）。
// service_role key は絶対にここへ書かないでください。

export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';

export const SCHOOL_NAME = 'All Time Golf';

// プラン表示（料金は Stripe 側の価格と一致させてください）
export const PLANS = [
  {
    id: 'BASIC',
    name: 'BASIC',
    price: '月額 ¥0,000',
    features: ['動画添削 月2回', 'レッスン履歴の閲覧'],
  },
  {
    id: 'STANDARD',
    name: 'STANDARD',
    price: '月額 ¥0,000',
    features: ['動画添削 月4回', '毎週の練習課題', 'レッスン履歴の閲覧'],
    recommended: true,
  },
  {
    id: 'PREMIUM',
    name: 'PREMIUM',
    price: '月額 ¥0,000',
    features: ['動画添削 無制限', '毎週の練習課題', 'コーチの解説動画'],
  },
];
