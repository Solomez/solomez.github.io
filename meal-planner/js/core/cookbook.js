// Рецепт как шаблон: количества и названия в шагах подставляются из данных ингредиентов,
// поэтому «½ стакана риса» в списке не может стать «100 г риса» в шаге (data/kitchen/SCHEMA.md).
//
//   {q:rice}      → «1 стакан риса», «2 зубчика чеснока», «½ пачки фарша (500 г)»
//   {q:oil*0.5}   → половина количества слота — часть на этот шаг
//   {a:rice}      → только мера: «1 стакан»
//   {n:rice.ins}  → название в падеже: «рисом»
//   {x:extra}     → текстовый параметр шага
import { measure, measureText, nameOf, shownCups, gCup, gramsLabel } from './measures.js';

// Подсказка о мерах: показывается у списка ингредиентов и в «Что значит?»
export const MEASURE_HINT = 'Стакан — 250 мл. Обычная кружка часто больше (300–350 мл). Нет мерного стакана (Messbecher, ~2 € в любом супермаркете) — один раз отмерь кружкой половину бутылки воды 0,5 л и запомни уровень (или отметь его маркером): это и есть «стакан». Литр — две бутылки 0,5 л. Ложки — без горки.';

export const PLACEHOLDER = /\{([qanNx]):([^}]*)\}/g;

// Ссылка «rice.gen*0.5» → { id, cas, frac }
export function parseRef(s) {
  const m = String(s).match(/^([$\w-]+)(?:\.(nom|gen|dat|acc|ins|prep))?(?:\*([\d.]+))?$/);
  return m ? { id: m[1], cas: m[2] || null, frac: m[3] ? +m[3] : 1 } : null;
}

export const slotId = (ing) => ing.id || ing.key;
export const slotOf = (r, id) => r.ingredients.find((i) => slotId(i) === id) || null;
const LIQUIDS = new Set(['water', 'milk', 'cream', 'kefir', 'oil', 'olive_oil', 'soy_sauce', 'vinegar', 'passata']);

// Пропорция жидкости для производного слота: { ratio, by: 'volume' | 'weight' }
export function derivedRatio(r, ing, kitchen) {
  const d = ing.derived;
  if (!d) return null;
  if (d.ratio > 0) return { ratio: d.ratio, by: d.by_unit || 'volume' };
  // по профилю: способ, которым готовится исходный слот в этом рецепте
  const from = slotOf(r, d.from);
  const prof = kitchen?.profiles?.[from?.key];
  const method = prof?.methods?.[d.method || r._methods?.[d.from]];
  const liq = method?.liquid;
  return liq ? { ratio: liq.ratio, by: liq.by || 'volume', max_g: liq.max_g } : null;
}

// Граммы слота при масштабе scale (производные — от показанной меры исходного: пропорция важнее граммов)
export function slotGrams(r, ing, scale, kitchen) {
  if (!ing.derived) return (ing.grams || 0) * scale;
  const from = slotOf(r, ing.derived.from);
  const dr = derivedRatio(r, ing, kitchen);
  if (!from || !dr) return (ing.grams || 0) * scale;
  const ms = kitchen?.measures || {};
  const fromGrams = (from.grams || 0) * scale;
  // вода для варки пасты: 1 л на 100 г, но не больше, чем помещается в обычную кастрюлю (max_g)
  if (dr.by === 'weight') return Math.min(fromGrams * dr.ratio, dr.max_g || Infinity);
  // мл на штуку (вода на пакетик чая): по показанному числу штук
  if (dr.by === 'ml_per_piece') {
    const mf = ms[from.key];
    const n = measure(mf, fromGrams, { as: from.as })?.n ?? (mf?.piece?.g ? fromGrams / mf.piece.g : 1);
    return n * dr.ratio * ((gCup(ms[ing.key] || {}) || 250) / 250);
  }
  const cups = shownCups(ms[from.key], fromGrams, { as: from.as }) ?? (ms[from.key] && gCup(ms[from.key]) ? fromGrams / gCup(ms[from.key]) : null);
  const g = gCup(ms[ing.key] || {}) || 250;
  return cups != null ? cups * dr.ratio * g : (ing.grams || 0) * scale;
}

// Бытовая мера ингредиента. → { text, measure (без граммов), grams, gramsText, err, unit }
export function slotMeasure(r, ing, scale, kitchen, { frac = 1, full = false, showGrams = false, packOf = null, cas = null } = {}) {
  if (ing.text && !(ing.grams > 0 && kitchen?.measures?.[ing.key] && ing.measure_too)) {
    return { text: ing.text, measure: ing.text, grams: (ing.grams || 0) * scale * frac, gramsText: '', err: 0, unit: 'text' };
  }
  const grams = slotGrams(r, ing, scale, kitchen) * frac;
  let m = kitchen?.measures?.[ing.key];
  // доля упаковки — той, что куплена на этой неделе, если вид меры — упаковка
  const bought = packOf?.(ing.key);
  if (m && bought > 0 && (ing.as || m.kind) === 'pack' && m.pack && !m.pack.label) m = { ...m, pack: { ...m.pack, g: Math.round(bought) } };
  const liquid = LIQUIDS.has(ing.key) || !!m?.liquid;
  const gramsText = grams > 0 ? gramsLabel(grams, m, liquid) : '';
  if (!m) {
    const t = ing.amount && Math.abs(scale * frac - 1) < 0.01 ? ing.amount : gramsText;
    return { text: t, measure: t, grams, gramsText, err: 0, unit: 'g', missing: true };
  }
  const opts = { as: ing.as, exact: !!ing.derived };
  const res = measure(m, grams, opts);
  const meas = measureText(m, grams, { ...opts, full, cas });
  const text = showGrams && gramsText ? (meas.endsWith(')') ? `${meas} — ${gramsText}` : `${meas} (${gramsText})`) : meas;
  return { text, measure: meas, grams, gramsText, err: res?.err ?? 0, unit: res?.unit, n: res?.n };
}

// Название слота в падеже: из measures.json (бытовое), иначе из карточки
export function slotName(ing, cas, kitchen) {
  const m = kitchen?.measures?.[ing.key];
  return nameOf(m, cas || 'nom', (ing.name_ru || ing.key).toLowerCase());
}

// Подстановки в тексте. ctx: { self, liquid, with, scale, kitchen, showGrams, packOf }
export function renderText(r, text, ctx = {}) {
  const { scale = 1, kitchen, showGrams = false, packOf } = ctx;
  const refs = [];
  // «$fat» → слот из with; там можно передать и часть: { "fat": "oil*0.5" }
  let extra = 1;
  const resolve = (id) => {
    extra = 1;
    if (id === 'self') return ctx.self;
    if (id === 'liquid') return ctx.liquid;
    if (id.startsWith('$')) {
      const v = String(ctx.with?.[id.slice(1)] ?? '');
      const [sid, f] = v.split('*');
      if (f) extra = +f || 1;
      return sid;
    }
    return id;
  };
  let out = String(text || '').replace(PLACEHOLDER, (all, kind, body) => {
    if (kind === 'x') {
      const v = ctx.with?.[body];
      return v ? renderText(r, v, { ...ctx, cap: false }).text : '';
    }
    const ref = parseRef(body);
    const id = ref && resolve(ref.id);
    const ing = id && slotOf(r, id);
    if (!ing) return all;
    refs.push({ id, frac: ref.frac * extra, kind });
    if (kind === 'n' || kind === 'N') {
      const n = slotName(ing, ref.cas, kitchen);
      return kind === 'N' ? n[0].toUpperCase() + n.slice(1) : n;
    }
    const mm = slotMeasure(r, ing, scale, kitchen, { frac: ref.frac * extra, full: kind === 'q', showGrams, packOf, cas: ref.cas });
    if (kind === 'q' && ing.text) return `${slotName(ing, 'acc', kitchen)} ${ing.text}`;
    return mm.text;
  });
  out = out.replace(/\s+,/g, ',').replace(/[ \t]{2,}/g, ' ').replace(/\s+\./g, '.');
  if (ctx.cap !== false) out = out.trim();
  if (out && ctx.cap !== false) out = out[0].toUpperCase() + out.slice(1);
  return { text: out, refs };
}

// Какие слоты упоминаются в шаблоне (без подстановки)
export function refsOf(text) {
  const out = [];
  String(text || '').replace(PLACEHOLDER, (_, kind, body) => {
    if (kind !== 'x') { const ref = parseRef(body); if (ref) out.push({ id: ref.id, frac: ref.frac, kind, cas: ref.cas }); }
    return '';
  });
  return out;
}

// Мера ингредиента для списка: главное — бытовая мера, граммы — по переключателю
export function ingredientMeasure(r, ing, scale, kitchen, opts = {}) {
  return slotMeasure(r, ing, scale, kitchen, opts);
}

// Текст шага при масштабе: шаблон хранится в step.tpl (или в text у шагов без подстановок)
export function stepText(r, step, scale, kitchen, opts = {}) {
  return renderText(r, step.tpl ?? step.text, { ...step.ctx, scale, kitchen, ...opts }).text;
}

// Ингредиенты шага: слоты из подстановок, с количеством (часть или всё)
export function stepSlots(r, step) {
  const seen = new Map();
  const param = (x) => String(step.ctx?.with?.[x.id.slice(1)] ?? '').split('*');
  for (const ref of refsOf(step.tpl ?? step.text).map((x) => (x.id.startsWith('$') ? { ...x, id: param(x)[0], frac: x.frac * (+param(x)[1] || 1) } : { ...x, id: x.id === 'self' ? step.ctx?.self : x.id === 'liquid' ? step.ctx?.liquid : x.id }))) {
    if (!ref.id) continue;
    const cur = seen.get(ref.id);
    if (!cur || (ref.kind !== 'n' && cur.kind === 'n')) seen.set(ref.id, ref);
  }
  return [...seen.values()].map((x) => ({ ing: slotOf(r, x.id), frac: x.frac, cas: x.cas, quantified: x.kind === 'q' || x.kind === 'a' })).filter((x) => x.ing);
}
