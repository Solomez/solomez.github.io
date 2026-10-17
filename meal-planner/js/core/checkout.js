// Одна сумма «к оплате» для всех экранов (План, Покупки, Итоги, экспорт): список покупок → план походов
// (с доплатой за меньшее число магазинов, если выбран режим «экономить походы») → + свои товары вне плана.
// Раньше План и Покупки считали по самой дешёвой цене каждой позиции, а походы — по-своему, и суммы расходились (F01).
import { buildShoppingList, chooseOffer, round2 } from './shopping.js';
import { planTrips, buyAheadDays } from './trips.js';
import { remainingPlan, todayIndex, dayDate } from './calendar.js';
import { effectivePlan } from './planner.js';

// Режим покупок: 'money' — дешевле (до двух магазинов в день, без доплат), 'trips' — меньше походов (один магазин в день)
export const saveModeOf = (prefs) => (prefs?.saveMode === 'trips' ? 'trips' : 'money');

// Первый день, когда продукт нужен (день готовки блюда)
export function firstNeededDay(plan, recipeMap) {
  const out = {};
  const cooks = [...plan.batches.map((b) => ({ id: b.recipeId, day: Math.min(...b.slots.map((s) => s.day)) })),
    ...(plan.extras || []).map((x) => ({ id: x.recipeId, day: x.day }))];
  for (const c of cooks) for (const i of recipeMap.get(c.id)?.ingredients || []) out[i.key] = Math.min(out[i.key] ?? 99, c.day);
  return out;
}

// Последний день, когда можно успеть купить: к завтраку и обеду — накануне, к перекусу и ужину — в тот же день
export function lastBuyDay(plan, recipeMap) {
  const out = {};
  const cooks = [...plan.batches.map((b) => ({ id: b.recipeId, slot: b.slots[0] })), ...(plan.extras || []).map((x) => ({ id: x.recipeId, slot: x }))];
  for (const c of cooks) {
    const d = c.slot.day - (c.slot.meal === 'breakfast' || c.slot.meal === 'lunch' ? 1 : 0);
    for (const i of recipeMap.get(c.id)?.ingredients || []) out[i.key] = Math.min(out[i.key] ?? 99, d);
  }
  return out;
}

// Магазины работают примерно до 19:30, в субботу — до 18:00: вечером первый поход переносится на завтра
export function firstShopDay(plan, now) {
  return todayIndex(plan, now) + (now.getHours() >= (now.getDay() === 6 ? 17 : 19) ? 1 : 0);
}

export const ownCost = (c) => round2((c.price || 0) * (c.byWeight ? 1 : c.qty || 1));

// «Взял другое вместо»: в сумме — цена взятого (столько же упаковок; развесное — одна), а не исходного товара (P1, P5 — S11)
export const swapCost = (swap, offer) => (swap?.price > 0 && offer ? round2(swap.price * (offer.pack?.loose ? 1 : offer.count || 1)) : null);

/**
 * ctx: { recipeMap, products, storage, prefs, home, unavailable: Set, cart: [], checked: {}, swaps: {}, now: Date, scope: 'rest' | 'week' }
 * Возвращает { list, listPlan, trips, extra, planTotal, own, ownTotal, toPay, left, bought, byStore, basicsTotal }:
 * toPay — всего к оплате за период (походы + свои товары), left — ещё не куплено, byStore — только магазины из походов.
 */
export function checkout(plan, ctx) {
  const now = ctx.now || new Date();
  const scope = ctx.scope || 'rest';
  const base = effectivePlan(plan, ['out']); // «ем вне дома» не покупаем; под прошедшее «не ел» продукты уже куплены
  const listPlan = scope === 'week' ? base : remainingPlan(base, now);
  const list = buildShoppingList(listPlan, ctx.recipeMap, ctx.products, { stores: ctx.prefs?.stores, home: ctx.home, unavailable: ctx.unavailable });
  const trips = tripsFor(list, listPlan, plan, now, ctx);
  const offerOf = new Map(list.items.map((i) => [i.key, i.offer]));
  for (const t of trips) for (const it of t.items) {
    const c = swapCost(ctx.swaps?.[it.key], offerOf.get(it.key));
    if (c == null) continue;
    t.total = round2(t.total - (it.cost || 0) + c);
    it.cost = c;
    it.swapped = true;
  }
  const extra = round2(trips.reduce((a, t) => a + t.items.reduce((b, i) => b + (i.extra || 0), 0), 0));
  const planTotal = round2(trips.reduce((a, t) => a + t.total, 0));
  // свои товары: ещё не купленные и купленные за время этого плана — купленное остаётся в сумме, как и товары плана
  const since = dayDate(plan, 0).getTime();
  const own = (ctx.cart || []).filter((c) => !c.done || (c.doneAt || 0) >= since);
  const ownTotal = round2(own.reduce((a, c) => a + ownCost(c), 0));
  const checked = ctx.checked || {};
  const bought = round2(trips.reduce((a, t) => a + t.items.filter((i) => checked[i.key]).reduce((b, i) => b + (i.cost || 0), 0), 0)
    + own.filter((c) => c.done).reduce((a, c) => a + ownCost(c), 0));
  const byStore = {};
  for (const t of trips) {
    const s = (byStore[t.store] = byStore[t.store] || { total: 0, count: 0 });
    s.total = round2(s.total + t.total);
    s.count += t.items.length;
  }
  for (const c of own) {
    const s = (byStore[c.store] = byStore[c.store] || { total: 0, count: 0 });
    s.total = round2(s.total + ownCost(c));
    s.count += 1;
  }
  const toPay = round2(planTotal + ownTotal);
  return { list, listPlan, trips, extra, planTotal, own, ownTotal, toPay, bought, left: round2(toPay - bought), byStore, basicsTotal: list.basicsTotal };
}

// План походов по списку покупок (логика прежняя — из экрана Покупок; режим «деньги» разрешает два магазина в день)
export function tripsFor(list, listPlan, plan, now, ctx) {
  const items = list.items.filter((i) => i.offer);
  if (!items.length) return [];
  const need = lastBuyDay(listPlan, ctx.recipeMap);
  const firstDay = firstShopDay(plan, now);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const money = saveModeOf(ctx.prefs) === 'money';
  const altCost = (key, store) => {
    if (ctx.unavailable?.has(`${store}|${key}`)) return null; // там этого не оказалось на полке
    const packs = (ctx.products[key]?.packs || []).filter((p) => p.store === store && !p.stale);
    return packs.length ? chooseOffer({ packs }, byKey.get(key).needGrams).cost : null;
  };
  const storage = ctx.storage || {};
  const trips = planTrips(items.map((i) => ({ key: i.key, store: i.offer.pack.store, cost: i.offer.cost })), {
    needDay: (k) => need[k] ?? firstDay,
    aheadOf: (k) => buyAheadDays(k, storage),
    firstDay,
    dateOf: (d) => dayDate(plan, d),
    // «дешевле» — без доплат: товар не перекладывается в другой магазин дороже (лучше третий магазин в день, чем доплата)
    altCost: money ? () => null : altCost,
    canFreeze: (k) => { const st = storage[k]; return !!st && st.place === 'fridge' && /нижняя/.test(st.shelf || '') && /^да/.test(st.freeze || ''); },
    maxStoresPerDay: money ? 2 : 1,
    maxExtra: money ? 0 : 2,
  });
  // пометка «поздно»: поход позже, чем продукт нужен. К обеду и ужину можно купить утром того же дня (P2: к обеду вторника —
  // во вторничном походе), к завтраку — только накануне (магазины ещё закрыты)
  const late = {};
  const cooks = [...listPlan.batches.map((b) => ({ id: b.recipeId, slot: b.slots[0] })), ...(listPlan.extras || []).map((x) => ({ id: x.recipeId, slot: x }))];
  for (const c of cooks) {
    const by = c.slot.day - (c.slot.meal === 'breakfast' ? 1 : 0);
    for (const i of ctx.recipeMap.get(c.id)?.ingredients || []) if (late[i.key] == null || by < late[i.key].by) late[i.key] = { by, day: c.slot.day };
  }
  for (const t of trips) for (const it of t.items) if (late[it.key] && late[it.key].by < t.day && it.lateFor == null) it.lateFor = late[it.key].day;
  return trips;
}
