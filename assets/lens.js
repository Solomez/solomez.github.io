// lens.js: the bottom edge of the screen bends like curved glass while the page scrolls (D-56).
//
// Technique of system.studio/work/patch (Daryl Ginn, studied 2026-10-20), turned from their sideways rail to
// vertical scroll and written anew for this site: every block of the page (text, heading, list row, picture,
// video, caption, frame, divider) gets a twin in one WebGL canvas; pictures and videos are uploaded as they are,
// text is drawn line by line onto a canvas from the positions the browser gives each word. Near the bottom edge
// the twin's mesh fans out sideways from the middle of the screen, and red and blue split apart along the fan.
//
// Changes over the original, for this site:
// - hand-off: the twin fades in over the page across 40 px, below that a fixed curtain in the page colour hides the
//   real page, so scrolling never shows a white line or a step;
// - the width follows the scroll speed (px per ms) through a critically damped spring (~0.2 s): a flick widens the
//   fan from +60% up to +210%, slow reading barely moves it, and it glides to rest as the page stops;
// - the colour split is set in pixels, the same for text and pictures, and grows with speed;
// - the bend appears with the first scroll, not on the first screen;
// - safety: if WebGL is lost (iPhone does that under memory pressure) or anything fails, the curtain goes and the
//   plain page shows; if scrolling stays below ~40 frames a second, the effect turns itself off for the session;
// - memory: twins are kept only within about three screens around the window, pictures are uploaded at the size
//   they are shown; text twins are drawn at the screen's density up to 3x, pictures up to 2x;
// - battery: nothing runs while nothing moves; the canvas covers only the bend;
// - keyboard: a link reached with Tab that lands in the bend is lifted above it; print hides the effect;
// - colours come from the page (curtain = page background, text twin = nearest background), ready for a redesign.
// Clicks go through the bend. Off with reduced motion. Phones: sync mode and a gentler bend (see below).
// Tuning: ?lens=zone,fan,power,chroma px,boost.
(() => {
  const main = document.querySelector('main.frame');
  if (!main || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Phones and tablets scroll the page on a separate thread, so a twin drawn by the page's own code trails the page by
  // a frame or two and the bend shakes (iPhone, 2026-10-20). There the page itself is moved by this code in the same
  // frame as the bend («sync»): the window still scrolls natively (momentum, the Safari toolbar), the page follows its
  // position, and the two can never drift apart. ?touch=off turns the effect off on a phone, ?touch=on shows it
  // without sync (for comparison).
  const touch = window.matchMedia('(pointer: coarse)').matches || /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const touchMode = new URLSearchParams(location.search).get('touch');
  if (touch && touchMode === 'off') return;
  const sync = touch && touchMode !== 'on';
  try { if (sessionStorage.getItem('lens-off')) return; } catch (e) { /* storage blocked: carry on */ }

  const qs = new URLSearchParams(location.search);
  // a phone gets a gentler bend: its text column fills the screen, so the desktop fan threw pictures far off the edges
  // (designer on iPhone: «картинка слишком сильно искажается»)
  const narrow = window.innerWidth <= 600;
  const P = narrow ? { zone: 0.1, fan: 0.3, pow: 2.6, chroma: 6, boost: 0.5 }
    : { zone: 0.1, fan: 0.6, pow: 2.6, chroma: 10, boost: 1.5 };
  if (qs.get('lens')) {
    const [z, f, p, c, b] = qs.get('lens').split(',').map(Number);
    if (z) P.zone = z; if (f) P.fan = f; if (p) P.pow = p; if (c >= 0) P.chroma = c; if (b >= 0) P.boost = b;
  }
  const FULL_SPEED = touch ? 5 : 3.5;   // px per ms that counts as a full-speed flick (a finger flicks faster)
  const SMOOTH = 24;         // ms: first pass against uneven trackpad steps
  const OMEGA = 22;          // rad/s: the width follows the speed like a critically damped spring, ~0.2 s
  const FX = 0.012;          // the rainbow fades in over the first part of the bend
  const FADE = 40;           // px: the page and its twin cross-fade above the bend
  const GATE = 300;          // ms: the bend grows in after the first scroll
  const SLOW = 25;           // ms per frame that counts as slow (below 40 frames a second)

  const canvas = document.createElement('canvas');
  const curtain = document.createElement('div');
  for (const n of [canvas, curtain]) { n.setAttribute('aria-hidden', 'true'); n.dataset.lens = ''; }
  canvas.style.cssText = 'position:fixed;left:0;bottom:0;pointer-events:none;z-index:15';   // anchored to the bottom, like the curtain
  curtain.style.cssText = 'position:fixed;left:0;right:0;bottom:0;pointer-events:none;z-index:14;display:none';
  const css = document.createElement('style');
  css.textContent = '@media print{[data-lens]{display:none!important}}';
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return;
  document.head.appendChild(css);
  document.body.append(curtain, canvas);

  // ------------------------------------------------------------------ colours from the page
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const pageBg = () => { const c = getComputedStyle(document.body).backgroundColor; return transparent(c) ? '#fff' : c; };
  function bgOf(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!transparent(c)) return c;
    }
    return pageBg();
  }
  curtain.style.background = pageBg();

  // ------------------------------------------------------------------ WebGL
  const VS = `
    precision highp float;
    attribute vec2 aUv;            // 0..1 across the block, y down
    uniform vec2 uRes;             // window, css px
    uniform vec2 uCanvas;          // the canvas covers only the bend: its top and height in the window, css px
    uniform vec4 uRect;            // block: left, top, width, height (css px, y down)
    uniform float uZone, uFan, uPow;
    varying vec2 vUv;
    varying float vEdge;
    varying float vY;
    void main() {
      vUv = aUv;
      vec2 s = uRect.xy + aUv * uRect.zw;
      vY = s.y;
      float dist = 1.0 - s.y / uRes.y;                            // 0 at the bottom edge
      float edge = pow(1.0 - smoothstep(0.0, uZone, dist), uPow); // 0 above the bend, 1 at the edge
      float cx = uRes.x * 0.5;                                    // one centre line for the whole page
      float x = cx + (s.x - cx) * (1.0 + uFan * edge);
      gl_Position = vec4(x / uRes.x * 2.0 - 1.0, 1.0 - (s.y - uCanvas.x) / uCanvas.y * 2.0, 0.0, 1.0);
      vEdge = edge;
    }`;
  const FS = `
    precision highp float;
    uniform sampler2D tMap;
    uniform float uChroma, uRadius, uFx, uFade0, uFade1;
    uniform vec2 uSize, uUvScale, uUvOffset;
    varying vec2 vUv;
    varying float vEdge;
    varying float vY;
    void main() {
      vec2 uv = uUvOffset + vUv * uUvScale;
      vec4 base = texture2D(tMap, uv);
      float fx = smoothstep(0.0003, uFx, vEdge);
      float ca = uChroma / max(uSize.x, 1.0) * uUvScale.x * fx * (0.4 + vEdge);  // px -> uv; widens toward the edge
      float r = texture2D(tMap, uv + vec2(ca, 0.0)).r;
      float b = texture2D(tMap, uv - vec2(ca, 0.0)).b;
      float mask = clamp((vY - uFade0) / (uFade1 - uFade0), 0.0, 1.0);   // cross-fade over the page above the curtain
      if (uRadius > 0.0) {                                        // rounded corners of pictures and videos
        vec2 q = abs(vUv * uSize - uSize * 0.5) - uSize * 0.5 + uRadius;
        float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - uRadius;
        mask *= 1.0 - smoothstep(0.0, 1.5, d);
      }
      vec3 rgb = mix(base.rgb, vec3(r, base.g, b), fx);
      gl_FragColor = vec4(rgb * base.a, base.a) * mask;
    }`;
  let U = {}, aUv = 0, grids = new Map();
  function initGL() {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    U = {};
    ['uRes', 'uCanvas', 'uRect', 'uZone', 'uFan', 'uPow', 'tMap', 'uChroma', 'uRadius', 'uFx', 'uFade0', 'uFade1', 'uSize', 'uUvScale', 'uUvOffset']
      .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    aUv = gl.getAttribLocation(prog, 'aUv');
    gl.enableVertexAttribArray(aUv);
    gl.uniform1f(U.uZone, P.zone); gl.uniform1f(U.uPow, P.pow); gl.uniform1f(U.uFx, FX);
    gl.uniform1i(U.tMap, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    grids = new Map();
  }
  try { initGL(); } catch (e) { canvas.remove(); curtain.remove(); return; }

  // a grid mesh per size: few columns (the fan is straight across a row), rows every ~4 px so the bend is smooth
  function grid(nx, ny) {
    const key = nx + 'x' + ny;
    if (grids.has(key)) return grids.get(key);
    const v = new Float32Array((nx + 1) * (ny + 1) * 2), idx = new Uint16Array(nx * ny * 6);
    let k = 0;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { v[k++] = i / nx; v[k++] = j / ny; }
    k = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    const g = { vb, ib, count: idx.length };
    grids.set(key, g);
    return g;
  }
  function texture(src) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    return tex;
  }

  // ------------------------------------------------------------------ blocks
  const SEL = ['h1.title', '.b-text .leaf', '.b-h2 h2', '.b-h3 h3', '.b-list .row', '.b-page .pg', '.b-file .file',
    '.b-toggle > summary', '.b-callout .box', '.b-divider > div', '.cap', '.b-image img', '.b-video video',
    '.page-icon img', '.cover img'].join(', ');
  const tiles = [];
  const byEl = new Map();
  for (const el of main.querySelectorAll(SEL)) {
    const kind = el.tagName === 'IMG' ? 'img' : el.tagName === 'VIDEO' ? 'video' : 'paint';
    const t = { el, kind, tex: null, ready: false, busy: false, gen: 0, top: 0, left: 0, w: 0, h: 0, fresh: false };
    tiles.push(t); byEl.set(el, t);
  }
  const isTile = (n) => byEl.has(n);

  // --- painting a block onto a canvas: boxes, borders, icons and text at the positions the browser laid them out
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawBox(ctx, el, st, o, alpha) {
    const r = el.getBoundingClientRect();
    const x = r.left - o.left, y = r.top - o.top, rad = parseFloat(st.borderTopLeftRadius) || 0;
    ctx.globalAlpha = alpha;
    if (!transparent(st.backgroundColor)) { ctx.fillStyle = st.backgroundColor; roundRect(ctx, x, y, r.width, r.height, rad); ctx.fill(); }
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => (st['border' + s + 'Style'] !== 'none' ? parseFloat(st['border' + s + 'Width']) || 0 : 0));
    if (bw.every((w) => w > 0) && bw.every((w) => w === bw[0])) {
      ctx.strokeStyle = st.borderTopColor; ctx.lineWidth = bw[0];
      roundRect(ctx, x + bw[0] / 2, y + bw[0] / 2, r.width - bw[0], r.height - bw[0], Math.max(0, rad - bw[0] / 2)); ctx.stroke();
    } else {
      ctx.fillStyle = st.borderBottomColor;
      if (bw[2]) ctx.fillRect(x, y + r.height - bw[2], r.width, bw[2]);
      ctx.fillStyle = st.borderTopColor;
      if (bw[0]) ctx.fillRect(x, y, r.width, bw[0]);
    }
  }
  async function drawSvg(ctx, svg, o, alpha) {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const c = svg.cloneNode(true);
    const st = getComputedStyle(svg);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.setAttribute('width', r.width); c.setAttribute('height', r.height);
    c.style.fill = st.fill; c.style.color = st.color;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(c));
    try { await img.decode(); } catch (e) { return; }
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, r.left - o.left, r.top - o.top, r.width, r.height);
  }
  function drawText(ctx, node, o, alpha, tileEl) {
    const text = node.data;
    if (!text.trim()) return;
    const el = node.parentElement;
    const st = getComputedStyle(el);
    ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
    ctx.fillStyle = st.color;
    ctx.globalAlpha = alpha;
    const fs = parseFloat(st.fontSize) || 16;
    const m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || fs * 0.8;
    const desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || fs * 0.2;
    let ul = null;   // underline of links (a.ln): from the nearest underlined ancestor inside the block
    for (let a = el; a && a !== tileEl.parentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if ((s.textDecorationLine || '').includes('underline')) { ul = s; break; }
    }
    const range = document.createRange();
    const lines = [];
    const re = /\S+/g;
    let mm;
    while ((mm = re.exec(text))) {
      range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const rr = rects[0];
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - rr.top) < 2) { last.end = mm.index + mm[0].length; last.right = rr.right; }
      else lines.push({ start: mm.index, end: mm.index + mm[0].length, left: rr.left, right: rr.right, top: rr.top, height: rr.height });
    }
    for (const ln of lines) {
      const base = ln.top + (ln.height - asc - desc) / 2 + asc - o.top;
      ctx.fillText(text.slice(ln.start, ln.end), ln.left - o.left, base);
      if (ul) {
        const th = parseFloat(ul.textDecorationThickness) || Math.max(1, fs * 0.05);
        const off = parseFloat(ul.textUnderlineOffset) || fs * 0.1;
        ctx.fillStyle = ul.textDecorationColor || st.color;
        ctx.fillRect(ln.left - o.left, base + off, ln.right - ln.left, th);
        ctx.fillStyle = st.color;
      }
    }
  }
  async function paint(t) {
    const el = t.el;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);        // text as sharp as the screen, up to 3x
    const c = document.createElement('canvas');
    c.width = Math.ceil(r.width * dpr); c.height = Math.ceil(r.height * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'alphabetic';
    // text twins sit on their background: an opaque twin gives the colour split something to split
    if (!el.matches('.b-callout .box, .b-divider > div')) { ctx.fillStyle = bgOf(el); ctx.fillRect(0, 0, r.width, r.height); }
    const jobs = [];
    const walk = (n, alpha) => {
      if (n.nodeType === 3) { drawText(ctx, n, r, alpha, el); return; }
      if (n.nodeType !== 1 || (n !== el && isTile(n))) return;
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const a = alpha * (parseFloat(st.opacity) || 1);
      drawBox(ctx, n, st, r, a);
      if (n.tagName.toLowerCase() === 'svg') { jobs.push(drawSvg(ctx, n, r, a)); return; }
      for (const ch of n.childNodes) walk(ch, a);
    };
    walk(el, 1);
    await Promise.all(jobs);
    return c;
  }
  // a picture is uploaded at the size it is shown (up to 2x), not at the size of the file
  function shrink(img, nw, nh, shownW) {
    const w = Math.max(1, Math.min(nw, Math.ceil(shownW * Math.min(window.devicePixelRatio || 1, 2))));
    if (w >= nw) return img;
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.max(1, Math.round((w * nh) / nw));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function prepare(t) {
    if (t.ready || t.busy || lost) return;
    t.busy = true;
    const gen = t.gen;
    try {
      let src = null;
      if (t.kind === 'img') {
        const img = t.el;
        if (!img.complete || !img.naturalWidth) { img.loading = 'eager'; await img.decode().catch(() => {}); }
        if (!img.naturalWidth) return;
        t.nw = img.naturalWidth; t.nh = img.naturalHeight; t.src = img;
        src = shrink(img, t.nw, t.nh, t.w);
      } else if (t.kind === 'video') {
        const v = t.el;
        if (v.readyState >= 2) {
          t.src = v; t.nw = v.videoWidth; t.nh = v.videoHeight; src = v;
          if (!t.hooked) {           // upload a new video frame only when the video has one
            t.hooked = true;
            if (v.requestVideoFrameCallback) { const on = () => { t.fresh = true; wake(); v.requestVideoFrameCallback(on); }; v.requestVideoFrameCallback(on); }
            else { let last = -1; t.poll = () => { if (v.currentTime !== last) { last = v.currentTime; t.fresh = true; } }; }
            v.addEventListener('play', wake);
          }
        } else if (v.poster) {
          const im = new Image(); im.src = v.poster; await im.decode().catch(() => {});
          if (!im.naturalWidth) return;
          t.nw = im.naturalWidth; t.nh = im.naturalHeight; t.src = im; src = shrink(im, t.nw, t.nh, t.w);
        } else return;
      } else {
        src = await paint(t);
        if (!src) return;
      }
      if (gen !== t.gen || lost || off) return;          // evicted or reset while preparing
      if (t.tex) gl.deleteTexture(t.tex);
      t.tex = texture(src);
      t.radius = parseFloat(getComputedStyle(t.el).borderTopLeftRadius) || 0;
      t.ready = true;
      dirty = true; wake();
    } catch (e) { /* this twin stays plain */ } finally { t.busy = false; }
  }
  function evict(t) {
    t.gen++;
    if (t.tex && !lost) gl.deleteTexture(t.tex);
    t.tex = null; t.ready = false;
  }

  // block positions on the page (layout is static; refreshed on resize and when the page height changes)
  function measure() {
    const sy = window.scrollY;
    for (const t of tiles) { const r = t.el.getBoundingClientRect(); t.top = r.top + sy; t.left = r.left; t.w = r.width; t.h = r.height; }
  }

  // ------------------------------------------------------------------ sync mode (phones, trial)
  let syncTop = 0, syncRO = null, tocHome = null;
  function moveMain(sy) { main.style.transform = `translate3d(0, ${syncTop - sy}px, 0)`; }
  function setupSync() {
    syncTop = main.getBoundingClientRect().top + window.scrollY;
    const toc = main.querySelector('.toc');
    if (toc) { tocHome = [toc, toc.parentNode, toc.nextSibling]; document.body.appendChild(toc); }   // a fixed outline must not ride along
    const fit = () => { document.body.style.minHeight = Math.ceil(syncTop + main.offsetHeight) + 'px'; };
    fit();
    Object.assign(main.style, { position: 'fixed', top: '0', left: '0', right: '0', willChange: 'transform' });
    moveMain(window.scrollY);
    syncRO = new ResizeObserver(fit);
    syncRO.observe(main);
  }
  // back to the plain page (the effect turned off): the page scrolls on its own again
  function teardownSync() {
    if (!sync) return;
    if (syncRO) syncRO.disconnect();
    for (const k of ['position', 'top', 'left', 'right', 'willChange', 'transform']) main.style[k] = '';
    document.body.style.minHeight = '';
    if (tocHome) tocHome[1].insertBefore(tocHome[0], tocHome[2]);
  }
  if (sync) setupSync();

  // ------------------------------------------------------------------ state, sleep and wake
  let W = 0, H = 0, lastW = 0, cTop = 0, cH = 0;
  let dirty = true, running = false, off = false, lost = false, shown = false;
  let armed = false, armT = 0;
  let lastT = 0, lastY = -1, k = 0, kv = 0, vel = 0, still = 2;
  let movingMs = 0, movingFrames = 0;

  function hideCurtain() { if (shown) { curtain.style.display = 'none'; shown = false; } }
  function turnOff(why) {
    if (off) return;
    off = true;
    teardownSync();
    hideCurtain();
    for (const t of tiles) evict(t);
    canvas.remove(); curtain.remove();
    try { sessionStorage.setItem('lens-off', why); } catch (e) { /* ignore */ }
  }
  function wake() { if (!running && !off) { running = true; lastT = 0; requestAnimationFrame(frame); } }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();                                      // ask for it back; meanwhile the plain page shows
    lost = true; hideCurtain();
    for (const t of tiles) { t.tex = null; t.ready = false; t.gen++; }
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try { initGL(); lost = false; dirty = true; resize(); idle(prepareAhead, { timeout: 500 }); wake(); } catch (e) { turnOff('webgl'); }
  });

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    // the canvas covers only the bend and the fade above it
    cTop = Math.floor(H * (1 - P.zone) - FADE) - 2;
    cH = H - cTop;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(cH * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = cH + 'px';
    if (!lost) gl.viewport(0, 0, canvas.width, canvas.height);
    curtain.style.height = Math.ceil(H * P.zone) + 'px';
    curtain.style.background = pageBg();
    // text wraps anew only when the width changes (the iPhone address bar changes only the height)
    if (W !== lastW) { for (const t of tiles) if (t.kind !== 'video' || !t.ready) evict(t); lastW = W; }
    measure();
    dirty = true;
  }

  // twins are prepared ahead in idle time, nearest to the bend first; far ones are let go to save memory
  const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 6 }), 60));
  let idleQueued = false;
  function inWindow(t, sy) { return t.top + t.h > sy - H && t.top < sy + 2 * H; }
  function prepareAhead(deadline) {
    idleQueued = false;
    if (off || lost) return;
    const sy = window.scrollY, zone = sy + H * (1 - P.zone);
    for (const t of tiles) if (t.ready && !inWindow(t, sy)) evict(t);
    const todo = tiles.filter((t) => !t.ready && !t.busy && t.h > 0 && inWindow(t, sy))
      .sort((a, b) => Math.abs(a.top - zone) - Math.abs(b.top - zone));
    for (const t of todo) {
      if (deadline.timeRemaining() < 3) break;
      prepare(t);
    }
    if (todo.length) queueIdle();
  }
  function queueIdle() { if (!idleQueued) { idleQueued = true; idle(prepareAhead, { timeout: 500 }); } }

  // ------------------------------------------------------------------ frame
  function frame(now) {
    if (off) { running = false; return; }
    try {
      if (!step(now)) { running = false; return; }
      requestAnimationFrame(frame);
    } catch (e) {
      turnOff('error');                                       // anything unexpected: back to the plain page
    }
  }

  // returns whether another frame is needed
  function step(now) {
    if (document.hidden) { lastT = 0; lastY = -1; return false; }
    const sy = window.scrollY;
    if (sync) moveMain(sy);                                        // page and bend move in the same frame
    const hNow = window.innerHeight;
    if (hNow !== H) {                                              // toolbar shown or hidden: follow the bottom at once
      H = hNow;
      if (H * P.zone + FADE + 4 > cH) resize(); else { cTop = H - cH; curtain.style.height = Math.ceil(H * P.zone) + 'px'; }
      dirty = true;
    }
    const raw = lastT ? now - lastT : 16.7;                        // ms since the last frame
    const dt = Math.min(Math.max(raw, 4), 100);
    lastT = now;
    const dy = lastY < 0 ? 0 : Math.abs(sy - lastY);
    const moved = dy > 0;
    lastY = sy;
    still = moved ? 0 : still + 1;
    if (still >= 2) vel = 0;                                       // the page has stopped: the target is rest
    else vel += (dy / dt - vel) * (1 - Math.exp(-dt / SMOOTH));    // px per ms, lightly smoothed
    // the width moves like a physical body: a critically damped spring toward the speed, no jumps, no overshoot
    const target = Math.min(vel / FULL_SPEED, 1);
    const sdt = dt / 1000;
    kv += (OMEGA * OMEGA * (target - k) - 2 * OMEGA * kv) * sdt;
    k += kv * sdt;
    if (k < 0) { k = 0; kv = 0; } else if (k > 1) { k = 1; kv = 0; }
    if (still >= 2 && k < 0.002 && Math.abs(kv) < 0.01) { k = 0; kv = 0; }

    // a device too slow for the effect: over 1.2 s of scrolling the average frame is longer than 25 ms (below
    // 40 frames a second): turn it off for the session. A gap over 1 s is a hidden tab, not a slow device.
    if (moved && raw < 1000) {
      movingMs += raw; movingFrames++;
      if (movingMs >= 1200) {
        if (movingMs / movingFrames > SLOW) { turnOff('slow'); return false; }
        movingMs = 0; movingFrames = 0;
      }
    }
    if (moved && still === 0 && Math.abs(sy - (prepareAhead.at || 0)) > H / 2) { prepareAhead.at = sy; queueIdle(); }

    if (!armed || lost) { hideCurtain(); return false; }
    const g = Math.min(1, (now - armT) / GATE);                    // the bend grows in after the first scroll
    const gate = g * g * (3 - 2 * g);

    const zoneTop = H * (1 - P.zone);
    const fadeTop = zoneTop - FADE;
    const live = [];
    let allReady = true, video = false;
    for (const t of tiles) {
      const top = t.top - sy, bottom = top + t.h;
      if (bottom <= fadeTop || top >= H) continue;
      live.push(t);
      if (!t.ready) { allReady = false; if (!t.busy) prepare(t); }
      if (t.kind === 'video' && t.src === t.el && !t.el.paused) { video = true; if (t.poll) t.poll(); }
    }
    const busy = moved || k > 0 || kv !== 0 || video || gate < 1;
    if (!dirty && !busy) return false;                             // nothing changed: sleep until the next scroll
    dirty = false;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    // a twin is missing: show the plain page for this frame rather than a gap
    if (!allReady || !live.length) { hideCurtain(); if (!allReady) dirty = true; return true; }
    if (!shown) { curtain.style.display = 'block'; shown = true; }
    const e = k * k * (3 - 2 * k);                                 // soft at low speed (reading stays calm), full on a flick
    gl.uniform2f(U.uRes, W, H);
    gl.uniform2f(U.uCanvas, cTop, cH);
    gl.uniform1f(U.uFan, (P.fan + P.boost * e) * gate);
    gl.uniform1f(U.uChroma, P.chroma * (0.6 + 0.9 * e) * gate);
    gl.uniform1f(U.uFade0, fadeTop); gl.uniform1f(U.uFade1, zoneTop);
    for (const t of live) {
      // positions from the cache and this frame's scroll: every twin moves by exactly the same amount
      const left = t.left, top = t.top - sy, width = t.w, height = t.h;
      if (t.fresh && t.src === t.el) {
        t.fresh = false;
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.el);
      }
      // object-fit: cover crop for pictures and videos whose box differs from the file
      let sx = 1, syc = 1, ox = 0, oy = 0;
      if (t.nw && t.nh) {
        const boxA = width / height, imgA = t.nw / t.nh;
        if (imgA > boxA * 1.001) { sx = boxA / imgA; ox = (1 - sx) / 2; } else if (imgA < boxA / 1.001) { syc = imgA / boxA; oy = (1 - syc) / 2; }
      }
      gl.uniform4f(U.uRect, left, top, width, height);
      gl.uniform2f(U.uSize, width, height);
      gl.uniform1f(U.uRadius, t.radius || 0);
      gl.uniform2f(U.uUvScale, sx, syc);
      gl.uniform2f(U.uUvOffset, ox, oy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const gr = grid(8, Math.min(240, Math.max(4, Math.ceil(height / 4))));
      gl.bindBuffer(gl.ARRAY_BUFFER, gr.vb);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gr.ib);
      gl.drawElements(gl.TRIANGLES, gr.count, gl.UNSIGNED_SHORT, 0);
    }
    return true;
  }

  // ------------------------------------------------------------------ events
  window.addEventListener('scroll', () => {
    if (!armed) { armed = true; armT = performance.now(); }       // the first scroll brings the bend in
    wake();
  }, { passive: true });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); queueIdle(); wake(); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { dirty = true; wake(); } });
  new ResizeObserver(() => { measure(); dirty = true; wake(); }).observe(main);
  window.addEventListener('load', () => { measure(); dirty = true; queueIdle(); });
  // keyboard: a link or control reached with Tab that lands in the bend is lifted above it
  document.addEventListener('focusin', (e) => {
    if (off || !main.contains(e.target)) return;
    requestAnimationFrame(() => {
      const r = e.target.getBoundingClientRect();
      const lim = H * (1 - P.zone) - FADE - 12;
      if (r.bottom > lim && r.top < H) window.scrollBy(0, r.bottom - lim);
    });
  });

  resize();
  queueIdle();
  wake();
})();
