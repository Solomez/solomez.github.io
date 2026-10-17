// Генератор рациона на неделю (обед + ужин) и замена блюд.
import { chooseOffer, proportionalCost, scaledIngredients, round2 } from './shopping.js';
import { canCook } from './equipment.js';

export const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const MEALS = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };

export const DEFAULT_PREFS = {
  maxRepeats: 2, // одно блюдо не чаще N приготовлений в неделю
  batchCooking: true, // ужин на 2 порции → обед следующего дня
  showBorderline: true, // показывать спорные блюда (шакшука, дал)
  excludedKeys: [], // продукты, которые не хочется видеть
  stores: [], // предпочитаемые магазины (пусто = все)
  hidden: [], // скрытые блюда
  favorites: [],
  planBreakfast: true, // подбирать завтрак и перекусы под остаток дневной нормы
  allowTwoStores: false, // устарело: заменено saveMode
  saveMode: 'money', // покупки: 'money' — дешевле (до двух магазинов в день), 'trips' — меньше походов (один магазин в день)
  equipment: {}, // кухонная утварь: id → есть ли (не указано — по умолчанию из equipment.js)
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// Группы приёмов пищи: каждая группа — одно приготовление
export function slotTemplate(batchCooking) {
  const groups = [];
  if (batchCooking) {
    groups.push([{ day: 0, meal: 'lunch' }]);
    for (let d = 0; d < 6; d++) groups.push([{ day: d, meal: 'dinner' }, { day: d + 1, meal: 'lunch' }]);
    groups.push([{ day: 6, meal: 'dinner' }]);
  } else {
    for (let d = 0; d < 7; d++) groups.push([{ day: d, meal: 'lunch' }], [{ day: d, meal: 'dinner' }]);
  }
  return groups;
}

export const mealType = (r) => r.meal_type || 'main';

export function eligibleRecipes(recipes, prefs = DEFAULT_PREFS, type = 'main') {
  const hidden = new Set(prefs.hidden || []);
  const excluded = new Set(prefs.excludedKeys || []);
  return recipes.filter((r) => {
    if (mealType(r) !== type) return false;
    if (hidden.has(r.id)) return false;
    if (!prefs.showBorderline && (r.tags || []).includes('спорное')) return false;
    if (!canCook(r, prefs.equipment)) return false; // нет нужной утвари
    return !r.ingredients.some((i) => !i.basic && !i.optional && excluded.has(i.key));
  });
}

export const canStore = (r) => (r.storage?.fridge_days ?? 0) >= 1;

// Размер порции: под калорийность приёма пищи, но не меньше ~90% цели по белку
export function portionFactor(recipe, targets) {
  const ps = recipe.per_serving;
  if (!targets || !ps?.kcal) return 1;
  let f = clamp(targets.perMeal.kcal / ps.kcal, 0.75, 1.6);
  const needP = targets.perMeal.protein * 0.9;
  if (ps.protein * f < needP) f = clamp(needP / ps.protein, f, 1.6);
  return Math.round(f * 10) / 10;
}

// Стоимость покупки key в количестве grams (упаковками; базовые — пропорционально)
function makeCoster(products, opts) {
  const memo = new Map();
  return (key, grams) => {
    if (grams <= 0) return 0;
    const p = products[key];
    if (!p) return 0;
    const g = Math.ceil(grams / 10) * 10;
    const mk = key + '|' + g;
    if (memo.has(mk)) return memo.get(mk);
    const v = p.basic ? proportionalCost(p, g, opts) : chooseOffer(p, g, opts)?.cost ?? 0;
    memo.set(mk, v);
    return v;
  };
}

function addNeeds(needs, recipe, factor, portions, sign = 1) {
  for (const i of scaledIngredients(recipe, factor, portions)) {
    if (i.key === 'water') continue;
    needs.set(i.key, (needs.get(i.key) || 0) + sign * i.grams);
  }
}

function marginalCost(needs, recipe, factor, portions, cost) {
  let d = 0;
  for (const i of scaledIngredients(recipe, factor, portions)) {
    if (i.key === 'water') continue;
    const cur = needs.get(i.key) || 0;
    d += cost(i.key, cur + i.grams) - cost(i.key, cur);
  }
  return d;
}

function totalCost(needs, cost) {
  let s = 0;
  for (const [k, g] of needs) s += cost(k, g);
  return s;
}

const COST_WEIGHT = 0.6;

const mainKeys = (r) => new Set(r.ingredients.filter((i) => !i.basic).map((i) => i.key));

// Неделя в бюджете (F02): раньше бюджет ограничивал только обеды и ужины, а завтраки и перекусы добавлялись после
// и в бюджет не входили. Теперь считается вся неделя; если вышло дороже — второй, более строгий проход.
// cheap — «Подобрать дешевле»: цена важнее разнообразия. Белок не снижается никогда (требование).
export function generatePlan(opts) {
  const { recipes, products, targets, prefs = DEFAULT_PREFS, budget = 70, reserve = 20, cheap = false } = opts;
  const withExtras = prefs.planBreakfast !== false && !!targets;
  const limit = withExtras ? budget : Math.max(10, budget - reserve);
  // «дешевле»: дешёвые блюда можно повторять трижды, «вкус недели» почти не мешает цене, завтраки и перекусы — дешевле
  const p2 = cheap ? { ...prefs, maxRepeats: Math.max(3, prefs.maxRepeats || 2) } : prefs;
  const run = (mealBudget, overPenalty, costWeight) => {
    const plan = buildPlan({ ...opts, prefs: p2, mealBudget, overPenalty, costWeight, tasteScale: cheap ? 0.25 : 1 });
    if (withExtras) plan.extras = planExtras({ plan, recipes, products, targets, prefs: p2, seed: opts.seed ?? 1, costWeight: cheap ? 3 : EXTRA_COST_WEIGHT });
    return { plan, cost: planCost(plan, recipes, products, prefs) };
  };
  let best = run(Math.max(10, budget - reserve), cheap ? 8 : 4, cheap ? 1.5 : COST_WEIGHT);
  if (best.cost > limit + 0.01) {
    const strict = run(Math.max(10, budget - reserve - (best.cost - limit)), 12, cheap ? 2 : 1.2);
    if (strict.cost < best.cost) best = strict;
  }
  best.plan.costEstimate = round2(best.cost);
  return best.plan;
}

// Стоимость покупок недели по самой выгодной цене (упаковками), включая завтраки и перекусы
export function planCost(plan, recipes, products, prefs = DEFAULT_PREFS) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const cost = makeCoster(products, { stores: prefs.stores });
  const needs = new Map();
  for (const b of plan.batches) if (byId.get(b.recipeId)) addNeeds(needs, byId.get(b.recipeId), b.factor, b.slots.length);
  for (const x of plan.extras || []) if (byId.get(x.recipeId)) addNeeds(needs, byId.get(x.recipeId), x.factor, 1);
  for (const [k] of needs) if (products[k]?.basic) needs.delete(k); // базовые (масло, специи) — отдельно, «купить один раз»
  return totalCost(needs, cost);
}

function buildPlan({ recipes, products, targets, prefs = DEFAULT_PREFS, seed = Date.now(), iterations = 120, locked = {}, mealBudget, overPenalty = 4, costWeight = COST_WEIGHT, tasteScale = 1 }) {
  const pool = eligibleRecipes(recipes, prefs);
  const template = slotTemplate(prefs.batchCooking !== false);
  const cost = makeCoster(products, { stores: prefs.stores });
  const maxRep = Math.max(1, prefs.maxRepeats || 2);
  const byId = new Map(recipes.map((r) => [r.id, r]));
  // «Вкус недели»: случайные предпочтения на всю генерацию, чтобы каждая новая неделя была другой,
  // а внутри генерации по-прежнему выбирался самый выгодный вариант
  const rng0 = mulberry32(seed >>> 0);
  // избранное — заметно чаще (звёздочка влияет на подбор), «спорное» — реже
  const fav = new Set(prefs.favorites || []);
  const taste = new Map(pool.map((r) => [r.id, (rng0() * 2.4 + ((r.tags || []).includes('спорное') ? 0.8 : 0)) * tasteScale - (fav.has(r.id) ? 1.6 : 0)]));
  let best = null;

  for (let it = 0; it < iterations; it++) {
    const rng = mulberry32((seed + it * 7919) >>> 0);
    const needs = new Map();
    const counts = {};
    const typeCounts = {};
    const batches = [];
    let penalty = 0;
    let prevType = null;
    for (let gi = 0; gi < template.length; gi++) {
      const slots = template[gi];
      const portions = slots.length;
      let pick = null;
      if (locked[gi] && byId.get(locked[gi])) {
        pick = byId.get(locked[gi]);
      } else {
        let bestScore = Infinity;
        for (const r of pool) {
          if (portions > 1 && !canStore(r)) continue;
          if ((counts[r.id] || 0) >= maxRep) continue;
          const f = portionFactor(r, targets);
          // цена важна, но внутри бюджета не перевешивает разнообразие (перерасход штрафуется ниже)
          let s = (costWeight * marginalCost(needs, r, f, portions, cost)) / portions;
          s += taste.get(r.id) || 0;
          s += (counts[r.id] || 0) * 2.5; // разнообразие
          if (r.protein_type === prevType) s += 1.2;
          s += Math.max(0, (typeCounts[r.protein_type] || 0) - 2) * 0.5;
          if (targets) s += Math.max(0, targets.perMeal.protein * 0.9 - r.per_serving.protein * f) * 0.04;
          s += rng() * 0.6; // небольшой шум между итерациями
          if (s < bestScore) {
            bestScore = s;
            pick = r;
          }
        }
      }
      if (!pick) continue;
      const f = portionFactor(pick, targets);
      addNeeds(needs, pick, f, portions);
      counts[pick.id] = (counts[pick.id] || 0) + 1;
      typeCounts[pick.protein_type] = (typeCounts[pick.protein_type] || 0) + 1;
      penalty += taste.get(pick.id) || 0;
      if (counts[pick.id] > 1) penalty += 2.5;
      if (pick.protein_type === prevType) penalty += 1.2;
      prevType = pick.protein_type;
      batches.push({ id: `b${gi}`, recipeId: pick.id, factor: f, slots: slots.map((s) => ({ ...s })) });
    }
    const total = totalCost(needs, cost);
    const objective = costWeight * total + penalty + Math.max(0, total - mealBudget) * overPenalty;
    if (!best || objective < best.objective) best = { objective, total, batches };
  }
  const plan = {
    id: 'plan-' + seed,
    createdAt: new Date().toISOString(),
    batchCooking: prefs.batchCooking !== false,
    batches: best ? best.batches : [],
    extras: [],
  };
  return plan;
}

// ---------- Завтраки и перекусы ----------
// Под остаток дневной нормы после обеда и ужина: 1 завтрак + 0–2 перекуса в день.
const EXTRA_COST_WEIGHT = 1.2;

export function planExtras({ plan, recipes, products, targets, prefs = DEFAULT_PREFS, seed = 1, costWeight = EXTRA_COST_WEIGHT }) {
  const map = new Map(recipes.map((r) => [r.id, r]));
  // цена с учётом уже купленных упаковок (открытая пачка творога дешевле новой)
  const cost = products ? makeCoster(products, { stores: prefs.stores }) : () => 0;
  const needs = new Map();
  for (const b of plan.batches) if (map.get(b.recipeId)) addNeeds(needs, map.get(b.recipeId), b.factor, b.slots.length);
  // наполовину — цена новых упаковок, наполовину — доля упаковки (банка пасты или мёда живёт неделями)
  const extraCost = (r, f) => (products ? 0.5 * marginalCost(needs, r, f, 1, cost) : 0) + 0.5 * r.per_serving.cost * f;
  const breakfasts = eligibleRecipes(recipes, prefs, 'breakfast');
  const snacks = eligibleRecipes(recipes, prefs, 'snack');
  const mains = daySums({ ...plan, extras: [] }, map);
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const counts = {};
  const extras = [];
  let prev = null;
  for (let d = 0; d < 7; d++) {
    let remK = targets.kcal - mains[d].kcal;
    let remP = targets.protein - mains[d].protein;
    if (breakfasts.length) {
      const wantK = Math.max(400, remK * 0.65);
      let best = null;
      for (const r of breakfasts) {
        const ps = r.per_serving;
        const f = wantK >= ps.kcal * 1.4 ? 1.5 : 1;
        let s = Math.abs(ps.kcal * f - wantK) / 300 + Math.max(0, Math.min(remP, 40) - ps.protein * f) * 0.05;
        s += Math.max(0, ps.protein * f - Math.max(remP, 25)) * 0.03;
        s += extraCost(r, f) * costWeight;
        s += (counts[r.id] || 0) * 0.9 + (r.id === prev ? 2 : 0) + rng() * 0.8;
        if (!best || s < best.s) best = { r, f, s };
      }
      extras.push({ id: `x${d}b`, day: d, meal: 'breakfast', recipeId: best.r.id, factor: best.f });
      addNeeds(needs, best.r, best.f, 1);
      counts[best.r.id] = (counts[best.r.id] || 0) + 1;
      prev = best.r.id;
      remK -= best.r.per_serving.kcal * best.f;
      remP -= best.r.per_serving.protein * best.f;
    }
    for (let n = 0; n < 2 && snacks.length && remK > 120; n++) {
      let best = null;
      for (const r of snacks) {
        const ps = r.per_serving;
        if (ps.kcal > remK + 150) continue;
        // при недоборе белка — белковый перекус, иначе калорийный
        let s = remP > 15 ? -Math.min(ps.protein, remP) * 0.08 : -Math.min(ps.kcal, remK) / 150;
        s += Math.max(0, ps.protein - Math.max(remP, 0)) * 0.05; // белок сверх нормы не нужен
        s += extraCost(r, 1) * costWeight;
        s += (counts[r.id] || 0) * 0.3 + extras.some((x) => x.day === d && x.recipeId === r.id) * 3 + rng() * 0.4;
        if (!best || s < best.s) best = { r, s };
      }
      if (!best) break;
      extras.push({ id: `x${d}s${n}`, day: d, meal: 'snack', recipeId: best.r.id, factor: 1 });
      addNeeds(needs, best.r, 1, 1);
      counts[best.r.id] = (counts[best.r.id] || 0) + 1;
      remK -= best.r.per_serving.kcal;
      remP -= best.r.per_serving.protein;
    }
  }
  return extras;
}

export function extraAlternatives(plan, extraId, { recipes, prefs = DEFAULT_PREFS }) {
  const x = (plan.extras || []).find((e) => e.id === extraId);
  if (!x) return [];
  const cur = recipes.find((r) => r.id === x.recipeId);
  const sameDay = new Set(plan.extras.filter((e) => e.day === x.day).map((e) => e.recipeId));
  return eligibleRecipes(recipes, prefs, x.meal)
    .filter((r) => !sameDay.has(r.id))
    .map((r) => ({ recipe: r, d: cur ? Math.abs(r.per_serving.kcal - cur.per_serving.kcal) / 300 + Math.abs(r.per_serving.protein - cur.per_serving.protein) / 15 : 0 }))
    .sort((a, b) => a.d - b.d)
    .map((a) => a.recipe);
}

// Порция при замене завтрака или перекуса: ×1,5 — только если новое блюдо и в полуторной порции не перебирает
// калорий прежнего (так же, как при составлении плана)
export function swapFactor(oldRecipe, oldFactor, recipe) {
  if (!oldRecipe) return 1;
  const want = oldRecipe.per_serving.kcal * (oldFactor || 1);
  return want >= recipe.per_serving.kcal * 1.4 ? 1.5 : 1;
}

export function swapExtra(plan, extraId, recipe, oldRecipe) {
  return {
    ...plan,
    edited: [...new Set([...(plan.edited || []), extraId])], // ручная замена завтрака или перекуса — «досоставить» её не тронет
    extras: plan.extras.map((e) => (e.id === extraId ? { ...e, recipeId: recipe.id, factor: swapFactor(oldRecipe, e.factor, recipe) } : e)),
  };
}

// Похожие блюда для замены: сначала те, что похожи по типу белка и продуктам и дёшевы при текущем плане
export function alternatives(plan, batchId, { recipes, products, targets, prefs = DEFAULT_PREFS, limit = 12 }) {
  const b = plan.batches.find((x) => x.id === batchId);
  if (!b) return [];
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const cur = byId.get(b.recipeId);
  const cost = makeCoster(products, { stores: prefs.stores });
  const needs = new Map();
  const counts = {};
  for (const x of plan.batches) {
    if (x.id === batchId) continue;
    const r = byId.get(x.recipeId);
    if (!r) continue;
    addNeeds(needs, r, x.factor, x.slots.length);
    counts[r.id] = (counts[r.id] || 0) + 1;
  }
  const maxRep = Math.max(1, prefs.maxRepeats || 2);
  const portions = b.slots.length;
  // блюда соседних приготовлений не предлагаем — иначе одно и то же три раза подряд
  const idx = plan.batches.findIndex((x) => x.id === batchId);
  const neighbours = new Set([plan.batches[idx - 1]?.recipeId, plan.batches[idx + 1]?.recipeId].filter(Boolean));
  const curKeys = cur ? mainKeys(cur) : new Set();
  const out = [];
  for (const r of eligibleRecipes(recipes, prefs)) {
    if (r.id === b.recipeId) continue;
    if (portions > 1 && !canStore(r)) continue;
    if ((counts[r.id] || 0) >= maxRep || neighbours.has(r.id)) continue;
    const f = portionFactor(r, targets);
    const delta = marginalCost(needs, r, f, portions, cost);
    const keys = mainKeys(r);
    const inter = [...keys].filter((k) => curKeys.has(k)).length;
    const jacc = inter / Math.max(1, new Set([...keys, ...curKeys]).size);
    let sim = jacc * 2 + (cur && r.protein_type === cur.protein_type ? 1.2 : 0);
    if (cur) sim -= Math.abs(r.per_serving.cost - cur.per_serving.cost) * 0.4;
    if (cur) sim -= Math.abs((r.time?.active || 20) - (cur.time?.active || 20)) / 30;
    const rank = sim - (delta / portions) * 0.8 - (counts[r.id] || 0) * 3;
    out.push({ recipe: r, factor: f, deltaCost: round2(delta), similarity: round2(sim), rank });
  }
  out.sort((a, b2) => b2.rank - a.rank);
  return out.slice(0, limit);
}

export function swapBatch(plan, batchId, recipe, targets) {
  return {
    ...plan,
    edited: [...new Set([...(plan.edited || []), batchId])], // ручная правка — «досоставить» её не тронет
    batches: plan.batches.map((b) => (b.id === batchId ? { ...b, recipeId: recipe.id, factor: portionFactor(recipe, targets) } : b)),
  };
}

// Разложить план по дням: days[d][meal] = { batch, recipe, factor, leftover }
export function planDays(plan, recipeMap) {
  const days = Array.from({ length: 7 }, () => ({ snacks: [] }));
  for (const b of plan.batches) {
    const r = recipeMap.get(b.recipeId);
    b.slots.forEach((s, idx) => {
      days[s.day][s.meal] = { batch: b, recipe: r, factor: b.factor, leftover: idx > 0, portions: b.slots.length };
    });
  }
  for (const x of plan.extras || []) {
    const e = { extra: x, recipe: recipeMap.get(x.recipeId), factor: x.factor, portions: 1 };
    if (!e.recipe) continue;
    if (x.meal === 'breakfast') days[x.day].breakfast = e;
    else days[x.day].snacks.push(e);
  }
  return days;
}

// Суммы по дням; mainOnly — только обед и ужин
export function daySums(plan, recipeMap, { mainOnly = false } = {}) {
  return planDays(plan, recipeMap).map((d) => {
    const sum = { kcal: 0, protein: 0, fat: 0, carbs: 0, cost: 0 };
    const entries = [d.lunch, d.dinner, ...(mainOnly ? [] : [d.breakfast, ...d.snacks])];
    for (const e of entries) {
      if (!e?.recipe) continue;
      const ps = e.recipe.per_serving;
      for (const k of Object.keys(sum)) sum[k] += (ps[k] || 0) * e.factor;
    }
    return sum;
  });
}

// ---------- Гибкий план (F21, F22, F05): «ем вне дома / пропустил», перенос, досоставить оставшиеся дни ----------
// plan.skips: { ключ: 'out' | 'skipped' } — необязательное поле (старые планы без него работают как раньше).
// Ключ обеда и ужина — 'день|приём', завтрака и перекуса — id («x1s0»): перекусов в день бывает два.
export const slotKey = (day, meal) => `${day}|${meal}`;
export const skipKeyOf = (e) => (e.extra ? e.extra.id : slotKey(e.day, e.meal));
export const skipOf = (plan, key) => plan?.skips?.[key] || null;

// План без пропущенных приёмов пищи. kinds: какие пропуски учитывать — для покупок только 'out' («ем вне дома»):
// под прошедшее «не ел» продукты уже куплены и остаются в сумме к оплате; для съеденного — оба вида.
// Ужин на 2 порции, у которого пропущен обед следующего дня, готовится на 1 порцию; пропущено всё — не готовится.
export function effectivePlan(plan, kinds = ['out', 'skipped']) {
  if (!plan || !plan.skips || !Object.keys(plan.skips).length) return plan;
  const off = (k) => kinds.includes(plan.skips[k]);
  return {
    ...plan,
    batches: plan.batches.map((b) => ({ ...b, slots: b.slots.filter((s) => !off(slotKey(s.day, s.meal))) })).filter((b) => b.slots.length),
    extras: (plan.extras || []).filter((x) => !off(x.id)),
  };
}

export function toggleSkip(plan, key, kind = 'out') {
  const skips = { ...(plan.skips || {}) };
  if (skips[key]) delete skips[key]; else skips[key] = kind;
  return { ...plan, skips };
}

// Перенести ужин на другой день: блюда двух ужинов меняются местами (вместе с обедом-остатком)
export function moveBatch(plan, batchId, toDay) {
  const a = plan.batches.find((b) => b.id === batchId);
  const b = plan.batches.find((x) => x.id !== batchId && x.slots[0].day === toDay && x.slots[0].meal === a?.slots[0].meal);
  if (!a || !b) return plan;
  const edited = [...new Set([...(plan.edited || []), a.id, b.id])];
  return {
    ...plan, edited,
    batches: plan.batches.map((x) => (x.id === a.id ? { ...x, recipeId: b.recipeId, factor: b.factor } : x.id === b.id ? { ...x, recipeId: a.recipeId, factor: a.factor } : x)),
  };
}

// Досоставить оставшиеся дни: закреплённое (isLocked: прошедшее, сегодня и завтра — продукты могли быть уже куплены)
// и изменённое вручную остаётся, остальное подбирается заново. План сохраняет id (отметки покупок не теряются),
// дату начала, пропуски и чеки. cheap — «Подобрать дешевле».
export function refillPlan(plan, { recipes, products, targets, prefs = DEFAULT_PREFS, budget = 70, reserve = 20, seed = 1, isLocked, isDone = () => false, cheap = false }) {
  const locked = {};
  const edited = new Set(plan.edited || []);
  // блюдо, которое больше нельзя предлагать (нет утвари, скрыто, исключён продукт), не закрепляется —
  // кроме уже приготовленного
  const okMain = new Set(eligibleRecipes(recipes, prefs, 'main').map((r) => r.id));
  const okExtra = (x) => eligibleRecipes(recipes, prefs, x.meal).some((r) => r.id === x.recipeId);
  for (const b of plan.batches) {
    const gi = +b.id.slice(1);
    const { day, meal } = b.slots[0];
    if (isDone(day, meal) || ((edited.has(b.id) || isLocked(day, meal)) && okMain.has(b.recipeId))) locked[gi] = b.recipeId;
  }
  // шаблон приготовлений — как у этого плана, даже если настройку «ужин на 2 порции» с тех пор поменяли
  const fresh = generatePlan({ recipes, products, targets, prefs: { ...prefs, batchCooking: plan.batchCooking !== false }, budget, reserve, seed, locked, cheap });
  const keepExtra = (x) => isDone(x.day, x.meal) || ((edited.has(x.id) || isLocked(x.day, x.meal)) && okExtra(x));
  return {
    ...fresh, id: plan.id, startDate: plan.startDate, settingsKey: plan.settingsKey, skips: plan.skips, edited: plan.edited, receipts: plan.receipts,
    // закреплённые завтраки и перекусы — целиком из прежнего плана, остальные — новые
    // (id слота одинаковый: «x<день>b», «x<день>s<n>»; новый берётся для всех слотов, где прежний не оставлен)
    extras: (() => {
      const kept = (plan.extras || []).filter(keepExtra);
      const keptIds = new Set(kept.map((x) => x.id));
      return [...kept, ...(fresh.extras || []).filter((x) => !keptIds.has(x.id))];
    })(),
    // факторы порций у закреплённых — прежние
    batches: fresh.batches.map((b) => { const o = plan.batches.find((x) => x.id === b.id); return o && locked[+b.id.slice(1)] ? { ...b, factor: o.factor } : b; }),
  };
}

// «Не предлагать» из плана: блюдо убирается и из текущей недели — каждое ещё не приготовленное
// появление заменяется самым похожим (prefs уже со скрытым блюдом). Возвращает { plan, count }
export function dropRecipe(plan, recipeId, { recipes, products, targets, prefs = DEFAULT_PREFS, isDone = () => false }) {
  let p = plan;
  let count = 0;
  for (const b of plan.batches) {
    if (b.recipeId !== recipeId || isDone(b.slots[0].day, b.slots[0].meal)) continue;
    const alt = alternatives(p, b.id, { recipes, products, targets, prefs, limit: 1 })[0];
    if (alt) { p = swapBatch(p, b.id, alt.recipe, targets); count++; }
  }
  const byId = new Map(recipes.map((r) => [r.id, r]));
  for (const x of plan.extras || []) {
    if (x.recipeId !== recipeId || isDone(x.day, x.meal)) continue;
    const alt = extraAlternatives(p, x.id, { recipes, prefs })[0];
    if (alt) { p = swapExtra(p, x.id, alt, byId.get(recipeId)); count++; }
  }
  const left = [...p.batches.filter((b) => b.recipeId === recipeId && !isDone(b.slots[0].day, b.slots[0].meal)),
    ...(p.extras || []).filter((x) => x.recipeId === recipeId && !isDone(x.day, x.meal))].length;
  return { plan: p, count, left };
}
