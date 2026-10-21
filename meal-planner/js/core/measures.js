// Бытовые меры без весов: граммы → «половина стакана», «2 столовые ложки», «1 луковица среднего размера»,
// «половина пачки фарша (пачка 500 г)». Слова и склонение — core/qty.js (без цифровых дробей и сокращений).
// Граммы — основа хранения (КБЖУ, цены, покупки); мера считается заново от граммов при каждом числе порций,
// поэтому округления не накапливаются. Плотности и размеры — data/kitchen/measures.json (с источниками).

import { qty, mlText, NOUNS } from './qty.js';

export const CUP_ML = 250;
const TBSP_ML = 15;
const TSP_ML = 5;

// Допуск округления (доля от граммов): обычные продукты и критичные пропорции (крупа : жидкость)
export const TOLERANCE = 0.15;
export const RATIO_TOLERANCE = 0.05;


// Сетка стаканов: ¼ … 2 — все доли, дальше — четверти и половинки
const CUPS = [];
for (let w = 0; w <= 12; w++) for (const f of w < 3 ? [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75] : [0, 0.5]) if (w + f >= 0.25) CUPS.push(w + f);
// Доли упаковки: четверти и трети; пятые — где иначе слишком грубо (пачка макарон 500 г = 5 порций по 100 г)
const PACKS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 4 / 3, 1.5, 5 / 3, 1.75, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];
const PACKS_FIFTHS = [0.2, 0.4, 0.6, 0.8];

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
      out.push({ unit: 'cup', n, g: n * gc, noun: 'стакан' });
      // точная жидкость к крупе: стаканы + остаток ложками («1 стакан и ещё три четверти стакана и 2 столовые ложки»)
      if (exact) {
        const fl = CUPS.filter((v) => v <= cups + 1e-9).pop();
        const t = fl ? half(((cups - fl) * CUP_ML) / TBSP_ML) : 0;
        if (fl && t >= 1 && t <= 4) out.push({ unit: 'cup+tbsp', n: fl, g: fl * gc + t * gTbsp(m), noun: 'стакан', plus: { n: t, noun: 'столовая ложка' } });
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
    if (t >= 1 && t <= maxTbsp) out.push({ unit: 'tbsp', n: t, g: t * gt, noun: 'столовая ложка' });
  }
  if (gs) {
    const t = half(grams / gs);
    if (t >= 0.5 && t < 3) out.push({ unit: 'tsp', n: t, g: t * gs, noun: 'чайная ложка' });
  }
  if (m.pinch_g && grams / m.pinch_g < 4.5) {
    const n = Math.max(1, Math.round(grams / m.pinch_g));
    out.push({ unit: 'pinch', n, g: n * m.pinch_g, noun: 'щепотка', bare1: true });
  }
  return out;
}
function pieceOptions(m, grams) {
  const p = m.piece;
  if (!p?.g) return [];
  const raw = grams / p.g;
  const step = p.step || (p.half ? 0.5 : 1);
  const n = Math.max(step, Math.round(raw / step) * step);
  return [{ unit: 'piece', n, g: n * p.g, noun: p.forms, size: p.size || null, of: p.of || null, named: true }];
}
// «около 170 г», «около 330 мл»: граммы расчёта, круглым числом
const about = (grams, m) => {
  const v = m.liquid && gCup(m) ? (grams / gCup(m)) * CUP_ML : grams;
  const r = v < 100 ? Math.max(5, Math.round(v / 5) * 5) : Math.round(v / 10) * 10;
  return r >= 1000 ? `${String(Math.round(r / 100) / 10).replace('.', ',')} ${m.liquid ? 'л' : 'кг'}` : `${r} ${m.liquid ? 'мл' : 'г'}`;
};
// S42: доля упаковки — всегда с граммами расчёта («треть пачки (около 170 г из пачки 500 г)»), а если доля
// заметно расходится с расчётом — «чуть больше трети»; совсем малая доля — граммами («около 80 г»). Целые
// упаковки и упаковки с весом на этикетке (банка 400 г, без жидкости 240 г) — как раньше: «(банка 400 г)»
function packOptions(m, grams) {
  const p = m.pack;
  if (!p?.g) return [];
  const share = grams / p.g;
  const size = p.label || (p.g >= 1000 && p.g % 1000 === 0 ? p.g / 1000 + ' кг' : p.g + (m.liquid ? ' мл' : ' г'));
  const gen = NOUNS[p.forms[0]]?.sg[1] || p.forms[1];
  if (share < 0.18) {
    if (p.label) return [];
    return [{ unit: 'pack', n: share, g: grams, noun: p.forms, small: true, approx: about(grams, m), tail: ` (меньше пятой части ${gen} ${size})` }];
  }
  let n = nearest(PACKS, share);
  const f = nearest(PACKS_FIFTHS, share);
  if (share < 1 && Math.abs(n - share) / share > 0.2 && Math.abs(f - share) < Math.abs(n - share)) n = f;
  const whole = Number.isInteger(n);
  const off = (n * p.g - grams) / grams;
  const pre = !whole && n < 1 && Math.abs(off) > 0.08 ? (off < 0 ? 'чуть больше' : 'чуть меньше') : null;
  const tail = whole || p.label ? ` (${p.forms[0]} ${size})` : n < 1 ? ` (около ${about(grams, m)} из ${gen} ${size})` : ` (всего около ${about(grams, m)}; ${p.forms[0]} ${size})`;
  return [{ unit: 'pack', n, g: n * p.g, noun: p.forms, pre, tail }];
}
function sliceOptions(m, grams) {
  const s = m.slice;
  if (!s?.g) return [];
  const n = Math.max(1, Math.round(grams / s.g));
  return [{ unit: 'slice', n, g: n * s.g, noun: s.forms }];
}

// Жидкость от литра — литрами («полтора литра воды»): 12 стаканов никто не отмеряет
function literOptions(m, grams) {
  if (!m.liquid || !gCup(m)) return [];
  const l = ((grams / gCup(m)) * CUP_ML) / 1000;
  if (l < 0.95) return [];
  const n = Math.max(1, half(l));
  return [{ unit: 'liter', n, g: (n * 1000 * gCup(m)) / CUP_ML, noun: 'литр' }];
}
// Целые банки и упаковки, когда продукта на всю упаковку и больше (томаты: «2 банки», а не «3 стакана и ещё четверть стакана»);
// «1 упаковка и ещё треть» — только если упаковок много, иначе стаканами (S42: мера не скачет от порций)
const wholePacks = (m, g) => {
  if (!m.pack?.g || g < m.pack.g * 0.9) return [];
  const share = g / m.pack.g;
  const near = Math.abs(share - Math.round(share * 2) / 2) <= 0.08 * share;
  return packOptions(m, g).map((o) => (near || share >= 1.75 ? { ...o, prefer: true } : o));
};

const BY_KIND = {
  cup: (m, g, o) => [...cupOptions(m, g, o), ...spoonOptions(m, g, o), ...literOptions(m, g), ...wholePacks(m, g)],
  spoon: (m, g, o) => [...spoonOptions(m, g, { maxTbsp: 8 }), ...(g / (gCup(m) || Infinity) > 0.45 ? cupOptions(m, g, o) : [])],
  piece: (m, g) => pieceOptions(m, g),
  pack: (m, g) => packOptions(m, g),
  slice: (m, g) => sliceOptions(m, g),
};
const ORDER = ['cup', 'spoon', 'piece', 'pack', 'slice'];

// Мера для граммов продукта. m — запись measures.json, as — вид меры (иначе m.kind).
// → { amount: «половина стакана», noun (название меры для qty.js), of: «чеснока» | null, size: «среднего размера» | null,
//     named (мера — само название продукта: «2 яйца»), tail: « (пачка 500 г)», unit, n, g, err }
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
  return best && { ...best, amount: words(best) };
}

// Мера словами в падеже: «половина стакана», «половину луковицы среднего размера», «1 стакан и 2 столовые ложки»
export function words(r, cas = 'nom') {
  if (!r) return '';
  if (r.small) return `около ${r.approx}`;
  // «чуть больше трети пачки» — после «больше/меньше» родительный падеж
  if (r.pre) return `${r.pre} ${qty(r.n, r.noun, 'gen')}`;
  let t = qty(r.n, r.noun, cas, { bare1: !!r.bare1 });
  if (r.plus) t += ` и ${qty(r.plus.n, r.plus.noun, cas)}`;
  // размер — после первого существительного: «1 перец среднего размера и ещё четверть перца»
  if (r.size) t = t.includes(' и ещё ') ? t.replace(' и ещё ', ` ${r.size} и ещё `) : `${t} ${r.size}`;
  return t;
}

// Падеж названия продукта: { nom, gen, dat, acc, ins, prep }
export const nameOf = (m, cas = 'nom', fallback = '') => m?.ru?.[cas] || m?.ru?.nom || fallback;

// Миллилитры жидкости по показанной мере: вода, молоко, сливки, кефир — всегда; масло и другие жидкости,
// которые отмеряют ложками, — если больше 2 столовых ложек. Литры — уже метрическая мера, им мл не нужны
export function mlOf(m, r) {
  if (!m?.liquid || !r || r.unit === 'liter' || r.unit === 'pack' || r.unit === 'piece' || r.unit === 'slice' || r.unit === 'pinch') return null;
  const gc = gCup(m);
  if (!gc) return null;
  const ml = (r.g / gc) * CUP_ML;
  if (m.kind === 'spoon' && ml <= 2 * TBSP_ML + 1e-6) return null;
  return mlText(ml);
}

// Текст: только мера («1 стакан») или мера с продуктом («1 стакан риса», «2 зубчика чеснока», «1 луковица среднего размера»).
// cas — падеж меры в шаге: «влей половину стакана воды», «смажь форму 1 столовой ложкой масла»
export function measureText(m, grams, { as, exact, full = false, showGrams = false, liquid = false, cas = null } = {}) {
  const r = measure(m, grams, { as, exact });
  if (!r) return null;
  let t = words(r, cas || 'nom');
  if (full) t += r.named ? (r.of ? ' ' + r.of : '') : ' ' + nameOf(m, 'gen');
  if (r.tail) t += r.tail;
  const ml = mlOf(m, r);
  // S41: малая доля стакана — ещё и ложками: мерного стакана у новичка нет, а ложка есть всегда
  const sp = spoonsOf(m, r);
  const inner = [sp, ml].filter(Boolean);
  if (inner.length) t += ` (${inner.join(', ')})`;
  else if (showGrams) t += r.tail ? ` — ${gramsLabel(grams, m, liquid)}` : ` (${gramsLabel(grams, m, liquid)})`;
  return t;
}

// Доля стакана без мерного стакана (S41): сыпучее до половины стакана, жидкость до трети — столовыми ложками
// («треть стакана сухарей (5 столовых ложек)», «треть стакана молока (5 столовых ложек, 80 мл)»)
export function spoonsOf(m, r) {
  if (!r || r.unit !== 'cup' || r.n > (m?.liquid ? 1 / 3 : 0.5) + 1e-9) return null;
  const t = Math.round((r.n * CUP_ML) / TBSP_ML);
  return t >= 3 ? qty(t, 'столовая ложка') : null;
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
