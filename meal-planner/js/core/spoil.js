// Покупка по дням и порча (блок В): сколько стоит продукт, если учесть, КОГДА он нужен.
// Раньше цена считалась по сумме граммов за неделю: остаток вскрытой пачки «бесплатен» в любой день, поэтому 1 кг фарша
// выгодно растягивать на Пн, Ср и Вс — а вскрытый фарш живёт 0–1 день. Здесь — модель закупки:
//   • всё покупается в день закупки buyDay (первый день плана);
//   • закрытая упаковка живёт closed дней (нижняя граница из данных, core/shelf.js), вскрытая — opened дней;
//   • продукт, нужный позже закрытого срока: можно заморозить — замораживается часть сразу в день покупки
//     (небольшой штраф: заморозить и вовремя достать); нельзя — нужна вторая закупка в день готовки (штраф + поход);
//   • вскрытая пачка доедается только в пределах срока после вскрытия: следующая готовка позже открывает новую пачку,
//     остаток прежней выбрасывается (штраф — его стоимость).
// Одна модель для генератора (цена и штраф блюда), списка покупок (сколько пачек и когда, что заморозить) и тестов.
import { chooseOffer, proportionalCost, scaledIngredients } from './shopping.js';
import { closedDays, openedDays, canFreeze, PIECE_SPLIT } from './shelf.js';
import { PIECES } from './stock.js';

// Веса штрафов (в евро «неудобства»): выброшенное — по стоимости; заморозка — 1 € за порцию + половина её цены
// (заморозить, вовремя достать, разморозить — для новичка это работа, и он может забыть); вторая закупка — цена партии
// + 1,5 € за каждый отдельный день похода; остаток последней пачки, который испортится в первые дни следующей недели, —
// половина стоимости (может пригодиться в новом плане). Подобрано по симуляции блока В (5 недель): сильнее —
// неделя однообразнее (ветчина и сосиски до конца недели), слабее — больше мяса во второй половине недели
export const SPOIL_W = { waste: 1, freezeFix: 1, freezeShare: 0.5, late: 1, trip: 1.5, tail: 0.5 };

const round10 = (g) => Math.ceil(g / 10) * 10;

// Дни использования продукта в плане: [{ day, grams }] по возрастанию дня (одинаковые дни сложены)
export function addUse(arr, day, grams) {
  const out = arr ? arr.slice() : [];
  const i = out.findIndex((u) => u.day >= day);
  if (i >= 0 && out[i].day === day) out[i] = { day, grams: out[i].grams + grams };
  else if (i >= 0) out.splice(i, 0, { day, grams });
  else out.push({ day, grams });
  return out;
}

export { PIECE_SPLIT };

/**
 * Разбор покупки одного продукта по дням: партии (покупки), в каждой — пачки «по вскрытию» (chunks).
 * uses — [{ day, grams }] по возрастанию; ctx: { buyDay, home (граммы дома), homeUntil (последний день, когда домашнее годно) };
 * whole — без вскрытия (штучное по штукам, развес): одна «пачка» на партию.
 * Возвращает { lots: [{ buy, late, chunks: [{ open, grams, uses }], frozen: [{ day, grams }] }], homeUsed, homeLeft, closed, opened, freezable }.
 * late — партия второй закупки (купить в день buy); frozen — порции первой партии, которые замораживаются в день покупки.
 */
export function lotsOf(key, uses, storage, ctx = {}, whole = false) {
  const B = ctx.buyDay || 0;
  const c = closedDays(key, storage);
  const o = openedDays(key, storage);
  const fr = canFreeze(key, storage);
  // сначала — то, что дома (пока оно годно)
  let home = ctx.home === Infinity ? Infinity : Math.max(0, +ctx.home || 0);
  const hUntil = ctx.homeUntil ?? Infinity;
  const rest = [];
  let homeUsed = 0;
  for (const u of uses) {
    let g = u.grams;
    if (home > 0 && u.day <= hUntil) { const t = Math.min(home, g); home -= t; homeUsed += t; g -= t; }
    if (g > 1e-6) rest.push({ day: u.day, grams: g });
  }
  const main = { buy: B, late: false, chunks: [], frozen: [] };
  const lots = [main];
  let late = null;
  for (const u of rest) {
    if (u.day <= B + c) { addToLot(main, u, o, whole); continue; }
    if (fr) { main.frozen.push(u); continue; }
    // нельзя заморозить — вторая закупка ближе к готовке; одна партия покрывает дни до своего закрытого срока
    if (!late || u.day > late.buy + c) { late = { buy: u.day, late: true, chunks: [], frozen: [] }; lots.push(late); }
    addToLot(late, u, o, whole);
  }
  return { lots: lots.filter((l) => l.chunks.length || l.frozen.length), homeUsed, homeLeft: home, closed: c, opened: o, freezable: fr };
}

function addToLot(lot, u, o, whole) {
  const ch = lot.chunks[lot.chunks.length - 1];
  // вскрытая пачка годна по день open + o включительно; дальше — новая пачка (штучное и развес — без вскрытия)
  if (ch && (whole || u.day <= ch.open + o)) { ch.grams += u.grams; ch.uses.push(u); return; }
  lot.chunks.push({ open: u.day, grams: u.grams, uses: [u] });
}

// Горизонт плана: остаток, который испортится до конца недели, — выброшен; в первые 2 дня следующей — «хвост»
const H_END = 7;
const H_TAIL = 9;

/**
 * Стоимость и штраф продукта при таких днях использования. memo — общий кэш chooseOffer.
 * Возвращает { cost, pen, trips: Set(день похода), waste (€ — выброшенное до конца недели) }.
 */
export function keyCost(key, uses, products, storage, ctx = {}, memo = new Map()) {
  const p = products[key];
  if (!p || !uses?.length) return ZERO;
  const total = uses.reduce((a, u) => a + u.grams, 0);
  if (p.basic) {
    // базовые (масло, соль, специи): без сроков, по доле упаковки
    const g = Math.max(0, total - (ctx.home === Infinity ? Infinity : +ctx.home || 0));
    return g > 0 ? { cost: proportionalCost(p, round10(g), ctx), pen: 0, trips: NONE, waste: 0 } : ZERO;
  }
  const offer = (g) => {
    const mk = key + '|' + round10(g);
    if (!memo.has(mk)) memo.set(mk, chooseOffer(p, round10(g), ctx));
    return memo.get(mk);
  };
  const pw = PIECE_SPLIT.has(key) ? PIECES[key]?.[0] || 0 : 0;
  // долгое хранение (рис, макароны, яйца, хлопья) и закрытым, и вскрытым — дни не важны: цена — по сумме граммов
  if (!pw && closedDays(key, storage) >= H_TAIL && openedDays(key, storage) >= H_TAIL && (ctx.homeUntil ?? Infinity) >= H_TAIL) {
    const g = total - (ctx.home === Infinity ? Infinity : +ctx.home || 0);
    return g > 1e-6 ? { cost: offer(g)?.cost || 0, pen: 0, trips: NONE, waste: 0 } : ZERO;
  }
  const whole = !!pw || !!offer(total)?.pack?.loose;
  const r = lotsOf(key, uses, storage, ctx, whole);
  let cost = 0;
  let pen = 0;
  let waste = 0;
  const trips = new Set();
  const perG = (o) => (o && o.boughtGrams > 0 ? o.cost / o.boughtGrams : 0);
  const lose = (eur, exp) => { if (exp < H_END) { waste += eur; pen += eur * SPOIL_W.waste; } else if (exp < H_TAIL) pen += eur * SPOIL_W.tail; };
  // дома лежит то, что испортится раньше, чем пригодится, — тоже потеря (стимул сначала использовать запасы)
  if (r.homeLeft > 0 && r.homeLeft !== Infinity && (ctx.homeUntil ?? Infinity) < H_TAIL) lose(proportionalCost(p, r.homeLeft, ctx), ctx.homeUntil);
  for (const lot of r.lots) {
    const frozenG = lot.frozen.reduce((a, u) => a + u.grams, 0);
    const closedExp = lot.buy + r.closed;
    lot.chunks.forEach((ch, i) => {
      // замороженные порции покупаются вместе с первой пачкой партии (одна упаковка, часть — сразу в морозилку)
      const extra = i === 0 ? frozenG : 0;
      const o = offer(ch.grams + extra);
      if (!o) return;
      cost += o.cost;
      const left = Math.max(0, o.boughtGrams - ch.grams - extra);
      if (left <= 1) return;
      const eur = left * perG(o);
      if (pw) {
        // штучное: начатая штука — срок вскрытой, целые — срок закрытой
        const part = Math.min(left, (pw - (ch.grams % pw)) % pw);
        const lastDay = ch.uses[ch.uses.length - 1].day;
        if (part > 1) lose(part * perG(o), Math.min(closedExp, lastDay + r.opened));
        if (left - part > 1) lose((left - part) * perG(o), closedExp);
      } else if (whole) lose(eur, closedExp);
      else lose(eur, i < lot.chunks.length - 1 ? -1 : Math.min(closedExp, ch.open + r.opened));
    });
    if (!lot.chunks.length && frozenG > 0) { const o = offer(frozenG); if (o) cost += o.cost; }
    for (const u of lot.frozen) pen += SPOIL_W.freezeFix + SPOIL_W.freezeShare * proportionalCost(p, u.grams, ctx);
    if (lot.late) {
      trips.add(lot.buy);
      pen += SPOIL_W.late * lot.chunks.reduce((a, ch) => a + (offer(ch.grams)?.cost || 0), 0);
    }
  }
  return { cost, pen, trips, waste };
}
const NONE = new Set();
const ZERO = { cost: 0, pen: 0, trips: NONE, waste: 0 };

/**
 * Кэширующий расчёт по всем продуктам плана: needs — Map key → [{ day, grams }] (новые массивы при каждом изменении).
 * opts: { products, storage, stores, home: { key: г }, homeUntil: { key: день }, buyDay }.
 * of(key, arr) — { cost, pen, trips, waste } с кэшем по массиву.
 */
export function makeDated(opts) {
  const memo = new Map();
  const cache = new WeakMap();
  const ctxOf = (key) => ({ stores: opts.stores, buyDay: opts.buyDay || 0, home: haveOfHome(opts.home, key), homeUntil: opts.homeUntil?.[key] });
  const of = (key, arr) => {
    if (!arr?.length) return ZERO;
    let v = cache.get(arr);
    if (!v) { v = keyCost(key, arr, opts.products, opts.storage, ctxOf(key), memo); cache.set(arr, v); }
    return v;
  };
  // то же с ещё одним использованием (day, grams): кэш по массиву и (день, граммы с точностью до 5 г) — подбор блюда
  // перебирает десятки рецептов с теми же продуктами (лук, рис, курица) на один и тот же день
  const plus = new WeakMap();
  const EMPTY = [];
  const ofAdd = (key, arr, day, grams) => {
    const base = arr || EMPTY;
    let m = plus.get(base);
    if (!m) { m = new Map(); plus.set(base, m); }
    const mk = key + '|' + day + '|' + Math.round(grams / 5);
    let v = m.get(mk);
    if (!v) { v = keyCost(key, addUse(arr, day, grams), opts.products, opts.storage, ctxOf(key), memo); m.set(mk, v); }
    return v;
  };
  return { of, ofAdd, opts };
}
const haveOfHome = (home, key) => { const v = home?.[key]; return v === true ? Infinity : +v || 0; };

// Ингредиенты блюда в днях: что добавит готовка recipe (factor, portions) в день day
export function dishUses(recipe, factor, portions) {
  return scaledIngredients(recipe, factor, portions).filter((i) => i.key !== 'water' && i.grams > 0);
}

// Добавить блюдо в needs (новые массивы — кэш остаётся верным)
export function addDish(needs, recipe, factor, portions, day) {
  for (const i of dishUses(recipe, factor, portions)) needs.set(i.key, addUse(needs.get(i.key), day, i.grams));
}

// Итог по всем продуктам: { cost, pen, waste, trips: Set } — pen уже со штрафом за каждый день второй закупки
export function datedTotal(needs, dated, { skipBasic = false } = {}) {
  let cost = 0;
  let pen = 0;
  let waste = 0;
  const trips = new Set();
  for (const [k, arr] of needs) {
    if (skipBasic && dated.opts.products[k]?.basic) continue;
    const v = dated.of(k, arr);
    cost += v.cost; pen += v.pen; waste += v.waste;
    for (const d of v.trips) trips.add(d);
  }
  return { cost, pen: pen + trips.size * SPOIL_W.trip, waste, trips };
}

// Насколько дороже станет план, если в день day приготовить recipe: { cost, pen } (pen — со штрафом за новые дни походов)
export function datedMarginal(needs, recipe, factor, portions, day, dated, tripDays = NONE) {
  let cost = 0;
  let pen = 0;
  const newTrips = new Set();
  // граммы блюда по продуктам (один продукт может быть в рецепте дважды)
  const add = new Map();
  for (const i of dishUses(recipe, factor, portions)) add.set(i.key, (add.get(i.key) || 0) + i.grams);
  for (const [k, g] of add) {
    const a = dated.of(k, needs.get(k));
    const b = dated.ofAdd(k, needs.get(k), day, g);
    cost += b.cost - a.cost;
    pen += b.pen - a.pen;
    for (const d of b.trips) if (!tripDays.has(d) && !a.trips.has(d)) newTrips.add(d);
  }
  return { cost, pen: pen + newTrips.size * SPOIL_W.trip };
}

// ---------- Список покупок по дням (этап 6а): какие пачки, когда купить, что сразу заморозить ----------
const samePack = (a, b) => a && b && a.store === b.store && a.name_de === b.name_de && a.grams === b.grams && !!a.loose === !!b.loose;
function mergeOffers(offers) {
  const xs = offers.filter(Boolean);
  if (!xs.length) return null;
  if (!xs.every((o) => samePack(o.pack, xs[0].pack))) return null;
  return { pack: xs[0].pack, count: Math.round(xs.reduce((a, o) => a + o.count, 0) * 1000) / 1000, cost: Math.round(xs.reduce((a, o) => a + o.cost, 0) * 100) / 100,
    boughtGrams: xs.reduce((a, o) => a + o.boughtGrams, 0) };
}

/**
 * Покупка одного продукта по дням: [{ buy, late, grams, offer, freeze: [{ day, grams }], first: { day, meal }, last }]
 * — первая партия (в день закупки, с порциями «заморозить сразу») и партии второй закупки (скоропортящееся, которое
 * нельзя заморозить). Пачки — «по вскрытию»: две готовки в разные дни берут две пачки по 500 г, а не 1 кг (вскрытый фарш
 * не доживёт). uses — [{ day, grams, meal? }] по возрастанию дня.
 */
export function purchaseLots(key, uses, product, storage, ctx = {}) {
  if (!product || !uses.length) return [];
  const offer = (g) => chooseOffer(product, Math.max(1, g), ctx);
  const total = uses.reduce((a, u) => a + u.grams, 0);
  const pw = PIECE_SPLIT.has(key) ? PIECES[key]?.[0] || 0 : 0;
  const whole = !!pw || !!offer(total)?.pack?.loose;
  const r = lotsOf(key, uses, storage, ctx, whole);
  const mealOf = (day) => uses.filter((u) => u.day === day).map((u) => u.meal).sort((a, b) => MEAL_ORDER[a] - MEAL_ORDER[b])[0] || 'dinner';
  return r.lots.map((lot) => {
    const frozenG = lot.frozen.reduce((a, u) => a + u.grams, 0);
    const grams = lot.chunks.reduce((a, ch) => a + ch.grams, 0) + frozenG;
    // замораживаемое — отдельными пачками, если так не дороже (+0,30 €): закрытую пачку заморозить проще и надёжнее,
    // чем делить вскрытую; иначе — одной упаковкой, часть которой сразу в морозилку («500 г из 1 кг»)
    let parts = lot.chunks.length ? lot.chunks.map((ch, i) => offer(ch.grams + (i === 0 ? frozenG : 0))) : [offer(frozenG)];
    if (lot.chunks.length && frozenG > 0) {
      const sep = [...lot.chunks.map((ch) => offer(ch.grams)), ...lot.frozen.map((u) => offer(u.grams))];
      const cost = (xs) => xs.reduce((a, o) => a + (o?.cost ?? Infinity), 0);
      if (mergeOffers(sep) && cost(sep) <= cost(parts) + 0.3) parts = sep;
    }
    const days = [...lot.chunks.flatMap((ch) => ch.uses.map((u) => u.day)), ...lot.frozen.map((u) => u.day)];
    const first = Math.min(...days);
    return { buy: lot.buy, late: lot.late, grams, offer: mergeOffers(parts) || offer(grams), freeze: lot.frozen.map((u) => ({ day: u.day, grams: u.grams, meal: mealOf(u.day) })),
      first: { day: first, meal: mealOf(first) }, last: Math.max(...days), closed: r.closed };
  });
}
const MEAL_ORDER = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };
