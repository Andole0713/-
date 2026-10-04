# 会員サイト 本番セットアップ手順

`app/` の会員サイトを本番運用するための手順です。上から順に進めてください（目安：2〜3時間）。

## 全体の仕組み

| 役割 | サービス | 内容 |
| --- | --- | --- |
| 画面 | GitHub Pages | `app/` のファイルを公開（無料） |
| ログイン・データ | Supabase | 会員アカウント、プロフィール、課題、レッスン、提出動画の記録 |
| 月額課金 | Stripe | 決済ページ、カード変更・プラン変更・解約（カスタマーポータル） |
| お客様の動画 | Supabase Storage | 会員ページから直接アップロード。本人とコーチだけが見られ、3か月後に自動削除 |
| 解説動画・ドリル | YouTube | スタッフが「限定公開」でアップし、レッスンにリンクを貼る |

```
会員 ──(ログイン/閲覧/提出)──▶ Supabase（データベース・RLSで本人のデータのみ）
  │                                  ▲
  └──(申し込み)──▶ Stripe 決済 ──(Webhook)──┘ 契約状態を自動反映
```

- 契約中（`active` / `trialing`）の会員だけが動画を提出できます。未契約の会員にはプラン選択画面が表示されます。
- 会員は自分のデータしか見られません。管理者（コーチ）は全会員のデータを見て編集できます。
- プランと契約状態は Stripe から自動で反映されます。会員が自分で書き換えることはできません。

## 費用の目安（会員100名以上）

| サービス | 費用 |
| --- | --- |
| Supabase Pro | 月 $25（無料プランは1週間アクセスがないと停止するため、本番では Pro を推奨）。動画の保存容量はプランに含まれる範囲で収まる見込み（3か月で自動削除） |
| Stripe | 決済額の 3.6%（月額固定費なし） |
| メール送信（Resend など） | 月 3,000 通まで無料 |
| GitHub Pages / YouTube | 無料 |

---

## 1. Supabase プロジェクトを作る

1. https://supabase.com でアカウントを作成し、「New project」を作成
   - Region は **Northeast Asia (Tokyo)** を選択
   - Database Password は安全な場所に保管
2. 左メニュー **SQL Editor** を開き、`supabase/migrations/20260926000000_init.sql` の中身をすべて貼り付けて **Run**
3. 動画の保存場所を確認
   - 左メニュー **Storage** に `swing-videos`（非公開）ができていることを確認
   - **Project Settings → Storage** の **Upload file size limit** を大きめ（例：5GB）に変更（1本あたりの上限は設けない運用のため。Pro プランで変更できます）
4. **Project Settings → API** で次の2つを控える
   - `Project URL`（例：`https://abcdefgh.supabase.co`）
   - `anon public` key
   - ※ `service_role` key は絶対に公開しないでください

## 2. 画面の設定と公開（GitHub Pages）

1. `app/config.js` を編集
   - `SUPABASE_URL` と `SUPABASE_ANON_KEY` に手順1-4の値を入れる
   - `SCHOOL_NAME` とプランの料金表示（`PLANS`）を書き換える
2. 公開は設定済みです（Settings → Pages の Source が **GitHub Actions**）。`main` に変更を取り込むと自動で公開されます
3. 数分後、`https://<ユーザー名>.github.io/<リポジトリ名>/app/` で会員サイトが開きます
   - このリポジトリの場合：`https://andole0713.github.io/-/app/`
   - 以降、この URL を「サイト URL」と呼びます

## 3. Supabase のログイン設定

**Authentication → URL Configuration**
- Site URL：サイト URL（例：`https://andole0713.github.io/-/app/`）
- Redirect URLs：同じサイト URL を追加

**Authentication → Emails → SMTP Settings（重要）**
- Supabase 標準のメール送信は1時間に数通までの制限があり、本番では届かなくなります。
- [Resend](https://resend.com) などで送信用のアカウントを作り、SMTP 情報を設定してください。
- あわせて **Email Templates** で確認メール・パスワード再設定メールの文面を日本語に変更しておくと親切です。

## 4. Stripe の設定

1. https://stripe.com でアカウントを作成（最初は「テストモード」で進める）
2. **商品カタログ** で「サブスクリプション制」の商品を作成し、**月額の継続価格** を設定
   - 価格の **価格 ID**（`price_...`）を控える
   - ユーキャン制（12か月・一括払い）は、今は LINE・電話での申し込みです（手順8を参照）
3. **設定 → Billing → カスタマーポータル** を開き、次を有効にして保存
   - 支払い方法の更新、請求書履歴
   - サブスクリプションのキャンセル（最低4か月の契約期間は、利用規約での案内をおすすめします）
4. **開発者 → API キー** でシークレットキー（`sk_test_...`）を控える

## 5. 決済処理（Edge Functions）をデプロイ

パソコンのターミナルで、このリポジトリのフォルダに移動して実行します（Node.js が必要）。

```bash
npx supabase login
npx supabase link --project-ref <プロジェクトID>   # URL の https://<ここ>.supabase.co 部分

npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_PRICE_SUBSCRIPTION=price_... \
  SITE_URL=https://andole0713.github.io/-/app

npx supabase functions deploy create-checkout-session
npx supabase functions deploy create-portal-session
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

### 古い動画の自動削除（3か月）

お客様の動画は、送信から3か月たつと自動で削除されます。そのための処理をデプロイし、毎日1回動くように設定します。

```bash
# 推測されにくい長い文字列を決めて登録（例：パスワード生成ツールで作った40文字以上）
npx supabase secrets set CRON_SECRET=<長いランダムな文字列>
npx supabase functions deploy purge-old-videos --no-verify-jwt
```

Supabase の **Database → Extensions** で `pg_cron` と `pg_net` を有効にし、**SQL Editor** で次を実行します（`<プロジェクトID>` と `<CRON_SECRET>` は置き換え）。

```sql
select cron.schedule(
  'purge-old-videos',
  '0 3 * * *',  -- 毎日 3:00（UTC）＝日本時間 12:00
  $$
  select net.http_post(
    url := 'https://<プロジェクトID>.supabase.co/functions/v1/purge-old-videos',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  );
  $$
);
```

## 6. Stripe Webhook を登録

1. Stripe の **開発者 → Webhook → エンドポイントを追加**
2. エンドポイント URL：`https://<プロジェクトID>.supabase.co/functions/v1/stripe-webhook`
3. 送信するイベント：
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
4. 作成後に表示される **署名シークレット**（`whsec_...`）を登録

```bash
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

## 7. 管理者（コーチ）アカウントを作る

1. 会員サイトの「新規登録」からご自身のアカウントを作成
2. Supabase の **SQL Editor** で次を実行（メールアドレスは置き換え）

```sql
update public.profiles set role = 'admin' where email = 'coach@example.com';
```

3. 再ログインすると管理画面（提出動画・会員一覧）が表示されます
   - 2人目以降のコーチは、管理画面の会員詳細で「権限」を「管理者」に変更できます

## 8. LINE・電話で申し込んだ会員（ユーキャン制など）を利用可能にする

カード決済をしていない会員は、管理者が「利用期限」を設定すると会員ページを使えるようになります。

1. 会員に、会員サイトの「新規登録」からアカウントを作ってもらう
2. 管理者でログイン →「会員一覧」→ 該当の会員を開く
3. 「プラン」を **ユーキャン制** に、「利用期限」を受講の最終日に設定して **保存する**
4. 期限を過ぎると、自動的に動画提出ができなくなります

「次回の面談日時」を入れておくと、会員のマイページに表示されます。

## 9. テスト（テストモード）

1. 別のメールアドレスで会員登録 → プランを選ぶ
2. Stripe の決済ページでテストカード `4242 4242 4242 4242`（有効期限は未来の日付、CVC は任意）を入力
3. 会員サイトに戻り、マイページが表示されることを確認
4. 会員ページの「動画を送る」からスマホの動画を送信 → 管理者でログインし「提出動画」で再生できることを確認
5. 管理者で「レッスンを書く」→ 会員側の「履歴」に表示されることを確認
6. 会員の「アカウント → 契約・お支払い」から解約 → 期間終了後にプラン選択画面に戻ることを確認

## 10. 本番運用への切り替え

- [ ] Stripe を本番モードに切り替え、手順4〜6を本番用のキー・価格 ID・Webhook でやり直す
- [ ] Supabase を Pro プランに変更（自動停止の防止・毎日バックアップ）
- [ ] 独自 SMTP でメールが届くことを確認
- [ ] **特定商取引法に基づく表記**・**利用規約**・**プライバシーポリシー** のページを用意する（オンラインでの有料サービス提供に必要）
- [ ] 会員への案内文を用意（撮影方法、動画は3か月で削除されること）

## ファイル構成

```
app/                         会員サイト（画面）
  index.html  style.css  app.js
  config.js                  ← Supabase の URL・キー、プラン表示を設定
supabase/
  migrations/…_init.sql      データベースの表とアクセス権限（RLS）
  functions/
    create-checkout-session/ 決済ページを作成
    create-portal-session/   カード変更・プラン変更・解約ページを作成
    stripe-webhook/          Stripe からの通知で契約状態を更新
    purge-old-videos/        3か月を過ぎたお客様の動画を自動削除
  config.toml
docs/SETUP.md                この手順書
index.html                   スクール紹介ページ（トップ）
prototype/                   旧デモ（ブラウザ内保存の試作品）
```
