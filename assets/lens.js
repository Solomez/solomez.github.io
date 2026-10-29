(() => {
  const main = document.querySelector('main.frame, main.h-main');
  if (!main || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return;
  const home = main.classList.contains('h-main');
  const bend = !(home && document.body.dataset.bend === '0');
  const touch = window.matchMedia('(pointer: coarse)').matches || /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const touchMode = new URLSearchParams(location.search).get('touch');
  if (touch && touchMode !== 'sync' && touchMode !== 'on') return;
  const desktopSafari = !touch && /^((?!chrome|chromium|crios|edg|opr|fxios|firefox|android).)*safari/i.test(navigator.userAgent);
  const sync = touchMode === 'sync' || (desktopSafari && new URLSearchParams(location.search).get('sync') !== '0');
  try { if (sessionStorage.getItem('lens-off')) return; } catch (e) {   }

  const qs = new URLSearchParams(location.search);
  const narrow = window.innerWidth <= 600;
  const P = narrow ? { zone: 0.1, fan: 0.3, pow: 2.6, chroma: 6, boost: 0.5 }
    : { zone: 0.1, fan: 0.6, pow: 2.6, chroma: 10, boost: 1.5 };
  let SLOW = 25;
  if (qs.get('lens')) {
    const [z, f, p, c, b, s] = qs.get('lens').split(',').map(Number);
    if (z) P.zone = z; if (f) P.fan = f; if (p) P.pow = p; if (c >= 0) P.chroma = c; if (b >= 0) P.boost = b;
    if (s > 0) SLOW = s;
  }
  const FULL_SPEED = touch ? 5 : 3.5;
  const SMOOTH = 24;
  const OMEGA = 22;
  const FX = 0.012;
  const FADE = 40;
  const GATE = 300;

  const canvas = document.createElement('canvas');
  const curtain = document.createElement('div');
  for (const n of [canvas, curtain]) { n.setAttribute('aria-hidden', 'true'); n.dataset.lens = ''; }
  canvas.style.cssText = 'position:fixed;left:0;bottom:0;pointer-events:none;z-index:15';
  curtain.style.cssText = 'position:fixed;left:0;right:0;bottom:0;pointer-events:none;z-index:14;display:none';
  const css = document.createElement('style');
  css.textContent = '@media print{[data-lens]{display:none!important}}';
  const homeQs = new URLSearchParams(location.search);
  const strip = home && homeQs.get('strip') === '1';
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: !(home && homeQs.get('aa') === '0') });
  if (!gl) return;
  document.head.appendChild(css);
  document.body.append(curtain, canvas);

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

  const VS = `
    precision highp float;
    attribute vec2 aUv;
    uniform vec2 uRes;
    uniform vec2 uCanvas;
    uniform vec4 uRect;
    uniform float uZone, uFan, uPow;
    varying vec2 vUv;
    varying float vEdge;
    varying float vY;
    void main() {
      vUv = aUv;
      vec2 s = uRect.xy + aUv * uRect.zw;
      vY = s.y;
      float dist = 1.0 - s.y / uRes.y;
      float edge = pow(1.0 - smoothstep(0.0, uZone, dist), uPow);
      float cx = uRes.x * 0.5;
      float x = cx + (s.x - cx) * (1.0 + uFan * edge);
      gl_Position = vec4(x / uRes.x * 2.0 - 1.0, 1.0 - (s.y - uCanvas.x) / uCanvas.y * 2.0, 0.0, 1.0);
      vEdge = edge;
    }`;
  const FS = `
    precision highp float;
    uniform sampler2D tMap;
    uniform float uChroma, uRadius, uFx, uFade0, uFade1, uRing;
    uniform vec2 uSize, uUvScale, uUvOffset;
    uniform vec4 uRingC;
    varying vec2 vUv;
    varying float vEdge;
    varying float vY;
    void main() {
      vec2 uv = uUvOffset + vUv * uUvScale;
      vec4 base = texture2D(tMap, uv);
      float fx = smoothstep(0.0003, uFx, vEdge);
      float ca = uChroma / max(uSize.x, 1.0) * uUvScale.x * fx * (0.4 + vEdge);
      float r = texture2D(tMap, uv + vec2(ca, 0.0)).r;
      float b = texture2D(tMap, uv - vec2(ca, 0.0)).b;
      float mask = clamp((vY - uFade0) / (uFade1 - uFade0), 0.0, 1.0);
      vec2 q = abs(vUv * uSize - uSize * 0.5) - uSize * 0.5 + uRadius;
      float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - uRadius;
      if (uRadius > 0.0) mask *= 1.0 - smoothstep(0.0, 1.5, d);
      vec3 rgb = mix(base.rgb, vec3(r, base.g, b), fx);
      vec4 col = vec4(rgb * base.a, base.a);
      if (uRing > 0.0) {
        float ra = uRingC.a * smoothstep(-uRing - 0.5, -uRing + 0.5, d);
        col = vec4(uRingC.rgb * ra, ra) + col * (1.0 - ra);
      }
      gl_FragColor = col * mask;
    }`;
  let U = {}, aUv = 0, grids = new Map(), prog = null;
  function initGL() {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    U = {};
    ['uRes', 'uCanvas', 'uRect', 'uZone', 'uFan', 'uPow', 'tMap', 'uChroma', 'uRadius', 'uFx', 'uFade0', 'uFade1', 'uSize', 'uUvScale', 'uUvOffset', 'uRing', 'uRingC']
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

  const SEL = (home
    ? ['.h-striped', '.h-card', '.h-clip-back', '.h-clip-front', '.h-h2', '.h-cover', '.h-case-title', '.h-case-desc',
      '.h-contact', '.h-quote', '.h-row', '.h-sticker', '.h-copy', '.pg-title', '.pg-body > *',
      '.pg-facts', '.pg-note', '.pg-next', '.pg-figure video']
    : ['h1.title', '.b-text .leaf', '.b-h2 h2', '.b-h3 h3', '.b-list .row', '.b-page .pg', '.b-file .file', '.b-next .next',
      '.b-toggle > summary', '.b-callout .box', '.b-divider > div', '.cap', '.b-image img', '.b-video video',
      '.page-icon img', '.cover img']).join(', ');
  const OWN_BOX = home ? '.h-striped, .h-card, .h-cover, .h-contact, .h-quote, .h-clip-back, .h-clip-front, .h-sticker, .pg-file, .pg-callout, .pg-hr, .pg-next, .h-ring'
    : '.b-callout .box, .b-divider > div';
  const tiles = [];
  const byEl = new Map();
  for (const el of main.querySelectorAll(SEL)) {
    const kind = el.tagName === 'VIDEO' ? 'video' : home ? 'paint' : el.tagName === 'IMG' ? 'img' : 'paint';
    const padX = home && el.matches('.h-case-desc') ? 8 : 0;
    const zoom = home && el.classList.contains('h-cover');
    const t = { el, kind, padX, zoom, tex: null, ready: false, busy: false, gen: 0, top: 0, left: 0, w: 0, h: 0, fresh: false };
    tiles.push(t); byEl.set(el, t);
  }
  const isTile = (n) => byEl.has(n);
  const tall = home || tiles.some((t) => t.kind === 'video');

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
    let ul = null;
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
    const upper = home && st.textTransform === 'uppercase';
    if (!lines.length) return false;
    for (const ln of lines) {
      const base = ln.top + (ln.height - asc - desc) / 2 + asc - o.top;
      const s = text.slice(ln.start, ln.end);
      ctx.fillText(upper ? s.toUpperCase() : s, ln.left - o.left, base);
      if (ul) {
        const th = parseFloat(ul.textDecorationThickness) || Math.max(1, fs * 0.05);
        const off = parseFloat(ul.textUnderlineOffset) || fs * 0.1;
        ctx.fillStyle = ul.textDecorationColor || st.color;
        ctx.fillRect(ln.left - o.left, base + off, ln.right - ln.left, th);
        ctx.fillStyle = st.color;
      }
    }
    return true;
  }
  function drawMarker(ctx, li, st, o, alpha) {
    const type = st.listStyleType;
    let mark = type === 'disc' ? '•' : type === 'circle' ? '◦' : type === 'square' ? '▪' : '';
    if (type === 'decimal') {
      let k = parseInt(li.parentElement.getAttribute('start'), 10) || 1;
      for (let p = li.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === 'LI') k++;
      mark = k + '.';
    }
    if (!mark) return false;
    const walk = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let first = null;
    while (walk.nextNode()) if (walk.currentNode.data.trim()) { first = walk.currentNode; break; }
    if (!first) return false;
    const i = first.data.search(/\S/);
    const range = document.createRange();
    range.setStart(first, i); range.setEnd(first, i + 1);
    const rr = range.getClientRects()[0];
    if (!rr) return false;
    const fst = getComputedStyle(first.parentElement);
    ctx.save();
    ctx.font = `${fst.fontStyle} ${fst.fontWeight} ${fst.fontSize} ${fst.fontFamily}`;
    ctx.fillStyle = getComputedStyle(li, '::marker').color || st.color;
    ctx.globalAlpha = alpha; ctx.textAlign = 'right';
    const fs = parseFloat(fst.fontSize) || 16, m = ctx.measureText('Hg');
    const asc = m.fontBoundingBoxAscent || fs * 0.8, desc = m.fontBoundingBoxDescent || fs * 0.2;
    ctx.fillText(mark, li.getBoundingClientRect().left - ctx.measureText(' ').width - o.left, rr.top + (rr.height - asc - desc) / 2 + asc - o.top);
    ctx.restore();
    return true;
  }
  const len = (v, of) => (v && v.endsWith('%') ? (parseFloat(v) / 100) * of : parseFloat(v) || 0);
  const blend = (m) => (m === 'multiply' ? 'multiply' : m === 'plus-lighter' ? 'lighter' : 'source-over');
  function shadowsOf(st) {
    const out = [];
    const re = /(rgba?\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(\s+inset)?/gi;
    let m;
    while ((m = re.exec(st.boxShadow || ''))) out.push({ color: m[1], x: +m[2], y: +m[3], blur: +m[4], spread: +m[5], inset: !!m[6] });
    return out;
  }
  function addRound(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const FAR = 10000;
  function drawShadow(ctx, x, y, w, h, rad, s, dpr) {
    ctx.save();
    ctx.shadowColor = s.color; ctx.shadowBlur = s.blur * dpr;
    ctx.shadowOffsetX = (s.x + FAR) * dpr; ctx.shadowOffsetY = s.y * dpr;
    ctx.fillStyle = '#000';
    if (s.inset) {
      ctx.beginPath(); addRound(ctx, x, y, w, h, rad); ctx.clip();
      const m = s.blur * 2 + Math.abs(s.x) + Math.abs(s.y) + s.spread + 4;
      ctx.beginPath();
      ctx.rect(x - m - FAR, y - m, w + 2 * m, h + 2 * m);
      addRound(ctx, x + s.spread - FAR, y + s.spread, w - 2 * s.spread, h - 2 * s.spread, Math.max(0, rad - s.spread));
      ctx.fill('evenodd');
    } else {
      ctx.beginPath(); addRound(ctx, x - s.spread - FAR, y - s.spread, w + 2 * s.spread, h + 2 * s.spread, rad + s.spread); ctx.fill();
    }
    ctx.restore();
  }
  const pics = new Map();
  const picUrl = (st) => { const m = /^url\("(.+)"\)$/.exec(st.backgroundImage || ''); return m ? m[1] : null; };
  function drawBoxHome(ctx, st, frags, o, alpha, dpr) {
    const sh = shadowsOf(st), url = picUrl(st), pic = url && pics.get(url);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => (st['border' + s + 'Style'] !== 'none' ? parseFloat(st['border' + s + 'Width']) || 0 : 0));
    if (!sh.length && transparent(st.backgroundColor) && !pic && !bw.some((w) => w > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha; ctx.globalCompositeOperation = blend(st.mixBlendMode);
    for (const f of frags) {
      const x = f.left - o.left, y = f.top - o.top, w = f.width, h = f.height;
      const rad = Math.min(len(st.borderTopLeftRadius, Math.min(w, h)), w / 2, h / 2);
      for (const s of sh) if (!s.inset) drawShadow(ctx, x, y, w, h, rad, s, dpr);
      if (!transparent(st.backgroundColor)) { ctx.fillStyle = st.backgroundColor; ctx.beginPath(); addRound(ctx, x, y, w, h, rad); ctx.fill(); }
      if (pic && pic.naturalWidth) {
        const [sw, shh] = (st.backgroundSize || 'auto').split(' ');
        const pw = sw && sw !== 'auto' ? len(sw, w) : pic.naturalWidth, ph = shh && shh !== 'auto' ? len(shh, h) : pic.naturalHeight;
        const [px, py] = (st.backgroundPosition || '0px 0px').split(' ');
        const bx = px.endsWith('%') ? (parseFloat(px) / 100) * (w - pw) : parseFloat(px) || 0;
        const by = py && py.endsWith('%') ? (parseFloat(py) / 100) * (h - ph) : parseFloat(py) || 0;
        ctx.drawImage(pic, x + bx, y + by, pw, ph);
      }
      for (const s of sh) if (s.inset) drawShadow(ctx, x, y, w, h, rad, s, dpr);
      if (bw.every((v) => v > 0) && bw.every((v) => v === bw[0])) {
        ctx.strokeStyle = st.borderTopColor; ctx.lineWidth = bw[0];
        ctx.beginPath(); addRound(ctx, x + bw[0] / 2, y + bw[0] / 2, w - bw[0], h - bw[0], Math.max(0, rad - bw[0] / 2)); ctx.stroke();
      }
    }
    ctx.restore();
    return true;
  }
  function drawPseudo(ctx, n, which, nr, o, alpha, dpr) {
    const ps = getComputedStyle(n, which);
    if (!ps.content || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' || ps.position !== 'absolute') return;
    const op = parseFloat(ps.opacity), a = alpha * (isNaN(op) ? 1 : op);
    const w = parseFloat(ps.width), h = parseFloat(ps.height);
    if (a <= 0 || !(w > 0) || !(h > 0)) return;
    const ns = getComputedStyle(n);
    const left = nr.left + (parseFloat(ns.borderLeftWidth) || 0) + len(ps.left, nr.width);
    const top = nr.top + (parseFloat(ns.borderTopWidth) || 0) + len(ps.top, nr.height);
    return drawBoxHome(ctx, ps, [{ left, top, width: w, height: h }], o, a, dpr);
  }
  function drawImg(ctx, img, st, r, o, alpha) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih || (img.tagName === 'IMG' && !img.complete)) return;
    const x = r.left - o.left, y = r.top - o.top, w = r.width, h = r.height;
    ctx.save();
    ctx.globalAlpha = alpha;
    const rad = Math.min(len(st.borderTopLeftRadius, Math.min(w, h)), w / 2, h / 2);
    ctx.beginPath(); addRound(ctx, x, y, w, h, rad); ctx.clip();
    const ia = iw / ih, ba = w / h;
    if (st.objectFit === 'cover' && Math.abs(ia / ba - 1) > 0.002) {
      const dw = ia > ba ? h * ia : w, dh = ia > ba ? h : w / ia;
      ctx.drawImage(img, x - (dw - w) / 2, y - (dh - h) / 2, dw, dh);
    } else ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    return true;
  }
  async function preload(el) {
    const imgs = el.tagName === 'IMG' ? [el] : [...el.querySelectorAll('img')];
    for (const im of imgs) if (!im.complete || !im.naturalWidth) im.loading = 'eager';
    const waits = imgs.map((im) => im.decode().catch(() => {}));
    for (const n of [el, ...el.querySelectorAll('*')]) {
      const u = picUrl(getComputedStyle(n));
      if (u && !pics.has(u)) { const im = new Image(); im.src = u; pics.set(u, im); }
    }
    for (const im of pics.values()) waits.push(im.decode().catch(() => {}));
    await Promise.all(waits);
  }

  async function paint(t) {
    const el = t.el;
    if (home) await preload(el);
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return null;
    const r = t.padX ? { left: b.left - t.padX, top: b.top, width: b.width + 2 * t.padX, height: b.height } : b;
    let dpr = Math.min(window.devicePixelRatio || 1, home ? 2 : 3);
    if (home) dpr = Math.min(dpr, 2048 / Math.max(r.width, r.height));
    const c = document.createElement('canvas');
    c.width = Math.ceil(r.width * dpr); c.height = Math.ceil(r.height * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.textBaseline = 'alphabetic';
    if (!el.matches(OWN_BOX)) { ctx.fillStyle = bgOf(el); ctx.fillRect(0, 0, r.width, r.height); }
    const jobs = [];
    const layers = [{ c, ctx, n: el.matches(OWN_BOX) ? 0 : 1 }];
    let cur = layers[0];
    const put = (ok) => { if (ok) cur.n++; };
    const walkHome = (n, alpha) => {
      if (n.nodeType === 3) { put(drawText(cur.ctx, n, r, alpha, el)); return; }
      if (n.nodeType !== 1 || (n !== el && isTile(n))) return;
      if (n.tagName === 'VIDEO' && n.classList.contains('lc-v')) {
        if (n.readyState < 2) return;
        layers.push({ el: n, dx: 0, dy: 0, w: 0, h: 0 });
        const c2 = document.createElement('canvas');
        c2.width = c.width; c2.height = c.height;
        const x2 = c2.getContext('2d'); x2.scale(dpr, dpr); x2.textBaseline = 'alphabetic';
        layers.push(cur = { c: c2, ctx: x2, n: 0 });
        return;
      }
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const op = parseFloat(st.opacity), a = alpha * (isNaN(op) ? 1 : op);
      if (a <= 0) return;
      const nr = n.getBoundingClientRect();
      if (n.tagName === 'CANVAS' && n.classList.contains('live')) {
        layers.push({ el: n, dx: nr.left - r.left, dy: nr.top - r.top, w: nr.width, h: nr.height });
        const c2 = document.createElement('canvas');
        c2.width = c.width; c2.height = c.height;
        const x2 = c2.getContext('2d'); x2.scale(dpr, dpr); x2.textBaseline = 'alphabetic';
        layers.push(cur = { c: c2, ctx: x2, n: 0 });
        return;
      }
      put(drawBoxHome(cur.ctx, st, st.display === 'inline' ? [...n.getClientRects()] : [nr], r, a, dpr));
      if (n.tagName === 'IMG' || n.tagName === 'CANVAS') { put(drawImg(cur.ctx, n, st, nr, r, a)); return; }
      if (st.display === 'list-item' && st.listStylePosition === 'outside') put(drawMarker(cur.ctx, n, st, r, a));
      put(drawPseudo(cur.ctx, n, '::before', nr, r, a, dpr));
      for (const ch of n.childNodes) walkHome(ch, a);
      put(drawPseudo(cur.ctx, n, '::after', nr, r, a, dpr));
    };
    if (home) {
      walkHome(el, 1);
      const more = layers.slice(1).filter((L) => L.el || L.n > 0);
      if (more.length) c.more = more;
      return c;
    }
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
          if (!t.hooked) {
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
      if (gen !== t.gen || lost || off) return;
      if (t.tex) gl.deleteTexture(t.tex);
      t.tex = texture(src);
      if (src.more) {
        t.more = src.more.map((L) => (L.el
          ? { el: L.el, tex: texture(L.el), v: L.el.glassV, dx: L.dx, dy: L.dy, w: L.w, h: L.h }
          : { tex: texture(L.c) }));
      }
      if (t.kind === 'video') t.ring = ringOf(t.el);
      const rr = getComputedStyle(t.el).borderTopLeftRadius;
      t.radius = home ? Math.min(len(rr, Math.min(t.w, t.h)), t.w / 2, t.h / 2) : parseFloat(rr) || 0;
      t.ready = true;
      dirty = true; wake();
    } catch (e) {   } finally { t.busy = false; }
  }
  function ringOf(el) {
    const n = home && el.parentElement && el.parentElement.querySelector(':scope > .h-ring');
    const s = n && shadowsOf(getComputedStyle(n)).find((x) => x.inset);
    const m = s && /rgba?\(([^)]+)\)/.exec(s.color);
    if (!m || !(s.spread > 0)) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { w: s.spread, c: [r / 255, g / 255, b / 255, a] };
  }
  function evict(t) {
    t.gen++;
    if (t.tex && !lost) gl.deleteTexture(t.tex);
    if (t.more && !lost) for (const L of t.more) gl.deleteTexture(L.tex);
    t.tex = null; t.more = null; t.ready = false;
  }

  function measure() {
    const sy = window.scrollY;
    for (const t of tiles) {
      const r = t.el.getBoundingClientRect();
      t.top = r.top + sy; t.left = r.left - t.padX; t.w = r.width + 2 * t.padX; t.h = r.height;
    }
  }

  let syncTop = 0, syncRO = null, tocHome = null;
  function moveMain(sy) { main.style.transform = `translate3d(0, ${syncTop - sy}px, 0)`; }
  function setupSync() {
    syncTop = main.getBoundingClientRect().top + window.scrollY;
    const toc = main.querySelector('.toc');
    if (toc) { tocHome = [toc, toc.parentNode, toc.nextSibling]; document.body.appendChild(toc); }
    const fit = () => { document.body.style.minHeight = Math.ceil(syncTop + main.offsetHeight) + 'px'; };
    fit();
    Object.assign(main.style, { position: 'fixed', top: '0', left: '0', right: '0', willChange: 'transform' });
    moveMain(window.scrollY);
    syncRO = new ResizeObserver(fit);
    syncRO.observe(main);
    document.addEventListener('click', syncLink);
    if (location.hash) requestAnimationFrame(() => syncTo(document.getElementById(decodeURIComponent(location.hash.slice(1))), 'auto'));
  }
  function syncTo(el, how) {
    if (!el || !main.contains(el)) return false;
    const m = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - m, behavior: how });
    return true;
  }
  function syncLink(e) {
    const a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = id && document.getElementById(id);
    if (el && syncTo(el, reduce ? 'auto' : 'smooth')) {
      e.preventDefault(); history.pushState(null, '', '#' + id);
      if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true });
    }
  }
  function teardownSync() {
    if (!sync) return;
    if (syncRO) syncRO.disconnect();
    for (const k of ['position', 'top', 'left', 'right', 'willChange', 'transform']) main.style[k] = '';
    document.removeEventListener('click', syncLink);
    document.body.style.minHeight = '';
    if (tocHome) tocHome[1].insertBefore(tocHome[0], tocHome[2]);
  }
  if (sync) setupSync();

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
    if (hooks) { const h = hooks; hooks = null; h.off(); }
    try { sessionStorage.setItem('lens-off', why); } catch (e) {   }
  }
  function wake() { if (!running && !off) { running = true; lastT = 0; requestAnimationFrame(frame); } }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true; hideCurtain();
    for (const t of tiles) { t.tex = null; t.more = null; t.ready = false; t.gen++; }
    if (hooks) hooks.lost();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try { initGL(); lost = false; dirty = true; resize(); idle(prepareAhead, { timeout: 500 }); if (hooks) hooks.restored(); wake(); } catch (e) { turnOff('webgl'); }
  });

  let hooks = null;
  function own() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.enableVertexAttribArray(aUv);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  function drawTwins(left, top, width, height) {
    const sy = window.scrollY;
    gl.useProgram(prog); gl.enableVertexAttribArray(aUv);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(U.uRes, width, H);
    gl.uniform2f(U.uCanvas, top, height);
    gl.uniform1f(U.uFan, 0); gl.uniform1f(U.uChroma, 0);
    gl.uniform1f(U.uFade0, -2e6); gl.uniform1f(U.uFade1, -1e6);
    let all = true;
    for (const t of tiles) {
      const y = t.top - sy;
      if (t.left >= left + width || t.left + t.w <= left || y >= top + height || y + t.h <= top) continue;
      if (!t.ready) { all = false; if (!t.busy && t.h > 0) prepare(t); continue; }
      const b = box(t, sy);
      drawTwin(t, b[0] - left, b[1], b[2], b[3]);
    }
    return all;
  }
  if (home) window.__homeLens = {
    gl, canvas, drawTwins, tiles,
    hook(h) { hooks = h; dirty = true; wake(); },
    wake() { dirty = true; wake(); },
    size() { return { W, H, dpr: Math.min(window.devicePixelRatio || 1, 2) }; },
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cTop = Math.floor(H * (1 - P.zone) - FADE) - 2;
    cH = H - cTop;
    if (tall && !strip) { cTop = 0; cH = H; }
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(cH * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = cH + 'px';
    if (!lost) gl.viewport(0, 0, canvas.width, canvas.height);
    curtain.style.height = Math.ceil(H * P.zone) + 'px';
    curtain.style.background = pageBg();
    if (W !== lastW) { for (const t of tiles) if (t.kind !== 'video' || !t.ready) evict(t); lastW = W; }
    measure();
    dirty = true;
  }

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

  function frame(now) {
    if (off) { running = false; return; }
    try {
      if (!step(now)) { running = false; return; }
      requestAnimationFrame(frame);
    } catch (e) {
      turnOff('error');
    }
  }

  function step(now) {
    if (document.hidden) { lastT = 0; lastY = -1; return false; }
    const sy = window.scrollY;
    if (sync) moveMain(sy);
    const hNow = window.innerHeight;
    if (hNow !== H) {
      H = hNow;
      if (tall || H * P.zone + FADE + 4 > cH) resize(); else { cTop = H - cH; curtain.style.height = Math.ceil(H * P.zone) + 'px'; }
      dirty = true;
    }
    const raw = lastT ? now - lastT : 16.7;
    const dt = Math.min(Math.max(raw, 4), 100);
    lastT = now;
    const dy = lastY < 0 ? 0 : Math.abs(sy - lastY);
    const moved = dy > 0;
    lastY = sy;
    still = moved ? 0 : still + 1;
    if (still >= 2) vel = 0;
    else vel += (dy / dt - vel) * (1 - Math.exp(-dt / SMOOTH));
    const target = Math.min(vel / FULL_SPEED, 1);
    const sdt = dt / 1000;
    kv += (OMEGA * OMEGA * (target - k) - 2 * OMEGA * kv) * sdt;
    k += kv * sdt;
    if (k < 0) { k = 0; kv = 0; } else if (k > 1) { k = 1; kv = 0; }
    if (still >= 2 && k < 0.002 && Math.abs(kv) < 0.01) { k = 0; kv = 0; }

    if (moved && raw < 1000) {
      movingMs += raw; movingFrames++;
      if (movingMs >= 1200) {
        if (movingMs / movingFrames > SLOW) { turnOff('slow'); return false; }
        movingMs = 0; movingFrames = 0;
      }
    }
    if (moved && still === 0 && Math.abs(sy - (prepareAhead.at || 0)) > H / 2) { prepareAhead.at = sy; queueIdle(); }

    const want = hooks ? hooks.want(now, moved) : false;
    if (!armed || lost) {
      hideCurtain();
      if (!hooks || lost || (!want && !dirty)) return false;
      dirty = false;
      own();
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      hooks.draw(now);
      return want;
    }
    const g = Math.min(1, (now - armT) / GATE);
    const gate = g * g * (3 - 2 * g);

    const zoneTop = H * (1 - P.zone);
    const fadeTop = zoneTop - FADE;
    const live = [];
    let allReady = true, video = false;
    for (const t of tiles) {
      const top = t.top - sy, bottom = top + t.h;
      if (bottom <= fadeTop || top >= H) continue;
      live.push(t);
      if (t.kind === 'video' && t.ready && t.src !== t.el && t.el.readyState >= 2) evict(t);
      if (!t.ready) { allReady = false; if (!t.busy) prepare(t); }
      if (t.kind === 'video' && t.src === t.el && !t.el.paused) { video = true; if (t.poll) t.poll(); }
    }
    const busy = moved || k > 0 || kv !== 0 || video || gate < 1 || want;
    if (!dirty && !busy) return false;
    dirty = false;
    if (hooks) own();
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!allReady || !live.length) { hideCurtain(); if (!allReady) dirty = true; }
    else {
      if (!shown) { curtain.style.display = 'block'; shown = true; }
      const e = k * k * (3 - 2 * k);
      gl.uniform2f(U.uRes, W, H);
      gl.uniform2f(U.uCanvas, cTop, cH);
      gl.uniform1f(U.uFan, (P.fan + P.boost * e) * gate);
      gl.uniform1f(U.uChroma, P.chroma * (0.6 + 0.9 * e) * gate);
      gl.uniform1f(U.uFade0, fadeTop); gl.uniform1f(U.uFade1, zoneTop);
      for (const t of live) {
        const whole = tall && t.kind === 'video' && t.src === t.el && !t.el.paused;
        if (whole) { gl.uniform1f(U.uFade0, -2e6); gl.uniform1f(U.uFade1, -1e6); }
        const b = box(t, sy);
        drawTwin(t, b[0], b[1], b[2], b[3]);
        if (whole) { gl.uniform1f(U.uFade0, fadeTop); gl.uniform1f(U.uFade1, zoneTop); }
      }
    }
    if (hooks) hooks.draw(now);
    return true;
  }
  function quad(tex, left, top, width, height, radius, sx, syc, ox, oy, ring) {
    gl.uniform4f(U.uRect, left, top, width, height);
    gl.uniform1f(U.uRing, ring ? ring.w : 0);
    if (ring) gl.uniform4f(U.uRingC, ring.c[0], ring.c[1], ring.c[2], ring.c[3]);
    gl.uniform2f(U.uSize, width, height);
    gl.uniform1f(U.uRadius, radius);
    gl.uniform2f(U.uUvScale, sx, syc);
    gl.uniform2f(U.uUvOffset, ox, oy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const gr = grid(8, Math.min(240, Math.max(4, Math.ceil(height / 4))));
    gl.bindBuffer(gl.ARRAY_BUFFER, gr.vb);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gr.ib);
    gl.drawElements(gl.TRIANGLES, gr.count, gl.UNSIGNED_SHORT, 0);
  }
  function box(t, sy) {
    if (!t.zoom) return [t.left, t.top - sy, t.w, t.h];
    const r = t.el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  }
  function drawTwin(t, left, top, w, h) {
    const width = w || t.w, height = h || t.h;
    if (t.fresh && t.src === t.el) {
      t.fresh = false;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.el);
    }
    let sx = 1, syc = 1, ox = 0, oy = 0;
    if (t.nw && t.nh) {
      const boxA = width / height, imgA = t.nw / t.nh;
      if (imgA > boxA * 1.001) { sx = boxA / imgA; ox = (1 - sx) / 2; } else if (imgA < boxA / 1.001) { syc = imgA / boxA; oy = (1 - syc) / 2; }
    }
    quad(t.tex, left, top, width, height, t.radius || 0, sx, syc, ox, oy, t.ring);
    if (!t.more) return;
    for (const L of t.more) {
      if (!L.el) { quad(L.tex, left, top, width, height, t.radius || 0, 1, 1, 0, 0); continue; }
      if (L.el.tagName === 'VIDEO') {
        if (!L.el.parentNode || !L.el.parentNode.classList.contains('lc-on') || L.el.readyState < 2) continue;
        if (L.v !== L.el.lcV) { L.v = L.el.lcV; gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.el); }
        quad(L.tex, left, top, width, height, t.radius || 0, 1, 1, 0, 0);
        continue;
      }
      if (L.v !== L.el.glassV) {
        L.v = L.el.glassV;
        gl.bindTexture(gl.TEXTURE_2D, L.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L.el);
      }
      quad(L.tex, left + L.dx, top + L.dy, L.w, L.h, 0, 1, 1, 0, 0);
    }
  }

  window.addEventListener('scroll', () => {
    if (!armed && bend) { armed = true; armT = performance.now(); }
    wake();
  }, { passive: true });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); queueIdle(); wake(); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { dirty = true; wake(); } });
  new ResizeObserver(() => { measure(); dirty = true; wake(); }).observe(main);
  window.addEventListener('load', () => { measure(); dirty = true; queueIdle(); });
  if (home) main.addEventListener('home-glass', (e) => {
    for (const t of tiles) if (e.detail.contains(t.el) || t.el.contains(e.detail)) evict(t);
    dirty = true; queueIdle(); wake();
  });
  if (home) main.addEventListener('home-glass-tick', () => {
    if (!armed || off || lost || !shown) return;
    const sy = window.scrollY, fadeTop = H * (1 - P.zone) - FADE;
    for (const t of tiles) if (t.more && t.ready && t.top - sy + t.h > fadeTop && t.top - sy < H) { dirty = true; wake(); return; }
  });
  if (home) main.addEventListener('lc-tick', (e) => {
    if (!armed || off || lost || !shown) return;
    const t = byEl.get(e.detail), sy = window.scrollY, fadeTop = H * (1 - P.zone) - FADE;
    if (t && t.ready && t.top - sy + t.h > fadeTop && t.top - sy < H) { dirty = true; wake(); }
  });
  const CONTROL = 'a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
  const navEl = document.querySelector('.h-nav-in');
  const navBottom = () => { const b = navEl ? navEl.getBoundingClientRect().bottom : 0; return b > 0 && b < H / 2 ? b : 0; };
  document.addEventListener('focusin', (e) => {
    if (off || !main.contains(e.target) || e.target === main || !e.target.matches(CONTROL)) return;
    requestAnimationFrame(() => {
      const r = e.target.getBoundingClientRect();
      const lim = H * (1 - P.zone) - FADE - 12;
      let kb = true;
      try { kb = e.target.matches(':focus-visible'); } catch (x) {   }
      const top = (kb ? navBottom() : 0) + 12;
      if (sync && !off && r.top < (kb ? top : 0)) window.scrollBy(0, r.top - top);
      else if (kb && r.top < top && r.bottom > 0) window.scrollBy(0, r.top - top);
      else if (r.bottom > lim && (r.top < H || (sync && !off))) {
        const up = kb ? Math.min(r.bottom - lim, r.top - top) : r.bottom - lim;
        if (up > 0) window.scrollBy(0, up);
      }
    });
  });

  resize();
  queueIdle();
  wake();
})();
