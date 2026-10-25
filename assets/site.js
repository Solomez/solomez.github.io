// site.js: the floating outline (as on notion.site): sits 18 px below the top of the page title,
// stays under the top bar when the page scrolls, and marks the section being read.
(() => {
  const toc = document.querySelector('.toc');
  const title = document.querySelector('.title');
  if (!toc || !title) return;
  const heads = [...document.querySelectorAll('.page-content h2[id], .page-content h3[id]')];
  const dashes = [...toc.querySelectorAll('.d')];
  const items = [...toc.querySelectorAll('.t')];
  const place = () => {
    const top = title.getBoundingClientRect().top + 18;
    toc.style.top = Math.max(62, top) + 'px';
  };
  const mark = () => {
    const line = window.innerHeight / 3;
    let k = 0;
    heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) k = i; });
    dashes.forEach((d, i) => d.classList.toggle('on', i === k));
    items.forEach((d, i) => d.classList.toggle('on', i === k));
  };
  const tick = () => { place(); mark(); };
  let raf = 0;
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tick(); }); }, { passive: true });
  window.addEventListener('resize', tick);
  tick();
})();

// D-55: videos play by themselves like moving pictures, without the player bar.
// They load only near the screen, play only while at least half visible, and pause when scrolled away or the tab
// is hidden. A tap, a click or Enter/Space pauses and resumes; in a case it opens the video larger (viewer.js).
// With reduced motion or data saver on, or when the browser blocks autoplay (iOS Low Power Mode), the video waits
// with a play mark. Without JS the usual player stays.
(() => {
  const vids = [...document.querySelectorAll('.b-video video')];
  if (!vids.length || !('IntersectionObserver' in window)) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const save = !!(navigator.connection && navigator.connection.saveData);
  const auto = () => !calm.matches && !save;
  const fig = (v) => v.closest('.b-video');
  const stop = (v, on) => fig(v).classList.toggle('stopped', on);
  const play = (v) => {
    const p = v.play();
    if (p && p.catch) p.catch(() => stop(v, true));
  };
  const near = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting && e.target.preload !== 'auto') { e.target.preload = 'auto'; near.unobserve(e.target); }
  }), { rootMargin: '800px 0px' });
  const seen = new IntersectionObserver((es) => es.forEach((e) => {
    const v = e.target;
    v.dataset.seen = e.intersectionRatio >= 0.5 ? '1' : '';
    if (v.dataset.seen && auto() && !v.dataset.held) play(v);
    else if (!v.dataset.seen && !v.paused) v.pause();
  }), { threshold: [0, 0.5, 1] });
  const toggle = (v) => {
    if (v.paused) { delete v.dataset.held; if (v.preload !== 'auto') v.preload = 'auto'; play(v); }
    else { v.dataset.held = '1'; v.pause(); stop(v, true); }
  };
  vids.forEach((v) => {
    v.controls = false;
    v.removeAttribute('controls');
    v.muted = true;
    fig(v).classList.add('auto');
    if (!auto()) stop(v, true);
    v.addEventListener('playing', () => stop(v, false));
    // in a case a click opens the video larger (viewer.js), where a click pauses; elsewhere it pauses here
    if (!fig(v).hasAttribute('data-zoom')) {
      v.tabIndex = 0;
      v.setAttribute('aria-label', v.getAttribute('aria-label') + '. Video, plays by itself; press to pause or play.');
      v.addEventListener('click', () => toggle(v));
      v.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(v); } });
    }
    near.observe(v);
    seen.observe(v);
  });
  document.addEventListener('visibilitychange', () => vids.forEach((v) => {
    if (document.hidden) v.pause();
    else if (v.dataset.seen && auto() && !v.dataset.held) play(v);
  }));
})();
