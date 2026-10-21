// Генератор рациона на неделю (обед + ужин) и замена блюд.
import { chooseOffer, proportionalCost, scaledIngredients, round2 } from './shopping.js';
import { canCook } from './equipment.js';
import { makeDated, addDish, datedMarginal, datedTotal } from './spoil.js';
import { dayDate, COOK_HOUR } from './calendar.js';
import { closedDays, openedDays } from './shelf.js';

export const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const DAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const MEALS = { breakfast: 'Завтрак', lunch: 'Обед', dinner: 'Ужин', snack: 'Перекус' };

// Предел активной готовки для плана недели (исходное условие); то же — core/compile.js ACTIVE_LIMIT
export const ACTIVE_MAX = 30;

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
  maxTotal: null, // время блюда целиком (с ожиданием), минут: null — любое; руками — всегда до ACTIVE_MAX (S65)
  stove: 'electric', // плита: 'electric' (ручка 1–6 или 1–9), 'induction' (1–9), 'gas' — для «Что значит?» про огонь (S55)
  showGrams: false, // в рецептах и режиме готовки — граммы мелко рядом с бытовой мерой
  planSource: 'shop', // откуда продукты для новой недели: 'home' — только из того, что дома, 'shop' — с покупками (запасы — в первую очередь)
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
    // активной готовки больше 30 минут (считает движок по шагам, с заменами) — не в план; в рецептах есть с предупреждением
    // предел — по нормам повара (time.active_pro); на странице — время новичка, оно больше (S53)
    if (r.compiled && (r.time?.active_pro ?? r.time?.active) > ACTIVE_MAX) return false;
    // «готовлю до 45 минут» в профиле — блюдо целиком, с ожиданием (S65: гуляш на 143 минуты не попадает)
    if (prefs.maxTotal && type === 'main' && (r.time?.total || 0) > prefs.maxTotal) return false;
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

// Сколько продукта есть дома для подбора: home — { key: граммы | Infinity | true }
export const haveOf = (home, key) => { const v = home?.[key]; return v === true ? Infinity : +v || 0; };

// Стоимость покупки key в количестве grams (упаковками; базовые — пропорционально).
// opts.home — что есть дома: покупается только то, чего не хватает (продукты из запасов «бесплатны»)
function makeCoster(products, opts) {
  const memo = new Map();
  return (key, grams) => {
    grams -= haveOf(opts?.home, key);
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

// «Только из того, что дома»: хватает ли запасов на это блюдо вместе с уже выбранными (needs).
// Базовые (соль, масло, специи) и «по желанию» не проверяем. Допуск — только на округление (2 г): иначе
// список покупок докупает целую упаковку ради недостающих граммов, и «из дома» перестаёт быть «без магазина»
const SLACK_G = 2;
export function fitsHome(needs, recipe, factor, portions, home) {
  for (const i of scaledIngredients(recipe, factor, portions)) {
    if (i.basic || i.optional || i.key === 'water' || !(i.grams > 0)) continue;
    if ((needs.get(i.key) || 0) + i.grams > haveOf(home, i.key) + SLACK_G) return false;
  }
  return true;
}
// Чего не хватает дома на блюдо: [{ key, grams }] (сколько докупить)
export function missingFromHome(recipe, factor, portions, home, needs = new Map()) {
  const out = [];
  for (const i of scaledIngredients(recipe, factor, portions)) {
    if (i.basic || i.optional || i.key === 'water' || !(i.grams > 0)) continue;
    const short = (needs.get(i.key) || 0) + i.grams - haveOf(home, i.key);
    if (short > SLACK_G) out.push({ key: i.key, grams: Math.min(short, i.grams) }); // тот же допуск, что в fitsHome
  }
  return out;
}

// Неделя в бюджете (F02): раньше бюджет ограничивал только обеды и ужины, а завтраки и перекусы добавлялись после
// и в бюджет не входили. Теперь считается вся неделя; если вышло дороже — второй, более строгий проход.
// cheap — «Подобрать дешевле»: цена важнее разнообразия. Белок не снижается никогда (требование).
export function generatePlan(opts) {
  const { recipes, products, targets, prefs = DEFAULT_PREFS, budget = 70, reserve = 20, cheap = false, home = null, source = 'shop' } = opts;
  const withExtras = prefs.planBreakfast !== false && !!targets;
  const onlyHome = source === 'home';
  const limit = withExtras ? budget : Math.max(10, budget - reserve);
  // «дешевле»: дешёвые блюда можно повторять трижды, «вкус недели» почти не мешает цене, завтраки и перекусы — дешевле
  const p2 = cheap ? { ...prefs, maxRepeats: Math.max(3, prefs.maxRepeats || 2) } : prefs;
  const run = (mealBudget, overPenalty, costWeight) => {
    const plan = buildPlan({ ...opts, prefs: p2, mealBudget, overPenalty, costWeight, tasteScale: cheap ? 0.25 : 1 });
    if (withExtras) plan.extras = planExtras({ plan, recipes, products, targets, prefs: p2, seed: opts.seed ?? 1, costWeight: cheap ? 3 : EXTRA_COST_WEIGHT, home, onlyHome, locked: opts.lockedExtras, storage: opts.storage, buyDay: opts.buyDay, homeUntil: opts.homeUntil, prev: opts.prev?.extras });
    return { plan, cost: planCost(plan, recipes, products, prefs, home, opts) };
  };
  let best = run(Math.max(10, budget - reserve), cheap ? 8 : 4, cheap ? 1.5 : COST_WEIGHT);
  if (!onlyHome && best.cost > limit + 0.01) {
    const strict = run(Math.max(10, budget - reserve - (best.cost - limit)), 12, cheap ? 2 : 1.2);
    if (strict.cost < best.cost) best = strict;
  }
  best.plan.costEstimate = round2(best.cost);
  best.plan.source = onlyHome ? 'home' : 'shop';
  return best.plan;
}

// Стоимость покупок недели по самой выгодной цене (упаковками), включая завтраки и перекусы.
// С данными о сроках (dated.storage) — по дням: пачка, вскрытая слишком давно, не доедается, нужна новая (core/spoil.js)
export function planCost(plan, recipes, products, prefs = DEFAULT_PREFS, home = null, dated = null) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  if (dated?.storage) {
    const d = makeDated({ products, storage: dated.storage, stores: prefs.stores, home, homeUntil: dated.homeUntil, buyDay: dated.buyDay });
    return datedTotal(datedNeeds(plan, byId), d, { skipBasic: true }).cost;
  }
  const cost = makeCoster(products, { stores: prefs.stores, home });
  const needs = new Map();
  for (const b of plan.batches) if (byId.get(b.recipeId)) addNeeds(needs, byId.get(b.recipeId), b.factor, b.slots.length);
  for (const x of plan.extras || []) if (byId.get(x.recipeId)) addNeeds(needs, byId.get(x.recipeId), x.factor, 1);
  for (const [k] of needs) if (products[k]?.basic) needs.delete(k); // базовые (масло, специи) — отдельно, «купить один раз»
  return totalCost(needs, cost);
}

// Продукты плана по дням готовки: Map key → [{ day, grams }] (обед и ужин — день готовки, завтрак и перекус — свой день)
export function datedNeeds(plan, byId) {
  const needs = new Map();
  for (const b of plan.batches) if (byId.get(b.recipeId) && b.slots.length) addDish(needs, byId.get(b.recipeId), b.factor, b.slots.length, b.slots[0].day);
  for (const x of plan.extras || []) if (byId.get(x.recipeId)) addDish(needs, byId.get(x.recipeId), x.factor, 1, x.day);
  return needs;
}

// Сколько весит «порча» в оценке блюда: штраф в евро (выброшенное, заморозка, вторая закупка) — чуть сильнее цены,
// чтобы скоропортящееся вставало в начало недели, а вскрытая пачка доедалась в свой срок (блок В)
export const SPOIL_WEIGHT = 1;

// «Досоставить»: прежнее блюдо готовки остаётся, если замена не даёт заметной выгоды (свежесть, цена) — иначе новый
// «вкус недели» перетасовывает план и докупает новое, а купленное лежит (блок В, сценарий пропуска дня)
const STAY = 2;
const STAY_EXTRA = 1;

function buildPlan({ recipes, products, targets, prefs = DEFAULT_PREFS, seed = Date.now(), iterations = 120, locked = {}, mealBudget, overPenalty = 4, costWeight = COST_WEIGHT, tasteScale = 1, home = null, source = 'shop', prefer = null, storage = null, buyDay = 0, homeUntil = null, prev = null }) {
  const pool = eligibleRecipes(recipes, prefs);
  const template = slotTemplate(prefs.batchCooking !== false);
  const cost = makeCoster(products, { stores: prefs.stores, home });
  // с данными о сроках — цена по дням (core/spoil.js): одна модель на всю генерацию (кэш упаковок общий)
  const dated = storage ? makeDated({ products, storage, stores: prefs.stores, home, homeUntil, buyDay }) : null;
  const onlyHome = source === 'home';
  // скоро испортится — блюда с этими продуктами чуть выгоднее
  const preferSet = new Set(prefer || []);
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
    let tripDays = new Set();
    for (let gi = 0; gi < template.length; gi++) {
      const slots = template[gi];
      const portions = slots.length;
      const day = slots[0].day;
      let pick = null;
      if (locked[gi] && byId.get(locked[gi])) {
        pick = byId.get(locked[gi]);
      } else {
        let bestScore = Infinity;
        for (const r of pool) {
          if (portions > 1 && !canStore(r)) continue;
          if ((counts[r.id] || 0) >= maxRep) continue;
          // то же блюдо две готовки подряд — 4 приёма пищи одного и того же (со сроками пачку выгодно доедать подряд)
          if (batches.length && batches[batches.length - 1].recipeId === r.id && batches[batches.length - 1].slots[0].day >= day - 1) continue;
          const f = portionFactor(r, targets);
          if (onlyHome && !fitsHome(needs, r, f, portions, home)) continue;
          // цена важна, но внутри бюджета не перевешивает разнообразие (перерасход штрафуется ниже);
          // со сроками — цена по дням и штраф за порчу (скоропортящееся позже срока, недоеденная вскрытая пачка)
          let s;
          if (dated) { const m = datedMarginal(needs, r, f, portions, day, dated, tripDays); s = (costWeight * m.cost + SPOIL_WEIGHT * m.pen) / portions; }
          else s = (costWeight * marginalCost(needs, r, f, portions, cost)) / portions;
          s += taste.get(r.id) || 0;
          s += (counts[r.id] || 0) * 2.5; // разнообразие
          if (r.protein_type === prevType) s += 1.2;
          s += Math.max(0, (typeCounts[r.protein_type] || 0) - 2) * 0.5;
          if (targets) s += Math.max(0, targets.perMeal.protein * 0.9 - r.per_serving.protein * f) * 0.04;
          if (preferSet.size) s -= r.ingredients.filter((i) => preferSet.has(i.key)).length * 1.2;
          if (prev?.batches?.[gi] === r.id) s -= STAY;
          s += rng() * 0.6; // небольшой шум между итерациями
          if (s < bestScore) {
            bestScore = s;
            pick = r;
          }
        }
      }
      if (!pick) continue;
      const f = portionFactor(pick, targets);
      if (dated) { addDish(needs, pick, f, portions, day); tripDays = datedTotal(needs, dated).trips; } else addNeeds(needs, pick, f, portions);
      counts[pick.id] = (counts[pick.id] || 0) + 1;
      typeCounts[pick.protein_type] = (typeCounts[pick.protein_type] || 0) + 1;
      penalty += taste.get(pick.id) || 0;
      if (prev?.batches?.[gi] === pick.id && !locked[gi]) penalty -= STAY;
      if (counts[pick.id] > 1) penalty += 2.5;
      if (pick.protein_type === prevType) penalty += 1.2;
      prevType = pick.protein_type;
      batches.push({ id: `b${gi}`, recipeId: pick.id, factor: f, slots: slots.map((s) => ({ ...s })) });
    }
    let total;
    let spoilPen = 0;
    if (dated) { const t = datedTotal(needs, dated); total = t.cost; spoilPen = t.pen; } else total = totalCost(needs, cost);
    // «из дома»: важнее всего — закрыть как можно больше приёмов пищи тем, что есть
    const objective = costWeight * total + SPOIL_WEIGHT * spoilPen + penalty + Math.max(0, total - mealBudget) * overPenalty - (onlyHome ? batches.length * 100 : 0);
    if (!best || objective < best.objective) best = { objective, total, batches };
  }
  // скоропортящееся — в первые дни: переставить готовки одинакового размера, если так меньше порчи (закреплённые — на месте)
  if (best && dated) best.batches = reorderFresh(best.batches, { byId, dated, costWeight, locked });
  const plan = {
    id: 'plan-' + seed,
    createdAt: new Date().toISOString(),
    batchCooking: prefs.batchCooking !== false,
    batches: best ? best.batches : [],
    extras: [],
  };
  return plan;
}

// Перестановка готовок ради свежести: меняем местами блюда двух готовок с одинаковым числом порций, если так
// дешевле с учётом порчи (цена по дням + штраф), а одинаковый белок не встаёт подряд. Жадно, пока есть улучшение.
function reorderFresh(batches, { byId, dated, costWeight, locked = {} }) {
  let cur = batches.map((b) => ({ ...b }));
  const score = (bs) => {
    const t = datedTotal(datedNeeds({ batches: bs, extras: [] }, byId), dated);
    let adj = 0;
    for (let i = 1; i < bs.length; i++) {
      const a = byId.get(bs[i - 1].recipeId);
      const b = byId.get(bs[i].recipeId);
      if (a && b && a.protein_type === b.protein_type) adj += 1.2;
    }
    return costWeight * t.cost + SPOIL_WEIGHT * t.pen + adj;
  };
  let base = score(cur);
  const free = (b) => !locked[+b.id.slice(1)];
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        const a = cur[i];
        const b = cur[j];
        if (!free(a) || !free(b) || a.slots.length !== b.slots.length || a.recipeId === b.recipeId) continue;
        const next = cur.slice();
        next[i] = { ...a, recipeId: b.recipeId, factor: b.factor };
        next[j] = { ...b, recipeId: a.recipeId, factor: a.factor };
        // то же блюдо две готовки подряд не ставим
        if (next.some((x, k) => k > 0 && next[k - 1].recipeId === x.recipeId)) continue;
        const s2 = score(next);
        if (s2 < base - 0.05) { cur = next; base = s2; improved = true; }
      }
    }
    if (!improved) break;
  }
  return cur;
}

// ---------- Завтраки и перекусы ----------
// Под остаток дневной нормы после обеда и ужина: 1 завтрак + 0–2 перекуса в день.
const EXTRA_COST_WEIGHT = 1.2;

export function planExtras({ plan, recipes, products, targets, prefs = DEFAULT_PREFS, seed = 1, costWeight = EXTRA_COST_WEIGHT, home = null, onlyHome = false, locked = null, storage = null, buyDay = 0, homeUntil = null, prev = null }) {
  const map = new Map(recipes.map((r) => [r.id, r]));
  // цена с учётом уже купленных упаковок (открытая пачка творога дешевле новой) и того, что дома
  const cost = products ? makeCoster(products, { stores: prefs.stores, home }) : () => 0;
  // со сроками — по дням: открытая пачка скира бесплатна, только пока она годна; бананы — по сроку от покупки
  const dated = products && storage ? makeDated({ products, storage, stores: prefs.stores, home, homeUntil, buyDay }) : null;
  const needs = new Map(); // без сроков: key → граммы
  let dn = new Map(); // со сроками: key → [{ day, grams }]
  let tripDays = new Set();
  const addX = (r, f, portions, day) => {
    addNeeds(needs, r, f, portions);
    if (dated) { addDish(dn, r, f, portions, day); tripDays = datedTotal(dn, dated).trips; }
  };
  for (const b of plan.batches) if (map.get(b.recipeId)) addX(map.get(b.recipeId), b.factor, b.slots.length, b.slots[0].day);
  // наполовину — цена новых упаковок, наполовину — доля упаковки (банка пасты или мёда живёт неделями)
  const marg = (r, f, day) => {
    if (!products) return 0;
    if (!dated) return marginalCost(needs, r, f, 1, cost);
    const m = datedMarginal(dn, r, f, 1, day, dated, tripDays);
    return m.cost + (SPOIL_WEIGHT / 0.5) * m.pen; // штраф порчи — в полную силу (extraCost берёт половину)
  };
  const extraCost = (r, f, day) => 0.5 * marg(r, f, day) + (home ? 0.25 : 0.5) * r.per_serving.cost * f;
  const fits = (r, f) => !onlyHome || fitsHome(needs, r, f, 1, home);
  // закреплённые завтраки и перекусы («досоставить»): их продукты уже заняты
  for (const x of locked || []) if (map.get(x.recipeId)) addX(map.get(x.recipeId), x.factor, 1, x.day);
  const lockedAt = (d, meal) => (locked || []).filter((x) => x.day === d && x.meal === meal);
  const breakfasts = eligibleRecipes(recipes, prefs, 'breakfast');
  const snacks = eligibleRecipes(recipes, prefs, 'snack');
  const mains = daySums({ ...plan, extras: [] }, map);
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const counts = {};
  const extras = [];
  let prevB = null;
  const prevX = prev; // «досоставить»: прежние завтраки и перекусы по id слота
  for (let d = 0; d < 7; d++) {
    let remK = targets.kcal - mains[d].kcal;
    let remP = targets.protein - mains[d].protein;
    for (const x of [...lockedAt(d, 'breakfast'), ...lockedAt(d, 'snack')]) {
      const r = map.get(x.recipeId);
      if (!r) continue;
      remK -= r.per_serving.kcal * x.factor;
      remP -= r.per_serving.protein * x.factor;
    }
    if (breakfasts.length && !lockedAt(d, 'breakfast').length) {
      const wantK = Math.max(400, remK * 0.65);
      let best = null;
      for (const r of breakfasts) {
        const ps = r.per_serving;
        let f = wantK >= ps.kcal * 1.4 ? 1.5 : 1;
        if (!fits(r, f)) { if (f > 1 && fits(r, 1)) f = 1; else continue; }
        let s = Math.abs(ps.kcal * f - wantK) / 300 + Math.max(0, Math.min(remP, 40) - ps.protein * f) * 0.05;
        s += Math.max(0, ps.protein * f - Math.max(remP, 25)) * 0.03;
        s += extraCost(r, f, d) * costWeight;
        s += (counts[r.id] || 0) * 0.9 + (r.id === prevB ? 2 : 0) + rng() * 0.8;
        if (prevX?.[`x${d}b`] === r.id) s -= STAY_EXTRA;
        if (!best || s < best.s) best = { r, f, s };
      }
      if (best) {
        extras.push({ id: `x${d}b`, day: d, meal: 'breakfast', recipeId: best.r.id, factor: best.f });
        addX(best.r, best.f, 1, d);
        counts[best.r.id] = (counts[best.r.id] || 0) + 1;
        prevB = best.r.id;
        remK -= best.r.per_serving.kcal * best.f;
        remP -= best.r.per_serving.protein * best.f;
      }
    }
    for (let n = lockedAt(d, 'snack').length; n < 2 && snacks.length && remK > 120; n++) {
      let best = null;
      for (const r of snacks) {
        const ps = r.per_serving;
        if (ps.kcal > remK + 150) continue;
        if (!fits(r, 1)) continue;
        // при недоборе белка — белковый перекус, иначе калорийный
        let s = remP > 15 ? -Math.min(ps.protein, remP) * 0.08 : -Math.min(ps.kcal, remK) / 150;
        s += Math.max(0, ps.protein - Math.max(remP, 0)) * 0.05; // белок сверх нормы не нужен
        s += extraCost(r, 1, d) * costWeight;
        s += (counts[r.id] || 0) * 0.3 + [...extras, ...lockedAt(d, 'snack')].some((x) => x.day === d && x.recipeId === r.id) * 3 + rng() * 0.4;
        if (prevX && Object.entries(prevX).some(([id, rid]) => rid === r.id && id.startsWith(`x${d}s`))) s -= STAY_EXTRA;
        if (!best || s < best.s) best = { r, s };
      }
      if (!best) break;
      const taken = new Set([...lockedAt(d, 'snack'), ...extras].map((x) => x.id));
      let k = n;
      while (taken.has(`x${d}s${k}`)) k++;
      extras.push({ id: `x${d}s${k}`, day: d, meal: 'snack', recipeId: best.r.id, factor: 1 });
      addX(best.r, 1, 1, d);
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
    // свой вариант — ровно в той порции, что собрал человек
    extras: plan.extras.map((e) => (e.id === extraId ? { ...e, recipeId: recipe.id, factor: recipe.custom ? 1 : swapFactor(oldRecipe, e.factor, recipe) } : e)),
  };
}

// Похожие блюда для замены: сначала те, что похожи по типу белка и продуктам и дёшевы при текущем плане
export function alternatives(plan, batchId, { recipes, products, targets, prefs = DEFAULT_PREFS, limit = 12, home = null, storage = null, buyDay = 0, homeUntil = null }) {
  const b = plan.batches.find((x) => x.id === batchId);
  if (!b) return [];
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const cur = byId.get(b.recipeId);
  const cost = makeCoster(products, { stores: prefs.stores, home });
  const needs = new Map();
  const counts = {};
  for (const x of plan.batches) {
    if (x.id === batchId) continue;
    const r = byId.get(x.recipeId);
    if (!r) continue;
    addNeeds(needs, r, x.factor, x.slots.length);
    counts[r.id] = (counts[r.id] || 0) + 1;
  }
  // со сроками: цена и порча по дням — замена в четверг, которой нужен фарш, дороже, чем по сумме граммов
  const dated = storage ? makeDated({ products, storage, stores: prefs.stores, home, homeUntil, buyDay }) : null;
  const dn = dated ? datedNeeds({ batches: plan.batches.filter((x) => x.id !== batchId), extras: plan.extras || [] }, byId) : null;
  const tripDays = dated ? datedTotal(dn, dated).trips : null;
  const maxRep = Math.max(1, prefs.maxRepeats || 2);
  const portions = b.slots.length;
  const day = b.slots[0].day;
  // блюда соседних приготовлений не предлагаем — иначе одно и то же три раза подряд
  const idx = plan.batches.findIndex((x) => x.id === batchId);
  const neighbours = new Set([plan.batches[idx - 1]?.recipeId, plan.batches[idx + 1]?.recipeId].filter(Boolean));
  const curKeys = cur ? mainKeys(cur) : new Set();
  // «осиротевшие» продукты: куплены (есть дома) под это блюдо, а больше ни одно блюдо недели их не берёт —
  // замена, которая их использует, выше; у остальных — «останется без дела: капуста 550 г» (блок В)
  // дальше по плану (с дня этой готовки); долгого хранения (рис, макароны) — не «сироты»: пригодятся потом
  const others = new Set([...plan.batches.filter((x) => x.id !== batchId && x.slots[0].day >= day), ...(plan.extras || []).filter((x) => x.day >= day)]
    .flatMap((x) => (byId.get(x.recipeId)?.ingredients || []).map((i) => i.key)));
  const shortLived = (k) => !storage || closedDays(k, storage) <= 14 || openedDays(k, storage) <= 7;
  const orphans = cur ? scaledIngredients(cur, b.factor, portions).filter((i) => !i.basic && !i.optional && i.key !== 'water' && !others.has(i.key) && haveOf(home, i.key) > 0 && shortLived(i.key))
    .map((i) => ({ key: i.key, grams: Math.min(i.grams, haveOf(home, i.key)) })) : [];
  const out = [];
  for (const r of eligibleRecipes(recipes, prefs)) {
    if (r.id === b.recipeId) continue;
    if (portions > 1 && !canStore(r)) continue;
    if ((counts[r.id] || 0) >= maxRep || neighbours.has(r.id)) continue;
    const f = portionFactor(r, targets);
    let delta;
    let spoil = 0;
    if (dated) { const m = datedMarginal(dn, r, f, portions, day, dated, tripDays); delta = m.cost; spoil = m.pen; } else delta = marginalCost(needs, r, f, portions, cost);
    const keys = mainKeys(r);
    const inter = [...keys].filter((k) => curKeys.has(k)).length;
    const jacc = inter / Math.max(1, new Set([...keys, ...curKeys]).size);
    let sim = jacc * 2 + (cur && r.protein_type === cur.protein_type ? 1.2 : 0);
    if (cur) sim -= Math.abs(r.per_serving.cost - cur.per_serving.cost) * 0.4;
    if (cur) sim -= Math.abs((r.time?.active || 20) - (cur.time?.active || 20)) / 30;
    // всё есть дома — выше (в плане «из дома» — обязательно сверху)
    const fromHome = !!home && fitsHome(needs, r, f, portions, home);
    const leaves = orphans.filter((o) => !keys.has(o.key));
    const rank = sim - ((delta + SPOIL_WEIGHT * spoil) / portions) * 0.8 - (counts[r.id] || 0) * 3 + (fromHome ? (plan.source === 'home' ? 20 : 1) : 0)
      + (orphans.length - leaves.length) * 1.5;
    out.push({ recipe: r, factor: f, deltaCost: round2(delta), similarity: round2(sim), rank, fromHome, leaves });
  }
  out.sort((a, b2) => b2.rank - a.rank);
  return out.slice(0, limit);
}

export function swapBatch(plan, batchId, recipe, targets) {
  return {
    ...plan,
    edited: [...new Set([...(plan.edited || []), batchId])], // ручная правка — «досоставить» её не тронет
    // что стояло изначально — для «Вернуть исходное» после нескольких замен
    batches: plan.batches.map((b) => (b.id === batchId ? { ...b, origRecipeId: b.origRecipeId || b.recipeId, recipeId: recipe.id, factor: recipe.custom ? 1 : portionFactor(recipe, targets) } : b)),
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
// cooked — для учёта продуктов (что ушло в готовку): обед из вчерашнего ужина, отмеченный «не ел» уже после готовки,
// не делает вчерашнюю готовку однопорционной задним числом (блок В: продукты «возвращались» в запасы)
export function effectivePlan(plan, kinds = ['out', 'skipped'], { cooked = false } = {}) {
  if (!plan || !plan.skips || !Object.keys(plan.skips).length) return plan;
  const off = (k) => kinds.includes(plan.skips[k]);
  const cookedAlready = (b, s, idx) => {
    if (!cooked || idx === 0 || off(slotKey(b.slots[0].day, b.slots[0].meal))) return false;
    const k = slotKey(s.day, s.meal);
    if (plan.skips[k] === 'skipped') return true;
    const at = plan.skipAt?.[k];
    if (!at) return false;
    const d = dayDate(plan, b.slots[0].day);
    d.setHours(COOK_HOUR[b.slots[0].meal] ?? 18, 0, 0, 0);
    return at >= d.getTime(); // «ем вне дома» отметили, когда ужин уже приготовлен
  };
  return {
    ...plan,
    batches: plan.batches.map((b) => ({ ...b, slots: b.slots.filter((s, idx) => !off(slotKey(s.day, s.meal)) || cookedAlready(b, s, idx)) })).filter((b) => b.slots.length),
    extras: (plan.extras || []).filter((x) => !off(x.id)),
  };
}

export function toggleSkip(plan, key, kind = 'out', t = Date.now()) {
  const skips = { ...(plan.skips || {}) };
  const skipAt = { ...(plan.skipAt || {}) };
  if (skips[key]) { delete skips[key]; delete skipAt[key]; } else { skips[key] = kind; skipAt[key] = t; }
  const done = { ...(plan.done || {}) };
  if (skips[key]) delete done[key]; // «не ел» снимает отметку «съел»
  return { ...plan, skips, skipAt, done };
}

// ---------- Отметка «приготовил / съел» ----------
// plan.done: { ключ: время отметки } — ключи те же, что у пропусков. Отмеченное готовится «сейчас»: продукты списываются
// из запасов в момент отметки (а не в плановое время), и в список покупок «на оставшееся» блюдо больше не входит.
// Неотмеченное прошедшее по-прежнему считается съеденным по плану, «не ел» — не списывается.
export const doneOf = (plan, key) => plan?.done?.[key] || null;
export function toggleDone(plan, key, t = Date.now()) {
  const done = { ...(plan.done || {}) };
  if (done[key]) delete done[key]; else done[key] = t;
  const skips = { ...(plan.skips || {}) };
  if (done[key]) delete skips[key]; // «съел» снимает «вне дома / не ел»
  return { ...plan, done, skips };
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
export function refillPlan(plan, { recipes, products, targets, prefs = DEFAULT_PREFS, budget = 70, reserve = 20, seed = 1, isLocked, isDone = () => false, cheap = false, home = null, source = 'shop', prefer = null, storage = null, buyDay = 0, homeUntil = null }) {
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
  const keepExtra = (x) => isDone(x.day, x.meal) || ((edited.has(x.id) || isLocked(x.day, x.meal)) && okExtra(x));
  const fresh = generatePlan({ recipes, products, targets, prefs: { ...prefs, batchCooking: plan.batchCooking !== false }, budget, reserve, seed, locked, cheap, home, source, prefer,
    lockedExtras: (plan.extras || []).filter(keepExtra), storage, buyDay, homeUntil,
    prev: { batches: Object.fromEntries(plan.batches.map((b) => [+b.id.slice(1), b.recipeId])), extras: Object.fromEntries((plan.extras || []).map((x) => [x.id, x.recipeId])) } });
  return {
    ...fresh, id: plan.id, startDate: plan.startDate, settingsKey: plan.settingsKey, skips: plan.skips, skipAt: plan.skipAt, edited: plan.edited, receipts: plan.receipts,
    refilledAt: Date.now(), done: plan.done,
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
export function dropRecipe(plan, recipeId, { recipes, products, targets, prefs = DEFAULT_PREFS, isDone = () => false, storage = null }) {
  let p = plan;
  let count = 0;
  for (const b of plan.batches) {
    if (b.recipeId !== recipeId || isDone(b.slots[0].day, b.slots[0].meal)) continue;
    const alt = alternatives(p, b.id, { recipes, products, targets, prefs, limit: 1, storage })[0];
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
