// viewer.js: the pictures and videos of a case open larger on a click (designer, 2026-10-25: «добавить возможность
// открыть медиа в более большой формат по клику в кейсах»). build.py marks each figure of a case page with data-zoom;
// a picture wider than its 1408 px page copy also carries data-full, a 2400 px copy that loads only here.
// - the media grows from its place on the page to fit the window and goes back there on close (reduced motion: a fade);
// - ← → or the side buttons go through the case's media, Esc, ✕ or a click outside closes; on a phone a swipe
//   sideways changes the media, a swipe down closes;
// - a video plays on from where it was; a click on it pauses, as on the page. The page's videos wait meanwhile.
// A native <dialog>: it sits in the top layer, above the glass canvases of lens.js and home-live.js, and the page
// behind it is inert. Without this script the media stay as they are.
(() => {
  const figs = [...document.querySelectorAll('figure[data-zoom]')];
  if (!figs.length || typeof HTMLDialogElement !== 'function') return;
  const root = document.documentElement;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const save = !!(navigator.connection && navigator.connection.saveData);
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';     // a soft stop, no overshoot
  const EASE_BACK = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const PLAY = '<svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true"><path d="M2 2.2v17.6c0 .8.9 1.3 1.6.9l14.6-8.8c.6-.4.6-1.4 0-1.8L3.6 1.3C2.9.9 2 1.4 2 2.2Z" fill="currentColor"/></svg>';
  const icon = (d) => `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // ------------------------------------------------------------------ the media of the page
  const items = figs.map((fig) => {
    const trig = fig.querySelector('.pg-media, .vbox');
    const img = trig && trig.querySelector('img');
    const vid = trig && trig.querySelector('video');
    const capEl = fig.querySelector('.pg-cap');
    const cap = capEl ? capEl.textContent.replace(/\s+/g, ' ').trim() : '';
    if (vid) {
      const s = vid.querySelector('source');
      return { trig, kind: 'video', el: vid, cap, src: (s && s.src) || vid.currentSrc || vid.src, poster: vid.poster,
               w: +vid.getAttribute('width') || 16, h: +vid.getAttribute('height') || 9 };
    }
    if (img) return { trig, kind: 'img', el: img, cap, alt: img.alt || cap, full: img.dataset.full || '',
                      w: +img.getAttribute('width') || img.naturalWidth || 16, h: +img.getAttribute('height') || img.naturalHeight || 9 };
    return null;
  }).filter((it) => it && it.trig);
  if (!items.length) return;
  const shown = (it) => it.trig.getClientRects().length > 0;          // not inside a closed toggle

  // ------------------------------------------------------------------ the dialog
  const dlg = document.createElement('dialog');
  dlg.className = 'pv';
  dlg.tabIndex = -1;                                    // opened with the mouse, the dialog itself takes the focus (no ring on ✕)
  dlg.setAttribute('aria-label', 'Media viewer');
  dlg.innerHTML = '<div class="pv-bg"></div><div class="pv-stage"></div><p class="pv-cap"></p>'
    + '<div class="pv-bar"><span class="pv-count" aria-live="polite"></span>'
    + `<button class="pv-btn pv-close" type="button" aria-label="Close">${icon('M5 5l10 10M15 5L5 15')}</button></div>`
    + `<button class="pv-btn pv-prev" type="button" aria-label="Previous">${icon('M12.5 4.5L7 10l5.5 5.5')}</button>`
    + `<button class="pv-btn pv-next" type="button" aria-label="Next">${icon('M7.5 4.5L13 10l-5.5 5.5')}</button>`;
  document.body.appendChild(dlg);
  const $ = (s) => dlg.querySelector(s);
  const bg = $('.pv-bg'), stage = $('.pv-stage'), cap = $('.pv-cap'), count = $('.pv-count');
  const prev = $('.pv-prev'), next = $('.pv-next'), shut = $('.pv-close');
  const chrome = [$('.pv-bar'), prev, next, cap];

  let list = [], idx = 0, cur = null, open = false, closing = false, viaKey = false, held = [];

  // where the media goes: as large as the window allows (never above its own pixels), the caption under it
  function place(it) {
    const W = window.innerWidth, H = window.innerHeight, phone = W < 768;
    const side = phone ? 12 : 96, top = phone ? 64 : 76;
    cap.textContent = it.cap;
    cap.hidden = !it.cap;
    cap.style.width = Math.min(700, W - (phone ? 32 : 2 * side)) + 'px';
    const capH = it.cap ? cap.offsetHeight + 16 : 0;
    const bottom = (phone ? 84 : 32) + capH;
    const aw = W - 2 * side, ah = Math.max(120, H - top - bottom);
    const s = Math.min(aw / it.w, ah / it.h, 1);
    const w = Math.round(it.w * s), h = Math.round(it.h * s);
    return { x: Math.round((W - w) / 2), y: Math.round(top + (ah - h) / 2), w, h };
  }
  function put(frame, L) {
    Object.assign(frame.style, { left: L.x + 'px', top: L.y + 'px', width: L.w + 'px', height: L.h + 'px' });
    cap.style.top = (L.y + L.h + 16) + 'px';
  }

  function media(it, frame) {
    if (it.kind === 'img') {
      const im = document.createElement('img');
      im.src = it.el.currentSrc || it.el.src;          // the page's copy, already loaded: shows at once
      im.alt = it.alt; im.draggable = false; im.decoding = 'async';
      if (it.full) {                                    // then the sharp one, when it is ready
        const big = new Image(); big.decoding = 'async'; big.src = it.full;
        (big.decode ? big.decode() : Promise.resolve()).then(() => { if (im.isConnected) im.src = it.full; }).catch(() => {});
      }
      return im;
    }
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('disablepictureinpicture', ''); v.setAttribute('disableremoteplayback', '');
    if (it.poster) v.poster = it.poster;
    v.tabIndex = 0;
    v.setAttribute('aria-label', (it.cap || 'Video') + '. Press to pause or play.');
    const at = it.el.currentTime || 0;
    if (at) v.addEventListener('loadedmetadata', () => { try { v.currentTime = at; } catch (e) { /* keeps 0 */ } }, { once: true });
    v.src = it.src;
    const mark = document.createElement('span');
    mark.className = 'pv-mark'; mark.innerHTML = PLAY;
    frame.appendChild(mark);
    const stop = (on) => frame.classList.toggle('stopped', on);
    const play = () => { const p = v.play(); if (p && p.catch) p.catch(() => stop(true)); };
    v.addEventListener('playing', () => stop(false));
    v.addEventListener('pause', () => stop(true));
    const toggle = () => (v.paused ? play() : v.pause());
    v.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    v.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    if (!calm.matches && !save) play(); else stop(true);
    return v;
  }

  function frameFor(it) {
    const frame = document.createElement('div');
    frame.className = 'pv-frame' + (it.kind === 'video' ? ' pv-vid' : '');
    frame.prepend(media(it, frame));
    const L = place(it);
    put(frame, L);
    stage.appendChild(frame);
    return { frame, L };
  }

  function label(i) {
    count.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    prev.hidden = next.hidden = list.length < 2;
    prev.disabled = i === 0;
    next.disabled = i === list.length - 1;
    for (const j of [i - 1, i + 1]) {                   // the neighbours' sharp copies, ahead of time
      const n = list[j];
      if (n && n.full && !n.pre) { n.pre = new Image(); n.pre.decoding = 'async'; n.pre.src = n.full; }
    }
  }

  const inView = (r) => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
  const radius = (el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  // a transform that lays the frame (rect L) over the rect r of the page
  const over = (r, L) => `translate(${r.left - L.x}px, ${r.top - L.y}px) scale(${r.width / L.w}, ${r.height / L.h})`;

  function show(it) {
    list = items.filter(shown);
    idx = Math.max(0, list.indexOf(it));
    viaKey = viaKey && !!it;
    // pause the page's videos behind the viewer; they go on when it closes
    held = [...document.querySelectorAll('main video')].filter((v) => !v.paused);
    held.forEach((v) => v.pause());
    if (!viaKey && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    root.classList.add('pv-lock');
    dlg.showModal();
    open = true;
    const { frame, L } = frameFor(list[idx]);
    cur = frame;
    label(idx);
    if (viaKey) shut.focus({ preventScroll: true }); else dlg.focus({ preventScroll: true });
    const r = list[idx].trig.getBoundingClientRect();
    if (calm.matches) {
      for (const el of [frame, bg, ...chrome]) el.animate({ opacity: [0, 1] }, { duration: 160, easing: 'ease-out' });
      return;
    }
    if (inView(r)) {
      const k = radius(list[idx].el);
      frame.animate([
        { transform: over(r, L), borderRadius: `${k * L.w / r.width}px / ${k * L.h / r.height}px` },
        { transform: 'none', borderRadius: '14px' },
      ], { duration: 460, easing: EASE });
    } else frame.animate({ opacity: [0, 1], transform: ['scale(0.96)', 'none'] }, { duration: 300, easing: EASE });
    bg.animate({ opacity: [0, 1] }, { duration: 320, easing: 'ease-out' });
    for (const el of chrome) el.animate({ opacity: [0, 1] }, { duration: 240, delay: 140, easing: 'ease-out', fill: 'backwards' });
  }

  function go(d, fromX = 0) {
    const j = idx + d;
    if (!open || closing || j < 0 || j >= list.length) return false;
    const old = cur;
    const { frame } = frameFor(list[j]);
    cur = frame; idx = j;
    label(j);
    const out = calm.matches ? { opacity: [1, 0] } : { opacity: [1, 0], transform: [`translateX(${fromX}px)`, `translateX(${-d * 80 + fromX}px)`] };
    old.style.pointerEvents = 'none';
    old.animate(out, { duration: 180, easing: 'ease-in', fill: 'forwards' }).finished.then(() => old.remove(), () => old.remove());
    old.querySelectorAll('video').forEach((v) => v.pause());
    frame.animate(calm.matches ? { opacity: [0, 1] } : { opacity: [0, 1], transform: [`translateX(${d * 80}px)`, 'none'] },
                  { duration: calm.matches ? 160 : 340, easing: EASE });
    cap.animate({ opacity: [0, 1] }, { duration: 200, easing: 'ease-out' });
    return true;
  }

  function close() {
    if (!open || closing) return;
    closing = true;
    const it = list[idx], frame = cur;
    frame.querySelectorAll('video').forEach((v) => {   // the page's copy goes on from here
      if (it.kind === 'video' && v.currentTime) try { it.el.currentTime = v.currentTime; } catch (e) { /* stays */ }
      v.pause();
    });
    let r = it.trig.getBoundingClientRect();
    if (!inView(r)) {                                   // went through the media: the page comes to the last one
      window.scrollTo(0, window.scrollY + r.top - Math.max(16, (window.innerHeight - r.height) / 2));
      r = it.trig.getBoundingClientRect();
    }
    // the frame's own box (left/top/size); where it is drawn now may differ: mid-animation or dragged by a finger
    const L = { x: parseFloat(frame.style.left), y: parseFloat(frame.style.top), w: parseFloat(frame.style.width), h: parseFloat(frame.style.height) };
    const from = getComputedStyle(frame).transform;
    const dragged = !!frame.style.transform;
    frame.getAnimations().forEach((a) => a.cancel());
    frame.style.transform = '';
    const k = radius(it.el);
    const runs = [];
    if (dragged && !calm.matches) runs.push(frame.animate({ opacity: [1, 0], transform: [from, from + ' translateY(80px)'] }, { duration: 220, easing: 'ease-in', fill: 'forwards' }));
    else if (calm.matches || !inView(r)) runs.push(frame.animate({ opacity: [1, 0] }, { duration: 180, easing: 'ease-in', fill: 'forwards' }));
    else runs.push(frame.animate([
      { transform: from === 'none' ? 'none' : from, borderRadius: '14px' },
      { transform: over(r, L), borderRadius: `${k * L.w / r.width}px / ${k * L.h / r.height}px` },
    ], { duration: 340, easing: EASE_BACK, fill: 'forwards' }));
    runs.push(bg.animate({ opacity: [getComputedStyle(bg).opacity, 0] }, { duration: calm.matches ? 180 : 300, easing: 'ease-out', fill: 'forwards' }));
    for (const el of chrome) runs.push(el.animate({ opacity: [1, 0] }, { duration: 140, easing: 'ease-out', fill: 'forwards' }));
    Promise.all(runs.map((a) => a.finished.catch(() => {}))).then(() => {
      dlg.close();
      stage.textContent = '';
      bg.style.opacity = '';
      for (const el of [bg, ...chrome]) el.getAnimations().forEach((a) => a.cancel());
      root.classList.remove('pv-lock');
      held.forEach((v) => { if (v.dataset.seen && !v.dataset.held) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } });
      held = [];
      if (viaKey) it.trig.focus({ preventScroll: true });
      open = closing = viaKey = false;
      cur = null;
    });
  }

  // ------------------------------------------------------------------ events
  items.forEach((it) => {
    const t = it.trig;
    t.tabIndex = 0;
    t.setAttribute('role', 'button');
    t.setAttribute('aria-haspopup', 'dialog');
    t.setAttribute('aria-label', (it.kind === 'video' ? 'Open the video larger' : 'Open the picture larger') + (it.cap ? ': ' + it.cap : ''));
    if (it.kind === 'video') it.el.tabIndex = -1;   // one stop for the keyboard: the frame
    t.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });   // no focus jump (lens.js lifts focused things)
    t.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); viaKey = false; show(it); });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viaKey = true; show(it); }
    });
  });

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });
  shut.addEventListener('click', close);
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  let swiped = 0;
  stage.addEventListener('click', (e) => {
    if (performance.now() - swiped < 400) return;      // the end of a swipe is not a click
    if (!cur || !cur.contains(e.target)) close();       // outside the media
  });

  // touch: sideways changes the media, down closes; the frame follows the finger
  let sw = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || closing || !cur) return;
    if (window.visualViewport && window.visualViewport.scale > 1.01) return;   // pinch-zoomed: the browser pans
    sw = { x: e.clientX, y: e.clientY, axis: '', dx: 0, dy: 0 };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!sw || !e.isPrimary) return;
    sw.dx = e.clientX - sw.x; sw.dy = e.clientY - sw.y;
    if (!sw.axis && Math.hypot(sw.dx, sw.dy) > 10) sw.axis = Math.abs(sw.dx) > Math.abs(sw.dy) ? 'x' : 'y';
    if (sw.axis === 'x') {
      const edge = (sw.dx > 0 && idx === 0) || (sw.dx < 0 && idx === list.length - 1);
      cur.style.transform = `translateX(${edge ? sw.dx / 3 : sw.dx}px)`;
    } else if (sw.axis === 'y' && sw.dy > 0) {
      cur.style.transform = `translateY(${sw.dy}px) scale(${1 - Math.min(sw.dy / 2000, 0.15)})`;
      bg.style.opacity = String(1 - Math.min(sw.dy / 500, 0.6));
    }
  });
  const end = () => {
    if (!sw) return;
    const s = sw; sw = null;
    if (!s.axis) return;
    swiped = performance.now();
    if (s.axis === 'x' && Math.abs(s.dx) > 60) {
      const old = cur, t = old.style.transform;
      old.style.transform = '';
      if (go(s.dx < 0 ? 1 : -1, s.dx)) return;
      old.style.transform = t;                          // the first or the last: springs back below
    }
    if (s.axis === 'y' && s.dy > 90) { close(); return; }
    const was = cur.style.transform;
    cur.style.transform = '';
    if (was) cur.animate({ transform: [was, 'none'] }, { duration: 260, easing: EASE });
    if (bg.style.opacity) { bg.animate({ opacity: [bg.style.opacity, 1] }, { duration: 200 }); bg.style.opacity = ''; }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  let rt = 0;
  window.addEventListener('resize', () => {
    if (!open) return;
    clearTimeout(rt);
    rt = setTimeout(() => { if (open && !closing && cur) put(cur, place(list[idx])); }, 80);
  });
})();
