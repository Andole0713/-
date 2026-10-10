import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import { Upload as TusUpload } from 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SCHOOL_NAME, PLANS, CONTACT } from './config.js';

// 撮影アプリ SwingFrame（会員ページの中の swing/ に入っている。ログインなしでだれでも使える）
// 撮影画面（SwingFrame）。#shoot を付けると、トップ画面を通らずにカメラが開く
const SWINGFRAME_URL = './swing/#shoot';

// SwingFrame の「コーチに送る」で渡された動画（同じサイトの IndexedDB に一時保存されている）
function handoffDb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('atg-handoff', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('files');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function getHandoff() {
  try {
    const db = await handoffDb();
    return await new Promise((resolve) => {
      const q = db.transaction('files').objectStore('files').get('swing');
      q.onsuccess = () => { db.close(); resolve(q.result?.blob ? q.result : null); };
      q.onerror = () => { db.close(); resolve(null); };
    });
  } catch { return null; }
}
async function clearHandoff() {
  state.handoff = null;
  try {
    const db = await handoffDb();
    await new Promise((resolve) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete('swing');
      tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
    });
  } catch { /* noop */ }
}

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const state = { session: null, profile: null, recovery: false, authTab: 'login', authMessage: '', unread: 0, drillUnread: 0, historyClub: '', adminPending: 0, adminMeetingTodo: 0, adminTodo: 0, meetingTab: 'upcoming' };
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
        const btns = [...wrap.querySelectorAll('button, input, select, textarea')];
        const i = btns.indexOf(document.activeElement);
        e.preventDefault();
        btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
      }
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.dataset.modal === 'cancel') close(false);
      else if (e.target.dataset.modal === 'ok') {
        // 入力欄があるときは、その値をまとめて返す（必須の欄が空なら閉じない）
        const fields = [...wrap.querySelectorAll('[name]')];
        if (!fields.length) return close(true);
        const empty = fields.find((f) => f.required && !String(f.value).trim());
        if (empty) { empty.focus(); empty.classList.add('invalid'); return; }
        close(Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? f.checked : f.value])));
      }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    (wrap.querySelector('.modal-body [name]') || wrap.querySelector('[data-modal="ok"]')).focus();
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

// 効果音（カップイン）。音源ファイルは使わず、その場で合成する。アカウント画面で消せる
//   参考にした音：アイアンショットの「バシッ」→ 約1秒あいて → カップの中で「コン、コンコンコンコン」と跳ねる
let audioCtx = null;
const soundOn = () => local.get('atg-sound') !== 'off';
function unlockAudio() {
  if (!soundOn()) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
}
// 音の高さ（1＝参考の音と同じ高さ。大きくするほど高い音）
const CUP_PITCH = 1;
// 打音を1つ鳴らす：partials＝[周波数, 強さ]、decay＝余韻の長さ（秒）、noise＝当たった瞬間の「カツッ」の高さ
function knockTone(ctx, out, t, { partials, decay, vol, attack = 0.002, noise = 3000 }) {
  partials.forEach(([f, g0], k) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    const f0 = f * CUP_PITCH; const d = decay * (k ? 0.6 : 1); // 高い成分ほど早く消える
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.985, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * g0, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(out); o.start(t); o.stop(t + d + 0.02);
  });
  const len = Math.floor(ctx.sampleRate * 0.015);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate); const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const n = ctx.createBufferSource(); n.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = noise * CUP_PITCH; bp.Q.value = 1.4;
  const ng = ctx.createGain(); ng.gain.value = vol * 0.25;
  n.connect(bp).connect(ng).connect(out); n.start(t);
}
// アイアンショット「バシッ」：鋭い打撃音（バ）＋短く締まった胴鳴り＋抜ける高い音（シッ）。キレを出すため余韻は短め
function ironShot(ctx, out, t) {
  const tone = (f, g0, d, type = 'sine', drop = 0.9) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * drop, t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g0, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(out); o.start(t); o.stop(t + d + 0.02);
  };
  tone(150, 0.45, 0.22, 'sine', 0.7);   // 締まった低い胴鳴り
  tone(260, 0.3, 0.16, 'triangle', 0.8);
  tone(1150, 0.12, 0.12, 'sine', 0.97); // 金属の響き（短く）
  tone(2900, 0.06, 0.08, 'sine', 0.98);
  const noise = (dur, shape) => {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate); const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * shape(i / len);
    const n = ctx.createBufferSource(); n.buffer = buf; return n;
  };
  const layer = (start, dur, shape, type, freq, q, gain) => {
    const n = noise(dur, shape); const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain; n.connect(f).connect(g).connect(out); n.start(t + start);
  };
  layer(0, 0.012, (x) => (1 - x) ** 4, 'highpass', 2500, 0.7, 1.2);      // 「バ」の鋭い立ち上がり
  layer(0, 0.035, (x) => (1 - x) ** 3, 'bandpass', 1300, 0.9, 1.0);      // 「バ」の厚み
  layer(0.012, 0.11, (x) => Math.min(1, x * 20) * (1 - x) ** 3, 'bandpass', 4200, 1.1, 0.35); // 「シッ」
}
function cupInSound(ctx, t0) {
  const master = ctx.createGain(); master.gain.value = 0.7;
  // 音が大きくなりすぎて割れないように、最後に軽く抑える
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 12; limiter.attack.value = 0.001; limiter.release.value = 0.12;
  master.connect(limiter).connect(ctx.destination);
  // アイアンショットの「バシッ」（キレのある音）
  ironShot(ctx, master, t0);
  // 約1秒後、カップの中で跳ねる「コン、コンコンコンコン」（硬いカップの響き）
  const cup = [[840, 0.5], [1680, 0.1], [3060, 0.16], [3560, 0.18], [4120, 0.2]];
  [[0.99, 0.18, 0.9], [1.13, 0.8, 0.55], [1.205, 0.9, 0.4], [1.275, 1, 0.26], [1.32, 0.42, 0.28], [1.38, 0.24, 0.2]]
    .forEach(([dt, v, d]) => knockTone(ctx, master, t0 + dt, { partials: cup, decay: d, vol: v, noise: 3800 }));
}
function playCupIn() {
  if (!soundOn()) return;
  unlockAudio();
  if (audioCtx) try { cupInSound(audioCtx, audioCtx.currentTime + 0.05); } catch { /* 音が鳴らなくても続ける */ }
}

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
async function uploadVideo(file, path, onProgress, bucket = VIDEO_BUCKET) {
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
      metadata: { bucketName: bucket, objectName: path, contentType: file.type || 'video/mp4', cacheControl: '3600' },
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

// ---------- ドリル動画（コーチが作る「ドリル集」。契約中はずっと見られる） ----------
const DRILL_BUCKET = 'drill-videos';
async function signedDrillUrls(drills) {
  const paths = drills.filter((d) => d?.video_path).map((d) => d.video_path);
  if (!paths.length) return {};
  const { data, error } = await sb.storage.from(DRILL_BUCKET).createSignedUrls([...new Set(paths)], 3600);
  if (error) throw error;
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}
function drillMedia(d, urls) {
  if (d.video_path) {
    const url = urls[d.video_path];
    return url ? `<video class="swing-video" src="${esc(url)}" controls playsinline preload="metadata"></video>`
      : '<p class="muted small">動画を読み込めませんでした。ページを再読み込みしてください。</p>';
  }
  return d.video_url ? videoEmbed(d.video_url) : '';
}
function drillCard(d, urls, extra = '') {
  return `<article class="drill-card">
    <h3>${esc(d.title)}</h3>${tagPills(d.tags)}
    ${d.description ? `<p class="pre">${esc(d.description)}</p>` : ''}
    ${drillMedia(d, urls)}${extra}
  </article>`;
}
// ドリルの区分（複数選べる）。グループ名：区分の一覧
const DRILL_TAGS = [
  ['スイング（P1〜P10）', ['P1 アドレス', 'P2 テークバック', 'P3 左腕水平', 'P4 トップ', 'P5 切り返し', 'P6 シャフト水平（ダウン）', 'P7 インパクト', 'P8 シャフト水平（フォロー）', 'P9 右腕水平', 'P10 フィニッシュ']],
  ['クラブ', ['ドライバー', 'FW・UT', 'アイアン', 'ウェッジ', 'パター']],
  ['球筋', ['ドロー', 'フェード', 'ストレート', '高い球', '低い球']],
  ['ミス・悩み', ['スライス', 'フック', 'ダフリ', 'トップ', 'シャンク', '飛距離アップ', '方向性']],
  ['ショット', ['フルスイング', 'ハーフスイング', 'アプローチ', 'バンカー', '傾斜']],
  ['そのほか', ['グリップ', 'リズム・テンポ', '体の使い方', '自宅でできる']],
];
const DRILL_TAG_ORDER = DRILL_TAGS.flatMap(([, list]) => list);
const sortTags = (tags = []) => [...tags].sort((a, b) => DRILL_TAG_ORDER.indexOf(a) - DRILL_TAG_ORDER.indexOf(b));
const tagPills = (tags = []) => (tags.length ? `<span class="tag-pills">${sortTags(tags).map((t) => `<span class="tag-pill">${esc(t)}</span>`).join('')}</span>` : '');
// ドリルを探すための絞り込み（名前＋区分。区分は複数選ぶと「すべて当てはまる」もの）
function drillFilter(drills) {
  const used = new Set(drills.flatMap((d) => d.tags || []));
  const groups = DRILL_TAGS.map(([g, list]) => [g, list.filter((t) => used.has(t))]).filter(([, list]) => list.length);
  return `<div class="drill-filter" data-drill-filter>
    <input type="search" class="drill-search" placeholder="ドリル名・説明で探す" data-action="filter-drills" aria-label="ドリル名・説明で探す">
    ${groups.length ? `<div class="tag-groups">${groups.map(([g, list]) => `<div class="tag-group"><span>${g}</span><div>${list.map((t) => `<button type="button" class="tag-chip" data-action="drill-tag" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}</div></div>`).join('')}</div>` : ''}
    <div class="between small drill-filter-foot"><span class="drill-hit" aria-live="polite"></span><button type="button" class="link hidden" data-action="drill-tag-clear">絞り込みを解除</button></div>
  </div>`;
}
const drillSearchAttrs = (d) => `data-text="${esc(`${d.title} ${d.description || ''}`.toLowerCase())}" data-tags="${esc((d.tags || []).join('|'))}"`;
function applyDrillFilter() {
  const box = document.querySelector('[data-drill-filter]');
  if (!box) return;
  const q = box.querySelector('.drill-search').value.trim().toLowerCase();
  const on = [...box.querySelectorAll('.tag-chip[aria-pressed="true"]')].map((b) => b.dataset.tag);
  let hit = 0; let all = 0;
  document.querySelectorAll('[data-tags]').forEach((el) => {
    const tags = el.dataset.tags ? el.dataset.tags.split('|') : [];
    const show = (!q || el.dataset.text.includes(q)) && on.every((t) => tags.includes(t));
    el.classList.toggle('hidden', !show);
    all++; if (show) hit++;
  });
  box.querySelector('.drill-hit').textContent = q || on.length ? `${all}件中 ${hit}件` : '';
  box.querySelector('[data-action="drill-tag-clear"]').classList.toggle('hidden', !(q || on.length));
}
// 区分を選ぶチェック（登録・編集で共通）
const tagChecks = (name, selected = []) => `<div class="tag-groups pick">${DRILL_TAGS.map(([g, list]) => `<div class="tag-group"><span>${g}</span><div>${list.map((t) => `<label class="tag-check"><input type="checkbox" name="${name}" value="${esc(t)}"${selected.includes(t) ? ' checked' : ''}><span>${esc(t)}</span></label>`).join('')}</div></div>`).join('')}</div>`;

// 管理者：ドリル（動画ファイル または YouTube）を1件追加して、その id を返す
async function createDrill({ title, description, file, url, tags = [] }, onProgress) {
  if (!title) throw new Error('ドリル名を入力してください');
  let video_path = null; let video_url = null;
  if (file) {
    if (file.type && !file.type.startsWith('video/')) throw new Error('ドリルは動画ファイルを選んでください');
    video_path = `drills/${videoFileName(file)}`;
    await uploadVideo(file, video_path, onProgress, DRILL_BUCKET);
  } else if (url) {
    video_url = normalizeYoutube(url);
    if (!video_url) throw new Error('ドリルの動画は YouTube のリンクを入力してください');
  } else {
    throw new Error('ドリルの動画ファイルを選ぶか、YouTube のリンクを入力してください');
  }
  const row = await must(sb.from('drills').insert({ title, description, video_path, video_url, ...(tags.length ? { tags } : {}) }).select('id').single());
  return row.id;
}
// 新しいドリルの入力欄（ドリル集の画面とレッスン作成画面で共通）
function drillFields(prefix) {
  return `<label for="${prefix}title">ドリル名</label><input id="${prefix}title" name="${prefix}title" maxlength="100" placeholder="例：左足踏み込みドリル">
    <label for="${prefix}desc">説明（任意）</label><textarea id="${prefix}desc" name="${prefix}desc" rows="3" maxlength="1000" placeholder="例：トップで一瞬止めてから、左足を踏み込んで切り返します。10回×2セット"></textarea>
    <label for="${prefix}file">動画ファイル</label><input id="${prefix}file" name="${prefix}file" type="file" accept="video/*">
    <label for="${prefix}url">または YouTube のリンク</label><input id="${prefix}url" name="${prefix}url" type="url" placeholder="https://youtu.be/...">
    <fieldset class="tag-field"><legend>区分（複数選べます・任意）</legend>${tagChecks(`${prefix}tag`)}</fieldset>
    <div id="${prefix}progress" class="hidden" aria-live="polite"><div class="between small"><span>アップロード中…</span><span class="pct">0%</span></div><div class="meter"><i style="width:0%"></i></div></div>`;
}
function drillFromForm(f, prefix) {
  return {
    title: f[`${prefix}title`].value.trim(), description: f[`${prefix}desc`].value.trim(),
    file: f[`${prefix}file`].files[0] || null, url: f[`${prefix}url`].value.trim(),
    tags: [...f.querySelectorAll(`input[name="${prefix}tag"]:checked`)].map((i) => i.value),
  };
}
function drillProgress(prefix) {
  const box = document.getElementById(`${prefix}progress`);
  box?.classList.remove('hidden');
  return (r) => {
    if (!box) return;
    const v = Math.round(r * 100);
    box.querySelector('i').style.width = `${v}%`; box.querySelector('.pct').textContent = `${v}%`;
  };
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
// 日付（YYYY-MM-DD）に月を足す。日は28日までにそろえる（どの月にもある日）
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(y, m - 1 + n, Math.min(d, 28));
  return t.toLocaleDateString('sv-SE');
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d + n).toLocaleDateString('sv-SE');
}
const fmtMonth = (ymd) => `${Number(ymd.slice(0, 4))}年${Number(ymd.slice(5, 7))}月`;
const fmtMD = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
// ロードマップの月が会員に公開済みか（公開日が来た、または前倒しで公開した）
// 取り消した月（hidden）は、公開日を過ぎていても公開しない
const rmOpen = (r) => !r.hidden && (Boolean(r.published_at) || r.publish_on <= today());
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
    <div class="top-right">${shootButton()}
      <a href="../" aria-label="${esc(SCHOOL_NAME)} トップページへ"><img class="top-logo" src="../assets/logo-mark.png" width="200" height="170" alt="${esc(SCHOOL_NAME)}"></a></div>
  </div>`;
}
// どの画面からでも、すぐにスイング撮影へ（動画を送らず撮影だけでもOK）。会員の画面だけに出す
function shootButton() {
  if (!state.profile || state.profile.role === 'admin') return '';
  return `<a class="top-shoot" href="${SWINGFRAME_URL}" aria-label="スイングを撮影する（撮影だけでもOK）">${icon('video')}<span>撮影</span></a>`;
}
const ICON = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v4M16 3v4"/><path d="M8 13.5h3v3H8z"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
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
const memberNav = (active) => nav([['home', 'home', 'ホーム'], ['submit', 'video', '撮影・提出'], ['history', 'book', '履歴', state.unread], ['drills', 'target', 'ドリル', state.drillUnread], ['account', 'user', 'アカウント']], active);
const newBadge = (l) => (l.read_at ? '' : '<span class="new-badge">NEW</span>');
const adminNav = (active) => nav([['admin/dashboard', 'gauge', 'やること', state.adminTodo], ['admin/inbox', 'inbox', '提出動画', state.adminPending], ['admin/meetings', 'calendar', '面談', state.adminMeetingTodo], ['admin/members', 'users', '会員一覧'], ['admin/drills', 'target', 'ドリル集'], ['account', 'user', 'アカウント']], active);

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

// この端末で最後にログインしたメールアドレス（次回のログイン欄に入れておく。パスワードは保存しない）
const LAST_EMAIL_KEY = 'atg-last-email';
const rememberEmail = () => { const e = state.session?.user?.email; if (e) local.set(LAST_EMAIL_KEY, e); };

// 撮影画面の「オンラインレッスン」から来たとき：ログイン済みならボタン1つでマイページへ
function viewContinue() {
  const p = state.profile;
  const email = state.session?.user?.email || '';
  return authShell(`
    <h1>オンラインレッスン</h1>
    <div class="continue-card">
      <span class="continue-ava" aria-hidden="true">${esc((p?.name || email || '?').slice(0, 1))}</span>
      <div><b>${esc(p?.name || '会員')} さん</b><small>${esc(email)}</small></div>
    </div>
    <button type="button" class="btn-block btn-gold" data-action="continue-go">ログインする</button>
    <button type="button" class="link continue-switch" data-action="switch-account">別のアカウントでログイン</button>`);
}

function viewAuth() {
  const t = state.authTab;
  const notice = !configured
    ? '<div class="notice">会員ログインは現在準備中です。開設まで今しばらくお待ちください。</div>'
    : state.authMessage ? `<div class="notice">${esc(state.authMessage)}</div>`
    : state.handoff && t !== 'reset' ? '<div class="notice">📹 SwingFrame で撮った動画をコーチに送るには、ログインしてください（初めての方は「新規登録」から）。ログインすると、そのまま送れます。</div>' : '';
  const forms = {
    login: `<form class="form" data-form="login">
        <label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="username" inputmode="email" value="${esc(local.get(LAST_EMAIL_KEY) || '')}" required>
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
    ${t === 'reset' ? '' : `<a class="auth-shoot" href="${SWINGFRAME_URL}"><span class="ico" aria-hidden="true">●</span>
      <span><b>スイングを撮影する</b><small>無料・登録不要。SwingFrame でスイングを撮って見返せます</small></span><i aria-hidden="true">›</i></a>
    <div class="seg" role="tablist">
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

// 申し込みボタン（カード決済のプランは決済ページへ、それ以外は LINE・電話）
const planApply = (pl) => (pl.checkout
  ? `<button class="btn-block btn-gold" data-action="checkout" data-plan="${esc(pl.id)}">このプランで申し込む</button>`
  : `<p class="muted small" style="margin:12px 0 0">このプランは LINE またはお電話でお申し込みください。</p>
     <a class="btn btn-block btn-line" href="${esc(CONTACT.lineUrl)}" target="_blank" rel="noopener">LINEで申し込む</a>
     <a class="btn btn-block btn-sub" href="tel:${esc(CONTACT.tel)}">電話で申し込む（${esc(CONTACT.telDisplay)}）</a>`);

// プランの詳細（閉じるボタン・背景・Esc で閉じる）
function showPlanDetail(pl) {
  const d = pl.detail;
  const prev = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal plan-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-sheet-title">
    <button type="button" class="sheet-close" data-sheet="close" aria-label="閉じる">×</button>
    <span class="eyebrow">${esc(pl.en)}</span>
    <h2 id="plan-sheet-title">${esc(pl.name)}</h2>
    <p class="lead">${esc(pl.lead)}</p>
    <dl class="spec"><div><dt>対象</dt><dd>${esc(pl.target)}</dd></div><div><dt>お支払い</dt><dd>${esc(pl.payment)}</dd></div><div><dt>料金</dt><dd>${esc(pl.price)}</dd></div></dl>
    <h3>こんな方におすすめ</h3>
    <ul class="ps-check">${d.forWho.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <h3>内容</h3>
    <div class="ps-contents">${d.contents.map(([t, x]) => `<div><b>${esc(t)}</b><p>${esc(x)}</p></div>`).join('')}</div>
    <h3>1か月の流れ</h3>
    <ol class="ps-flow">${d.flow.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    <h3>お支払い・ご契約について</h3>
    <ul class="ps-terms">${d.terms.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="muted small">※ 料金・内容は変更になる場合があります。ご不明な点は LINE またはお電話（${esc(CONTACT.hours)}）でお気軽にご相談ください。</p>
    <div class="ps-apply">${planApply(pl)}</div>
    <button type="button" class="btn-block btn-sub" data-sheet="close">閉じる</button>
  </div>`;
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); prev?.focus?.(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const items = [...wrap.querySelectorAll('button, a[href]')];
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
    }
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-sheet="close"]')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  wrap.querySelector('.sheet-close').focus();
}

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
        ${pl.detail ? `<button type="button" class="btn-block btn-sub plan-detail-btn" data-action="plan-detail" data-plan="${esc(pl.id)}">詳細を見る</button>` : ''}
        ${planApply(pl)}
      </div>`).join('')}
    <p class="muted small">カード決済は Stripe の安全な決済ページで行います。解約・プラン変更はいつでも「アカウント」から行えます。</p>
  </div>` + nav([['plans', 'card', 'プラン'], ['account', 'user', 'アカウント']], 'plans');
}

// ---------- 画面：会員 ----------

async function viewMemberHome() {
  const p = state.profile;
  const since = monthStart();
  const [tasks, lessons, subs, monthSubs, monthLessons, roadmap] = await Promise.all([
    must(sb.from('tasks').select('*').eq('member_id', p.id).order('sort_order').order('created_at')),
    must(sb.from('lessons').select('id, lesson_date, title, point, practice, practice_done, read_at').eq('member_id', p.id).order('lesson_date', { ascending: false }).order('created_at', { ascending: false }).limit(1)),
    must(sb.from('submissions').select('id, created_at, club, status').eq('member_id', p.id).eq('status', 'pending').order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id').eq('member_id', p.id).gte('created_at', since)),
    must(sb.from('lessons').select('id').eq('member_id', p.id).gte('created_at', since)),
    must(sb.from('roadmap_items').select('id, publish_on, theme, published_at, hidden, seen_at, drills(title)').eq('member_id', p.id).order('publish_on')),
  ]);
  const [rounds, myMeetings] = await Promise.all([
    must(sb.from('rounds').select('played_on, score, holes').eq('member_id', p.id)),
    sb.from('meetings').select('scheduled_at, summary').eq('member_id', p.id).eq('status', 'done').neq('summary', '').order('scheduled_at', { ascending: false }).limit(1)
      .then((r) => r.data || []),
  ]);
  const lastMeeting = myMeetings[0];
  const st = scoreStats(rounds, p);
  const rmOpened = roadmap.filter(rmOpen);
  const rmNow = rmOpened[rmOpened.length - 1];
  const rmDays = rmNow ? (await must(sb.from('roadmap_practice').select('practiced_on').eq('item_id', rmNow.id))).length : 0;
  const latest = lessons[0];
  const done = tasks.filter((t) => t.done).length;
  const plan = planOf(p.plan);
  const quota = quotaOf(p);
  const extra = extraThisMonth(p);
  return header('マイページ') + `<div class="content wide"><div class="cols">
  <div class="col-main">
    <div class="blk" style="--o:1">
    ${state.handoff ? `<a class="handoff-banner" href="#/submit/swingframe"><span class="ico" aria-hidden="true">📹</span>
        <span><b>SwingFrame で撮った動画があります</b><small>このままコーチに送れます</small></span><i aria-hidden="true">›</i></a>` : ''}
    </div>
    <div class="blk" style="--o:2">
    <div class="hero">${plan ? `<span class="pill">${esc(plan.name)}</span>` : ''}
      <h1>${esc(p.name)}さん、おかえりなさい。</h1>
      <div class="muted">現在の目標</div><h2 style="margin:4px 0 0;font-size:24px">${esc(p.goal || '未設定')}</h2>
      ${p.theme ? `<div style="margin-top:12px">今月のテーマ：${esc(p.theme)}</div>` : ''}</div>
    </div>
    <div class="blk" style="--o:3">
    ${rmNow ? `<a class="rm-home" href="#/drills">
        <div class="rm-home-head"><span class="rm-badge">今月のドリル</span>${rmNow.seen_at ? '' : '<span class="new-badge">NEW</span>'}
          <span class="rm-home-step"><b>${rmOpened.length}</b>/${roadmap.length}か月目</span></div>
        <h3>${esc(rmNow.theme || rmNow.drills?.title || 'ドリル')}</h3>
        ${rmNow.drills && rmNow.theme ? `<p class="rm-home-drill">🎯 ${esc(rmNow.drills.title)}</p>` : ''}
        <div class="rm-home-meter" aria-hidden="true"><i style="width:${Math.round((rmOpened.length / roadmap.length) * 100)}%"></i></div>
        <div class="rm-home-foot"><span class="rm-home-days">${rmDays ? `✓ 今月の練習 <b>${rmDays}</b>日` : 'まだ練習の記録がありません'}</span>
          <span class="rm-home-btn">ドリルを見る <i aria-hidden="true">›</i></span></div></a>` : ''}
    </div>
    <div class="blk" style="--o:7">
    <div class="section-title"><div><div class="eyebrow">Practice</div><h2>今月の課題</h2></div><span class="muted">${done}/${tasks.length}</span></div>
    ${tasks.length ? tasks.map((t) => `<button type="button" class="task${t.done ? ' done' : ''}" data-action="toggle-task" data-id="${t.id}" data-done="${t.done}" aria-pressed="${t.done}">
        <span class="check">${t.done ? '✓' : ''}</span><span><b>${esc(t.title)}</b><div class="muted">${esc(t.detail)}</div></span></button>`).join('')
      : '<div class="empty">コーチから課題が届くとここに表示されます</div>'}
    </div>
    <div class="blk" style="--o:8">
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
    </div>
  </div>
  <div class="col-side">
    <div class="blk" style="--o:4">
    <div class="grid">
      <a class="stat stat-link" href="#/scores"><div class="label">ベストスコア</div><b>${esc(st.best ?? '—')}</b></a>
      <a class="stat stat-link" href="#/scores"><div class="label">平均スコア${st.count ? `<small>直近${st.recent}R</small>` : ''}</div><b>${esc(st.avg ?? '—')}</b></a>
    </div>
    <a class="score-add" href="#/scores"><span class="sa-txt">⛳ ラウンドのスコアを記録する${st.count ? `<small>${st.count}ラウンド記録済み</small>` : ''}</span><i aria-hidden="true">›</i></a>
    </div>
    <div class="blk" style="--o:5">
    ${!isStandalone() && !local.get('atg-install-dismissed') ? `<div class="install-banner">
        <div><b>ホーム画面に追加しませんか？</b><span>アプリのようにワンタップで開けます</span></div>
        <a class="btn btn-sm btn-gold" href="#/install">やり方</a>
        <button type="button" class="install-close" data-action="dismiss-install" aria-label="閉じる">×</button></div>` : ''}
    </div>
    <div class="blk" style="--o:6">
    <div class="section-title"><div><div class="eyebrow">This Month</div><h2>今月のサポート</h2></div></div>
    <div class="card">
      <div class="support">
        <div><span class="label">動画提出</span><b>${monthSubs.length}${quota ? `<small>/${quota}本</small>` : '<small>本</small>'}</b>
          ${quota ? `<div class="meter"><i style="width:${Math.min(100, (monthSubs.length / quota) * 100)}%"></i></div>` : ''}</div>
        <div><span class="label">解説動画</span><b>${monthLessons.length}<small>本</small></b></div>
        <div><span class="label">次回の面談</span>${p.next_meeting_at && new Date(p.next_meeting_at).getTime() > Date.now() - 2 * 3600000 ? meetingWhen(p.next_meeting_at) : '<b class="none">未定</b>'}</div>
      </div>
      ${extra ? `<p class="muted small" style="margin:10px 0 0">今月は追加の ${extra} 本を含みます。</p>` : ''}
      ${plan?.monthly ? '<p class="muted small" style="margin:10px 0 0">毎月、動画2本の提出と25分のオンライン面談1回が受けられます。</p>' : ''}
      ${lastMeeting ? `<details class="last-meeting"><summary>前回の面談（${fmtShort(lastMeeting.scheduled_at)}）のまとめ</summary><p class="pre">${esc(lastMeeting.summary)}</p></details>` : ''}
      <div class="meeting-book">
        <p class="muted small">面談のご予約はLINEで承ります。日時が決まると「次回の面談」に表示されます。</p>
        ${lineBtn('LINEで面談を予約する')}
      </div>
    </div>
    </div>
  </div>
  </div>  </div>` + memberNav('home');
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
    <a class="shoot-cta" href="${SWINGFRAME_URL}"><span class="ico" aria-hidden="true">●</span>
      <span><b>SwingFrame で撮影する</b><small>ガイドに合わせて自動で録画。撮ったあと再生画面の「⛳ コーチへ」を押すと、そのままここに届きます</small></span><i aria-hidden="true">›</i></a>
    <div class="notice">正面または後方から、全身とクラブが入るように撮影してください。<a href="#/guide">撮り方ガイドを見る</a><br>送った動画は<b>${RETENTION_LABEL}</b>保存され、その後自動で削除されます。</div>
    <form class="card form" data-form="submit">
      <label for="video">スイング動画</label>
      <input id="video" name="video" type="file" accept="video/*"${state.handoff ? '' : ' required'} class="visually-hidden">
      ${state.handoff ? `<div class="handoff-pick"><b>📹 SwingFrame で撮った動画</b>
          <span>${new Date(state.handoff.ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}・${formatBytes(state.handoff.blob.size)}</span>
          <button type="button" class="link" data-action="handoff-clear">この動画を使わない</button></div>` : ''}
      <label class="file-pick" for="video">
        <span class="file-pick-main">${state.handoff ? 'ほかの動画を選ぶ' : '動画を選ぶ・撮影する'}</span>
        <span class="file-pick-sub" id="video-name">スマホのカメラロールから選べます</span>
      </label>
      <video id="video-preview" class="swing-video${state.handoff ? '' : ' hidden'}" controls playsinline muted${state.handoff ? ` src="${URL.createObjectURL(state.handoff.blob)}"` : ''}></video>
      <div class="grid">
        <div><label for="club">クラブ</label><select id="club" name="club">
          ${(myClubs.length ? [...myClubs, 'その他'] : DEFAULT_CLUB_OPTIONS).map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div><label for="angle">撮影方向</label><select id="angle" name="angle"><option>正面</option><option>後方</option><option>その他</option></select></div>
      </div>
      ${myClubs.length
        ? '<p class="muted small" style="margin:8px 0 0">クラブはMyクラブセッティングから表示しています。<a href="#/account/clubs">変更する</a></p>'
        : '<p class="tip">アカウントの<a href="#/account/clubs">「Myクラブセッティング」</a>を登録すると、お使いのクラブから選べるようになります。</p>'}
      <label for="question">お悩み・質問（文章で）</label>
      <textarea id="question" name="question" rows="5" maxlength="2000" placeholder="例：最近ドライバーが右に出ます。前回の課題はだいぶできるようになりました。">${esc(state.handoff?.note || '')}</textarea>
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
  const yt = l.video_url ? youtubeId(l.video_url) : null;
  return `<a class="lesson-card${l.read_at ? '' : ' unread'}" href="#/lesson/${l.id}">
    <div class="lc-top"><span class="lc-date">${fmtDate(l.lesson_date)}</span>${newBadge(l)}</div>
    <h3>${esc(l.title)}</h3>
    ${l.point ? `<p class="lc-point">${esc(l.point)}</p>` : ''}
    ${yt ? `<div class="lc-video">
        <img src="https://i.ytimg.com/vi/${yt}/hqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">
        <span class="lc-play" aria-hidden="true"></span>
        <span class="lc-video-label">▶ コーチの解説動画を見る</span>
      </div>` : ''}
    <div class="lc-foot">${practiceProgress(l)}<span class="go">${yt ? 'レッスンの詳細' : 'レッスンを見る'} <i aria-hidden="true">›</i></span></div>
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

  return header('レッスン履歴') + `<div class="content wide">
    <p class="muted small" style="margin:0 0 8px">送った動画と、その動画へのコーチの解説をセットで表示しています。動画は送信から${RETENTION_LABEL}見られます。</p>
    ${clubs.length > 1 ? `<div class="filter-chips" role="group" aria-label="クラブで絞り込む">
      ${[['', 'すべて'], ...clubs.map((c) => [c, c])].map(([v, label]) => `<button type="button" data-action="history-filter" data-club="${esc(v)}" class="${filter === v ? 'on' : ''}" aria-pressed="${filter === v}">${esc(label)}</button>`).join('')}
    </div>` : ''}
    ${list ? `<div class="history-list">${list}</div>` : `<div class="empty">${filter ? 'このクラブの動画はまだありません' : 'まだ履歴はありません。まずは動画を送りましょう。'}</div>`}
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
  const [urls, links] = await Promise.all([
    signedVideoUrls([l.submissions]),
    must(sb.from('lesson_drills').select('sort_order, drills(*)').eq('lesson_id', l.id).order('sort_order')),
  ]);
  const drills = links.map((x) => x.drills).filter(Boolean);
  const drillUrls = await signedDrillUrls(drills);
  const mine = l.member_id === state.profile.id;
  if (mine && !l.read_at) {
    const { error } = await sb.rpc('mark_lesson_read', { p_lesson: l.id });
    if (!error) state.unread = Math.max(0, state.unread - 1);
  }
  return header('レッスン詳細', back) + `<div class="content wide lesson-page">
    <div class="blk" style="--o:0">
    <div class="lesson-head">
      <span class="date">${fmtDate(l.lesson_date)}</span>
      <h1>${esc(l.title)}</h1>
      ${l.point ? `<div class="diag"><span>今回の診断</span><p>${esc(l.point)}</p></div>` : ''}
    </div>
    </div>
  <div class="cols">
  <div class="col-main">
    <div class="blk" style="--o:1">
    ${l.video_url ? `<section class="card lesson-sec">${secTitle('▶', 'コーチの解説動画')}${videoEmbed(l.video_url)}</section>` : ''}
    </div>
    <div class="blk" style="--o:2">
    ${drills.length ? `<section class="card lesson-sec">${secTitle('◎', 'ドリル動画')}
        ${mine ? '<p class="muted small" style="margin:-4px 0 6px">ドリルは「ドリル」のページにもたまっていきます。契約中はいつでも見返せます。</p>' : ''}
        ${drills.map((d) => drillCard(d, drillUrls)).join('')}</section>` : ''}
    </div>
    <div class="blk" style="--o:5">
    ${l.submissions ? `<section class="card lesson-sec">${secTitle('◉', '送った動画')}${swingVideo(l.submissions, urls)}
        ${mine ? `<a class="muted small" href="#/submission/${l.submission_id}">送った動画の詳細（保存期限など）›</a>` : ''}
        ${l.submissions.question ? `<div class="my-q"><span>送ったときのお悩み・質問</span><p class="pre">${esc(l.submissions.question)}</p></div>` : ''}</section>` : ''}
    </div>
  </div>
  <div class="col-side">
    <div class="blk" style="--o:3">
    ${l.feedback ? `<section class="card lesson-sec">${secTitle('✎', 'コーチからのフィードバック')}<div class="fb">${richText(l.feedback)}</div></section>` : ''}
    </div>
    <div class="blk" style="--o:4">
    ${l.practice ? `<section class="card lesson-sec practice">${secTitle('✓', '次回までの練習')}
        ${mine ? '<p class="muted small" style="margin:-4px 0 4px">練習したらタップしてチェックしましょう。</p>' : ''}
        ${drillList(l.practice, l.practice_done || [], mine ? l.id : null)}</section>` : ''}
    </div>
  </div>
  </div>
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
      <div class="fs-seg" role="group" aria-label="文字の大きさ">${FONT_SIZES.map(([k, label]) => `<button type="button" data-action="font-size" data-size="${k}" aria-pressed="${document.documentElement.dataset.fs === k}" class="${document.documentElement.dataset.fs === k ? 'on' : ''}">${label}</button>`).join('')}</div>
    </div>
    ${admin ? '' : `<div class="card">
      <b>効果音</b> <span class="muted small">（この端末だけに反映）</span>
      <label class="switch"><input type="checkbox" name="sound_toggle"${soundOn() ? ' checked' : ''}>
        <span>ログインしたとき・動画を送ったときにカップインの音を鳴らす</span></label>
      <button type="button" class="btn-sm btn-sub" data-action="sound-test" style="margin-top:8px">♪ 試しに鳴らす</button>
    </div>`}
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

// 会員：これまでに届いたドリル（契約中はずっと見られる）
// ロードマップのマス目：段の端に折り返しの矢印を付け、開いた月の詳細をその段のすぐ下に差し込む
const RM_COLS = () => (window.matchMedia('(min-width:700px)').matches ? 4 : 3);
function rmLayout(openIndex) {
  const grid = document.getElementById('rm-grid');
  if (!grid) return;
  const cols = RM_COLS();
  grid.style.setProperty('--cols', cols);
  const tiles = [...grid.querySelectorAll('.rm-tile')];
  const store = grid.parentElement.querySelector('.rm-panels');
  grid.querySelectorAll('.rm-panel').forEach((p) => store.appendChild(p));
  tiles.forEach((t, i) => {
    t.classList.toggle('rowend', (i + 1) % cols === 0 || i === tiles.length - 1);
    t.classList.toggle('last', i === tiles.length - 1);
    t.classList.toggle('active', i === openIndex);
    t.setAttribute('aria-expanded', String(i === openIndex));
    t.classList.remove('has-panel');
  });
  if (openIndex == null || openIndex < 0 || !tiles[openIndex]) { grid.dataset.open = ''; return; }
  const endIndex = Math.min(tiles.length - 1, Math.floor(openIndex / cols) * cols + cols - 1);
  const panel = store.querySelector(`.rm-panel[data-i="${openIndex}"]`);
  panel.style.setProperty('--px', `${(((openIndex % cols) + 0.5) / cols) * 100}%`);
  tiles[endIndex].after(panel);
  tiles[endIndex].classList.add('has-panel');
  grid.dataset.open = String(openIndex);
}
window.addEventListener('resize', () => {
  const grid = document.getElementById('rm-grid');
  if (grid && Number(grid.style.getPropertyValue('--cols')) !== RM_COLS()) rmLayout(grid.dataset.open === '' ? null : Number(grid.dataset.open));
});

// ---------- スコア記録 ----------
// ベストは18ホールの全ラウンドから、平均は18ホールの直近10ラウンドから計算する
const AVG_ROUNDS = 10;
function scoreStats(rounds, p = {}) {
  const full = rounds.filter((r) => r.holes === 18)
    .sort((a, b) => (a.played_on < b.played_on ? 1 : a.played_on > b.played_on ? -1 : 0));
  if (!full.length) return { best: p.best_score ?? null, avg: p.avg_score ?? null, count: 0, recent: 0 };
  const recent = full.slice(0, AVG_ROUNDS);
  const avg = recent.reduce((t, r) => t + r.score, 0) / recent.length;
  return { best: Math.min(...full.map((r) => r.score)), avg: Math.round(avg * 10) / 10, count: full.length, recent: recent.length };
}

async function viewScores() {
  const p = state.profile;
  const rounds = await must(sb.from('rounds').select('*').eq('member_id', p.id).order('played_on', { ascending: false }).order('created_at', { ascending: false }));
  const st = scoreStats(rounds, p);
  const last = rounds.find((r) => r.holes === 18);
  return header('スコア記録', 'home') + `<div class="content">
    <div class="grid score-sum">
      <div class="stat"><div class="label">ベストスコア</div><b>${esc(st.best ?? '—')}</b></div>
      <div class="stat"><div class="label">平均スコア${st.count ? `<small>直近${st.recent}R</small>` : ''}</div><b>${esc(st.avg ?? '—')}</b></div>
    </div>
    <p class="muted small" style="margin:6px 0 0">18ホールのラウンドから自動で計算します（ベストは全ラウンド、平均は直近${AVG_ROUNDS}ラウンド）。${st.count ? `記録：${st.count}ラウンド` : ''}</p>

    <form class="card form" data-form="round">
      <b>ラウンドのスコアを記録</b>
      <label for="played_on">日付</label><input id="played_on" name="played_on" type="date" value="${today()}" max="${today()}" required>
      <label for="course_name">ゴルフ場</label>
      <input id="course_name" name="course_name" list="course-list" maxlength="100" required autocomplete="off" data-action="course-search" placeholder="ゴルフ場名を入力（候補が出ます）" value="${esc(last?.course_name || '')}">
      <datalist id="course-list"></datalist>
      <div class="halves">
        <div><label for="out_score">前半</label><input id="out_score" name="out_score" type="number" inputmode="numeric" min="10" max="125" required placeholder="例：47" data-action="round-total"></div>
        <span class="plus" aria-hidden="true">＋</span>
        <div><label for="in_score">後半</label><input id="in_score" name="in_score" type="number" inputmode="numeric" min="10" max="125" placeholder="例：48" data-action="round-total"></div>
        <span class="plus" aria-hidden="true">＝</span>
        <div class="total"><span class="lbl">18H</span><b id="round-total">—</b></div>
      </div>
      <p class="muted small" style="margin:4px 0 0">ハーフだけ回ったときは、後半を空欄にすると9ホールとして記録します（ベスト・平均の計算には入りません）。</p>
      <label for="putts">パット数（任意）</label><input id="putts" name="putts" type="number" inputmode="numeric" min="0" max="150" placeholder="例：36">
      <label for="note">ひとこと（任意）</label><input id="note" name="note" maxlength="300" placeholder="例：ドライバーが安定してきた">
      <button class="btn-block btn-gold" type="submit">記録する</button>
    </form>

    <div class="section-title"><div><div class="eyebrow">Rounds</div><h2>これまでのラウンド</h2></div></div>
    ${rounds.length ? `<div class="card">${rounds.map((r) => `<div class="list-item round-row">
        <div class="grow"><b>${fmtDate(r.played_on)}</b>　${esc(r.course_name)}${r.holes === 9 ? '<span class="pill">9H</span>' : ''}
          <div class="muted small">${r.out_score != null ? `${r.out_score}${r.in_score != null ? ` / ${r.in_score}` : ''}　` : ''}${r.putts != null ? `パット ${r.putts}　` : ''}${esc(r.note)}</div></div>
        <b class="round-score${st.count && r.holes === 18 && r.score === st.best ? ' best' : ''}">${r.score}</b>
        <button type="button" class="btn-sm btn-sub" data-action="delete-round" data-id="${r.id}" data-label="${esc(`${fmtDate(r.played_on)} ${r.course_name}（${r.score}）`)}" aria-label="削除">×</button>
      </div>`).join('')}</div>` : '<div class="empty">まだ記録はありません。ラウンドしたらスコアを記録しましょう。</div>'}
  </div>` + memberNav('home');
}

// 会員：ロードマップ（毎月1本のドリルの定期公開）
// その月の期間（公開日〜次の月の公開日の前日。最大31日）
function rmPeriod(items, i) {
  const start = items[i].publish_on;
  const next = items[i + 1]?.publish_on;
  const days = [];
  for (let d = start; days.length < 31 && (!next || d < next); d = addDays(d, 1)) days.push(d);
  return days;
}
function practiceBlock(r, days, log) {
  const done = new Set(log);
  const t = today();
  const did = done.has(t);
  return `<div class="practice-log" data-item="${r.id}">
    <div class="between"><b class="small">練習した日 <span class="pl-count">${done.size}</span>日</b>
      <button type="button" class="btn-sm ${did ? 'btn-sub' : 'btn-gold'} pl-btn" data-action="practice-today" data-item="${r.id}" aria-pressed="${did}">${did ? '✓ 今日は練習済み' : '今日練習した'}</button></div>
    <div class="pl-days" aria-label="練習した日">${days.map((d) => `<i class="${done.has(d) ? 'on' : ''}${d === t ? ' today' : ''}${d > t ? ' future' : ''}" data-day="${d}" title="${fmtMD(d)}"></i>`).join('')}</div>
  </div>`;
}
function reflectionForm(r, body) {
  return `<form class="reflection form" data-form="reflection" data-item="${r.id}">
    <label for="rf-${r.id}">今月のふり返り</label>
    <textarea id="rf-${r.id}" name="body" rows="3" maxlength="1000" placeholder="例：トップで止める意識で、切り返しが少しゆっくりになった。まだ右に出ることがある。">${esc(body || '')}</textarea>
    <button class="btn-sm btn-sub" type="submit">ふり返りを保存</button>
  </form>`;
}
function roadmapView(items, urls, extra = {}) {
  if (!items.length) return '';
  const { practice = [], reflections = [], goal = '' } = extra;
  const logOf = (id) => practice.filter((x) => x.item_id === id).map((x) => x.practiced_on);
  const refOf = (id) => reflections.find((x) => x.item_id === id)?.body || '';
  const open = items.filter(rmOpen);
  const current = open[open.length - 1];
  const step = open.length;
  const last = items[items.length - 1];
  return `<section class="roadmap" data-current="${items.indexOf(current)}">
    <div class="rm-head">
      <div><div class="eyebrow">Roadmap</div><h2>あなたのロードマップ</h2></div>
      <div class="rm-step"><b>${step}</b><small>/${items.length}か月</small></div>
    </div>
    <div class="meter"><i style="width:${Math.round((step / items.length) * 100)}%"></i></div>
    ${goal ? `<p class="rm-goal-top">🏁 ゴール：<b>${esc(goal)}</b></p>` : ''}
    <p class="muted small" style="margin:8px 0 0">毎月1本、あなた専用のドリルが公開されます。ご契約中はいつでも見返せます。</p>
    <div class="rm-grid" id="rm-grid">${items.map((r, i) => {
      const isOpen = rmOpen(r);
      const isCurrent = r === current;
      const isNew = isOpen && !r.seen_at;
      const cls = isCurrent ? 'current' : isOpen ? 'done' : 'locked';
      const icon = isCurrent ? '▶' : isOpen ? '✓' : '🔒';
      return `<button type="button" class="rm-tile ${cls}" data-action="rm-open" data-i="${i}" aria-expanded="false" aria-controls="rm-panel-${i}">
          ${isCurrent ? '<span class="now">今月</span>' : ''}<span class="no">${i + 1}か月目</span><span class="st" aria-hidden="true">${icon}</span>
          ${isNew ? '<span class="dot" aria-label="NEW"></span>' : ''}
          <b>${esc(r.theme || (r.drills?.title ?? 'テーマ準備中'))}</b></button>`;
    }).join('')}
      <div class="rm-goal-tile">🏁 ゴール：${esc(goal || '目標達成')}</div>
    </div>
    <div class="rm-panels" hidden>${items.map((r, i) => {
      const isOpen = rmOpen(r);
      const isCurrent = r === current;
      const isNew = isOpen && !r.seen_at;
      const days = logOf(r.id).length;
      const head = `${isCurrent ? '<span class="rm-badge">今月のドリル</span>' : ''}
        <div class="rm-month">${i + 1}か月目・${fmtMonth(r.publish_on)}${isNew ? '<span class="new-badge">NEW</span>' : ''}${!isCurrent && isOpen && days ? `<span class="rm-days">練習 ${days}日</span>` : ''}</div>
        <h3>${esc(r.theme || (r.drills?.title ?? 'テーマ準備中'))}</h3>`;
      const body = isOpen
        ? `${r.note ? `<p class="rm-note pre">${esc(r.note)}</p>` : ''}${r.drills ? drillCard(r.drills, urls) : '<p class="muted small">ドリルは準備中です。もうしばらくお待ちください。</p>'}
           ${isCurrent ? practiceBlock(r, rmPeriod(items, i), logOf(r.id)) : ''}${reflectionForm(r, refOf(r.id))}`
        : `<p class="rm-lock">🔒 ${r.hidden ? '公開準備中' : `${fmtMD(r.publish_on)} に公開予定`}</p>`;
      return `<section class="rm-panel ${isCurrent ? 'current' : isOpen ? 'done' : 'locked'}" id="rm-panel-${i}" data-i="${i}">
          <button type="button" class="rm-close" data-action="rm-open" data-i="${i}" aria-label="閉じる">×</button>${head}${body}</section>`;
    }).join('')}</div>
    <p class="muted small" style="margin:10px 0 0">各月を押すと、その下にドリルが表示されます。</p>
  </section>`;
}

async function viewMemberDrills() {
  const p = state.profile;
  const [rows, roadmap] = await Promise.all([
    must(sb.from('lesson_drills')
      .select('sort_order, drills(*), lessons!inner(id, title, lesson_date, member_id)')
      .eq('lessons.member_id', p.id)),
    must(sb.from('roadmap_items').select('id, publish_on, theme, note, published_at, hidden, seen_at, drills(*)').eq('member_id', p.id).order('publish_on')),
  ]);
  const [practice, reflections, goals] = roadmap.length ? await Promise.all([
    must(sb.from('roadmap_practice').select('item_id, practiced_on').eq('member_id', p.id)),
    must(sb.from('roadmap_reflections').select('item_id, body').eq('member_id', p.id)),
    must(sb.from('roadmap_goals').select('goal').eq('member_id', p.id)),
  ]) : [[], [], []];
  // 見たので既読にする（今回の表示では NEW を出したまま）
  if (roadmap.some((r) => rmOpen(r) && !r.seen_at)) {
    const { error } = await sb.rpc('mark_roadmap_seen');
    if (!error) state.drillUnread = 0;
  }
  // 同じドリルが何度か届いた場合は、いちばん新しいレッスンにまとめる
  const byDrill = new Map();
  rows.filter((r) => r.drills).sort((a, b) => (a.lessons.lesson_date < b.lessons.lesson_date ? 1 : -1))
    .forEach((r) => { if (!byDrill.has(r.drills.id)) byDrill.set(r.drills.id, r); });
  const list = [...byDrill.values()];
  const urls = await signedDrillUrls([...list.map((r) => r.drills), ...roadmap.filter(rmOpen).map((r) => r.drills)]);
  return header('ドリル') + `<div class="content wide">
    ${roadmapView(roadmap, urls, { practice, reflections, goal: goals[0]?.goal || p.goal })}
    <div class="section-title"><div><div class="eyebrow">From Lessons</div><h2>レッスンで届いたドリル</h2></div></div>
    ${list.length ? `<div class="drill-list">${list.map((r) => drillCard(r.drills, urls,
      `<a class="drill-from" href="#/lesson/${r.lessons.id}">${fmtDate(r.lessons.lesson_date)} のレッスン「${esc(r.lessons.title)}」より ›</a>`)).join('')}</div>`
      : '<div class="empty">コーチからレッスンでドリルが届くと、ここにたまっていきます。</div>'}
  </div>` + memberNav('drills');
}

// 使い方ガイド（初回ログイン時に自動で表示。アカウント画面からいつでも見られる）
function viewGuide() {
  const first = !state.profile.onboarded_at;
  return header('使い方ガイド', first ? '' : 'account') + `<div class="content guide">
    ${first ? `<div class="hero"><div class="eyebrow">Welcome</div><h1>${esc(state.profile.name || '')}さん、ようこそ。</h1>
      <p style="margin:0">レッスンの受け方を3つのステップでご紹介します。</p></div>` : ''}
    <section class="card guide-step">
      <div class="step-no"><span>STEP</span>1</div>
      <h2>動画を撮る <small>このアプリの撮影機能「SwingFrame」を使います</small></h2>
      <ol>
        <li>下のメニューの「<b>撮影・提出</b>」→「<b>SwingFrame で撮影する</b>」を押します</li>
        <li>ガイドに合わせて立つと、自動で録画されます</li>
        <li>撮った動画の再生画面で「<b>⛳ コーチへ</b>」を押すと、提出画面にそのまま届きます</li>
      </ol>
      <a class="btn btn-sm btn-sub" href="${SWINGFRAME_URL}" style="margin:0 0 10px">SwingFrame を開く ›</a>
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
        <li>下のメニューの「<b>撮影・提出</b>」を開く</li>
        <li>SwingFrame から届いた動画を確認する（カメラロールの動画を送るときは「<b>動画を選ぶ</b>」から選ぶ）</li>
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

// 日付の計算（日本時間）
const DAY = 86400000;
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
const isoDaysFrom = (n) => new Date(Date.now() + n * DAY).toISOString();
const monthStartIso = () => monthStart();
const MEETING_STATUS = { scheduled: ['予定', ''], done: ['完了', 'ok'], no_show: ['欠席', 'warn'], canceled: ['キャンセル', 'mute'] };
const meetingPill = (m) => {
  const late = m.status === 'scheduled' && new Date(m.scheduled_at).getTime() + (m.duration_min || 25) * 60000 < Date.now();
  const [label, cls] = late ? ['結果未入力', 'warn'] : MEETING_STATUS[m.status] || ['—', ''];
  return `<span class="pill ${cls}">${label}</span>`;
};
// 動画の返信目標（提出から何時間以内に返すか）
const REPLY_TARGET_H = 48;
// 平均スコアより何打以上良ければ「好スコア」としてお知らせするか
const GREAT_MARGIN = 5;
// レッスンを送ってから何日見ていなければ「未読」としてお知らせするか
const UNREAD_DAYS = 3;
const hoursText = (h) => (h >= 48 ? `${Math.floor(h / 24)}日` : `${h}時間`);
// 返信目標までの残り時間（過ぎていれば超過時間）
const replyDue = (iso) => {
  const left = Math.ceil(REPLY_TARGET_H - (Date.now() - new Date(iso).getTime()) / 3600000);
  if (left <= 0) return { over: true, cls: 'late', text: `返信目標を${hoursText(Math.max(1, -left))}超過` };
  return { over: false, cls: left <= 12 ? 'soon' : '', text: `返信目標まであと${hoursText(left)}` };
};
// ベスト更新・ベストタイ・平均より大きく良いスコアを探す（18ホールのみ）
function findCelebrations(rounds, people, acked = new Set(), days = 14) {
  const byMember = new Map();
  rounds.filter((r) => r.holes === 18).forEach((r) => {
    if (!byMember.has(r.member_id)) byMember.set(r.member_id, []);
    byMember.get(r.member_id).push(r);
  });
  const out = [];
  for (const [mid, list] of byMember) {
    list.sort((a, b) => (a.played_on !== b.played_on ? (a.played_on < b.played_on ? -1 : 1) : (a.created_at < b.created_at ? -1 : 1)));
    const p = people.find((x) => x.id === mid) || {};
    list.forEach((r, i) => {
      if (daysAgo(r.created_at) > days || acked.has(r.id)) return;
      const prev = list.slice(0, i);
      const best = prev.length ? Math.min(...prev.map((x) => x.score)) : p.best_score ?? null;
      const recent = prev.slice(-AVG_ROUNDS);
      const avg = recent.length ? recent.reduce((t, x) => t + x.score, 0) / recent.length : p.avg_score ?? null;
      const tags = [];
      if (best != null && r.score < best) tags.push(['best', `ベストスコア更新！（これまで ${best}）`]);
      else if (best != null && r.score === best) tags.push(['tie', 'ベストスコアタイ']);
      if (avg != null && avg - r.score >= GREAT_MARGIN) tags.push(['great', `平均（${Math.round(avg * 10) / 10}）より ${Math.round((avg - r.score) * 10) / 10}打 良い`]);
      if (tags.length) out.push({ r, tags, name: p.name });
    });
  }
  return out.sort((a, b) => (a.r.created_at < b.r.created_at ? 1 : -1));
}
const memberLink = (id, name) => `<a href="#/admin/member/${id}">${esc(name || '（名前未設定）')}</a>`;

// メニューの件数（確認待ちの動画・結果未入力の面談）
async function loadAdminBadges() {
  const [pend, late] = await Promise.all([
    sb.from('submissions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('meetings').select('id', { count: 'exact', head: true }).eq('status', 'scheduled').lt('scheduled_at', new Date(Date.now() - 30 * 60000).toISOString()),
  ]);
  state.adminPending = pend.count || 0;
  state.adminMeetingTodo = late.count || 0;
}

// ダッシュボード：対応が必要なことを1画面にまとめる
async function viewDashboard() {
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const [members, pending, meetings, rmSoon, rmAll, subs30, practice30, rounds30, refs7, rounds18, acks, unread] = await Promise.all([
    must(sb.from('profiles').select('id, name, email, role, plan, subscription_status, access_until, current_period_end, created_at, best_score, avg_score').order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id, created_at, club, angle, member_id, profiles(name)').eq('status', 'pending').order('created_at')),
    must(sb.from('meetings').select('id, member_id, scheduled_at, duration_min, status, profiles(name)').gte('scheduled_at', isoDaysFrom(-45)).order('scheduled_at')),
    must(sb.from('roadmap_items').select('id, member_id, publish_on, theme, profiles(name)').is('drill_id', null).eq('hidden', false).gte('publish_on', today()).lte('publish_on', isoDaysFrom(14).slice(0, 10)).order('publish_on')),
    must(sb.from('roadmap_items').select('member_id')),
    must(sb.from('submissions').select('member_id, created_at').gte('created_at', isoDaysFrom(-30))),
    must(sb.from('roadmap_practice').select('member_id, practiced_on').gte('practiced_on', isoDaysFrom(-30).slice(0, 10))),
    must(sb.from('rounds').select('member_id, played_on, created_at, score, course_name, profiles(name)').gte('created_at', isoDaysFrom(-30)).order('created_at', { ascending: false })),
    must(sb.from('roadmap_reflections').select('member_id, body, updated_at, profiles(name)').gte('updated_at', isoDaysFrom(-7)).order('updated_at', { ascending: false })),
    must(sb.from('rounds').select('id, member_id, played_on, created_at, score, holes, course_name').eq('holes', 18)),
    sb.from('admin_acks').select('ref_id').eq('kind', 'celebration').then((r) => r.data || []), // 設定前でも動くように
    must(sb.from('lessons').select('id, member_id, title, created_at, profiles(name)').is('read_at', null).lte('created_at', isoDaysFrom(-UNREAD_DAYS)).gte('created_at', isoDaysFrom(-60)).order('created_at')),
  ]);
  const people = members.filter((m) => m.role !== 'admin');
  const active = people.filter(isActive);
  const nameOf = (id) => people.find((m) => m.id === id)?.name || '（名前未設定）';
  const now = Date.now();
  const lateMeetings = meetings.filter((m) => m.status === 'scheduled' && new Date(m.scheduled_at).getTime() + (m.duration_min || 25) * 60000 < now);
  const upcoming = meetings.filter((m) => m.status === 'scheduled' && new Date(m.scheduled_at).getTime() >= now - 30 * 60000 && new Date(m.scheduled_at).getTime() < now + 7 * DAY);
  const todayMeetings = upcoming.filter((m) => new Date(m.scheduled_at).toDateString() === new Date().toDateString());
  const monthFrom = new Date(monthStartIso()).getTime();
  const metThisMonth = new Set(meetings.filter((m) => ['scheduled', 'done'].includes(m.status) && new Date(m.scheduled_at).getTime() >= monthFrom).map((m) => m.member_id));
  const needMeeting = active.filter((m) => m.plan === 'SUBSCRIPTION' && !metThisMonth.has(m.id));
  const withRoadmap = new Set(rmAll.map((r) => r.member_id));
  const noRoadmap = active.filter((m) => !withRoadmap.has(m.id));
  const soonExpire = people.filter((m) => m.access_until && m.access_until >= today() && m.access_until <= isoDaysFrom(14).slice(0, 10));
  const pastDue = people.filter((m) => m.subscription_status === 'past_due');
  const newcomers = people.filter((m) => !isActive(m) && daysAgo(m.created_at) <= 30);
  const moved = new Set([...subs30.map((x) => x.member_id), ...practice30.map((x) => x.member_id), ...rounds30.map((x) => x.member_id)]);
  const quiet = active.filter((m) => !moved.has(m.id) && daysAgo(m.created_at) > 14);
  const oldestWait = pending.length ? daysAgo(pending[0].created_at) : 0;
  const overdue = pending.filter((x) => replyDue(x.created_at).over);
  const celebrations = findCelebrations(rounds18, people, new Set(acks.map((a) => a.ref_id)));
  const todo = pending.length + lateMeetings.length + needMeeting.length + rmSoon.length + pastDue.length + soonExpire.length;
  state.adminTodo = todo;

  // kind: todo=対応が必要（赤・「対応が必要」の数に含む） / watch=様子を見る（黄） / info=お知らせ（青）
  const section = (title, icon, list, empty, more = '', kind = 'todo') => `<section class="card dash-sec ${kind}${list.length ? ' has' : ''}">
      <div class="dash-h"><span class="dash-i" aria-hidden="true">${icon}</span><b>${title}</b><span class="dash-n">${list.length}</span>${more}</div>
      ${list.length ? `<div class="dash-list">${list.join('')}</div>` : `<p class="dash-ok">✓ ${empty}</p>`}
    </section>`;
  const row = (main, sub = '', right = '') => `<div class="dash-row"><div class="grow">${main}${sub ? `<small>${sub}</small>` : ''}</div>${right}</div>`;
  const left = [
    section('確認待ちの提出動画', '▶', pending.map((x) => row(`${memberLink(x.member_id, x.profiles?.name)}　${esc(x.club)} / ${esc(x.angle)}`,
      `${fmtDate(x.created_at)} 提出・<b class="${replyDue(x.created_at).cls}">${replyDue(x.created_at).text}</b>`,
      `<a class="btn btn-sm" href="#/admin/lesson/new/s/${x.id}">レッスンを書く</a>`)), '確認待ちの動画はありません', '<a class="dash-more" href="#/admin/inbox">一覧 ›</a>'),
    section('面談：結果の入力待ち', '!', lateMeetings.map((m) => row(`${memberLink(m.member_id, m.profiles?.name)}`, `${fmtShort(m.scheduled_at)} の面談`,
      `<button type="button" class="btn btn-sm" data-action="meeting-done" data-id="${m.id}">結果を入力</button>`)), '入力待ちの面談はありません'),
    section('今後7日の面談', '◷', upcoming.map((m) => row(`<b>${fmtShort(m.scheduled_at)}</b>　${memberLink(m.member_id, m.profiles?.name)}`, `${m.duration_min}分${todayMeetings.includes(m) ? '・<b class="today">今日</b>' : ''}`,
      `<a class="btn btn-sm btn-sub" href="#/admin/prep/${m.id}">準備メモ</a>`)), '予定はありません', '<a class="dash-more" href="#/admin/meetings">面談管理 ›</a>', 'info'),
    section('今月まだ面談の予定がない会員', '◎', needMeeting.map((m) => row(memberLink(m.id, m.name), 'サブスクリプション制（月1回）',
      `<button type="button" class="btn btn-sm btn-sub" data-action="meeting-add" data-member="${m.id}">予約を入れる</button>`)), '全員、今月の面談が入っています'),
  ];
  const right = [
    section('ロードマップ：ドリル未定（2週間以内に公開）', '◎', rmSoon.map((r) => row(memberLink(r.member_id, r.profiles?.name), `${fmtDate(r.publish_on)} 公開・${esc(r.theme || 'テーマ未定')}`,
      `<a class="btn btn-sm btn-sub" href="#/admin/roadmap/${r.member_id}">編集</a>`)), 'ドリル未定の月はありません'),
    section('ロードマップ未作成の契約中会員', '+', noRoadmap.map((m) => row(memberLink(m.id, m.name), `${esc(planLabel(m.plan))}・登録 ${fmtDate(m.created_at)}`)), '全員作成済みです', '', 'watch'),
    section('契約・支払い', '¥', [
      ...pastDue.map((m) => row(memberLink(m.id, m.name), '<b class="late">支払い遅延</b>')),
      ...soonExpire.map((m) => row(memberLink(m.id, m.name), `利用期限 ${fmtDate(m.access_until)}（あと${Math.max(0, Math.ceil((new Date(m.access_until) - today0) / DAY))}日）`)),
    ], '支払い遅延・期限切れ間近の会員はいません'),
    section('新規登録（未契約・30日以内）', '☆', newcomers.map((m) => row(memberLink(m.id, m.name), `${esc(m.email)}・${fmtDate(m.created_at)} 登録`)), '新しい登録はありません', '', 'info'),
    section(`レッスンを見ていない会員（${UNREAD_DAYS}日以上）`, '✉', unread.map((l) => row(memberLink(l.member_id, l.profiles?.name), `「${esc(l.title)}」${fmtDate(l.created_at)} 送付・${daysAgo(l.created_at)}日未読`)), '送ったレッスンはすべて見られています', '', 'watch'),
    section('30日間動きがない契約中会員', '…', quiet.map((m) => row(memberLink(m.id, m.name), '動画提出・練習記録・スコア記録がありません')), '全員、何かしら動きがあります', '', 'watch'),
  ];
  // お祝いは一番下に表示する
  const celebrateSec = section('お祝い（ベスト更新・好スコア）', '★', celebrations.map((c) => row(`${memberLink(c.r.member_id, c.name)}　<b class="score-big">${c.r.score}</b>`,
      `${c.tags.map(([k, t]) => `<span class="cele ${k}">${esc(t)}</span>`).join('')}<br>${fmtDate(c.r.played_on)} ${esc(c.r.course_name)}`,
      `<button type="button" class="btn btn-sm btn-gold" data-action="celebrate-done" data-id="${c.r.id}" data-member="${c.r.member_id}" data-label="${esc(`${c.name || ''}さん ${c.r.score}（${c.tags.map((t) => t[1]).join('・')}）`)}">お祝い済み</button>`)), '新しいお祝いはありません', '', 'celebrate');
  const feed = [
    ...refs7.map((x) => ({ t: x.updated_at, html: `💬 ${memberLink(x.member_id, x.profiles?.name)} がふり返りを書きました<small>${esc(x.body.slice(0, 60))}</small>` })),
    ...rounds30.filter((x) => daysAgo(x.created_at) <= 7).map((x) => ({ t: x.created_at, html: `⛳ ${memberLink(x.member_id, x.profiles?.name)} がスコアを記録：<b>${x.score}</b><small>${fmtDate(x.played_on)} ${esc(x.course_name)}</small>` })),
    ...people.filter((m) => daysAgo(m.created_at) <= 7).map((m) => ({ t: m.created_at, html: `☆ ${memberLink(m.id, m.name)} が新規登録しました` })),
  ].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 12);

  return header('やること') + `<div class="content wide">
    <div class="kpis">
      <a class="kpi${pending.length ? ' alert' : ''}" href="#/admin/inbox"><span>確認待ちの動画</span><b>${pending.length}</b><small>${overdue.length ? `<b class="late">返信目標（${REPLY_TARGET_H}時間）超過 ${overdue.length}件</b>` : pending.length ? `いちばん古いもの ${oldestWait}日前` : 'なし'}</small></a>
      <a class="kpi" href="#/admin/meetings"><span>今日の面談</span><b>${todayMeetings.length}</b><small>今後7日で ${upcoming.length}件</small></a>
      <div class="kpi${todo ? ' alert' : ''}"><span>対応が必要</span><b>${todo}</b><small>下の一覧で確認</small></div>
      <a class="kpi" href="#/admin/members"><span>契約中の会員</span><b>${active.length}</b><small>登録 ${people.length}名</small></a>
    </div>
    <div class="dash-top"><p class="dash-legend"><span class="lg todo">対応が必要</span><span class="lg watch">様子を見る</span><span class="lg info">お知らせ</span><span class="lg celebrate">お祝い</span></p>
      <span class="dash-links"><a class="btn btn-sm btn-sub" href="#/admin/templates">✎ テンプレート</a><a class="btn btn-sm btn-sub" href="#/admin/report">📊 月のまとめ</a></span></div>
    <div class="cols">
      <div class="col-main">${left.map((h, i) => `<div class="blk" style="--o:${i}">${h}</div>`).join('')}</div>
      <div class="col-side">${right.map((h, i) => `<div class="blk" style="--o:${10 + i}">${h}</div>`).join('')}
        <div class="blk" style="--o:20"><section class="card dash-sec"><div class="dash-h"><span class="dash-i" aria-hidden="true">↻</span><b>最近の動き（7日）</b></div>
          ${feed.length ? `<div class="dash-list">${feed.map((f) => `<div class="dash-row feed"><div class="grow">${f.html}</div><span class="muted small">${fmtShort(f.t)}</span></div>`).join('')}</div>` : '<p class="dash-ok">まだ動きはありません</p>'}</section></div>
        <div class="blk" style="--o:30">${celebrateSec}</div>
      </div>
    </div>
  </div>` + adminNav('admin/dashboard');
}

// 面談の管理
async function viewMeetings() {
  const tab = state.meetingTab;
  const [list, members] = await Promise.all([
    must(sb.from('meetings').select('id, member_id, scheduled_at, duration_min, status, summary, profiles(name)').gte('scheduled_at', isoDaysFrom(-120)).order('scheduled_at')),
    must(sb.from('profiles').select('id, name, role, plan, subscription_status, access_until').neq('role', 'admin').order('name')),
  ]);
  meetingMembers = members;
  const now = Date.now();
  const late = list.filter((m) => m.status === 'scheduled' && new Date(m.scheduled_at).getTime() + (m.duration_min || 25) * 60000 < now);
  const upcoming = list.filter((m) => m.status === 'scheduled' && !late.includes(m));
  const past = list.filter((m) => m.status !== 'scheduled').reverse();
  const shown = { upcoming, late, past }[tab] || upcoming;
  // 日付ごとにまとめる
  let day = '';
  const rows = shown.map((m) => {
    const d = new Date(m.scheduled_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const head = d !== day ? `<h3 class="month">${d}</h3>` : '';
    day = d;
    const t = new Date(m.scheduled_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const actions = m.status === 'scheduled'
      ? `<a class="btn btn-sm btn-gold" href="#/admin/prep/${m.id}">準備メモ</a>
         <button type="button" class="btn btn-sm" data-action="meeting-done" data-id="${m.id}">結果を入力</button>
         <button type="button" class="btn btn-sm btn-sub" data-action="meeting-move" data-id="${m.id}" data-at="${m.scheduled_at}" data-min="${m.duration_min}">日時変更</button>
         <button type="button" class="btn btn-sm btn-sub" data-action="meeting-status" data-id="${m.id}" data-status="canceled">キャンセル</button>`
      : `<button type="button" class="btn btn-sm btn-sub" data-action="meeting-done" data-id="${m.id}">まとめを編集</button>`;
    return `${head}<div class="card meeting-row">
      <div class="mt-time"><b>${t}</b><small>${m.duration_min}分</small></div>
      <div class="grow"><div>${memberLink(m.member_id, m.profiles?.name)} ${meetingPill(m)}</div>
        ${m.summary ? `<p class="mt-sum">${esc(m.summary)}</p>` : ''}
        <div class="mt-actions">${actions}</div></div>
    </div>`;
  }).join('');
  const tabBtn = (k, label, n) => `<button type="button" data-action="meeting-tab" data-tab="${k}" class="${tab === k ? 'on' : ''}" aria-pressed="${tab === k}">${label}${n ? `<em>${n}</em>` : ''}</button>`;
  return header('面談') + `<div class="content wide">
    <div class="between" style="flex-wrap:wrap;gap:10px">
      <div class="filter-chips" role="group" aria-label="表示する面談">${tabBtn('upcoming', 'これから', upcoming.length)}${tabBtn('late', '結果入力待ち', late.length)}${tabBtn('past', '過去', 0)}</div>
      <button type="button" class="btn btn-gold btn-sm" data-action="meeting-add">＋ 面談を予約</button>
    </div>
    <p class="muted small">面談の予約はLINEで日程を決めてから、ここに登録します。登録すると会員の「次回の面談」に表示され、前日にお知らせメールが届きます（メール設定後）。</p>
    ${rows ? `<div class="meeting-list">${rows}</div>` : `<div class="empty">${tab === 'late' ? '結果の入力待ちはありません 🎉' : tab === 'past' ? '過去の面談はまだありません' : 'これからの面談はありません'}</div>`}
  </div>` + adminNav('admin/meetings');
}
let meetingMembers = [];
async function meetingMemberOptions(selected) {
  if (!meetingMembers.length || !('email' in meetingMembers[0])) meetingMembers = await must(sb.from('profiles').select('id, name, email, role, plan, subscription_status, access_until').neq('role', 'admin').order('name'));
  return memberOptionsHtml(meetingMembers, selected);
}
// 会員の選択肢（契約中／未契約に分ける）。q を渡すと名前・メールで絞り込む
function memberOptionsHtml(list, selected, q = '') {
  const key = q.trim().toLowerCase();
  const hit = key ? list.filter((m) => `${m.name || ''} ${m.email || ''}`.toLowerCase().includes(key)) : list;
  if (key && !hit.length) return '<option value="">見つかりません</option>';
  const act = hit.filter(isActive);
  const rest = hit.filter((m) => !isActive(m));
  const sel = selected && hit.some((m) => m.id === selected) ? selected : key && hit.length === 1 ? hit[0].id : '';
  const opt = (m) => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${esc(m.name || '（名前未設定）')}</option>`;
  return `<option value="">${key ? `会員を選ぶ（${hit.length}件）` : '会員を選ぶ'}</option>${act.length ? `<optgroup label="契約中">${act.map(opt).join('')}</optgroup>` : ''}${rest.length ? `<optgroup label="未契約">${rest.map(opt).join('')}</optgroup>` : ''}`;
}
const splitLocal = (iso) => { const v = toLocalInput(iso); return [v.slice(0, 10), v.slice(11, 16)]; };


// 会員詳細に出すロードマップの流れ（確認用）
function adminRoadmapSummary(items, extra = {}) {
  const done = items.filter(rmOpen).length;
  const { practice = [], reflections = [], goal = '' } = extra;
  const days = (id) => practice.filter((x) => x.item_id === id).length;
  const ref = (id) => reflections.find((x) => x.item_id === id)?.body;
  return `${goal ? `<p class="rm-goal-top" style="margin-top:0">🏁 ゴール：<b>${esc(goal)}</b></p>` : '<p class="muted small" style="margin-top:0">ゴール未設定（「編集する」から設定できます）</p>'}
    <div class="between small"><span>${done}/${items.length}か月 公開済み</span><span class="muted">次回：${(() => { const n = items.find((r) => !rmOpen(r) && !r.hidden); return n ? fmtDate(n.publish_on) : '—'; })()}</span></div>
    <div class="meter"><i style="width:${Math.round((done / items.length) * 100)}%"></i></div>
    <ol class="rm-mini">${items.map((r, i) => `<li class="${rmOpen(r) ? 'open' : ''}">
      <span class="n">${i + 1}</span>
      <span class="grow"><b>${esc(r.theme || '（テーマ未定）')}</b><small>${fmtDate(r.publish_on)}・${r.drills ? esc(r.drills.title) : '<em>ドリル未定</em>'}${rmOpen(r) ? `・練習 ${days(r.id)}日${r.seen_at ? '' : '・<em>未読</em>'}` : ''}</small>
        ${ref(r.id) ? `<span class="rm-ref">💬 ${esc(ref(r.id))}</span>` : ''}</span>
      <span class="rm-act"><span class="pill ${rmOpen(r) ? 'ok' : r.hidden ? 'warn' : ''}">${rmOpen(r) ? '公開済み' : r.hidden ? '取り消し中' : '予定'}</span>
        ${rmOpen(r) ? `<button type="button" class="btn-sm btn-danger" data-action="rm-unpublish" data-id="${r.id}" data-title="${esc(r.theme || `${i + 1}か月目`)}">取り消す</button>`
          : r.hidden ? `<button type="button" class="btn-sm btn-sub" data-action="rm-republish" data-id="${r.id}" data-date="${r.publish_on}">再公開</button>` : ''}</span></li>`).join('')}</ol>`;
}

// ロードマップの編集（保存するまで画面の中だけで変更できる）
let rmLibrary = [];
function rmPreview(date, theme, drill) {
  return `${date ? fmtDate(date) : '公開日未定'}・${esc(theme || 'テーマ未定')}${drill ? '' : '・<em>ドリル未定</em>'}`;
}
function rmRow(r, i, expand = false) {
  const open = r.id && rmOpen(r);
  return `<details class="rm-edit" data-row data-id="${esc(r.id || '')}"${expand ? ' open' : ''}>
    <summary class="rm-edit-head"><b class="rm-no">${i + 1}か月目</b>
      <span class="pill ${open ? 'ok' : r.hidden ? 'warn' : ''}">${open ? '公開済み' : r.hidden ? '取り消し中' : r.id ? '予定' : '新規'}</span>
      <span class="rm-tools">
        <button type="button" class="btn-sm btn-sub" data-action="rm-move" data-dir="-1" aria-label="上の月と入れ替える">↑</button>
        <button type="button" class="btn-sm btn-sub" data-action="rm-move" data-dir="1" aria-label="下の月と入れ替える">↓</button>
        <button type="button" class="btn-sm btn-danger" data-action="rm-remove">削除</button>
      </span>
      <span class="rm-prev">${rmPreview(r.publish_on, r.theme, r.drill_id)}</span></summary>
    <div class="grid">
      <div><label>公開日</label><input type="date" name="publish_on" value="${esc(r.publish_on)}" required></div>
      <div><label>ドリル</label><select name="drill_id"><option value="">（未定）</option>${rmLibrary.map((d) => `<option value="${d.id}"${d.id === r.drill_id ? ' selected' : ''}>${esc(d.title)}</option>`).join('')}</select></div>
    </div>
    <label>テーマ・目標</label><input name="theme" maxlength="100" value="${esc(r.theme || '')}" placeholder="例：アドレスと前傾角度を安定させる">
    <label>会員へのひとこと（任意）</label><textarea name="note" rows="2" maxlength="1000" placeholder="例：今月は毎日5分、鏡の前で確認しましょう">${esc(r.note || '')}</textarea>
    <div class="rm-edit-foot">
      <button type="button" class="link" data-action="rm-shift">この月から後ろを1か月ずらす</button>
      ${open ? '<label class="switch small"><input type="checkbox" name="unpublish"><span>公開を取り消す（会員に見えなくする）</span></label>'
        : r.hidden ? '<label class="switch small"><input type="checkbox" name="republish"><span>取り消しをやめて、再び公開する</span></label>'
        : r.id ? '<label class="switch small"><input type="checkbox" name="publish_now"><span>公開日を待たずに今すぐ公開する</span></label>' : ''}
    </div>
  </details>`;
}
// 折りたたんだ見出しの内容を、入力に合わせて更新する
function rmRefresh(row) {
  const v = (n) => row.querySelector(`[name="${n}"]`).value;
  row.querySelector('.rm-prev').innerHTML = rmPreview(v('publish_on'), v('theme').trim(), v('drill_id'));
}
async function viewRoadmapEdit(memberId) {
  const [m, items, library, goals] = await Promise.all([
    must(sb.from('profiles').select('id, name, goal').eq('id', memberId).maybeSingle()),
    must(sb.from('roadmap_items').select('*').eq('member_id', memberId).order('publish_on')),
    must(sb.from('drills').select('id, title').order('title')),
    must(sb.from('roadmap_goals').select('goal').eq('member_id', memberId)),
  ]);
  rmLibrary = library;
  const back = `admin/member/${memberId}`;
  if (!m) return header('ロードマップ', back) + '<div class="content"><div class="empty">会員が見つかりません</div></div>';
  return header(`ロードマップ：${m.name || ''}`, back) + `<div class="content">
    <p class="muted small" style="margin:0 0 8px">公開日になると、その月のドリルが会員ページに自動で公開されます。変更は「保存する」を押すまで反映されません。</p>
    ${library.length ? '' : '<div class="notice">ドリル集にドリルがありません。先に<a href="#/admin/drills">ドリル集</a>で登録すると、ここで選べます。</div>'}
    <form class="form" data-form="roadmap" data-member="${esc(memberId)}" data-deleted="">
      <div class="card" style="margin-top:0"><label for="rm-goal" style="margin-top:0">ロードマップのゴール</label>
        <input id="rm-goal" name="goal" maxlength="100" value="${esc(goals[0]?.goal ?? '')}" placeholder="${esc(m.goal ? `例：${m.goal}` : '例：12か月後に90切り')}">
        <p class="muted small" style="margin:4px 0 0">会員のロードマップの一番上と最後に表示されます。空欄のときは会員情報の「目標」を表示します。</p></div>
      <p class="muted small" style="margin:0 0 8px">各月を押すと開いて編集できます。</p>
      <div id="rm-rows">${(() => { const next = items.findIndex((r) => !rmOpen(r)); return items.map((r, i) => rmRow(r, i, i === next)).join(''); })()}</div>
      <button type="button" class="btn-block btn-sub" data-action="rm-add">＋ 1か月追加</button>
      <div class="rm-save"><span id="rm-dirty" class="small hidden">未保存の変更があります</span>
        <button class="btn-block btn-gold" type="submit">保存する</button></div>
    </form>
  </div>` + adminNav('admin/members');
}
function rmRenumber() {
  document.querySelectorAll('#rm-rows [data-row]').forEach((row, i) => { row.querySelector('.rm-no').textContent = `${i + 1}か月目`; });
}
function rmDirty() { document.getElementById('rm-dirty')?.classList.remove('hidden'); }

// ドリル集（何人の会員にも使い回せる）
async function viewDrills() {
  const [drills, links] = await Promise.all([
    must(sb.from('drills').select('*').order('created_at', { ascending: false })),
    must(sb.from('lesson_drills').select('drill_id')),
  ]);
  const used = links.reduce((m, x) => m.set(x.drill_id, (m.get(x.drill_id) || 0) + 1), new Map());
  return header('ドリル集') + `<div class="content">
    <p class="muted small" style="margin:0 0 8px">ここに登録したドリルは、レッスン作成画面の「ドリル動画」の欄にチェックで選べるようになり、会員に送れます。同じドリルを何人にでも使い回せるので、保存容量を節約できます。</p>
    <details class="card add-drill"${drills.length ? '' : ' open'}><summary><b>＋ 新しいドリルを登録</b></summary>
      <form class="form" data-form="drill-new">${drillFields('nd_')}
        <button class="btn-block" type="submit">ドリルを登録する</button></form>
    </details>
    <div class="section-title"><h2>登録済み（${drills.length}件）</h2></div>
    ${drills.length ? drillFilter(drills) : ''}
    ${drills.map((d) => `<a class="card link drill-row" href="#/admin/drill/${d.id}" ${drillSearchAttrs(d)}>
        <div class="grow"><b>${esc(d.title)}</b>${tagPills(d.tags)}
          <div class="muted small">${d.video_path ? '動画ファイル' : 'YouTube'}・${used.get(d.id) || 0}件のレッスンで使用・${fmtDate(d.created_at)}</div></div>
        <span class="drill-go" aria-hidden="true">›</span>
      </a>`).join('') || '<div class="empty">まだドリルはありません</div>'}
  </div>` + adminNav('admin/drills');
}

// ドリルの詳細：動画・説明・区分の確認と編集、どの会員に使ったか
async function viewDrillDetail(id) {
  const d = await must(sb.from('drills').select('*').eq('id', id).maybeSingle());
  if (!d) return header('ドリル', 'admin/drills') + '<div class="content"><div class="empty">ドリルが見つかりません</div></div>' + adminNav('admin/drills');
  const [urls, links, rms] = await Promise.all([
    signedDrillUrls([d]),
    must(sb.from('lesson_drills').select('lesson_id, lessons(id, title, lesson_date, member_id, profiles(name))').eq('drill_id', id)),
    must(sb.from('roadmap_items').select('id, publish_on, member_id, profiles(name)').eq('drill_id', id).order('publish_on')),
  ]);
  const lessons = links.map((x) => x.lessons).filter(Boolean).sort((a, b) => (a.lesson_date < b.lesson_date ? 1 : -1));
  return header(d.title, 'admin/drills') + `<div class="content wide"><div class="cols"><div class="col-main">
    <div class="card drill-detail">
      ${drillMedia(d, urls)}
      <h2>${esc(d.title)}</h2>
      ${tagPills(d.tags)}
      ${d.description ? `<p class="pre">${esc(d.description)}</p>` : '<p class="muted small">説明はありません</p>'}
      <p class="muted small" style="margin:8px 0 0">${d.video_path ? '動画ファイル' : 'YouTube'}・登録 ${fmtDate(d.created_at)}</p>
    </div>
    <div class="section-title"><h2>使った会員</h2><span class="muted small">レッスン ${lessons.length}件・ロードマップ ${rms.length}件</span></div>
    <div class="card">
      ${lessons.map((l) => `<div class="list-item small"><span>${fmtDate(l.lesson_date)}　${memberLink(l.member_id, l.profiles?.name)}　<a class="muted" href="#/admin/lesson/${l.id}">「${esc(l.title)}」</a></span><span class="pill">レッスン</span></div>`).join('')}
      ${rms.map((r) => `<div class="list-item small"><span>${fmtDate(r.publish_on)}　${memberLink(r.member_id, r.profiles?.name)}</span><span class="pill">ロードマップ</span></div>`).join('')}
      ${lessons.length || rms.length ? '' : '<p class="muted small" style="margin:0">まだ使われていません</p>'}
    </div>
  </div><div class="col-side">
    <form class="card form" data-form="drill-edit" data-id="${d.id}">
      <b>ドリルを編集</b>
      <label for="de-title">ドリル名</label><input id="de-title" name="title" maxlength="100" value="${esc(d.title)}" required>
      <label for="de-desc">説明</label><textarea id="de-desc" name="description" rows="4" maxlength="1000">${esc(d.description || '')}</textarea>
      ${d.video_url ? `<label for="de-url">YouTube のリンク</label><input id="de-url" name="video_url" type="url" value="${esc(d.video_url)}" required>` : '<p class="muted small" style="margin:8px 0 0">動画ファイルを差し替えたいときは、新しいドリルとして登録してください。</p>'}
      <fieldset class="tag-field"><legend>区分（複数選べます）</legend>${tagChecks('tag', d.tags || [])}</fieldset>
      <button class="btn-block" type="submit">保存する</button>
    </form>
    <button class="btn-block btn-danger" data-action="delete-drill" data-id="${d.id}" data-path="${esc(d.video_path || '')}" data-title="${esc(d.title)}" data-used="${lessons.length}">このドリルを削除</button>
  </div></div></div>` + adminNav('admin/drills');
}

async function viewInbox() {
  const subs = await must(sb.from('submissions').select('*, profiles(name, plan)').eq('status', 'pending').order('created_at'));
  const urls = await signedVideoUrls(subs);
  return header('提出動画（確認待ち）') + `<div class="content wide">
    ${subs.length ? `<div class="inbox-list">` + subs.map((s) => `<div class="card">
        <div class="between"><div><b>${esc(s.profiles?.name || '（名前未設定）')}</b> <span class="pill">${esc(planLabel(s.profiles?.plan))}</span></div>
          <span class="muted">${fmtDate(s.created_at)}</span></div>
        <div class="muted">${esc(s.club)} / ${esc(s.angle)}　<b class="due ${replyDue(s.created_at).cls}">${replyDue(s.created_at).text}</b></div>
        ${swingVideo(s, urls)}
        ${s.question ? `<p class="pre">${esc(s.question)}</p>` : ''}
        <div class="row" style="margin-top:10px">
          <a class="btn grow" href="#/admin/lesson/new/s/${s.id}">レッスンを書く</a>
          <button class="btn-sub" data-action="mark-reviewed" data-id="${s.id}">対応済みにする</button>
        </div>
        <a class="muted small" href="#/admin/member/${s.member_id}">会員ページを見る</a>
      </div>`).join('') + '</div>' : '<div class="empty">確認待ちの動画はありません 🎉</div>'}
  </div>` + adminNav('admin/inbox');
}

async function viewMembers() {
  const [members, pend, mtgs] = await Promise.all([
    must(sb.from('profiles').select('id, name, email, plan, role, subscription_status, access_until, next_meeting_at').order('created_at', { ascending: false })),
    must(sb.from('submissions').select('member_id').eq('status', 'pending')),
    must(sb.from('meetings').select('member_id, status').gte('scheduled_at', monthStart()).in('status', ['scheduled', 'done'])),
  ]);
  const pendBy = pend.reduce((a, x) => a.set(x.member_id, (a.get(x.member_id) || 0) + 1), new Map());
  const metBy = new Set(mtgs.map((x) => x.member_id));
  const flags = (m) => {
    if (m.role === 'admin') return '';
    const f = [];
    if (pendBy.get(m.id)) f.push(`<span class="flag red">動画 ${pendBy.get(m.id)}件 確認待ち</span>`);
    if (isActive(m) && m.plan === 'SUBSCRIPTION' && !metBy.has(m.id)) f.push('<span class="flag yellow">今月の面談 未予約</span>');
    if (m.next_meeting_at && new Date(m.next_meeting_at).getTime() > Date.now()) f.push(`<span class="flag">面談 ${fmtShort(m.next_meeting_at)}</span>`);
    if (m.access_until && m.access_until >= today() && m.access_until <= isoDaysFrom(14).slice(0, 10)) f.push(`<span class="flag yellow">期限 ${fmtDate(m.access_until)}</span>`);
    if (m.subscription_status === 'past_due') f.push('<span class="flag red">支払い遅延</span>');
    if (!isActive(m) && daysAgo(m.created_at) <= 30) f.push('<span class="flag blue">新規登録</span>');
    return f.length ? `<div class="flags">${f.join('')}</div>` : '';
  };
  return header('会員一覧') + `<div class="content wide">
    <div class="form"><input type="search" id="member-search" placeholder="名前・メールで検索" data-action="filter-members"></div>
    <p class="muted">${members.filter((m) => isActive(m)).length} 名が契約中 / 全 ${members.length} 名</p>
    <div id="member-list">${members.map((m) => `<a class="card link" href="#/admin/member/${m.id}" data-search="${esc(`${m.name} ${m.email}`.toLowerCase())}">
        <div class="between"><div><b>${esc(m.name || '（名前未設定）')}</b>${m.role === 'admin' ? ' <span class="pill">ADMIN</span>' : ''}
          <div class="muted">${esc(m.email)}</div></div>
          <div style="text-align:right">${m.role === 'admin' ? '' : memberPill(m)}<div class="muted">${esc(planLabel(m.plan))}</div></div></div>
        ${flags(m)}
      </a>`).join('')}</div>
  </div>` + adminNav('admin/members');
}

async function viewMemberDetail(id) {
  const [m, tasks, lessons, subs, monthSubs, roadmap] = await Promise.all([
    must(sb.from('profiles').select('*').eq('id', id).maybeSingle()),
    must(sb.from('tasks').select('*').eq('member_id', id).order('sort_order').order('created_at')),
    must(sb.from('lessons').select('id, lesson_date, title, created_at, read_at').eq('member_id', id).order('lesson_date', { ascending: false }).order('created_at', { ascending: false })),
    must(sb.from('submissions').select('id, created_at, club, angle, status').eq('member_id', id).order('created_at', { ascending: false }).limit(20)),
    must(sb.from('submissions').select('id').eq('member_id', id).gte('created_at', monthStart())),
    must(sb.from('roadmap_items').select('id, publish_on, theme, published_at, hidden, seen_at, drills(title)').eq('member_id', id).order('publish_on')),
  ]);
  const [rmPractice, rmRefs, rmGoals] = roadmap.length ? await Promise.all([
    must(sb.from('roadmap_practice').select('item_id').eq('member_id', id)),
    must(sb.from('roadmap_reflections').select('item_id, body, updated_at').eq('member_id', id)),
    must(sb.from('roadmap_goals').select('goal').eq('member_id', id)),
  ]) : [[], [], []];
  const [mRounds, mMeetings, mNotes, mPractice, karte] = await Promise.all([
    must(sb.from('rounds').select('played_on, course_name, score, holes, created_at').eq('member_id', id).order('played_on', { ascending: false })),
    must(sb.from('meetings').select('id, scheduled_at, duration_min, status, summary').eq('member_id', id).order('scheduled_at', { ascending: false })),
    must(sb.from('staff_notes').select('id, body, pinned, created_at').eq('member_id', id).order('pinned', { ascending: false }).order('created_at', { ascending: false })),
    must(sb.from('roadmap_practice').select('practiced_on').eq('member_id', id).gte('practiced_on', isoDaysFrom(-30).slice(0, 10))),
    sb.from('member_karte').select('*').eq('member_id', id).maybeSingle().then((r) => r.data),
  ]);
  const mst = scoreStats(mRounds, m || {});
  if (!m) return header('会員詳細', 'admin/members') + '<div class="content"><div class="empty">会員が見つかりません</div></div>';
  const self = m.id === state.profile.id;
  return header(m.name || '会員詳細', 'admin/members') + `<div class="content wide"><div class="cols"><div class="col-main">
    <div class="card"><div class="between"><div><b>${esc(m.email)}</b><div class="muted">登録日 ${fmtDate(m.created_at)}</div></div>${memberPill(m)}</div>
      ${m.current_period_end ? `<div class="muted">次回更新日 ${fmtDate(m.current_period_end)}</div>` : ''}</div>

    <form class="card form" data-form="admin-profile" data-id="${m.id}">
      <b>会員情報</b>
      <label for="name">会員名</label><input id="name" name="name" value="${esc(m.name)}" maxlength="50">
      <label for="plan">プラン <span class="muted">（通常は Stripe から自動で反映）</span></label>
      <select id="plan" name="plan"><option value="">—</option>${PLANS.map((pl) => `<option value="${esc(pl.id)}" ${m.plan === pl.id ? 'selected' : ''}>${esc(pl.name)}</option>`).join('')}</select>
      <label for="goal">目標</label><input id="goal" name="goal" value="${esc(m.goal)}" maxlength="50">
      <div class="admin-scores">
        <div><span>ベストスコア</span><b>${esc(mst.best ?? '—')}</b></div>
        <div><span>平均スコア${mst.count ? `（直近${mst.recent}R）` : ''}</span><b>${esc(mst.avg ?? '—')}</b></div>
        <div><span>記録</span><b>${mst.count}<small>R</small></b></div>
      </div>
      ${mRounds.length ? `<details class="admin-rounds"><summary>最近のラウンドを見る</summary>${mRounds.slice(0, 10).map((r) => `<div class="list-item small"><span>${fmtDate(r.played_on)}　${esc(r.course_name)}${r.holes === 9 ? '（9H）' : ''}</span><b>${r.score}</b></div>`).join('')}</details>`
        : '<p class="muted small" style="margin:4px 0 0">スコアは会員がラウンドごとに入力すると、自動で計算されます。</p>'}
      <label for="theme">今月のテーマ</label><input id="theme" name="theme" value="${esc(m.theme)}" maxlength="100">
      <label for="access_until">利用期限 <span class="muted">（LINE・電話で申し込んだ会員用。カード決済の会員は空欄）</span></label>
      <input id="access_until" name="access_until" type="date" value="${esc(m.access_until || '')}">
      <label for="extra_submissions">今月の追加本数 <span class="muted">（LINEで追加の申し込み・お支払いがあった分。来月は自動で0本に戻ります）</span></label>
      <input id="extra_submissions" name="extra_submissions" type="number" min="0" max="20" value="${extraThisMonth(m)}">
      <p class="muted small" style="margin:4px 0 0">今月の提出：${monthSubs.length}本${quotaOf(m) ? ` ／ 送れる本数：${quotaOf(m)}本` : ''}</p>
      ${self ? '' : `<label for="role">権限</label><select id="role" name="role">
        <option value="member" ${m.role === 'member' ? 'selected' : ''}>会員</option>
        <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者（コーチ）</option></select>`}
      <button class="btn-block" type="submit">保存する</button>
    </form>

    ${karteForm(m.id, karte)}

    </div><div class="col-side">
    ${(() => {
      const next = mMeetings.filter((x) => x.status === 'scheduled' && new Date(x.scheduled_at).getTime() > Date.now() - 30 * 60000).at(-1);
      const recent = mMeetings.filter((x) => x !== next).slice(0, 5);
      // 最近の動き（30日）：動画・レッスン・スコア・ふり返り・面談・練習
      const feed = [
        ...subs.filter((x) => daysAgo(x.created_at) <= 30).map((x) => ({ t: x.created_at, h: `▶ 動画を提出（${esc(x.club)} / ${esc(x.angle)}）${x.status === 'pending' ? ' <span class="pill warn">確認待ち</span>' : ''}` })),
        ...lessons.filter((x) => daysAgo(x.lesson_date) <= 30).map((x) => ({ t: x.lesson_date, h: `✎ レッスン「${esc(x.title)}」を送付${x.read_at ? '' : ' <span class="pill mute">未読</span>'}` })),
        ...mRounds.filter((x) => daysAgo(x.played_on) <= 30).map((x) => ({ t: x.played_on, h: `⛳ スコア <b>${x.score}</b>（${esc(x.course_name)}）` })),
        ...rmRefs.filter((x) => daysAgo(x.updated_at) <= 30).map((x) => ({ t: x.updated_at, h: `💬 ふり返り：${esc(x.body.slice(0, 50))}` })),
        ...mMeetings.filter((x) => x.status !== 'scheduled' && daysAgo(x.scheduled_at) <= 30).map((x) => ({ t: x.scheduled_at, h: `◷ 面談 ${meetingPill(x)}` })),
      ].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 10);
      return `<div class="section-title" style="margin-top:0"><h2>面談</h2><button type="button" class="btn btn-sm" data-action="meeting-add" data-member="${m.id}">＋ 予約</button></div>
    <div class="card">
      ${next ? `<div class="next-meeting"><span>次回</span><b>${fmtShort(next.scheduled_at)}</b><small>${next.duration_min}分</small>
          <a class="btn btn-sm btn-gold" href="#/admin/prep/${next.id}">準備メモ</a>
          <button type="button" class="btn btn-sm btn-sub" data-action="meeting-move" data-id="${next.id}" data-at="${next.scheduled_at}" data-min="${next.duration_min}">日時変更</button></div>`
        : '<p class="muted small" style="margin:0">次回の面談は入っていません。LINEで日程が決まったら「＋ 予約」から登録します。</p>'}
      ${recent.length ? `<div class="mt-history">${recent.map((x) => `<div class="list-item small"><div class="grow">${fmtShort(x.scheduled_at)} ${meetingPill(x)}${x.summary ? `<div class="muted">${esc(x.summary.slice(0, 60))}</div>` : ''}</div>
          <button type="button" class="btn btn-sm btn-sub" data-action="meeting-done" data-id="${x.id}">${x.status === 'scheduled' ? '結果' : '編集'}</button></div>`).join('')}</div>` : ''}
    </div>

    <div class="section-title"><h2>担当者メモ</h2><span class="muted small">会員には見えません</span></div>
    <div class="card">
      <form class="form note-form" data-form="staff-note" data-member="${m.id}">
        <textarea name="body" rows="2" maxlength="2000" placeholder="例：10/5 LINEで追加動画1本の申し込み。振込確認済み" aria-label="担当者メモ"></textarea>
        <div class="between"><label class="switch small"><input type="checkbox" name="pinned"><span>上に固定する</span></label>
          <button class="btn-sm" type="submit">メモを残す</button></div>
      </form>
      ${mNotes.map((n) => `<div class="note${n.pinned ? ' pinned' : ''}"><p class="pre">${esc(n.body)}</p>
          <div class="note-foot"><span class="muted small">${n.pinned ? '📌 ' : ''}${fmtShort(n.created_at)}</span>
            <button type="button" class="link" data-action="note-pin" data-id="${n.id}" data-pinned="${n.pinned}">${n.pinned ? '固定を外す' : '固定'}</button>
            <button type="button" class="link" data-action="note-delete" data-id="${n.id}">削除</button></div></div>`).join('') || '<p class="muted small" style="margin:8px 0 0">まだメモはありません</p>'}
    </div>

    <div class="section-title"><h2>最近の動き（30日）</h2><span class="muted small">練習記録 ${new Set(mPractice.map((x) => x.practiced_on)).size}日</span></div>
    <div class="card">${feed.length ? feed.map((f) => `<div class="list-item small feed"><div class="grow">${f.h}</div><span class="muted">${fmtDate(f.t)}</span></div>`).join('') : '<p class="muted small" style="margin:0">30日間、動きがありません</p>'}</div>
    `;
    })()}
    <div class="section-title"><h2>ドリル定期公開</h2>${roadmap.length ? `<a class="btn btn-sm" href="#/admin/roadmap/${m.id}">編集する</a>` : ''}</div>
    <div class="card">${roadmap.length ? adminRoadmapSummary(roadmap, { practice: rmPractice, reflections: rmRefs, goal: rmGoals[0]?.goal }) : `
      <p class="muted small" style="margin:0">初回カウンセリングで決めた内容をもとに、毎月1本ずつ公開するドリルの計画を作ります。あとから自由に変更できます。</p>
      <form class="form" data-form="roadmap-create" data-id="${m.id}">
        <div class="grid">
          <div><label for="rm-start">最初の公開日</label><input id="rm-start" name="start" type="date" value="${today()}" required></div>
          <div><label for="rm-months">月数</label><input id="rm-months" name="months" type="number" min="1" max="36" value="12" required></div>
        </div>
        <button class="btn-block" type="submit">ロードマップを作成する</button>
      </form>`}</div>

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
    <div class="card">${lessons.map((l) => `<div class="list-item"><div class="grow">${fmtDate(l.lesson_date)}　<b>${esc(l.title)}</b>
          ${l.read_at ? `<span class="pill ok">既読 ${fmtMD(l.read_at.slice(0, 10))}</span>` : `<span class="pill ${daysAgo(l.created_at) >= UNREAD_DAYS ? 'warn' : 'mute'}">未読${daysAgo(l.created_at) >= 1 ? `（${daysAgo(l.created_at)}日）` : ''}</span>`}</div>
        <a class="btn btn-sm btn-sub" href="#/admin/lesson/${l.id}">編集</a></div>`).join('') || '<div class="muted">レッスンはまだありません</div>'}</div>

    <div class="section-title"><h2>提出動画</h2></div>
    <div class="card">${subs.map((s) => `<div class="list-item"><div>${fmtDate(s.created_at)}　${esc(s.club)} / ${esc(s.angle)}</div>
        ${s.status === 'pending' ? `<a class="btn btn-sm" href="#/admin/lesson/new/s/${s.id}">レッスンを書く</a>` : '<span class="pill ok">対応済み</span>'}</div>`).join('') || '<div class="muted">提出はまだありません</div>'}</div>
  </div></div>
  </div>` + adminNav('admin/members');
}

// カウンセリングシート（会員には見えない）
const KARTE_FIELDS = [
  ['golf_history', 'ゴルフ歴・ラウンド頻度', '例：歴5年。月1〜2回ラウンド', 500],
  ['practice_env', '練習環境・練習頻度', '例：近所の練習場に週1回。自宅でパター練習', 500],
  ['body_notes', 'ケガ・体の状態', '例：腰痛あり。左手首を以前痛めた', 500],
  ['goals', '目標（具体的に・いつまでに）', '例：来年の春までに90切り。社内コンペで優勝したい', 500],
  ['issues', '悩み・課題', '例：ドライバーのスライス。アプローチのざっくり', 500],
  ['contact_pref', '連絡方法・連絡しやすい時間帯', '例：LINE。平日20時以降', 300],
  ['notes', 'その他', '例：3月は仕事の繁忙期で練習量が落ちる', 2000],
];
function karteForm(memberId, k) {
  k = k || {};
  const filled = KARTE_FIELDS.some(([n]) => k[n]);
  return `<form class="card form karte" data-form="karte" data-member="${memberId}">
    <div class="between"><b>カウンセリングシート</b><span class="muted small">会員には見えません${k.updated_at ? `・${fmtShort(k.updated_at)} 更新` : ''}</span></div>
    ${filled ? '' : '<p class="muted small" style="margin:4px 0 0">初回カウンセリングで聞いた内容を残しておくと、面談の準備メモにも表示されます。</p>'}
    ${KARTE_FIELDS.map(([n, label, ph, max]) => `<label for="k_${n}">${label}</label><textarea id="k_${n}" name="${n}" rows="2" maxlength="${max}" placeholder="${ph}">${esc(k[n] || '')}</textarea>`).join('')}
    <button class="btn-block" type="submit">シートを保存する</button>
  </form>`;
}

// 面談の準備メモ：前回の面談から今日までの動きを1画面にまとめる
async function viewMeetingPrep(id) {
  const mt = await must(sb.from('meetings').select('id, member_id, scheduled_at, duration_min, status, summary').eq('id', id).maybeSingle());
  if (!mt) return header('面談の準備メモ', 'admin/meetings') + '<div class="content"><div class="empty">面談が見つかりません</div></div>' + adminNav('admin/meetings');
  const mid = mt.member_id;
  const [m, prevList, karte, notes, rounds, roadmap, tasks] = await Promise.all([
    must(sb.from('profiles').select('id, name, plan, goal, theme, best_score, avg_score, created_at').eq('id', mid).maybeSingle()),
    must(sb.from('meetings').select('scheduled_at, summary').eq('member_id', mid).eq('status', 'done').lt('scheduled_at', mt.scheduled_at).order('scheduled_at', { ascending: false }).limit(1)),
    must(sb.from('member_karte').select('*').eq('member_id', mid).maybeSingle()),
    must(sb.from('staff_notes').select('body, pinned, created_at').eq('member_id', mid).order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(30)),
    must(sb.from('rounds').select('id, member_id, played_on, created_at, score, holes, course_name').eq('member_id', mid).order('played_on', { ascending: false })),
    must(sb.from('roadmap_items').select('id, publish_on, theme, hidden, drills(title)').eq('member_id', mid).order('publish_on')),
    must(sb.from('tasks').select('title, detail, done').eq('member_id', mid).order('sort_order')),
  ]);
  const prev = prevList[0];
  const since = prev ? prev.scheduled_at : isoDaysFrom(-30);
  const sinceYmd = new Date(since).toLocaleDateString('sv-SE');
  const [subs, lessons, practice, refs] = await Promise.all([
    must(sb.from('submissions').select('created_at, club, angle, status').eq('member_id', mid).gte('created_at', since).order('created_at')),
    must(sb.from('lessons').select('id, title, created_at, read_at').eq('member_id', mid).gte('created_at', since).order('created_at')),
    must(sb.from('roadmap_practice').select('practiced_on').eq('member_id', mid).gte('practiced_on', sinceYmd)),
    must(sb.from('roadmap_reflections').select('body, updated_at').eq('member_id', mid).gte('updated_at', since).order('updated_at', { ascending: false })),
  ]);
  const days = Math.max(1, daysAgo(since));
  const practiceDays = new Set(practice.map((x) => x.practiced_on)).size;
  const periodRounds = rounds.filter((r) => r.played_on >= sinceYmd);
  const st = scoreStats(rounds, m || {});
  const cele = findCelebrations(rounds, [m || { id: mid }], new Set(), days);
  const unread = lessons.filter((l) => !l.read_at);
  const nowItem = roadmap.filter((r) => !r.hidden && r.publish_on <= today()).at(-1);
  const nextItem = roadmap.find((r) => r.publish_on > today());
  const tDone = tasks.filter((t) => t.done).length;
  const periodNotes = notes.filter((n) => n.pinned || n.created_at >= since);

  // 話すことのヒント（データから自動で作る）
  const hints = [];
  if (cele.length) hints.push(['good', `お祝い：${cele.map((c) => `${fmtMD(c.r.played_on)} ${c.r.score}（${c.tags.map((t) => t[1]).join('・')}）`).join('、')}`]);
  if (karte?.body_notes) hints.push(['warn', `体の状態を確認：${karte.body_notes}`]);
  if (unread.length) hints.push(['warn', `まだ見ていないレッスンが${unread.length}件：${unread.map((l) => `「${l.title}」`).join('')}`]);
  if (!practiceDays) hints.push(['warn', 'この期間、練習の記録がありません。練習できているか聞いてみる']);
  else if (practiceDays / days * 7 < 1) hints.push(['', `練習の記録は${days}日間で${practiceDays}日。続けやすい練習方法を一緒に考える`]);
  if (!subs.length) hints.push(['', 'この期間、動画の提出がありません。次の提出を促す']);
  if (tasks.length) hints.push([tDone < tasks.length ? '' : 'good', `今月の課題：${tasks.length}件中 ${tDone}件 完了`]);
  if (nextItem) hints.push([nextItem.drills ? '' : 'warn', nextItem.drills ? `次のドリル（${fmtMD(nextItem.publish_on)} 公開）「${nextItem.drills.title}」を予告する` : `次のドリル（${fmtMD(nextItem.publish_on)} 公開予定）がまだ未定です`]);
  if (karte?.goals || m?.goal) hints.push(['', `目標「${karte?.goals || m.goal}」に対する進み具合を確認する`]);
  if (prev?.summary) hints.push(['', '前回のまとめの内容ができているか確認する']);

  const stat = (label, val, sub = '') => `<div class="prep-stat"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return header('面談の準備メモ', 'admin/meetings') + `<div class="content wide">
    <div class="card prep-head">
      <div class="grow"><div class="muted small">${fmtShort(mt.scheduled_at)}・${mt.duration_min}分 ${meetingPill(mt)}</div>
        <h2>${memberLink(mid, m?.name)} さん</h2>
        <div class="muted small">${esc(planLabel(m?.plan))}${prev ? `・前回の面談 ${fmtShort(prev.scheduled_at)}（${days}日前）` : '・前回の面談の記録なし（直近30日を表示）'}</div></div>
      <div class="prep-actions">
        <button type="button" class="btn btn-sm" data-action="meeting-done" data-id="${mt.id}">${mt.status === 'scheduled' ? '結果を入力' : 'まとめを編集'}</button>
        <button type="button" class="btn btn-sm btn-sub" data-action="print">印刷</button>
      </div>
    </div>
    <div class="cols"><div class="col-main">
      <section class="card"><b>話すことのヒント</b>
        ${hints.length ? `<ul class="prep-hints">${hints.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>` : '<p class="muted small">特にありません</p>'}</section>

      <div class="section-title"><h2>この期間の動き</h2><span class="muted small">${fmtDate(sinceYmd)} 〜 今日（${days}日間）</span></div>
      <div class="prep-stats">
        ${stat('動画の提出', `${subs.length}<small>本</small>`, subs.filter((x) => x.status === 'pending').length ? `確認待ち ${subs.filter((x) => x.status === 'pending').length}本` : '')}
        ${stat('送ったレッスン', `${lessons.length}<small>件</small>`, unread.length ? `未読 ${unread.length}件` : lessons.length ? 'すべて既読' : '')}
        ${stat('練習した日', `${practiceDays}<small>日</small>`, days >= 7 ? `週あたり ${Math.round(practiceDays / days * 7 * 10) / 10}日` : `${days}日間で`)}
        ${stat('ラウンド', `${periodRounds.length}<small>回</small>`, periodRounds.length ? `ベスト ${Math.min(...periodRounds.map((r) => r.score))}` : '')}
      </div>

      <section class="card"><div class="between"><b>スコア</b><span class="muted small">全体：ベスト ${esc(st.best ?? '—')}・平均 ${esc(st.avg ?? '—')}</span></div>
        ${periodRounds.length ? periodRounds.map((r) => { const c = cele.find((x) => x.r.id === r.id); return `<div class="list-item small"><span>${fmtDate(r.played_on)}　${esc(r.course_name)}${r.holes === 9 ? '（9H）' : ''}${c ? c.tags.map(([k, t]) => ` <span class="cele ${k}">${esc(t)}</span>`).join('') : ''}</span><b>${r.score}</b></div>`; }).join('') : '<p class="muted small" style="margin:6px 0 0">この期間のラウンド記録はありません</p>'}</section>

      <section class="card"><b>ドリル・課題</b>
        <div class="list-item small"><span>今のドリル</span><b>${nowItem ? `${esc(nowItem.drills?.title || nowItem.theme || '未定')}` : '—'}</b></div>
        <div class="list-item small"><span>次のドリル</span><b>${nextItem ? `${fmtMD(nextItem.publish_on)} ${esc(nextItem.drills?.title || nextItem.theme || '未定')}` : '—'}</b></div>
        ${tasks.map((t) => `<div class="list-item small"><span>${t.done ? '✅' : '⬜️'} ${esc(t.title)} <span class="muted">${esc(t.detail)}</span></span></div>`).join('')}
        ${refs.length ? `<p class="small" style="margin:10px 0 4px"><b>会員のふり返り</b></p>${refs.map((x) => `<p class="pre small prep-quote">${esc(x.body)}<span class="muted">（${fmtDate(x.updated_at)}）</span></p>`).join('')}` : ''}
      </section>

      <section class="card"><b>この期間の動画とレッスン</b>
        ${[...subs.map((x) => ({ t: x.created_at, h: `▶ 動画（${esc(x.club)} / ${esc(x.angle)}）${x.status === 'pending' ? ' <span class="pill warn">確認待ち</span>' : ''}` })),
          ...lessons.map((x) => ({ t: x.created_at, h: `✎ レッスン「${esc(x.title)}」${x.read_at ? ' <span class="pill ok">既読</span>' : ' <span class="pill mute">未読</span>'}` }))]
          .sort((a, b) => (a.t < b.t ? -1 : 1)).map((f) => `<div class="list-item small"><span>${f.h}</span><span class="muted">${fmtDate(f.t)}</span></div>`).join('') || '<p class="muted small" style="margin:6px 0 0">ありません</p>'}
      </section>
    </div><div class="col-side">
      <div class="section-title" style="margin-top:0"><h2>前回の面談のまとめ</h2></div>
      <div class="card">${prev?.summary ? `<p class="pre" style="margin:0">${esc(prev.summary)}</p>` : '<p class="muted small" style="margin:0">記録がありません</p>'}</div>

      <div class="section-title"><h2>カウンセリングシート</h2><a class="muted small" href="#/admin/member/${mid}">編集 ›</a></div>
      <div class="card">${KARTE_FIELDS.filter(([n]) => karte?.[n]).map(([n, label]) => `<div class="karte-row"><span>${label}</span><p class="pre">${esc(karte[n])}</p></div>`).join('') || '<p class="muted small" style="margin:0">まだ記入されていません</p>'}</div>

      <div class="section-title"><h2>担当者メモ</h2><span class="muted small">固定＋この期間</span></div>
      <div class="card">${periodNotes.map((n) => `<div class="note${n.pinned ? ' pinned' : ''}"><p class="pre">${esc(n.body)}</p><span class="muted small">${n.pinned ? '📌 ' : ''}${fmtShort(n.created_at)}</span></div>`).join('') || '<p class="muted small" style="margin:0">ありません</p>'}</div>
    </div></div>
  </div>` + adminNav('admin/meetings');
}

// レッスン文のテンプレート
const TPL_FIELDS = { point: '今回の診断（ポイント）', feedback: 'フィードバック', practice: '次回までの練習' };
let lessonTemplates = [];
const tplPicker = (field) => {
  const items = lessonTemplates.filter((t) => t.field === field);
  return `<div class="tpl-bar" data-tpl-bar="${field}">
    ${items.length ? `<select data-tpl-for="${field}" aria-label="${TPL_FIELDS[field]}のテンプレートから挿入"><option value="">テンプレートから挿入…</option>${items.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select>` : ''}
    <button type="button" class="link" data-action="tpl-save" data-field="${field}">この欄の文をテンプレートに保存</button></div>`;
};
async function viewTemplates() {
  const list = await must(sb.from('lesson_templates').select('*').order('title'));
  return header('レッスン文のテンプレート', 'admin/dashboard') + `<div class="content">
    <p class="muted small">よく使う文を登録しておくと、レッスン作成画面の各欄にある「テンプレートから挿入」で選ぶだけで入力できます。挿入したあとに、会員に合わせて書き足してください。</p>
    <form class="card form" data-form="tpl-new">
      <b>新しいテンプレート</b>
      <label for="tpl-field">使う欄</label><select id="tpl-field" name="field">${Object.entries(TPL_FIELDS).map(([k, l]) => `<option value="${k}"${k === 'feedback' ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <label for="tpl-title">名前（選ぶときに表示）</label><input id="tpl-title" name="title" maxlength="50" placeholder="例：前傾キープの基本" required>
      <label for="tpl-body">本文</label><textarea id="tpl-body" name="body" rows="5" maxlength="3000" required></textarea>
      <button class="btn-block" type="submit">登録する</button>
    </form>
    ${Object.entries(TPL_FIELDS).map(([k, l]) => {
      const items = list.filter((t) => t.field === k);
      return `<div class="section-title"><h2>${l}</h2><span class="muted small">${items.length}件</span></div>
      <div class="card">${items.map((t) => `<div class="tpl-item"><div class="grow"><b>${esc(t.title)}</b><p class="pre muted small">${esc(t.body.slice(0, 140))}${t.body.length > 140 ? '…' : ''}</p></div>
        <div class="tpl-actions"><button type="button" class="btn btn-sm btn-sub" data-action="tpl-edit" data-id="${t.id}">編集</button>
          <button type="button" class="btn-sm btn-danger" data-action="tpl-delete" data-id="${t.id}" data-title="${esc(t.title)}">削除</button></div></div>`).join('') || '<p class="muted small" style="margin:0">まだありません</p>'}</div>`;
    }).join('')}
  </div>` + adminNav('admin/dashboard');
}

// 月のまとめ（経営の数字）
async function viewReport(ym) {
  const now = new Date();
  const [y, mo] = /^\d{4}-\d{2}$/.test(ym || '') ? ym.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  const from = new Date(y, mo - 1, 1); const to = new Date(y, mo, 1); const pFrom = new Date(y, mo - 2, 1);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const [people, events, subs, lessons, meetings, practice, rounds] = await Promise.all([
    must(sb.from('profiles').select('id, role, plan, created_at, subscription_status, access_until, best_score, avg_score').neq('role', 'admin')),
    must(sb.from('membership_events').select('member_id, kind, created_at')),
    must(sb.from('submissions').select('created_at, reviewed_at, status').gte('created_at', pFrom.toISOString()).lt('created_at', to.toISOString())),
    must(sb.from('lessons').select('created_at, read_at').gte('created_at', pFrom.toISOString()).lt('created_at', to.toISOString())),
    must(sb.from('meetings').select('member_id, status, scheduled_at').gte('scheduled_at', pFrom.toISOString()).lt('scheduled_at', to.toISOString())),
    must(sb.from('roadmap_practice').select('member_id, practiced_on').gte('practiced_on', pFrom.toLocaleDateString('sv-SE')).lt('practiced_on', to.toLocaleDateString('sv-SE'))),
    must(sb.from('rounds').select('id, member_id, played_on, created_at, score, holes')),
  ]);
  const ms = (iso) => new Date(iso).getTime();
  const subActive = (p) => ['active', 'trialing'].includes(p.subscription_status);
  // 利用期限が切れた会員は、期限の翌日に「終了」したものとして数える
  const expired = people.filter((p) => !subActive(p) && p.access_until && p.access_until < today())
    .map((p) => ({ member_id: p.id, kind: 'stop', created_at: new Date(`${p.access_until}T23:59:59`).toISOString() }));
  const allEvents = [...events, ...expired];
  const activeNow = people.filter(isActive).length;
  const best = findCelebrations(rounds, people, new Set(), Infinity).filter((c) => c.tags.some(([k]) => k === 'best'));
  const calc = (a, b) => {
    const A = a.getTime();
    const inR = (iso) => iso && ms(iso) >= A && ms(iso) < b.getTime();
    const aY = a.toLocaleDateString('sv-SE'); const bY = b.toLocaleDateString('sv-SE');
    const inD = (ymd) => ymd && ymd >= aY && ymd < bY;
    const after = (iso) => ms(iso) >= A;
    const starts = allEvents.filter((e) => e.kind === 'start' && inR(e.created_at));
    const stops = allEvents.filter((e) => e.kind === 'stop' && inR(e.created_at));
    const atStart = activeNow - allEvents.filter((e) => e.kind === 'start' && after(e.created_at)).length + allEvents.filter((e) => e.kind === 'stop' && after(e.created_at)).length;
    const s = subs.filter((x) => inR(x.created_at));
    const replied = s.filter((x) => x.reviewed_at);
    const hrs = replied.map((x) => (ms(x.reviewed_at) - ms(x.created_at)) / 3600000);
    const l = lessons.filter((x) => inR(x.created_at));
    const mt = meetings.filter((x) => inR(x.scheduled_at));
    const done = mt.filter((x) => x.status === 'done').length; const noShow = mt.filter((x) => x.status === 'no_show').length;
    const pr = practice.filter((x) => inD(x.practiced_on));
    const prMembers = new Set(pr.map((x) => x.member_id)).size;
    return {
      starts: starts.length, stops: new Set(stops.map((e) => e.member_id)).size, atStart: Math.max(0, atStart),
      keep: atStart > 0 ? Math.max(0, Math.round((1 - new Set(stops.map((e) => e.member_id)).size / atStart) * 100)) : null,
      signups: people.filter((p) => inR(p.created_at)).length,
      subs: s.length, pending: s.length - replied.length,
      avgReply: hrs.length ? Math.round(hrs.reduce((t, h) => t + h, 0) / hrs.length * 10) / 10 : null,
      inTarget: hrs.length ? Math.round(hrs.filter((h) => h <= REPLY_TARGET_H).length / hrs.length * 100) : null,
      lessons: l.length, readRate: l.length ? Math.round(l.filter((x) => x.read_at).length / l.length * 100) : null,
      done, noShow, canceled: mt.filter((x) => x.status === 'canceled').length,
      meetRate: done + noShow ? Math.round(done / (done + noShow) * 100) : null,
      practiceDays: new Set(pr.map((x) => `${x.member_id}:${x.practiced_on}`)).size, prMembers,
      rounds: rounds.filter((r) => inD(r.played_on)).length,
      bests: best.filter((c) => inD(c.r.played_on)).length,
    };
  };
  const c = calc(from, to); const p = calc(pFrom, from);
  // 前の月との差（better：増えると良い 'up'／減ると良い 'down'）
  const diff = (k, unit = '', better = 'up') => {
    if (c[k] == null || p[k] == null) return '';
    const d = Math.round((c[k] - p[k]) * 10) / 10;
    if (!d) return '<small class="rp-d">前月と同じ</small>';
    const good = (d > 0) === (better === 'up');
    return `<small class="rp-d ${good ? 'up' : 'down'}">前月より ${d > 0 ? '+' : ''}${d}${unit}</small>`;
  };
  const card = (label, val, unit, k, dUnit = unit, better = 'up', note = '') => `<div class="rp-card"><span>${label}</span><b>${val ?? '—'}${val != null ? `<small>${unit}</small>` : ''}</b>${k ? diff(k, dUnit, better) : ''}${note ? `<small class="muted">${note}</small>` : ''}</div>`;
  const prevKey = key(pFrom); const nextKey = key(to);
  const isCurrent = key(from) === key(now);
  return header('月のまとめ', 'admin/dashboard') + `<div class="content wide">
    <div class="rp-month">
      <a class="btn btn-sm btn-sub" href="#/admin/report/${prevKey}" aria-label="前の月">‹ 前の月</a>
      <b>${y}年${mo}月${isCurrent ? '<small>（今日まで）</small>' : ''}</b>
      ${to.getTime() <= Date.now() ? `<a class="btn btn-sm btn-sub" href="#/admin/report/${nextKey}" aria-label="次の月">次の月 ›</a>` : '<span class="rp-sp"></span>'}
    </div>
    <div class="section-title"><h2>会員</h2></div>
    <div class="rp-grid">
      ${card('契約中（今）', activeNow, '名', '', '', 'up')}
      ${card('入会（契約開始）', c.starts, '名', 'starts', '名')}
      ${card('退会・期限切れ', c.stops, '名', 'stops', '名', 'down')}
      ${card('継続率', c.keep, '%', 'keep', 'pt', 'up', c.atStart ? `月初の契約 ${c.atStart}名のうち` : '')}
      ${card('新規登録', c.signups, '名', 'signups', '名')}
    </div>
    <div class="section-title"><h2>動画とレッスン</h2></div>
    <div class="rp-grid">
      ${card('提出された動画', c.subs, '本', 'subs', '本')}
      ${card('平均の返信時間', c.avgReply, '時間', 'avgReply', '時間', 'down')}
      ${card(`${REPLY_TARGET_H}時間以内の返信`, c.inTarget, '%', 'inTarget', 'pt', 'up', c.pending ? `未対応 ${c.pending}本` : '')}
      ${card('送ったレッスン', c.lessons, '件', 'lessons', '件')}
      ${card('レッスンの既読率', c.readRate, '%', 'readRate', 'pt')}
    </div>
    <div class="section-title"><h2>面談</h2></div>
    <div class="rp-grid">
      ${card('実施', c.done, '回', 'done', '回')}
      ${card('欠席', c.noShow, '回', 'noShow', '回', 'down')}
      ${card('キャンセル', c.canceled, '回', 'canceled', '回', 'down')}
      ${card('実施率', c.meetRate, '%', 'meetRate', 'pt', 'up', '実施 ÷（実施＋欠席）')}
    </div>
    <div class="section-title"><h2>練習とスコア</h2></div>
    <div class="rp-grid">
      ${card('練習の記録', c.practiceDays, '日', 'practiceDays', '日', 'up', `記録した会員 ${c.prMembers}名`)}
      ${card('ラウンド', c.rounds, '回', 'rounds', '回')}
      ${card('ベストスコア更新', c.bests, '回', 'bests', '回')}
    </div>
    <p class="muted small" style="margin-top:16px">※ 入会・退会・継続率は、この機能を入れた日（データベースの設定を実行した日）からの記録で計算します。それより前の入会は「登録日」で数えています。${isCurrent ? '今月の数字は今日までの集計です。' : ''}</p>
  </div>` + adminNav('admin/dashboard');
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
  const [member, urls, library, picked, tpls] = await Promise.all([
    must(sb.from('profiles').select('id, name').eq('id', memberId).maybeSingle()),
    signedVideoUrls([submission]),
    must(sb.from('drills').select('*').order('created_at', { ascending: false })),
    lesson.id ? must(sb.from('lesson_drills').select('drill_id').eq('lesson_id', lesson.id)) : [],
    sb.from('lesson_templates').select('id, field, title, body').order('title').then((r) => r.data || []),
  ]);
  lessonTemplates = tpls;
  const pickedIds = new Set(picked.map((x) => x.drill_id));
  const back = `admin/member/${memberId}`;
  return header(lesson.id ? 'レッスン編集' : 'レッスン作成', back) + `<div class="content">
    <div class="between"><div class="muted">会員：<b>${esc(member?.name || '')}</b></div><a class="muted small" href="#/admin/templates">テンプレートを管理 ›</a></div>
    ${submission ? `<div class="card"><b>提出動画</b>（${esc(submission.club)} / ${esc(submission.angle)}）${swingVideo(submission, urls)}
        ${submission.question ? `<p class="pre">${esc(submission.question)}</p>` : ''}</div>` : ''}
    <form class="card form" data-form="lesson" data-id="${esc(lesson.id || '')}" data-member="${esc(memberId)}" data-submission="${esc(submission?.id || '')}">
      <label for="lesson_date">日付</label><input id="lesson_date" name="lesson_date" type="date" value="${esc(lesson.lesson_date)}" required>
      <label for="title">タイトル</label><input id="title" name="title" value="${esc(lesson.title)}" maxlength="100" placeholder="例：ドライバーの右プッシュ" required>
      <label for="point">今回の診断（ポイント）</label><input id="point" name="point" value="${esc(lesson.point)}" maxlength="300" placeholder="例：切り返しで上体が先行している">${tplPicker('point')}
      <label for="feedback">フィードバック</label><textarea id="feedback" name="feedback" rows="7" maxlength="5000">${esc(lesson.feedback)}</textarea>${tplPicker('feedback')}
      <p class="muted small" style="margin:4px 0 0">空行で段落が分かれます。行の先頭に「・」を付けると箇条書きになり、その直前の短い行（例：ポイント）は見出しになります。</p>
      <label for="practice">次回までの練習</label><textarea id="practice" name="practice" rows="4" maxlength="2000" placeholder="① ハーフスイング 20球&#10;② 7I 30球">${esc(lesson.practice)}</textarea>${tplPicker('practice')}
      <label for="video_url">コーチの解説動画（YouTube・任意）</label><input id="video_url" name="video_url" type="url" value="${esc(lesson.video_url || '')}" placeholder="https://youtu.be/...">
      <fieldset class="drill-pick"><legend>ドリル動画（任意）</legend>
        <div class="between small"><span>ドリル集から選ぶ（<b>${library.length}</b>件）</span><span class="drill-count" id="drill-count" aria-live="polite">選択中 <b>${pickedIds.size}</b>件</span></div>
        ${library.length ? `${drillFilter(library)}
        <div class="drill-options">${library.map((d) => `<label class="drill-opt" ${drillSearchAttrs(d)}>
            <input type="checkbox" name="drill" value="${d.id}"${pickedIds.has(d.id) ? ' checked' : ''}>
            <span class="grow"><b>${esc(d.title)}</b>${tagPills(d.tags)}${d.description ? `<small>${esc(d.description.split('\n')[0].slice(0, 40))}</small>` : ''}</span>
            <span class="drill-type">${d.video_path ? '動画' : 'YouTube'}</span></label>`).join('')}</div>`
          : '<p class="muted small">まだドリル集にドリルがありません。下の「新しいドリルを登録して付ける」か、メニューの<a href="#/admin/drills">ドリル集</a>から登録できます。</p>'}
        <details class="add-drill"><summary>＋ 新しいドリルを登録して付ける</summary>${drillFields('ld_')}</details>
      </fieldset>
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
    // パソコンでは下部メニューを左側のサイドメニューにするため、メニューがある画面かどうかを付けておく
    document.body.classList.toggle('with-nav', html.includes('<nav class="nav"'));
    $app.innerHTML = html; window.scrollTo(0, 0);
  };
  try {
    if (!configured) return paint(viewAuth());
    if (state.recovery) return paint(viewRecovery());
    if (!state.session) { state.handoff = await getHandoff(); return paint(viewAuth()); }
    if (!state.profile) await loadProfile();
    rememberEmail();

    const p = state.profile;
    const r = getRoute();
    if (r[0] === 'continue') return paint(viewContinue());
    if (r[0] === 'account') {
      paint(viewAccount());
      if (r[1] === 'clubs') document.getElementById('clubs')?.scrollIntoView({ block: 'start' });
      return;
    }

    if (p.role === 'admin') {
      if (r[0] !== 'admin') return go('admin/dashboard');
      await loadAdminBadges();
      if (r[1] === 'dashboard') return paint(await viewDashboard());
      if (r[1] === 'meetings') return paint(await viewMeetings());
      if (r[1] === 'prep' && r[2]) return paint(await viewMeetingPrep(r[2]));
      if (r[1] === 'report') return paint(await viewReport(r[2]));
      if (r[1] === 'templates') return paint(await viewTemplates());
      if (r[1] === 'members') return paint(await viewMembers());
      if (r[1] === 'drills') return paint(await viewDrills());
      if (r[1] === 'drill' && r[2]) return paint(await viewDrillDetail(r[2]));
      if (r[1] === 'roadmap' && r[2]) return paint(await viewRoadmapEdit(r[2]));
      if (r[1] === 'member' && r[2]) return paint(await viewMemberDetail(r[2]));
      if (r[1] === 'lesson' && r[2]) return paint(await viewLessonForm(r));
      if (r[1] === 'inbox') return paint(await viewInbox());
      return go('admin/dashboard');
    }

    if (!isActive(p)) {
      if (r[0] !== 'plans') return go('plans');
      return paint(viewPlans());
    }
    state.handoff = await getHandoff();
    if (r[0] === 'guide') return paint(viewGuide());
    if (r[0] === 'scores' && isActive(p)) return paint(await viewScores());
    if (r[0] === 'install') return paint(viewInstall());
    if (!p.onboarded_at) return go('guide');
    const [unreadLessons, unreadDrills] = await Promise.all([
      sb.from('lessons').select('id', { count: 'exact', head: true }).eq('member_id', p.id).is('read_at', null),
      sb.from('roadmap_items').select('id', { count: 'exact', head: true }).eq('member_id', p.id).is('seen_at', null).eq('hidden', false)
        .or(`published_at.not.is.null,publish_on.lte.${today()}`),
    ]);
    state.unread = unreadLessons.count || 0;
    state.drillUnread = unreadDrills.count || 0;
    if (r[0] === 'submit') return paint(await viewSubmit());
    if (r[0] === 'history') return paint(await viewHistory());
    if (r[0] === 'drills') {
      paint(await viewMemberDrills());
      // 今月のドリルを、その段のすぐ下に開いておく
      const rm = document.querySelector('.roadmap');
      if (rm) rmLayout(Number(rm.dataset.current));
      return;
    }
    if (r[0] === 'lesson' && r[1]) return paint(await viewLesson(r[1]));
    if (r[0] === 'submission' && r[1]) return paint(await viewSubmission(r[1]));
    if (r[0] !== 'home') return go('home');
    return paint(await viewMemberHome());
  } catch (e) {
    console.error(e);
    // データベースの更新（SQL の実行）がまだのときは、分かりやすく案内する
    const needsSql = ['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205', '42883'].includes(e.code) || /schema cache|does not exist/i.test(e.message || '');
    if (needsSql) {
      return paint(`<div class="content"><div class="error"><b>この画面はまだ準備中です。</b><br>${state.profile?.role === 'admin'
        ? 'データベースの更新が必要です。Supabase の SQL Editor で、supabase/migrations/ の新しい SQL ファイルを実行してください。'
        : '時間をおいてもう一度お試しください。'}<br><span class="muted small">（${esc(e.message)}）</span></div>
        <button data-action="reload">再読み込み</button> <a class="btn btn-sub" href="#/">ホームへ</a></div>`);
    }
    paint(`<div class="content"><div class="error">読み込みに失敗しました：${esc(e.message)}</div>
      <button data-action="reload">再読み込み</button> <button class="btn-sub" data-action="logout">ログアウト</button></div>`);
  }
}

// ---------- 操作 ----------

const actions = {
  'continue-go': () => playCupIn() || go(state.profile?.role === 'admin' ? 'admin/dashboard' : 'home'),
  'switch-account': async () => {
    await sb.auth.signOut();
    state.authTab = 'login'; state.authMessage = '';
    history.replaceState(null, '', `${location.pathname}#/home`);
    render();
  },
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
  'sound-test': () => {
    if (!soundOn()) { toast('効果音をオンにすると鳴らせます'); return; }
    playCupIn();
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
  'plan-detail': (el) => showPlanDetail(PLANS.find((p) => p.id === el.dataset.plan)),
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
  'handoff-clear': async () => {
    await clearHandoff();
    toast('SwingFrame の動画を取り消しました'); render();
  },
  'meeting-tab': (el) => { state.meetingTab = el.dataset.tab; render(); },
  'meeting-add': async (el) => {
    const [d] = splitLocal(new Date(Date.now() + DAY).toISOString());
    const v = await confirmDialog({
      title: '面談を予約',
      body: `<div class="form modal-form">
        <label>会員</label>
        <input type="search" class="member-search" data-member-search placeholder="名前・メールで検索" aria-label="会員を名前・メールで検索" autocomplete="off">
        <select name="member_id" required>${await meetingMemberOptions(el.dataset.member)}</select>
        <div class="grid"><div><label>日付</label><input name="date" type="date" value="${d}" required></div>
          <div><label>時刻</label><input name="time" type="time" value="19:00" step="300" required></div></div>
        <label>時間（分）</label><input name="duration_min" type="number" min="5" max="180" value="25" required>
      </div>`,
      ok: '予約する',
    });
    if (!v) return;
    const at = new Date(`${v.date}T${v.time}`);
    await must(sb.from('meetings').insert({ member_id: v.member_id, scheduled_at: at.toISOString(), duration_min: Number(v.duration_min) || 25 }));
    toast(`${fmtShort(at.toISOString())} に面談を予約しました`); render();
  },
  'meeting-move': async (el) => {
    const [d, t] = splitLocal(el.dataset.at);
    const v = await confirmDialog({
      title: '面談の日時を変更',
      body: `<div class="form modal-form"><div class="grid"><div><label>日付</label><input name="date" type="date" value="${d}" required></div>
        <div><label>時刻</label><input name="time" type="time" value="${t}" step="300" required></div></div>
        <label>時間（分）</label><input name="duration_min" type="number" min="5" max="180" value="${esc(el.dataset.min || 25)}" required></div>`,
      ok: '変更する',
    });
    if (!v) return;
    const at = new Date(`${v.date}T${v.time}`);
    await must(sb.from('meetings').update({ scheduled_at: at.toISOString(), duration_min: Number(v.duration_min) || 25, status: 'scheduled' }).eq('id', el.dataset.id));
    toast(`${fmtShort(at.toISOString())} に変更しました`); render();
  },
  'meeting-status': async (el) => {
    const label = { canceled: 'キャンセル', no_show: '欠席' }[el.dataset.status];
    if (!(await confirmDialog({ title: `この面談を「${label}」にしますか？`, body: '<p>あとから「まとめを編集」で変更できます。</p>', ok: `${label}にする` }))) return;
    await must(sb.from('meetings').update({ status: el.dataset.status }).eq('id', el.dataset.id));
    toast(`${label}にしました`); render();
  },
  'meeting-done': async (el) => {
    const m = await must(sb.from('meetings').select('id, member_id, scheduled_at, status, summary, profiles(name)').eq('id', el.dataset.id).single());
    const v = await confirmDialog({
      title: '面談の結果',
      body: `<p class="muted small" style="margin:0 0 6px">${esc(m.profiles?.name || '')}さん・${fmtShort(m.scheduled_at)}</p>
        <div class="form modal-form">
        <label>結果</label><div class="seg-radio">
          ${[['done', '完了'], ['no_show', '欠席'], ['canceled', 'キャンセル']].map(([k, l]) => `<label><input type="radio" name="status_${m.id}" value="${k}"${(m.status === 'scheduled' ? 'done' : m.status) === k ? ' checked' : ''} data-status-radio><span>${l}</span></label>`).join('')}</div>
        <input type="hidden" name="status" value="${m.status === 'scheduled' ? 'done' : m.status}">
        <label>面談のまとめ <span class="muted">（会員のホームに表示されます）</span></label>
        <textarea name="summary" rows="4" maxlength="2000" placeholder="例：切り返しのタイミングを確認。来月はインパクトの形に取り組む">${esc(m.summary || '')}</textarea>
        <label>担当者メモ <span class="muted">（会員には見えません・任意）</span></label>
        <textarea name="note" rows="2" maxlength="2000" placeholder="例：腰に違和感あり。次回まで様子を見る"></textarea>
      </div>`,
      ok: '保存する',
    });
    if (!v) return;
    await must(sb.from('meetings').update({ status: v.status, summary: v.summary.trim() }).eq('id', m.id));
    if (v.note.trim()) await must(sb.from('staff_notes').insert({ member_id: m.member_id, body: `【面談 ${fmtShort(m.scheduled_at)}】${v.note.trim()}` }));
    toast('面談の結果を保存しました'); render();
  },
  'celebrate-done': async (el) => {
    const v = await confirmDialog({
      title: 'お祝い済みにしますか？',
      body: `<p>${esc(el.dataset.label)}</p><div class="form modal-form"><label>送った内容のメモ <span class="muted">（任意・担当者メモに残ります）</span></label>
        <textarea name="note" rows="2" maxlength="500" placeholder="例：LINEでお祝いメッセージを送った"></textarea></div>`,
      ok: 'お祝い済みにする',
    });
    if (!v) return;
    await must(sb.from('admin_acks').upsert({ kind: 'celebration', ref_id: el.dataset.id }));
    if (v.note.trim()) await must(sb.from('staff_notes').insert({ member_id: el.dataset.member, body: `【お祝い】${el.dataset.label}：${v.note.trim()}` }));
    toast('お祝い済みにしました'); render();
  },
  print: () => window.print(),
  'tpl-save': async (el) => {
    const field = el.dataset.field;
    const box = document.getElementById(field);
    const sel = box.value.slice(box.selectionStart, box.selectionEnd);
    const text = (sel || box.value).trim();
    if (!text) throw new Error('先に欄に文を入力してください（一部を選んでおくと、その部分だけを保存します）');
    const v = await confirmDialog({
      title: 'テンプレートに保存',
      body: `<div class="form modal-form"><label>名前（選ぶときに表示）</label><input name="title" maxlength="50" required placeholder="例：前傾キープの基本">
        <label>本文（${TPL_FIELDS[field]}）</label><textarea name="body" rows="5" maxlength="3000" required>${esc(text)}</textarea></div>`,
      ok: '保存する',
    });
    if (!v) return;
    const row = await must(sb.from('lesson_templates').insert({ field, title: v.title.trim(), body: v.body.trim() }).select('id, field, title, body').single());
    lessonTemplates.push(row);
    document.querySelector(`[data-tpl-bar="${field}"]`).outerHTML = tplPicker(field);
    toast(`テンプレート「${row.title}」を保存しました`);
  },
  'tpl-edit': async (el) => {
    const t = await must(sb.from('lesson_templates').select('*').eq('id', el.dataset.id).single());
    const v = await confirmDialog({
      title: 'テンプレートを編集',
      body: `<div class="form modal-form"><label>使う欄</label><select name="field">${Object.entries(TPL_FIELDS).map(([k, l]) => `<option value="${k}"${k === t.field ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label>名前</label><input name="title" maxlength="50" required value="${esc(t.title)}">
        <label>本文</label><textarea name="body" rows="7" maxlength="3000" required>${esc(t.body)}</textarea></div>`,
      ok: '保存する',
    });
    if (!v) return;
    await must(sb.from('lesson_templates').update({ field: v.field, title: v.title.trim(), body: v.body.trim() }).eq('id', t.id));
    toast('保存しました'); render();
  },
  'tpl-delete': async (el) => {
    if (!(await confirmDialog({ title: 'テンプレートを削除しますか？', body: `<p>「${esc(el.dataset.title)}」</p><p>これまでに送ったレッスンの文は消えません。</p>`, ok: '削除する' }))) return;
    await must(sb.from('lesson_templates').delete().eq('id', el.dataset.id));
    toast('削除しました'); render();
  },
  'note-pin': async (el) => {
    await must(sb.from('staff_notes').update({ pinned: el.dataset.pinned !== 'true' }).eq('id', el.dataset.id));
    render();
  },
  'note-delete': async (el) => {
    if (!(await confirmDialog({ title: 'このメモを削除しますか？', body: '<p>削除すると元に戻せません。</p>', ok: '削除する' }))) return;
    await must(sb.from('staff_notes').delete().eq('id', el.dataset.id));
    toast('メモを削除しました'); render();
  },
  'delete-round': async (el) => {
    const ok = await confirmDialog({ title: 'この記録を削除しますか？', body: `<p>${esc(el.dataset.label)}</p>`, ok: '削除する' });
    if (!ok) return;
    await must(sb.from('rounds').delete().eq('id', el.dataset.id));
    toast('削除しました'); render();
  },
  'rm-unpublish': async (el) => {
    const ok = await confirmDialog({
      title: 'このドリルの公開を取り消しますか？',
      body: `<p><b>${esc(el.dataset.title)}</b></p><p>会員のドリルページから見えなくなります（「公開準備中」と表示されます）。あとで「再公開」で戻せます。</p>`,
      ok: '取り消す',
    });
    if (!ok) return;
    await must(sb.from('roadmap_items').update({ hidden: true, published_at: null, seen_at: null }).eq('id', el.dataset.id));
    toast('公開を取り消しました'); render();
  },
  'rm-republish': async (el) => {
    const future = el.dataset.date > today();
    await must(sb.from('roadmap_items').update({ hidden: false, published_at: future ? null : new Date().toISOString() }).eq('id', el.dataset.id));
    toast(future ? `取り消しをやめました（${fmtMD(el.dataset.date)} に公開されます）` : '再公開しました'); render();
  },
  'rm-open': (el) => {
    const grid = document.getElementById('rm-grid');
    const i = Number(el.dataset.i);
    const next = grid.dataset.open === String(i) ? null : i;
    rmLayout(next);
    if (next != null) document.getElementById(`rm-panel-${i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  'practice-today': async (el) => {
    const item = el.dataset.item;
    const t = today();
    const on = el.getAttribute('aria-pressed') !== 'true';
    el.disabled = true;
    try {
      if (on) await must(sb.from('roadmap_practice').insert({ item_id: item, member_id: state.profile.id, practiced_on: t }));
      else await must(sb.from('roadmap_practice').delete().eq('item_id', item).eq('practiced_on', t));
      const box = el.closest('.practice-log');
      box.querySelector(`[data-day="${t}"]`)?.classList.toggle('on', on);
      box.querySelector('.pl-count').textContent = box.querySelectorAll('.pl-days i.on').length;
      el.setAttribute('aria-pressed', String(on));
      el.textContent = on ? '✓ 今日は練習済み' : '今日練習した';
      el.classList.toggle('btn-gold', !on); el.classList.toggle('btn-sub', on);
      if (on) toast('ナイス練習！記録しました⛳');
    } catch (e) { toast('記録できませんでした', true); }
    el.disabled = false;
  },
  'rm-move': (el) => {
    const row = el.closest('[data-row]');
    const other = Number(el.dataset.dir) < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!other) return;
    // 公開日はそのままにして、テーマ・ドリル・ひとことを入れ替える
    ['theme', 'drill_id', 'note'].forEach((n) => {
      const a = row.querySelector(`[name="${n}"]`); const b = other.querySelector(`[name="${n}"]`);
      [a.value, b.value] = [b.value, a.value];
    });
    rmRefresh(row); rmRefresh(other); rmDirty();
  },
  'rm-shift': (el) => {
    let row = el.closest('[data-row]');
    while (row) {
      const input = row.querySelector('[name="publish_on"]');
      if (input.value) input.value = addMonths(input.value, 1);
      rmRefresh(row);
      row = row.nextElementSibling;
    }
    rmDirty(); toast('この月から後ろの公開日を1か月ずらしました（保存すると反映されます）');
  },
  'rm-remove': (el) => {
    const row = el.closest('[data-row]');
    const f = row.closest('form');
    if (row.dataset.id) f.dataset.deleted = [f.dataset.deleted, row.dataset.id].filter(Boolean).join(',');
    row.remove(); rmRenumber(); rmDirty();
  },
  'rm-add': () => {
    const rows = document.querySelectorAll('#rm-rows [data-row]');
    const last = rows[rows.length - 1]?.querySelector('[name="publish_on"]').value;
    const html = rmRow({ publish_on: last ? addMonths(last, 1) : today(), theme: '', drill_id: null, note: '' }, rows.length, true);
    document.getElementById('rm-rows').insertAdjacentHTML('beforeend', html);
    rmDirty();
  },
  'drill-tag': (el) => {
    el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
    applyDrillFilter();
  },
  'drill-tag-clear': () => {
    const box = document.querySelector('[data-drill-filter]');
    box.querySelector('.drill-search').value = '';
    box.querySelectorAll('.tag-chip').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    applyDrillFilter();
  },
  'delete-drill': async (el) => {
    const used = Number(el.dataset.used);
    const ok = await confirmDialog({
      title: 'このドリルを削除しますか？',
      body: `<p><b>${esc(el.dataset.title)}</b></p><p>${used ? `${used}件のレッスンで使われています。削除すると、会員のドリル一覧からも見られなくなります。` : 'まだどのレッスンにも使われていません。'}</p>`,
      ok: '削除する',
    });
    if (!ok) return;
    if (el.dataset.path) {
      const { error } = await sb.storage.from(DRILL_BUCKET).remove([el.dataset.path]);
      if (error) throw error;
    }
    await must(sb.from('drills').delete().eq('id', el.dataset.id));
    toast('ドリルを削除しました'); go('admin/drills');
  },
  'delete-lesson': async (el) => {
    if (!confirm('このレッスンを削除します。よろしいですか？')) return;
    await must(sb.from('lessons').delete().eq('id', el.dataset.id));
    toast('削除しました'); go(`admin/member/${el.dataset.member}`);
  },
};

const forms = {
  login: async (f) => {
    unlockAudio();
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) throw new Error('メールアドレスまたはパスワードが正しくありません');
    local.set(LAST_EMAIL_KEY, f.email.value.trim());
    playCupIn();
    // 撮影画面から来てログインした場合は、そのままマイページへ
    if (getRoute()[0] === 'continue') history.replaceState(null, '', `${location.pathname}#/home`);
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
    unlockAudio(); // スマホでは、押した瞬間に音の準備をしておかないと後で鳴らせない
    const h = state.handoff;
    const file = f.video.files[0] || (h ? new File([h.blob], h.name || 'swingframe.mp4', { type: h.type || h.blob.type || 'video/mp4' }) : null);
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
    if (h && !f.video.files[0]) await clearHandoff();
    playCupIn();
    toast('⛳ 動画を送信しました。コーチからの解説をお待ちください。');
    go('home');
  },
  'admin-profile': async (f) => {
    const update = {
      name: f.name.value.trim(), plan: f.plan.value || null, goal: f.goal.value.trim(),
      theme: f.theme.value.trim(),
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
  karte: async (f) => {
    const row = { member_id: f.dataset.member, updated_at: new Date().toISOString(), updated_by: state.profile.id };
    KARTE_FIELDS.forEach(([n]) => { row[n] = f.elements[n].value.trim(); });
    await must(sb.from('member_karte').upsert(row));
    toast('カウンセリングシートを保存しました'); render();
  },
  'tpl-new': async (f) => {
    await must(sb.from('lesson_templates').insert({ field: f.field.value, title: f.title.value.trim(), body: f.body.value.trim() }));
    toast('テンプレートを登録しました'); render();
  },
  'staff-note': async (f) => {
    const body = f.body.value.trim();
    if (!body) throw new Error('メモを入力してください');
    await must(sb.from('staff_notes').insert({ member_id: f.dataset.member, body, pinned: f.pinned.checked }));
    toast('メモを残しました'); render();
  },
  round: async (f) => {
    const out = Number(f.out_score.value);
    const inn = f.in_score.value === '' ? null : Number(f.in_score.value);
    const holes = inn == null ? 9 : 18;
    const score = out + (inn ?? 0);
    const odd = (n) => n < 27 || n > 100;
    if ((odd(out) || (inn != null && odd(inn))) && !(await confirmDialog({ title: 'このスコアで記録しますか？', body: `<p>前半 <b>${out}</b>${inn != null ? `・後半 <b>${inn}</b>` : ''} です。入力に間違いがないか確認してください。</p>`, ok: '記録する' }))) return;
    if (holes === 9 && !(await confirmDialog({ title: '9ホールとして記録しますか？', body: '<p>後半が空欄なので、9ホールの記録になります（ベスト・平均の計算には入りません）。</p>', ok: '9ホールで記録' }))) return;
    await must(sb.from('rounds').insert({
      member_id: state.profile.id, played_on: f.played_on.value, course_name: f.course_name.value.trim(), holes, score, out_score: out, in_score: inn,
      putts: f.putts.value === '' ? null : Number(f.putts.value), note: f.note.value.trim(),
    }));
    toast('スコアを記録しました⛳'); render();
  },
  reflection: async (f) => {
    await must(sb.from('roadmap_reflections').upsert({
      item_id: f.dataset.item, member_id: state.profile.id, body: f.body.value.trim(), updated_at: new Date().toISOString(),
    }));
    toast('ふり返りを保存しました');
  },
  'roadmap-create': async (f) => {
    const months = Math.min(36, Math.max(1, Number(f.months.value) || 12));
    const start = f.start.value;
    if (!start) throw new Error('最初の公開日を入力してください');
    await must(sb.from('roadmap_items').insert(Array.from({ length: months }, (_, i) => ({
      member_id: f.dataset.id, publish_on: addMonths(start, i),
    }))));
    toast(`${months}か月分のロードマップを作りました`); go(`admin/roadmap/${f.dataset.id}`);
  },
  roadmap: async (f) => {
    const member_id = f.dataset.member;
    const rows = [...f.querySelectorAll('[data-row]')].map((row) => ({
      id: row.dataset.id,
      publish_on: row.querySelector('[name="publish_on"]').value,
      theme: row.querySelector('[name="theme"]').value.trim(),
      drill_id: row.querySelector('[name="drill_id"]').value || null,
      note: row.querySelector('[name="note"]').value.trim(),
      now: row.querySelector('[name="publish_now"]')?.checked,
      unpublish: row.querySelector('[name="unpublish"]')?.checked,
      republish: row.querySelector('[name="republish"]')?.checked,
    }));
    if (rows.some((r) => !r.publish_on)) throw new Error('すべての月に公開日を入れてください');
    await must(sb.from('roadmap_goals').upsert({ member_id, goal: f.goal.value.trim(), updated_at: new Date().toISOString() }));
    const deleted = (f.dataset.deleted || '').split(',').filter(Boolean);
    if (deleted.length) await must(sb.from('roadmap_items').delete().in('id', deleted));
    await Promise.all(rows.filter((r) => r.id).map((r) => must(sb.from('roadmap_items').update({
      publish_on: r.publish_on, theme: r.theme, drill_id: r.drill_id, note: r.note,
      ...(r.now ? { published_at: new Date().toISOString() } : {}),
      ...(r.unpublish ? { hidden: true, published_at: null, seen_at: null } : {}),
      ...(r.republish ? { hidden: false, published_at: r.publish_on > today() ? null : new Date().toISOString() } : {}),
    }).eq('id', r.id))));
    const added = rows.filter((r) => !r.id).map((r) => ({ member_id, publish_on: r.publish_on, theme: r.theme, drill_id: r.drill_id, note: r.note }));
    if (added.length) await must(sb.from('roadmap_items').insert(added));
    toast('ロードマップを保存しました'); render();
  },
  'drill-edit': async (f) => {
    const row = {
      title: f.title.value.trim(), description: f.description.value.trim(),
      tags: [...f.querySelectorAll('input[name="tag"]:checked')].map((i) => i.value),
    };
    if (!row.title) throw new Error('ドリル名を入力してください');
    if (f.video_url) {
      row.video_url = normalizeYoutube(f.video_url.value);
      if (!row.video_url) throw new Error('YouTube のリンクを入力してください');
    }
    await must(sb.from('drills').update(row).eq('id', f.dataset.id));
    toast('ドリルを保存しました'); render();
  },
  'drill-new': async (f) => {
    await createDrill(drillFromForm(f, 'nd_'), drillProgress('nd_'));
    toast('ドリルを登録しました'); render();
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
    // 新しいドリルが入力されていれば、先にドリル集へ登録しておく
    const drillIds = [...f.querySelectorAll('input[name="drill"]:checked')].map((i) => i.value);
    const nd = drillFromForm(f, 'ld_');
    if (nd.title || nd.file || nd.url) drillIds.push(await createDrill(nd, drillProgress('ld_')));
    const saveDrills = async (lessonId) => {
      await must(sb.from('lesson_drills').delete().eq('lesson_id', lessonId));
      if (drillIds.length) await must(sb.from('lesson_drills').insert(drillIds.map((drill_id, i) => ({ lesson_id: lessonId, drill_id, sort_order: i }))));
    };
    let notice = 'レッスンを保存しました';
    if (f.dataset.id) {
      await must(sb.from('lessons').update(row).eq('id', f.dataset.id));
      await saveDrills(f.dataset.id);
    } else {
      const created = await must(sb.from('lessons').insert({ ...row, member_id: f.dataset.member, submission_id: f.dataset.submission || null }).select('id').single());
      await saveDrills(created.id);
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

let courseTimer;
document.addEventListener('input', (ev) => {
  if (ev.target.dataset.action === 'round-total') {
    const f = ev.target.form;
    const o = f.out_score.value; const i = f.in_score.value;
    const el = document.getElementById('round-total');
    el.textContent = o && i ? Number(o) + Number(i) : '—';
    el.previousElementSibling.textContent = o && !i ? '9H' : '18H';
    if (o && !i) el.textContent = o;
    return;
  }
  if (ev.target.dataset.action === 'course-search') {
    clearTimeout(courseTimer);
    const q = ev.target.value.trim();
    courseTimer = setTimeout(async () => {
      if (!q) return;
      const { data } = await sb.rpc('search_courses', { p_query: q });
      const list = document.getElementById('course-list');
      if (list && data) list.innerHTML = data.map((c) => `<option value="${esc(c.course_name)}"></option>`).join('');
    }, 250);
    return;
  }
  const rmRowEl = ev.target.closest('form[data-form="roadmap"] [data-row]');
  if (rmRowEl) { rmDirty(); rmRefresh(rmRowEl); } else if (ev.target.closest('form[data-form="roadmap"]')) rmDirty();
  if (ev.target.dataset.action === 'filter-drills') { applyDrillFilter(); return; }
  if (ev.target.matches('[data-member-search]')) {
    const sel = ev.target.parentElement.querySelector('select[name="member_id"]');
    sel.innerHTML = memberOptionsHtml(meetingMembers, sel.value, ev.target.value);
    return;
  }
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
  if (ev.target.name === 'sound_toggle') {
    local.set('atg-sound', ev.target.checked ? 'on' : 'off');
    if (ev.target.checked) playCupIn();
    toast(ev.target.checked ? '効果音をオンにしました' : '効果音をオフにしました');
    return;
  }
  if (ev.target.dataset.tplFor) {
    const t = lessonTemplates.find((x) => x.id === ev.target.value);
    const box = document.getElementById(ev.target.dataset.tplFor);
    ev.target.value = '';
    if (!t || !box) return;
    if (box.tagName === 'INPUT') box.value = box.value ? `${box.value} ${t.body}` : t.body;
    else {
      const at = box.selectionEnd ?? box.value.length;
      const before = box.value.slice(0, at);
      const pad = before && !before.endsWith('\n') ? '\n' : '';
      box.setRangeText(pad + t.body, at, at, 'end');
    }
    box.focus();
    return;
  }
  if (ev.target.matches('[data-status-radio]')) {
    ev.target.closest('.modal-form').querySelector('input[name="status"]').value = ev.target.value;
    return;
  }
  if (ev.target.name === 'drill') {
    const n = document.querySelectorAll('input[name="drill"]:checked').length;
    const c = document.getElementById('drill-count');
    if (c) c.innerHTML = `選択中 <b>${n}</b>件`;
    return;
  }
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
