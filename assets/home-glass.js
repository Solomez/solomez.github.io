// home-glass.js: the still glass of the new home page (REDESIGN_HOME.md, stage 4): the chips on every cover, the lens and
// the sphere over the stripes, drawn as Figma's GLASS effect (home/SPEC.md: refraction, depth, dispersion, light angle
// and intensity, read from tokens.css; the tint is the element's own CSS background).
//
// The effect, read off the Figma renders (home/stage4/): inside a bevel `depth` px wide the backdrop is sampled toward
// the centre, by depth × refraction × GAIN px at the edge, falling with the cube of the distance; red is bent a tenth
// × dispersion more than green and blue a tenth less; the tint lies over the result; a 1 px rim is bright on the lit
// side and dark opposite, with a second bright line 1 px inside on the dark side.
//
// Everything is drawn once (again on resize, when the fonts arrive or a picture changes): one WebGL canvas, kept off
// the page, renders each piece, and the result is copied into a plain 2D <canvas> inside the element, under its text.
// The CSS tint of a piece goes only once its glass is in place, so without WebGL (or if it fails) the page looks as
// before. Only the hero moves, clockwise, on its own, frames only while the panel is on screen (stage 5, the designer:
// «при движении под кольцом картинка не меняется, нужно сделать это динамичным»), in one of three ways (?ring=):
// - a (?ring=a2), an edgeless field (made for an ask that turned out to be about the cursor lens): the stripes
//   stand still; one liquid field of refraction turns clockwise over them: two soft lenses (where the lens and the sphere
//   were) pull the stripes toward the centre, their strength and their radius uneven round the circumference, a few
//   lobes drifting at different speeds; the pull falls to nothing smoothly at the field's edge and beyond, the colour
//   split and the faint tint fade with it, no rim lines; so no circle reads anywhere;
// - a1 «поток под стеклом», the default (the designer's choice): the stripes inside the glass turn about a point beside
//   the centre, so they slide through the lens and the sphere and bend as they go;
// - b «живое стекло»: the stripes stand still; the ring is uneven like poured glass (its bevel widens and narrows round
//   the circumference, WOBBLE) and turns, so the bend travels round over the stripes;
// - c: the stage-4 turn, stripes and glass round one centre (everything refracted turns as one picture).
// The bottom lens (lens.js) copies these canvases into its twins («home-glass» event); the lens and sphere canvases are
// marked «live» and counted (glassV) so lens.js and home-live.js draw them fresh each frame («home-glass-tick»).
// The hero's lens and sphere (not the chips) have a rounded rim (designer, 2026-10-23: «у стекла эппловского прикольный
// эффект, что грани скруглены, а у тебя они очень острые, резко обрезаются»): the bevel is a quarter circle in section,
// the bend follows its slope, softly capped so the picture never folds (it grows toward the edge and the stripes roll
// over it, magnified at most 1/ROUND.min times); the edge is smoothed over ROUND.aa px; the light is a soft specular band
// on the lit side, a faint Fresnel glow round the whole rim and a slight shade opposite; a soft CSS shadow lies under
// the lens and the sphere (home.css, body.glass-round). ?round=0 brings back the sharp rim; ?round=roll,spec,fresnel,shade.
// Off with prefers-reduced-transparency (the CSS tints get denser instead); no turning with prefers-reduced-motion.
// Tuning: ?glass=gain,power,rim,cap,light-angle (?glass=0 turns it off); ?spin=seconds per turn (?spin=0 stops it);
// ?field=R1,S1,R2,S2,lobes,tint (a: radius and pull in px of the outer and the inner lens, unevenness, tint),
// ?flow=dx,dy (a1), ?wobble=amount (b).
(() => {
  const body = document.body;
  const main = document.querySelector('main.h-main');
  if (!body.classList.contains('home') || !main) return;
  const qs = new URLSearchParams(location.search);
  if (qs.get('glass') === '0') return;
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return;
  const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the ring round the photo turns (designer, 2026-10-22: «хочу чтобы круг вокруг аватарки прокручивался по часовой
  // стрелке, при этом будет создаваться эффект преломления»; it replaced a hover orbit of the sphere that looked lopsided)
  const SPIN_PERIOD = (Number(qs.get('spin')) || 20) * 1000;   // ms: one clockwise turn of the stripes in the lens
  const SPIN_RAMP = 1200;             // ms: the turn eases in after the page loads
  // a1 is the default: the designer chose the first «поток под стеклом» (2026-10-22, «1 вариант за основу берем»); his
  // «границы круга не были видны» was about the cursor lens (home-live.js), so the edgeless field stays as ?ring=a2
  let RING = (qs.get('ring') || 'a1').toLowerCase();           // a1, a2 (= a), b or c, see the top
  if (RING === 'a2') RING = 'a';
  const FIELD = { R1: 165, S1: 24, R2: 138, S2: 36, lobes: 0.5, tint: 1 };   // a: see the shader FLOW
  if (qs.get('field')) {
    const [r1, s1, r2, s2, l, t] = qs.get('field').split(',').map(Number);
    if (r1 > 0) FIELD.R1 = r1; if (s1 >= 0) FIELD.S1 = s1; if (r2 > 0) FIELD.R2 = r2; if (s2 >= 0) FIELD.S2 = s2; if (l >= 0) FIELD.lobes = l; if (t >= 0) FIELD.tint = t;
  }
  const FLOW = (qs.get('flow') || '-22,18').split(',').map(Number);   // a1: the turning point, px from the lens centre
  const WOBBLE = qs.get('wobble') !== null ? Number(qs.get('wobble')) : 0.35;   // b: how uneven the ring is (0 = even)
  // the effect, fitted to the Figma renders
  const T = { gain: 0.92, power: 3, rim: 0.3, cap: 0.5, ang: 0 };   // cap: the bevel is at most this × the shorter side
  if (qs.get('glass')) {
    const [g, p, r, c, a] = qs.get('glass').split(',').map(Number);
    if (g > 0) T.gain = g; if (p > 0) T.power = p; if (r >= 0) T.rim = r; if (c >= 0) T.cap = c; if (a) T.ang = a;
  }
  // the rounded rim of the hero (see the top): min: the least the picture is stretched (1 − the steepest bend change);
  // roll: how fast the bend reaches it; spec, at, w: the specular band (strength, px inside the edge, half-width px);
  // fres, fw: the Fresnel glow and how far it reaches (px); shade, sw: the far side's shade; aa: the edge's soft px
  const ROUND = { on: qs.get('round') !== '0', min: 0.15, roll: 2.5, spec: 0.5, at: 1.8, w: 3, fres: 0.12, fw: 7, shade: 0.16, sw: 9, aa: 1.5 };
  if (qs.get('round') && qs.get('round') !== '0') {
    const [r, s, f, d] = qs.get('round').split(',').map(Number);
    if (r > 0) ROUND.roll = r; if (s >= 0) ROUND.spec = s; if (f >= 0) ROUND.fres = f; if (d >= 0) ROUND.shade = d;
  }
  const DISP = 0.1;                   // red bends (1 + DISP × dispersion) times green, blue (1 − DISP × dispersion)

  // ------------------------------------------------------------------ parameters from tokens.css
  const cs = getComputedStyle(body);
  const num = (n, d) => { const x = parseFloat(cs.getPropertyValue(n)); return isNaN(x) ? d : x; };
  const param = (k, d) => ({
    refr: num(`--home-glass-${k}-refraction`, d[0]), depth: num(`--home-glass-${k}-depth`, d[1]),
    disp: num(`--home-glass-${k}-dispersion`, d[2]), angle: num(`--home-glass-${k}-light-angle`, d[3]),
    light: num(`--home-glass-${k}-light-intensity`, d[4]),
  });
  const P = { chip: param('chip', [1, 100, 1, -45, 0.8]), lens: param('lens', [0.8, 42.11, 0.7, 315, 0.9]), sphere: param('sphere', [1, 65.11, 0.5, 315, 1]) };
  P.lens.round = P.sphere.round = ROUND.on;
  const rgba = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return [0, 0, 0, 0];
    const v = m[1].split(/[\s,\/]+/).map(parseFloat);
    return [v[0] / 255, v[1] / 255, v[2] / 255, isNaN(v[3]) ? 1 : v[3]];
  };
  const pageBg = () => { const c = cs.backgroundColor; return !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) ? '#fff' : c; };

  // ------------------------------------------------------------------ WebGL: one canvas off the page
  const glc = document.createElement('canvas');
  const gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return;
  const VS = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() { vUv = aPos; gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0); }`;
  const FS = `
    precision highp float;
    uniform sampler2D tMap;
    uniform vec2 uSize;            // the piece, css px
    uniform float uRadius;         // its corner radius
    uniform vec2 uOrigin, uMap;    // where the piece lies in the backdrop, and the backdrop's size (css px)
    uniform float uDepth, uRefr, uDisp, uAngle, uLight, uGain, uPower, uRim, uCap;
    uniform vec4 uTint;
    uniform vec3 uSpin;            // turn the backdrop about (x, y) by z radians, clockwise on screen (0 for the chips)
    uniform vec2 uWobble;          // the uneven ring (b): its turn angle, how much the bevel varies (0 = even)
    uniform float uRound;          // 1: the hero's rounded rim and volume light; 0: the chips, as they were
    uniform vec4 uRoll;            // rounded rim: 1 − least stretch, slope gain, edge soft px, unused
    uniform vec4 uSpec, uFres;     // specular: strength, px in, half-width; Fresnel: strength, reach px, shade, its reach px
    varying vec2 vUv;
    vec2 spin(vec2 q) {
      vec2 v = q - uSpin.xy;
      float c = cos(uSpin.z), s = sin(uSpin.z);
      return uSpin.xy + vec2(c * v.x + s * v.y, -s * v.x + c * v.y);   // where the turned stripes came from
    }
    vec2 mirror(vec2 uv) { return 1.0 - abs(mod(uv, 2.0) - 1.0); }     // beyond the backdrop: its reflection
    float box(vec2 p, vec2 h, float r) {                        // signed distance to the rounded box, + outside
      vec2 q = abs(p) - h + r;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
    }
    void main() {
      vec2 h = uSize * 0.5;
      float r = min(uRadius, min(h.x, h.y));
      vec2 p = vUv * uSize - h;
      float sd = box(p, h, r);
      float cover = uRound > 0.5 ? clamp(0.5 - sd / uRoll.z, 0.0, 1.0) : clamp(0.5 - sd, 0.0, 1.0);   // soft edge
      if (cover <= 0.0) discard;
      vec2 e = vec2(0.5, 0.0);                                  // outward normal from the distance field
      vec2 n = normalize(vec2(box(p + e.xy, h, r) - box(p - e.xy, h, r), box(p + e.yx, h, r) - box(p - e.yx, h, r)) + vec2(1e-6, 0.0));
      float d = max(-sd, 0.0);                                  // px inside the edge
      float depth = uCap > 0.0 ? min(uDepth, uCap * min(uSize.x, uSize.y)) : uDepth;   // a small pill has a small bevel
      float phi = atan(p.y, p.x) - uWobble.x;                   // poured glass: the bevel widens and narrows round the ring
      depth *= 1.0 + uWobble.y * (0.6 * sin(2.0 * phi) + 0.4 * sin(3.0 * phi + 1.3));
      float s;                                                  // bend toward the centre
      if (uRound > 0.5) {
        // a quarter circle in section: slope t / sqrt(1 − t²), t = 1 at the edge; the bend changes by its slope × gain,
        // softly capped at uRoll.x px per px so the picture never folds: s = ∫ b·σ / sqrt(σ² + a²), a = b / gain
        float t = clamp(1.0 - d / depth, 0.0, 1.0), b = uRoll.x, a = b / max(uRefr * uGain * uRoll.y, 1e-3);
        s = depth * b * t * t / (sqrt(t * t * (1.0 - a * a) + a * a) + a);
      } else s = depth * uRefr * uGain * pow(clamp(1.0 - d / depth, 0.0, 1.0), uPower);
      vec3 k = vec3(1.0 + DISP * uDisp, 1.0, 1.0 - DISP * uDisp);
      vec2 at = uOrigin + vUv * uSize;
      vec3 col = vec3(texture2D(tMap, mirror(spin(at - n * s * k.r) / uMap)).r,
                      texture2D(tMap, mirror(spin(at - n * s * k.g) / uMap)).g,
                      texture2D(tMap, mirror(spin(at - n * s * k.b) / uMap)).b);
      col = mix(col, uTint.rgb, uTint.a);
      vec2 L = vec2(-cos(uAngle), sin(uAngle));                 // toward the light (315° = top left)
      float lit = dot(n, L);
      if (uRound > 0.5) {                                       // volume: specular band, Fresnel glow, far-side shade
        float q = (d - uSpec.y) / uSpec.z;
        float hi = uSpec.x * max(lit, 0.0) * max(lit, 0.0) * exp(-q * q) + uFres.x * exp(-d / uFres.y);
        col *= 1.0 - uFres.z * max(-lit, 0.0) * max(-lit, 0.0) * exp(-d / uFres.w);
        col = 1.0 - (1.0 - col) * (1.0 - clamp(uLight * hi, 0.0, 1.0));   // screen: light adds without clipping
      } else {
        float outer = exp(-d * d * 2.0), inner = exp(-(d - 1.0) * (d - 1.0) * 2.0);
        float up = lit > 0.0 ? lit * lit : -lit * lit;
        col += uLight * uRim * (up * outer + 0.6 * max(-lit, 0.0) * max(-lit, 0.0) * inner);
      }
      gl_FragColor = vec4(clamp(col, 0.0, 1.0) * cover, cover);
    }`.replace(/DISP/g, DISP.toFixed(3));
  // variant a: the whole panel in one pass. Two soft lenses pull the stripes toward the centre: the pull rises toward
  // each lens' edge and falls to nothing there smoothly (x^12 (1-x)^2: flat at the edge, nothing beyond); the edge's
  // radius and the pull's strength vary round the circumference with lobes that drift at different speeds, the whole
  // field turning clockwise (uT). The colour split is a tenth × dispersion of the pull, the tint fades out with x.
  const FLOW_FS = `
    precision highp float;
    uniform sampler2D tMap;
    uniform vec2 uSize;            // the panel, css px
    uniform float uRadius;
    uniform vec2 uC;               // the centre of the field
    uniform vec4 uOuter, uInner;   // a lens: radius px, pull px, dispersion, unused
    uniform float uT, uLobes, uTintA;
    varying vec2 vUv;
    float box(vec2 p, vec2 h, float r) {
      vec2 q = abs(p) - h + r;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
    }
    vec2 mirror(vec2 uv) { return 1.0 - abs(mod(uv, 2.0) - 1.0); }
    float pull(float r, float phi, vec4 f, float seed) {
      float R = f.x * (1.0 + 0.24 * uLobes * (0.5 * sin(2.0 * (phi - uT) + seed) + 0.3 * sin(3.0 * (phi - 0.7 * uT) + 2.1 * seed) + 0.2 * sin(5.0 * (phi - 1.3 * uT) + 0.7)));
      float x = r / R;
      if (x >= 1.0) return 0.0;
      float g = pow(x, 12.0) * (1.0 - x) * (1.0 - x) * 312.0;
      float m = 1.0 + uLobes * (0.6 * sin(2.0 * (phi - 1.1 * uT) + 1.0 + seed) + 0.4 * sin(4.0 * (phi - 0.8 * uT) + seed));
      return f.y * g * max(m, 0.0);
    }
    void main() {
      vec2 h = uSize * 0.5;
      vec2 p = vUv * uSize - h;
      float cover = clamp(0.5 - box(p, h, min(uRadius, min(h.x, h.y))), 0.0, 1.0);
      if (cover <= 0.0) discard;
      vec2 at = vUv * uSize;
      vec2 v = at - uC;
      float r = length(v), phi = atan(v.y, v.x);
      vec2 n = v / max(r, 0.001);
      float s1 = pull(r, phi, uOuter, 0.0), s2 = pull(r, phi, uInner, 1.7);
      float s = s1 + s2;
      float disp = s > 0.0 ? (s1 * uOuter.z + s2 * uInner.z) / s : 0.0;
      vec3 k = vec3(1.0 + DISP * disp, 1.0, 1.0 - DISP * disp);
      vec3 col = vec3(texture2D(tMap, mirror((at - n * s * k.r) / uSize)).r,
                      texture2D(tMap, mirror((at - n * s * k.g) / uSize)).g,
                      texture2D(tMap, mirror((at - n * s * k.b) / uSize)).b);
      col = mix(col, vec3(1.0), uTintA * (1.0 - smoothstep(0.55, 1.0, r / uOuter.x)));
      gl_FragColor = vec4(col * cover, cover);
    }`.replace(/DISP/g, DISP.toFixed(3));
  let U = {}, prog = null, F = {}, flowProg = null;
  function initGL() {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = (fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    prog = link(FS);
    gl.useProgram(prog);
    U = {};
    ['tMap', 'uSize', 'uRadius', 'uOrigin', 'uMap', 'uDepth', 'uRefr', 'uDisp', 'uAngle', 'uLight', 'uGain', 'uPower', 'uRim', 'uCap', 'uTint', 'uSpin', 'uWobble', 'uRound', 'uRoll', 'uSpec', 'uFres']
      .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(U.tMap, 0);
    gl.uniform1f(U.uGain, T.gain); gl.uniform1f(U.uPower, T.power); gl.uniform1f(U.uRim, T.rim); gl.uniform1f(U.uCap, T.cap);
    gl.uniform4f(U.uRoll, 1 - ROUND.min, ROUND.roll, ROUND.aa, 0);
    gl.uniform4f(U.uSpec, ROUND.spec, ROUND.at, ROUND.w, 0); gl.uniform4f(U.uFres, ROUND.fres, ROUND.fw, ROUND.shade, ROUND.sw);
    flowProg = link(FLOW_FS);
    gl.useProgram(flowProg);
    F = {};
    ['tMap', 'uSize', 'uRadius', 'uC', 'uOuter', 'uInner', 'uT', 'uLobes', 'uTintA'].forEach((n) => { F[n] = gl.getUniformLocation(flowProg, n); });
    gl.uniform1i(F.tMap, 0);
    gl.useProgram(prog);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
  }
  try { initGL(); } catch (e) { return; }
  function upload(src) {
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

  // ------------------------------------------------------------------ 2D helpers
  const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);
  const stat = { renders: 0, frames: 0, ms: 0, fms: 0 };   // checks of stage 4 (window.homeGlass); fms: ms in the turn's frames
  window.homeGlass = stat;
  function sheet(w, h, dpr) {                          // a canvas of w × h css px at the screen's density
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * dpr)); c.height = Math.max(1, Math.ceil(h * dpr));
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    return [c, ctx];
  }
  function rel(el, root) {                             // a box in the coordinates of its root, css px
    const a = el.getBoundingClientRect(), b = root.getBoundingClientRect();
    return { left: a.left - b.left, top: a.top - b.top, width: a.width, height: a.height };
  }
  const len = (v, of) => (v && v.endsWith('%') ? (parseFloat(v) / 100) * of : parseFloat(v) || 0);
  const radiusOf = (el, r) => Math.min(len(getComputedStyle(el).borderTopLeftRadius, Math.min(r.width, r.height)), r.width / 2, r.height / 2);
  function round(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawCover(ctx, img, r) {                    // a picture with object-fit: cover, clipped to its corners
    if (!img || !img.naturalWidth) return;
    ctx.save();
    round(ctx, r.left, r.top, r.width, r.height, radiusOf(img, r)); ctx.clip();
    const ia = img.naturalWidth / img.naturalHeight, ba = r.width / r.height;
    const dw = ia > ba ? r.height * ia : r.width, dh = ia > ba ? r.height : r.width / ia;
    ctx.drawImage(img, r.left - (dw - r.width) / 2, r.top - (dh - r.height) / 2, dw, dh);
    ctx.restore();
  }
  async function decode(img) {
    if (!img) return;
    if (!img.complete || !img.naturalWidth) { img.loading = 'eager'; await img.decode().catch(() => {}); }
  }
  // a piece: its glass rendered from the backdrop texture and copied into its own canvas
  function render(el, box, tex, origin, map, p, tint, turn, wobble) {
    const dpr = dprOf();
    const pw = Math.ceil(box.width * dpr), ph = Math.ceil(box.height * dpr);
    if (glc.width < pw || glc.height < ph) { glc.width = Math.max(glc.width, pw); glc.height = Math.max(glc.height, ph); }
    gl.viewport(0, glc.height - ph, pw, ph); gl.scissor(0, glc.height - ph, pw, ph);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    if (p === FIELD) {                                 // variant a: the field over the whole panel
      gl.useProgram(flowProg);
      gl.uniform2f(F.uSize, box.width, box.height); gl.uniform1f(F.uRadius, radiusOf(el, box));
      gl.uniform2f(F.uC, turn[0], turn[1]); gl.uniform1f(F.uT, turn[2]);
      gl.uniform4f(F.uOuter, p.R1, p.S1, P.lens.disp, 0); gl.uniform4f(F.uInner, p.R2, p.S2, P.sphere.disp, 0);
      gl.uniform1f(F.uLobes, p.lobes); gl.uniform1f(F.uTintA, tint[3] * p.tint);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(prog);
      return copy(el, box, pw, ph, 'h-flow');
    }
    gl.uniform2f(U.uSize, box.width, box.height);
    gl.uniform1f(U.uRadius, radiusOf(el, box));
    gl.uniform2f(U.uOrigin, origin[0], origin[1]); gl.uniform2f(U.uMap, map[0], map[1]);
    gl.uniform1f(U.uDepth, p.depth); gl.uniform1f(U.uRefr, p.refr); gl.uniform1f(U.uDisp, p.disp);
    gl.uniform1f(U.uAngle, ((T.ang || p.angle) * Math.PI) / 180); gl.uniform1f(U.uLight, p.light);
    gl.uniform4f(U.uTint, tint[0], tint[1], tint[2], tint[3]);
    const t = turn || [0, 0, 0], w = wobble || [0, 0];
    gl.uniform3f(U.uSpin, t[0], t[1], t[2]);
    gl.uniform2f(U.uWobble, w[0], w[1]);
    gl.uniform1f(U.uRound, p.round ? 1 : 0);            // only the hero's lens and sphere
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return copy(el, box, pw, ph, 'h-glass');
  }
  // the drawn piece into its own canvas: .h-glass as the first child, under the text; .h-flow (variant a) over the stripes
  function copy(el, box, pw, ph, cls) {
    let cv = cls === 'h-flow' ? el.querySelector(':scope > .h-flow') : el.firstElementChild;
    if (!cv || !cv.classList.contains(cls)) {
      cv = document.createElement('canvas');
      cv.className = cls; cv.setAttribute('aria-hidden', 'true');
      const img = cls === 'h-flow' && el.querySelector(':scope > img');
      if (img) img.after(cv); else el.insertBefore(cv, el.firstChild);
    }
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; cv.style.width = box.width + 'px'; cv.style.height = box.height + 'px'; }
    const c2 = cv.getContext('2d');
    c2.clearRect(0, 0, pw, ph);
    c2.drawImage(glc, 0, 0, pw, ph, 0, 0, pw, ph);
    el.classList.add('glassed');
    stat.renders++;
    return cv;
  }
  const tintOf = (el) => rgba(getComputedStyle(el).backgroundColor);   // the CSS tint before the glass replaces it
  const done = (el) => main.dispatchEvent(new CustomEvent('home-glass', { detail: el }));

  // ------------------------------------------------------------------ the chips of a cover
  const rendered = new Map();                          // element -> the layout it was last drawn at
  const sizeKey = (el) => [el, ...el.querySelectorAll('.h-chip, .h-lens, .h-sphere, .h-photo')]
    .map((n) => { const r = n.getBoundingClientRect(); return `${r.left},${r.top},${r.width},${r.height}`; }).join(';') + '@' + dprOf();
  async function renderCover(cover) {
    const chips = [...cover.querySelectorAll('.h-chip')];
    if (!chips.length) return;
    const img = cover.querySelector('img');
    await decode(img);
    const t0 = performance.now();
    const cr = cover.getBoundingClientRect();
    if (!cr.width) return;
    const st = getComputedStyle(cover);
    const rects = chips.map((c) => rel(c, cover));
    // the backdrop: the cover (its colour and picture within its corners) and the page around, as far as the bend reaches
    const reach = Math.ceil(P.chip.depth * P.chip.refr * T.gain) + 4;   // the cap only shortens it
    const x0 = Math.floor(Math.min(...rects.map((r) => r.left)) - reach), y0 = Math.floor(Math.min(...rects.map((r) => r.top)) - reach);
    const x1 = Math.ceil(Math.max(...rects.map((r) => r.left + r.width)) + reach), y1 = Math.ceil(Math.max(...rects.map((r) => r.top + r.height)) + reach);
    const [c, ctx] = sheet(x1 - x0, y1 - y0, dprOf());
    ctx.translate(-x0, -y0);
    ctx.fillStyle = pageBg(); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    round(ctx, 0, 0, cr.width, cr.height, radiusOf(cover, cr)); ctx.clip();
    ctx.fillStyle = st.backgroundColor; ctx.fillRect(0, 0, cr.width, cr.height);
    if (img) drawCover(ctx, img, rel(img, cover));
    const tex = upload(c);
    chips.forEach((chip, i) => {
      const tint = chip.classList.contains('glassed') ? rendered.get(chip).tint : tintOf(chip);
      render(chip, rects[i], tex, [rects[i].left - x0, rects[i].top - y0], [x1 - x0, y1 - y0], P.chip, tint);
      rendered.set(chip, { key: sizeKey(chip), tint });
    });
    gl.deleteTexture(tex);
    rendered.set(cover, { key: sizeKey(cover) });
    stat.ms += performance.now() - t0;
    done(cover);
  }

  // ------------------------------------------------------------------ the hero: lens, then the sphere over lens and photo
  // Lens and sphere are circles round one centre, so the turning is drawn from the still stripes: every frame the glass
  // is rendered anew with its samples turned about that centre. The bend and the colour split travel with the stripes,
  // the light on the rims stays put, and the stripes outside the lens stay still. The sphere's backdrop (the stripes
  // seen through the lens) is made once at rest: the lens' own rim lies outside what the sphere's bevel reaches.
  let hero = null;                                     // the two backdrops, kept for the turning
  async function renderHero() {
    const panel = main.querySelector('.h-striped');
    if (!panel) return;
    const stripes = panel.querySelector('.h-stripes'), lens = panel.querySelector('.h-lens');
    const sphere = panel.querySelector('.h-sphere'), photo = sphere && sphere.querySelector('.h-photo');
    await decode(stripes); await decode(photo);
    const t0 = performance.now();
    const pr = panel.getBoundingClientRect();
    if (!pr.width) return;
    const [c, ctx] = sheet(pr.width, pr.height, dprOf());
    ctx.fillStyle = getComputedStyle(panel).backgroundColor; ctx.fillRect(0, 0, pr.width, pr.height);
    if (stripes) drawCover(ctx, stripes, rel(stripes, panel));
    if (hero) { gl.deleteTexture(hero.lensTex); if (hero.sphereTex !== hero.lensTex) gl.deleteTexture(hero.sphereTex); hero = null; }
    // narrower windows show the panel smaller (home.css, stage 6): the bevels and the turning point shrink with it
    const k = Math.min(1, pr.width / 397);
    const h = { lensTex: upload(c), sphereTex: null, map: [pr.width, pr.height], c: [pr.width / 2, pr.height / 2], lens: null, sphere: null, sphereTint: [0, 0, 0, 0],
      k, pLens: k < 1 ? { ...P.lens, depth: P.lens.depth * k } : P.lens, pSphere: k < 1 ? { ...P.sphere, depth: P.sphere.depth * k } : P.sphere };
    if (RING === 'a') {                                // the field over the whole panel; the lens and sphere discs stay empty
      const r = lens ? rel(lens, panel) : null;
      if (r) h.c = [r.left + r.width / 2, r.top + r.height / 2];
      h.flow = { el: panel, box: { left: 0, top: 0, width: pr.width, height: pr.height }, tint: lens ? (lens.classList.contains('glassed') ? rendered.get(lens).tint : tintOf(lens)) : [1, 1, 1, 0.2] };
      for (const el of [lens, sphere]) if (el) { const cv = el.querySelector(':scope > .h-glass'); if (cv) cv.remove(); el.classList.remove('glassed'); }
      hero = h;
      drawHero(turn.angle);
      body.classList.add('ring-a');                    // home.css: no CSS disc, no glow ring
      rendered.set(panel, { key: sizeKey(panel) });
      stat.ms += performance.now() - t0;
      done(panel);
      go();
      return;
    }
    if (lens) {
      const r = rel(lens, panel);
      const tint = lens.classList.contains('glassed') ? rendered.get(lens).tint : tintOf(lens);
      h.lens = { el: lens, box: r, tint };
      h.c = [r.left + r.width / 2, r.top + r.height / 2];
      const cv = render(lens, r, h.lensTex, [r.left, r.top], h.map, h.pLens, tint, [h.c[0], h.c[1], 0]);
      rendered.set(lens, { key: sizeKey(lens), tint });
      ctx.drawImage(cv, r.left, r.top, r.width, r.height);   // the sphere sees the stripes through the lens
    }
    if (sphere) {
      const b = rel(sphere, panel);
      if (!lens) h.c = [b.left + b.width / 2, b.top + b.height / 2];
      // a: the stripes drift under the sphere, so it looks at them directly, through the lens' tint (its bevel lies
      // outside what the sphere reaches); b and c: through the lens as drawn once at rest
      if (RING === 'a1' && lens) { h.sphereTex = h.lensTex; h.sphereTint = h.lens.tint; } else h.sphereTex = upload(c);
      h.sphere = { el: sphere, box: b };
    }
    hero = h;
    drawHero(turn.angle);
    body.classList.toggle('glass-round', ROUND.on);  // home.css: the soft shadow under the lens and the sphere
    rendered.set(panel, { key: sizeKey(panel) });
    stat.ms += performance.now() - t0;
    done(panel);
    go();
  }
  let stamp = 0;
  function drawHero(a) {
    const h = hero;
    stamp++;
    if (h.flow) { live(render(h.flow.el, h.flow.box, h.lensTex, null, null, FIELD, h.flow.tint, [h.c[0], h.c[1], a])); return; }
    const t = RING === 'b' ? [h.c[0], h.c[1], 0] : RING === 'a1' ? [h.c[0] + FLOW[0] * h.k, h.c[1] + FLOW[1] * h.k, a] : [h.c[0], h.c[1], a];
    const w = RING === 'b' ? [a, WOBBLE] : [0, 0];
    if (h.lens) live(render(h.lens.el, h.lens.box, h.lensTex, [h.lens.box.left, h.lens.box.top], h.map, h.pLens, h.lens.tint, t, w));
    if (h.sphere) live(render(h.sphere.el, h.sphere.box, h.sphereTex, [h.sphere.box.left, h.sphere.box.top], h.map, h.pSphere, h.sphereTint, t, [w[0], w[1] * 0.5]));
  }
  const live = (cv) => { cv.classList.add('live'); cv.glassV = stamp; };   // for lens.js and home-live.js: drawn fresh each frame
  const tickEvent = new Event('home-glass-tick');

  // ------------------------------------------------------------------ the turn
  // a steady clockwise turn, eased in once after load; frames only while the panel is on screen and the tab is shown
  const turn = { angle: 0, speed: 0, raf: 0, last: 0, seen: false };
  function tick(now) {
    turn.raf = 0;
    if (!hero || !turn.seen || document.hidden) { turn.last = 0; return; }
    const dt = turn.last ? Math.min(now - turn.last, 50) : 0;
    turn.last = now;
    turn.speed = Math.min(1, turn.speed + dt / SPIN_RAMP);
    const k = turn.speed * turn.speed * (3 - 2 * turn.speed);
    turn.angle = (turn.angle + (k * 2 * Math.PI * dt) / SPIN_PERIOD) % (2 * Math.PI);
    const f0 = performance.now();
    try { drawHero(turn.angle); } catch (e) { return; }
    stat.frames++; stat.fms += performance.now() - f0;
    main.dispatchEvent(tickEvent);
    turn.raf = requestAnimationFrame(tick);
  }
  function go() {
    if (noMotion || qs.get('spin') === '0' || turn.raf || !hero || !turn.seen || document.hidden) return;
    turn.raf = requestAnimationFrame(tick);
  }
  {
    const panel = main.querySelector('.h-striped');
    if (panel) new IntersectionObserver(([e]) => { turn.seen = e.isIntersecting; go(); }).observe(panel);
    document.addEventListener('visibilitychange', go);
  }

  // ------------------------------------------------------------------ when to draw
  const covers = [...main.querySelectorAll('.h-cover')];
  const panel = main.querySelector('.h-striped');
  const pending = new Set();
  let timer = 0;
  function flush() {
    timer = 0;
    const jobs = [...pending]; pending.clear();
    for (const el of jobs) {
      const was = rendered.get(el);
      if (was && was.key === sizeKey(el) && !el.dataset.glassDirty) continue;
      delete el.dataset.glassDirty;
      (el === panel ? renderHero() : renderCover(el)).catch(() => {});
    }
  }
  function schedule(el, force) {
    if (force) el.dataset.glassDirty = '1';
    pending.add(el);
    if (!timer) timer = setTimeout(flush, 80);
  }
  const owner = (n) => (panel && panel.contains(n) ? panel : covers.find((c) => c.contains(n)) || null);
  // covers far down the page wait until they come near (their pictures load lazily)
  const seen = new Set();
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting && !seen.has(e.target)) { seen.add(e.target); io.unobserve(e.target); schedule(e.target); }
  }, { rootMargin: '1000px 0px' });
  // sizes change when the fonts arrive (home.js widens the chips) and on resize; pictures when the admin swaps them
  const ro = new ResizeObserver((es) => { for (const e of es) { const o = owner(e.target); if (o && rendered.has(o)) schedule(o); } });
  for (const n of main.querySelectorAll('.h-chip, .h-cover, .h-striped, .h-sphere, .h-lens')) ro.observe(n);
  for (const im of main.querySelectorAll('.h-cover img, .h-stripes, .h-photo')) im.addEventListener('load', () => { const o = owner(im); if (o) schedule(o, true); });
  // a height change alone is the iPhone toolbar folding away while scrolling: the glass stays as drawn
  let rt = 0, rw = window.innerWidth + '@' + dprOf();
  window.addEventListener('resize', () => {
    const k = window.innerWidth + '@' + dprOf();
    if (k === rw) return;
    rw = k; clearTimeout(rt);
    rt = setTimeout(() => { for (const el of rendered.keys()) if (el === panel || covers.includes(el)) schedule(el, true); }, 150);
  });
  glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); hero = null; });   // the drawn canvases stay
  glc.addEventListener('webglcontextrestored', () => { try { initGL(); schedule(panel, true); for (const c of covers) if (seen.has(c)) schedule(c, true); } catch (e) { /* stays as drawn */ } });

  const start = () => {
    if (panel) schedule(panel);
    for (const c of covers) io.observe(c);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else start();
})();
