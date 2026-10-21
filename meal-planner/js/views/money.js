// Одна и та же сумма на всех экранах: checkout() с текущими настройками, запасами «дома», «нет на полке» и своими товарами.
import { state } from '../state.js';
import { checkout } from '../core/checkout.js';
import { effectivePlan } from '../core/planner.js';
import { dayDate } from '../core/calendar.js';
import { cookEvents, currentStock, homeAt, stockGrams, expiringSoon } from '../core/stock.js';
import { homeMap } from './catalog.js';
import { thawWay } from '../core/shelf.js';

// «Нет на полке» помним 3 недели
// Если в этом же магазине взяли замену — товар в этой неделе остаётся в его походе (P5: после замены он уезжал в другой магазин),
// а «нет на полке» продолжает действовать для следующих недель
export const unavailableSet = (plan = state.plan) => {
  const swaps = state.swaps?.[plan?.id] || {};
  const tookHere = new Set(Object.entries(swaps).map(([key, s]) => `${s.here || s.store}|${key}`));
  return new Set(Object.keys(state.unavailable).filter((k) => Date.now() - state.unavailable[k] < 21 * 86400000 && !tookHere.has(k)));
};

// Готовки текущего плана по времени (без «ем вне дома» и «не ел») — из них учёт запасов вычитает приготовленное
export const planEvents = (plan = state.plan) => (plan?.batches ? cookEvents(effectivePlan(plan, ['out', 'skipped'], { cooked: true }), state.recipeMap) : []);

export function checkoutNow(plan = state.plan, scope = 'rest', now = new Date(), prefs = state.prefs) {
  // на оставшееся — то, что дома сейчас (отмеченное минус уже приготовленное); на всю неделю — как отмечено
  const home = scope === 'rest' ? homeAt(state.pantry, plan === state.plan ? planEvents(plan) : [], now.getTime()) : homeMap();
  return checkout(plan, {
    recipeMap: state.recipeMap, products: state.data.products, storage: state.data.storage, prefs,
    home, unavailable: unavailableSet(plan), cart: state.cart, checked: state.checked[plan.id] || {}, swaps: state.swaps?.[plan.id] || {}, now, scope,
  });
}

// Бюджет, с которым сравниваем неделю: весь, если завтраки и перекусы в плане, иначе — за вычетом резерва на них
export const weekBudget = (plan = state.plan) => ((plan?.extras || []).length ? state.profile.budget : state.profile.budget - state.profile.reserve);

// Что куплено по плану: отмеченные в Покупках позиции → { key: { grams, t } }. Отметка хранит время (старые — true:
// считаем, что куплено в первый день плана)
export function boughtNow(plan = state.plan, now = new Date()) {
  const out = new Map();
  const checked = plan ? state.checked[plan.id] || {} : {};
  if (!plan?.batches?.length || !Object.values(checked).some(Boolean)) return out;
  const ck = checkoutNow(plan, 'week', now);
  const start = dayDate(plan, 0).getTime();
  const byKey = new Map(ck.list.items.map((i) => [i.key, i]));
  // по позициям походов: первая покупка и партии второй закупки (отметка «banana#1»), с порциями «заморозить сразу»
  for (const t of ck.trips) for (const ti of t.items) {
    const c = checked[ti.ckey || ti.key];
    const offer = ti.offer || byKey.get(ti.key)?.offer;
    if (!c || !offer) continue;
    const at = typeof c === 'number' ? c : start;
    out.set(ti.key, [].concat(out.get(ti.key) || [], buyOf(plan, offer, at, ti)));
  }
  // отмечено, но в походах этой недели позиции уже нет (например, «Вся неделя» → «Оставшееся») — по списку
  for (const it of ck.list.items) {
    const c = checked[it.key];
    if (!c || !it.offer || out.has(it.key)) continue;
    out.set(it.key, buyOf(plan, it.offer, typeof c === 'number' ? c : start, {}));
  }
  return out;
}
// Покупка для учёта: упаковками (вскрытие и порча считаются по пачкам), замороженные порции — до дня разморозки
function buyOf(plan, offer, t, ti) {
  const thaw = (f) => { const way = thawWay(ti.key, state.data.storage); const d = dayDate(plan, way === 'fridge' ? f.day - 1 : f.day); d.setHours(way === 'fridge' ? 20 : 7, 0, 0, 0); return d.getTime(); };
  return { grams: offer.boughtGrams, t, packGrams: offer.pack.grams, loose: !!offer.pack.loose, cost: offer.cost,
    frozen: (ti.freezeUntil != null ? [{ day: ti.freezeUntil, grams: offer.boughtGrams }] : ti.freeze || []).map((f) => ({ grams: f.grams, until: thaw(f) })) };
}

// Покупки недели для прогноза «к концу недели по плану»: отмеченное купленным — как есть, остальное — в день своего похода
// (утром), с заморозкой, если её советуют (trip item freeze)
export function plannedBought(plan = state.plan, now = new Date()) {
  const out = boughtNow(plan, now);
  if (!plan?.batches?.length) return out;
  const ck = checkoutNow(plan, 'week', now);
  const checked = state.checked[plan.id] || {};
  const byKey = new Map(ck.list.items.map((i) => [i.key, i]));
  for (const t of ck.trips) for (const ti of t.items) {
    const ckey = ti.ckey || ti.key;
    if (checked[ckey]) continue;
    const it = byKey.get(ti.key);
    const offer = ti.offer || it?.offer;
    if (!offer) continue;
    const d = dayDate(plan, t.day);
    d.setHours(9, 0, 0, 0);
    out.set(ti.key, [].concat(out.get(ti.key) || [], buyOf(plan, offer, d.getTime(), ti)));
  }
  return out;
}

// Запасы сейчас: отмеченное дома + купленное − приготовленное (см. core/stock.js)
export function stockNow(now = new Date()) {
  return currentStock({ pantry: state.pantry, events: planEvents(), bought: boughtNow(state.plan, now), now: now.getTime(), storage: state.data.storage, products: state.data.products });
}
// Для подбора блюд: граммы (базовые — в наличии) и продукты, которые скоро испортятся
export function homeForPlanning(now = new Date()) {
  const stock = stockNow(now);
  return { stock, home: stockGrams(stock, state.data.products, state.pantry), expiring: expiringSoon(stock, state.data.storage, now.getTime()) };
}
