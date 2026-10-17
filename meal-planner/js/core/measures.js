// Бытовые меры без весов: граммы → «½ стакана», «2 ст. л.», «1 луковица среднего размера», «½ пачки фарша (500 г)».
// Граммы — основа хранения (КБЖУ, цены, покупки); мера считается заново от граммов при каждом числе порций,
// поэтому округления не накапливаются. Плотности и размеры — data/kitchen/measures.json (с источниками).

export const CUP_ML = 250;
const TBSP_ML = 15;
const TSP_ML = 5;

// Допуск округления (доля от граммов): обычные продукты и критичные пропорции (крупа : жидкость)
export const TOLERANCE = 0.15;
export const RATIO_TOLERANCE = 0.05;

const GLYPHS = [[0.25, '¼'], [0.5, '½'], [0.75, '¾'], [1 / 3, '⅓'], [2 / 3, '⅔'], [0.2, '⅕'], [0.4, '⅖'], [0.6, '⅗'], [0.8, '⅘']];
const glyph = (f) => (GLYPHS.find(([v]) => Math.abs(v - f) < 1e-6) || [0, ''])[1];

// Сетка стаканов: ¼ … 2 — все доли, дальше — четверти и половинки
const CUPS = [];
for (let w = 0; w <= 12; w++) for (const f of w < 3 ? [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75] : [0, 0.5]) if (w + f >= 0.25) CUPS.push(w + f);
// Доли упаковки: четверти и трети; пятые — где иначе слишком грубо (пачка макарон 500 г = 5 порций по 100 г)
const PACKS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 4 / 3, 1.5, 5 / 3, 1.75, 2, 2.5, 3, 4];
const PACKS_FIFTHS = [0.2, 0.4, 0.6, 0.8];

export function fmtNum(x) {
  const w = Math.floor(x + 1e-9);
  const f = x - w;
  const g = f > 1e-6 ? glyph(Math.round(f * 60) / 60) || glyph(Math.round(f * 4) / 4) : '';
  if (!w) return g || '0';
  return `${w}${g}`;
}
const nearest = (grid, x) => grid.reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b), grid[0]);
const half = (x) => Math.round(x * 2) / 2;

// Форма слова для числа: [1, 2–4 и дроби, 5+]
export function plural(n, forms) {
  if (!Number.isInteger(n)) return forms[3] || forms[1];
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return forms[0];
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return forms[1];
  return forms[2];
}
const CUP_FORMS = ['стакан', 'стакана', 'стаканов'];
const PINCH_FORMS = ['щепотка', 'щепотки', 'щепоток'];

const gCup = (m) => m.g_cup || (m.g_tbsp ? m.g_tbsp * (CUP_ML / TBSP_ML) : m.g_tsp ? m.g_tsp * (CUP_ML / TSP_ML) : 0);
const gTbsp = (m) => m.g_tbsp || (gCup(m) ? gCup(m) * (TBSP_ML / CUP_ML) : 0);
const gTsp = (m) => m.g_tsp || (gTbsp(m) ? gTbsp(m) / 3 : 0);

// Варианты меры одного вида: [{ unit, n, g (сколько это граммов), amount, of }]
function cupOptions(m, grams, { exact } = {}) {
  const out = [];
  const gc = gCup(m);
  if (gc) {
    const cups = grams / gc;
    if (cups >= 0.22) {
      const n = nearest(CUPS, cups);
      out.push({ unit: 'cup', n, g: n * gc, amount: `${fmtNum(n)} ${n >= 1 && Number.isInteger(n) ? plural(n, CUP_FORMS) : 'стакана'}` });
      // точная жидкость к крупе: стаканы + остаток ложками («1¾ стакана + 2 ст. л.»)
      if (exact) {
        const fl = CUPS.filter((v) => v <= cups + 1e-9).pop();
        const t = fl ? half(((cups - fl) * CUP_ML) / TBSP_ML) : 0;
        if (fl && t >= 1) out.push({ unit: 'cup+tbsp', n: fl, g: fl * gc + t * gTbsp(m), amount: `${fmtNum(fl)} ${fl >= 1 && Number.isInteger(fl) ? plural(fl, CUP_FORMS) : 'стакана'} + ${fmtNum(t)} ст. л.` });
      }
    }
  }
  return out;
}
function spoonOptions(m, grams, { maxTbsp = 4 } = {}) {
  const out = [];
  const gt = gTbsp(m);
  const gs = gTsp(m);
  if (gt) {
    const t = half(grams / gt);
    if (t >= 1 && t <= maxTbsp) out.push({ unit: 'tbsp', n: t, g: t * gt, amount: `${fmtNum(t)} ст. л.` });
  }
  if (gs) {
    const t = half(grams / gs);
    if (t >= 0.5 && t < 3) out.push({ unit: 'tsp', n: t, g: t * gs, amount: `${fmtNum(t)} ч. л.` });
  }
  if (m.pinch_g && grams / m.pinch_g < 4.5) {
    const n = Math.max(1, Math.round(grams / m.pinch_g));
    out.push({ unit: 'pinch', n, g: n * m.pinch_g, amount: n === 1 ? 'щепотка' : `${n} ${plural(n, PINCH_FORMS)}` });
  }
  return out;
}
function pieceOptions(m, grams) {
  const p = m.piece;
  if (!p?.g) return [];
  const raw = grams / p.g;
  const step = p.step || (p.half ? 0.5 : 1);
  const n = Math.max(step, Math.round(raw / step) * step);
  const noun = plural(n, p.forms);
  return [{ unit: 'piece', n, g: n * p.g, amount: `${fmtNum(n)} ${noun}${p.size ? ' ' + p.size : ''}`, of: p.of || null, noun: true }];
}
function packOptions(m, grams) {
  const p = m.pack;
  if (!p?.g) return [];
  const share = grams / p.g;
  if (share < 0.18) return [];
  let n = nearest(PACKS, share);
  const f = nearest(PACKS_FIFTHS, share);
  if (share < 1 && Math.abs(n - share) / share > 0.2 && Math.abs(f - share) < Math.abs(n - share)) n = f;
  return [{ unit: 'pack', n, g: n * p.g, amount: `${fmtNum(n)} ${plural(n, p.forms)}`, tail: ` (${p.forms[0]} ${p.label || (p.g >= 1000 && p.g % 1000 === 0 ? p.g / 1000 + ' кг' : p.g + (m.liquid ? ' мл' : ' г'))})` }];
}
function sliceOptions(m, grams) {
  const s = m.slice;
  if (!s?.g) return [];
  const n = Math.max(1, Math.round(grams / s.g));
  return [{ unit: 'slice', n, g: n * s.g, amount: `${n} ${plural(n, s.forms)}` }];
}

// Жидкость от литра — литрами («1½ л воды»): 12 стаканов никто не отмеряет
function literOptions(m, grams) {
  if (!m.liquid || !gCup(m)) return [];
  const l = ((grams / gCup(m)) * CUP_ML) / 1000;
  if (l < 0.95) return [];
  const n = Math.max(1, half(l));
  return [{ unit: 'liter', n, g: (n * 1000 * gCup(m)) / CUP_ML, amount: `${fmtNum(n)} л` }];
}
// Целые банки и упаковки, когда продукта на всю упаковку и больше (томаты: «2 банки», а не «3¼ стакана»)
const wholePacks = (m, g) => (m.pack?.g && g >= m.pack.g * 0.9 ? packOptions(m, g).map((o) => ({ ...o, prefer: true })) : []);

const BY_KIND = {
  cup: (m, g, o) => [...cupOptions(m, g, o), ...spoonOptions(m, g, o), ...literOptions(m, g), ...wholePacks(m, g)],
  spoon: (m, g, o) => [...spoonOptions(m, g, { maxTbsp: 8 }), ...(g / (gCup(m) || Infinity) > 0.45 ? cupOptions(m, g, o) : [])],
  piece: (m, g) => pieceOptions(m, g),
  pack: (m, g) => packOptions(m, g),
  slice: (m, g) => sliceOptions(m, g),
};
const ORDER = ['cup', 'spoon', 'piece', 'pack', 'slice'];

// Мера для граммов продукта. m — запись measures.json, as — вид меры (иначе m.kind).
// → { amount: «½ стакана», of: «чеснока» | null, noun (мера — само название: «2 яйца»), tail: « (500 г)», unit, n, g, err }
export function measure(m, grams, { as, exact } = {}) {
  if (!m || !(grams > 0)) return null;
  const kind = as || m.kind;
  const score = (o) => ({ ...o, err: Math.abs(o.g - grams) / grams });
  const pick = (opts) => {
    const sc = opts.map(score);
    // точная мера к жидкости — только если обычная хуже критичного допуска
    const plain = sc.filter((o) => o.unit !== 'cup+tbsp');
    const bestPlain = plain.reduce((b, o) => (!b || o.err < b.err - 1e-9 ? o : b), null);
    if (exact && bestPlain && bestPlain.err <= RATIO_TOLERANCE) {
      const fitExact = plain.filter((o) => o.err <= RATIO_TOLERANCE + 1e-9);
      return fitExact.find((o) => o.unit === 'liter') || bestPlain;
    }
    // самая крупная мера в пределах допуска; иначе — самая точная
    const fit = sc.filter((o) => o.err <= TOLERANCE + 1e-9);
    const rank = (o) => (o.prefer ? -2 : o.unit === 'liter' ? -1 : { cup: 0, 'cup+tbsp': exact ? -1 : 1, pack: 0, piece: 0, slice: 0, tbsp: 1, tsp: 2, pinch: 3 }[o.unit]);
    if (fit.length) return fit.sort((a, b) => rank(a) - rank(b) || a.err - b.err)[0];
    return sc.reduce((b, o) => (!b || o.err < b.err ? o : b), null);
  };
  let best = BY_KIND[kind] ? pick(BY_KIND[kind](m, grams, { exact })) : null;
  // нет подходящей меры своего вида — любая другая, что есть у продукта
  if (!best || best.err > TOLERANCE * 2) {
    const alt = pick(ORDER.filter((k) => k !== kind).flatMap((k) => BY_KIND[k](m, grams, { exact })));
    if (alt && (!best || alt.err < best.err)) best = alt;
  }
  return best;
}

// Падеж названия продукта: { nom, gen, dat, acc, ins, prep }
export const nameOf = (m, cas = 'nom', fallback = '') => m?.ru?.[cas] || m?.ru?.nom || fallback;

// Текст: только мера («1 стакан») или мера с продуктом («1 стакан риса», «2 зубчика чеснока», «1 луковица среднего размера»)
// Винительный падеж меры для «выложи 1 пачку», «добавь щепотку», «нарежь ½ луковицы» (дроби и 2–4 — уже в родительном)
function accusative(r) {
  const one = Number.isInteger(r.n) && r.n % 10 === 1 && r.n % 100 !== 11;
  if (!one && r.unit !== 'pinch') return r.amount;
  return r.amount.replace(/^((?:\d+\s)?)([а-яё]+)(а|я)(?=\s|$)/i, (all, num, stem, end) => `${num}${stem}${end === 'а' ? 'у' : 'ю'}`);
}

export function measureText(m, grams, { as, exact, full = false, showGrams = false, liquid = false, cas = null } = {}) {
  const r = measure(m, grams, { as, exact });
  if (!r) return null;
  let t = cas === 'acc' ? accusative(r) : r.amount;
  if (full) t += r.noun ? (r.of ? ' ' + r.of : '') : ' ' + nameOf(m, 'gen');
  if (r.tail) t += r.tail;
  if (showGrams) t += r.tail ? ` — ${gramsLabel(grams, m, liquid)}` : ` (${gramsLabel(grams, m, liquid)})`;
  return t;
}

// «185 г», «370 мл», «1,2 кг»
export function gramsLabel(grams, m, liquid) {
  if (liquid || m?.liquid) {
    const ml = gCup(m) ? (grams / gCup(m)) * CUP_ML : grams;
    return `${Math.round(ml / 5) * 5 || Math.round(ml)} мл`;
  }
  if (grams >= 1000) return `${String(Math.round(grams / 100) / 10).replace('.', ',')} кг`;
  if (grams < 1) return `${Math.max(0.1, Math.round(grams * 10) / 10)} г`.replace('.', ',');
  return `${grams < 10 ? Math.round(grams * 2) / 2 : Math.round(grams / 5) * 5} г`.replace('.', ',');
}

// Объём в стаканах для меры (для пропорций): сколько стаканов показано человеку
export function shownCups(m, grams, opts) {
  const r = measure(m, grams, opts);
  const gc = gCup(m);
  if (!r || !gc) return null;
  return r.g / gc;
}
export { gCup };
