// home.js: the home page from the Figma redesign (build.py --home-v2).

// Figma rounds the width of text that hugs its content up to a whole pixel (a chip label of 160.13 px is 161 px there).
// Chips, buttons and nav keys do the same here, so a row of them lines up with the design to the pixel.
// Without this script they are at most 2 px shorter; nothing else depends on it.
(() => {
  const els = [...document.querySelectorAll('.h-chip, .h-btn, .h-key:not(.h-key--home)')];
  const fit = () => els.forEach((el) => {
    el.style.width = '';
    const w = el.getBoundingClientRect().width;
    const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight);
    el.style.width = (Math.ceil(w - pad - 0.01) + pad) + 'px';
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit); else fit();
  // again when the width changes: the phone widths change the paddings (home.css); a height change alone is the iPhone
  // toolbar folding away while scrolling, nothing to do then
  let w = window.innerWidth, t = 0;
  window.addEventListener('resize', () => {
    if (window.innerWidth === w) return;
    w = window.innerWidth; clearTimeout(t); t = setTimeout(fit, 120);
  });
})();

// The texts keep the admin's no-break spaces and line breaks: they set the lines of the 700 px column (card 2's title
// has no other space). On a phone a forced line break in a case title becomes a space, and where a text no longer fits its narrower
// column, its no-break spaces become plain ones, so the line can wrap; when the window is wide enough again, the text
// gets them back. The words themselves never change.
(() => {
  const els = [...document.querySelectorAll('.h-name, .h-lead, .h-h2, .h-case-title, .h-case-desc, .h-contact-title, .h-contact-text, .h-contact-email, .h-copy')];
  const phone = window.matchMedia('(max-width: 767px)');
  const kept = new Map();                               // element -> how to put it back
  const fit = () => els.forEach((el) => {
    if (kept.has(el)) { for (const undo of kept.get(el).reverse()) undo(); kept.delete(el); }
    const list = [];
    if (phone.matches && el.matches('.h-case-title')) for (const br of el.querySelectorAll('br')) {
      const sp = document.createTextNode(' ');
      br.replaceWith(sp); list.push(() => sp.replaceWith(br));
    }
    for (const inMarker of [false, true]) {             // the words under the marker stay together if they can
      if (el.scrollWidth <= el.clientWidth + 1) break;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const n = walk.currentNode, t = n.data;
        if (!t.includes('\u00a0') || (!inMarker && n.parentElement.closest('.h-hl'))) continue;
        n.data = t.replace(/\u00a0/g, ' '); list.push(() => { n.data = t; });
      }
    }
    if (list.length) kept.set(el, list);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit); else fit();
  let w = window.innerWidth, t = 0;
  window.addEventListener('resize', () => {
    if (window.innerWidth === w) return;
    w = window.innerWidth; clearTimeout(t); t = setTimeout(fit, 120);
  });
})();

// On-this-page marks: the mark of the section being read is dark (My work, the five cases, Contact),
// as site.js does on the other pages.
(() => {
  const marks = [...document.querySelectorAll('.h-toc .h-mark')];
  const targets = marks.map((m) => document.getElementById(m.getAttribute('href').slice(1)));
  if (!marks.length || targets.some((t) => !t)) return;
  const mark = () => {
    const line = window.innerHeight / 3;
    let k = 0;
    targets.forEach((t, i) => { if (t.getBoundingClientRect().top <= line) k = i; });
    marks.forEach((m, i) => {
      m.classList.toggle('on', i === k);
      if (i === k) m.setAttribute('aria-current', 'location'); else m.removeAttribute('aria-current');
    });
  };
  let raf = 0;
  window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; mark(); }); }, { passive: true });
  window.addEventListener('resize', mark);
  mark();
})();

// the list rows (1)–(4): on hover the letters flip over (see home.css «hover: the line stays…»). The text is split into
// letters here, so the admin's labels keep working; the link keeps its name for screen readers. A flip always plays to
// the end, even if the pointer leaves; keyboard focus plays it too. Nothing with reduced motion.
// Split letters lose the font's kerning (CONTACT grew 6 px), so each letter gets back the place the browser gave it in
// the whole line: measured before the split, set as a margin in em (it holds at any type size).
const splitRows = () => {
  const rows = document.querySelectorAll('body.home .h-row');
  if (!rows.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const a of rows) {
    const node = a.firstChild;
    if (!node || node.nodeType !== 3 || a.childNodes.length !== 1) continue;
    const text = node.data;
    const rg = document.createRange();
    const at = [];                                      // where each letter starts in the whole line
    for (let i = 0; i < text.length; i++) { rg.setStart(node, i); rg.setEnd(node, i + 1); at.push(rg.getBoundingClientRect().left); }
    rg.setStart(node, 0); rg.setEnd(node, text.length);
    at.push(rg.getBoundingClientRect().right);
    const fs = parseFloat(getComputedStyle(a).fontSize) || 16;
    a.setAttribute('aria-label', text.trim());
    const wrap = document.createElement('span');
    wrap.className = 'h-flip'; wrap.setAttribute('aria-hidden', 'true');
    for (const c of text) { const s = document.createElement('span'); s.className = 'h-ch'; s.textContent = c; wrap.appendChild(s); }
    a.textContent = '';
    a.appendChild(wrap);
    const chars = [...wrap.children];
    chars.forEach((s, i) => {
      const fix = at[i + 1] - at[i] - s.getBoundingClientRect().width;
      if (Math.abs(fix) > 0.01) s.style.marginRight = (fix / fs).toFixed(4) + 'em';
    });
    let busy = false;
    const flip = (x, up) => {
      if (busy) return;
      busy = true;
      let i0 = 0;                                       // the letter under the pointer starts the wave
      if (x != null) {
        let best = Infinity;
        chars.forEach((s, i) => { const r = s.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - x); if (d < best) { best = d; i0 = i; } });
      }
      a.style.setProperty('--dir', up ? 1 : -1);
      a.classList.add('flipping');
      let last = chars[0], far = -1;
      chars.forEach((s, i) => { const d = Math.abs(i - i0); s.style.setProperty('--d', d); if (d > far) { far = d; last = s; } s.classList.remove('go'); });
      void wrap.offsetWidth;                            // start again from the first frame
      for (const s of chars) s.classList.add('go');
      last.addEventListener('animationend', () => {
        for (const s of chars) s.classList.remove('go');
        a.classList.remove('flipping');
        busy = false;
      }, { once: true });
    };
    a.addEventListener('pointerenter', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const r = a.getBoundingClientRect();
      flip(e.clientX, e.clientY > r.top + r.height / 2);
    });
    a.addEventListener('focus', () => { if (a.matches(':focus-visible')) flip(null, true); });
  }
};
if (document.fonts && document.fonts.ready) document.fonts.ready.then(splitRows); else splitRows();
