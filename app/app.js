import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { Upload as TusUpload } from 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SCHOOL_NAME, PLANS, CONTACT, GUIDE } from './config.js';

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const state = { session: null, profile: null, recovery: false, authTab: 'login', authMessage: '', unread: 0, historyClub: '' };
let renderSeq = 0;

// ---------- ユーティリティ ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const fmtDate = (d) => (d ? String(d).slice(0, 10).replaceAll('-', '.') : '');
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（端末の日付）

let toastTimer;
function toast(msg, bad = false) {
  $toast.textContent = msg;
  $toast.classList.toggle('bad', bad);
  $toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.add('hidden'), 3500);
}

// 確認画面（「変更する」を押すと true、「キャンセル」・背景・Esc で false）
function confirmDialog({ title, body, ok = '変更する' }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">${esc(title)}</h2>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button type="button" class="btn-sub" data-modal="cancel">キャンセル</button>
        <button type="button" class="btn-gold" data-modal="ok">${esc(ok)}</button>
      </div></div>`;
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      prev?.focus?.();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Tab') { // フォーカスを確認画面の中に留める
        const btns = [...wrap.querySelectorAll('button')];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
      }
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.dataset.modal === 'cancel') close(false);
      else if (e.target.dataset.modal === 'ok') close(true);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-modal="ok"]').focus();
  });
}

// この端末だけの設定（文字の大きさ・ホーム画面追加の案内を閉じたか）。保存できない環境でも動くようにする
const local = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* noop */ } },
};
const FONT_SIZES = [['m', '標準'], ['l', '大きめ'], ['xl', '特大']];
function applyFontSize(size = local.get('atg-font-size') || 'm') {
  document.documentElement.dataset.fs = FONT_SIZES.some(([k]) => k === size) ? size : 'm';
}
applyFontSize();

// ホーム画面に追加（Android の Chrome などはボタンから追加できる。iPhone は共有メニューから）
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// YouTube の URL から動画 ID を取り出し、https://youtu.be/ID の形にそろえる
function normalizeYoutube(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://youtu.be/${id}` : null;
}
function youtubeId(url) {
  const n = normalizeYoutube(url);
  return n ? n.slice(-11) : null;
}
// ---------- お客様のスイング動画（Storage に保存） ----------
// Myクラブセッティングで選べる一般的なクラブ（自由入力で追加もできる）
const CLUB_PRESETS = ['ドライバー', '3W', '5W', '7W', '3U', '4U', '5U', '4I', '5I', '6I', '7I', '8I', '9I', 'PW', 'AW', 'SW', 'LW', 'パター'];
// Myクラブセッティングを登録していない会員に出す、これまでの選択肢
const DEFAULT_CLUB_OPTIONS = ['ドライバー', 'フェアウェイウッド', 'ユーティリティ', 'アイアン', 'ウェッジ', 'パター', 'その他'];

function clubChip(name, checked) {
  return `<label class="chip"><input type="checkbox" name="club" value="${esc(name)}"${checked ? ' checked' : ''}><span>${esc(name)}</span></label>`;
}

const VIDEO_BUCKET = 'swing-videos';
const RETENTION_LABEL = '3か月';

// 動画ファイルを再開できる方式（tus）でアップロードする。大きな動画や途切れやすい回線でも送れる。
async function uploadVideo(file, path, onProgress) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('ログインし直してください');
  await new Promise((resolve, reject) => {
    const upload = new TusUpload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${token}`, 'x-upsert': 'false' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: { bucketName: VIDEO_BUCKET, objectName: path, contentType: file.type || 'video/mp4', cacheControl: '3600' },
      chunkSize: 6 * 1024 * 1024, // Supabase の決まり（6MB 単位）
      onError: (e) => reject(new Error('動画を送信できませんでした。電波のよい場所でもう一度お試しください。')),
      onProgress: (sent, total) => onProgress(total ? sent / total : 0),
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    });
  });
}

function videoFileName(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

// 再生用の一時的なリンク（1時間有効）をまとめて作る
async function signedVideoUrls(subs) {
  const paths = subs.filter((x) => x && x.video_path && !x.video_deleted_at).map((x) => x.video_path);
  if (!paths.length) return {};
  const { data, error } = await sb.storage.from(VIDEO_BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

function swingVideo(sub, urls) {
  if (!sub) return '';
  if (sub.video_deleted_at) return `<p class="muted small">保存期間（${RETENTION_LABEL}）を過ぎたため、動画は削除されました。</p>`;
  const url = urls[sub.video_path];
  return url
    ? `<video class="swing-video" src="${esc(url)}" controls playsinline preload="metadata"></video>`
    : '<p class="muted small">動画を読み込めませんでした。ページを再読み込みしてください。</p>';
}

// 送った動画の保存期限（送信から3か月）
function videoExpiry(createdAt) {
  const d = new Date(createdAt);
  d.setMonth(d.getMonth() + 3);
  return d;
}
function daysLeft(date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86400000));
}

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))}MB`;
}

function videoEmbed(url) {
  const id = youtubeId(url);
  if (!id) return '';
  return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube 動画" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>
    <a class="muted small" href="https://youtu.be/${id}" target="_blank" rel="noopener">YouTube で開く ↗</a>`;
}

const STATUS_LABEL = {
  active: ['契約中', 'ok'], trialing: ['お試し中', 'ok'], past_due: ['支払い遅延', 'warn'],
  unpaid: ['未払い', 'bad'], canceled: ['解約済み', 'bad'], incomplete: ['手続き中', 'warn'],
  incomplete_expired: ['期限切れ', 'bad'], paused: ['一時停止', 'warn'], none: ['未契約', ''],
};
function statusPill(status) {
  const [label, cls] = STATUS_LABEL[status] ?? [status, ''];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}
// 利用できる会員：Stripe で契約中、または管理者が設定した利用期限内（LINE・電話で申し込んだ会員）
const isActive = (p) => ['active', 'trialing'].includes(p?.subscription_status)
  || (!!p?.access_until && p.access_until >= new Date().toLocaleDateString('sv-SE'));
function memberPill(p) {
  if (!['active', 'trialing'].includes(p.subscription_status) && isActive(p)) return '<span class="pill ok">利用中</span>';
  return statusPill(p.subscription_status);
}
const planOf = (id) => PLANS.find((pl) => pl.id === id);
const planLabel = (id) => planOf(id)?.name ?? id ?? '';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
// <input type="datetime-local"> 用の値（端末の時刻）
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtShort(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function meetingWhen(iso) {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `<b class="when">${d.getMonth() + 1}/${d.getDate()}<small>（${WEEK[d.getDay()]}）</small><em>${hm}</em></b>`;
}
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); };
// 今月の1日（YYYY-MM-01）。追加本数が有効な月の判定に使う
const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
// 今月の追加本数（LINE で申し込み → コーチが会員詳細で設定。月が変わると 0 本）
const extraThisMonth = (p) => (p.extra_submissions_month === monthKey() ? p.extra_submissions || 0 : 0);
// 今月送れる本数（上限のないプランは null）。データベースの can_submit_video() と同じ計算
function quotaOf(p) {
  const base = planOf(p.plan)?.monthly?.submissions;
  return base ? base + extraThisMonth(p) : null;
}
const lineBtn = (label) => `<a class="btn btn-block btn-line" href="${esc(CONTACT.lineUrl)}" target="_blank" rel="noopener">${label}</a>`;

function getRoute() {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}
function go(path) {
  if (location.hash === `#/${path}`) render();
  else location.hash = `/${path}`;
}

function header(title, back) {
  return `<div class="top">
    <div class="row">${back ? `<a class="back" href="#/${back}" aria-label="戻る">‹</a>` : ''}
      <div><div class="brand">${esc(title)}</div><div class="muted">Members</div></div></div>
    <a href="../" aria-label="${esc(SCHOOL_NAME)} トップページへ"><img class="top-logo" src="../assets/logo-mark.png" width="200" height="170" alt="${esc(SCHOOL_NAME)}"></a>
  </div>`;
}
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M8 7h7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  inbox: '<path d="M3 13l3-8h12l3 8"/><path d="M3 13v6h18v-6h-5l-1 3H9l-1-3z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5c2.5 0 4.5 1.5 5.5 4.5"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
function nav(items, active) {
  return `<nav class="nav" style="grid-template-columns:repeat(${items.length},1fr)">${items
    .map(([path, ic, label, badge]) => `<a href="#/${path}" class="${active === path ? 'active' : ''}"${active === path ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge ? `<em class="nav-badge" aria-label="未読${badge}件">${badge}</em>` : ''}</a>`)
    .join('')}</nav>`;
}
const memberNav = (active) => nav([['home', 'home', 'ホーム'], ['submit', 'video', '動画提出'], ['history', 'book', '履歴', state.unread], ['account', 'user', 'アカウント']], active);
const newBadge = (l) => (l.read_at ? '' : '<span class="new-badge">NEW</span>');
const adminNav = (active) => nav([['admin/inbox', 'inbox', '提出動画'], ['admin/members', 'users', '会員一覧'], ['account', 'user', 'アカウント']], active);

async function must(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function loadProfile() {
  const uid = state.session?.user?.id;
  if (!uid) { state.profile = null; return; }
  state.profile = await must(sb.from('profiles').select('*').eq('id', uid).single());
}

async function callFunction(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = 'エラーが発生しました';
    try { msg = (await error.context.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return data;
}

// ---------- 画面：未設定・ログイン ----------

function authShell(inner) {
  return `<div class="auth-page"><div class="auth">
    <a class="auth-logo" href="../" aria-label="${esc(SCHOOL_NAME)} トップページへ"><img src="../assets/logo.png" width="880" height="626" alt="オルタイムゴルフ"><small>MEMBERS</small></a>
    <div class="auth-card">${inner}</div>
    <a class="auth-back" href="../">‹ トップページへ戻る</a>
  </div></div>`;
}

function viewAuth() {
  const t = state.authTab;
  const notice = !configured
    ? '<div class="notice">会員ログインは現在準備中です。開設まで今しばらくお待ちください。</div>'
    : state.authMessage ? `<div class="notice">${esc(state.authMessage)}</div>` : '';
  const forms = {
    login: `<form class="form" data-form="login">
        <label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
        <label for="password">パスワード</label>
        <div class="pw"><input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="button" class="pw-toggle" data-action="toggle-password" aria-label="パスワードを表示">表示</button></div>
        <button class="btn-block btn-gold" type="submit">ログイン</button>
        <button type="button" class="link" data-action="auth-tab" data-tab="reset">パスワードをお忘れの方</button>
      </form>`,
    signup: `<form class="form" data-form="signup">
        <label for="name">お名前</label><input id="name" name="name" autocomplete="name" maxlength="50" required>
        <label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
        <label for="password">パスワード（8文字以上）</label>
        <div class="pw"><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
          <button type="button" class="pw-toggle" data-action="toggle-password" aria-label="パスワードを表示">表示</button></div>
        <button class="btn-block btn-gold" type="submit">登録する</button>
      </form>`,
    reset: `<form class="form" data-form="reset">
        <p class="muted">ご登録のメールアドレスに、パスワード再設定用のリンクをお送りします。</p>
        <label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
        <button class="btn-block btn-gold" type="submit">再設定メールを送る</button>
        <button type="button" class="link" data-action="auth-tab" data-tab="login">ログイン画面に戻る</button>
      </form>`,
  };
  const heading = { login: '会員ログイン', signup: '新規会員登録', reset: 'パスワードの再設定' }[t];
  return authShell(`
    ${t === 'reset' ? '' : `<div class="seg" role="tablist">
      <button type="button" role="tab" aria-selected="${t === 'login'}" data-action="auth-tab" data-tab="login" class="${t === 'login' ? 'active' : ''}">ログイン</button>
      <button type="button" role="tab" aria-selected="${t === 'signup'}" data-action="auth-tab" data-tab="signup" class="${t === 'signup' ? 'active' : ''}">新規登録</button>
    </div>`}
    <h1>${heading}</h1>
    ${notice}
    ${forms[t]}`);
}

function viewRecovery() {
  return authShell(`<h1>新しいパスワード</h1>
    <form class="form" data-form="new-password">
      <label for="password">新しいパスワード（8文字以上）</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
      <button class="btn-block btn-gold" type="submit">パスワードを変更する</button>
    </form>`);
}

// ---------- 画面：未契約（プラン選択） ----------

function viewPlans() {
  const p = state.profile;
  const troubled = ['past_due', 'unpaid', 'incomplete', 'paused'].includes(p.subscription_status);
  return header('プランを選ぶ') + `<div class="content">
    <div class="hero"><span class="pill">WELCOME</span><h1>${esc(p.name || 'ようこそ')}さん</h1>
      <div class="muted">プランを選んで決済が完了すると、動画提出やレッスンの閲覧ができるようになります。</div></div>
    ${troubled ? `<div class="notice">お支払いの確認ができていません（${esc(STATUS_LABEL[p.subscription_status]?.[0] ?? p.subscription_status)}）。
        カード情報を更新してください。<button class="btn-block" data-action="portal">お支払い情報を更新する</button></div>` : ''}
    ${troubled ? '' : PLANS.map((pl) => `<div class="card plan${pl.recommended ? ' rec' : ''}">
        <div class="between"><span class="eyebrow">${esc(pl.en)}</span>${pl.recommended ? '<span class="pill">中級〜上級者におすすめ</span>' : ''}</div>
        <h3>${esc(pl.name)}</h3>
        <p class="lead">${esc(pl.lead)}</p>
        <dl class="spec"><div><dt>対象</dt><dd>${esc(pl.target)}</dd></div><div><dt>お支払い</dt><dd>${esc(pl.payment)}</dd></div></dl>
        <div class="price">${esc(pl.price)}</div>
        <ul>${pl.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${pl.checkout
          ? `<button class="btn-block btn-gold" data-action="checkout" data-plan="${esc(pl.id)}">このプランで申し込む</button>`
          : `<p class="muted small" style="margin:12px 0 0">このプランは LINE またはお電話でお申し込みください。</p>
             <a class="btn btn-block btn-line" href="${esc(CONTACT.lineUrl)}" target="_blank" rel="noopener">LINEで申し込む</a>
             <a class="btn btn-block btn-sub" href="tel:${esc(CONTACT.tel)}">電話で申し込む（${esc(CONTACT.telDisplay)}）</a>`}
      </div>`).join('')}
    <p class="muted small">カード決済は Stripe の安全な決済ページで行います。解約・プラン変更はいつでも「アカウント」から行えます。</p>
  </div>` + nav([['plans', 'card', 'プラン'], ['account', 'user', 'アカウント']], 'plans');
}

// ---------- 画面：会員 ----------

async function viewMemberHome() {
  const p = state.profile;
  const since = monthStart();
  const [tasks, lessons, subs, monthSubs, monthLessons] = await Promise.all([
    must(sb.from('tasks').select('*').eq('member_id', p.id).order('sort_order').order('created_at')),
    must(sb.from('lessons').select('id, lesson_date, title, point, practice, practice_done, read_at').eq('member_id', p.id).order('lesson_date', { ascending: false }).order('created_at', { ascending: false }).limit(1)),
    must(sb.from('submissions').select('id, created_at, club, status').eq('member_id', p.id).eq('status', 'pending').order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id').eq('member_id', p.id).gte('created_at', since)),
    must(sb.from('lessons').select('id').eq('member_id', p.id).gte('created_at', since)),
  ]);
  const latest = lessons[0];
  const done = tasks.filter((t) => t.done).length;
  const plan = planOf(p.plan);
  const quota = quotaOf(p);
  const extra = extraThisMonth(p);
  return header('マイページ') + `<div class="content">
    <div class="hero">${plan ? `<span class="pill">${esc(plan.name)}</span>` : ''}
      <h1>${esc(p.name)}さん、おかえりなさい。</h1>
      <div class="muted">現在の目標</div><h2 style="margin:4px 0 0;font-size:24px">${esc(p.goal || '未設定')}</h2>
      ${p.theme ? `<div style="margin-top:12px">今月のテーマ：${esc(p.theme)}</div>` : ''}</div>
    <div class="grid">
      <div class="stat"><div class="label">ベストスコア</div><b>${esc(p.best_score ?? '—')}</b></div>
      <div class="stat"><div class="label">平均スコア</div><b>${esc(p.avg_score ?? '—')}</b></div>
    </div>
    ${!isStandalone() && !local.get('atg-install-dismissed') ? `<div class="install-banner">
        <div><b>ホーム画面に追加しませんか？</b><span>アプリのようにワンタップで開けます</span></div>
        <a class="btn btn-sm btn-gold" href="#/install">やり方</a>
        <button type="button" class="install-close" data-action="dismiss-install" aria-label="閉じる">×</button></div>` : ''}
    <div class="section-title"><div><div class="eyebrow">This Month</div><h2>今月のサポート</h2></div></div>
    <div class="card">
      <div class="support">
        <div><span class="label">動画提出</span><b>${monthSubs.length}${quota ? `<small>/${quota}本</small>` : '<small>本</small>'}</b>
          ${quota ? `<div class="meter"><i style="width:${Math.min(100, (monthSubs.length / quota) * 100)}%"></i></div>` : ''}</div>
        <div><span class="label">解説動画</span><b>${monthLessons.length}<small>本</small></b></div>
        <div><span class="label">次回の面談</span>${p.next_meeting_at ? meetingWhen(p.next_meeting_at) : '<b class="none">未定</b>'}</div>
      </div>
      ${extra ? `<p class="muted small" style="margin:10px 0 0">今月は追加の ${extra} 本を含みます。</p>` : ''}
      ${plan?.monthly ? '<p class="muted small" style="margin:10px 0 0">毎月、動画2本の提出と25分のオンライン面談1回が受けられます。</p>' : ''}
      <div class="meeting-book">
        <p class="muted small">面談のご予約はLINEで承ります。日時が決まると「次回の面談」に表示されます。</p>
        ${lineBtn('LINEで面談を予約する')}
      </div>
    </div>
    <div class="section-title"><div><div class="eyebrow">Practice</div><h2>今月の課題</h2></div><span class="muted">${done}/${tasks.length}</span></div>
    ${tasks.length ? tasks.map((t) => `<button type="button" class="task${t.done ? ' done' : ''}" data-action="toggle-task" data-id="${t.id}" data-done="${t.done}" aria-pressed="${t.done}">
        <span class="check">${t.done ? '✓' : ''}</span><span><b>${esc(t.title)}</b><div class="muted">${esc(t.detail)}</div></span></button>`).join('')
      : '<div class="empty">コーチから課題が届くとここに表示されます</div>'}
    <div class="section-title"><div><div class="eyebrow">Lesson</div><h2>最新のレッスン</h2></div>${latest ? '<a href="#/history">すべて見る</a>' : ''}</div>
    ${latest ? `<a class="lesson-feature" href="#/lesson/${latest.id}">
        <span class="date">${fmtDate(latest.lesson_date)}</span>${newBadge(latest)}
        <h3>${esc(latest.title)}</h3>
        ${latest.point ? `<div class="point"><span>今回のポイント</span><p>${esc(latest.point)}</p></div>` : ''}
        ${practiceProgress(latest)}
        <span class="go">レッスンを見る <i aria-hidden="true">›</i></span></a>`
      : '<div class="empty">まだレッスンはありません。まずは動画を送りましょう。</div>'}
    ${subs.length ? `<div class="notice">確認待ちの動画が ${subs.length} 件あります。コーチからのレッスンをお待ちください。</div>` : ''}
    <a class="btn btn-block btn-gold" href="#/submit">スイング動画を送る</a>
  </div>` + memberNav('home');
}

async function viewSubmit() {
  const p = state.profile;
  const quota = quotaOf(p);
  const extra = extraThisMonth(p);
  const myClubs = p.clubs || [];
  const monthSubs = quota ? await must(sb.from('submissions').select('id').eq('member_id', p.id).gte('created_at', monthStart())) : [];
  const usage = quota ? `<div class="card"><div class="between"><span>今月の提出</span><b>${monthSubs.length} / ${quota} 本</b></div>
      <div class="meter"><i style="width:${Math.min(100, (monthSubs.length / quota) * 100)}%"></i></div>
      ${extra ? `<p class="muted small" style="margin:8px 0 0">追加の ${extra} 本を含みます。</p>` : ''}</div>` : '';
  if (quota && monthSubs.length >= quota) {
    return header('スイング動画を送る') + `<div class="content">${usage}
      <div class="card limit">
        <b>今月の提出本数に達しました</b>
        <p>${extra ? '追加分も含めて、今月送れる本数をすべて使いました。' : `今月の動画（${quota}本）はすべて送信済みです。`}さらに動画を送りたい場合は、追加料金でお送りいただけます。</p>
        <p class="muted small">LINEで「動画を追加したい」とお送りください。お支払いの確認後、コーチが追加の設定をすると、この画面から送れるようになります。</p>
        ${lineBtn('LINEで追加を申し込む')}
      </div>
      <p class="muted small center">来月1日になると、また${planOf(p.plan).monthly.submissions}本送れるようになります。</p>
    </div>` + memberNav('submit');
  }
  return header('スイング動画を送る') + `<div class="content">
    ${usage}
    <div class="notice">正面または後方から、全身とクラブが入るように撮影してください。<a href="#/guide">撮り方ガイドを見る</a><br>送った動画は<b>${RETENTION_LABEL}</b>保存され、その後自動で削除されます。</div>
    <form class="card form" data-form="submit">
      <label for="video">スイング動画</label>
      <input id="video" name="video" type="file" accept="video/*" required class="visually-hidden">
      <label class="file-pick" for="video">
        <span class="file-pick-main">動画を選ぶ・撮影する</span>
        <span class="file-pick-sub" id="video-name">スマホのカメラロールから選べます</span>
      </label>
      <video id="video-preview" class="swing-video hidden" controls playsinline muted></video>
      <div class="grid">
        <div><label for="club">クラブ</label><select id="club" name="club">
          ${(myClubs.length ? [...myClubs, 'その他'] : DEFAULT_CLUB_OPTIONS).map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div><label for="angle">撮影方向</label><select id="angle" name="angle"><option>正面</option><option>後方</option><option>その他</option></select></div>
      </div>
      ${myClubs.length
        ? '<p class="muted small" style="margin:8px 0 0">クラブはMyクラブセッティングから表示しています。<a href="#/account/clubs">変更する</a></p>'
        : '<p class="tip">アカウントの<a href="#/account/clubs">「Myクラブセッティング」</a>を登録すると、お使いのクラブから選べるようになります。</p>'}
      <label for="question">お悩み・質問（文章で）</label>
      <textarea id="question" name="question" rows="5" maxlength="2000" placeholder="例：最近ドライバーが右に出ます。前回の課題はだいぶできるようになりました。"></textarea>
      <div id="upload-progress" class="hidden" aria-live="polite">
        <div class="between small"><span>送信中…</span><span id="upload-percent">0%</span></div>
        <div class="meter"><i id="upload-bar" style="width:0%"></i></div>
        <p class="muted small" style="margin:6px 0 0">送信が終わるまで、この画面を閉じないでください。</p>
      </div>
      <button class="btn-block btn-gold" type="submit">動画を送信する</button>
    </form>
  </div>` + memberNav('submit');
}

// レッスンのカード（動画あり・練習の進み具合・NEW が一目で分かる）
function lessonCard(l) {
  return `<a class="lesson-card${l.read_at ? '' : ' unread'}" href="#/lesson/${l.id}">
    <div class="lc-top"><span class="lc-date">${fmtDate(l.lesson_date)}</span>${newBadge(l)}
      ${l.video_url ? '<span class="lc-tag">▶ 解説動画</span>' : ''}</div>
    <h3>${esc(l.title)}</h3>
    ${l.point ? `<p class="lc-point">${esc(l.point)}</p>` : ''}
    <div class="lc-foot">${practiceProgress(l)}<span class="go">レッスンを見る <i aria-hidden="true">›</i></span></div>
  </a>`;
}
function keepLabel(s) {
  const left = daysLeft(videoExpiry(s.created_at));
  return s.video_deleted_at || left === 0 ? '保存期間終了' : `あと${left}日見られます`;
}
// 送った動画と、その動画へのレッスンをセットにしたカード
function swingPair(s, lessons) {
  return `<div class="pair">
    <a class="pair-sub" href="#/submission/${s.id}">
      <span class="pair-icon" aria-hidden="true">▶</span>
      <span class="grow"><b>送った動画</b>　${fmtDate(s.created_at)}<br>
        <span class="muted small">${esc(s.club)} / ${esc(s.angle)}・${keepLabel(s)}</span></span>
      <span class="pair-go" aria-hidden="true">›</span>
    </a>
    <div class="pair-arrow" aria-hidden="true"></div>
    ${lessons.length ? lessons.map(lessonCard).join('')
      : '<div class="pair-wait"><span class="dot" aria-hidden="true"></span>コーチが確認中です。解説が届くとここに表示されます。</div>'}
  </div>`;
}
const monthLabel = (iso) => `${iso.slice(0, 4)}年${Number(iso.slice(5, 7))}月`;

async function viewHistory() {
  const p = state.profile;
  const [lessons, subs] = await Promise.all([
    must(sb.from('lessons').select('id, submission_id, lesson_date, created_at, title, point, practice, practice_done, read_at, video_url').eq('member_id', p.id).order('lesson_date', { ascending: false }).order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id, created_at, club, angle, status, video_deleted_at').eq('member_id', p.id).order('created_at', { ascending: false }).limit(200)),
  ]);
  // 送った動画ごとにレッスンをまとめ、動画のないレッスン（コーチから直接届いたもの）も並べる
  const bySub = new Map(subs.map((s) => [s.id, []]));
  const loose = [];
  lessons.forEach((l) => (bySub.has(l.submission_id) ? bySub.get(l.submission_id).push(l) : loose.push(l)));
  const items = [
    ...subs.map((s) => ({ date: s.created_at.slice(0, 10), club: s.club, html: swingPair(s, bySub.get(s.id)) })),
    ...loose.map((l) => ({ date: String(l.lesson_date), club: '', html: `<div class="pair">${lessonCard(l)}</div>` })),
  ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));

  const clubs = [...new Set(subs.map((s) => s.club).filter(Boolean))];
  const filter = clubs.includes(state.historyClub) ? state.historyClub : '';
  const shown = filter ? items.filter((it) => it.club === filter) : items;
  let month = '';
  const list = shown.map((it) => {
    const m = monthLabel(it.date);
    const head = m !== month ? `<h3 class="month">${m}</h3>` : '';
    month = m;
    return head + it.html;
  }).join('');

  return header('レッスン履歴') + `<div class="content">
    <p class="muted small" style="margin:0 0 8px">送った動画と、その動画へのコーチの解説をセットで表示しています。動画は送信から${RETENTION_LABEL}見られます。</p>
    ${clubs.length > 1 ? `<div class="filter-chips" role="group" aria-label="クラブで絞り込む">
      ${[['', 'すべて'], ...clubs.map((c) => [c, c])].map(([v, label]) => `<button type="button" data-action="history-filter" data-club="${esc(v)}" class="${filter === v ? 'on' : ''}" aria-pressed="${filter === v}">${esc(label)}</button>`).join('')}
    </div>` : ''}
    ${list || `<div class="empty">${filter ? 'このクラブの動画はまだありません' : 'まだ履歴はありません。まずは動画を送りましょう。'}</div>`}
    ${items.length ? '' : '<a class="btn btn-block btn-gold" href="#/submit">スイング動画を送る</a>'}
  </div>` + memberNav('history');
}

// コーチの文章を読みやすく整形する（空行で段落、「・」などで始まる行は箇条書き、箇条書き直前の短い行は小見出し）
const BULLET = /^[・•●◆■\-*]\s*/;
function richText(text) {
  return text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let html = ''; let para = []; let list = [];
    const flushPara = () => { if (para.length) html += `<p>${para.map(esc).join('<br>')}</p>`; para = []; };
    const flushList = () => { if (list.length) html += `<ul>${list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`; list = []; };
    lines.forEach((line, i) => {
      if (BULLET.test(line)) { flushPara(); list.push(line.replace(BULLET, '')); return; }
      flushList();
      if (line.length <= 20 && !/[。．.!！?？、]$/.test(line) && BULLET.test(lines[i + 1] || '')) {
        flushPara(); html += `<h4>${esc(line)}</h4>`; return;
      }
      para.push(line);
    });
    flushPara(); flushList();
    return html;
  }).join('');
}
// 練習メニューを1行ずつ番号付きで表示。行末の「20球」「10回」などは量として右に出す
const practiceLines = (text) => (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
// 練習のチェック数（例：練習 1/3）
function practiceProgress(l) {
  const total = practiceLines(l.practice).length;
  if (!total) return '';
  const done = (l.practice_done || []).filter((i) => i < total).length;
  return `<div class="practice-progress${done === total ? ' all' : ''}">練習 ${done}/${total}${done === total ? ' ✓ 完了' : ''}</div>`;
}
// lessonId を渡すと、会員が1行ずつチェックできる
function drillList(text, done = [], lessonId = null) {
  return `<ol class="drill">${practiceLines(text).map((line, i) => {
    const body = line.replace(/^(?:[①-⑳]|\d{1,2}[.)．）])\s*/, '');
    const m = body.match(/^(.+?)[\s　]+(\d+\s*(?:球|回|分|秒|本|セット|set))$/i);
    const on = done.includes(i);
    const inner = `<span class="n">${on ? '✓' : i + 1}</span><span class="t">${esc(m ? m[1] : body)}</span>${m ? `<span class="amt">${esc(m[2])}</span>` : ''}`;
    return lessonId
      ? `<li class="${on ? 'done' : ''}"><button type="button" class="drill-btn" data-action="toggle-practice" data-lesson="${esc(lessonId)}" data-index="${i}" aria-pressed="${on}">${inner}</button></li>`
      : `<li>${inner}</li>`;
  }).join('')}</ol>`;
}
const secTitle = (icon, label) => `<h2 class="sec-h"><i aria-hidden="true">${icon}</i>${label}</h2>`;

async function viewLesson(id, back = 'history') {
  const l = await must(sb.from('lessons').select('*, submissions(video_path, video_deleted_at, question)').eq('id', id).maybeSingle());
  if (!l) return header('レッスン詳細', back) + '<div class="content"><div class="empty">レッスンが見つかりません</div></div>';
  const urls = await signedVideoUrls([l.submissions]);
  const mine = l.member_id === state.profile.id;
  if (mine && !l.read_at) {
    const { error } = await sb.rpc('mark_lesson_read', { p_lesson: l.id });
    if (!error) state.unread = Math.max(0, state.unread - 1);
  }
  return header('レッスン詳細', back) + `<div class="content lesson-page">
    <div class="lesson-head">
      <span class="date">${fmtDate(l.lesson_date)}</span>
      <h1>${esc(l.title)}</h1>
      ${l.point ? `<div class="diag"><span>今回の診断</span><p>${esc(l.point)}</p></div>` : ''}
    </div>
    ${l.video_url ? `<section class="card lesson-sec">${secTitle('▶', 'コーチの解説動画')}${videoEmbed(l.video_url)}</section>` : ''}
    ${l.feedback ? `<section class="card lesson-sec">${secTitle('✎', 'コーチからのフィードバック')}<div class="fb">${richText(l.feedback)}</div></section>` : ''}
    ${l.practice ? `<section class="card lesson-sec practice">${secTitle('✓', '次回までの練習')}
        ${mine ? '<p class="muted small" style="margin:-4px 0 4px">練習したらタップしてチェックしましょう。</p>' : ''}
        ${drillList(l.practice, l.practice_done || [], mine ? l.id : null)}</section>` : ''}
    ${l.submissions ? `<section class="card lesson-sec">${secTitle('◎', '送った動画')}${swingVideo(l.submissions, urls)}
        ${mine ? `<a class="muted small" href="#/submission/${l.submission_id}">送った動画の詳細（保存期限など）›</a>` : ''}
        ${l.submissions.question ? `<div class="my-q"><span>送ったときのお悩み・質問</span><p class="pre">${esc(l.submissions.question)}</p></div>` : ''}</section>` : ''}
  </div>` + (state.profile.role === 'admin' ? '' : memberNav('history'));
}

async function viewSubmission(id) {
  const sub = await must(sb.from('submissions').select('*').eq('id', id).maybeSingle());
  if (!sub) return header('送った動画', 'history') + '<div class="content"><div class="empty">動画が見つかりません</div></div>' + memberNav('history');
  const [lessons, urls] = await Promise.all([
    must(sb.from('lessons').select('id, title, lesson_date, point, practice, practice_done, read_at, video_url').eq('submission_id', sub.id).order('lesson_date', { ascending: false })),
    signedVideoUrls([sub]),
  ]);
  const expiry = videoExpiry(sub.created_at);
  const deleted = sub.video_deleted_at || daysLeft(expiry) === 0;
  return header('送った動画', 'history') + `<div class="content">
    <div class="between"><div><div class="muted">送信日</div><b style="font-size:18px">${fmtDate(sub.created_at)}</b></div>
      ${sub.status === 'pending' ? '<span class="pill warn">確認待ち</span>' : '<span class="pill ok">解説済み</span>'}</div>
    <div class="card">
      ${deleted ? `<p class="muted">保存期間（${RETENTION_LABEL}）を過ぎたため、動画は削除されました。</p>` : swingVideo(sub, urls)}
      <div class="list-item"><span class="muted">クラブ・撮影方向</span><span>${esc(sub.club)} / ${esc(sub.angle)}</span></div>
      <div class="list-item"><span class="muted">保存期限</span><span>${deleted ? '終了' : `${fmtDate(expiry.toISOString())}（あと${daysLeft(expiry)}日）`}</span></div>
    </div>
    ${sub.question ? `<div class="card"><b>送ったお悩み・質問</b><p class="pre" style="margin:6px 0 0">${esc(sub.question)}</p></div>` : ''}
    <div class="section-title"><div><div class="eyebrow">Coach</div><h2>この動画への解説</h2></div></div>
    ${lessons.length ? lessons.map(lessonCard).join('')
      : '<div class="pair-wait"><span class="dot" aria-hidden="true"></span>コーチが確認中です。解説が届くと、ここと「履歴」に表示され、メールでもお知らせします。</div>'}
  </div>` + memberNav('history');
}

function viewAccount() {
  const p = state.profile;
  const admin = p.role === 'admin';
  const navHtml = admin ? adminNav('account') : isActive(p) ? memberNav('account') : nav([['plans', 'card', 'プラン'], ['account', 'user', 'アカウント']], 'account');
  return header('アカウント') + `<div class="content">
    <form class="card form" data-form="profile-name">
      <label for="name">お名前</label><input id="name" name="name" value="${esc(p.name)}" maxlength="50" required>
      <label>メールアドレス</label><div>${esc(p.email || state.session.user.email)}</div>
      <button class="btn-block btn-sub" type="submit">名前を保存</button>
    </form>
    ${admin ? '' : (() => {
      const mine = p.clubs || [];
      const custom = mine.filter((c) => !CLUB_PRESETS.includes(c));
      return `<form class="card form" data-form="clubs" id="clubs">
        <div class="between"><b>Myクラブセッティング</b><span class="muted small">${mine.length ? `${mine.length}本登録中` : '未登録'}</span></div>
        <p class="muted small" style="margin:6px 0 0">お使いのクラブを選んで保存すると、動画を送るときにこのクラブから選べるようになります。</p>
        <div class="club-grid" id="club-grid">${CLUB_PRESETS.map((c) => clubChip(c, mine.includes(c))).join('')}${custom.map((c) => clubChip(c, true)).join('')}</div>
        <label for="club-custom">リストにないクラブを追加</label>
        <div class="row"><input id="club-custom" class="grow" maxlength="20" placeholder="例：ユーティリティ 22°、52° ウェッジ">
          <button type="button" class="btn-sub" data-action="add-club" style="flex:none">追加</button></div>
        <button class="btn-block btn-gold" type="submit">Myクラブセッティングを保存</button>
      </form>`;
    })()}
    ${admin ? '<div class="card"><span class="pill">ADMIN</span> 管理者アカウントです</div>' : `<div class="card">
      <div class="between"><b>ご契約</b>${memberPill(p)}</div>
      <div class="list-item"><span>プラン</span><b>${esc(planLabel(p.plan) || '—')}</b></div>
      ${p.current_period_end ? `<div class="list-item"><span>${p.subscription_status === 'canceled' ? '利用期限' : '次回更新日'}</span><b>${fmtDate(p.current_period_end)}</b></div>` : ''}
      ${p.access_until ? `<div class="list-item"><span>利用期限</span><b>${fmtDate(p.access_until)}</b></div>` : ''}
      ${p.stripe_customer_id ? '<button class="btn-block" data-action="portal">契約・お支払い（プラン変更・解約）</button>'
        : isActive(p) ? `<p class="muted small" style="margin:10px 0 0">ご契約内容の変更は、LINE またはお電話（${esc(CONTACT.telDisplay)}）でお問い合わせください。</p>`
        : '<a class="btn btn-block" href="#/plans">プランを選ぶ</a>'}
    </div>`}
    ${admin ? '' : `<form class="card form" data-form="notify">
      <b>お知らせメール</b>
      <label class="switch"><input type="checkbox" name="email_notify"${p.email_notify !== false ? ' checked' : ''}>
        <span>レッスンが届いたとき・面談の前日にメールで知らせる</span></label>
      <button class="btn-block btn-sub" type="submit">保存</button>
    </form>`}
    <div class="card">
      <b>文字の大きさ</b> <span class="muted small">（この端末だけに反映）</span>
      <div class="seg" role="group" aria-label="文字の大きさ">${FONT_SIZES.map(([k, label]) => `<button type="button" data-action="font-size" data-size="${k}" aria-pressed="${document.documentElement.dataset.fs === k}" class="${document.documentElement.dataset.fs === k ? 'on' : ''}">${label}</button>`).join('')}</div>
    </div>
    ${admin ? '' : `<div class="card links">
      <a class="list-item" href="#/guide"><span>使い方ガイド（動画の撮り方・送り方）</span><span aria-hidden="true">›</span></a>
      <a class="list-item" href="#/install"><span>ホーム画面に追加する方法</span><span aria-hidden="true">›</span></a>
    </div>`}
    <form class="card form" data-form="change-password">
      <b>パスワード変更</b>
      <label for="password">新しいパスワード（8文字以上）</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
      <button class="btn-block btn-sub" type="submit">パスワードを変更</button>
    </form>
    <button class="btn-block btn-danger" data-action="logout">ログアウト</button>
  </div>` + navHtml;
}

// 使い方ガイド（初回ログイン時に自動で表示。アカウント画面からいつでも見られる）
function viewGuide() {
  const first = !state.profile.onboarded_at;
  const sf = GUIDE.swingFrame;
  const apps = [sf.ios && `<a class="btn btn-sm btn-sub" href="${esc(sf.ios)}" target="_blank" rel="noopener">App Store</a>`,
    sf.android && `<a class="btn btn-sm btn-sub" href="${esc(sf.android)}" target="_blank" rel="noopener">Google Play</a>`].filter(Boolean).join(' ');
  return header('使い方ガイド', first ? '' : 'account') + `<div class="content guide">
    ${first ? `<div class="hero"><div class="eyebrow">Welcome</div><h1>${esc(state.profile.name || '')}さん、ようこそ。</h1>
      <p style="margin:0">レッスンの受け方を3つのステップでご紹介します。</p></div>` : ''}
    <section class="card guide-step">
      <div class="step-no"><span>STEP</span>1</div>
      <h2>動画を撮る <small>SwingFrame を使います</small></h2>
      <ol>
        <li>スマホで <b>SwingFrame</b> アプリを開いて撮影します${apps ? '' : '（お持ちでない場合は、アプリストアで「SwingFrame」と検索してください）'}</li>
        <li>撮影した動画を、スマホに保存します</li>
      </ol>
      ${apps ? `<div class="row" style="gap:8px;margin:4px 0 10px">${apps}</div>` : ''}
      <div class="tip-box"><b>きれいに撮るコツ</b>
        <ul>
          <li><b>正面</b>（体の正面）または<b>後方</b>（打つ方向の後ろ）から撮る</li>
          <li>頭から足先まで、クラブ全体が画面に入るようにする</li>
          <li>スマホは腰くらいの高さで固定する（三脚などがあると安定します）</li>
        </ul></div>
    </section>
    <section class="card guide-step">
      <div class="step-no"><span>STEP</span>2</div>
      <h2>動画を送る</h2>
      <ol>
        <li>下のメニューの「<b>動画提出</b>」を開く</li>
        <li>「<b>動画を選ぶ・撮影する</b>」から、SwingFrame で保存した動画を選ぶ</li>
        <li>クラブ・撮影方向・お悩みを入力して「<b>動画を送信する</b>」</li>
      </ol>
      <p class="muted small" style="margin:0">サブスクリプション制は毎月2本まで送れます。送った動画は3か月間、履歴から見返せます。</p>
    </section>
    <section class="card guide-step">
      <div class="step-no"><span>STEP</span>3</div>
      <h2>レッスンを見て練習する</h2>
      <ol>
        <li>コーチからレッスンが届くと、<b>メールでお知らせ</b>が届き、「履歴」に <span class="new-badge">NEW</span> が付きます</li>
        <li>解説動画とフィードバックを確認します</li>
        <li>「次回までの練習」は、練習したらタップして<b>チェック</b>しましょう</li>
      </ol>
      <p class="muted small" style="margin:0">月1回のオンライン面談は、マイページの「LINEで面談を予約する」から予約できます。</p>
    </section>
    <button class="btn-block btn-gold" data-action="finish-guide">${first ? 'はじめる' : 'マイページへ'}</button>
  </div>` + (first ? '' : memberNav('account'));
}

// ホーム画面に追加する方法
function viewInstall() {
  const done = isStandalone();
  return header('ホーム画面に追加', 'account') + `<div class="content">
    <div class="card"><p style="margin:0">ホーム画面に追加すると、アプリのようにアイコンをタップするだけで会員ページが開けます。</p></div>
    ${done ? '<div class="notice">すでにホーム画面から開いています。</div>' : ''}
    ${installPrompt ? '<button class="btn-block btn-gold" data-action="install-app">ホーム画面に追加する</button>' : ''}
    <section class="card guide-step${isIOS() ? ' current' : ''}">
      <h2>iPhone（Safari）の場合</h2>
      <ol>
        <li>Safari でこのページを開く</li>
        <li>画面下の <b>共有ボタン</b>（四角から矢印が出ているマーク）をタップ</li>
        <li>「<b>ホーム画面に追加</b>」をタップ →「<b>追加</b>」</li>
      </ol>
    </section>
    <section class="card guide-step${!isIOS() ? ' current' : ''}">
      <h2>Android（Chrome）の場合</h2>
      <ol>
        <li>Chrome でこのページを開く</li>
        <li>右上の <b>︙</b>（メニュー）をタップ</li>
        <li>「<b>ホーム画面に追加</b>」または「<b>アプリをインストール</b>」をタップ</li>
      </ol>
    </section>
  </div>` + memberNav('account');
}

// ---------- 画面：管理者 ----------

async function viewInbox() {
  const subs = await must(sb.from('submissions').select('*, profiles(name, plan)').eq('status', 'pending').order('created_at'));
  const urls = await signedVideoUrls(subs);
  return header('提出動画（確認待ち）') + `<div class="content">
    ${subs.length ? subs.map((s) => `<div class="card">
        <div class="between"><div><b>${esc(s.profiles?.name || '（名前未設定）')}</b> <span class="pill">${esc(planLabel(s.profiles?.plan))}</span></div>
          <span class="muted">${fmtDate(s.created_at)}</span></div>
        <div class="muted">${esc(s.club)} / ${esc(s.angle)}</div>
        ${swingVideo(s, urls)}
        ${s.question ? `<p class="pre">${esc(s.question)}</p>` : ''}
        <div class="row" style="margin-top:10px">
          <a class="btn grow" href="#/admin/lesson/new/s/${s.id}">レッスンを書く</a>
          <button class="btn-sub" data-action="mark-reviewed" data-id="${s.id}">対応済みにする</button>
        </div>
        <a class="muted small" href="#/admin/member/${s.member_id}">会員ページを見る</a>
      </div>`).join('') : '<div class="empty">確認待ちの動画はありません 🎉</div>'}
  </div>` + adminNav('admin/inbox');
}

async function viewMembers() {
  const members = await must(sb.from('profiles').select('id, name, email, plan, role, subscription_status, access_until').order('created_at', { ascending: false }));
  return header('会員一覧') + `<div class="content">
    <div class="form"><input type="search" id="member-search" placeholder="名前・メールで検索" data-action="filter-members"></div>
    <p class="muted">${members.filter((m) => isActive(m)).length} 名が契約中 / 全 ${members.length} 名</p>
    <div id="member-list">${members.map((m) => `<a class="card link" href="#/admin/member/${m.id}" data-search="${esc(`${m.name} ${m.email}`.toLowerCase())}">
        <div class="between"><div><b>${esc(m.name || '（名前未設定）')}</b>${m.role === 'admin' ? ' <span class="pill">ADMIN</span>' : ''}
          <div class="muted">${esc(m.email)}</div></div>
          <div style="text-align:right">${m.role === 'admin' ? '' : memberPill(m)}<div class="muted">${esc(planLabel(m.plan))}</div></div></div>
      </a>`).join('')}</div>
  </div>` + adminNav('admin/members');
}

async function viewMemberDetail(id) {
  const [m, tasks, lessons, subs, monthSubs] = await Promise.all([
    must(sb.from('profiles').select('*').eq('id', id).maybeSingle()),
    must(sb.from('tasks').select('*').eq('member_id', id).order('sort_order').order('created_at')),
    must(sb.from('lessons').select('id, lesson_date, title').eq('member_id', id).order('lesson_date', { ascending: false }).order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id, created_at, club, angle, status').eq('member_id', id).order('created_at', { ascending: false }).limit(20)),
    must(sb.from('submissions').select('id').eq('member_id', id).gte('created_at', monthStart())),
  ]);
  if (!m) return header('会員詳細', 'admin/members') + '<div class="content"><div class="empty">会員が見つかりません</div></div>';
  const self = m.id === state.profile.id;
  return header(m.name || '会員詳細', 'admin/members') + `<div class="content">
    <div class="card"><div class="between"><div><b>${esc(m.email)}</b><div class="muted">登録日 ${fmtDate(m.created_at)}</div></div>${memberPill(m)}</div>
      ${m.current_period_end ? `<div class="muted">次回更新日 ${fmtDate(m.current_period_end)}</div>` : ''}</div>

    <form class="card form" data-form="admin-profile" data-id="${m.id}">
      <b>会員情報</b>
      <label for="name">会員名</label><input id="name" name="name" value="${esc(m.name)}" maxlength="50">
      <label for="plan">プラン <span class="muted">（通常は Stripe から自動で反映）</span></label>
      <select id="plan" name="plan"><option value="">—</option>${PLANS.map((pl) => `<option value="${esc(pl.id)}" ${m.plan === pl.id ? 'selected' : ''}>${esc(pl.name)}</option>`).join('')}</select>
      <label for="goal">目標</label><input id="goal" name="goal" value="${esc(m.goal)}" maxlength="50">
      <div class="grid">
        <div><label for="best_score">Best Score</label><input id="best_score" name="best_score" type="number" min="40" max="200" value="${esc(m.best_score ?? '')}"></div>
        <div><label for="avg_score">平均スコア</label><input id="avg_score" name="avg_score" type="number" min="40" max="200" value="${esc(m.avg_score ?? '')}"></div>
      </div>
      <label for="theme">今月のテーマ</label><input id="theme" name="theme" value="${esc(m.theme)}" maxlength="100">
      <label for="access_until">利用期限 <span class="muted">（LINE・電話で申し込んだ会員用。カード決済の会員は空欄）</span></label>
      <input id="access_until" name="access_until" type="date" value="${esc(m.access_until || '')}">
      <label for="next_meeting_at">次回の面談日時</label><input id="next_meeting_at" name="next_meeting_at" type="datetime-local" value="${esc(toLocalInput(m.next_meeting_at))}">
      <label for="extra_submissions">今月の追加本数 <span class="muted">（LINEで追加の申し込み・お支払いがあった分。来月は自動で0本に戻ります）</span></label>
      <input id="extra_submissions" name="extra_submissions" type="number" min="0" max="20" value="${extraThisMonth(m)}">
      <p class="muted small" style="margin:4px 0 0">今月の提出：${monthSubs.length}本${quotaOf(m) ? ` ／ 送れる本数：${quotaOf(m)}本` : ''}</p>
      ${self ? '' : `<label for="role">権限</label><select id="role" name="role">
        <option value="member" ${m.role === 'member' ? 'selected' : ''}>会員</option>
        <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者（コーチ）</option></select>`}
      <button class="btn-block" type="submit">保存する</button>
    </form>

    <div class="section-title"><h2>今月の課題</h2>${tasks.length ? '<button class="btn-sm btn-sub" data-action="reset-tasks" data-id="' + m.id + '">完了をリセット</button>' : ''}</div>
    <div class="card">
      ${tasks.map((t) => `<div class="list-item"><div class="grow">${t.done ? '✅' : '⬜️'} <b>${esc(t.title)}</b> <span class="muted">${esc(t.detail)}</span></div>
          <button class="btn-sm btn-danger" data-action="delete-task" data-id="${t.id}">削除</button></div>`).join('') || '<div class="muted">課題はまだありません</div>'}
      <form class="form" data-form="add-task" data-id="${m.id}" data-count="${tasks.length}">
        <div class="row" style="align-items:flex-end">
          <div class="grow"><label for="task-title">練習内容</label><input id="task-title" name="title" maxlength="100" placeholder="例：ドライバー ハーフスイング" required></div>
          <div style="width:90px"><label for="task-detail">量</label><input id="task-detail" name="detail" maxlength="200" placeholder="20球"></div>
        </div>
        <button class="btn-block btn-sub" type="submit">＋ 課題を追加</button>
      </form>
    </div>

    <div class="section-title"><h2>レッスン</h2><a class="btn btn-sm" href="#/admin/lesson/new/m/${m.id}">＋ 追加</a></div>
    <div class="card">${lessons.map((l) => `<div class="list-item"><div>${fmtDate(l.lesson_date)}　<b>${esc(l.title)}</b></div>
        <a class="btn btn-sm btn-sub" href="#/admin/lesson/${l.id}">編集</a></div>`).join('') || '<div class="muted">レッスンはまだありません</div>'}</div>

    <div class="section-title"><h2>提出動画</h2></div>
    <div class="card">${subs.map((s) => `<div class="list-item"><div>${fmtDate(s.created_at)}　${esc(s.club)} / ${esc(s.angle)}</div>
        ${s.status === 'pending' ? `<a class="btn btn-sm" href="#/admin/lesson/new/s/${s.id}">レッスンを書く</a>` : '<span class="pill ok">対応済み</span>'}</div>`).join('') || '<div class="muted">提出はまだありません</div>'}</div>
  </div>` + adminNav('admin/members');
}

// 新規（提出動画から / 会員から）または既存レッスンの編集
async function viewLessonForm(route) {
  let lesson = { lesson_date: today(), title: '', point: '', feedback: '', practice: '', video_url: '' };
  let memberId; let submission = null;
  if (route[2] === 'new' && route[3] === 's') {
    submission = await must(sb.from('submissions').select('*, profiles(name)').eq('id', route[4]).maybeSingle());
    if (!submission) return header('レッスン作成', 'admin/inbox') + '<div class="content"><div class="empty">提出が見つかりません</div></div>';
    memberId = submission.member_id;
  } else if (route[2] === 'new' && route[3] === 'm') {
    memberId = route[4];
  } else {
    lesson = await must(sb.from('lessons').select('*, submissions(*)').eq('id', route[2]).maybeSingle());
    if (!lesson) return header('レッスン編集', 'admin/members') + '<div class="content"><div class="empty">レッスンが見つかりません</div></div>';
    memberId = lesson.member_id;
    submission = lesson.submissions;
  }
  const member = await must(sb.from('profiles').select('id, name').eq('id', memberId).maybeSingle());
  const urls = await signedVideoUrls([submission]);
  const back = `admin/member/${memberId}`;
  return header(lesson.id ? 'レッスン編集' : 'レッスン作成', back) + `<div class="content">
    <div class="muted">会員：<b>${esc(member?.name || '')}</b></div>
    ${submission ? `<div class="card"><b>提出動画</b>（${esc(submission.club)} / ${esc(submission.angle)}）${swingVideo(submission, urls)}
        ${submission.question ? `<p class="pre">${esc(submission.question)}</p>` : ''}</div>` : ''}
    <form class="card form" data-form="lesson" data-id="${esc(lesson.id || '')}" data-member="${esc(memberId)}" data-submission="${esc(submission?.id || '')}">
      <label for="lesson_date">日付</label><input id="lesson_date" name="lesson_date" type="date" value="${esc(lesson.lesson_date)}" required>
      <label for="title">タイトル</label><input id="title" name="title" value="${esc(lesson.title)}" maxlength="100" placeholder="例：ドライバーの右プッシュ" required>
      <label for="point">今回の診断（ポイント）</label><input id="point" name="point" value="${esc(lesson.point)}" maxlength="300" placeholder="例：切り返しで上体が先行している">
      <label for="feedback">フィードバック</label><textarea id="feedback" name="feedback" rows="7" maxlength="5000">${esc(lesson.feedback)}</textarea>
      <p class="muted small" style="margin:4px 0 0">空行で段落が分かれます。行の先頭に「・」を付けると箇条書きになり、その直前の短い行（例：ポイント）は見出しになります。</p>
      <label for="practice">次回までの練習</label><textarea id="practice" name="practice" rows="4" maxlength="2000" placeholder="① ハーフスイング 20球&#10;② 7I 30球">${esc(lesson.practice)}</textarea>
      <label for="video_url">コーチの解説動画（YouTube・任意）</label><input id="video_url" name="video_url" type="url" value="${esc(lesson.video_url || '')}" placeholder="https://youtu.be/...">
      ${lesson.id ? '' : '<label class="switch"><input type="checkbox" name="notify" checked><span>会員にメールでお知らせする</span></label>'}
      <button class="btn-block" type="submit">${lesson.id ? '更新する' : '保存して会員に公開する'}</button>
    </form>
    ${lesson.id ? `<button class="btn-block btn-danger" data-action="delete-lesson" data-id="${lesson.id}" data-member="${esc(memberId)}">このレッスンを削除</button>` : ''}
  </div>` + adminNav('admin/inbox');
}

// ---------- ルーティング ----------

async function render() {
  const seq = ++renderSeq;
  const paint = (html) => {
    if (seq !== renderSeq) return;
    document.body.classList.toggle('on-auth', html.startsWith('<div class="auth-page">'));
    $app.innerHTML = html; window.scrollTo(0, 0);
  };
  try {
    if (!configured) return paint(viewAuth());
    if (state.recovery) return paint(viewRecovery());
    if (!state.session) return paint(viewAuth());
    if (!state.profile) await loadProfile();

    const p = state.profile;
    const r = getRoute();
    if (r[0] === 'account') {
      paint(viewAccount());
      if (r[1] === 'clubs') document.getElementById('clubs')?.scrollIntoView({ block: 'start' });
      return;
    }

    if (p.role === 'admin') {
      if (r[0] !== 'admin') return go('admin/inbox');
      if (r[1] === 'members') return paint(await viewMembers());
      if (r[1] === 'member' && r[2]) return paint(await viewMemberDetail(r[2]));
      if (r[1] === 'lesson' && r[2]) return paint(await viewLessonForm(r));
      return paint(await viewInbox());
    }

    if (!isActive(p)) {
      if (r[0] !== 'plans') return go('plans');
      return paint(viewPlans());
    }
    if (r[0] === 'guide') return paint(viewGuide());
    if (r[0] === 'install') return paint(viewInstall());
    if (!p.onboarded_at) return go('guide');
    state.unread = (await sb.from('lessons').select('id', { count: 'exact', head: true }).eq('member_id', p.id).is('read_at', null)).count || 0;
    if (r[0] === 'submit') return paint(await viewSubmit());
    if (r[0] === 'history') return paint(await viewHistory());
    if (r[0] === 'lesson' && r[1]) return paint(await viewLesson(r[1]));
    if (r[0] === 'submission' && r[1]) return paint(await viewSubmission(r[1]));
    if (r[0] !== 'home') return go('home');
    return paint(await viewMemberHome());
  } catch (e) {
    console.error(e);
    paint(`<div class="content"><div class="error">読み込みに失敗しました：${esc(e.message)}</div>
      <button data-action="reload">再読み込み</button> <button class="btn-sub" data-action="logout">ログアウト</button></div>`);
  }
}

// ---------- 操作 ----------

const actions = {
  'auth-tab': (el) => { state.authTab = el.dataset.tab; state.authMessage = ''; render(); },
  'history-filter': (el) => { state.historyClub = el.dataset.club; render(); },
  'toggle-practice': async (el) => {
    const on = el.getAttribute('aria-pressed') !== 'true';
    el.disabled = true;
    try {
      await must(sb.rpc('set_practice_done', { p_lesson: el.dataset.lesson, p_index: Number(el.dataset.index), p_done: on }));
      el.setAttribute('aria-pressed', String(on));
      el.parentElement.classList.toggle('done', on);
      el.querySelector('.n').textContent = on ? '✓' : Number(el.dataset.index) + 1;
      const list = el.closest('.drill');
      if (on && list.querySelectorAll('li.done').length === list.children.length) toast('すべての練習が完了しました！ナイスです⛳');
    } catch (e) { toast('更新できませんでした', true); }
    el.disabled = false;
  },
  'font-size': (el) => {
    local.set('atg-font-size', el.dataset.size);
    applyFontSize(el.dataset.size);
    document.querySelectorAll('[data-action="font-size"]').forEach((b) => {
      const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
  },
  'dismiss-install': (el) => {
    local.set('atg-install-dismissed', '1');
    el.closest('.install-banner').remove();
  },
  'install-app': async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') { local.set('atg-install-dismissed', '1'); toast('ホーム画面に追加しました'); }
    render();
  },
  'finish-guide': async () => {
    if (!state.profile.onboarded_at) {
      await must(sb.from('profiles').update({ onboarded_at: new Date().toISOString() }).eq('id', state.profile.id));
      await loadProfile();
    }
    go('home');
  },
  'add-club': () => {
    const input = document.getElementById('club-custom');
    const name = input.value.trim().slice(0, 20);
    if (!name) { input.focus(); return; }
    const grid = document.getElementById('club-grid');
    const exists = [...grid.querySelectorAll('input[name="club"]')].find((i) => i.value === name);
    if (exists) { exists.checked = true; } else { grid.insertAdjacentHTML('beforeend', clubChip(name, true)); }
    input.value = '';
    toast(`「${name}」を追加しました。保存すると反映されます`);
  },
  'toggle-password': (el) => {
    const input = el.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? '隠す' : '表示';
    el.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
  },
  reload: () => location.reload(),
  logout: async () => { await sb.auth.signOut(); location.hash = ''; },
  checkout: async (el) => {
    el.disabled = true; el.textContent = '決済ページへ移動中…';
    try {
      const { url } = await callFunction('create-checkout-session', { plan: el.dataset.plan });
      location.href = url;
    } catch (e) { toast(e.message, true); el.disabled = false; el.textContent = 'このプランで申し込む'; }
  },
  portal: async (el) => {
    el.disabled = true;
    try {
      const { url } = await callFunction('create-portal-session', {});
      location.href = url;
    } catch (e) { toast(e.message, true); el.disabled = false; }
  },
  'toggle-task': async (el) => {
    const done = el.dataset.done !== 'true';
    el.disabled = true;
    try {
      await must(sb.from('tasks').update({ done }).eq('id', el.dataset.id));
      render();
    } catch (e) { toast('更新できませんでした', true); el.disabled = false; }
  },
  'mark-reviewed': async (el) => {
    if (!confirm('レッスンを作らずに対応済みにしますか？')) return;
    await must(sb.from('submissions').update({ status: 'reviewed' }).eq('id', el.dataset.id));
    toast('対応済みにしました'); render();
  },
  'delete-task': async (el) => {
    await must(sb.from('tasks').delete().eq('id', el.dataset.id));
    render();
  },
  'reset-tasks': async (el) => {
    await must(sb.from('tasks').update({ done: false }).eq('member_id', el.dataset.id));
    toast('完了をリセットしました'); render();
  },
  'delete-lesson': async (el) => {
    if (!confirm('このレッスンを削除します。よろしいですか？')) return;
    await must(sb.from('lessons').delete().eq('id', el.dataset.id));
    toast('削除しました'); go(`admin/member/${el.dataset.member}`);
  },
};

const forms = {
  login: async (f) => {
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) throw new Error('メールアドレスまたはパスワードが正しくありません');
  },
  signup: async (f) => {
    const { data, error } = await sb.auth.signUp({
      email: f.email.value.trim(),
      password: f.password.value,
      options: { data: { name: f.name.value.trim() }, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    if (!data.session) {
      state.authTab = 'login';
      state.authMessage = '確認メールを送りました。メール内のリンクを開いて登録を完了してください。';
      render();
    }
  },
  reset: async (f) => {
    const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: location.origin + location.pathname });
    if (error) throw error;
    state.authMessage = '再設定メールを送りました。メール内のリンクを開いてください。';
    render();
  },
  'new-password': async (f) => {
    const { error } = await sb.auth.updateUser({ password: f.password.value });
    if (error) throw error;
    state.recovery = false;
    toast('パスワードを変更しました');
    render();
  },
  'change-password': async (f) => {
    const ok = await confirmDialog({
      title: 'パスワードを変更しますか？',
      body: '<p>変更すると、次回のログインから新しいパスワードが必要になります。</p><p class="muted small">新しいパスワードは忘れないよう控えておいてください。</p>',
    });
    if (!ok) return;
    const { error } = await sb.auth.updateUser({ password: f.password.value });
    if (error) throw error;
    f.reset(); toast('パスワードを変更しました');
  },
  clubs: async (f) => {
    const picked = [...f.querySelectorAll('input[name="club"]:checked')].map((i) => i.value.trim()).filter(Boolean);
    const clubs = [...new Set(picked)];
    clubs.sort((a, b) => {
      const ia = CLUB_PRESETS.indexOf(a); const ib = CLUB_PRESETS.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    if (clubs.length > 30) throw new Error('登録できるクラブは30本までです');
    await must(sb.from('profiles').update({ clubs }).eq('id', state.profile.id));
    await loadProfile();
    toast(clubs.length ? `Myクラブセッティングを保存しました（${clubs.length}本）` : 'Myクラブセッティングを解除しました');
    render();
  },
  notify: async (f) => {
    await must(sb.from('profiles').update({ email_notify: f.email_notify.checked }).eq('id', state.profile.id));
    await loadProfile();
    toast(f.email_notify.checked ? 'お知らせメールを受け取る設定にしました' : 'お知らせメールを停止しました');
  },
  'profile-name': async (f) => {
    const name = f.name.value.trim();
    if (!name) throw new Error('お名前を入力してください');
    if (name === state.profile.name) { toast('お名前は変更されていません'); return; }
    const ok = await confirmDialog({
      title: 'お名前を変更しますか？',
      body: `<dl class="modal-diff"><dt>変更前</dt><dd>${esc(state.profile.name || '（未設定）')}</dd><dt>変更後</dt><dd><b>${esc(name)}</b></dd></dl>`,
    });
    if (!ok) return;
    await must(sb.from('profiles').update({ name }).eq('id', state.profile.id));
    await loadProfile(); toast('お名前を変更しました');
  },
  submit: async (f) => {
    const file = f.video.files[0];
    if (!file) throw new Error('送る動画を選んでください');
    if (file.type && !file.type.startsWith('video/')) throw new Error('動画ファイルを選んでください');
    if (!(await must(sb.rpc('can_submit_video')))) {
      render();
      throw new Error('今月の提出本数に達しています。追加はLINEでお申し込みください。');
    }
    const path = `${state.profile.id}/${videoFileName(file)}`;
    const box = document.getElementById('upload-progress');
    const bar = document.getElementById('upload-bar');
    const pct = document.getElementById('upload-percent');
    box.classList.remove('hidden');
    const leaveGuard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', leaveGuard);
    try {
      await uploadVideo(file, path, (r) => {
        const v = Math.round(r * 100);
        bar.style.width = `${v}%`; pct.textContent = `${v}%`;
      });
      await must(sb.from('submissions').insert({
        member_id: state.profile.id, video_path: path,
        club: f.club.value, angle: f.angle.value, question: f.question.value.trim(),
      }));
    } finally {
      window.removeEventListener('beforeunload', leaveGuard);
    }
    toast('動画を送信しました。コーチからの解説をお待ちください。');
    go('home');
  },
  'admin-profile': async (f) => {
    const num = (v) => (v === '' ? null : Number(v));
    const update = {
      name: f.name.value.trim(), plan: f.plan.value || null, goal: f.goal.value.trim(),
      best_score: num(f.best_score.value), avg_score: num(f.avg_score.value), theme: f.theme.value.trim(),
      next_meeting_at: f.next_meeting_at.value ? new Date(f.next_meeting_at.value).toISOString() : null,
      access_until: f.access_until.value || null,
      extra_submissions: Number(f.extra_submissions.value) || 0,
      extra_submissions_month: monthKey(),
    };
    if (f.role) update.role = f.role.value;
    await must(sb.from('profiles').update(update).eq('id', f.dataset.id));
    toast('保存しました'); render();
  },
  'add-task': async (f) => {
    await must(sb.from('tasks').insert({
      member_id: f.dataset.id, title: f.title.value.trim(), detail: f.detail.value.trim(), sort_order: Number(f.dataset.count),
    }));
    render();
  },
  lesson: async (f) => {
    let videoUrl = null;
    if (f.video_url.value.trim()) {
      videoUrl = normalizeYoutube(f.video_url.value);
      if (!videoUrl) throw new Error('解説動画は YouTube のリンクを入力してください');
    }
    const row = {
      lesson_date: f.lesson_date.value, title: f.title.value.trim(), point: f.point.value.trim(),
      feedback: f.feedback.value.trim(), practice: f.practice.value.trim(), video_url: videoUrl,
    };
    let notice = 'レッスンを保存しました';
    if (f.dataset.id) {
      await must(sb.from('lessons').update(row).eq('id', f.dataset.id));
    } else {
      const created = await must(sb.from('lessons').insert({ ...row, member_id: f.dataset.member, submission_id: f.dataset.submission || null }).select('id').single());
      if (f.dataset.submission) await must(sb.from('submissions').update({ status: 'reviewed' }).eq('id', f.dataset.submission));
      if (f.notify?.checked) {
        try {
          const r = await callFunction('notify-lesson', { lesson_id: created.id });
          notice = r?.sent ? 'レッスンを保存し、会員にメールでお知らせしました' : 'レッスンを保存しました（この会員はお知らせメールを停止しています）';
        } catch {
          notice = 'レッスンを保存しました（お知らせメールは送れませんでした）';
        }
      }
    }
    toast(notice);
    go(f.dataset.submission && !f.dataset.id ? 'admin/inbox' : `admin/member/${f.dataset.member}`);
  },
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action] || el.tagName === 'INPUT') return;
  ev.preventDefault();
  try { await actions[el.dataset.action](el); } catch (e) { console.error(e); toast(e.message || 'エラーが発生しました', true); }
});

document.addEventListener('input', (ev) => {
  if (ev.target.dataset.action !== 'filter-members') return;
  const q = ev.target.value.trim().toLowerCase();
  document.querySelectorAll('#member-list [data-search]').forEach((a) => a.classList.toggle('hidden', q && !a.dataset.search.includes(q)));
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  ev.preventDefault();
  if (!sb) { toast('会員ログインは現在準備中です', true); return; }
  const btn = f.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f); } catch (e) { console.error(e); toast(e.message || 'エラーが発生しました', true); }
  if (btn && btn.isConnected) btn.disabled = false;
});

// 動画を選んだら、ファイル名と容量を表示してプレビューする
let previewUrl = null;
document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'video') return;
  const file = ev.target.files[0];
  const name = document.getElementById('video-name');
  const preview = document.getElementById('video-preview');
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  if (!file) { name.textContent = 'スマホのカメラロールから選べます'; preview.classList.add('hidden'); return; }
  name.textContent = `${file.name}（${formatBytes(file.size)}）`;
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.classList.remove('hidden');
});

window.addEventListener('hashchange', render);

// 決済完了後：Webhook で契約状態が反映されるまで少し待つ
async function waitForCheckout() {
  $app.innerHTML = '<div class="loading">決済を確認しています…</div>';
  for (let i = 0; i < 15; i++) {
    await loadProfile();
    if (isActive(state.profile)) { toast('ご登録ありがとうございます！'); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  toast('決済の反映に時間がかかっています。しばらくしてから再読み込みしてください。', true);
}

async function init() {
  if (!configured) return render();
  const params = new URLSearchParams(location.search);
  const checkout = params.get('checkout');
  const view = params.get('view');
  if (checkout || view) history.replaceState(null, '', location.pathname + (view ? `#/${view}` : location.hash));

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') state.recovery = true;
    const changedUser = state.session?.user?.id !== session?.user?.id;
    state.session = session;
    if (changedUser) state.profile = null;
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY') {
      if (changedUser || event === 'PASSWORD_RECOVERY') setTimeout(render, 0);
    }
  });

  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (state.session && checkout === 'success') await waitForCheckout();
  else if (checkout === 'cancel') toast('お申し込みはキャンセルされました');
  render();
}

init();
