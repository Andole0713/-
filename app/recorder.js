// 解説動画レコーダー（スタッフ用）
// 会員が送った動画を再生しながら、線・矢印・円・角度を書き込み、マイクで話した声と一緒に録画する。
// 画面（canvas）をそのまま録るので、編集ソフトを使わずに1本の解説動画ができる。
// openRecorder({ src, title }) → 使うと決めた動画の Blob（やめたら null）

const COLORS = ['#ff3b30', '#ffd60a', '#ffffff', '#0a84ff'];
const TOOLS = [['move', '✥', '動かす'], ['pen', '✎', 'ペン'], ['line', '／', '直線'], ['arrow', '↗', '矢印'], ['circle', '○', '円'], ['angle', '∠', '角度']];
const MAX_SEC = 600; // 録画は10分まで

// 録画に使える形式（mp4 を優先。会員の iPhone でもそのまま再生できる）
function pickMime() {
  const list = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export function canRecord() {
  return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && navigator.mediaDevices?.getUserMedia && pickMime());
}

export function openRecorder({ src, title = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'rec';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', '解説動画を作る');
    wrap.innerHTML = `
      <div class="rec-top"><b>🎙 解説動画を作る</b><span class="rec-sub">${esc(title)}</span><button type="button" class="rec-x" data-r="close" aria-label="閉じる">×</button></div>
      <div class="rec-stage"><canvas class="rec-cv"></canvas><div class="rec-load">動画を読み込んでいます…</div>
        <div class="rec-badge" hidden><i></i>録画中 <b class="rec-time">0:00</b></div>
        <div class="rec-tip" hidden></div></div>
      <div class="rec-bar">
        <div class="rec-row">
          <button type="button" data-r="play" class="rec-play" aria-label="再生・一時停止">▶</button>
          <span class="rec-grp">${[[0.25, '¼'], [0.5, '½'], [1, '等速']].map(([r, l]) => `<button type="button" data-r="rate" data-v="${r}" class="${r === 1 ? 'on' : ''}">${l}</button>`).join('')}</span>
          <span class="rec-grp"><button type="button" data-r="step" data-v="-1" aria-label="1コマ戻す">◀</button><button type="button" data-r="step" data-v="1" aria-label="1コマ進める">▶</button></span>
          <span class="rec-grp zoom"><button type="button" data-r="zoom" data-v="-1" aria-label="縮小">－</button><button type="button" data-r="zoom" data-v="0" class="rec-zv" title="全体を表示">1.0倍</button><button type="button" data-r="zoom" data-v="1" aria-label="拡大">＋</button></span>
          <input type="range" class="rec-seek" min="0" max="1000" value="0" aria-label="再生位置">
        </div>
        <div class="rec-row">
          <span class="rec-grp tools">${TOOLS.map(([k, ic, l]) => `<button type="button" data-r="tool" data-v="${k}" class="${k === 'pen' ? 'on' : ''}" title="${l}"><b>${ic}</b><small>${l}</small></button>`).join('')}</span>
          <span class="rec-grp">${COLORS.map((c, i) => `<button type="button" data-r="color" data-v="${c}" class="sw${i === 0 ? ' on' : ''}" style="--c:${c}" aria-label="色"></button>`).join('')}</span>
          <span class="rec-grp"><button type="button" data-r="del" hidden>選んだものを消す</button><button type="button" data-r="undo">元に戻す</button><button type="button" data-r="clear">全部消す</button></span>
        </div>
        <div class="rec-row rec-main">
          <button type="button" data-r="rec" class="rec-go">● 録画を始める</button>
          <span class="rec-hint">「✥ 動かす」で、書いた線や円をつかんで移動、端をつまんで長さ・大きさ・角度を変えられます。＋－で拡大・縮小（2本指でつまむ・マウスのホイールでも）。拡大中は「✥ 動かす」で何もない所をドラッグすると、見る場所を動かせます。録画中も操作できます。</span>
        </div>
      </div>
      <div class="rec-review" hidden>
        <video class="rec-out" controls playsinline></video>
        <div class="rec-review-btns"><button type="button" data-r="retake" class="rec-sub-btn">撮り直す</button><button type="button" data-r="use" class="rec-use">この動画を使う</button></div>
      </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('rec-open');

    const cv = wrap.querySelector('.rec-cv'); const ctx = cv.getContext('2d');
    const video = document.createElement('video');
    video.playsInline = true; video.muted = true; video.preload = 'auto';
    const $ = (s) => wrap.querySelector(s);
    let tool = 'pen'; let color = COLORS[0];
    const shapes = []; let draft = null; let anglePts = [];
    // 「元に戻す」用に、書き込み・移動・削除の前の状態を残す
    const history = [];
    const snap = () => { history.push(JSON.stringify(shapes)); if (history.length > 60) history.shift(); };
    // 拡大・縮小：z 倍で、動画の (cx, cy) を画面の真ん中に映す。view は今の表示、aim は向かう先（ボタンのときはなめらかに寄る）
    const view = { z: 1, cx: 0, cy: 0 }; const aim = { z: 1, cx: 0, cy: 0 };
    const ZMAX = 4;
    let sel = null; let drag = null; // 動かす：選んでいる図形と、つかんでいる場所
    let rec = null; let chunks = []; let mic = null; let t0 = 0; let timer = null; let outUrl = ''; let objUrl = ''; let raf = 0; let closed = false;

    // 動画は一度ダウンロードしてから使う（別のサーバーの動画のままだと、画面を録画できないため）
    fetch(src).then((r) => r.blob()).then((b) => {
      objUrl = URL.createObjectURL(b); video.src = objUrl;
    }).catch(() => { $('.rec-load').textContent = '動画を読み込めませんでした。閉じて、もう一度お試しください。'; });
    video.addEventListener('loadedmetadata', () => {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      cv.width = Math.round(video.videoWidth * scale / 2) * 2; cv.height = Math.round(video.videoHeight * scale / 2) * 2;
      $('.rec-load').hidden = true;
      view.cx = aim.cx = cv.width / 2; view.cy = aim.cy = cv.height / 2;
      fit();
      video.currentTime = 0.05;
    });
    // 画面（表示エリア）にちょうど収まる大きさで表示する。縦長の動画でも下がはみ出さないように
    const stage = $('.rec-stage');
    function fit() {
      if (!cv.width) return;
      const pad = 16;
      const w = Math.max(50, stage.clientWidth - pad); const h = Math.max(50, stage.clientHeight - pad);
      const k = Math.min(w / cv.width, h / cv.height);
      cv.style.width = `${Math.floor(cv.width * k)}px`; cv.style.height = `${Math.floor(cv.height * k)}px`;
    }
    const ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    ro?.observe(stage);
    window.addEventListener('resize', fit);

    // 線の太さは画面上での太さ。拡大しても太くならないように倍率で割る
    const lw = () => Math.max(4, cv.width / 110) / view.z;
    function arrowHead(a, b) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x); const s = lw() * 4;
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - s * Math.cos(ang - 0.45), b.y - s * Math.sin(ang - 0.45));
      ctx.lineTo(b.x - s * Math.cos(ang + 0.45), b.y - s * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    }
    function label(text, x, y) {
      ctx.font = `700 ${Math.round(lw() * 6.5)}px sans-serif`;
      const w = ctx.measureText(text).width; const h = lw() * 8;
      // 画面の端で切れないように、枠の中に収める
      x = Math.max(-8, Math.min(x, cv.width - w - 24)); y = Math.max(h + 2, Math.min(y, cv.height - 6));
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(x + 8, y - h, w + 14, h + 4);
      ctx.fillStyle = '#fff'; ctx.fillText(text, x + 15, y - lw());
    }
    function drawShape(s) {
      ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = lw(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = lw();
      if (s.t === 'pen') { ctx.beginPath(); s.p.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); }
      if (s.t === 'line' || s.t === 'arrow') { ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); ctx.stroke(); if (s.t === 'arrow') arrowHead(s.a, s.b); }
      if (s.t === 'circle') { ctx.beginPath(); ctx.arc(s.a.x, s.a.y, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0, Math.PI * 2); ctx.stroke(); }
      if (s.t === 'angle') {
        const [a, b, c] = s.p;
        // 途中（1点目・2点目だけ）のときは、置いた点と線だけを出す
        s.p.forEach((q) => { ctx.beginPath(); ctx.arc(q.x, q.y, lw() * 1.4, 0, Math.PI * 2); ctx.fill(); });
        if (!b) { ctx.shadowBlur = 0; return; }
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); if (c) ctx.lineTo(c.x, c.y); ctx.stroke();
        if (c) {
          const a1 = Math.atan2(a.y - b.y, a.x - b.x); const a2 = Math.atan2(c.y - b.y, c.x - b.x);
          let d = Math.abs(a1 - a2) * 180 / Math.PI; if (d > 180) d = 360 - d;
          ctx.beginPath(); ctx.arc(b.x, b.y, lw() * 6, Math.min(a1, a2), Math.max(a1, a2), Math.abs(a1 - a2) > Math.PI); ctx.stroke();
          ctx.shadowBlur = 0; label(`${Math.round(d)}°`, b.x, b.y);
        }
      }
      ctx.shadowBlur = 0;
    }
    function frame() {
      if (closed) return;
      // 次の描画を先に予約する（1つの図形でエラーが起きても、画面が止まらないように）
      raf = requestAnimationFrame(frame);
      try { draw(); } catch (err) { console.error(err); }
    }
    function draw() {
      if (video.readyState >= 2 && cv.width) {
        ease();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (view.z > 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); }
        ctx.setTransform(view.z, 0, 0, view.z, cv.width / 2 - view.z * view.cx, cv.height / 2 - view.z * view.cy);
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        shapes.forEach(drawShape);
        if (draft) drawShape(draft);
        if (anglePts.length) drawShape({ t: 'angle', c: color, p: anglePts });
        // 選んでいる図形の「つまみ」（録画中は映らないように出さない）
        if (tool === 'move' && sel && shapes.includes(sel) && !(rec && rec.state === 'recording')) {
          handles(sel).forEach((h) => { ctx.beginPath(); ctx.arc(h.x, h.y, lw() * 2.8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2 / view.z; ctx.strokeStyle = '#111'; ctx.stroke(); });
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (!$('.rec-seek').matches(':active') && video.duration) $('.rec-seek').value = String(Math.round(video.currentTime / video.duration * 1000));
      }
    }
    raf = requestAnimationFrame(frame);

    // 書き込み（指・マウス・ペン）
    // 画面上の位置（canvas の座標）
    const scr = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    // 画面上の位置 → 動画の上の位置。図形は動画の上の位置で持つので、拡大・縮小しても動画と一緒に動く
    const toVid = (q, v = view) => ({ x: v.cx + (q.x - cv.width / 2) / v.z, y: v.cy + (q.y - cv.height / 2) / v.z });
    const pt = (e) => toVid(scr(e));
    // 動画の外（黒い所）が見えないように、見る場所を枠の中に収める
    function clampView(v) {
      v.z = Math.max(1, Math.min(ZMAX, v.z));
      const hw = cv.width / 2 / v.z; const hh = cv.height / 2 / v.z;
      v.cx = Math.max(hw, Math.min(cv.width - hw, v.cx)); v.cy = Math.max(hh, Math.min(cv.height - hh, v.cy));
      return v;
    }
    // 画面上の点 s を動かさずに、倍率を z にする（指でつまんだ所・マウスの所を中心に拡大）
    function zoomAt(z, s, v = view) {
      const before = toVid(s, v); v.z = Math.max(1, Math.min(ZMAX, z));
      v.cx = before.x - (s.x - cv.width / 2) / v.z; v.cy = before.y - (s.y - cv.height / 2) / v.z;
      return clampView(v);
    }
    const zv = () => { $('.rec-zv').textContent = `${aim.z.toFixed(1)}倍`; };
    // 指やホイールで動かしたときは、そのまま（なめらかに寄せる途中のものは止める）
    const jump = () => { Object.assign(aim, view); zv(); };
    function ease() {
      const k = 0.22;
      view.z += (aim.z - view.z) * k; view.cx += (aim.cx - view.cx) * k; view.cy += (aim.cy - view.cy) * k;
      if (Math.abs(aim.z - view.z) < 0.002) Object.assign(view, aim);
    }
    const ZSTEPS = [1, 1.5, 2, 3, 4];
    function zoomStep(d) {
      const c = { x: cv.width / 2, y: cv.height / 2 };
      const z = d > 0 ? (ZSTEPS.find((v) => v > aim.z + 0.05) || ZMAX) : ([...ZSTEPS].reverse().find((v) => v < aim.z - 0.05) || 1);
      zoomAt(z, c, aim); zv();
    }
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(view.z * Math.exp(-e.deltaY * 0.0015), scr(e)); jump();
    }, { passive: false });
    // 2本指：つまんで拡大・縮小、そのまま動かすと見る場所が動く
    const touches = new Map(); let pinch = null;
    const pinchInfo = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
    // 図形の「つまみ」（端・中心・角度の頂点）。つかむと形を変えられる
    function handles(s) {
      if (s.t === 'line' || s.t === 'arrow' || s.t === 'circle') return [s.a, s.b];
      if (s.t === 'angle') return s.p;
      return [];
    }
    // 直線・矢印：0°・45°・90°・135°・180° の近くでは、その角度にぴたっと吸い付く（数字は出さない）
    const SNAP_DEG = 4; let snapped = false;
    function snapTo(fixed, p) {
      const dx = p.x - fixed.x; const dy = p.y - fixed.y; const len = Math.hypot(dx, dy);
      if (len < 12) { snapped = false; return p; }
      const ang = Math.atan2(dy, dx); const step = Math.PI / 4;
      const near = Math.round(ang / step) * step;
      const on = Math.abs(ang - near) * 180 / Math.PI <= SNAP_DEG;
      if (on && !snapped) navigator.vibrate?.(8); // 吸い付いた瞬間、対応するスマホでは軽く震える
      snapped = on;
      return on ? { x: fixed.x + len * Math.cos(near), y: fixed.y + len * Math.sin(near) } : p;
    }
    const segDist = (p, a, b) => {
      const dx = b.x - a.x; const dy = b.y - a.y; const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    // 指・マウスの位置にある図形を探す（上に描いたものから）
    function hit(p) {
      const tol = lw() * 4;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        const h = handles(s).find((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol * 1.3);
        if (h) return { s, h };
        let d = Infinity;
        if (s.t === 'pen') for (let k = 1; k < s.p.length; k++) d = Math.min(d, segDist(p, s.p[k - 1], s.p[k]));
        if (s.t === 'line' || s.t === 'arrow') d = segDist(p, s.a, s.b);
        if (s.t === 'circle') { const r = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y); const c = Math.hypot(p.x - s.a.x, p.y - s.a.y); d = c <= r ? 0 : c - r; }
        if (s.t === 'angle') d = Math.min(segDist(p, s.p[0], s.p[1]), s.p[2] ? segDist(p, s.p[1], s.p[2]) : Infinity);
        if (d <= tol) return { s, h: null };
      }
      return null;
    }
    const allPts = (s) => (s.t === 'pen' || s.t === 'angle' ? s.p : [s.a, s.b]);
    // 角度：いま何点目をタップするかを案内する
    const ANGLE_STEPS = ['角度：① 片方の端をタップ', '角度：② 角の頂点（曲がっている所）をタップ', '角度：③ もう片方の端をタップ'];
    function angleTip() {
      const tip = $('.rec-tip');
      tip.hidden = tool !== 'angle';
      tip.textContent = ANGLE_STEPS[anglePts.length] || '';
    }
    const showDel = () => { $('[data-r="del"]').hidden = !(tool === 'move' && sel && shapes.includes(sel)); };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') touches.set(e.pointerId, scr(e));
      if (touches.size === 2) {
        // 2本目の指：書きかけの線はやめて、つまむ操作にする
        draft = null; drag = null; pan = null;
        pinch = { ...pinchInfo(), z: view.z, v: { ...view } };
        // 角度で1本目の指が点を置いていたら、それは取り消す
        if (angleTap && anglePts.length) { anglePts.pop(); angleTip(); }
        angleTap = false;
        return;
      }
      if (touches.size > 2) return;
      const p = pt(e);
      if (tool === 'move') {
        const f = hit(p);
        sel = f ? f.s : null; showDel();
        // 円の中心をつかんだときは、大きさはそのままで円ごと動かす
        if (f) { snap(); drag = { s: f.s, h: f.s.t === 'circle' && f.h === f.s.a ? null : f.h, last: p }; }
        // 何もない所をつかんだら、拡大中は見る場所を動かす
        else if (view.z > 1.001) pan = { s: scr(e), cx: view.cx, cy: view.cy };
        return;
      }
      if (tool === 'angle') {
        anglePts.push(p); angleTap = e.pointerType === 'touch' && anglePts.length < 3;
        if (anglePts.length === 3) { snap(); shapes.push({ t: 'angle', c: color, p: anglePts }); anglePts = []; }
        angleTip();
        return;
      }
      draft = tool === 'pen' ? { t: 'pen', c: color, p: [p] } : { t: tool, c: color, a: p, b: p };
    });
    cv.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, scr(e));
      if (pinch) {
        if (touches.size < 2) return;
        const n = pinchInfo();
        // つまみ始めの表示から計算しなおす（指の間の点が、つまんだ所に付いてくる）
        const v = { ...pinch.v };
        const at = toVid(pinch.m, v);
        v.z = Math.max(1, Math.min(ZMAX, pinch.z * n.d / Math.max(1, pinch.d)));
        v.cx = at.x - (n.m.x - cv.width / 2) / v.z; v.cy = at.y - (n.m.y - cv.height / 2) / v.z;
        Object.assign(view, clampView(v)); jump();
        return;
      }
      if (pan) {
        const q = scr(e);
        view.cx = pan.cx - (q.x - pan.s.x) / view.z; view.cy = pan.cy - (q.y - pan.s.y) / view.z;
        clampView(view); jump();
        return;
      }
      if (drag) {
        const p = pt(e);
        if (drag.h) {
          const lineLike = drag.s.t === 'line' || drag.s.t === 'arrow';
          const q = lineLike ? snapTo(drag.h === drag.s.a ? drag.s.b : drag.s.a, p) : p;
          drag.h.x = q.x; drag.h.y = q.y;
        } else {
          // 円は中心をつかんでも全体が動く。それ以外も全体を平行移動
          const dx = p.x - drag.last.x; const dy = p.y - drag.last.y;
          allPts(drag.s).forEach((q) => { q.x += dx; q.y += dy; });
        }
        drag.last = p;
        return;
      }
      if (tool === 'move') { cv.style.cursor = hit(pt(e)) ? 'grab' : (view.z > 1.001 ? 'move' : 'default'); return; }
      if (!draft) return;
      const p = pt(e);
      if (draft.t === 'pen') draft.p.push(p); else draft.b = draft.t === 'line' || draft.t === 'arrow' ? snapTo(draft.a, p) : p;
    });
    let pan = null; let angleTap = false;
    const endDraw = (e) => {
      if (e && touches.has(e.pointerId)) {
        touches.delete(e.pointerId);
        if (pinch) { if (!touches.size) pinch = null; return; }
      }
      drag = null; pan = null;
      if (draft) { if (draft.t === 'pen' ? draft.p.length > 1 : Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y) > 4) { snap(); shapes.push(draft); } draft = null; }
    };
    cv.addEventListener('pointerup', endDraw); cv.addEventListener('pointercancel', endDraw);

    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    async function startRec() {
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch {
        if (!confirm('マイクが使えません。声なしで録画しますか？（マイクの使用を許可すると声も録れます）')) return;
      }
      const stream = cv.captureStream(30);
      mic?.getAudioTracks().forEach((t) => stream.addTrack(t));
      const mimeType = pickMime();
      chunks = [];
      rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      rec.start(1000);
      t0 = Date.now();
      $('.rec-badge').hidden = false; $('.rec-go').textContent = '■ 録画を止める'; $('.rec-go').classList.add('on');
      timer = setInterval(() => { const s = (Date.now() - t0) / 1000; $('.rec-time').textContent = fmt(s); if (s >= MAX_SEC) stopRec(); }, 250);
    }
    function stopRec() {
      if (!rec || rec.state === 'inactive') return;
      clearInterval(timer); rec.stop();
      mic?.getTracks().forEach((t) => t.stop()); mic = null;
      $('.rec-badge').hidden = true; $('.rec-go').textContent = '● 録画を始める'; $('.rec-go').classList.remove('on');
    }
    async function finish() {
      video.pause(); $('.rec-play').textContent = '▶';
      let blob = new Blob(chunks, { type: (rec.mimeType || 'video/webm').split(';')[0] });
      blob = await fixMp4(blob);
      wrap.dataset.blob = '1'; wrap._blob = blob;
      if (outUrl) URL.revokeObjectURL(outUrl);
      outUrl = URL.createObjectURL(blob);
      $('.rec-out').src = outUrl;
      $('.rec-review').hidden = false;
    }
    function close(result) {
      if (closed) return;
      stopRec(); closed = true; cancelAnimationFrame(raf); video.pause();
      if (objUrl) URL.revokeObjectURL(objUrl);
      if (outUrl && !result) URL.revokeObjectURL(outUrl);
      document.removeEventListener('keydown', onKey, true);
      ro?.disconnect(); window.removeEventListener('resize', fit);
      wrap.remove(); document.body.classList.remove('rec-open');
      resolve(result || null);
    }
    const onKey = (e) => { if (e.key === 'Escape' && !(rec && rec.state === 'recording')) close(null); };
    document.addEventListener('keydown', onKey, true);

    $('.rec-seek').addEventListener('input', (e) => { if (video.duration) video.currentTime = Number(e.target.value) / 1000 * video.duration; });
    video.addEventListener('ended', () => { $('.rec-play').textContent = '▶'; });
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      const r = b.dataset.r;
      if (r === 'close') {
        if (rec && rec.state === 'recording' && !confirm('録画中です。やめて閉じますか？')) return;
        if (wrap._blob && !$('.rec-review').hidden && !confirm('録った動画を使わずに閉じますか？')) return;
        close(null);
      }
      if (r === 'play') { if (video.paused) { video.play(); b.textContent = '❚❚'; } else { video.pause(); b.textContent = '▶'; } }
      if (r === 'rate') { video.playbackRate = Number(b.dataset.v); b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }
      if (r === 'step') { video.pause(); $('.rec-play').textContent = '▶'; video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + Number(b.dataset.v) / 30)); }
      if (r === 'tool') { tool = b.dataset.v; anglePts = []; sel = null; showDel(); angleTip(); cv.style.cursor = tool === 'move' ? 'default' : 'crosshair'; b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }
      if (r === 'color') { color = b.dataset.v; if (tool === 'move' && sel && shapes.includes(sel)) { snap(); sel.c = color; } b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }
      if (r === 'undo') {
        if (anglePts.length) { anglePts = []; angleTip(); }
        else if (history.length) { shapes.splice(0, shapes.length, ...JSON.parse(history.pop())); sel = null; showDel(); }
      }
      if (r === 'clear') { if (shapes.length) snap(); shapes.length = 0; anglePts = []; sel = null; showDel(); }
      if (r === 'del' && sel) { snap(); shapes.splice(shapes.indexOf(sel), 1); sel = null; showDel(); }
      if (r === 'zoom') { const d = Number(b.dataset.v); if (d) zoomStep(d); else { aim.z = 1; aim.cx = cv.width / 2; aim.cy = cv.height / 2; zv(); } }
      if (r === 'rec') { if (rec && rec.state === 'recording') stopRec(); else startRec(); }
      if (r === 'retake') { $('.rec-review').hidden = true; $('.rec-out').removeAttribute('src'); wrap._blob = null; }
      if (r === 'use') close(wrap._blob);
    });
  });
}

// iPhone・Mac の Safari で録った mp4 は、長さが「不明」のまま保存されることがある。
// SwingFrame と同じ方法で、実際の長さをファイルの先頭に書き込む。
function fixMp4(blob){
  if(!blob||!/mp4/i.test(blob.type||''))return Promise.resolve(blob);
  function view(a,b){return blob.slice(a,b).arrayBuffer().then(function(x){return new DataView(x)})}
  function kids(d,s,e,cb){
    while(s+8<=e){
      var sz=d.getUint32(s),t=String.fromCharCode(d.getUint8(s+4),d.getUint8(s+5),d.getUint8(s+6),d.getUint8(s+7));
      if(sz<8||s+sz>e)return;
      cb(t,s+8,s+sz);s+=sz;
    }
  }
  function u64(d,o){return d.getUint32(o)*4294967296+d.getUint32(o+4)}
  var tops=[];
  function walk(off){
    if(off+8>blob.size)return Promise.resolve();
    return view(off,Math.min(blob.size,off+16)).then(function(d){
      var sz=d.getUint32(0),t=String.fromCharCode(d.getUint8(4),d.getUint8(5),d.getUint8(6),d.getUint8(7));
      if(sz===1&&d.byteLength>=16)sz=u64(d,8); else if(sz===0)sz=blob.size-off;
      if(sz<8)return;
      tops.push({t:t,o:off,n:sz});
      return walk(off+sz);
    });
  }
  return walk(0).then(function(){
    var moov=tops.filter(function(b){return b.t==='moov'})[0];
    var moofs=tops.filter(function(b){return b.t==='moof'});
    if(!moov||!moofs.length||moov.n>4e6)return blob;
    return Promise.all([view(moov.o,moov.o+moov.n)].concat(moofs.map(function(b){return view(b.o,b.o+b.n)})))
    .then(function(vs){
      var mv=vs[0],trk={},defDur={},end={};
      /* the header first: the per-track default sample length (trex) is needed
         to measure fragments that do not list each sample's length.
         The header:  movie and track time scales, and where the lengths live */
      var out=new Uint8Array(mv.buffer.slice(0)),w=new DataView(out.buffer),mts=0,mvhd=0,mehd=0,had=0;
      function put(o,v,big){
        if(big){w.setUint32(o,Math.floor(v/4294967296));w.setUint32(o+4,v>>>0)}
        else if(v<=0xffffffff)w.setUint32(o,v);
      }
      kids(mv,0,mv.byteLength,function(t,b,e){
        if(t!=='moov')return;
        kids(mv,b,e,function(t2,p,q){
          if(t2==='mvhd'){mvhd=p;mts=mv.getUint32(p+(mv.getUint8(p)?20:12));
            had=mv.getUint8(p)?u64(mv,p+24):mv.getUint32(p+16)}
          else if(t2==='mvex')kids(mv,p,q,function(t3,r){
            if(t3==='trex')defDur[mv.getUint32(r+4)]=mv.getUint32(r+12);
            else if(t3==='mehd')mehd=r;
          });
          else if(t2==='trak'){
            var tk={};
            kids(mv,p,q,function(t3,r,s2){
              if(t3==='tkhd'){tk.tkhd=r;tk.id=mv.getUint32(r+(mv.getUint8(r)?20:12))}
              else if(t3==='mdia')kids(mv,r,s2,function(t4,u){
                if(t4==='mdhd'){tk.mdhd=u;tk.ts=mv.getUint32(u+(mv.getUint8(u)?20:12))}
              });
            });
            if(tk.id)trk[tk.id]=tk;
          }
        });
      });
      /* every fragment: where each track's run starts and how long it lasts */
      vs.slice(1).forEach(function(d){
        kids(d,0,d.byteLength,function(t,b,e){
          if(t!=='moof')return;
          kids(d,b,e,function(t2,b2,e2){
            if(t2!=='traf')return;
            var id=0,dd=0,base=null,sum=0;
            kids(d,b2,e2,function(t3,p,q){
              var fl=d.getUint32(p)&0xffffff,v=d.getUint8(p),o;
              if(t3==='tfhd'){
                id=d.getUint32(p+4);o=p+8;dd=defDur[id]||0;
                if(fl&1)o+=8; if(fl&2)o+=4; if(fl&8)dd=d.getUint32(o);
              }else if(t3==='tfdt'){
                base=v?u64(d,p+4):d.getUint32(p+4);
              }else if(t3==='trun'){
                var n=d.getUint32(p+4),i;o=p+8;
                if(fl&1)o+=4; if(fl&4)o+=4;
                for(i=0;i<n;i++){
                  if(fl&0x100){sum+=d.getUint32(o);o+=4}else sum+=dd;
                  if(fl&0x200)o+=4; if(fl&0x400)o+=4; if(fl&0x800)o+=4;
                }
              }
            });
            if(!id)return;
            var from=base!=null?base:(end[id]||0);
            end[id]=Math.max(end[id]||0,from+sum);
          });
        });
      });
      if(!mvhd||!mts)return blob;
      /* only a length that really says "unknown" (or nothing) is rewritten */
      if(had>0&&had/mts<21600)return blob;
      var longest=0;
      Object.keys(trk).forEach(function(id){
        var tk=trk[id],e=end[id];
        if(!e||!tk.ts||!tk.mdhd||!tk.tkhd)return;
        var v=mv.getUint8(tk.mdhd);put(tk.mdhd+(v?24:16),e,v);
        var m=Math.round(e/tk.ts*mts);
        v=mv.getUint8(tk.tkhd);put(tk.tkhd+(v?28:20),m,v);
        longest=Math.max(longest,m);
      });
      if(!longest)return blob;
      var v=mv.getUint8(mvhd);put(mvhd+(v?24:16),longest,v);
      if(mehd){v=mv.getUint8(mehd);put(mehd+4,longest,v)}
      return new Blob([blob.slice(0,moov.o),out,blob.slice(moov.o+moov.n)],{type:blob.type});
    });
  }).catch(function(){return blob});
}