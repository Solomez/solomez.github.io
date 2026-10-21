// Рецепт как шаблон: количества и названия в шагах подставляются из данных ингредиентов,
// поэтому «половина стакана риса» в списке не может стать «100 г риса» в шаге (data/kitchen/SCHEMA.md).
//
//   {q:rice}      → «1 стакан риса», «2 зубчика чеснока», «половину пачки фарша (пачка 500 г)»
//   {q:oil*0.5}   → половина количества слота — часть на этот шаг
//   {a:rice}      → только мера: «1 стакан»
//   {q:oil.ins}   → мера в падеже: «1 столовой ложкой масла». Без падежа — винительный («влей половину стакана»),
//                   а в скобках и после двоеточия — именительный («посоли (половина чайной ложки)»)
//   {n:rice.ins}  → название в падеже: «рисом»
//   {x:extra}     → текстовый параметр шага
import { measure, measureText, nameOf, shownCups, gCup, gramsLabel } from './measures.js';
import { NOUNS, CASES } from './qty.js';

// Подсказка о мерах: показывается у списка ингредиентов и в «Что значит?»
export const MEASURE_HINT = 'Стакан — 250 мл. Обычная кружка часто больше (300–350 мл). Нет мерного стакана (Messbecher, ~2 € в любом супермаркете) — один раз отмерь кружкой половину бутылки воды 0,5 л и запомни уровень (или отметь его маркером): это и есть «стакан». Нет и бутылки — стакан это 16 столовых ложек, половина — 8, треть — 5–6, четверть — 4. Крупу и воду для неё мерь одной и той же кружкой — важна пропорция, а не точный объём. Литр — две бутылки 0,5 л. Ложки — без горки: столовая — обычная суповая, чайная — маленькая, в 3 раза меньше.';

// {g:self>450:текст} — текст, только если слота в шаге больше N граммов (S21: «жарь в два захода» — когда не помещается)
export const PLACEHOLDER = /\{([qanNxg]):([^}]*)\}/g;

// Падеж меры без явного падежа: в скобках и сразу после двоеточия — именительный, иначе — винительный (дополнение глагола)
export function defaultCase(str, at) {
  const before = String(str).slice(0, at);
  const open = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
  return open > 0 || /:\s*$/.test(before) ? 'nom' : 'acc';
}

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
  // соль в воду для варки (S02, S03): граммы на кг жидкости способа или самого продукта
  if (d.by === 'salt') return method?.salt ? { ratio: method.salt.g_per_kg, by: 'salt', per: method.salt.per || 'self' } : null;
  const liq = method?.liquid;
  // scale — часть жидкости даёт само блюдо (томаты из банки): воды меньше пропорции способа во столько раз
  return liq ? { ratio: liq.ratio * (d.scale > 0 ? d.scale : 1), by: liq.by || 'volume', max_g: liq.max_g } : null;
}

// Граммы слота при масштабе scale (производные — от показанной меры исходного: пропорция важнее граммов)
// Вода для варки продукта (картофель, цветная капуста — её сливают): растёт с порциями, но не больше, чем
// помещается в кастрюлю 3 л — две трети (S51); больше продукта — шаг говорит «вари в два захода»
export const BOIL_WATER_MAX = 2000;
export function slotGrams(r, ing, scale, kitchen) {
  if (!ing.derived) return ing.key === 'water' && ing.for ? Math.min((ing.grams || 0) * scale, Math.max(BOIL_WATER_MAX, ing.grams || 0)) : (ing.grams || 0) * scale;
  const from = slotOf(r, ing.derived.from);
  const dr = derivedRatio(r, ing, kitchen);
  if (!from || !dr) return (ing.grams || 0) * scale;
  const ms = kitchen?.measures || {};
  const fromGrams = (from.grams || 0) * scale;
  if (dr.by === 'salt') {
    // соль на воду (паста: 7 г на литр) или на сам продукт (рис, картофель)
    const liq = dr.per === 'liquid' ? r.ingredients.find((x) => x.derived?.from === ing.derived.from && x.derived.by !== 'salt') : null;
    const base = liq ? slotGrams(r, liq, scale, kitchen) : fromGrams;
    return Math.round(base * dr.ratio) / 1000;
  }
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
  // точная мера — только для пропорции по объёму (крупа : жидкость); воду для варки макарон (по весу) — литрами
  const opts = { as: ing.as, exact: !!ing.derived && derivedRatio(r, ing, kitchen)?.by !== 'weight' };
  const res = measure(m, grams, opts);
  const meas = measureText(m, grams, { ...opts, full, cas });
  // у жидкости миллилитры уже в мере — граммы второй раз не нужны
  // граммы уже сказаны в мере («около 170 г из пачки 500 г», S42) — второй раз не нужны
  const text = showGrams && gramsText && !/ мл\)$/.test(meas) && !/около \d/.test(meas) ? (meas.endsWith(')') ? `${meas} — ${gramsText}` : `${meas} (${gramsText})`) : meas;
  return { text, measure: meas, grams, gramsText, err: res?.err ?? 0, unit: res?.unit, n: res?.n };
}

// Название слота в падеже: из measures.json (бытовое), иначе из карточки. count ≥ 2 у штучного продукта, чьё
// название — сама штука («помидор»), — во множественном числе (S51: «вымой помидоры» на 4 порции)
const NO_PLURAL = new Set(['куриное филе', 'печенье']);
export function slotName(ing, cas, kitchen, count = 1) {
  const m = kitchen?.measures?.[ing.key];
  const nom = m?.ru?.nom;
  const N = count >= 2 && m?.piece?.forms?.[0] === nom && !NO_PLURAL.has(nom) ? NOUNS[nom] : null;
  if (N) return N.pl[CASES.indexOf(cas || 'nom')] || N.pl[0];
  return nameOf(m, cas || 'nom', (ing.name_ru || ing.key).toLowerCase());
}
// Сколько штук продукта при этом масштабе (для числа в названии)
function pieces(r, ing, scale, kitchen) {
  const m = kitchen?.measures?.[ing.key];
  if (!m?.piece?.g || ing.text) return 1;
  const g = slotGrams(r, ing, scale, kitchen);
  return measure(m, g)?.unit === 'piece' ? measure(m, g).n : g / m.piece.g;
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
  let out = String(text || '').replace(PLACEHOLDER, (all, kind, body, at, str) => {
    if (kind === 'x') {
      const v = ctx.with?.[body];
      if (!v) return '';
      // продукты из параметра («посоли кипящую воду ({q:salt_pasta})») — тоже продукты шага (S57)
      const sub = renderText(r, v, { ...ctx, cap: false });
      refs.push(...sub.refs.map((x) => ({ ...x, viaParam: true })));
      return sub.text;
    }
    if (kind === 'g') {
      // {g:self>450:…} — больше N граммов; {g:self<pack:…} — меньше целой упаковки (банки): нужна не вся
      const m = String(body).match(/^([$\w-]+)([<>])(\d+|pack):(.*)$/s);
      const gi = m && slotOf(r, resolve(m[1]));
      if (!gi) return '';
      const g = slotGrams(r, gi, scale, kitchen);
      const pack = kitchen?.measures?.[gi.key]?.pack?.g;
      if (m[3] === 'pack') {
        if (!pack) return '';
        const rest = g % pack;
        return m[2] === '<' && rest > pack * 0.1 && rest < pack * 0.9 ? m[4] : '';
      }
      return (m[2] === '>' ? g > +m[3] : g < +m[3]) ? m[4] : '';
    }
    const ref = parseRef(body);
    const id = ref && resolve(ref.id);
    const ing = id && slotOf(r, id);
    if (!ing) return all;
    refs.push({ id, frac: ref.frac * extra, kind, cas: ref.cas || (kind === 'q' || kind === 'a' ? defaultCase(str, at) : null) });
    if (kind === 'n' || kind === 'N') {
      const n = slotName(ing, ref.cas, kitchen, pieces(r, ing, scale, kitchen));
      return kind === 'N' ? n[0].toUpperCase() + n.slice(1) : n;
    }
    const mm = slotMeasure(r, ing, scale, kitchen, { frac: ref.frac * extra, full: kind === 'q', showGrams, packOf, cas: ref.cas || defaultCase(str, at) });
    if (kind === 'q' && ing.text) return `${slotName(ing, 'acc', kitchen)} ${ing.text}`;
    return mm.text;
  });
  // мера в скобках со своими скобками: «(треть стакана (80 мл))» → «(треть стакана, 80 мл)»
  out = out.replace(/\(([^()]*?)\s\(([^()]*)\)\)/g, '($1, $2)');
  out = out.replace(/\s+,/g, ',').replace(/[ \t]{2,}/g, ' ').replace(/\s+\./g, '.');
  // «затем {x:reserve}Слей…» с пустым параметром — «затем слей»
  out = out.replace(/(затем) ([А-ЯЁ])(?=[а-яё])/g, (m, a, c) => `${a} ${c.toLowerCase()}`);
  if (ctx.cap !== false) out = out.trim();
  if (out && ctx.cap !== false) out = out[0].toUpperCase() + out.slice(1);
  return { text: out, refs };
}

// Продукты шага, как их видит человек (S57): все подстановки текста, включая параметры общих действий
// ({x:salt} → «посоли воду ({q:salt_pasta})»). → [{ ing, frac, kind, cas, quantified }] по одному на продукт;
// у продукта с количеством в шаге — ссылка с количеством (сумма долей, если продукт назван дважды)
export function stepUses(r, step, kitchen) {
  const { refs } = renderText(r, step.tpl ?? step.text, { ...step.ctx, kitchen });
  const by = new Map();
  for (const x of refs) {
    const ing = slotOf(r, x.id);
    if (!ing) continue;
    const q = x.kind === 'q' || x.kind === 'a';
    const cur = by.get(ing);
    if (!cur) by.set(ing, { ing, frac: q ? x.frac : 1, kind: x.kind, cas: x.cas, quantified: q });
    else if (q && cur.quantified) cur.frac += x.frac;
    else if (q) Object.assign(cur, { frac: x.frac, kind: x.kind, cas: x.cas, quantified: true });
    else if (!cur.quantified && x.cas === 'acc') cur.cas = 'acc';
  }
  return [...by.values()];
}

// Какие слоты упоминаются в шаблоне (без подстановки)
export function refsOf(text) {
  const out = [];
  String(text || '').replace(PLACEHOLDER, (_, kind, body, at, str) => {
    if (kind !== 'x' && kind !== 'g') { const ref = parseRef(body); if (ref) out.push({ id: ref.id, frac: ref.frac, kind, cas: ref.cas || (kind === 'q' || kind === 'a' ? defaultCase(str, at) : null) }); }
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
