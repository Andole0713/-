const SITE_SRC = document.currentScript && document.currentScript.src;
// ===== 連絡先の設定（ここを書き換えるだけでページ全体に反映されます） =====
const CONTACT = {
  tel: '0527004909',
  telDisplay: '052-700-4909',
  hours: '受付時間 11:00〜20:00',
  lineUrl: 'https://lin.ee/ssvLEAZ',
};

if (CONTACT.lineUrl) {
  document.querySelectorAll('[data-line]').forEach((a) => { a.href = CONTACT.lineUrl; a.target = '_blank'; a.rel = 'noopener'; });
}
if (CONTACT.tel) {
  document.querySelectorAll('[data-tel]').forEach((a) => { a.href = 'tel:' + CONTACT.tel; });
  document.querySelectorAll('[data-tel-text]').forEach((a) => { a.textContent = CONTACT.telDisplay || CONTACT.tel; });
}
if (CONTACT.hours) document.querySelectorAll('[data-hours]').forEach((p) => { p.textContent = CONTACT.hours; });

// ヘッダーの背景・スマホ下部ボタンの表示
const header = document.getElementById('header');

// 目次メニュー（3本バー）の開け閉め
const menuBtn = document.getElementById('menuBtn');
const drawer = document.getElementById('drawer');
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
  drawer.setAttribute('aria-hidden', String(!open));
}
menuBtn.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
drawer.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
window.addEventListener('resize', () => { if (window.innerWidth > 1024) setMenu(false); });
const sticky = document.getElementById('stickyCta');
const contact = document.getElementById('contact');
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();
function onScroll() {
  const y = window.scrollY;
  header.classList.toggle('scrolled', y > 40);
  const contactTop = contact ? contact.getBoundingClientRect().top : Infinity;
  sticky.classList.toggle('show', y > window.innerHeight * 0.6 && contactTop > window.innerHeight * 0.5);
}
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// 統計用：どこから来たか（リンクの ?from=instagram など）と、表示・ボタンが押された回数を記録する
// 個人を特定する情報は送らない。記録できなくてもページはそのまま使える
(() => {
  const safe = (f) => { try { return f(); } catch { return null; } };
  const from = (new URLSearchParams(location.search).get('from') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  // はじめて来たときのきっかけを残す（会員登録したときに、アプリがこれを記録する）
  if (from && !safe(() => localStorage.getItem('atg-from'))) safe(() => localStorage.setItem('atg-from', JSON.stringify({ source: from, ts: Date.now() })));
  const source = from || safe(() => JSON.parse(localStorage.getItem('atg-from') || 'null')?.source) || '';
  let cfg = null;
  const send = async (kind) => {
    try {
      cfg = cfg || await import(new URL('../app/config.js', SITE_SRC || location.href).href);
      if (!cfg.SUPABASE_URL || /mock|YOUR/.test(cfg.SUPABASE_URL)) return;
      await fetch(`${cfg.SUPABASE_URL}/rest/v1/site_events`, {
        method: 'POST', keepalive: true,
        headers: { apikey: cfg.SUPABASE_ANON_KEY, authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ kind, source }),
      });
    } catch { /* 記録できなくても何もしない */ }
  };
  if (!safe(() => sessionStorage.getItem('atg-viewed'))) { safe(() => sessionStorage.setItem('atg-viewed', '1')); send('view'); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    const kind = a.hasAttribute('data-line') ? 'line' : a.hasAttribute('data-tel') ? 'tel'
      : /(^|\/)app\/swing\//.test(a.getAttribute('href') || '') ? 'shoot' : /(^|\/)app\/?$/.test(a.getAttribute('href') || '') ? 'login'
      : a.closest('.plan') && a.getAttribute('href') === '#contact' ? 'plan' : '';
    if (kind) send(kind);
  });
})();

// スクロールでふわっと表示
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
}
