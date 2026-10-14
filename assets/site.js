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
