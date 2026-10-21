// Одна сумма «к оплате» для всех экранов (План, Покупки, Итоги, экспорт): список покупок → план походов
// (с доплатой за меньшее число магазинов, если выбран режим «экономить походы») → + свои товары вне плана.
// Раньше План и Покупки считали по самой дешёвой цене каждой позиции, а походы — по-своему, и суммы расходились (F01).
import { buildShoppingList, chooseOffer, round2 } from './shopping.js';
import { planTrips } from './trips.js';
import { buyAheadDays, canFreeze, closedDays } from './shelf.js';
import { purchaseLots, addUse } from './spoil.js';
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
  if (ctx.storage) attachLots(list, Math.max(0, firstShopDay(plan, now)), ctx);
  const trips = tripsFor(list, listPlan, plan, now, ctx);
  const offerOf = new Map(list.items.map((i) => [i.key, i.offer]));
  for (const t of trips) for (const it of t.items) {
    if (it.lot) continue; // «взял другое» — для первой покупки
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
  const bought = round2(trips.reduce((a, t) => a + t.items.filter((i) => checked[i.ckey || i.key]).reduce((b, i) => b + (i.cost || 0), 0), 0)
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

/**
 * Покупка по дням (блок В): у позиции списка — партии lots (core/spoil.js purchaseLots). Первая партия — в offer
 * (пачки «по вскрытию», порции «заморозить сразу» — freeze), партии второй закупки — lots[1..] со своей упаковкой и ценой
 * (скоропортящееся, которое нельзя заморозить: бананы, огурцы, помидоры, скир — докупить ближе к готовке).
 * Сумма списка пересчитывается. buyDay — день первой закупки.
 */
export function attachLots(list, buyDay, ctx) {
  for (const it of list.items) {
    const p = ctx.products[it.key];
    if (!p || it.basic || !it.offer) continue;
    let uses = [];
    for (const u of it.uses) if (u.day != null) uses = addUse(uses, u.day, u.grams);
    // приём пищи — для «купить накануне» (к завтраку и обеду)
    const meals = new Map();
    for (const u of it.uses) if (u.day != null && (!meals.has(u.day) || order(u.meal) < order(meals.get(u.day)))) meals.set(u.day, u.meal);
    uses = uses.map((u) => ({ ...u, meal: meals.get(u.day) }));
    const prod = withStores(p, ctx);
    const lots = purchaseLots(it.key, uses, prod, ctx.storage, { stores: ctx.prefs?.stores, buyDay, home: it.homeGrams || 0 });
    if (!lots.length || lots.some((l) => !l.offer)) continue;
    it.lots = lots;
    it.offer = lots[0].offer;
    it.needGrams = lots[0].grams;
  }
  list.total = round2(list.items.reduce((a, i) => a + (i.lots ? i.lots.reduce((b, l) => b + (l.offer?.cost || 0), 0) : i.offer?.cost || 0), 0));
}
const order = (m) => ({ breakfast: 0, lunch: 1, snack: 2, dinner: 3 })[m] ?? 3;
// «нет на полке» уже учтено в списке (withoutUnavailable) — упаковки берём из того же продукта
const withStores = (p, ctx) => {
  if (!ctx.unavailable?.size) return p;
  const packs = (p.packs || []).filter((x) => !ctx.unavailable.has(`${x.store}|${p.key}`));
  return packs.length ? { ...p, packs } : p;
};

// План походов по списку покупок (логика прежняя — из экрана Покупок; режим «деньги» разрешает два магазина в день)
export function tripsFor(list, listPlan, plan, now, ctx) {
  const listItems = list.items.filter((i) => i.offer);
  if (!listItems.length) return [];
  const need = lastBuyDay(listPlan, ctx.recipeMap);
  const firstDay = firstShopDay(plan, now);
  const byKey = new Map(listItems.map((i) => [i.key, i]));
  const money = saveModeOf(ctx.prefs) === 'money';
  const storage = ctx.storage || {};
  const altCost = (key, store, grams) => {
    if (ctx.unavailable?.has(`${store}|${key}`)) return null; // там этого не оказалось на полке
    const packs = (ctx.products[key]?.packs || []).filter((p) => p.store === store && !p.stale);
    return packs.length ? chooseOffer({ packs }, grams ?? byKey.get(key).needGrams).cost : null;
  };
  // позиции походов: первая партия продукта и партии второй закупки (ckey — ключ отметки «куплено»: «banana#1»)
  const items = [];
  for (const i of listItems) {
    const lots = i.lots || [{ offer: i.offer, grams: i.needGrams, freeze: [] }];
    lots.forEach((l, k) => {
      if (!l.offer) return;
      const lastBuy = l.first ? l.first.day - (l.first.meal === 'breakfast' || l.first.meal === 'lunch' ? 1 : 0) : null;
      items.push({ key: i.key, ckey: k ? `${i.key}#${k}` : i.key, lot: k, store: l.offer.pack.store, cost: l.offer.cost, offer: k ? l.offer : undefined, grams: l.grams,
        freezeUses: l.freeze || [], needDay: k ? lastBuy : undefined,
        // вторая закупка покрывает дни до последнего использования — купить не раньше, чем позволяет срок
        ahead: k ? Math.max(0, closedDays(i.key, storage) - (l.last - l.first.day)) : undefined });
    });
  }
  const trips = planTrips(items, {
    needDay: (k) => need[k] ?? firstDay,
    aheadOf: (k) => buyAheadDays(k, storage),
    firstDay,
    dateOf: (d) => dayDate(plan, d),
    // «дешевле» — без доплат: товар не перекладывается в другой магазин дороже (лучше третий магазин в день, чем доплата)
    altCost: money ? () => null : altCost,
    canFreeze: (k) => canFreeze(k, storage),
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
  for (const t of trips) for (const it of t.items) {
    if (!it.lot && late[it.key] && late[it.key].by < t.day && it.lateFor == null) it.lateFor = late[it.key].day;
    // «заморозь сразу» — от дня этого похода: что понадобится позже закрытого срока (порциями, по дням готовки)
    if (it.freezeUses?.length && it.freezeUntil == null) {
      const c = closedDays(it.key, storage);
      const fz = it.freezeUses.filter((u) => u.day > t.day + c);
      if (fz.length) it.freeze = fz.map((u) => ({ ...u }));
    }
    delete it.freezeUses;
  }
  return trips;
}
