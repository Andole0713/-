// 動画編集（スタッフ用・パソコン向け）
// 撮った動画を読み込んで、カット・つなぐ・スロー・一時停止・テロップ・線・ナレーション・BGM を入れ、
// 1本の mp4 に書き出す。書き出した動画は、そのままドリルの動画として登録できる。
// openEditor({ title }) → 書き出した動画の File（やめたら null）
//
// しくみ
// - 編集内容（プロジェクト）は P に持つ。映像は「区間（seg）」を並べたもの。テロップ・線（ov）とナレーション（nar）は、
//   どの区間の何秒目から出すか（seg と rel）で持つので、区間を並べ替えても一緒に動く。
// - プレビューは <video> を再生しながら canvas に描く。書き出しは1コマずつ動画を送って canvas に描き、WebCodecs で mp4 にする。
// - 編集中の内容は、このパソコンのブラウザ（IndexedDB）に自動で保存される。

const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';
const FPS = 30;
const SANS = '"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
const SERIF = '"Noto Serif JP","Hiragino Mincho ProN","Yu Mincho",serif';
const COLORS = ['#ff3b30', '#ffd60a', '#ffffff', '#0a84ff', '#34c759', '#ff9f0a', '#111111'];
const TOOLS = [
  ['select', '✥', '選ぶ・動かす', 'V'], ['text', 'T', 'テロップ', 'T'], ['line', '／', '直線', 'L'], ['arrow', '↗', '矢印', 'A'],
  ['circle', '◯', '円', 'O'], ['angle', '∠', '角度', 'G'], ['pen', '✎', '手書き', 'P'], ['num', '①', '番号', 'N'],
  ['spot', '◎', 'スポット', 'H'], ['blur', '▦', 'ぼかし', 'B'],
];
const TRANS = [['', 'なし'], ['fade', 'ふわっと'], ['black', '暗転'], ['white', '白く光る']];
const MASKS = ['blur', 'spot']; // 映像に効果をかけるもの（線より先に描く）
const lerp = (a, b, k) => a + (b - a) * k;
const lerpP = (p, q, k) => ({ x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k) });
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const TEXT_STYLES = {
  outline: { label: '白文字＋黒ふち', color: '#ffffff', stroke: '#000000' },
  yellow: { label: '黄色の帯', color: '#111111', bg: '#ffd60a' },
  dark: { label: '黒い帯', color: '#ffffff', bg: 'rgba(0,0,0,.72)' },
  white: { label: '白い帯', color: '#111111', bg: 'rgba(255,255,255,.92)' },
  gold: { label: '金の見出し', color: '#e2cc9a', stroke: '#0b100d', serif: true },
  red: { label: '赤の注意', color: '#ffffff', bg: '#d8392f' },
};
const SPEEDS = [[1, '等速'], [0.5, '½'], [0.25, '¼']];
const BGM_MOODS = [['fresh', 'さわやか'], ['calm', 'おちついた'], ['bright', '元気']];
const DRAFT_KEY = 'project';
const PRESET_KEY = 'atg-ed-presets';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtT = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const r2 = (v) => Math.round(v * 100) / 100;

// 使えるか（パソコンの Chrome・Edge・Safari の新しいもの）
export function canEdit() {
  return !!(window.VideoEncoder && window.VideoFrame && window.AudioEncoder && window.OfflineAudioContext && window.indexedDB && window.isSecureContext);
}

// ===== 下書きの保存（IndexedDB） =====
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('atg-editor', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode); const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => { db.close(); res(req?.result); }; tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const kvGet = (k) => kv('readonly', (s) => s.get(k)).catch(() => null);
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k)).catch(() => null);
const kvDel = (k) => kv('readwrite', (s) => s.delete(k)).catch(() => null);
const kvClear = () => kv('readwrite', (s) => s.clear()).catch(() => null);

// ===== 曲を作る（アプリに入っている BGM。著作権を気にせず使える） =====
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);
async function makeBgm(mood, sec = 48) {
  const sr = 44100; const ctx = new OfflineAudioContext(2, sr * sec, sr);
  const out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
  const cfg = {
    fresh: { bpm: 100, prog: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], lead: true, beat: 'soft', wave: 'triangle' },
    calm: { bpm: 72, prog: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]], lead: false, beat: null, wave: 'sine' },
    bright: { bpm: 122, prog: [[62, 66, 69], [57, 61, 64], [59, 62, 66], [55, 59, 62]], lead: true, beat: 'full', wave: 'square' },
  }[mood] || {};
  const beat = 60 / cfg.bpm; const bar = beat * 4;
  const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const tone = (freq, t, dur, type, peak, pan = 0) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); const p = ctx.createStereoPanner(); p.pan.value = pan;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = type === 'square' ? 2200 : 3800;
    o.connect(f); f.connect(g); g.connect(p); p.connect(out); env(g, t, 0.02, dur, peak); o.start(t); o.stop(t + dur + 0.1);
  };
  const noise = ctx.createBuffer(1, sr, sr); const nd = noise.getChannelData(0); for (let i = 0; i < sr; i++) nd[i] = Math.random() * 2 - 1;
  const hat = (t, peak) => {
    const s = ctx.createBufferSource(); s.buffer = noise; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain(); s.connect(f); f.connect(g); g.connect(out); env(g, t, 0.002, 0.05, peak); s.start(t); s.stop(t + 0.1);
  };
  const kick = (t) => {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = ctx.createGain(); o.connect(g); g.connect(out); env(g, t, 0.003, 0.25, 0.55); o.start(t); o.stop(t + 0.35);
  };
  const melody = [0, 2, 4, 7, 4, 2, 4, 9, 7, 4, 2, 0, 2, 4, 2, -1];
  for (let b = 0, t = 0; t < sec - 0.5; b++, t += bar) {
    const ch = cfg.prog[b % cfg.prog.length];
    if (mood === 'calm') ch.forEach((n, i) => tone(NOTE(n), t, bar * 0.95, 'sine', 0.07, (i - 1) * 0.4));
    else for (let k = 0; k < 8; k++) ch.forEach((n, i) => tone(NOTE(n + 12 * (k % 2)), t + k * beat / 2, beat * 0.45, cfg.wave, mood === 'bright' ? 0.025 : 0.045, (i - 1) * 0.5));
    tone(NOTE(ch[0] - 24), t, bar * 0.9, 'sine', 0.16);
    if (mood === 'calm') { [0, 2].forEach((k) => tone(NOTE(ch[(b + k) % 3] + 12), t + k * beat * 1.5 + beat * 0.5, beat * 1.4, 'triangle', 0.03, 0.3)); }
    if (cfg.lead && b % 8 >= 2) for (let k = 0; k < 4; k++) tone(NOTE(ch[0] + 12 + melody[(b * 4 + k) % melody.length]), t + k * beat, beat * 0.8, 'triangle', 0.05, 0.2);
    if (cfg.beat) for (let k = 0; k < 8; k++) { hat(t + k * beat / 2, cfg.beat === 'full' ? 0.06 : 0.035); if (cfg.beat === 'full' && k % 2 === 0) kick(t + k * beat / 2); else if (cfg.beat === 'soft' && k % 4 === 0) kick(t + k * beat / 2); }
  }
  const buf = await ctx.startRendering();
  return new Blob([wav(buf)], { type: 'audio/wav' });
}
function wav(buf) {
  const ch = buf.numberOfChannels; const n = buf.length; const sr = buf.sampleRate;
  const ab = new ArrayBuffer(44 + n * ch * 2); const v = new DataView(ab);
  const s = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  s(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) v.setInt16(o, clamp(data[c][i], -1, 1) * 0x7fff, true);
  return ab;
}

// ===== 本体 =====
export function openEditor({ title = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'ved';
    wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', '動画を編集する');
    wrap.innerHTML = `
      <div class="ved-top">
        <b>🎬 動画を編集する</b>
        <span class="ved-grp"><button type="button" data-e="undo" title="元に戻す（Ctrl+Z）">↶ 戻す</button><button type="button" data-e="redo" title="やり直す（Ctrl+Shift+Z）">↷ やり直す</button></span>
        <span class="ved-save muted"></span>
        <span class="ved-sp"></span>
        <label class="ved-orient">画面 <select data-e="orient"><option value="v">縦長（スマホ向け）</option><option value="h">横長</option><option value="s">正方形</option></select></label>
        <button type="button" data-e="help" class="ved-ghost">⌨ 使い方</button>
        <button type="button" data-e="new" class="ved-ghost">新しく作る</button>
        <button type="button" data-e="export" class="ved-go">書き出す ›</button>
        <button type="button" class="ved-x" data-e="close" aria-label="閉じる">×</button>
      </div>
      <div class="ved-body">
        <div class="ved-tools">${TOOLS.map(([k, ic, l, key]) => `<button type="button" data-e="tool" data-v="${k}" class="${k === 'select' ? 'on' : ''}" title="${l}（${key}）"><b>${ic}</b><small>${l}</small></button>`).join('')}
          <span class="ved-tools-sep"></span>
          <button type="button" data-e="undo" class="ved-tool-act" title="1つ前に戻す（Ctrl+Z）"><b>↶</b><small>1つ戻す</small></button>
          <button type="button" data-e="clear-lines" class="ved-tool-act" title="描いた線・矢印・円・角度・番号を消す"><b>⌫</b><small>線を全部消す</small></button></div>
        <div class="ved-center">
          <div class="ved-stage"><canvas class="ved-cv"></canvas>
            <div class="ved-empty"><p><b>動画を読み込んで始めましょう</b></p><p>下の「＋ 動画・画像を追加」を押すか、ここに動画ファイルをドラッグしてください。<br>複数まとめて選ぶと、選んだ順につながります。</p><button type="button" data-e="add" class="ved-go">＋ 動画・画像を追加</button></div>
            <div class="ved-tip" hidden></div><div class="ved-count" hidden></div>
          </div>
          <div class="ved-ctrl">
            <button type="button" data-e="play" class="ved-play" title="再生・一時停止（スペース）">▶</button>
            <span class="ved-grp">${[[-1, 1, '◀◀', '1秒戻す（Shift+←）'], [-1, 0, '◀', '1コマ戻す（←）'], [1, 0, '▶', '1コマ進める（→）'], [1, 1, '▶▶', '1秒進める（Shift+→）']].map(([v, f, l, a]) => `<button type="button" data-e="step" data-v="${v}"${f ? ' data-fast="1"' : ''} title="${a}">${l}</button>`).join('')}</span>
            <span class="ved-time"><b class="ved-now">0:00.0</b> / <span class="ved-total">0:00.0</span></span>
            <span class="ved-sp"></span>
            <span class="ved-grp"><button type="button" data-e="split" title="今の位置で分ける（S）">✂ 分ける</button><button type="button" data-e="freeze" title="今の場面で止める（F）">⏸ ここで止める</button><button type="button" data-e="del" title="選んだものを消す（Delete）">🗑 消す</button></span>
            <button type="button" data-e="narr" class="ved-rec" title="今の位置から声を録る（R）">🎙 ナレーションを録る</button>
          </div>
        </div>
        <aside class="ved-panel"></aside>
      </div>
      <div class="ved-tl">
        <div class="ved-tl-bar"><button type="button" data-e="add" class="ved-add">＋ 動画・画像を追加</button>
          <span class="ved-grp"><button type="button" data-e="card" data-v="open" title="ロゴとタイトルの画面を先頭に入れる">オープニングを入れる</button><button type="button" data-e="card" data-v="end" title="ロゴの画面を最後に入れる">エンディングを入れる</button></span>
          <span class="ved-sp"></span><label class="ved-zoom">表示 <input type="range" data-e="tlzoom" min="0" max="100" value="30"></label></div>
        <div class="ved-tl-main"><div class="ved-tl-labels"><span class="lr"></span><span class="lv">映像</span><span class="lo">文字・線</span><span class="ln">声</span><span class="lb">BGM</span></div>
          <div class="ved-tl-scroll"><div class="ved-tl-inner"></div></div></div>
      </div>
      <input type="file" class="ved-file" accept="video/*,image/*" multiple hidden>
      <input type="file" class="ved-bgmfile" accept="audio/*" hidden>
      <div class="ved-media" hidden></div>
      <div class="ved-modal" hidden></div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('rec-open');
    const $ = (s) => wrap.querySelector(s);
    const cv = $('.ved-cv'); const ctx = cv.getContext('2d');
    const LOGO = new Image(); LOGO.src = new URL('../assets/logo.png', import.meta.url).href; LOGO.onload = () => dirty();

    // ===== 状態 =====
    const blank = () => ({ v: 1, orient: null, size: 'sd', segs: [], ovs: [], nars: [], bgm: null, origVol: 1, title });
    let P = blank();
    const B = new Map(); // key → Blob（動画・画像・声・曲）
    const M = new Map(); // key → { video | img | audio, w, h, dur, thumb, url }
    let T = 0; let playing = false; let clock = 0; let tAt = 0;
    let tool = 'select'; let color = COLORS[0];
    let sel = null; // { kind: 'seg'|'ov'|'nar'|'bgm', id }
    let L = { starts: new Map(), total: 0, list: [] };
    let undo = []; let redo = []; let closed = false; let raf = 0; let needDraw = true; let saveTimer = 0; let ready = false;
    let recState = null; // ナレーション録音中
    let pps = 40; // タイムライン：1秒あたりの幅（px）
    const presets = (() => { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); } catch { return []; } })();

    const dims = () => {
      const base = P.size === 'hd' ? 1080 : 720; const long = Math.round(base * 16 / 9);
      return P.orient === 'h' ? [long, base] : P.orient === 's' ? [base, base] : [base, long];
    };
    const segDur = (s) => (s.kind === 'clip' ? (s.out - s.in) / s.speed : s.dur);
    function layout() {
      const starts = new Map(); let t = 0; const list = [];
      P.segs.forEach((s) => { starts.set(s.id, t); list.push({ s, start: t, end: t + segDur(s) }); t += segDur(s); });
      L = { starts, total: t, list };
      return L;
    }
    const segAt = (t) => L.list.find((x) => t >= x.start - 1e-6 && t < x.end - 1e-6) || (L.list.length && t >= L.total - 1e-6 ? L.list[L.list.length - 1] : null);
    // テロップ・線・声の、タイムライン上の開始時間
    const absStart = (o) => (L.starts.has(o.seg) ? L.starts.get(o.seg) + o.rel : null);
    const ovSpan = (o) => { const s = absStart(o); return s == null ? null : [s, s + o.len]; };
    // タイムラインの時間 t に合わせて「どの区間の何秒目」として持ち直す
    function anchor(o, t) {
      t = clamp(t, 0, Math.max(0, L.total - 0.05));
      const x = segAt(t) || L.list[0]; if (!x) return;
      o.seg = x.s.id; o.rel = r2(t - x.start);
    }
    const find = (k, id) => (k === 'seg' ? P.segs : k === 'ov' ? P.ovs : k === 'nar' ? P.nars : []).find((x) => x.id === id);
    const selObj = () => (sel ? (sel.kind === 'bgm' ? P.bgm : find(sel.kind, sel.id)) : null);

    // ===== 元に戻す・やり直す・自動保存 =====
    function snap() { undo.push(JSON.stringify(P)); if (undo.length > 100) undo.shift(); redo = []; }
    function restore(json) { P = JSON.parse(json); if (sel && !selObj()) sel = null; changed(true); }
    function changed(keepUndo) {
      layout(); T = clamp(T, 0, L.total); syncPanel(); renderTl(); dirty(); refreshSnaps();
      $('.ved-empty').hidden = P.segs.length > 0;
      wrap.querySelectorAll('[data-e="undo"]').forEach((x) => { x.disabled = !undo.length; }); $('[data-e="redo"]').disabled = !redo.length;
      $('.ved-total').textContent = fmtT(L.total);
      if (!ready) return;
      clearTimeout(saveTimer); $('.ved-save').textContent = '保存中…';
      saveTimer = setTimeout(async () => { await kvSet(DRAFT_KEY, JSON.stringify(P)); if (!closed) $('.ved-save').textContent = '✓ 自動保存しました'; }, 800);
      void keepUndo;
    }
    const dirty = () => { needDraw = true; };
    let snapTimer = 0; const refreshSnaps = () => { clearTimeout(snapTimer); snapTimer = setTimeout(() => ensureSnaps().catch(() => {}), 250); };

    // ===== 素材の読み込み =====
    async function addBlob(blob, key = uid()) {
      B.set(key, blob); await kvSet(`b:${key}`, blob);
      return key;
    }
    function seekTo(v, t) {
      return new Promise((res) => {
        if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) { res(); return; }
        let done = false; const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
        v.addEventListener('seeked', fin); v.currentTime = t; setTimeout(fin, 4000);
      });
    }
    async function loadMedia(key) {
      if (M.has(key)) return M.get(key);
      const blob = B.get(key) || await kvGet(`b:${key}`); if (!blob) return null; B.set(key, blob);
      const url = URL.createObjectURL(blob);
      if (blob.type.startsWith('image/')) {
        const img = await createImageBitmap(blob);
        const m = { img, w: img.width, h: img.height, url, thumb: thumbOf(img, img.width, img.height) }; M.set(key, m); return m;
      }
      if (blob.type.startsWith('audio/')) {
        const a = new Audio(url); a.preload = 'auto';
        await new Promise((res) => { a.onloadedmetadata = res; a.onerror = res; setTimeout(res, 5000); });
        const m = { audio: a, url, dur: Number.isFinite(a.duration) ? a.duration : 0 }; M.set(key, m); return m;
      }
      const v = document.createElement('video'); v.preload = 'auto'; v.playsInline = true; v.muted = true; v.src = url;
      $('.ved-media').appendChild(v);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('この動画は読み込めませんでした（このブラウザで再生できない形式かもしれません）')); });
      await seekTo(v, Math.min(0.1, v.duration / 2));
      const m = { video: v, w: v.videoWidth, h: v.videoHeight, dur: v.duration, url, thumb: thumbOf(v, v.videoWidth, v.videoHeight) };
      v.addEventListener('seeked', dirty);
      M.set(key, m); return m;
    }
    function thumbOf(src, w, h) {
      const c = document.createElement('canvas'); c.height = 60; c.width = Math.round(60 * w / h) || 60;
      try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.6); } catch { return ''; }
    }
    async function addFiles(files) {
      files = [...files].filter((f) => /^(video|image)\//.test(f.type));
      if (!files.length) return;
      tip('読み込んでいます…', 0);
      const before = JSON.stringify(P); let added = 0;
      for (const f of files) {
        try {
          const key = await addBlob(f); const m = await loadMedia(key);
          if (!P.orient) P.orient = m.w > m.h * 1.1 ? 'h' : 'v';
          if (m.img) P.segs.push({ id: uid(), kind: 'still', key, name: f.name, dur: 3, zoom: 1, zx: 0.5, zy: 0.5 });
          else P.segs.push({ id: uid(), kind: 'clip', key, name: f.name, in: 0, out: r2(m.dur), speed: 1, mute: false, zoom: 1, zx: 0.5, zy: 0.5 });
          added++;
        } catch (e) { tip(e.message || '読み込めませんでした', 4000); }
      }
      if (added) { undo.push(before); redo = []; $('[data-e="orient"]').value = P.orient; layout(); fitTl(); changed(); tip(`${added}個 追加しました`, 1600); }
    }

    // ===== 描く =====
    const blurC = document.createElement('canvas');
    // 動きながら拡大：区間のはじめ（zoom・zx・zy）から終わり（kb）へ、なめらかに寄る
    function segView(s, lt) {
      if (!s.kb) return s;
      const k = ease(clamp(lt / Math.max(0.01, segDur(s)), 0, 1));
      return { zoom: lerp(s.zoom || 1, s.kb.z, k), zx: lerp(s.zx ?? 0.5, s.kb.x, k), zy: lerp(s.zy ?? 0.5, s.kb.y, k) };
    }
    function drawFit(c, src, sw, sh, W, H, s) {
      const z = s.zoom || 1; const cw = sw / z; const ch = sh / z;
      const cx = clamp((s.zx ?? 0.5) * sw, cw / 2, sw - cw / 2); const cy = clamp((s.zy ?? 0.5) * sh, ch / 2, sh - ch / 2);
      const sx = cx - cw / 2; const sy = cy - ch / 2;
      const k = Math.min(W / cw, H / ch); const dw = cw * k; const dh = ch * k;
      if (dw < W - 2 || dh < H - 2) {
        // 縦横の比率が違うときは、同じ映像をぼかして背景にする（黒い帯にしない）
        const bw = 40; const bh = Math.max(8, Math.round(40 * H / W)); blurC.width = bw; blurC.height = bh;
        const bc = blurC.getContext('2d'); const kk = Math.max(bw / cw, bh / ch);
        bc.drawImage(src, sx, sy, cw, ch, (bw - cw * kk) / 2, (bh - ch * kk) / 2, cw * kk, ch * kk);
        c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(blurC, 0, 0, W, H);
        c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(0, 0, W, H);
      }
      c.drawImage(src, sx, sy, cw, ch, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    function drawCard(c, W, H, s, lt) {
      const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#17221b'); g.addColorStop(1, '#0b100d');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      const u = Math.min(W, H) / 100; const a = clamp(lt / 0.5, 0, 1) * clamp((s.dur - lt) / 0.45, 0, 1);
      c.save(); c.globalAlpha = a; c.textAlign = 'center'; c.textBaseline = 'middle';
      const lw = Math.min(W * 0.6, 62 * u); let y = H * (s.style === 'end' ? 0.46 : 0.38);
      if (LOGO.naturalWidth) { const lh = lw * LOGO.naturalHeight / LOGO.naturalWidth; c.drawImage(LOGO, (W - lw) / 2, y - lh / 2, lw, lh); y += lh / 2 + 7 * u; }
      c.strokeStyle = 'rgba(200,169,106,.8)'; c.lineWidth = Math.max(1, u * 0.25); c.beginPath(); c.moveTo(W / 2 - 14 * u, y); c.lineTo(W / 2 + 14 * u, y); c.stroke();
      y += 7 * u;
      if (s.title) { c.fillStyle = '#e2cc9a'; c.font = `700 ${7 * u}px ${SERIF}`; wrapLines(c, s.title, W * 0.86).forEach((l, i) => c.fillText(l, W / 2, y + i * 9 * u)); y += 9 * u * wrapLines(c, s.title, W * 0.86).length; }
      if (s.sub) { c.fillStyle = '#c9cbbf'; c.font = `500 ${3.6 * u}px ${SANS}`; c.fillText(s.sub, W / 2, y + 1 * u); }
      c.restore();
    }
    function wrapLines(c, text, maxW) {
      const out = [];
      String(text).split('\n').forEach((para) => {
        let line = '';
        [...para].forEach((ch) => { if (c.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; });
        out.push(line);
      });
      return out;
    }
    function textBox(c, o, W, H) {
      const u = Math.min(W, H) / 100; const fs = (o.size || 6) * u; const st = TEXT_STYLES[o.style] || TEXT_STYLES.outline;
      c.font = `${st.serif ? 700 : 800} ${fs}px ${st.serif ? SERIF : SANS}`;
      const lines = wrapLines(c, o.text || ' ', W * 0.92); const lh = fs * 1.28;
      const tw = Math.max(fs * 0.6, ...lines.map((l) => c.measureText(l).width));
      const pad = st.bg ? fs * 0.42 : fs * 0.12; const w = tw + pad * 2; const h = lh * lines.length + pad * 2 - fs * 0.12;
      return { x: o.x * W - w / 2, y: o.y * H - h / 2, w, h, fs, lh, lines, st, pad };
    }
    function drawText(c, o, W, H, alpha) {
      const b = textBox(c, o, W, H);
      c.save(); c.globalAlpha = alpha;
      if (b.st.bg) { c.fillStyle = b.st.bg; c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, b.fs * 0.2); c.fill(); }
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
      b.lines.forEach((l, i) => {
        const y = b.y + b.pad + b.lh * (i + 0.5) - b.fs * 0.03; const x = o.x * W;
        if (b.st.stroke) { c.lineWidth = b.fs * 0.2; c.strokeStyle = b.st.stroke; c.strokeText(l, x, y); }
        c.fillStyle = o.color || b.st.color; c.fillText(l, x, y);
      });
      c.restore();
    }
    const angDeg = (p) => { const [a, b, d] = p; const a1 = Math.atan2(a.y - b.y, a.x - b.x); const a2 = Math.atan2(d.y - b.y, d.x - b.x); let x = Math.abs(a1 - a2) * 180 / Math.PI; if (x > 180) x = 360 - x; return x; };
    function drawShape(c, o, W, H, alpha, pr = 1) {
      const u = Math.min(W, H) / 100; const lw = (o.w || 1) * u * 0.9; const P2 = (q) => ({ x: q.x * W, y: q.y * H });
      c.save(); c.globalAlpha = alpha; c.strokeStyle = o.c; c.fillStyle = o.c; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round';
      c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = lw;
      const head = (a, b) => {
        const ang = Math.atan2(b.y - a.y, b.x - a.x); const s = lw * 3.6;
        c.beginPath(); c.moveTo(b.x + Math.cos(ang) * lw * 0.6, b.y + Math.sin(ang) * lw * 0.6);
        c.lineTo(b.x - s * Math.cos(ang - 0.5), b.y - s * Math.sin(ang - 0.5)); c.lineTo(b.x - s * Math.cos(ang + 0.5), b.y - s * Math.sin(ang + 0.5)); c.closePath(); c.fill();
      };
      if (o.type === 'line' || o.type === 'arrow') {
        const a = P2(o.a); const b0 = P2(o.b); const b = { x: a.x + (b0.x - a.x) * pr, y: a.y + (b0.y - a.y) * pr };
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); if (o.type === 'arrow' && pr > 0.05) head(a, b);
      } else if (o.type === 'circle') {
        const a = P2(o.a); const b = P2(o.b);
        c.beginPath(); c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); c.stroke();
      } else if (o.type === 'pen') {
        const n = Math.max(2, Math.round(o.p.length * pr)); c.beginPath(); o.p.slice(0, n).forEach((q, i) => { const p = P2(q); if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }); c.stroke();
      } else if (o.type === 'angle') {
        const pts = o.p.map(P2); pts.forEach((q) => { c.beginPath(); c.arc(q.x, q.y, lw * 1.1, 0, Math.PI * 2); c.fill(); });
        if (pts.length >= 2) {
          const [a, b, d] = pts; const k = Math.min(1, pr * 2);
          c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + (a.x - b.x) * k, b.y + (a.y - b.y) * k); c.stroke();
          if (d) {
            const k2 = clamp(pr * 2 - 1, 0, 1); c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + (d.x - b.x) * k2, b.y + (d.y - b.y) * k2); c.stroke();
            if (pr >= 1) {
              const a1 = Math.atan2(a.y - b.y, a.x - b.x); const a2 = Math.atan2(d.y - b.y, d.x - b.x); let diff = a2 - a1; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
              const rr = Math.min(Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(d.x - b.x, d.y - b.y)) * 0.32;
              c.lineWidth = lw * 0.7; c.beginPath(); c.arc(b.x, b.y, rr, a1, a1 + diff, diff < 0); c.stroke();
              const mid = a1 + diff / 2; const lx = b.x + Math.cos(mid) * (rr + 7 * u); const ly = b.y + Math.sin(mid) * (rr + 7 * u);
              const txt = `${Math.round(angDeg(o.p))}°`; c.shadowBlur = 0; c.font = `800 ${5 * u}px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle';
              const tw = c.measureText(txt).width; c.fillStyle = 'rgba(0,0,0,.7)'; c.beginPath(); c.roundRect(lx - tw / 2 - 1.5 * u, ly - 3.4 * u, tw + 3 * u, 6.8 * u, 1.4 * u); c.fill();
              c.fillStyle = '#fff'; c.fillText(txt, lx, ly);
            }
          }
        }
      } else if (o.type === 'num') {
        const q = P2(o.a); const r = 3.6 * u * (o.s || 1) * (pr < 1 ? 0.6 + 0.4 * pr + Math.sin(pr * Math.PI) * 0.25 : 1);
        c.beginPath(); c.arc(q.x, q.y, r, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
        c.lineWidth = Math.max(1.5, r * 0.14); c.strokeStyle = '#fff'; c.stroke();
        c.fillStyle = o.c === '#ffffff' || o.c === '#ffd60a' ? '#111' : '#fff'; c.font = `800 ${r * 1.15}px ${SANS}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(o.n), q.x, q.y + r * 0.04);
        if (o.label) { c.font = `800 ${r * 0.95}px ${SANS}`; const tw = c.measureText(o.label).width; c.textAlign = 'left'; c.lineWidth = r * 0.2; c.strokeStyle = '#000'; c.strokeText(o.label, q.x + r * 1.35, q.y); c.fillStyle = '#fff'; c.fillText(o.label, q.x + r * 1.35, q.y); void tw; }
      }
      c.restore();
    }
    // スポットライト（見せたい所以外を暗く）・ぼかし／モザイク
    const tmpC = document.createElement('canvas');
    function boxOf(o, W, H) { const x = Math.min(o.a.x, o.b.x) * W; const y = Math.min(o.a.y, o.b.y) * H; return { x, y, w: Math.abs(o.b.x - o.a.x) * W, h: Math.abs(o.b.y - o.a.y) * H }; }
    function drawMask(c, o, W, H, alpha) {
      const b = boxOf(o, W, H); if (b.w < 2 || b.h < 2) return;
      c.save(); c.globalAlpha = alpha;
      if (o.type === 'spot') {
        const dark = `rgba(0,0,0,${o.dark ?? 0.62})`;
        if (o.shape === 'rect') { c.fillStyle = dark; c.beginPath(); c.rect(0, 0, W, H); c.roundRect(b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.08); c.fill('evenodd'); }
        else {
          // ふちをやわらかく（楕円のグラデーション）
          const cx = b.x + b.w / 2; const cy = b.y + b.h / 2; const rx = b.w / 2; const ry = b.h / 2;
          c.translate(cx, cy); c.scale(rx, ry);
          const g = c.createRadialGradient(0, 0, 0, 0, 0, 1.12); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.86, 'rgba(0,0,0,0)'); g.addColorStop(1, dark);
          c.fillStyle = g; c.fillRect(-cx / rx - 1, -cy / ry - 1, W / rx + 2, H / ry + 2);
        }
        if (o.ring) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = alpha; c.strokeStyle = o.c || '#ffd60a'; c.lineWidth = Math.max(2, Math.min(W, H) / 220); c.beginPath(); if (o.shape === 'rect') c.roundRect(b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.08); else c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); c.stroke(); }
      } else {
        c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.12); c.clip();
        const str = o.str ?? 12;
        if (o.mode === 'mosaic') {
          const cell = Math.max(3, str * 1.3 * Math.min(W, H) / 720); const tw = Math.max(1, Math.round(b.w / cell)); const th = Math.max(1, Math.round(b.h / cell));
          tmpC.width = tw; tmpC.height = th; tmpC.getContext('2d').drawImage(c.canvas, b.x, b.y, b.w, b.h, 0, 0, tw, th);
          c.imageSmoothingEnabled = false; c.drawImage(tmpC, 0, 0, tw, th, b.x, b.y, b.w, b.h); c.imageSmoothingEnabled = true;
        } else {
          const pad = str * 3; tmpC.width = Math.ceil(b.w + pad * 2); tmpC.height = Math.ceil(b.h + pad * 2);
          tmpC.getContext('2d').drawImage(c.canvas, b.x - pad, b.y - pad, tmpC.width, tmpC.height, 0, 0, tmpC.width, tmpC.height);
          c.filter = `blur(${str * Math.min(W, H) / 720}px)`; c.drawImage(tmpC, b.x - pad, b.y - pad); c.filter = 'none';
        }
      }
      c.restore();
    }
    // 動くものを追いかける：はじめの枠（a・b）から終わりの枠（a2・b2）へ動かす
    function geoAt(o, t) {
      if (!o.a2) return o; const s = absStart(o); if (s == null) return o;
      const k = clamp((t - s) / Math.max(0.01, o.len), 0, 1);
      return { ...o, a: lerpP(o.a, o.a2, k), b: lerpP(o.b, o.b2, k) };
    }
    // 追いかけるときに、今どちらの枠を直すか（終わりに近ければ終わりの枠）
    function editEnd(o) { if (!o.a2) return false; const s = absStart(o); return s != null && T - s > o.len / 2; }
    // 出し方（ふわっと出る・描かれる）
    function ovAlpha(o, t, s) {
      const e = s + o.len; if (o.anim === 'none') return [1, 1];
      const fade = Math.min(0.25, o.len / 4); let a = clamp((t - s) / fade, 0, 1) * clamp((e - t) / fade, 0, 1);
      let pr = 1;
      if (o.type !== 'text' && !MASKS.includes(o.type) && o.anim !== 'fade') { pr = clamp((t - s) / Math.min(0.6, o.len / 2), 0, 1); a = clamp((e - t) / fade, 0, 1); pr = 1 - (1 - pr) ** 2; }
      return [a, pr];
    }
    function drawOverlays(c, W, H, t, editing) {
      const order = [...P.ovs.filter((o) => o.type === 'blur'), ...P.ovs.filter((o) => o.type === 'spot'), ...P.ovs.filter((o) => !MASKS.includes(o.type))];
      order.forEach((o) => {
        const sp = ovSpan(o); if (!sp) return;
        const isSel = editing && sel?.kind === 'ov' && sel.id === o.id;
        if (!(t >= sp[0] && t < sp[1]) && !isSel) return;
        let [a, pr] = (t >= sp[0] && t < sp[1]) ? ovAlpha(o, t, sp[0]) : [0.35, 1];
        if (editing && !playing && t >= sp[0] && t < sp[1]) { a = 1; pr = 1; }
        const g = geoAt(o, t);
        if (o.type === 'text') drawText(c, g, W, H, a); else if (MASKS.includes(o.type)) drawMask(c, g, W, H, a); else drawShape(c, g, W, H, a, pr);
      });
    }
    // 場面の切り替え
    const snaps = new Map(); // ふわっと切り替えるときの、前の場面の最後の1コマ
    function snapKey(i) { const prev = L.list[i - 1]; const [W, H] = dims(); return prev ? `${W}x${H}|${JSON.stringify(prev.s)}` : ''; }
    async function grabFrame(x, t, W, H) {
      const c = document.createElement('canvas'); c.width = W; c.height = H; const cx = c.getContext('2d');
      cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
      const s = x.s; const lt = t - x.start;
      if (s.kind === 'card') { drawCard(cx, W, H, s, Math.min(lt, s.dur - 0.5)); return c; }
      const m = M.get(s.key); if (!m) return c;
      let src = m.img;
      if (m.video) {
        if (!m.grab) { m.grab = document.createElement('video'); m.grab.muted = true; m.grab.preload = 'auto'; m.grab.src = m.url; $('.ved-media').appendChild(m.grab); await new Promise((r) => { if (m.grab.readyState >= 1) r(); else { m.grab.onloadedmetadata = r; setTimeout(r, 4000); } }); }
        await seekTo(m.grab, clamp(srcTime(x, t), 0, m.dur - 0.02)); src = m.grab;
      }
      if (src) drawFit(cx, src, m.w, m.h, W, H, segView(s, lt));
      return c;
    }
    let snapBusy = null;
    async function ensureSnaps() {
      if (snapBusy) await snapBusy;
      snapBusy = (async () => {
        const [W, H] = dims(); const want = new Set();
        for (let i = 1; i < L.list.length; i++) {
          const x = L.list[i]; if (x.s.tr?.type !== 'fade') continue;
          const key = snapKey(i); want.add(key); if (snaps.has(key)) continue;
          const prev = L.list[i - 1]; snaps.set(key, await grabFrame(prev, prev.end - 0.02, W, H));
        }
        [...snaps.keys()].forEach((k) => { if (!want.has(k)) snaps.delete(k); });
        dirty();
      })();
      await snapBusy; snapBusy = null;
    }
    function drawTrans(c, W, H, t) {
      const i = L.list.findIndex((x) => t >= x.start - 1e-6 && t < x.end - 1e-6); if (i < 0) return;
      const x = L.list[i]; const lt = t - x.start; const tr = x.s.tr; const next = L.list[i + 1];
      const dip = (col, a) => { if (a <= 0) return; c.save(); c.globalAlpha = clamp(a, 0, 1); c.fillStyle = col; c.fillRect(0, 0, W, H); c.restore(); };
      if (tr?.type) {
        const d = tr.d || 0.6;
        if (tr.type === 'fade' && i > 0) { const img = snaps.get(snapKey(i)); if (img && lt < d) { c.save(); c.globalAlpha = 1 - ease(lt / d); c.drawImage(img, 0, 0, W, H); c.restore(); } }
        else if (tr.type === 'black' || (tr.type === 'fade' && i === 0)) dip('#000', 1 - lt / (i === 0 ? d : d / 2));
        else if (tr.type === 'white') dip('#fff', 1 - lt / (d / 2));
      }
      const nt = next?.s.tr;
      if (nt && (nt.type === 'black' || nt.type === 'white')) { const d = (nt.d || 0.6) / 2; dip(nt.type === 'black' ? '#000' : '#fff', 1 - (x.end - t) / d); }
    }
    // 1コマを描く（プレビュー・書き出し共通）
    function renderFrame(c, W, H, t, editing = false) {
      c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      const x = segAt(t);
      if (x) {
        const s = x.s;
        if (s.kind === 'card') drawCard(c, W, H, s, t - x.start);
        else { const m = M.get(s.key); const src = m?.video || m?.img; if (src && (m.img || m.video.readyState >= 2)) drawFit(c, src, m.w, m.h, W, H, segView(s, t - x.start)); }
      }
      drawOverlays(c, W, H, t, editing);
      drawTrans(c, W, H, t);
    }

    // ===== プレビュー =====
    let active = null; // 今再生している <video>
    function srcTime(x, t) { return x.s.in + (t - x.start) * x.s.speed; }
    function syncMedia(force = false) {
      const x = segAt(T); const m = x && x.s.kind === 'clip' ? M.get(x.s.key) : null; const v = m?.video || null;
      if (active && active !== v) { active.pause(); active = null; }
      if (v) {
        const want = srcTime(x, T);
        v.playbackRate = x.s.speed; v.muted = !playing || x.s.mute || recState || (x.s.speed !== 1 && !x.s.slowSound); v.volume = clamp(P.origVol, 0, 1);
        if (playing) {
          if (active !== v || force || Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
          if (v.paused) v.play().catch(() => {});
          active = v;
        } else { if (!v.paused) v.pause(); if (force || Math.abs(v.currentTime - want) > 0.02) v.currentTime = want; }
      }
      // ナレーション
      P.nars.forEach((n) => {
        const m2 = M.get(n.key); const a = m2?.audio; if (!a) return; const s = absStart(n); if (s == null) return;
        const inR = playing && !recState && T >= s && T < s + n.len;
        a.volume = clamp(n.vol ?? 1, 0, 1);
        if (inR) { const w = T - s; if (a.paused || force || Math.abs(a.currentTime - w) > 0.3) { a.currentTime = w; a.play().catch(() => {}); } } else if (!a.paused) a.pause();
      });
      // BGM
      const bm = P.bgm && M.get(P.bgm.key)?.audio;
      if (bm) {
        const on = playing && !recState && P.bgm.vol > 0;
        if (on) { const d = bm.duration || 1; const w = T % d; bm.loop = true; bm.volume = clamp(bgmGain(T), 0, 1); if (bm.paused || force || Math.abs(bm.currentTime - w) > 0.4) { bm.currentTime = w; bm.play().catch(() => {}); } } else if (!bm.paused) bm.pause();
      }
    }
    // BGM の音量（はじめと終わりは小さく、声が入っている間は小さく）
    function narSpans() { return P.nars.map((n) => { const s = absStart(n); return s == null ? null : [s, s + n.len]; }).filter(Boolean); }
    function bgmGain(t) {
      if (!P.bgm) return 0; let g = P.bgm.vol;
      g *= clamp(t / 1, 0, 1) * clamp((L.total - t) / 1.5, 0, 1);
      if (P.bgm.duck !== false) { const sp = narSpans(); const near = sp.some(([s, e]) => t > s - 0.3 && t < e + 0.4); if (near) g *= 0.28; }
      return g;
    }
    function play() {
      if (!P.segs.length) return;
      if (T >= L.total - 0.05) T = 0;
      playing = true; tAt = T; clock = performance.now(); syncMedia(true); $('.ved-play').textContent = '❚❚';
    }
    function pause() {
      playing = false; $('.ved-play').textContent = '▶';
      if (active) active.pause(); active = null;
      P.nars.forEach((n) => M.get(n.key)?.audio?.pause()); if (P.bgm) M.get(P.bgm.key)?.audio?.pause();
      syncMedia(true); dirty();
    }
    function seek(t) { T = clamp(t, 0, L.total); if (playing) { tAt = T; clock = performance.now(); syncMedia(true); } else syncMedia(true); dirty(); placePh(); }

    function fitCanvas() {
      const [W, H] = dims(); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const st = $('.ved-stage'); const w = st.clientWidth - 24; const h = st.clientHeight - 24; const k = Math.min(w / W, h / H);
      cv.style.width = `${Math.max(10, Math.floor(W * k))}px`; cv.style.height = `${Math.max(10, Math.floor(H * k))}px`;
    }
    const ro = new ResizeObserver(() => { fitCanvas(); dirty(); }); ro.observe($('.ved-stage'));

    function frame() {
      if (closed) return;
      raf = requestAnimationFrame(frame);
      try {
        if (playing) {
          T = tAt + (performance.now() - clock) / 1000;
          if (recState && T >= L.total) { stopNarr(); }
          if (T >= L.total) { T = L.total; pause(); }
          syncMedia(); needDraw = true;
        }
        if (needDraw) {
          needDraw = false; fitCanvas(); const [W, H] = dims();
          renderFrame(ctx, W, H, T, true);
          drawDraft(); drawHandles();
          $('.ved-now').textContent = fmtT(T); placePh();
        }
      } catch (err) { console.error(err); }
    }
    raf = requestAnimationFrame(frame);

    // ===== 画面の上で描く・動かす =====
    let draft = null; let anglePts = []; let drag = null;
    const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, -0.1, 1.1), y: clamp((e.clientY - r.top) / r.height, -0.1, 1.1) }; };
    const pxu = () => cv.getBoundingClientRect().width / cv.width; // 画面上の1px
    function drawDraft() {
      const [W, H] = dims();
      if (draft) { if (draft.type === 'text') drawText(ctx, draft, W, H, 1); else if (MASKS.includes(draft.type)) { drawMask(ctx, { mode: 'blur', str: 12, dark: 0.62, ...draft }, W, H, 1); ctx.save(); ctx.setLineDash([8, 6]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; const bb = boxOf(draft, W, H); ctx.strokeRect(bb.x, bb.y, bb.w, bb.h); ctx.restore(); } else drawShape(ctx, draft, W, H, 1, 1); }
      if (anglePts.length) drawShape(ctx, { type: 'angle', c: color, w: 1, p: anglePts }, W, H, 1, 1);
    }
    function ovBox(o) {
      const [W, H] = dims(); o = geoAt(o, T);
      if (o.type === 'text') { const b = textBox(ctx, o, W, H); return { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H }; }
      const pts = o.type === 'pen' || o.type === 'angle' ? o.p : o.type === 'num' ? [o.a] : [o.a, o.b];
      const xs = pts.map((q) => q.x); const ys = pts.map((q) => q.y); const pad = o.type === 'num' ? 0.045 : 0.015;
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad * W / H, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 * W / H };
    }
    function handlesOf(o) {
      if (o.type === 'line' || o.type === 'arrow' || o.type === 'circle') return [['a', o.a], ['b', o.b]];
      if (MASKS.includes(o.type)) { const g = geoAt(o, T); return [['a', g.a], ['b', g.b], ['ab', { x: g.a.x, y: g.b.y }], ['ba', { x: g.b.x, y: g.a.y }]]; }
      if (o.type === 'angle') return o.p.map((q, i) => [i, q]);
      if (o.type === 'text') { const b = ovBox(o); return [['size', { x: b.x + b.w, y: b.y + b.h }]]; }
      return [];
    }
    function drawHandles() {
      const o = sel?.kind === 'ov' ? find('ov', sel.id) : null; if (!o || playing) return;
      const [W, H] = dims(); const b = ovBox(o); const k = 1 / pxu();
      ctx.save(); ctx.setLineDash([6 * k, 4 * k]); ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5 * k; ctx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H); ctx.setLineDash([]);
      handlesOf(o).forEach(([, q]) => { ctx.beginPath(); ctx.arc(q.x * W, q.y * H, 7 * k, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#c8a96a'; ctx.lineWidth = 2.5 * k; ctx.stroke(); });
      ctx.restore();
    }
    function hitOv(p) {
      const [W, H] = dims(); const tol = 10 / pxu();
      const cur = sel?.kind === 'ov' ? find('ov', sel.id) : null;
      if (cur) { const h = handlesOf(cur).find(([, q]) => Math.hypot((q.x - p.x) * W, (q.y - p.y) * H) < tol * 1.4); if (h) return { o: cur, h: h[0] }; }
      const vis = P.ovs.filter((o) => { const sp = ovSpan(o); return sp && T >= sp[0] - 1e-6 && T < sp[1]; });
      for (let i = vis.length - 1; i >= 0; i--) {
        const b = ovBox(vis[i]); const m = 6 / pxu() / W;
        if (p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m) return { o: vis[i], h: null };
      }
      return null;
    }
    function newOv(o) {
      // 今の場面が「止めた画面」なら、その区間のあいだ出す。動画なら3秒
      const x = segAt(T); if (!x) return null;
      let len = 3; if (x.s.kind !== 'clip') len = x.end - T; len = r2(clamp(len, 0.5, Math.max(0.5, L.total - T)));
      Object.assign(o, { id: uid(), len, anim: o.type === 'text' || o.type === 'spot' ? 'fade' : o.type === 'blur' ? 'none' : 'draw' }); anchor(o, T);
      if (o.type === 'spot') Object.assign(o, { shape: 'ellipse', dark: 0.62, ring: false, c: '#ffd60a' });
      if (o.type === 'blur') { Object.assign(o, { mode: 'blur', str: 12 }); delete o.c; }
      // ぼかしは、その場面の終わりまで（映り込みを隠すことが多いので）
      if (o.type === 'blur') { const x2 = segAt(T); if (x2) o.len = r2(Math.max(0.5, x2.end - T)); }
      return o;
    }
    cv.addEventListener('pointerdown', (e) => {
      if (!P.segs.length) return;
      if (playing) pause();
      const p = pt(e); cv.setPointerCapture(e.pointerId);
      if (tool === 'select') {
        const h = hitOv(p);
        if (h) { select('ov', h.o.id); drag = { o: h.o, h: h.h, p0: p, orig: JSON.stringify(h.o), before: JSON.stringify(P), moved: false, end: editEnd(h.o) }; }
        else select(null);
        return;
      }
      if (tool === 'text') {
        const st = presets.find((x) => x.def) || { style: 'outline', size: 6 };
        const o = newOv({ type: 'text', text: 'テロップ', x: clamp(p.x, 0.1, 0.9), y: clamp(p.y, 0.05, 0.95), style: st.style, size: st.size, color: st.color || '' });
        if (o) { snap(); P.ovs.push(o); select('ov', o.id); changed(); setTool('select'); setTimeout(() => { const ta = $('.ved-panel textarea'); ta?.focus(); ta?.select(); }, 30); }
        return;
      }
      if (tool === 'num') {
        const n = 1 + Math.max(0, ...P.ovs.filter((o) => o.type === 'num' && Math.abs((ovSpan(o)?.[0] ?? -9) - T) < 30).map((o) => o.n));
        const o = newOv({ type: 'num', a: p, n, c: color, s: 1, label: '' }); if (o) { snap(); P.ovs.push(o); select('ov', o.id); changed(); }
        return;
      }
      if (tool === 'angle') {
        anglePts.push(p);
        if (anglePts.length === 3) { const o = newOv({ type: 'angle', p: anglePts, c: color, w: 1 }); anglePts = []; if (o) { snap(); P.ovs.push(o); select('ov', o.id); changed(); } }
        else tip(anglePts.length === 1 ? '次に、角の頂点（関節など）をクリック' : '最後に、もう一方の端をクリック', 2500);
        dirty(); return;
      }
      draft = tool === 'pen' ? { type: 'pen', p: [p], c: color, w: 1 } : { type: tool, a: p, b: p, c: color, w: 1 };
      dirty();
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pt(e);
      if (draft) { if (draft.type === 'pen') draft.p.push(p); else draft.b = e.shiftKey && draft.type === 'circle' ? { x: p.x, y: draft.a.y + (p.x - draft.a.x) * cv.width / cv.height * Math.sign(p.y - draft.a.y || 1) } : p; dirty(); return; }
      if (drag) {
        const o = drag.o; const orig = JSON.parse(drag.orig); const dx = p.x - drag.p0.x; const dy = p.y - drag.p0.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.002) drag.moved = true;
        const mv = (q) => ({ x: q.x + dx, y: q.y + dy });
        if (drag.h === null) {
          if (o.type === 'text') { o.x = clamp(orig.x + dx, 0, 1); o.y = clamp(orig.y + dy, 0, 1); }
          else if (o.type === 'pen' || o.type === 'angle') o.p = orig.p.map(mv);
          else if (o.type === 'num') o.a = mv(orig.a);
          else if (MASKS.includes(o.type) && orig.a2) {
            if (drag.end) { o.a2 = mv(orig.a2); o.b2 = mv(orig.b2); } else { o.a = mv(orig.a); o.b = mv(orig.b); }
          } else { o.a = mv(orig.a); o.b = mv(orig.b); }
        } else if (MASKS.includes(o.type)) {
          const A = drag.end ? 'a2' : 'a'; const Bk = drag.end ? 'b2' : 'b';
          if (drag.h === 'a') o[A] = p; else if (drag.h === 'b') o[Bk] = p;
          else if (drag.h === 'ab') { o[A] = { x: p.x, y: orig[A].y }; o[Bk] = { x: orig[Bk].x, y: p.y }; }
          else if (drag.h === 'ba') { o[Bk] = { x: p.x, y: orig[Bk].y }; o[A] = { x: orig[A].x, y: p.y }; }
        } else if (drag.h === 'size') {
          const [W, H] = dims(); const b0 = textBox(ctx, orig, W, H); const k = clamp(((p.x * W - b0.x) / b0.w + (p.y * H - b0.y) / b0.h) / 2, 0.3, 4);
          o.size = r2(clamp(orig.size * k, 2, 20));
        } else if (o.type === 'angle') o.p[drag.h] = p;
        else o[drag.h] = p;
        dirty(); return;
      }
      if (tool === 'select') { const h = hitOv(p); cv.style.cursor = h ? (h.h !== null ? 'grab' : 'move') : 'default'; } else cv.style.cursor = 'crosshair';
    });
    const endDraw = () => {
      if (draft) {
        const d = draft; draft = null;
        const big = d.type === 'pen' ? d.p.length > 2 : Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 0.01;
        if (big) { const o = newOv(d); if (o) { snap(); P.ovs.push(o); select('ov', o.id); changed(); } }
        dirty();
      }
      if (drag) { if (drag.moved) { undo.push(drag.before); redo = []; changed(); } drag = null; }
    };
    cv.addEventListener('pointerup', endDraw); cv.addEventListener('pointercancel', endDraw);
    cv.addEventListener('dblclick', () => { if (sel?.kind === 'ov') { const ta = $('.ved-panel textarea'); ta?.focus(); ta?.select(); } });

    function setTool(k) {
      tool = k; anglePts = []; wrap.querySelectorAll('[data-e="tool"]').forEach((b) => b.classList.toggle('on', b.dataset.v === k));
      cv.style.cursor = k === 'select' ? 'default' : 'crosshair';
      const hints = { text: 'テロップを置きたい場所をクリック', line: 'ドラッグして線を引く', arrow: 'ドラッグして矢印を引く', circle: 'ドラッグして円を描く（Shift で正円）', angle: '角度：はじめに片方の端をクリック', pen: 'ドラッグして自由に描く', num: '番号を置きたい場所をクリック（1, 2, 3…と増えます）', spot: 'ドラッグして、明るく見せたい所を囲む', blur: 'ドラッグして、隠したい所を囲む' };
      if (hints[k]) tip(hints[k], 2500);
      dirty();
    }

    // ===== 選んだものの設定（右の欄） =====
    function select(kind, id) { sel = kind ? { kind, id } : null; syncPanel(); renderTl(); dirty(); }
    const colorRow = (cur, attr = 'c') => `<div class="ved-colors">${COLORS.map((c) => `<button type="button" class="sw${c === cur ? ' on' : ''}" style="--c:${c}" data-p="${attr}" data-val="${c}" aria-label="色"></button>`).join('')}</div>`;
    const timing = (o) => {
      const s = absStart(o) ?? 0;
      return `<div class="ved-row"><label>出す時間 <input type="number" step="0.1" min="0" data-p="start" value="${r2(s)}">秒から</label><label><input type="number" step="0.1" min="0.2" data-p="len" value="${r2(o.len)}">秒間</label></div>
        <div class="ved-row"><button type="button" class="ved-mini" data-e="ov-tohere">今の位置から出す</button><button type="button" class="ved-mini" data-e="ov-toseg">この場面のあいだ出す</button></div>`;
    };
    function syncPanel() {
      const pnl = $('.ved-panel'); const o = selObj();
      if (document.activeElement && pnl.contains(document.activeElement) && document.activeElement.matches('input[type=text],textarea,input[type=number]') && pnl.dataset.for === (sel ? `${sel.kind}:${sel.id}` : '')) return;
      pnl.dataset.for = sel ? `${sel.kind}:${sel.id}` : '';
      if (!o) { pnl.innerHTML = panelHome(); return; }
      if (sel.kind === 'seg') pnl.innerHTML = panelSeg(o);
      else if (sel.kind === 'ov') pnl.innerHTML = o.type === 'text' ? panelText(o) : MASKS.includes(o.type) ? panelMask(o) : panelShape(o);
      else if (sel.kind === 'nar') pnl.innerHTML = panelNar(o);
      else if (sel.kind === 'bgm') pnl.innerHTML = panelBgm();
    }
    function panelHome() {
      return `<h3>全体の設定</h3>
        <label class="ved-lab">元の動画の音量 <b>${Math.round(P.origVol * 100)}%</b></label><input type="range" min="0" max="1" step="0.05" data-p="origVol" value="${P.origVol}">
        <h3>BGM</h3>${bgmBlock()}
        <h3>テロップの型</h3><p class="ved-note">テロップを選んで「この形を型に保存」を押すと、次から同じ形で置けます。</p>
        ${presets.length ? `<div class="ved-presets">${presets.map((x, i) => `<span class="ved-preset${x.def ? ' def' : ''}"><button type="button" data-e="preset-def" data-v="${i}" title="新しいテロップをこの形にする">${x.def ? '★ ' : ''}${esc(x.name)}</button><button type="button" data-e="preset-del" data-v="${i}" aria-label="型を消す">×</button></span>`).join('')}</div>` : '<p class="ved-note">まだありません。</p>'}
        <h3>ヒント</h3><ul class="ved-hints"><li>タイムラインの映像をドラッグで並べ替え、端をつまんで長さを調整できます。</li><li>「⏸ ここで止める」で一時停止した画面を入れると、線や番号の説明がしやすくなります。</li><li>止めた画面の上で描いたものは、その画面のあいだ出ます。</li><li>「🎙 ナレーションを録る」で、動画を流しながら声を入れられます。話した言葉を字幕にすることもできます。</li><li>映像を選ぶと、場面の切り替え（ふわっと・暗転）と、動きながらの拡大を設定できます。</li><li>「◎ スポット」で見せたい所以外を暗く、「▦ ぼかし」で映り込みを隠せます。動くものは「追いかける」で位置を合わせられます。</li></ul>`;
    }
    function bgmBlock() {
      return `${P.bgm ? `<div class="ved-bgm-now">♪ ${esc(P.bgm.name)} <button type="button" class="ved-mini" data-e="bgm-del">外す</button></div>
          <label class="ved-lab">BGM の音量 <b>${Math.round(P.bgm.vol * 100)}%</b></label><input type="range" min="0" max="1" step="0.05" data-p="bgmVol" value="${P.bgm.vol}">
          <label class="ved-chk"><input type="checkbox" data-p="bgmDuck"${P.bgm.duck !== false ? ' checked' : ''}> 声が入っているあいだは小さくする</label>` : ''}
        <p class="ved-note">アプリに入っている曲（自由に使えます）</p>
        <div class="ved-row wrap">${BGM_MOODS.map(([k, l]) => `<button type="button" class="ved-mini" data-e="bgm-make" data-v="${k}">♪ ${l}</button>`).join('')}</div>
        <button type="button" class="ved-mini" data-e="bgm-file">曲のファイルを読み込む</button>
        <p class="ved-note">読み込む曲は、使ってよいもの（購入した音源・利用許諾のある曲）だけにしてください。</p>`;
    }
    function panelSeg(s) {
      const x = L.list.find((y) => y.s.id === s.id);
      const head = s.kind === 'clip' ? '🎞 動画' : s.kind === 'still' ? '⏸ 止めた画面・画像' : s.style === 'end' ? '🏁 エンディング' : '🎬 オープニング';
      let h = `<h3>${head}</h3><p class="ved-note">${esc(s.name || '')} ／ ${fmtT(x?.start)}〜${fmtT(x?.end)}（${r2(segDur(s))}秒）</p>`;
      if (s.kind === 'clip') {
        const m = M.get(s.key);
        h += `<label class="ved-lab">速さ</label><div class="ved-seg-btns">${SPEEDS.map(([v, l]) => `<button type="button" data-p="speed" data-val="${v}" class="${s.speed === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="ved-row"><label>使う所 <input type="number" step="0.1" min="0" data-p="in" value="${r2(s.in)}">〜<input type="number" step="0.1" min="0" data-p="out" value="${r2(s.out)}">秒</label></div>
          <p class="ved-note">元の動画は ${r2(m?.dur || 0)}秒。タイムラインで端をつまんでも調整できます。</p>
          <label class="ved-chk"><input type="checkbox" data-p="mute"${s.mute ? ' checked' : ''}> この動画の音を消す</label>
          ${s.speed !== 1 ? `<label class="ved-chk"><input type="checkbox" data-p="slowSound"${s.slowSound ? ' checked' : ''}> スローのときも音を出す（低い音になります）</label>` : ''}`;
      }
      if (s.kind === 'still' || s.kind === 'card') h += `<div class="ved-row"><label>長さ <input type="number" step="0.1" min="0.3" data-p="dur" value="${r2(s.dur)}">秒</label></div>`;
      if (s.kind === 'card') {
        h += `<label class="ved-lab">タイトル</label><textarea rows="2" data-p="title" maxlength="60">${esc(s.title || '')}</textarea>
          <label class="ved-lab">小さい文字</label><input type="text" data-p="sub" maxlength="60" value="${esc(s.sub || '')}">`;
      } else {
        const pos = (zx, zy, px) => `<label class="ved-lab">左右の位置</label><input type="range" min="0" max="1" step="0.01" data-p="${px}x" value="${zx}"><label class="ved-lab">上下の位置</label><input type="range" min="0" max="1" step="0.01" data-p="${px}y" value="${zy}">`;
        h += `<h3>拡大</h3><label class="ved-chk"><input type="checkbox" data-p="kbOn"${s.kb ? ' checked' : ''}> 動きながら拡大する（はじめ → 終わりへ寄る・引く）</label>
          ${s.kb ? `<div class="ved-row wrap"><button type="button" class="ved-mini" data-e="kb-preset" data-v="in">全体 → 寄る</button><button type="button" class="ved-mini" data-e="kb-preset" data-v="out">寄る → 全体</button></div><p class="ved-note">位置を動かすと、プレビューがはじめ・終わりの画面に切り替わります。</p>` : ''}
          <label class="ved-lab">${s.kb ? 'はじめの拡大' : '拡大'} <b>${r2(s.zoom || 1)}倍</b></label><input type="range" min="1" max="3" step="0.05" data-p="zoom" value="${s.zoom || 1}">
          ${(s.zoom || 1) > 1 || s.kb ? pos(s.zx ?? 0.5, s.zy ?? 0.5, 'z') : ''}
          ${s.kb ? `<label class="ved-lab">終わりの拡大 <b>${r2(s.kb.z)}倍</b></label><input type="range" min="1" max="3" step="0.05" data-p="kbz" value="${s.kb.z}">${pos(s.kb.x, s.kb.y, 'kb')}` : ''}`;
      }
      const idx = P.segs.indexOf(s);
      h += `<h3>${idx === 0 ? 'はじまり方' : '前の場面からの切り替え'}</h3><div class="ved-seg-btns">${TRANS.filter(([k]) => idx > 0 || k !== 'white').map(([k, l]) => `<button type="button" data-p="trType" data-val="${k}" class="${(s.tr?.type || '') === k ? 'on' : ''}">${idx === 0 && k === 'fade' ? '黒から' : l}</button>`).join('')}</div>
        ${s.tr?.type ? `<label class="ved-lab">切り替えの長さ <b>${r2(s.tr.d || 0.6)}秒</b></label><input type="range" min="0.2" max="1.5" step="0.1" data-p="trD" value="${s.tr.d || 0.6}">` : ''}
        ${P.segs.length > 2 ? `<button type="button" class="ved-mini" data-e="tr-all">全部のつなぎ目を同じにする</button>` : ''}`;
      h += `<div class="ved-row wrap"><button type="button" class="ved-mini" data-e="seg-dup">複製</button><button type="button" class="ved-mini" data-e="seg-left">◀ 前へ</button><button type="button" class="ved-mini" data-e="seg-right">後ろへ ▶</button><button type="button" class="ved-mini danger" data-e="del">消す</button></div>`;
      return h;
    }
    function panelText(o) {
      const st = TEXT_STYLES[o.style] || TEXT_STYLES.outline;
      return `<h3>T テロップ</h3>
        <label class="ved-lab">文字（改行もできます）</label><textarea rows="3" data-p="text" maxlength="200">${esc(o.text)}</textarea>
        <label class="ved-lab">形</label><div class="ved-styles">${Object.entries(TEXT_STYLES).map(([k, v]) => `<button type="button" data-p="style" data-val="${k}" class="${o.style === k ? 'on' : ''}" style="--fg:${v.color};--bg:${v.bg || 'transparent'};--st:${v.stroke || 'transparent'}"><span>${v.label}</span></button>`).join('')}</div>
        <label class="ved-lab">文字の色</label>${colorRow(o.color || st.color, 'color')}
        <label class="ved-lab">大きさ <b>${r2(o.size)}</b></label><input type="range" min="2.5" max="16" step="0.25" data-p="size" value="${o.size}">
        <label class="ved-lab">位置</label><div class="ved-row wrap">${[['上', 0.12], ['真ん中', 0.5], ['下', 0.86]].map(([l, y]) => `<button type="button" class="ved-mini" data-e="ov-pos" data-v="${y}">${l}</button>`).join('')}</div>
        <label class="ved-lab">出し方</label><div class="ved-seg-btns">${[['fade', 'ふわっと'], ['none', 'パッと']].map(([k, l]) => `<button type="button" data-p="anim" data-val="${k}" class="${(o.anim || 'fade') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${timing(o)}
        <div class="ved-row wrap"><button type="button" class="ved-mini" data-e="preset-save">この形を型に保存</button><button type="button" class="ved-mini" data-e="ov-dup">複製</button><button type="button" class="ved-mini danger" data-e="del">消す</button></div>`;
    }
    function panelMask(o) {
      const spot = o.type === 'spot';
      return `<h3>${spot ? '◎ スポットライト' : '▦ ぼかし'}</h3>
        ${spot ? `<label class="ved-lab">形</label><div class="ved-seg-btns">${[['ellipse', '丸'], ['rect', '四角']].map(([k, l]) => `<button type="button" data-p="shape" data-val="${k}" class="${(o.shape || 'ellipse') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <label class="ved-lab">まわりの暗さ <b>${Math.round((o.dark ?? 0.62) * 100)}%</b></label><input type="range" min="0.2" max="0.9" step="0.02" data-p="dark" value="${o.dark ?? 0.62}">
          <label class="ved-chk"><input type="checkbox" data-p="ring"${o.ring ? ' checked' : ''}> ふちに線を出す</label>${o.ring ? colorRow(o.c || '#ffd60a') : ''}`
    : `<label class="ved-lab">かけ方</label><div class="ved-seg-btns">${[['blur', 'ぼかし'], ['mosaic', 'モザイク']].map(([k, l]) => `<button type="button" data-p="mode" data-val="${k}" class="${(o.mode || 'blur') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <label class="ved-lab">強さ</label><input type="range" min="4" max="30" step="1" data-p="str" value="${o.str ?? 12}">`}
        <label class="ved-chk"><input type="checkbox" data-p="track"${o.a2 ? ' checked' : ''}> 動くものを追いかける（はじめと終わりで位置を変える）</label>
        ${o.a2 ? `<p class="ved-note">「はじめへ」で枠を合わせ、「終わりへ」でもう一度合わせると、その間をなめらかに動きます。今は<b>${editEnd(o) ? '終わり' : 'はじめ'}の枠</b>を直しています。</p>
          <div class="ved-row"><button type="button" class="ved-mini" data-e="ov-gostart">◀ はじめへ</button><button type="button" class="ved-mini" data-e="ov-goend">終わりへ ▶</button></div>` : ''}
        <label class="ved-lab">出し方</label><div class="ved-seg-btns">${[['fade', 'ふわっと'], ['none', 'パッと']].map(([k, l]) => `<button type="button" data-p="anim" data-val="${k}" class="${(o.anim || 'fade') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${timing(o)}
        <div class="ved-row wrap"><button type="button" class="ved-mini" data-e="ov-dup">複製</button><button type="button" class="ved-mini danger" data-e="del">消す</button></div>`;
    }
    function panelShape(o) {
      const name = { line: '／ 直線', arrow: '↗ 矢印', circle: '◯ 円', angle: '∠ 角度', pen: '✎ 手書き', num: '① 番号' }[o.type];
      return `<h3>${name}</h3>
        <label class="ved-lab">色</label>${colorRow(o.c)}
        ${o.type === 'num' ? `<div class="ved-row"><label>番号 <input type="number" min="0" max="99" data-p="n" value="${o.n}"></label></div><label class="ved-lab">横に出す言葉（任意）</label><input type="text" data-p="label" maxlength="20" value="${esc(o.label || '')}" placeholder="例：腰"><label class="ved-lab">大きさ</label><input type="range" min="0.6" max="2.5" step="0.05" data-p="s" value="${o.s || 1}">`
    : `<label class="ved-lab">太さ</label><input type="range" min="0.4" max="3" step="0.1" data-p="w" value="${o.w || 1}">`}
        ${o.type === 'angle' ? `<p class="ved-note">今の角度：<b>${Math.round(angDeg(o.p))}°</b>（点をつまんで動かせます）</p>` : ''}
        <label class="ved-lab">出し方</label><div class="ved-seg-btns">${[['draw', '描かれる'], ['fade', 'ふわっと'], ['none', 'パッと']].map(([k, l]) => `<button type="button" data-p="anim" data-val="${k}" class="${(o.anim || 'draw') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${timing(o)}
        <div class="ved-row wrap"><button type="button" class="ved-mini" data-e="ov-dup">複製</button><button type="button" class="ved-mini danger" data-e="del">消す</button></div>`;
    }
    function panelNar(n) {
      return `<h3>🎙 ナレーション</h3><p class="ved-note">${fmtT(absStart(n))} から ${r2(n.len)}秒</p>
        <label class="ved-lab">音量 <b>${Math.round((n.vol ?? 1) * 100)}%</b></label><input type="range" min="0" max="1.5" step="0.05" data-p="vol" value="${n.vol ?? 1}">
        <div class="ved-row"><label>始める時間 <input type="number" step="0.1" min="0" data-p="start" value="${r2(absStart(n) ?? 0)}">秒</label></div>
        <p class="ved-note">タイムラインでドラッグしても動かせます。</p>
        <div class="ved-row wrap"><button type="button" class="ved-mini danger" data-e="del">消す</button></div>`;
    }
    function panelBgm() { return `<h3>♪ BGM</h3>${bgmBlock()}`; }

    // 右の欄の入力
    let editSnap = false;
    $('.ved-panel').addEventListener('focusin', () => { editSnap = false; });
    function applyProp(el, val) {
      const k = el.dataset.p; const o = selObj();
      if (!editSnap) { snap(); editSnap = true; }
      if (k === 'origVol') { P.origVol = Number(val); return 'soft'; }
      if (k === 'bgmVol') { P.bgm.vol = Number(val); return 'soft'; }
      if (k === 'bgmDuck') { P.bgm.duck = el.checked; return; }
      if (!o) return;
      if (k === 'start') { const s = Number(val); if (Number.isFinite(s)) anchor(o, s); return; }
      if (['len', 'size', 'w', 's', 'vol', 'zoom', 'zx', 'zy', 'dur', 'n'].includes(k)) { const v = Number(val); if (!Number.isFinite(v)) return 'skip'; o[k] = k === 'len' ? Math.max(0.2, v) : k === 'dur' ? Math.max(0.3, v) : v; return ['size', 'w', 's', 'zoom', 'zx', 'zy', 'vol'].includes(k) ? 'soft' : undefined; }
      if (k === 'in' || k === 'out') {
        const m = M.get(o.key); const v = Number(val); if (!Number.isFinite(v)) return 'skip';
        if (k === 'in') o.in = r2(clamp(v, 0, o.out - 0.1)); else o.out = r2(clamp(v, o.in + 0.1, m?.dur ?? v));
        return;
      }
      if (k === 'speed') { o.speed = Number(val); return; }
      if (k === 'kbOn') { o.kb = el.checked ? { z: Math.min(3, Math.max(1.8, (o.zoom || 1) + 0.8)), x: o.zx ?? 0.5, y: o.zy ?? 0.5 } : null; return; }
      if (k === 'kbz' || k === 'kbx' || k === 'kby') { const v = Number(val); if (!o.kb || !Number.isFinite(v)) return 'skip'; o.kb[k.slice(2)] = v; return 'soft'; }
      if (k === 'trType') { o.tr = val ? { type: val, d: o.tr?.d || 0.6 } : null; return; }
      if (k === 'trD') { if (o.tr) o.tr.d = Number(val); return 'soft'; }
      if (k === 'dark') { o.dark = Number(val); return 'soft'; }
      if (k === 'str') { o.str = Number(val); return 'soft'; }
      if (k === 'ring') { o.ring = el.checked; return; }
      if (k === 'track') { if (el.checked) { o.a2 = { ...o.a }; o.b2 = { ...o.b }; } else { delete o.a2; delete o.b2; } return; }
      if (k === 'mute' || k === 'slowSound') { o[k] = el.checked; return; }
      if (k === 'text' || k === 'title' || k === 'sub' || k === 'label') { o[k] = val; return 'soft'; }
      if (k === 'style') { o.style = val; o.color = ''; return; }
      o[k] = val;
    }
    $('.ved-panel').addEventListener('input', (e) => {
      const el = e.target.closest('[data-p]'); if (!el || el.tagName === 'BUTTON') return;
      const r = applyProp(el, el.type === 'checkbox' ? el.checked : el.value);
      if (r === 'skip') return;
      // 動きながら拡大：はじめ・終わりのどちらを直しているか、プレビューで見えるように
      const so = selObj(); const kp = el.dataset.p;
      if (sel?.kind === 'seg' && so?.kb && ['zoom', 'zx', 'zy', 'kbz', 'kbx', 'kby'].includes(kp)) { layout(); const st = L.starts.get(so.id); seek(kp.startsWith('kb') ? st + segDur(so) - 0.04 : st + 0.01); }
      layout(); dirty(); renderTl();
      const lab = el.previousElementSibling?.querySelector?.('b');
      if (lab && el.type === 'range') { const kk = el.dataset.p; lab.textContent = kk === 'zoom' || kk === 'kbz' ? `${r2(el.value)}倍` : kk === 'size' ? r2(el.value) : kk === 'trD' ? `${r2(el.value)}秒` : `${Math.round(el.value * 100)}%`; }
      if (ready) { clearTimeout(saveTimer); saveTimer = setTimeout(() => kvSet(DRAFT_KEY, JSON.stringify(P)), 800); }
    });
    $('.ved-panel').addEventListener('change', (e) => {
      const el = e.target.closest('[data-p]'); if (!el) return;
      editSnap = false; const keep = document.activeElement; changed();
      if (el.type === 'range' && el.dataset.p === 'zoom') { syncPanel(); } void keep;
    });
    $('.ved-panel').addEventListener('click', (e) => {
      const el = e.target.closest('button[data-p]'); if (!el) return;
      editSnap = false; applyProp(el, el.dataset.val); editSnap = false;
      if (el.dataset.p === 'speed') { const s = selObj(); if (s) { /* 速さを変えても、後ろの文字・線がずれないように場面ごと動く */ } }
      changed(); syncPanel();
    });

    // ===== タイムライン =====
    const tlInner = $('.ved-tl-inner'); const tlScroll = $('.ved-tl-scroll');
    function fitTl() { const w = tlScroll.clientWidth - 40; pps = clamp(w / Math.max(4, L.total || layout().total || 10), 8, 400); $('[data-e="tlzoom"]').value = String(Math.round(Math.log(pps / 8) / Math.log(50) * 100)); }
    function lanesOf(list, spanFn) {
      const lanes = []; const out = new Map();
      [...list].sort((a, b) => (spanFn(a)?.[0] ?? 0) - (spanFn(b)?.[0] ?? 0)).forEach((o) => {
        const sp = spanFn(o); if (!sp) return; let i = lanes.findIndex((end) => end <= sp[0] + 1e-3); if (i < 0) { i = lanes.length; lanes.push(0); }
        lanes[i] = sp[1]; out.set(o.id, i);
      });
      return [out, Math.max(1, lanes.length)];
    }
    const OV_NAME = { text: 'T', line: '／', arrow: '↗', circle: '◯', angle: '∠', pen: '✎', num: '#', spot: '◎', blur: '▦' };
    function renderTl() {
      const total = L.total; const W = Math.max(tlScroll.clientWidth - 4, total * pps + 80);
      const [ovLane, nOv] = lanesOf(P.ovs, ovSpan); const [narLane, nNar] = lanesOf(P.nars, (n) => { const s = absStart(n); return s == null ? null : [s, s + n.len]; });
      const LH = Math.max(nOv, nNar) > 4 ? 16 : 22; const hOv = Math.min(nOv * LH + 6, 110); const hNar = Math.min(nNar * LH + 6, 60);
      wrap.style.setProperty('--tl-ov', `${hOv}px`); wrap.style.setProperty('--tl-nar', `${hNar}px`);
      const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 2 : pps > 10 ? 5 : 10;
      let ruler = ''; for (let t = 0; t <= total + step; t += step) ruler += `<i style="left:${t * pps}px"${Math.abs(t % (step * 2)) < 1e-6 ? ' class="b"' : ''}>${Math.abs(t % (step * 2)) < 1e-6 ? fmtT(t).replace(/\.0$/, '') : ''}</i>`;
      const segs = L.list.map(({ s, start, end }) => {
        const m = M.get(s.key); const th = s.kind === 'card' ? '' : (m?.thumb ? `style="background-image:url(${m.thumb})"` : '');
        const label = s.kind === 'card' ? (s.style === 'end' ? 'エンディング' : 'オープニング') : s.kind === 'still' ? '⏸ 止める' : esc(s.name || '動画');
        return `<div class="ved-seg k-${s.kind}${sel?.kind === 'seg' && sel.id === s.id ? ' sel' : ''}" data-seg="${s.id}" style="left:${start * pps}px;width:${Math.max(4, (end - start) * pps - 2)}px">
          <span class="th" ${th}></span>${s.tr?.type ? `<b class="trm" title="切り替え：${(TRANS.find(([k]) => k === s.tr.type) || [])[1]}">⧓</b>` : ''}${s.kb ? '<em>🔍</em>' : ''}<span class="nm">${label}</span>${s.kind === 'clip' && s.speed !== 1 ? `<em>${s.speed}x</em>` : ''}${s.mute ? '<em>🔇</em>' : ''}
          ${s.kind === 'clip' ? '<i class="hd l" data-h="l"></i>' : ''}<i class="hd r" data-h="r"></i></div>`;
      }).join('');
      const ovs = P.ovs.map((o) => {
        const sp = ovSpan(o); if (!sp) return '';
        const txt = o.type === 'text' ? esc(o.text.split('\n')[0]) : o.type === 'num' ? `${o.n}${o.label ? ` ${esc(o.label)}` : ''}` : o.type === 'angle' ? `${Math.round(angDeg(o.p))}°` : '';
        return `<div class="ved-ov t-${o.type}${sel?.kind === 'ov' && sel.id === o.id ? ' sel' : ''}" data-ov="${o.id}" style="left:${sp[0] * pps}px;width:${Math.max(6, o.len * pps - 1)}px;top:${ovLane.get(o.id) * LH + 3}px;height:${LH - 3}px;line-height:${LH - 5}px;--c:${o.type === 'blur' ? '#8e8e93' : o.type === 'spot' ? '#ffd60a' : (o.c || o.color || '#e2cc9a')}"><b>${OV_NAME[o.type]}</b> ${txt}<i class="hd l" data-h="l"></i><i class="hd r" data-h="r"></i></div>`;
      }).join('');
      const nars = P.nars.map((n) => { const s = absStart(n); if (s == null) return ''; return `<div class="ved-nar${sel?.kind === 'nar' && sel.id === n.id ? ' sel' : ''}" data-nar="${n.id}" style="left:${s * pps}px;width:${Math.max(6, n.len * pps - 1)}px;top:${narLane.get(n.id) * LH + 3}px">🎙 ${r2(n.len)}秒</div>`; }).join('');
      const bgm = P.bgm ? `<div class="ved-bgmbar${sel?.kind === 'bgm' ? ' sel' : ''}" data-bgm="1" style="left:0;width:${Math.max(20, total * pps)}px">♪ ${esc(P.bgm.name)}　${Math.round(P.bgm.vol * 100)}%</div>` : `<button type="button" class="ved-bgm-add" data-e="bgm-open">＋ BGM を入れる</button>`;
      tlInner.style.width = `${W}px`;
      tlInner.innerHTML = `<div class="ved-ruler">${ruler}</div><div class="ved-trk tv">${segs}</div><div class="ved-trk to">${ovs}</div><div class="ved-trk tn">${nars}</div><div class="ved-trk tb">${bgm}</div><div class="ved-ph"><i></i></div>`;
      placePh();
    }
    function placePh() { const ph = tlInner.querySelector('.ved-ph'); if (ph) ph.style.transform = `translateX(${T * pps}px)`; if (playing) { const x = T * pps; if (x < tlScroll.scrollLeft || x > tlScroll.scrollLeft + tlScroll.clientWidth - 30) tlScroll.scrollLeft = x - 40; } }
    const tlT = (e) => (e.clientX - tlInner.getBoundingClientRect().left) / pps;
    // 吸着：再生位置・区間の境目・ほかの文字の端に、近ければくっつける
    function snapT(t, ignore) {
      const tg = [T, 0, L.total, ...L.list.map((x) => x.start)]; P.ovs.forEach((o) => { if (o.id === ignore) return; const sp = ovSpan(o); if (sp) tg.push(sp[0], sp[1]); });
      const th = 7 / pps; let best = t; let bd = th; tg.forEach((x) => { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } });
      return best;
    }
    let tdrag = null;
    tlInner.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (playing) pause();
      const segEl = e.target.closest('[data-seg]'); const ovEl = e.target.closest('[data-ov]'); const narEl = e.target.closest('[data-nar]'); const bgmEl = e.target.closest('[data-bgm]');
      const h = e.target.dataset.h || null; const t0 = tlT(e);
      tlInner.setPointerCapture(e.pointerId);
      if (segEl) { const s = find('seg', segEl.dataset.seg); select('seg', s.id); tdrag = { kind: 'seg', o: s, h, t0, x0: e.clientX, orig: { ...s }, before: JSON.stringify(P), el: tlInner.querySelector(`[data-seg="${s.id}"]`) }; return; }
      if (ovEl) { const o = find('ov', ovEl.dataset.ov); select('ov', o.id); tdrag = { kind: 'ov', o, h, t0, orig: { s: absStart(o), len: o.len }, before: JSON.stringify(P) }; seekIfOutside(o); return; }
      if (narEl) { const n = find('nar', narEl.dataset.nar); select('nar', n.id); tdrag = { kind: 'nar', o: n, t0, orig: { s: absStart(n) }, before: JSON.stringify(P) }; return; }
      if (bgmEl) { select('bgm'); return; }
      select(null); seek(t0); tdrag = { kind: 'seek' };
    });
    function seekIfOutside(o) { const sp = ovSpan(o); if (sp && (T < sp[0] || T >= sp[1])) seek(sp[0] + Math.min(0.3, o.len / 2)); }
    tlInner.addEventListener('pointermove', (e) => {
      if (!tdrag) return; const t = tlT(e);
      if (tdrag.kind === 'seek') { seek(t); return; }
      const d = t - tdrag.t0; tdrag.moved = tdrag.moved || Math.abs(d * pps) > 3;
      if (!tdrag.moved) return;
      if (tdrag.kind === 'seg') {
        const s = tdrag.o; const o0 = tdrag.orig;
        if (tdrag.h === 'l') { s.in = r2(clamp(o0.in + d * s.speed, 0, o0.out - 0.1)); }
        else if (tdrag.h === 'r') { if (s.kind === 'clip') s.out = r2(clamp(o0.out + d * s.speed, o0.in + 0.1, M.get(s.key)?.dur ?? o0.out)); else s.dur = r2(Math.max(0.3, o0.dur + d)); }
        else { tdrag.el.style.transform = `translateX(${d * pps}px)`; tdrag.el.classList.add('drag'); tdrag.reorder = t; return; }
        layout(); renderTl(); seek(T); return;
      }
      if (tdrag.kind === 'ov') {
        const o = tdrag.o; const { s, len } = tdrag.orig;
        if (tdrag.h === 'l') { const ns = clamp(snapT(s + d, o.id), 0, s + len - 0.2); anchor(o, ns); o.len = r2(s + len - ns); }
        else if (tdrag.h === 'r') { const ne = clamp(snapT(s + len + d, o.id), s + 0.2, L.total); o.len = r2(ne - s); }
        else { const ns = clamp(snapT(s + d, o.id), 0, Math.max(0, L.total - 0.1)); anchor(o, ns); }
        renderTl(); syncPanel(); dirty(); return;
      }
      if (tdrag.kind === 'nar') { anchor(tdrag.o, clamp(tdrag.orig.s + d, 0, L.total)); renderTl(); syncPanel(); }
    });
    const tlUp = () => {
      if (!tdrag) return; const dd = tdrag; tdrag = null;
      if (dd.kind === 'seg' && dd.reorder != null && dd.moved) {
        const i = P.segs.indexOf(dd.o); const rest = P.segs.filter((s) => s !== dd.o);
        let acc = 0; let j = rest.length; for (let k = 0; k < rest.length; k++) { const mid = acc + segDur(rest[k]) / 2; if (dd.reorder < mid) { j = k; break; } acc += segDur(rest[k]); }
        rest.splice(j, 0, dd.o); if (j !== i) { undo.push(dd.before); redo = []; P.segs = rest; }
        changed(); return;
      }
      if (dd.moved && dd.before) { undo.push(dd.before); redo = []; changed(); }
    };
    tlInner.addEventListener('pointerup', tlUp); tlInner.addEventListener('pointercancel', tlUp);
    tlScroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPps(pps * Math.exp(-e.deltaY * 0.002)); } }, { passive: false });
    function setPps(v) { pps = clamp(v, 8, 400); $('[data-e="tlzoom"]').value = String(Math.round(Math.log(pps / 8) / Math.log(50) * 100)); renderTl(); }

    // ===== 編集の操作 =====
    function splitAt(t) {
      const x = segAt(t); if (!x || t - x.start < 0.1 || x.end - t < 0.1) return null;
      const s = x.s; const b = { ...s, id: uid() };
      if (s.kind === 'clip') { const st = r2(srcTime(x, t)); s.out = st; b.in = st; } else { const d = t - x.start; b.dur = r2(s.dur - d); s.dur = r2(d); }
      P.segs.splice(P.segs.indexOf(s) + 1, 0, b);
      // 後半に入る文字・線・声は、後半の区間につけ直す
      [...P.ovs, ...P.nars].forEach((o) => { if (o.seg === s.id && o.rel >= t - x.start - 1e-6) { o.seg = b.id; o.rel = r2(o.rel - (t - x.start)); } });
      return b;
    }
    async function freezeAt() {
      const x = segAt(T); if (!x) return;
      if (x.s.kind !== 'clip') { tip('動画の場面で使ってください', 2000); return; }
      const m = M.get(x.s.key); const v = m.video;
      await seekTo(v, srcTime(x, T));
      const c = document.createElement('canvas'); c.width = m.w; c.height = m.h; c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      snap();
      const key = await addBlob(blob); await loadMedia(key);
      const still = { id: uid(), kind: 'still', key, name: `${x.s.name || ''} の ${fmtT(srcTime(x, T))}`, dur: 2, zoom: x.s.zoom, zx: x.s.zx, zy: x.s.zy, from: x.s.id };
      let idx;
      if (T - x.start < 0.1) idx = P.segs.indexOf(x.s);
      else if (x.end - T < 0.1) idx = P.segs.indexOf(x.s) + 1;
      else { splitAt(T); idx = P.segs.indexOf(x.s) + 1; }
      P.segs.splice(idx, 0, still);
      layout(); T = L.starts.get(still.id) + 0.01; select('seg', still.id); changed();
      tip('止めた画面を入れました（2秒）。この上に線や番号を描くと、止まっているあいだ出ます', 3500);
    }
    function deleteSel() {
      if (!sel) return; const o = selObj(); if (!o) return;
      snap();
      if (sel.kind === 'seg') { P.segs = P.segs.filter((s) => s !== o); P.ovs = P.ovs.filter((v) => v.seg !== o.id); P.nars = P.nars.filter((n) => n.seg !== o.id); }
      if (sel.kind === 'ov') P.ovs = P.ovs.filter((v) => v !== o);
      if (sel.kind === 'nar') P.nars = P.nars.filter((v) => v !== o);
      if (sel.kind === 'bgm') P.bgm = null;
      sel = null; changed();
    }
    function addCard(style) {
      snap();
      const s = { id: uid(), kind: 'card', style, dur: style === 'end' ? 2.5 : 3, title: style === 'end' ? 'オルタイムゴルフ' : (P.title || 'ドリル名'), sub: style === 'end' ? 'Online Golf Lesson' : 'All Time Golf ドリル' };
      if (style === 'end') P.segs.push(s); else P.segs.unshift(s);
      layout(); select('seg', s.id); changed(); seek(L.starts.get(s.id) + 1);
      if (style === 'open') setTimeout(() => { const ta = $('.ved-panel textarea'); ta?.focus(); ta?.select(); }, 30);
    }

    // ===== ナレーション =====
    async function startNarr() {
      if (!P.segs.length) return;
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { tip('マイクを使えませんでした。ブラウザでマイクを許可してください', 4000); return; }
      const ask = await modal(`<h3>🎙 ナレーションを録る</h3><p>今の位置（${fmtT(T)}）から動画が流れます。見ながら話してください。もう一度ボタンを押すか、動画の最後で止まります。</p>
        <label class="ved-chk"><input type="checkbox" name="sub" ${window.SpeechRecognition || window.webkitSpeechRecognition ? 'checked' : 'disabled'}> 話した言葉を字幕（テロップ）にする${window.SpeechRecognition || window.webkitSpeechRecognition ? '' : '（このブラウザでは使えません）'}</label>
        <p class="ved-note">録音中は、元の動画の音・BGM は流れません（声に混ざらないように）。字幕はあとで直せます。</p>`, [['cancel', 'やめる'], ['ok', '3秒後に始める']]);
      if (!ask || ask.btn !== 'ok') { stream.getTracks().forEach((t) => t.stop()); return; }
      for (let i = 3; i > 0; i--) { count(i); await new Promise((r) => setTimeout(r, 800)); }
      count(0);
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const t0 = T; recState = { mr, stream, chunks, t0, subs: [], sr: null };
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (ask.data.sub && SR) {
        const sr = new SR(); sr.lang = 'ja-JP'; sr.continuous = true; sr.interimResults = true; let segStart = null;
        sr.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]; if (segStart == null) segStart = Math.max(t0, T - 0.6);
            if (r.isFinal) { const text = r[0].transcript.trim(); if (text) recState?.subs.push({ text, s: segStart, e: T + 0.3 }); segStart = null; }
          }
        };
        sr.onend = () => { if (recState && recState.sr === sr) try { sr.start(); } catch { /* 続けられないときはそのまま */ } };
        try { sr.start(); recState.sr = sr; } catch { /* 字幕なしで続ける */ }
      }
      mr.start(); select(null); play();
      const b = $('[data-e="narr"]'); b.classList.add('on'); b.textContent = '■ 録音を止める';
    }
    async function stopNarr() {
      const r = recState; if (!r) return; recState = null;
      const t1 = Math.min(T, L.total);
      if (r.sr) { const sr = r.sr; r.sr = null; try { sr.stop(); } catch { /* なし */ } }
      await new Promise((res) => { r.mr.onstop = res; r.mr.stop(); });
      r.stream.getTracks().forEach((t) => t.stop());
      pause();
      const b = $('[data-e="narr"]'); b.classList.remove('on'); b.textContent = '🎙 ナレーションを録る';
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
      const len = r2(t1 - r.t0); if (len < 0.3) { tip('短すぎたので入れませんでした', 2000); return; }
      snap();
      const key = await addBlob(blob); await loadMedia(key);
      const n = { id: uid(), key, len, vol: 1 }; layout(); anchor(n, r.t0); P.nars.push(n);
      // 字幕：長い文は短く分けて、話した時間に合わせて並べる
      let added = 0;
      r.subs.forEach(({ text, s, e }) => {
        const parts = splitSub(text); const span = Math.max(0.8, e - s); let at = s;
        parts.forEach((p) => {
          const d = span * p.length / text.length;
          const o = { id: uid(), type: 'text', text: p, x: 0.5, y: 0.86, style: 'dark', size: 4.6, color: '', len: r2(Math.max(0.8, d)), anim: 'none' };
          anchor(o, at); P.ovs.push(o); at += d; added++;
        });
      });
      select('nar', n.id); changed();
      tip(added ? `声を入れました（${len}秒）。字幕を${added}個つけました` : `声を入れました（${len}秒）`, 3000);
    }
    function splitSub(text) {
      const max = 16; const out = []; let cur = '';
      text.replace(/\s+/g, ' ').split(/(?<=[、。！？!?])/).forEach((piece) => {
        if ((cur + piece).length <= max) cur += piece; else { if (cur) out.push(cur); while (piece.length > max) { out.push(piece.slice(0, max)); piece = piece.slice(max); } cur = piece; }
      });
      if (cur.trim()) out.push(cur);
      return out.map((s) => s.trim()).filter(Boolean);
    }
    function count(n) { const el = $('.ved-count'); el.hidden = !n; el.textContent = n || ''; }

    // ===== BGM =====
    async function setBgm(blob, name) {
      snap(); const key = await addBlob(blob); await loadMedia(key);
      P.bgm = { key, name, vol: P.bgm?.vol ?? 0.35, duck: P.bgm?.duck ?? true }; select('bgm'); changed();
    }

    // ===== 書き出し =====
    async function decodeAudio(key, actx) {
      const blob = B.get(key) || await kvGet(`b:${key}`); if (!blob) return null;
      try { return await actx.decodeAudioData(await blob.arrayBuffer()); } catch { return null; }
    }
    async function renderAudio(total) {
      const sr = 48000; const len = Math.max(1, Math.ceil(total * sr));
      const actx = new OfflineAudioContext(2, len, sr); const cache = new Map();
      const get = async (key) => { if (!cache.has(key)) cache.set(key, await decodeAudio(key, actx)); return cache.get(key); };
      for (const x of L.list) {
        const s = x.s; if (s.kind !== 'clip' || s.mute || (s.speed !== 1 && !s.slowSound) || P.origVol <= 0) continue;
        const buf = await get(s.key); if (!buf) continue;
        const src = actx.createBufferSource(); src.buffer = buf; src.playbackRate.value = s.speed;
        const g = actx.createGain(); g.gain.value = P.origVol; src.connect(g); g.connect(actx.destination);
        src.start(x.start, s.in, s.out - s.in);
      }
      for (const n of P.nars) {
        const st = absStart(n); if (st == null) continue; const buf = await get(n.key); if (!buf) continue;
        const src = actx.createBufferSource(); src.buffer = buf; const g = actx.createGain(); g.gain.value = n.vol ?? 1;
        src.connect(g); g.connect(actx.destination); src.start(st, 0, Math.min(n.len, buf.duration));
      }
      if (P.bgm && P.bgm.vol > 0) {
        const buf = await get(P.bgm.key);
        if (buf) {
          const src = actx.createBufferSource(); src.buffer = buf; src.loop = true; const g = actx.createGain();
          src.connect(g); g.connect(actx.destination);
          for (let t = 0; t <= total; t += 0.05) g.gain.setValueAtTime(bgmGain(t), t);
          src.start(0); src.stop(total);
        }
      }
      return actx.startRendering();
    }
    async function pickVideoCodec(W, H, bitrate) {
      for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f']) {
        try { const s = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate, framerate: FPS }); if (s.supported) return codec; } catch { /* 次を試す */ }
      }
      return null;
    }
    async function exportVideo(onProg, signal) {
      layout(); const [W, H] = dims(); const total = L.total;
      const { Muxer, ArrayBufferTarget } = await import(MUXER_URL);
      const bitrate = P.size === 'hd' ? 8e6 : 4.5e6;
      const vcodec = await pickVideoCodec(W, H, bitrate); if (!vcodec) throw new Error('このブラウザでは mp4 に書き出せません。パソコンの Chrome をお使いください');
      onProg(0, '切り替えの準備をしています…'); await ensureSnaps();
      onProg(0, '音をまとめています…');
      const audio = await renderAudio(total);
      let acodec = null;
      for (const [c, mc] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        try { if ((await AudioEncoder.isConfigSupported({ codec: c, sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported) { acodec = [c, mc]; break; } } catch { /* 次を試す */ }
      }
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: FPS }, ...(acodec ? { audio: { codec: acodec[1], numberOfChannels: 2, sampleRate: 48000 } } : {}), fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
      let err = null;
      const venc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: (e) => { err = e; } });
      venc.configure({ codec: vcodec, width: W, height: H, bitrate, framerate: FPS, latencyMode: 'quality' });
      const c = document.createElement('canvas'); c.width = W; c.height = H; const cx = c.getContext('2d', { willReadFrequently: false });
      const n = Math.max(1, Math.round(total * FPS)); let lastKey = ''; const t0 = performance.now();
      if (playing) pause();
      for (let i = 0; i < n; i++) {
        if (signal.aborted) throw new DOMException('中止しました', 'AbortError'); if (err) throw err;
        const t = Math.min(total - 1e-4, (i + 0.5) / FPS); const x = segAt(t);
        if (x && x.s.kind === 'clip') { const m = M.get(x.s.key); const want = clamp(srcTime(x, t), 0, m.dur - 0.01); const k = `${x.s.key}:${want.toFixed(3)}`; if (k !== lastKey) { await seekTo(m.video, want); lastKey = k; } }
        renderFrame(cx, W, H, t, false);
        const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
        while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
        if (i % 5 === 0) { const el = (performance.now() - t0) / 1000; const rest = el / (i + 1) * (n - i - 1); onProg((i + 1) / n * 0.92, `映像を作っています… ${Math.round((i + 1) / n * 100)}%（あと約${Math.ceil(rest)}秒）`); }
      }
      await venc.flush(); venc.close();
      if (acodec) {
        onProg(0.94, '音を入れています…');
        const aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: (e) => { err = e; } });
        aenc.configure({ codec: acodec[0], sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
        const L0 = audio.getChannelData(0); const R0 = audio.getChannelData(1); const step = 1024;
        for (let i = 0; i < audio.length; i += step) {
          const len = Math.min(step, audio.length - i); const data = new Float32Array(len * 2); data.set(L0.subarray(i, i + len), 0); data.set(R0.subarray(i, i + len), len);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round(i / 48000 * 1e6), data });
          aenc.encode(ad); ad.close();
          if (aenc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 2));
        }
        await aenc.flush(); aenc.close();
      }
      if (err) throw err;
      muxer.finalize(); onProg(1, 'できあがりました');
      return new Blob([target.buffer], { type: 'video/mp4' });
    }
    async function doExport() {
      if (!P.segs.length) { tip('先に動画を追加してください', 2000); return; }
      if (playing) pause(); if (recState) await stopNarr();
      const pick = await modal(`<h3>書き出す</h3><p>全体の長さ：<b>${fmtT(L.total)}</b></p>
        <label class="ved-lab">画質</label>
        <label class="ved-chk"><input type="radio" name="size" value="sd" ${P.size !== 'hd' ? 'checked' : ''}> 標準（720p）… スマホで見るならこれで十分。ファイルが小さく、早くできます</label>
        <label class="ved-chk"><input type="radio" name="size" value="hd" ${P.size === 'hd' ? 'checked' : ''}> 高画質（1080p）</label>
        <p class="ved-note">書き出し中はこの画面を開いたままにしてください。目安は動画の長さと同じくらいの時間です。</p>`, [['cancel', 'やめる'], ['ok', '書き出す']]);
      if (!pick || pick.btn !== 'ok') return;
      P.size = pick.data.size === 'hd' ? 'hd' : 'sd'; changed();
      const ac = new AbortController();
      const box = $('.ved-modal'); box.hidden = false;
      box.innerHTML = `<div class="ved-dlg"><h3>書き出しています</h3><p class="ved-prog-msg">準備しています…</p><div class="ved-meter"><i></i></div><div class="ved-dlg-btns"><button type="button" class="ved-ghost" data-x="abort">中止する</button></div></div>`;
      box.querySelector('[data-x="abort"]').onclick = () => ac.abort();
      try {
        const blob = await exportVideo((r, msg) => { box.querySelector('.ved-meter i').style.width = `${Math.round(r * 100)}%`; box.querySelector('.ved-prog-msg').textContent = msg; }, ac.signal);
        fitCanvas(); seek(T);
        const url = URL.createObjectURL(blob); const mb = Math.round(blob.size / 1048576 * 10) / 10;
        box.innerHTML = `<div class="ved-dlg wide"><h3>できあがりました（${mb}MB）</h3><video src="${url}" controls playsinline class="ved-out"></video>
          <div class="ved-dlg-btns"><button type="button" class="ved-ghost" data-x="back">編集に戻る</button><a class="ved-ghost" href="${url}" download="${esc((P.title || 'ドリル動画').replace(/[\\/:*?"<>|]/g, ''))}.mp4">パソコンに保存</a><button type="button" class="ved-go" data-x="use">この動画を使う</button></div></div>`;
        box.querySelector('[data-x="back"]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
        box.querySelector('[data-x="use"]').onclick = () => finish(new File([blob], `drill-${Date.now()}.mp4`, { type: 'video/mp4' }));
      } catch (e) {
        box.innerHTML = `<div class="ved-dlg"><h3>${e.name === 'AbortError' ? '中止しました' : '書き出せませんでした'}</h3><p>${esc(e.name === 'AbortError' ? '編集の内容はそのまま残っています。' : (e.message || String(e)))}</p><div class="ved-dlg-btns"><button type="button" class="ved-go" data-x="back">編集に戻る</button></div></div>`;
        box.querySelector('[data-x="back"]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
        if (e.name !== 'AbortError') console.error(e);
      }
    }

    // ===== 小さな部品 =====
    let tipTimer = 0;
    function tip(msg, ms = 2000) { const el = $('.ved-tip'); el.textContent = msg; el.hidden = false; clearTimeout(tipTimer); if (ms) tipTimer = setTimeout(() => { el.hidden = true; }, ms); }
    function modal(html, btns) {
      return new Promise((res) => {
        const box = $('.ved-modal'); box.hidden = false;
        box.innerHTML = `<form class="ved-dlg">${html}<div class="ved-dlg-btns">${btns.map(([k, l], i) => `<button type="${i === btns.length - 1 ? 'submit' : 'button'}" data-x="${k}" class="${i === btns.length - 1 ? 'ved-go' : 'ved-ghost'}">${l}</button>`).join('')}</div></form>`;
        const f = box.querySelector('form');
        const done = (btn) => { const data = {}; f.querySelectorAll('input[name]').forEach((i) => { if (i.type === 'checkbox') data[i.name] = i.checked; else if (i.type === 'radio') { if (i.checked) data[i.name] = i.value; } else data[i.name] = i.value; }); box.hidden = true; box.innerHTML = ''; res({ btn, data }); };
        f.addEventListener('submit', (e) => { e.preventDefault(); done(btns[btns.length - 1][0]); });
        f.querySelectorAll('button[type=button]').forEach((b) => { b.onclick = () => done(b.dataset.x); });
      });
    }
    function showHelp() {
      modal(`<h3>⌨ 使い方とショートカット</h3>
        <div class="ved-help"><div><h4>基本の流れ</h4><ol><li>「＋ 動画・画像を追加」で動画を読み込む（複数可）</li><li>タイムラインで並べ替え・端をつまんでカット、「✂ 分ける」でいらない所を分けて消す</li><li>見せたい場面で「⏸ ここで止める」→ 線・番号・角度を描く</li><li>テロップを入れる（右の欄で形・大きさ・出す時間）</li><li>「🎙 ナレーションを録る」で声と字幕を入れる</li><li>BGM を選んで「書き出す」</li></ol></div>
        <div><h4>ショートカット</h4><table>${[['スペース', '再生・一時停止'], ['← / →', '1コマ戻す・進める'], ['Shift + ← / →', '1秒戻す・進める'], ['Home / End', '最初・最後へ'], ['S', '今の位置で分ける'], ['F', 'ここで止める（静止画を入れる）'], ['R', 'ナレーションを録る・止める'], ['Delete', '選んだものを消す'], ['Ctrl + Z', '元に戻す'], ['Ctrl + Shift + Z', 'やり直す'], ['Ctrl + D', '選んだものを複製'], ['V T L A O G P N H B', '道具の切り替え'], ['Ctrl + ホイール', 'タイムラインの拡大・縮小']].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div></div>
        <p class="ved-note">編集中の内容は、このパソコンのブラウザに自動で保存されます（別のパソコンでは続きを開けません）。</p>`, [['ok', '閉じる']]);
    }
    function dup() {
      const o = selObj(); if (!o || sel.kind === 'bgm' || sel.kind === 'nar') return;
      snap(); const c = JSON.parse(JSON.stringify(o)); c.id = uid();
      if (sel.kind === 'seg') { P.segs.splice(P.segs.indexOf(o) + 1, 0, c); }
      else { const sp = ovSpan(o); P.ovs.push(c); if (sp) anchor(c, Math.min(sp[1], L.total - 0.2)); }
      select(sel.kind, c.id); changed();
    }
    function finish(file) {
      if (closed) return; closed = true;
      cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('keydown', onKey);
      if (recState) { try { recState.mr.stop(); recState.stream.getTracks().forEach((t) => t.stop()); } catch { /* なし */ } }
      M.forEach((m) => { m.video?.pause(); m.grab?.pause(); m.audio?.pause(); if (m.url) URL.revokeObjectURL(m.url); });
      clearTimeout(saveTimer); if (ready) kvSet(DRAFT_KEY, JSON.stringify(P));
      wrap.remove(); document.body.classList.remove('rec-open');
      resolve(file || null);
    }

    // ===== ボタン =====
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-e]'); if (!b || b.tagName === 'SELECT' || b.type === 'range') return;
      const k = b.dataset.e;
      if (k === 'close') finish(null);
      else if (k === 'add') $('.ved-file').click();
      else if (k === 'play') { if (recState) { stopNarr(); return; } if (playing) pause(); else play(); }
      else if (k === 'step') { if (playing) pause(); seek(T + Number(b.dataset.v) * (b.dataset.fast ? 1 : 1 / FPS)); }
      else if (k === 'tool') setTool(b.dataset.v);
      else if (k === 'undo') { if (undo.length) { redo.push(JSON.stringify(P)); restore(undo.pop()); } }
      else if (k === 'redo') { if (redo.length) { undo.push(JSON.stringify(P)); restore(redo.pop()); } }
      else if (k === 'split') { if (playing) pause(); snap(); if (splitAt(T)) { changed(); tip('分けました。いらない方を選んで「消す」', 2500); } else undo.pop(); }
      else if (k === 'freeze') { if (playing) pause(); freezeAt(); }
      else if (k === 'del') deleteSel();
      else if (k === 'clear-lines') {
        const isLine = (o) => o.type !== 'text' && !MASKS.includes(o.type);
        const all = P.ovs.filter(isLine);
        if (!all.length) { tip('消す線がありません', 1800); return; }
        const here = all.filter((o) => { const sp = ovSpan(o); return sp && T >= sp[0] - 1e-6 && T < sp[1]; });
        const btns = here.length && here.length < all.length ? [['cancel', 'やめる'], ['all', `動画全体の線を消す（${all.length}個）`], ['here', `今の場面の線だけ消す（${here.length}個）`]] : [['cancel', 'やめる'], ['all', `線を全部消す（${all.length}個）`]];
        const r = await modal('<h3>描いた線を消しますか？</h3><p>線・矢印・円・角度・手書き・番号を消します（テロップ・スポット・ぼかしは残ります）。消したあとでも「↶ 1つ戻す」で元に戻せます。</p>', btns);
        if (!r || r.btn === 'cancel') return;
        const del = new Set((r.btn === 'here' ? here : all).map((o) => o.id));
        snap(); P.ovs = P.ovs.filter((o) => !del.has(o.id)); if (sel?.kind === 'ov' && del.has(sel.id)) sel = null; anglePts = []; draft = null;
        changed(); tip(`${del.size}個の線を消しました`, 1800);
      }
      else if (k === 'narr') { if (recState) stopNarr(); else { if (playing) pause(); startNarr(); } }
      else if (k === 'card') addCard(b.dataset.v);
      else if (k === 'export') doExport();
      else if (k === 'help') showHelp();
      else if (k === 'new') {
        const r = await modal('<h3>新しく作りますか？</h3><p>今の編集内容は消えます（元に戻せません）。</p>', [['cancel', 'やめる'], ['ok', '新しく作る']]);
        if (r?.btn !== 'ok') return; if (playing) pause();
        await kvClear(); M.forEach((m) => { m.video?.remove(); if (m.url) URL.revokeObjectURL(m.url); }); M.clear(); B.clear();
        P = blank(); undo = []; redo = []; sel = null; T = 0; changed();
      }
      else if (k === 'ov-gostart' || k === 'ov-goend') { const o = selObj(); const s0 = o && absStart(o); if (s0 != null) { seek(k === 'ov-gostart' ? s0 + 0.01 : s0 + o.len - 0.04); syncPanel(); } }
      else if (k === 'kb-preset') {
        const o = selObj(); if (!o) return; snap();
        const cx = o.kb?.x ?? o.zx ?? 0.5; const cy = o.kb?.y ?? o.zy ?? 0.5; const z = Math.max(1.8, o.kb?.z ?? 2, o.zoom > 1 ? o.zoom : 0);
        if (b.dataset.v === 'in') { o.zoom = 1; o.zx = 0.5; o.zy = 0.5; o.kb = { z, x: cx, y: cy }; } else { o.zoom = z; o.zx = cx; o.zy = cy; o.kb = { z: 1, x: 0.5, y: 0.5 }; }
        changed(); syncPanel(); const st = L.starts.get(o.id); seek(st + 0.01);
      }
      else if (k === 'tr-all') { const o = selObj(); if (!o) return; snap(); const tr = o.tr ? { ...o.tr } : null; P.segs.forEach((x, i) => { if (i > 0) x.tr = tr ? { ...tr } : null; }); changed(); tip(tr ? '全部のつなぎ目に同じ切り替えを入れました' : '全部のつなぎ目の切り替えを外しました', 2000); }
      else if (k === 'ov-tohere') { const o = selObj(); if (o) { snap(); anchor(o, T); changed(); } }
      else if (k === 'ov-toseg') { const o = selObj(); const x = segAt(T); if (o && x) { snap(); anchor(o, x.start); o.len = r2(x.end - x.start); changed(); } }
      else if (k === 'ov-pos') { const o = selObj(); if (o) { snap(); o.y = Number(b.dataset.v); o.x = 0.5; changed(); } }
      else if (k === 'ov-dup' || k === 'seg-dup') dup();
      else if (k === 'seg-left' || k === 'seg-right') { const o = selObj(); const i = P.segs.indexOf(o); const j = i + (k === 'seg-left' ? -1 : 1); if (o && j >= 0 && j < P.segs.length) { snap(); P.segs.splice(i, 1); P.segs.splice(j, 0, o); changed(); } }
      else if (k === 'preset-save') {
        const o = selObj(); if (!o) return;
        const r = await modal(`<h3>テロップの型に保存</h3><label class="ved-lab">型の名前</label><input type="text" name="name" maxlength="20" value="${esc(TEXT_STYLES[o.style]?.label || '型')}"><label class="ved-chk"><input type="checkbox" name="def" checked> 新しいテロップをこの形にする</label>`, [['cancel', 'やめる'], ['ok', '保存する']]);
        if (r?.btn !== 'ok') return; if (r.data.def) presets.forEach((x) => { x.def = false; });
        presets.push({ name: r.data.name || '型', style: o.style, size: o.size, color: o.color || '', def: !!r.data.def });
        try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch { /* 保存できなくても続ける */ }
        tip('型を保存しました', 1500);
      }
      else if (k === 'preset-def') { const i = Number(b.dataset.v); const was = presets[i].def; presets.forEach((x) => { x.def = false; }); presets[i].def = !was; try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch { /* なし */ } syncPanel(); }
      else if (k === 'preset-del') { presets.splice(Number(b.dataset.v), 1); try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch { /* なし */ } syncPanel(); }
      else if (k === 'bgm-open') select('bgm');
      else if (k === 'bgm-file') $('.ved-bgmfile').click();
      else if (k === 'bgm-del') { snap(); P.bgm = null; sel = null; changed(); }
      else if (k === 'bgm-make') {
        const label = BGM_MOODS.find(([m]) => m === b.dataset.v)?.[1] || ''; b.disabled = true; tip('曲を用意しています…', 0);
        try { const blob = await makeBgm(b.dataset.v); await setBgm(blob, `アプリの曲（${label}）`); tip('BGM を入れました。再生して確かめてください', 2500); } catch (err) { tip('曲を作れませんでした', 3000); console.error(err); }
        b.disabled = false;
      }
    });
    $('[data-e="orient"]').addEventListener('change', (e) => { snap(); P.orient = e.target.value; changed(); });
    $('[data-e="tlzoom"]').addEventListener('input', (e) => setPps(8 * 50 ** (Number(e.target.value) / 100)));
    $('.ved-file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('.ved-bgmfile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await setBgm(f, f.name); });
    const stage = $('.ved-stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
    stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('drop'); addFiles(e.dataTransfer.files); });

    function onKey(e) {
      if (closed || !$('.ved-modal').hidden) return;
      const typing = e.target.closest?.('input,textarea,select,[contenteditable]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); wrap.querySelector(`[data-e="${e.shiftKey ? 'redo' : 'undo'}"]`).click(); return; }
      if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); wrap.querySelector('[data-e="redo"]').click(); return; }
      if (mod && e.key.toLowerCase() === 'd') { if (typing) return; e.preventDefault(); dup(); return; }
      if (typing || mod || e.altKey) return;
      const key = e.key;
      if (key === ' ') { e.preventDefault(); $('[data-e="play"]').click(); }
      else if (key === 'ArrowLeft' || key === 'ArrowRight') { e.preventDefault(); if (playing) pause(); seek(T + (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS)); }
      else if (key === 'Home') seek(0); else if (key === 'End') seek(L.total);
      else if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteSel(); }
      else if (key === 'Escape') { if (anglePts.length || draft) { anglePts = []; draft = null; dirty(); } else select(null); }
      else {
        const k = key.toLowerCase();
        if (k === 's') $('[data-e="split"]').click(); else if (k === 'f') $('[data-e="freeze"]').click(); else if (k === 'r') $('[data-e="narr"]').click();
        else { const t = TOOLS.find((x) => x[3].toLowerCase() === k); if (t) setTool(t[0]); }
      }
    }
    window.addEventListener('keydown', onKey);

    // ===== はじめ：下書きがあれば続きから =====
    (async () => {
      changed();
      const saved = await kvGet(DRAFT_KEY); let draftP = null; try { draftP = saved && JSON.parse(saved); } catch { /* 壊れていたら新しく */ }
      if (draftP?.segs?.length) {
        const r = await modal(`<h3>前回の続きがあります</h3><p>動画 ${draftP.segs.length}個・テロップや線 ${draftP.ovs.length}個${draftP.nars.length ? `・声 ${draftP.nars.length}個` : ''}（全体 ${fmtT(draftP.segs.reduce((t, s) => t + segDur(s), 0))}）</p>`, [['new', '新しく作る'], ['ok', '続きから編集する']]);
        if (r?.btn === 'ok') {
          tip('読み込んでいます…', 0);
          const keys = new Set([...draftP.segs.map((s) => s.key), ...draftP.nars.map((n) => n.key), draftP.bgm?.key].filter(Boolean));
          for (const k of keys) { try { await loadMedia(k); } catch { /* 読み込めない素材は飛ばす */ } }
          draftP.segs = draftP.segs.filter((s) => s.kind === 'card' || M.has(s.key)); draftP.nars = draftP.nars.filter((n) => M.has(n.key)); if (draftP.bgm && !M.has(draftP.bgm.key)) draftP.bgm = null;
          P = draftP; if (title && !P.title) P.title = title; $('[data-e="orient"]').value = P.orient || 'v';
          ready = true; layout(); fitTl(); changed(); seek(0); tip('前回の続きを開きました', 1500);
          return;
        }
        await kvClear();
      }
      P = blank(); $('[data-e="orient"]').value = 'v'; ready = true; changed();
    })();
  });
}
