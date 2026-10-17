// Сборка рецепта из шаблона (data/kitchen/SCHEMA.md): замены → слоты, шаги из профилей ингредиентов и общих
// действий, проверки безопасности, таймлайн (что ставить раньше), время, таймеры, КБЖУ и цена.
// Один и тот же код — для карточки, режима готовки, плана, покупок и тестов.
import { renderText, refsOf, slotId, slotOf, slotGrams } from './cookbook.js';
import { schedule, timesOf, runningDuring } from './timeline.js';
import { allowedProduct } from './rules.js';
import { round2 } from './shopping.js';

const HARD = new Set(['oven', 'pan', 'pot', 'baking_dish', 'tray', 'blender', 'microwave']);
// чем можно обойтись: жарить на плите можно и в кастрюле, форма и противень взаимозаменяемы
const ALT = { pan: ['pan', 'pot'], tray: ['baking_dish', 'tray'], baking_dish: ['baking_dish', 'tray'] };
const toolOk = (t, hasTool) => (ALT[t] || [t]).some(hasTool);
const STARCH = new Set(['grain', 'pasta', 'potato']);
export const ACTIVE_LIMIT = 30;
// мясо не успевает дойти в блюде — готовить его до готовности сразу
const FALLBACK = { pan_brown: 'pan_pieces', sauce: 'pan_crumble' };

const isHeat = (s) => !!(s.heat || s.oven);
const span = (r) => (Array.isArray(r) ? r : r == null ? null : [r, r]);
const normTime = (t) => ({ active: span(t?.active) || [0, 0], passive: span(t?.passive) || [0, 0] });
// Обжарка на плите «помешивая раз в 1–2 минуты»: руки заняты не всё время. Если у шага с огнём на плите
// только активное время от 4 минут, считаем занятыми руками 40 % (помешать, перевернуть), остальное — ожидание
// у плиты, когда можно нарезать следующий продукт. Общее время шага не меняется (модель, а не данные).
export const ATTENDED_SHARE = 0.4;
export function attendedTime(s) {
  const t = normTime(s.time);
  if (!s.heat || s.oven || t.passive[1] > 0 || t.active[0] < 4 || s.continuous) return t;
  const a = t.active.map((x) => Math.round(x * ATTENDED_SHARE * 2) / 2);
  return { active: a, passive: [t.active[0] - a[0], t.active[1] - a[1]], attended: true };
}

// Подходящий способ профиля для контекста слота (и утвари, что есть дома)
export function pickMethod(prof, context, prefer, hasTool = () => true) {
  if (!prof?.methods) return null;
  const ok = (name) => {
    const m = prof.methods[name];
    return m && (!context || (m.contexts || []).includes(context)) && (m.equipment || []).filter((t) => HARD.has(t)).every((t) => toolOk(t, hasTool));
  };
  if (prefer && ok(prefer)) return prefer;
  return Object.keys(prof.methods).find(ok) || null;
}

const factorOf = (prof) => (prof?.yield?.factor || 1) * (prof?.edible || 1);

// Мягкая утварь в тексте шага — для подсказок «нет сита — …» (как в scripts/build_data.py)
export function softTools(text) {
  const t = String(text || '').toLowerCase();
  const uses = [];
  if (/тёрк|терк/.test(t) && !/не на тёрк/.test(t)) uses.push({ tool: 'grater', kind: /цедр/.test(t) ? 'zest' : 'grate' });
  if (/\bсит[оеау]\b|\bситом|дуршлаг/.test(t)) uses.push({ tool: 'sieve', kind: /просей/.test(t) ? 'sift' : /промой/.test(t) ? 'rinse' : 'drain' });
  if (/(накрой|под) крышк|крышкой/.test(t)) uses.push({ tool: 'lid', kind: 'cover' });
  return uses;
}

// Слоты рецепта после замен: subs = { слот: новый ключ }
function substituteSlots(card, subs, env) {
  const { products = {}, kitchen } = env;
  const swapped = [];
  const ingredients = card.ingredients.map((ing) => {
    const id = slotId(ing);
    const to = subs?.[id];
    if (!to || to === ing.key) return { ...ing, id };
    const p = products[to];
    // количество: коэффициент из data/substitutes.json (специи: чили острее паприки), иначе — по выходу продукта
    const row = (env.substitutes?.[ing.key] || []).find(([k]) => k === to);
    const ratio = +row?.[2] > 0 ? +row[2] : factorOf(kitchen?.profiles?.[ing.key]) / factorOf(kitchen?.profiles?.[to]);
    const grams = Math.round((ing.grams || 0) * ratio * 10) / 10;
    swapped.push({ slot: id, from: ing.key, from_ru: ing.name_ru, to, to_ru: p?.name_ru || to, note: kitchen?.profiles?.[to]?.note_as_sub || null });
    return {
      ...ing, id, key: to, grams, name_ru: p?.name_ru || to, name_de: p?.name_de_generic || p?.name_de || to,
      note: kitchen?.profiles?.[to]?.note_as_sub || null, replaced: { key: ing.key, name_ru: ing.name_ru, grams: ing.grams },
    };
  });
  return { ingredients, swapped };
}

// Развернуть шаги шаблона: общие, действия (actions.json), из профилей ингредиентов
function expandSteps(r, card, env) {
  const { kitchen, hasTool = () => true } = env;
  const out = [];
  const methods = {};
  const errors = [];
  // способы слотов заранее: разогрев духовки берёт температуру из способа продукта («@chicken_legs»)
  const chosen = {};
  for (const st of card.steps.filter((x) => x.use)) {
    const ing = slotOf(r, st.use);
    const prof = kitchen?.profiles?.[ing?.key];
    const name = pickMethod(prof, env.ctxOverride?.[st.use] || st.context, env.ctxOverride?.[st.use] ? null : st.method, hasTool);
    if (name && !chosen[st.use]) chosen[st.use] = prof.methods[name];
  }
  const ovenOf = (slot) => (chosen[slot]?.steps || []).find((x) => x.oven)?.oven || null;
  const push = (s, base) => out.push({
    ...s, track: base.track || 'main', time: attendedTime(s), tpl: s.text, origin: base.origin,
    ctx: base.ctx || {}, src: base.src || null, use: base.use || null, kind: base.kind || 'step',
  });
  card.steps.forEach((st, i) => {
    const track = st.track || 'main';
    if (st.use) {
      const ing = slotOf(r, st.use);
      const prof = kitchen?.profiles?.[ing?.key];
      const name = pickMethod(prof, env.ctxOverride?.[st.use] || st.context, env.ctxOverride?.[st.use] ? null : st.method, hasTool);
      if (!ing || !name) {
        errors.push(`шаг ${i + 1}: нет способа «${st.context}» для ${ing?.key || st.use}`);
        return;
      }
      methods[st.use] = name;
      const m = prof.methods[name];
      const liquid = r.ingredients.find((x) => x.derived?.from === st.use);
      const ctx = { self: st.use, liquid: liquid ? slotId(liquid) : null, with: st.with || {} };
      const prep = m.prep !== undefined ? m.prep : prof.prep;
      // part: "prep" — только подготовка (профиль + шаги способа до первого огня), "cook" — остальное;
      // так подготовку можно поставить раньше в дорожке, не перечисляя id шагов профиля
      const firstHeat = (m.steps || []).findIndex((x) => isHeat(x));
      const cut = firstHeat < 0 ? (m.steps || []).length : firstHeat;
      if (prep?.text && st.prep !== false && st.part !== 'cook') push({ ...prep }, { track, origin: `${ing.key}:prep`, ctx, use: st.use, kind: 'prep', src: ing.key });
      // skip — шаги способа, которые в этом рецепте не нужны (курица уже нарезана для маринада)
      const msteps = (m.steps || []).filter((x, j) => !(st.skip || []).includes(x.id) && (st.part === 'prep' ? j < cut : st.part === 'cook' ? j >= cut : true)).map((x) => ({ ...x }));
      // «late»: добавить что-то за N минут до конца основного этапа — этап делится на два шага
      if (st.late) {
        const k = Math.max(0, msteps.findIndex((x) => x.main));
        const main = msteps[k];
        const L = st.late.min || 0;
        const t = normTime(main.time);
        const first = { ...main, time: { active: t.active, passive: [Math.max(1, t.passive[0] - L), Math.max(1, t.passive[1] - L)] }, continues: true };
        delete first.cues; delete first.check; delete first.not_ready; delete first.overdone;
        const late = { ...main, id: (main.id || 'main') + '-late', text: st.late.text, time: { active: [0, 1], passive: [L, L] }, late: true };
        // основной этап без огня (кускус запаривают): добавку кладут в кипящую жидкость перед ним
        if (!isHeat(main)) msteps.splice(k, 0, { id: 'late', text: st.late.text, time: { active: [0, 1] } });
        else msteps.splice(k, 1, first, late);
      }
      msteps.forEach((x) => push(x, { track, origin: `${ing.key}:${name}:${x.id || ''}`, ctx, use: st.use, src: ing.key }));
      if (m.finishes_later) methods[`${st.use}#later`] = true;
    } else if (st.act) {
      const a = kitchen?.actions?.[st.act];
      if (!a) { errors.push(`шаг ${i + 1}: нет действия ${st.act}`); return; }
      // параметры действия: переданные в with или значения по умолчанию; "$имя" в огне и духовке — из параметров
      const w = { ...Object.fromEntries(Object.entries(a.params || {}).filter(([, v]) => v.default != null).map(([k, v]) => [k, String(v.default)])), ...(st.with || {}) };
      for (const [k, v] of Object.entries(w)) {
        const o = typeof v === 'string' && v.startsWith('@') ? ovenOf(v.slice(1)) : null;
        if (o) w[k] = String(k === 'mode' ? o.mode : o.c);
        else if (typeof v === 'string' && v.startsWith('@')) w[k] = String(a.params?.[k]?.default ?? '');
      }
      if (typeof (st.with || {}).temp === 'string' && st.with.temp.startsWith('@') && !(st.with || {}).mode) { const o = ovenOf(st.with.temp.slice(1)); if (o?.mode) w.mode = o.mode; }
      const val = (v) => (typeof v === 'string' && v.startsWith('$') ? w[v.slice(1)] : v);
      const merged = { ...a, ...Object.fromEntries(Object.entries(st).filter(([k]) => !['act', 'with', 'track'].includes(k))) };
      delete merged.params;
      if (merged.heat) merged.heat = val(merged.heat);
      if (merged.oven) merged.oven = { c: +val(merged.oven.c), mode: val(merged.oven.mode) };
      push(merged, { track, origin: `act:${st.act}`, ctx: { with: w }, src: 'act' });
    } else {
      push(st, { track, origin: `card:${i}`, ctx: { with: st.with || {} }, src: 'card' });
    }
  });
  // разогрев духовки — на температуру первого шага с духовкой после него (при замене бедро 220 °C → грудка 200 °C)
  out.forEach((s, i) => {
    if (s.origin !== 'act:preheat_oven') return;
    const next = out.slice(i + 1).find((x) => x.oven && !x.background);
    if (next?.oven?.c) {
      s.oven = { ...next.oven };
      s.ctx = { ...s.ctx, with: { ...s.ctx.with, temp: String(next.oven.c), mode: next.oven.mode || s.ctx.with?.mode } };
    }
  });
  return { steps: out, methods, errors };
}

// Все слоты, на которые ссылается шаг: текст, параметры with (и подстановки внутри них)
function allRefs(s) {
  const ids = new Set(stepRefs(s));
  // только те параметры with, что реально подставляются в текст шага ({x:имя})
  const used = new Set([...String(s.tpl || '').matchAll(/\{x:([^}]+)\}/g)].map((m) => m[1]));
  for (const [k, v] of Object.entries(s.ctx?.with || {})) {
    if (!used.has(k)) continue;
    for (const x of refsOf(String(v))) ids.add(x.id);
  }
  return [...ids];
}

// Слоты, которых касается шаг (подстановки + свой слот)
function stepRefs(s) {
  const ids = new Set();
  for (const ref of refsOf(s.tpl)) {
    const id = ref.id === 'self' ? s.ctx.self : ref.id === 'liquid' ? s.ctx.liquid : ref.id.startsWith('$') ? String(s.ctx.with?.[ref.id.slice(1)] ?? '').split('*')[0] : ref.id;
    if (id) ids.add(id);
  }
  if (s.ctx.self) ids.add(s.ctx.self);
  return [...ids];
}

// Птица, свинина, фарш: проверка безопасности на шаге, где мясо доходит; на шагах до него — «ещё сырое внутри»
function attachSafety(r, steps, kitchen, methods) {
  for (const ing of r.ingredients) {
    const prof0 = kitchen?.profiles?.[ing.key];
    if (!prof0?.safety || !prof0.safety_check) continue;
    const id = slotId(ing);
    // у способа может быть своя проверка (фарш крошкой — не «разрежь котлету»)
    const prof = { ...prof0, safety_check: prof0.methods?.[methods[id]]?.safety_check || prof0.safety_check };
    const touched = steps.map((s, i) => (isHeat(s) && s.slots.includes(id) ? i : -1)).filter((i) => i >= 0);
    if (!touched.length) continue;
    const track = steps[touched[0]].track;
    let fin = touched[touched.length - 1];
    // обжарили и доготавливают в блюде — проверка на последнем шаге с огнём этой дорожки
    if (methods[`${id}#later`]) {
      const lastHeat = steps.map((s, i) => (isHeat(s) && s.track === track && i >= fin ? i : -1)).filter((i) => i >= 0).pop();
      if (lastHeat != null) fin = lastHeat;
    }
    for (let i = touched[0]; i <= fin; i++) {
      const s = steps[i];
      if (!isHeat(s) || (s.track !== track && !s.slots.includes(id))) continue;
      const entry = i === fin
        ? { slot: id, stage: 'final', check: prof.safety_check.check, temp_c: prof.safety_check.temp_c, kind: prof.safety, src: prof.safety_check.src }
        : { slot: id, stage: 'partial', kind: prof.safety };
      s.safety = [...(s.safety || []).filter((x) => x.slot !== id), entry];
      if (!s.slots.includes(id)) s.slots.push(id);
    }
  }
}

// КБЖУ и цена: поправка базовых значений карточки на изменившиеся слоты (как считает scripts/build_data.py)
function eurPerKg(p) {
  const packs = p?.packs || [];
  return packs[0]?.eur_per_kg || 0;
}
function recount(card, r, products) {
  const n = card.servings || 1;
  const ps = { ...card.per_serving };
  let breakdown = [...(card.cost_breakdown || [])];
  const changed = r.ingredients.filter((ing) => ing.replaced);
  if (!changed.length) return { per_serving: ps, cost_breakdown: breakdown };
  for (const ing of changed) {
    const a = products[ing.replaced.key]?.nutrition_per_100g;
    const b = products[ing.key]?.nutrition_per_100g;
    if (Array.isArray(a) && Array.isArray(b)) {
      ['kcal', 'protein', 'fat', 'carbs'].forEach((f, j) => { ps[f] = (ps[f] || 0) + (ing.grams * (+b[j] || 0) - ing.replaced.grams * (+a[j] || 0)) / 100 / n; });
    }
    const old = breakdown.find((c) => c.key === ing.replaced.key);
    const perKg = eurPerKg(products[ing.key]);
    const cost = round2(((ing.grams / n) * perKg) / 1000);
    ps.cost = (ps.cost || 0) - (old?.cost_per_serving || 0) + cost;
    const best = products[ing.key]?.packs?.[0];
    const row = { key: ing.key, name_ru: products[ing.key]?.name_ru || ing.name_ru, grams_per_serving: Math.round((ing.grams / n) * 10) / 10, cost_per_serving: cost, store: best?.store || null, is_estimate: !!(best?.is_estimate || best?.stale) };
    breakdown = old ? breakdown.map((c) => (c === old ? row : c)) : [...breakdown, row];
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    per_serving: { ...ps, cost: round2(Math.max(0, ps.cost)), kcal: Math.round(Math.max(0, ps.kcal)), protein: r1(Math.max(0, ps.protein)), fat: r1(Math.max(0, ps.fat)), carbs: r1(Math.max(0, ps.carbs)) },
    cost_breakdown: breakdown,
  };
}

// Подпись шага для сравнения «до и после замены»
const sig = (s) => `${s.track}|${s.text}|${s.heat || ''}|${s.oven ? s.oven.c : ''}|${(s.time.active || []).join('-')}|${(s.time.passive || []).join('-')}|${(s.cues || []).map((c) => c.text).join('/')}`;

// card — карточка v2 из recipes.json; env: { kitchen, products, subs, equipment: hasTool(id) }
export function compile(card, env = {}) {
  if (card.format !== 2) return card;
  const { kitchen, products = {} } = env;
  const { ingredients, swapped } = substituteSlots(card, env.subs, env);
  const r = { ...card, ingredients, swapped };
  // у нового способа есть жидкость, а связанной воды в рецепте нет (картофель → рис) — добавляем слот воды;
  // связанная вода, которая новому способу не нужна (рис → картофель), уходит из рецепта
  for (const st of card.steps.filter((x) => x.use)) {
    const ing = slotOf(r, st.use);
    const prof = kitchen?.profiles?.[ing?.key];
    const m = prof?.methods?.[pickMethod(prof, env.ctxOverride?.[st.use] || st.context, st.method, env.hasTool || (() => true))];
    const has = r.ingredients.some((x) => x.derived?.from === st.use);
    if (m?.liquid && !has) {
      r.ingredients = [...r.ingredients, { id: `${st.use}_water`, key: 'water', name_ru: 'Вода', name_de: 'Wasser', grams: 0, basic: true, optional: false, note: null, derived: { from: st.use, by: 'liquid' }, added: true }];
    }
    if (!m?.liquid && has && ing.replaced) r.ingredients = r.ingredients.filter((x) => x.derived?.from !== st.use);
  }
  const { steps: raw, methods, errors } = expandSteps(r, card, env);
  r._methods = Object.fromEntries(Object.entries(methods).filter(([k]) => !k.includes('#')));
  // производные количества (жидкость к крупе) — по пропорции нового способа
  r.ingredients = r.ingredients.map((ing) => (ing.derived ? { ...ing, grams: Math.round(slotGrams(r, ing, 1, kitchen)) } : ing));
  // вода, на которую после замены не ссылается ни один шаг (вода для картофеля, а теперь рис), — из списка
  if (swapped.length) {
    // вода и соль «для картофеля» (ингредиент с for) — уходят, если картофель заменён продуктом другой роли
    // (рис, паста) и шаги на них больше не ссылаются
    const used0 = new Set(raw.flatMap(allRefs));
    const cross = new Set(swapped.filter((x) => kitchen?.profiles?.[x.from]?.role !== kitchen?.profiles?.[x.to]?.role).map((x) => x.slot));
    r.ingredients = r.ingredients.filter((i) => !(i.for && cross.has(i.for)) || used0.has(slotId(i)));
  }
  if (swapped.length && env.base) {
    const used = new Set(raw.flatMap(allRefs));
    const before = new Set(env.base.steps.flatMap(allRefs));
    // базовое (вода, соль), которое было нужно только замененному продукту (вода и соль для картофеля), — из списка
    r.ingredients = r.ingredients.filter((i) => !(i.basic || i.key === 'water') || used.has(slotId(i)) || !before.has(slotId(i)));
  }
  // в блюде несколько компонентов — шаг профиля без названия продукта («Сними с огня и оставь под крышкой»)
  // начинается с него: «Рис: сними с огня…»
  const multi = new Set(raw.filter((x) => x.track !== 'finish' && !x.background).map((x) => x.track)).size > 1;
  for (const s of raw) {
    if (multi && s.ctx.self && s.use && !/\{[qanN]:self/.test(s.tpl || '')) s.tpl = `{N:self}: ${s.tpl[0].toLowerCase()}${s.tpl.slice(1)}`;
  }
  for (const s of raw) {
    s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
    if (s.why) s.why = renderText(r, s.why, { ...s.ctx, kitchen, cap: false }).text;
    if (s.note) s.note = renderText(r, s.note, { ...s.ctx, kitchen }).text;
    s.slots = stepRefs(s);
    s.tools = softTools(s.text);
  }
  attachSafety(r, raw, kitchen, methods);
  // в посуде ещё сырое мясо — «попробуй» на этом шаге нельзя: признак-вкус убираем
  for (const s of raw) if ((s.safety || []).some((x) => x.stage === 'partial') && (s.cues || []).some((c) => c.type === 'taste')) s.cues = s.cues.filter((c) => c.type !== 'taste');
  // таймлайн: порядок шагов и что идёт параллельно
  const t = timesOf(raw);
  const plan = t.plan;
  const ordered = plan.order.map((i) => ({ ...raw[i], at: plan.at[i], parallel: runningDuring(plan, raw, i).map((j) => plan.order.indexOf(j)) }));
  ordered.forEach((s) => {
    const lo = s.time.active[0] + s.time.passive[0];
    s.timer_min = s.time.passive[1] > 0 || isHeat(s) ? (lo >= 1 ? lo : null) : null;
  });
  // шаг, который нельзя начинать, пока не закончился предыдущий шаг своей дорожки (таймер): «сначала дождись шага N»
  ordered.forEach((s, k) => {
    const prev = ordered.slice(0, k).filter((x) => x.track === s.track && !x.background).pop();
    if (prev && prev.time.passive[1] > 0 && s.track !== 'finish') s.wait_for = ordered.indexOf(prev);
    if (s.track === 'finish' && k > 0) {
      const last = ordered.slice(0, k).filter((x) => x.track !== 'finish' && !x.background && x.time.passive[1] > 0 && x.at.end > s.at.start - 0.5);
      if (last.length && !ordered.slice(0, k).some((x) => x.track === 'finish')) s.wait_for = ordered.indexOf(last[last.length - 1]);
    }
  });
  // ссылка «дойдёт на шаге N» для неготового мяса
  ordered.forEach((s) => (s.safety || []).forEach((x) => {
    if (x.stage === 'partial') x.final_step = ordered.findIndex((o) => (o.safety || []).some((y) => y.slot === x.slot && y.stage === 'final'));
  }));
  r.steps = ordered;
  r.time = { ...t, prep: t.active, cook: t.passive };
  delete r.time.plan;
  // посуда: способы ингредиентов добавляют обязательную утварь
  const tools = [...(card.tools || [])];
  for (const [slot, name] of Object.entries(r._methods)) {
    const m = kitchen?.profiles?.[slotOf(r, slot)?.key]?.methods?.[name];
    for (const tl of (m?.equipment || []).filter((x) => HARD.has(x))) if (!tools.some((g) => g.includes(tl))) tools.push(ALT[tl] || [tl]);
  }
  r.tools = tools;
  Object.assign(r, recount(card, r, products));
  r.warnings = [];
  if (r.time.active > ACTIVE_LIMIT) r.warnings.push(`активной готовки ≈ ${r.time.active} мин — больше ${ACTIVE_LIMIT}`);
  // мясо должно было дойти в блюде, а блюдо после замены готовится быстрее (кускус запаривают 5 минут) —
  // мясо дожаривается до готовности сразу: способ «обжарить» меняется на «жарить до готовности»
  if (!env.ctxOverride) {
    const over = {};
    for (const [slot, name] of Object.entries(r._methods)) {
      const ing = slotOf(r, slot);
      const meth = kitchen?.profiles?.[ing?.key]?.methods?.[name];
      if (!meth?.finishes_later || !meth.finish_min) continue;
      const own = r.steps.filter((x) => x.ctx?.self === slot && isHeat(x));
      const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === slot && y.stage === 'final'));
      const t = own.length && fin && fin !== own[own.length - 1] ? fin.at.end - own[own.length - 1].at.end : Infinity;
      const ctx = FALLBACK[card.steps.find((x) => x.use === slot)?.context];
      if (t < meth.finish_min[0] - 0.5 && ctx) over[slot] = ctx;
    }
    if (Object.keys(over).length) {
      const again = compile(card, { ...env, ctxOverride: over });
      again.adapted = Object.keys(over);
      return again;
    }
  }
  // мясо, которое доходит в блюде, а блюдо после замены готовится дольше: грудка станет суше — одна строка
  for (const [slot, name] of Object.entries(r._methods)) {
    const ing = slotOf(r, slot);
    const meth = kitchen?.profiles?.[ing?.key]?.methods?.[name];
    if (!meth?.finishes_later || !meth.finish_max) continue;
    const own = r.steps.filter((x) => x.ctx?.self === slot && isHeat(x));
    const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === slot && y.stage === 'final'));
    const t = own.length && fin ? Math.round(fin.at.end - own[own.length - 1].at.end) : 0;
    if (t > meth.finish_max[1]) r.warnings.push(`${ing.name_ru.toLowerCase()} пробудет в блюде ≈ ${t} мин — станет суше (ей хватает до ${meth.finish_max[1]} мин): для долгого блюда лучше филе бёдер`);
  }
  r.errors = errors;
  // какие шаги изменились после замен
  if (swapped.length && env.base) {
    const before = new Set(env.base.steps.map(sig));
    r.steps.forEach((s) => { s.changed = !before.has(sig(s)); });
  }
  r.compiled = true;
  return r;
}

// Варианты замены слота: из data/substitutes.json, только совместимые (роль, способ для контекста, утварь, исключения)
export function subOptions(card, id, env) {
  const { kitchen, products = {}, substitutes = {}, hasTool = () => true } = env;
  const ing = card.ingredients.find((i) => slotId(i) === id);
  if (!ing || ing.key === 'water') return [];
  const from = kitchen?.profiles?.[ing.key];
  const uses = card.steps.filter((s) => s.use === id);
  return (substitutes[ing.key] || []).map(([key, note]) => {
    const prof = kitchen?.profiles?.[key];
    const p = products[key];
    let reason = null;
    if (!p?.packs?.length) reason = 'нет в магазинах';
    else if (!allowedProduct(key, p)) reason = 'исключено';
    else if (!prof || !from) reason = 'нет профиля приготовления';
    else if (card.ingredients.some((x) => x.key === key)) reason = 'уже есть в блюде';
    else {
      const sameRole = prof.role === from.role;
      for (const s of uses) {
        const cross = STARCH.has(prof.role) && STARCH.has(from.role) && s.context === 'side';
        if (!sameRole && !cross) { reason = 'другая роль в блюде'; break; }
        if (!pickMethod(prof, s.context, null, () => true)) { reason = 'так не готовят'; break; }
        if (!pickMethod(prof, s.context, null, hasTool)) { reason = 'нужна посуда, которой нет'; break; }
      }
      if (!uses.length && !sameRole) reason = 'другая роль в блюде';
      // мясо, которое доходит в блюде: после обжарки должно быть не меньше finish_min минут на огне
      if (!reason && uses.length) {
        const r = compile(card, { ...env, subs: { [id]: key } });
        if (r.errors.length) reason = 'так не готовят';
        for (const s of uses) {
          const meth = prof.methods[r._methods[id]];
          if (reason || !meth?.finishes_later || !meth.finish_min) continue;
          const mine = r.steps.filter((x) => x.ctx?.self === id && (x.heat || x.oven));
          const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === id && y.stage === 'final'));
          const last = mine[mine.length - 1];
          if (last && fin && fin !== last && fin.at.end - last.at.end < meth.finish_min[0] - 0.5) reason = `не успеет дойти: в блюде ${Math.round(fin.at.end - last.at.end)} мин, нужно от ${meth.finish_min[0]}`;
        }
      }
    }
    return { key, name_ru: p?.name_ru || key, note: prof?.note_as_sub || note || null, allowed: !reason, reason };
  });
}

// Что изменится до подтверждения замены
export function previewSub(card, subs, id, key, env) {
  const base = compile(card, { ...env, subs });
  const next = compile(card, { ...env, subs: { ...subs, [id]: key }, base: compile(card, { ...env, subs: {} }) });
  const a = base.ingredients.find((i) => slotId(i) === id);
  const b = next.ingredients.find((i) => slotId(i) === id);
  const m0 = base._methods[id];
  const m1 = next._methods[id];
  return {
    base, recipe: next,
    time: next.time.total - base.time.total,
    active: next.time.active - base.time.active,
    kcal: next.per_serving.kcal - base.per_serving.kcal,
    protein: Math.round((next.per_serving.protein - base.per_serving.protein) * 10) / 10,
    cost: round2(next.per_serving.cost - base.per_serving.cost),
    from: a, to: b,
    method: m0 !== m1 ? { from: m0, to: m1 } : null,
    changedSteps: next.steps.filter((s) => s.changed).length,
    warnings: next.warnings.filter((w) => !base.warnings.includes(w)),
    note: env.kitchen?.profiles?.[key]?.note_as_sub || null,
  };
}
