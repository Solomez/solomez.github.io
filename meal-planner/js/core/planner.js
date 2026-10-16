// Генератор рациона на неделю (обед + ужин) и замена блюд.
import { chooseOffer, proportionalCost, scaledIngredients, round2 } from './shopping.js';

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
  allowTwoStores: false, // в плане походов разрешить два магазина в один день, если так дешевле
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

export function generatePlan({ recipes, products, targets, prefs = DEFAULT_PREFS, budget = 70, reserve = 20, seed = Date.now(), iterations = 120, locked = {} }) {
  const pool = eligibleRecipes(recipes, prefs);
  const template = slotTemplate(prefs.batchCooking !== false);
  const cost = makeCoster(products, { stores: prefs.stores });
  const maxRep = Math.max(1, prefs.maxRepeats || 2);
  const mealBudget = Math.max(10, budget - reserve);
  const byId = new Map(recipes.map((r) => [r.id, r]));
  // «Вкус недели»: случайные предпочтения на всю генерацию, чтобы каждая новая неделя была другой,
  // а внутри генерации по-прежнему выбирался самый выгодный вариант
  const rng0 = mulberry32(seed >>> 0);
  const taste = new Map(pool.map((r) => [r.id, rng0() * 2.4 + ((r.tags || []).includes('спорное') ? 0.8 : 0)]));
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
          let s = (COST_WEIGHT * marginalCost(needs, r, f, portions, cost)) / portions;
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
    const objective = COST_WEIGHT * total + penalty + Math.max(0, total - mealBudget) * 4;
    if (!best || objective < best.objective) best = { objective, total, batches };
  }
  const plan = {
    id: 'plan-' + seed,
    createdAt: new Date().toISOString(),
    batchCooking: prefs.batchCooking !== false,
    batches: best ? best.batches : [],
    extras: [],
  };
  if (prefs.planBreakfast !== false && targets) plan.extras = planExtras({ plan, recipes, products, targets, prefs, seed });
  return plan;
}

// ---------- Завтраки и перекусы ----------
// Под остаток дневной нормы после обеда и ужина: 1 завтрак + 0–2 перекуса в день.
const EXTRA_COST_WEIGHT = 1.2;

export function planExtras({ plan, recipes, products, targets, prefs = DEFAULT_PREFS, seed = 1 }) {
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
        s += extraCost(r, f) * EXTRA_COST_WEIGHT;
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
        s += extraCost(r, 1) * EXTRA_COST_WEIGHT;
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
  return { ...plan, extras: plan.extras.map((e) => (e.id === extraId ? { ...e, recipeId: recipe.id, factor: swapFactor(oldRecipe, e.factor, recipe) } : e)) };
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
