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
   - あとから追加された設定ファイル（`supabase/migrations/` の日付が新しいもの。例：`20261004000000_my_clubs.sql`、`20261005000000_extra_submissions.sql`、`20261006000000_member_experience.sql`、`20261007000000_drills.sql`、`20261008000000_roadmap.sql`、`20261009000000_roadmap_extras.sql`、`20261010000000_roadmap_unpublish.sql`、`20261011000000_rounds.sql`、`20261012000000_round_halves.sql`、`20261013000000_admin_ops.sql`）も、同じように古い順に実行してください。初期設定を新しく実行した場合も、重ねて実行して問題ありません
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

### お知らせメール（レッスン到着・面談の前日）

会員へのお知らせメールは [Resend](https://resend.com)（無料プラン：1日100通・月3,000通まで）から送ります。

1. Resend に登録し、**Domains** で送信に使うドメイン（例：`tefcas-creation.com`）を追加して、表示される DNS の設定をドメインの管理画面に登録する（確認が終わるまで、会員宛てには送れません）
2. **API Keys** でキーを作成する（`re_` で始まる文字列。**このキーは誰にも送らないでください**）
3. ターミナルで次を実行

```bash
npx supabase secrets set \
  RESEND_API_KEY=re_... \
  MAIL_FROM="All Time Golf <info@送信に使うドメイン>" \
  SITE_URL=https://andole0713.github.io/-/app
npx supabase functions deploy notify-lesson
npx supabase functions deploy meeting-reminders --no-verify-jwt
```

- **レッスン到着**：管理者がレッスンを新しく保存すると、自動でメールが送られます（作成画面の「会員にメールでお知らせする」を外すと送りません）
- **面談の前日**：毎日1回、翌日（日本時間）に面談がある会員へ送ります。**SQL Editor** で次を実行してください（`CRON_SECRET` は動画の自動削除と同じもの）

```sql
select cron.schedule(
  'meeting-reminders',
  '0 1 * * *',  -- 毎日 1:00（UTC）＝日本時間 10:00
  $$
  select net.http_post(
    url := 'https://<プロジェクトID>.supabase.co/functions/v1/meeting-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  );
  $$
);
```

会員は「アカウント → お知らせメール」でいつでも停止できます。

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

### 面談の予約（LINE）

会員のマイページに「LINEで面談を予約する」ボタンがあります。LINEで日程が決まったら、会員詳細の「次回の面談日時」に入力して保存すると、会員のマイページに表示されます。

### 3本目以降の動画（追加料金・LINE）

サブスクリプション制は毎月2本まで送れます（月の区切りは日本時間の1日）。2本送ると、動画提出画面に「LINEで追加を申し込む」ボタンが表示されます。

1. LINEで申し込みを受け、お支払いを確認する
2. 管理者でログイン →「会員一覧」→ 該当の会員を開く
3. 「今月の追加本数」に追加する本数（例：1）を入れて **保存する**
4. 会員がその本数だけ追加で送れるようになります。翌月になると自動で0本に戻ります

本数の制限はデータベース側（`can_submit_video()`）でも確認しているため、画面を操作しても上限を超えて送ることはできません。

### ドリル動画（ドリル集）

管理画面の「ドリル集」でドリル（動画ファイル または YouTube のリンク）を登録し、レッスン作成画面で選んで会員に送ります。

- 同じドリルを何人の会員にも使い回せます（動画は1回だけ保存されるので、容量を節約できます）
- 会員ページの「ドリル」に、これまで届いたドリルがたまっていきます。**契約中（利用期限内）はいつでも見られ**、契約が終わると見られなくなります
- ドリルは自動では削除されません。不要になったら「ドリル集」から削除してください
- 動画ファイルは Storage の `drill-videos` に保存されます。大きな動画を扱うため、Supabase の **Storage → Settings → Upload file size limit** を 500MB 程度に上げてください（無料プランは 50MB が上限）

### ドリルの定期公開（ロードマップ）

入会時の初回カウンセリングで、会員ごとに「毎月1本のドリル」の計画（ロードマップ）を作ります。

1. 管理者でログイン →「会員一覧」→ 会員を開く →「ドリル定期公開」で最初の公開日と月数（通常12）を入れて **ロードマップを作成する**
2. 「編集する」で、各月のテーマ・ドリル（ドリル集から選ぶ）・会員へのひとことを入れて **保存する**
3. 公開日（日本時間）になると、その月のドリルが会員ページの「ドリル」に自動で公開されます。ホームにも「今月のドリル」が表示されます

会員ページでは、今月のドリルに「今日練習した」ボタン（練習した日を記録）と「今月のふり返り」の欄があり、公開された新しいドリルには NEW が付きます。管理者は会員詳細の「ドリル定期公開」で、各月の練習日数・ふり返り・未読を確認できます。ロードマップのゴールは編集画面の一番上で設定します。

公開したドリルを取り消すときは、会員詳細の「ドリル定期公開」で「取り消す」を押します（会員には「公開準備中」と表示され、ドリルは見えなくなります）。「再公開」で元に戻せます。

途中の変更：月の入れ替え（↑↓）、「この月から後ろを1か月ずらす」（休会などで延期するとき）、月の追加・削除、公開日を待たずに今すぐ公開、がいつでもできます。会員には、まだ公開前の月はテーマだけが見え、ドリルの中身は公開日まで見えません。

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
  manifest.webmanifest       ホーム画面に追加したときの名前・アイコン
  swing/                     撮影アプリ SwingFrame（ログイン不要。会員ページと同じアプリとしてホーム画面に追加される）
supabase/
  migrations/…_init.sql      データベースの表とアクセス権限（RLS）
  functions/
    create-checkout-session/ 決済ページを作成
    create-portal-session/   カード変更・プラン変更・解約ページを作成
    stripe-webhook/          Stripe からの通知で契約状態を更新
    purge-old-videos/        3か月を過ぎたお客様の動画を自動削除（ドリル動画は対象外）
    notify-lesson/           レッスン到着のお知らせメール
    meeting-reminders/       面談前日のお知らせメール
  config.toml
docs/SETUP.md                この手順書
index.html                   スクール紹介ページ（トップ）
prototype/                   旧デモ（ブラウザ内保存の試作品）
```

## 管理者の運用（やること・面談管理）

- 管理者でログインすると最初に「やること」画面が開きます。確認待ちの動画、結果が未入力の面談、今月まだ面談の予定がない会員、支払い遅延、30日間動きがない会員などを一覧で確認できます。赤い数字がなくなれば対応漏れはありません
- 面談はLINEで日程を決めたあと「面談」画面の「＋ 面談を予約」で登録します。面談が終わったら「結果を入力」で完了・欠席・キャンセルを選び、まとめを書くと会員のホームに表示されます
- 会員詳細の「担当者メモ」は会員には表示されません。電話・LINEでのやり取りや支払い確認などを残しておくと、スタッフ間で共有できます
- 以前の「次回の面談日時」の入力欄は面談管理に移りました（入力済みの日時は `20261013000000_admin_ops.sql` を実行すると自動で引き継がれます）
