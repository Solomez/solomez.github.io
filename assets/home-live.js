// home-live.js: the live glass of the new home page (REDESIGN_HOME.md, stage 5; the designer, 2026-10-22: «курсор
// работал как преломление под кликабельными областями»). Two pieces of glass move over the page and refract it:
// - the navigation (two Tab Bars, fixed at the top): the page scrolling under it is bent at the bevel, red and blue
//   come apart, a light rim, with Figma's GLASS numbers for the nav (tokens.css); the keys' background blur stays CSS;
// - the cursor: the Figma arrow is the system cursor (home.css); over anything clickable (links, buttons, the case
//   cards, the nav keys; not the list rows, whose letters flip) a 120 px lens grows round it in ~180 ms and refracts what it is over, moving
//   with the pointer (no easing on the position; the morph eases). It has no edge (designer, 2026-10-22: «надо сделать
//   так, чтобы границы круга не были видны вообще (надо настроить как-то преломление не ровно)»): the bend grows from
//   nothing at the rim to the middle and back, smooth all the way, its reach and strength uneven round the circle (a few
//   soft lobes that drift as the pointer travels), no tint, no rim light, and the last part fades into the page.
// Both draw through lens.js (D-56): its twins of the page blocks, its WebGL context and its canvas (on this page it
// covers the window), its safety: off for the session on a slow device, the plain page while the context is lost,
// nothing without WebGL. Each frame: the twins under the nav are drawn flat into a texture, the glass is drawn from it
// into the canvas under the nav's text (the text stays DOM); the cursor the same over its own small texture, which also
// holds the nav's glass where the two overlap. Frames only while something moves (scroll, pointer, morph, the hero's
// turn); nothing while idle. The glass model is that of home-glass.js (bevel, dispersion, rim).
// Phones and tablets, reduced motion, reduced transparency and browsers without the twins keep the CSS glass of
// home.css and the system cursor. Tuning: ?live=0 (off), ?live=nav or ?live=cursor (one of the two).
(() => {
  const body = document.body, main = document.querySelector('main.h-main');
  if (!body.classList.contains('home') || !main) return;
  const qs = new URLSearchParams(location.search);
  const mode = qs.get('live');
  if (mode === '0' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const touch = window.matchMedia('(pointer: coarse)').matches || /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  if (touch) return;
  const fine = window.matchMedia('(pointer: fine)').matches;
  if (fine && mode !== 'nav') body.classList.add('h-arrow');   // the Figma arrow; the lens below needs the twins
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return;
  const api = window.__homeLens;
  if (!api) return;
  const gl = api.gl;
  const navIn = document.querySelector('.h-nav-in');
  const pills = mode === 'cursor' || !navIn ? [] : [...navIn.querySelectorAll('.h-tabbar')];
  const cursorOn = fine && mode !== 'nav';
  if (!pills.length && !cursorOn) return;

  // ------------------------------------------------------------------ parameters (tokens.css, the fit of home-glass.js)
  const cs = getComputedStyle(body);
  const num = (n, d) => { const x = parseFloat(cs.getPropertyValue(n)); return isNaN(x) ? d : x; };
  const param = (k, d) => ({
    refr: num(`--home-glass-${k}-refraction`, d[0]), depth: num(`--home-glass-${k}-depth`, d[1]),
    disp: num(`--home-glass-${k}-dispersion`, d[2]), angle: num(`--home-glass-${k}-light-angle`, d[3]),
    light: num(`--home-glass-${k}-light-intensity`, d[4]),
  });
  const P = { nav: param('nav', [0.46, 32, 0.21, -45, 0.3]) };   // the cursor lens has its own model (LQ below)
  const T = { gain: 0.92, power: 3, rim: 0.3, cap: 0.5 };
  const rgba = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return [0, 0, 0, 0];
    const v = m[1].split(/[\s,\/]+/).map(parseFloat);
    return [v[0] / 255, v[1] / 255, v[2] / 255, isNaN(v[3]) ? 1 : v[3]];
  };
  const bg = rgba(cs.backgroundColor);
  const navTint = pills.length ? rgba(getComputedStyle(pills[0]).backgroundColor) : [1, 1, 1, 0.7];
  // the lens (Figma 96 px; the designer asked for it «немного больше», 2026-10-22), and how far its centre sits up-left
  // of the arrow's tip (Figma canvas)
  const LENS = 120, OFF = 9;
  const slow = Number(qs.get('morph')) || 1;                   // ?morph=10: the morph ten times slower, for the eye
  const GROW = 180 * slow, SHRINK = 150 * slow;                // ms: the morph
  const PAD = 8;                      // px of page round a piece in its backdrop texture
  const TRIG = 'a, button, [role="button"], summary, label, input, select, textarea, .h-case, .h-row, .h-key, .h-btn';
  // the cursor lens: reach (× the lens radius), pull (× the radius), unevenness, colour split; ?cursor=reach,pull,lobes,split
  const LQ = { reach: 0.92, pull: 0.22, lobes: 0.6, split: 0.6 };   // pull 0.22: the designer's pick (letters may fold a little)
  if (qs.get('cursor')) {
    const [a, b, c, d] = qs.get('cursor').split(',').map(Number);
    if (a > 0) LQ.reach = a; if (b >= 0) LQ.pull = b; if (c >= 0) LQ.lobes = c; if (d >= 0) LQ.split = d;
  }
  const DRIFT = 0.015;                // rad of the lobes' drift per px the pointer travels (still pointer: still lens)
  // the lens' shape (designer, 2026-10-22: «линза курсора была более динамичной, сейчас это чистый круг, можно попробовать
  // разные формы»); ?shape= to try the others:
  // - drop: stretches along the pointer's motion and trails a tail, then settles like jelly when it stops;
  // - blob: deep lobes that keep flowing, even while the pointer rests;
  // - squircle: a rounded square that turns toward the motion;
  // - circle, the default (the designer's pick after trying them, 2026-10-22: «давай круг»): the lens of before.
  const SHAPES = { circle: 0, drop: 1, blob: 2, squircle: 3 };
  const SHAPE = SHAPES[qs.get('shape')] !== undefined ? SHAPES[qs.get('shape')] : SHAPES.circle;
  const JELLY = { k: 260, c: 15 };    // the spring between the pointer's speed and the shape: stiffness, damping (a little overshoot)
  const CPAD = 92;                    // px of page round the lens in its backdrop: room for the stretch and the tail

  // ------------------------------------------------------------------ WebGL, in lens.js's context
  const VS = `
    attribute vec2 aPos;
    uniform vec4 uRect;            // where to draw: left, top, width, height (css px of the target, y down)
    uniform vec2 uRes;             // the target, css px
    varying vec2 vUv;
    void main() {
      vUv = aPos;
      vec2 p = uRect.xy + aPos * uRect.zw;
      gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
    }`;
  // the glass of home-glass.js, over a backdrop that was drawn into a texture (so rows run bottom-up: flipped here)
  const FS = `
    precision highp float;
    uniform sampler2D tMap;
    uniform vec2 uSize;            // the piece, css px
    uniform float uRadius;
    uniform vec2 uOrigin, uMap;    // where the piece lies in the backdrop, and the backdrop's size (css px)
    uniform float uDepth, uRefr, uDisp, uAngle, uLight, uGain, uPower, uRim, uCap;
    uniform vec4 uTint;
    varying vec2 vUv;
    float box(vec2 p, vec2 h, float r) {
      vec2 q = abs(p) - h + r;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
    }
    vec4 look(vec2 at) { vec2 uv = at / uMap; return texture2D(tMap, vec2(uv.x, 1.0 - uv.y)); }
    void main() {
      vec2 h = uSize * 0.5;
      float r = min(uRadius, min(h.x, h.y));
      vec2 p = vUv * uSize - h;
      float sd = box(p, h, r);
      float cover = clamp(0.5 - sd, 0.0, 1.0);
      if (cover <= 0.0) discard;
      vec2 e = vec2(0.5, 0.0);
      vec2 n = normalize(vec2(box(p + e.xy, h, r) - box(p - e.xy, h, r), box(p + e.yx, h, r) - box(p - e.yx, h, r)) + vec2(1e-6, 0.0));
      float d = max(-sd, 0.0);
      float depth = uCap > 0.0 ? min(uDepth, uCap * min(uSize.x, uSize.y)) : uDepth;
      float s = depth * uRefr * uGain * pow(clamp(1.0 - d / depth, 0.0, 1.0), uPower);
      vec3 k = vec3(1.0 + DISP * uDisp, 1.0, 1.0 - DISP * uDisp);
      vec2 at = uOrigin + vUv * uSize;
      vec3 col = vec3(look(at - n * s * k.r).r, look(at - n * s * k.g).g, look(at - n * s * k.b).b);
      col = mix(col, uTint.rgb, uTint.a);
      vec2 L = vec2(-cos(uAngle), sin(uAngle));
      float lit = dot(n, L);
      float outer = exp(-d * d * 2.0), inner = exp(-(d - 1.0) * (d - 1.0) * 2.0);
      float up = lit > 0.0 ? lit * lit : -lit * lit;
      col += uLight * uRim * (up * outer + 0.6 * max(-lit, 0.0) * max(-lit, 0.0) * inner);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0) * cover, cover);
    }`.replace(/DISP/g, '0.1');
  // the cursor lens without an edge: a smooth bulge, uneven round the circle, fading out at its reach
  const LIQ = `
    precision highp float;
    uniform sampler2D tMap;
    uniform vec2 uSize;            // the region round the lens, css px (its backdrop texture covers exactly it)
    uniform float uR, uS, uT, uLobes, uDisp, uShape;
    uniform vec3 uMove;            // the pointer's direction (x, y) and speed, px per ms, after the jelly spring
    varying vec2 vUv;
    vec4 look(vec2 at) { vec2 uv = at / uSize; return texture2D(tMap, vec2(uv.x, 1.0 - uv.y)); }
    void main() {
      vec2 at = vUv * uSize;
      vec2 v = at - uSize * 0.5;
      float sp = min(uMove.z, 2.5);
      vec2 q = vec2(dot(v, uMove.xy), dot(v, vec2(-uMove.y, uMove.x)));   // along the motion, across it
      float lob = uLobes;
      bool drop = uShape > 0.5 && uShape < 1.5, blob = uShape > 1.5 && uShape < 2.5, sq = uShape > 2.5;
      float sd = min(sp, 1.0);                                   // an ordinary hand move is 0.5–1.5 px per ms
      if (drop) { float st = 1.0 + 0.7 * sd; q = vec2(q.x / st, q.y * sqrt(st)); }   // up to 1.7× longer along, thinner across
      if (blob) lob = uLobes * 2.6;
      float phi = atan(q.y, q.x);
      float r = sq ? pow(pow(abs(q.x), 6.0) + pow(abs(q.y), 6.0), 1.0 / 6.0) * 1.08 : length(q);
      float R = uR * (1.0 + lob * (0.09 * sin(2.0 * phi + uT) + 0.06 * sin(3.0 * phi - 1.3 * uT + 1.7) + 0.04 * sin(5.0 * phi + 0.7 * uT + 0.4)));
      if (drop) R *= 1.0 + 0.5 * sd * smoothstep(0.2, 1.0, -cos(phi));     // the tail trails behind, up to 1.5×
      float x = length(q) > 0.0 ? r / max(R, 0.001) : 0.0;
      if (x >= 1.0) discard;
      float m = 1.0 + uLobes * (0.35 * sin(2.0 * phi - 0.8 * uT + 1.0) + 0.25 * sin(4.0 * phi + 1.1 * uT + 2.3));
      float g = 16.0 * x * x * (1.0 - x) * (1.0 - x);          // 0 at the middle and at the reach, flat at both, 1 between
      float s = uS * g * max(m, 0.0);
      vec2 n = v / max(length(v), 0.001);
      vec3 k = vec3(1.0 + 0.1 * uDisp, 1.0, 1.0 - 0.1 * uDisp);
      vec3 col = vec3(look(at - n * s * k.r).r, look(at - n * s * k.g).g, look(at - n * s * k.b).b);
      float a = 1.0 - smoothstep(0.82, 1.0, x);                 // the last part fades into the page itself
      gl_FragColor = vec4(col * a, a);
    }`;
  const BLIT = `
    precision mediump float;
    uniform sampler2D tMap;
    uniform vec4 uUv;              // the part of the texture: origin and size, texture space
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(tMap, uUv.xy + vUv * uUv.zw); }`;
  let G = null, B = null, Q = null, vb = null, fboA = null, fboB = null, fboC = null;
  let scale = 0;
  function program(vs, fs, names) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const o = { p };
    for (const n of names) o[n] = gl.getUniformLocation(p, n);
    return o;
  }
  function fbo(w, h) {                                 // a texture to draw into, w × h device px
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }
  function init() {
    G = program(VS, FS, ['tMap', 'uRect', 'uRes', 'uSize', 'uRadius', 'uOrigin', 'uMap', 'uDepth', 'uRefr', 'uDisp', 'uAngle', 'uLight', 'uGain', 'uPower', 'uRim', 'uCap', 'uTint']);
    B = program(VS, BLIT, ['tMap', 'uRect', 'uRes', 'uUv']);
    Q = program(VS, LIQ, ['tMap', 'uRect', 'uRes', 'uSize', 'uR', 'uS', 'uT', 'uLobes', 'uDisp', 'uShape', 'uMove']);
    gl.useProgram(G.p);
    gl.uniform1i(G.tMap, 0); gl.uniform1f(G.uGain, T.gain); gl.uniform1f(G.uPower, T.power); gl.uniform1f(G.uRim, T.rim); gl.uniform1f(G.uCap, T.cap);
    gl.useProgram(B.p); gl.uniform1i(B.tMap, 0);
    gl.useProgram(Q.p); gl.uniform1i(Q.tMap, 0);
    vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    fboA = fboB = fboC = null; scale = 0;
  }
  function target(f, w, h) {                           // bind a texture of at least w × h css px to draw into
    const pw = Math.ceil(w * scale), ph = Math.ceil(h * scale);
    if (!f || f.w !== pw || f.h !== ph) { if (f) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); } f = fbo(pw, ph); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.viewport(0, 0, pw, ph);
    return f;
  }
  function begin(p) {
    gl.useProgram(p.p);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  // the glass of a piece: from its backdrop texture (map, css px; the piece at origin in it) to a box on the target
  function glass(tex, map, origin, box, radius, p, tint, res, k) {
    begin(G);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(G.uRes, res[0], res[1]); gl.uniform4f(G.uRect, box[0], box[1], box[2], box[3]);
    gl.uniform2f(G.uSize, box[2], box[3]); gl.uniform1f(G.uRadius, radius);
    gl.uniform2f(G.uOrigin, origin[0], origin[1]); gl.uniform2f(G.uMap, map[0], map[1]);
    gl.uniform1f(G.uDepth, p.depth * (k || 1)); gl.uniform1f(G.uRefr, p.refr); gl.uniform1f(G.uDisp, p.disp);
    gl.uniform1f(G.uAngle, (p.angle * Math.PI) / 180); gl.uniform1f(G.uLight, p.light);
    gl.uniform4f(G.uTint, tint[0], tint[1], tint[2], tint[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // the cursor lens: from the backdrop of its region onto the same region of the target
  function liquid(tex, reg, radius, phase, move, res) {
    begin(Q);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(Q.uRes, res[0], res[1]); gl.uniform4f(Q.uRect, reg.left, reg.top, reg.w, reg.h);
    gl.uniform2f(Q.uSize, reg.w, reg.h);
    gl.uniform1f(Q.uR, radius * LQ.reach); gl.uniform1f(Q.uS, radius * LQ.pull); gl.uniform1f(Q.uT, phase);
    gl.uniform1f(Q.uLobes, LQ.lobes); gl.uniform1f(Q.uDisp, LQ.split);
    gl.uniform1f(Q.uShape, SHAPE); gl.uniform3f(Q.uMove, move[0], move[1], move[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // a texture (all of it, drawn bottom-up) onto a box of the target
  function blit(f, box, res) {
    begin(B);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.uniform2f(B.uRes, res[0], res[1]); gl.uniform4f(B.uRect, box[0], box[1], box[2], box[3]);
    gl.uniform4f(B.uUv, 0, 1, 1, -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  try { init(); } catch (e) { return; }

  // ------------------------------------------------------------------ the nav: where it is
  let nav = null;                                      // its box on screen, with PAD, and the pills' boxes within it
  function measure() {
    if (!pills.length) return;
    const r = navIn.getBoundingClientRect();
    const n = { left: Math.floor(r.left - PAD), top: Math.floor(r.top - PAD), w: Math.ceil(r.width + 2 * PAD) + 1, h: Math.ceil(r.height + 2 * PAD) + 1, pills: [] };
    for (const p of pills) {
      const b = p.getBoundingClientRect();
      const rad = Math.min(parseFloat(getComputedStyle(p).borderTopLeftRadius) || 0, b.height / 2);
      n.pills.push({ left: b.left - n.left, top: b.top - n.top, w: b.width, h: b.height, rad });
    }
    nav = n;
    navDirty = true;
  }

  // ------------------------------------------------------------------ state
  const stat = { nav: 0, cursor: 0, ms: 0 };          // for the checks of stage 5 (window.homeLive)
  window.homeLive = stat;                             // (stat.jel below: the jelly, for the checks)
  const cur = { x: -1, y: -1, on: false, k: 0, moved: false, last: 0, phase: 0, since: 0 };   // k: the morph, 0 arrow … 1 lens
  const GROW_MS = 800;                // a case cover grows on hover on a 760 ms spring (home.css): the glass redraws meanwhile
  // the jelly: the pointer's speed (target), the shape's speed following it on a spring, and the direction it last had
  const jel = { tx: 0, ty: 0, vx: 0, vy: 0, ax: 0, ay: 0, dir: 0, at: 0, prev: 0 };
  stat.jel = jel;
  let navDirty = true, curDirty = true, lastSy = -1, glassed = false, dead = false;
  const ease = (k) => 1 - Math.pow(1 - k, 3);
  function setGlassed(on) {
    if (glassed === on) return;
    glassed = on;
    for (const p of pills) p.classList.toggle('glassed', on);
  }
  // the lens: its centre and the backdrop region round it (css px on screen)
  function lensBox() {
    const cx = cur.x - OFF, cy = cur.y - OFF, d = LENS * ease(cur.k);
    return { cx, cy, d, left: cx - d / 2, top: cy - d / 2, reg: { left: cx - LENS / 2 - CPAD, top: cy - LENS / 2 - CPAD, w: LENS + 2 * CPAD, h: LENS + 2 * CPAD } };
  }
  const hits = (a, b) => a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;

  const hooks = {
    want(now, moved) {
      if (dead) return false;
      let more = false;
      if (cursorOn) {
        const dt = cur.last ? Math.min(now - cur.last, 50) : 0;
        cur.last = now;
        const to = cur.on ? 1 : 0;
        if (cur.k !== to) {
          cur.k = to ? Math.min(1, cur.k + dt / GROW) : Math.max(0, cur.k - dt / SHRINK);
          more = true;
        }
        if (cur.moved) { cur.moved = false; curDirty = true; more = true; }
        if (cur.k > 0 && SHAPE !== SHAPES.circle) {
          if (now - jel.at > 60) { jel.tx = 0; jel.ty = 0; }        // the pointer rests: the shape settles
          const s = dt / 1000;
          jel.ax += (JELLY.k * (jel.tx - jel.vx) - JELLY.c * jel.ax) * s; jel.vx += jel.ax * s;
          jel.ay += (JELLY.k * (jel.ty - jel.vy) - JELLY.c * jel.ay) * s; jel.vy += jel.ay * s;
          const sp = Math.hypot(jel.vx, jel.vy);
          if (sp > 0.05) jel.dir = Math.atan2(jel.vy, jel.vx);
          if (sp > 0.002 || Math.hypot(jel.ax, jel.ay) > 0.002 || jel.tx || jel.ty) more = true;
          if (SHAPE === SHAPES.blob) { cur.phase += dt * 0.0022; more = true; }   // the blob flows on its own
        } else if (cur.k === 0) { jel.vx = jel.vy = jel.ax = jel.ay = jel.tx = jel.ty = 0; }
      }
      if (now - cur.since < GROW_MS) { navDirty = curDirty = true; more = true; }   // a cover is growing or shrinking
      const sy = window.scrollY;
      if (sy !== lastSy || moved) { lastSy = sy; navDirty = curDirty = true; more = true; }
      if (!cur.on && cur.k === 0) cur.last = 0;
      return more || navDirty || (curDirty && cur.k > 0);
    },
    draw(now) {
      if (dead) return;
      const t0 = performance.now();
      const { W, H, dpr } = api.size();
      if (dpr !== scale) { scale = dpr; navDirty = curDirty = true; }
      const res = [W, H];
      if (nav) {
        if (navDirty) {
          fboA = target(fboA, nav.w, nav.h);                       // the page under the nav, flat
          gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
          const all = api.drawTwins(nav.left, nav.top, nav.w, nav.h);
          fboB = target(fboB, nav.w, nav.h);                       // the glass of the two pills
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          for (const p of nav.pills) glass(fboA.tex, [nav.w, nav.h], [p.left, p.top], [p.left, p.top, p.w, p.h], p.rad, P.nav, navTint, [nav.w, nav.h]);
          navDirty = !all;                                         // a twin still being prepared: again next frame
          stat.nav++;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, api.canvas.width, api.canvas.height);
        blit(fboB, [nav.left, nav.top, nav.w, nav.h], res);
        setGlassed(true);
      }
      if (cursorOn && cur.k > 0 && cur.x >= 0) {
        const L = lensBox();
        if (curDirty) {
          fboC = target(fboC, L.reg.w, L.reg.h);                   // the page under the lens, and the nav's glass on it
          gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
          api.drawTwins(L.reg.left, L.reg.top, L.reg.w, L.reg.h);
          if (nav && hits(L.reg, nav)) blit(fboB, [nav.left - L.reg.left, nav.top - L.reg.top, nav.w, nav.h], [L.reg.w, L.reg.h]);
          curDirty = false;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, api.canvas.width, api.canvas.height);
        liquid(fboC.tex, L.reg, L.d / 2, cur.phase, [Math.cos(jel.dir), Math.sin(jel.dir), Math.hypot(jel.vx, jel.vy)], res);
        stat.cursor++;
      }
      stat.ms += performance.now() - t0;
    },
    lost() { setGlassed(false); dead = true; },
    restored() { try { init(); dead = false; navDirty = curDirty = true; } catch (e) { dead = true; } },
    off() { setGlassed(false); dead = true; },
  };

  // ------------------------------------------------------------------ events
  if (cursorOn) {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      if (cur.x >= 0) {
        cur.phase += Math.hypot(e.clientX - cur.x, e.clientY - cur.y) * DRIFT;
        const dt = e.timeStamp - jel.prev;
        if (dt > 0 && dt < 100) { jel.tx = (e.clientX - cur.x) / dt; jel.ty = (e.clientY - cur.y) / dt; jel.at = performance.now(); }
      }
      jel.prev = e.timeStamp;
      cur.x = e.clientX; cur.y = e.clientY; cur.moved = true;
      if (cur.on || cur.k > 0) api.wake();
    }, { passive: true });
    document.addEventListener('pointerover', (e) => {
      const h = e.target.closest ? e.target.closest(TRIG) : null;
      // no lens over the outline marks (too small) and the list rows (their letters flip; designer, 2026-10-22)
      const on = !!h && !h.closest('.h-toc, .h-row');
      const card = e.target.closest ? e.target.closest('.h-case') : null;
      if (card !== cur.card) { cur.card = card; cur.since = performance.now(); api.wake(); }
      if (on !== cur.on) { cur.on = on; api.wake(); }
    });
    document.documentElement.addEventListener('pointerleave', () => { if (cur.on) { cur.on = false; api.wake(); } });
  }
  // the hero's glass turned: the nav or the lens over it is drawn anew
  main.addEventListener('home-glass-tick', () => {
    if (dead) return;
    const panel = main.querySelector('.h-striped');
    if (!panel) return;
    const r = panel.getBoundingClientRect(), b = { left: r.left, top: r.top, w: r.width, h: r.height };
    let any = false;
    if (nav && hits(b, nav)) { navDirty = true; any = true; }
    if (cursorOn && cur.k > 0 && cur.x >= 0 && hits(b, lensBox().reg)) { curDirty = true; any = true; }
    if (any) api.wake();
  });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { measure(); curDirty = true; api.wake(); }, 160); });
  if (navIn) new ResizeObserver(() => { measure(); api.wake(); }).observe(navIn);
  measure();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); api.wake(); });
  api.hook(hooks);
})();
