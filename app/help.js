// はじめての方へ・図解・用語集（ゴルフを始めたばかりの方にも分かるように）
// 画面の部品（ヘッダー・メニュー）は app.js 側で付ける。ここは中身だけ。

export const HELP_TABS = [
  ['help', 'はじめての方へ'],
  ['help/zukai', '図解で見る'],
  ['help/words', '用語集'],
];

// ---------- はじめての方へ ----------
const FLOW = [
  ['video', '撮る', 'スマホでスイングを撮影（撮影機能「SwingFrame」）'],
  ['video', '送る', '撮った動画をコーチに送信'],
  ['lesson', '解説が届く', 'コーチが動画を見て「レッスン」を作成'],
  ['drill', '練習する', 'レッスンの「練習」や毎月の「ドリル」に取り組む'],
  ['score', '記録する', 'ラウンドのスコアを記録して上達を確認'],
];

const TABS_EXPLAIN = [
  ['home', 'ホーム', 'home', '次にやること・今月のドリル・残りの回数など、いま大事なことがまとめて見られます'],
  ['video', '撮影・提出', 'video', 'スイングを撮影して、コーチに動画を送ります。動画の撮影・保存のみでも使えます'],
  ['lesson', 'レッスン', 'book', 'コーチから届いたレッスンと、送った動画をあとから見返せます'],
  ['drill', 'ドリル', 'target', '毎月1つ届く練習メニュー（ドリル）と、1年間の練習計画が見られます'],
  ['menu', 'メニュー', 'grid', 'スコア記録・お祝い・用語集・アカウントなど、すべての機能はここから'],
];

function firstPage(icon) {
  return `
  <section class="card help-intro">
    <p class="help-lead">ゴルフがはじめての方も大丈夫です。<br>このアプリは、<b>スマホで撮ったスイング動画をコーチに送り、解説を受けながら上達していく</b>オンラインレッスンです。</p>
  </section>

  <h2 class="help-h"><span class="help-num">1</span>このアプリでできること</h2>
  <div class="help-flow">${FLOW.map(([cat, t, d], i) => `<div class="hf-step cat-${cat}"><span class="hf-n">${i + 1}</span><b>${t}</b><small>${d}</small></div>`).join('<span class="hf-arrow" aria-hidden="true">↓</span>')}
    <p class="hf-loop">↻ これをくり返して、少しずつ上達していきます</p></div>

  <h2 class="help-h"><span class="help-num">2</span>画面の下のメニュー</h2>
  <p class="muted small">画面のいちばん下にあるボタンで、ページを切り替えます。色ごとに役割が分かれています。</p>
  <div class="help-tabs-explain">${TABS_EXPLAIN.map(([cat, label, ic, d]) => `<div class="hte cat-${cat}"><span class="hte-ic">${icon(ic)}</span><div><b>${label}</b><small>${d}</small></div></div>`).join('')}</div>
  <p class="muted small">画面の右上の「<b>撮影</b>」ボタンからも、いつでも撮影を始められます。</p>

  <h2 class="help-h"><span class="help-num">3</span>まずはこの順番で</h2>
  <ol class="help-check">
    <li><b>Myクラブを登録する</b><small>メニュー →「アカウント」で、持っているクラブを選びます（持っていなくてもOK）</small></li>
    <li><b>動画を1本送ってみる</b><small>「撮影・提出」から。撮り方は「図解で見る」の「撮影の向き」を参考に</small></li>
    <li><b>レッスンを見る</b><small>コーチから届くとメールでお知らせ。「レッスン」に <span class="new-badge">NEW</span> が付きます</small></li>
    <li><b>練習してチェックする</b><small>レッスンの「次回までの練習」や毎月のドリルを練習したら、タップして記録します</small></li>
    <li><b>面談を予約する</b><small>ホームの「LINEで面談を予約する」から。コーチと画面越しに話せます</small></li>
  </ol>

  <h2 class="help-h"><span class="help-num">4</span>ゴルフの基本（3分で分かる）</h2>
  <div class="card help-basics">
    <dl>
      <dt>どんなスポーツ？</dt><dd>止まっているボールをクラブで打ち、<b>できるだけ少ない回数でカップ（穴）に入れる</b>スポーツです。打った回数がそのままスコアになり、<b>少ないほど良い</b>成績です。</dd>
      <dt>1ラウンド＝18ホール</dt><dd>コースは18の「ホール」でできています。18ホールを回ることを「1ラウンド」と言い、4〜5時間ほどかけてプレーします。</dd>
      <dt>パー＝基準の打数</dt><dd>ホールごとに「このくらいで入れられたら上手」という基準（パー3・4・5）があります。18ホールの合計は基本<b>72</b>です。</dd>
      <dt>目標の目安</dt><dd>はじめてのラウンドは<b>120〜150</b>くらいがふつうです。上達の目安として「<b>100切り</b>」（99以下）、「<b>90切り</b>」（89以下）がよく目標にされます。</dd>
      <dt>クラブは最大14本</dt><dd>遠くへ飛ばす「ドライバー」から、グリーンの上で転がす「パター」まで、距離に合わせて使い分けます。最初は数本でも大丈夫です。</dd>
    </dl>
    <p class="muted small" style="margin:8px 0 0">くわしくは「図解で見る」と「用語集」をご覧ください。</p>
  </div>

  <h2 class="help-h"><span class="help-num">5</span>よくある質問</h2>
  <div class="help-faq">
    <details><summary>クラブを持っていなくても始められますか？</summary><p>はい。練習場ではクラブを借りられるところが多いです。まずは7番アイアン1本から始める方もいます。何をそろえればよいかは、面談やLINEでコーチに相談してください。</p></details>
    <details><summary>どこで撮影すればいいですか？</summary><p>ゴルフ練習場（打ちっぱなし）や、自宅で素振りをする様子でも大丈夫です。周りの人の迷惑にならない場所で、全身とクラブが画面に入るように撮りましょう。</p></details>
    <details><summary>どんな動画を送ればいいですか？</summary><p>ふだん通りのスイングを1〜3回撮れば十分です。「右に曲がる」「当たらない」など、気になっていることを一緒に書いて送ると、コーチがそこを中心に解説します。</p></details>
    <details><summary>レッスンはいつ届きますか？</summary><p>動画を送ってから、通常2日以内に届きます。届くとメールでお知らせし、「レッスン」に NEW が付きます。</p></details>
    <details><summary>言葉の意味が分からないときは？</summary><p>「用語集」で調べられます。それでも分からないときは、遠慮なくLINEでコーチに聞いてください。</p></details>
  </div>`;
}

// ---------- 図解 ----------
// 撮影の向き（上から見た図）
const SVG_ANGLE = `<svg viewBox="0 0 360 250" class="zk-svg" role="img" aria-label="撮影の向きの図：正面はボールの向こう側から体の正面を、後方は打つ方向の真後ろから撮ります">
  <rect x="0" y="0" width="360" height="250" rx="14" fill="#eef5ea"/>
  <line x1="66" y1="132" x2="334" y2="132" stroke="#9cb79a" stroke-width="2" stroke-dasharray="6 6"/>
  <path d="M322 124l14 8-14 8" fill="none" stroke="#5f8a5c" stroke-width="2.5"/>
  <text x="238" y="152" font-size="12.5" fill="#3f6b3c" font-weight="700">打つ方向（目標）→</text>
  <circle cx="190" cy="132" r="5" fill="#fff" stroke="#555"/>
  <text x="198" y="124" font-size="11.5" fill="#555">ボール</text>
  <g stroke="#1f2d24" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="170" cy="194" rx="6" ry="10" fill="#fff" stroke-width="2"/>
    <ellipse cx="210" cy="194" rx="6" ry="10" fill="#fff" stroke-width="2"/>
    <path d="M166 176Q178 158 191 151M214 176Q203 160 192 151" fill="none" stroke-width="9"/>
    <path d="M166 176Q178 158 191 151M214 176Q203 160 192 151" fill="none" stroke="#fff" stroke-width="5"/>
    <rect x="160" y="171" width="60" height="16" rx="8" fill="#fff" stroke-width="2.2"/>
    <circle cx="190" cy="179" r="9.5" fill="#f0d9b5" stroke-width="2"/>
    <path d="M181 175a9.5 9.5 0 0 1 18 0z" fill="#1f2d24" stroke-width="1"/>
    <path d="M184 172q6-7 12 0" fill="#1f2d24" stroke-width="1"/>
    <circle cx="191.5" cy="151" r="4" fill="#fff" stroke-width="1.8"/>
  </g>
  <line x1="191" y1="148" x2="190" y2="136" stroke="#777" stroke-width="2"/>
  <text x="222" y="186" font-size="12" fill="#1f2d24" font-weight="700">あなた（右打ち）</text>
  <text x="222" y="200" font-size="10.5" fill="#1f2d24">左肩が打つ方向を向く</text>
  <text x="104" y="226" font-size="10.5" fill="#1f2d24">（上から見た図・ボールの方を向いて立つ）</text>
  <g transform="translate(190 36)"><rect x="-17" y="-11" width="34" height="22" rx="4" fill="#2f6fb0"/><circle r="5.5" fill="#fff"/></g>
  <path d="M190 50v70" stroke="#2f6fb0" stroke-width="2" stroke-dasharray="4 4"/>
  <text x="214" y="32" font-size="14" font-weight="700" fill="#2f6fb0">正面から</text>
  <text x="214" y="49" font-size="11" fill="#2f6fb0">ボールの向こう側から、</text>
  <text x="214" y="64" font-size="11" fill="#2f6fb0">体の正面（おなか側）を撮る</text>
  <g transform="translate(36 132) rotate(90)"><rect x="-17" y="-11" width="34" height="22" rx="4" fill="#c46a1b"/><circle r="5.5" fill="#fff"/></g>
  <path d="M50 132h128" stroke="#c46a1b" stroke-width="2" stroke-dasharray="4 4"/>
  <text x="14" y="88" font-size="14" font-weight="700" fill="#c46a1b">後方から</text>
  <text x="14" y="105" font-size="11" fill="#c46a1b">打つ方向の真後ろから撮る</text>
</svg>`;

// ゴルフコース（上から見た図）
const SVG_COURSE = `<svg viewBox="0 0 360 230" class="zk-svg" role="img" aria-label="ゴルフコースの図：ティーグラウンドから打ち、フェアウェイを通って、グリーンのカップに入れます">
  <rect x="0" y="0" width="360" height="230" rx="14" fill="#cfe3c4"/>
  <line x1="10" y1="22" x2="350" y2="22" stroke="#fff" stroke-width="3" stroke-dasharray="2 10"/>
  <text x="14" y="16" font-size="10.5" fill="#3c5a37" font-weight="700">OB（コースの外・白い杭）</text>
  <path d="M40 150 C110 140 150 70 230 80 S320 110 320 110 L322 140 C280 130 250 112 230 116 C170 122 130 186 44 182z" fill="#a8d08d"/>
  <rect x="22" y="152" width="36" height="24" rx="4" fill="#8cc070" stroke="#5f8a5c"/>
  <circle cx="300" cy="122" r="30" fill="#7fbf63" stroke="#5f9e47" stroke-width="2"/>
  <line x1="304" y1="126" x2="304" y2="98" stroke="#333" stroke-width="2"/><path d="M304 98l14 5-14 5z" fill="#d64b3c"/>
  <circle cx="304" cy="126" r="2.6" fill="#222"/>
  <ellipse cx="255" cy="160" rx="22" ry="10" fill="#efe1b5" stroke="#d6c38b"/>
  <ellipse cx="160" cy="75" rx="18" ry="9" fill="#efe1b5" stroke="#d6c38b"/>
  <path d="M170 170 C185 150 225 160 215 190 C200 210 165 200 170 170z" fill="#8ec3e6" stroke="#6aa8d2"/>
  <path d="M40 164 Q120 90 190 108 Q255 116 300 124" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="3 4"/>
  <g font-size="11" font-weight="700" fill="#1f2d24">
    <text x="14" y="198">① ティーグラウンド</text><text x="14" y="212" font-weight="400" font-size="10">最初に打つ場所</text>
    <text x="96" y="134">② フェアウェイ</text><text x="96" y="147" font-weight="400" font-size="10">芝が短く打ちやすい</text>
    <text x="100" y="44">ラフ（芝が長い）</text>
    <text x="134" y="62" font-size="10">バンカー（砂）</text>
    <text x="222" y="220">池（ハザード）</text>
    <text x="268" y="176">バンカー</text>
    <text x="262" y="78">③ グリーン</text><text x="262" y="91" font-weight="400" font-size="10">旗の下にカップ</text>
  </g>
</svg>`;

// スイングの流れ（正面から見た人型・右打ち）。撮影機能のガイドと同じ、線で描いた人型
// 各場面の体の位置：sc=肩の中心, sw=肩幅の半分, hx/hy=手の位置, ca=クラブの向き（度・右=0 下=90）, cl=クラブの長さ, hp=腰の位置, trail=右足かかとを上げる
const POSES = [
  { sc: 60, sw: 13, hx: 61, hy: 76, ca: 92, cl: 42, hp: 60 },
  { sc: 58, sw: 11, hx: 38, hy: 70, ca: 186, cl: 34, hp: 59 },
  { sc: 57, sw: 8, hx: 40, hy: 25, ca: 2, cl: 34, hp: 58 },
  { sc: 58, sw: 9, hx: 38, hy: 40, ca: 300, cl: 34, hp: 60 },
  { sc: 60, sw: 11, hx: 46, hy: 64, ca: 228, cl: 34, hp: 62 },
  { sc: 61, sw: 13, hx: 63, hy: 76, ca: 94, cl: 42, hp: 63 },
  { sc: 63, sw: 10, hx: 84, hy: 62, ca: 318, cl: 34, hp: 64, trail: 1 },
  { sc: 64, sw: 8, hx: 79, hy: 22, ca: 196, cl: 34, hp: 65, trail: 2 },
];
const INK = '#1f2d24';
function figure(P, label, n) {
  const f = (v) => v.toFixed(1);
  const rad = (d) => (d * Math.PI) / 180;
  const ex = P.hx + P.cl * Math.cos(rad(P.ca)), ey = P.hy + P.cl * Math.sin(rad(P.ca));
  const sL = [P.sc - P.sw, 38], sR = [P.sc + P.sw, 38];         // 画面の左＝右肩、右＝左肩（正面から見た右打ち）
  const hL = [P.hp - 8, 74], hR = [P.hp + 8, 74];
  const kneeL = P.trail ? [P.hp - 2, 97] : [52, 97], kneeR = [68, 97];
  const ankL = P.trail === 2 ? [57, 117] : P.trail ? [52, 119] : [49, 120], ankR = [71, 120];
  const arm = (s) => { const mx = (s[0] + P.hx) / 2 + (s[0] < P.sc ? -3 : 3), my = (s[1] + P.hy) / 2; return `M${f(s[0])} ${f(s[1])}Q${f(mx)} ${f(my)} ${f(P.hx)} ${f(P.hy)}`; };
  const leg = (h, k, a) => `M${f(h[0])} ${f(h[1])}L${f(k[0])} ${f(k[1])}L${f(a[0])} ${f(a[1])}`;
  const legs = (w, color) => `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${w}">
      <path d="${leg(hL, kneeL, ankL)}"/><path d="${leg(hR, kneeR, ankR)}"/></g>`;
  const arms = (w, color) => `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${w}">
      <path d="${arm(sL)}"/><path d="${arm(sR)}"/></g>`;
  const torso = `M${f(sL[0] - 1)} ${f(sL[1] - 1)}Q${f(P.sc)} ${f(sL[1] - 5)} ${f(sR[0] + 1)} ${f(sR[1] - 1)}L${f(hR[0] + 1)} ${f(hR[1] - 4)}L${f(hL[0] - 1)} ${f(hL[1] - 4)}Z`;
  const shoe = (a, up) => `<ellipse cx="${f(a[0] + (up ? 0 : a[0] < 60 ? -2 : 2))}" cy="${f(a[1] + 3)}" rx="${up ? 3 : 6}" ry="3" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`;
  return `<figure class="zk-fig"><svg viewBox="0 0 120 130" aria-hidden="true">
    <line x1="4" y1="125" x2="116" y2="125" stroke="#b9c7b4" stroke-width="2"/>
    ${n <= 2 || n === 6 ? '<circle cx="60" cy="122" r="2.8" fill="#fff" stroke="#666"/>' : ''}
    ${legs(13, INK)}${legs(9, '#fff')}
    <path d="M${f(hL[0] - 1)} ${f(hL[1] - 3)}L${f(hR[0] + 1)} ${f(hR[1] - 3)}" stroke="${INK}" stroke-width="2.4"/>
    ${shoe(ankL, P.trail === 2)}${shoe(ankR)}
    <path d="${torso}" fill="#fff" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/>
    <circle cx="${f(P.sc)}" cy="24" r="8.5" fill="#fff" stroke="${INK}" stroke-width="2.2"/>
    <path d="M${f(P.sc - 9)} 22Q${f(P.sc)} 9 ${f(P.sc + 9)} 22Z" fill="${INK}"/>
    <path d="M${f(P.sc - 9)} 22h18" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="${f(P.hx)}" y1="${f(P.hy)}" x2="${f(ex)}" y2="${f(ey)}" stroke="#555" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${f(ex)}" cy="${f(ey)}" r="3" fill="#8a9097"/>
    ${arms(8.5, INK)}${arms(4.5, '#fff')}
    <circle cx="${f(P.hx)}" cy="${f(P.hy)}" r="3.6" fill="#fff" stroke="${INK}" stroke-width="1.8"/>
  </svg><figcaption><span>${n}</span>${label}</figcaption></figure>`;
}
const SWING = [
  ['アドレス', '構える'], ['テークバック', 'クラブを上げ始める'], ['トップ', 'いちばん上'], ['切り返し', '下ろし始める'],
  ['ダウンスイング', '下ろす'], ['インパクト', 'ボールに当たる瞬間'], ['フォロースルー', '振り抜く'], ['フィニッシュ', '振り終わり'],
];

// クラブの種類と飛ぶ距離の目安
const CLUBS = [
  ['ドライバー', '1W', 'いちばん遠くへ飛ばす。最初の1打で使う', 200, 'wood-l'],
  ['フェアウェイウッド', '3W・5W', '芝の上から遠くへ', 180, 'wood'],
  ['ユーティリティ', 'UT', 'ウッドとアイアンの中間。やさしく打てる', 160, 'ut'],
  ['アイアン', '5〜9番', '番号が大きいほど短く、高く上がる（7番が基準）', 130, 'iron'],
  ['ウェッジ', 'PW・AW・SW', 'グリーンの近く・バンカーから', 90, 'wedge'],
  ['パター', 'PT', 'グリーンの上で転がしてカップへ', 0, 'putter'],
];
const HEAD = {
  'wood-l': '<path d="M10 6v20" stroke="#555" stroke-width="2"/><ellipse cx="17" cy="30" rx="11" ry="7" fill="#1f2d24"/>',
  wood: '<path d="M10 6v22" stroke="#555" stroke-width="2"/><ellipse cx="16" cy="31" rx="8" ry="5" fill="#1f2d24"/>',
  ut: '<path d="M10 6v23" stroke="#555" stroke-width="2"/><path d="M8 28h12l2 6H8z" fill="#1f2d24"/>',
  iron: '<path d="M10 6v24" stroke="#555" stroke-width="2"/><path d="M9 29l13 1-1 6-12-1z" fill="#8a9097"/>',
  wedge: '<path d="M10 6v24" stroke="#555" stroke-width="2"/><path d="M9 29l12-2 2 8-13 1z" fill="#8a9097"/>',
  putter: '<path d="M10 6v26" stroke="#555" stroke-width="2"/><rect x="6" y="31" width="18" height="5" rx="1.5" fill="#1f2d24"/>',
};

// スコアの数え方（パー4の例）
const SVG_SCORE = `<svg viewBox="0 0 360 120" class="zk-svg" role="img" aria-label="パー4のホールの例：4回でカップに入れるとパー">
  <rect x="0" y="0" width="360" height="120" rx="14" fill="#eef5ea"/>
  <rect x="14" y="62" width="30" height="20" rx="3" fill="#8cc070"/>
  <circle cx="318" cy="72" r="26" fill="#7fbf63"/>
  <line x1="324" y1="76" x2="324" y2="50" stroke="#333" stroke-width="2"/><path d="M324 50l12 4-12 4z" fill="#d64b3c"/>
  <circle cx="324" cy="76" r="2.4" fill="#222"/>
  <g fill="none" stroke="#c46a1b" stroke-width="2" stroke-dasharray="4 4">
    <path d="M30 70 Q95 0 160 66"/><path d="M160 66 Q230 18 296 70"/><path d="M296 72 Q306 78 312 76"/><path d="M312 76 L322 76"/></g>
  <g font-size="11.5" font-weight="700" fill="#c46a1b">
    <text x="80" y="22">1打目</text><text x="210" y="30">2打目</text><text x="268" y="104">3打目</text><text x="314" y="112">4打目</text></g>
  <circle cx="160" cy="66" r="3.5" fill="#fff" stroke="#555"/><circle cx="296" cy="71" r="3.5" fill="#fff" stroke="#555"/>
  <text x="14" y="104" font-size="11" fill="#1f2d24">スタート</text>
  <text x="126" y="104" font-size="12" fill="#1f2d24" font-weight="700">4回で入れる ＝ パー</text>
</svg>`;
const SCORE_TERMS = [
  ['イーグル', '−2', 'パーより2打少ない', 'great'], ['バーディ', '−1', 'パーより1打少ない', 'great'],
  ['パー', '±0', '基準どおり', 'good'], ['ボギー', '+1', 'パーより1打多い', ''],
  ['ダブルボギー', '+2', 'パーより2打多い', ''], ['トリプルボギー', '+3', 'パーより3打多い', ''],
];

function zukaiPage(icon) {
  return `
  <nav class="zk-index" aria-label="図解の目次">
    <a href="#zk-angle">撮影の向き</a><a href="#zk-swing">スイングの流れ</a><a href="#zk-course">コースのつくり</a><a href="#zk-clubs">クラブの種類</a><a href="#zk-score">スコアの数え方</a>
  </nav>

  <section class="card zk cat-video" id="zk-angle">
    <h2 class="zk-h">${icon('video')}撮影の向き</h2>
    <p>動画は「<b>正面</b>」か「<b>後方</b>」のどちらかから撮ります。送るときに、どちらから撮ったかを選びます。</p>
    ${SVG_ANGLE}
    <ul class="zk-points"><li>頭から足先まで、<b>クラブ全体</b>が画面に入るように</li><li>スマホは<b>胸の少し下あたりの高さ</b>で固定（三脚があると安定）</li><li>ボールの近くに立ちすぎないよう、<b>2〜3m</b>はなれて撮る</li></ul>
  </section>

  <section class="card zk cat-drill" id="zk-swing">
    <h2 class="zk-h">${icon('target')}スイングの流れ</h2>
    <p>スイングは、構えてから振り終わるまでを8つの場面に分けて考えます。レッスンでは「トップで〜」「インパクトで〜」のように、この言葉で説明します。</p>
    <div class="zk-swing">${SWING.map(([t, d], i) => figure(POSES[i], `<b>${t}</b><small>${d}</small>`, i + 1)).join('')}</div>
    <p class="muted small">※ 右打ちの人を、正面（体の前）から見た図です。</p>
  </section>

  <section class="card zk cat-score" id="zk-course">
    <h2 class="zk-h">${icon('flag')}コースのつくり（1ホール）</h2>
    <p>①ティーグラウンドから打ち始め、②フェアウェイを通って、③グリーンの上にあるカップに入れたら、そのホールは終わりです。</p>
    ${SVG_COURSE}
    <ul class="zk-points"><li><b>ラフ</b>：芝が長く、ボールが打ちにくい場所</li><li><b>バンカー</b>：砂の場所。専用の打ち方があります</li><li><b>池・OB</b>：入ると1打の罰（ペナルティ）が加わります</li></ul>
  </section>

  <section class="card zk cat-lesson" id="zk-clubs">
    <h2 class="zk-h">${icon('club')}クラブの種類と飛ぶ距離の目安</h2>
    <p>クラブは長いほど遠くへ飛び、短いほど高く上がって正確に打てます。距離に合わせて使い分けます。</p>
    <div class="zk-clubs">${CLUBS.map(([n, s, d, y, h]) => `<div class="zc">
      <svg viewBox="0 0 30 40" aria-hidden="true">${HEAD[h]}</svg>
      <div class="zc-t"><b>${n}</b><span>${s}</span><small>${d}</small></div>
      <div class="zc-bar">${y ? `<i style="width:${Math.round((y / 220) * 100)}%"></i><em>約${y}ヤード</em>` : '<em>グリーンの上</em>'}</div></div>`).join('')}</div>
    <p class="muted small">※ 距離は大人の男性の一般的な目安です（1ヤード＝約0.9m）。人によって大きく変わります。</p>
  </section>

  <section class="card zk cat-celebrate" id="zk-score">
    <h2 class="zk-h">${icon('trophy')}スコアの数え方</h2>
    <p>ボールを打った回数を数えます。空振りも1回、池やOBに入ったときは罰として1回を足します。ホールごとの基準の回数を「<b>パー</b>」と言います。</p>
    ${SVG_SCORE}
    <div class="zk-terms">${SCORE_TERMS.map(([t, n, d, cls]) => `<div class="zt ${cls}"><b>${t}</b><span>${n}</span><small>${d}</small></div>`).join('')}</div>
    <p class="muted small">18ホール全部パーなら合計72。「100切り」は、18ホールの合計を99以下にすることです（だいたい1ホールあたりボギー＋α）。</p>
  </section>`;
}

// ---------- 用語集 ----------
const WORD_CATS = [['app', 'アプリ'], ['swing', 'スイング'], ['club', 'クラブ'], ['course', 'コース'], ['score', 'スコア'], ['play', '練習・その他']];
const WORDS = [
  ['app', 'レッスン', 'れっすん', '送った動画に対して、コーチが作る解説。ポイント・くわしい説明・次回までの練習がまとまっています。「レッスン」タブで見返せます。'],
  ['app', 'ドリル', 'どりる', '上達のための練習メニュー（動画つき）。毎月1つ届き、「ドリル」タブで見られます。'],
  ['app', 'ロードマップ', 'ろーどまっぷ', '1年間（12か月）の練習計画。毎月のテーマとドリルが順番に公開されます。'],
  ['app', '課題', 'かだい', 'コーチから出される、今月取り組むこと。できたらタップしてチェックします。'],
  ['app', '面談', 'めんだん', 'コーチとビデオ通話で話すオンラインレッスン（25分）。LINEで予約します。'],
  ['app', '権利', 'けんり', '動画を送れる回数・面談を受けられる回数のこと。毎月プランに応じて付与され、半年後の月末まで使えます。'],
  ['app', 'SwingFrame', 'すいんぐふれーむ', 'このアプリの撮影機能。ガイドに合わせて立つと自動で録画し、そのままコーチに送れます。'],
  ['app', '回数外', 'かいすうがい', 'コーチ側の都合などで、送った回数に数えない動画。権利は減りません。'],
  ['swing', 'アドレス', 'あどれす', 'ボールを打つ前に構えた姿勢。'],
  ['swing', 'グリップ', 'ぐりっぷ', 'クラブの握り方。また、クラブの握る部分のこと。'],
  ['swing', 'スタンス', 'すたんす', '足の開き方・立ち方。'],
  ['swing', '前傾（ぜんけい）', 'ぜんけい', '構えたときに、腰から上を前に傾けた角度。スイング中に保つことが大切です。'],
  ['swing', 'テークバック', 'てーくばっく', 'クラブを後ろに上げ始める動き。'],
  ['swing', 'トップ', 'とっぷ', 'クラブを上げきった、いちばん高い位置。'],
  ['swing', '切り返し', 'きりかえし', 'トップからクラブを下ろし始める瞬間。'],
  ['swing', 'ダウンスイング', 'だうんすいんぐ', 'トップからボールに向かってクラブを下ろす動き。'],
  ['swing', 'インパクト', 'いんぱくと', 'クラブがボールに当たる瞬間。'],
  ['swing', 'フォロースルー', 'ふぉろーするー', 'ボールを打ったあと、クラブを振り抜く動き。'],
  ['swing', 'フィニッシュ', 'ふぃにっしゅ', 'スイングの最後の、振り終わった姿勢。'],
  ['swing', 'スライス', 'すらいす', 'ボールが右へ大きく曲がること（右利きの場合）。初心者に多い悩みです。'],
  ['swing', 'フック', 'ふっく', 'ボールが左へ大きく曲がること（右利きの場合）。'],
  ['swing', 'ダフリ', 'だふり', 'ボールの手前の地面を打ってしまうミス。'],
  ['swing', 'トップ（ミス）', 'とっぷ', 'ボールの上の方を打ってしまい、低く転がるミス。スイングの「トップ」とは別の意味です。'],
  ['swing', 'シャンク', 'しゃんく', 'クラブの根元に当たり、ボールが右へ真横に近い方向へ飛ぶミス。'],
  ['swing', 'ヘッドスピード', 'へっどすぴーど', 'クラブの先（ヘッド）が動く速さ。速いほど遠くへ飛びます。'],
  ['club', 'ドライバー', 'どらいばー', 'いちばん遠くへ飛ばすクラブ。ホールの最初の1打で使います。「1W」とも書きます。'],
  ['club', 'ウッド', 'うっど', 'ヘッドが大きく丸いクラブ。遠くへ飛ばすときに使います（3W・5Wなど）。'],
  ['club', 'ユーティリティ', 'ゆーてぃりてぃ', 'ウッドとアイアンの中間のクラブ。やさしく打てるので人気です（UT）。'],
  ['club', 'アイアン', 'あいあん', '金属の薄いヘッドのクラブ。番号が大きいほど短く、高く上がります（7番アイアンが練習の基本）。'],
  ['club', 'ウェッジ', 'うぇっじ', 'グリーンの近くやバンカーで使う、短い距離用のクラブ（PW・AW・SW）。'],
  ['club', 'パター', 'ぱたー', 'グリーンの上で、ボールを転がしてカップに入れるためのクラブ。'],
  ['club', 'シャフト', 'しゃふと', 'クラブの棒の部分。'],
  ['club', 'ヘッド', 'へっど', 'クラブの先の、ボールに当たる部分。'],
  ['club', 'フェース', 'ふぇーす', 'ヘッドの、ボールに当たる面。この向きでボールの方向が決まります。'],
  ['course', 'ホール', 'ほーる', 'コースの1区切り。ティーグラウンドからグリーンまで。1ラウンドは18ホールです。'],
  ['course', 'ティーグラウンド', 'てぃーぐらうんど', '各ホールで最初に打つ場所。'],
  ['course', 'ティー', 'てぃー', '最初の1打のときに、ボールを乗せる小さな台。'],
  ['course', 'フェアウェイ', 'ふぇあうぇい', 'ティーグラウンドからグリーンまでの、芝が短く打ちやすい場所。'],
  ['course', 'ラフ', 'らふ', 'フェアウェイの外側の、芝が長い場所。'],
  ['course', 'バンカー', 'ばんかー', '砂が入ったくぼみ。'],
  ['course', 'グリーン', 'ぐりーん', 'カップがある、芝がとても短く整えられた場所。パターで転がします。'],
  ['course', 'カップ', 'かっぷ', 'グリーンにある穴。ここにボールを入れたらホール終了です。'],
  ['course', 'OB', 'おーびー', '「アウト・オブ・バウンズ」の略。コースの外のこと。入ると1打の罰が加わり、打ち直しになります。'],
  ['course', 'ハザード', 'はざーど', '池など、ボールが入ると困る場所。'],
  ['score', 'パー', 'ぱー', 'ホールごとに決められた基準の打数。18ホールの合計は基本72です。'],
  ['score', 'ボギー', 'ぼぎー', 'パーより1打多いこと。'],
  ['score', 'バーディ', 'ばーでぃ', 'パーより1打少ないこと。'],
  ['score', 'ベストスコア', 'べすとすこあ', 'これまでで一番良かった（少なかった）18ホールのスコア。'],
  ['score', '100切り・90切り', 'ひゃくぎり', '18ホールの合計を99以下・89以下にすること。上達の目標としてよく使われます。'],
  ['score', 'ハーフ', 'はーふ', '18ホールの半分の9ホール。前半を「アウト」、後半を「イン」と呼びます。'],
  ['score', 'パット', 'ぱっと', 'グリーンの上で、パターで打つこと。'],
  ['play', '打ちっぱなし（練習場）', 'うちっぱなし', 'ボールを打つ練習ができる施設。クラブを借りられるところも多いです。'],
  ['play', 'ラウンド', 'らうんど', 'コースに出て18ホール（または9ホール）を回ること。'],
  ['play', '素振り', 'すぶり', 'ボールを打たずにクラブを振る練習。'],
  ['play', 'ハーフスイング', 'はーふすいんぐ', 'クラブを腰の高さくらいまでしか上げない、小さなスイング。基本の練習によく使います。'],
  ['play', 'ヤード', 'やーど', 'ゴルフで使う距離の単位。1ヤード＝約0.9m。'],
  ['play', 'アプローチ', 'あぷろーち', 'グリーンの近くから、カップに寄せるための短いショット。'],
];

function wordsPage() {
  return `
  <div class="card gl-search">
    <input type="search" data-glossary-search placeholder="言葉を入力して探す（例：トップ、バンカー）" aria-label="用語を検索" autocomplete="off">
    <div class="gl-cats" role="group" aria-label="分類で絞り込む">
      <button type="button" class="gl-cat on" data-action="glossary-cat" data-cat="">すべて</button>
      ${WORD_CATS.map(([k, l]) => `<button type="button" class="gl-cat c-${k}" data-action="glossary-cat" data-cat="${k}">${l}</button>`).join('')}
    </div>
  </div>
  <dl class="gl-list">${WORDS.map(([c, w, kana, d]) => `<div class="gl-item c-${c}" data-cat="${c}" data-key="${w} ${kana} ${d}">
    <dt><span class="gl-tag">${WORD_CATS.find((x) => x[0] === c)[1]}</span>${w}</dt><dd>${d}</dd></div>`).join('')}</dl>
  <p class="empty gl-none" hidden>見つかりませんでした。LINEでコーチに聞いてみてください。</p>`;
}

export function helpPage(tab, icon) {
  if (tab === 'zukai') return zukaiPage(icon);
  if (tab === 'words') return wordsPage();
  return firstPage(icon);
}
