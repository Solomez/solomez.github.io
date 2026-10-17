// Одна и та же сумма на всех экранах: checkout() с текущими настройками, запасами «дома», «нет на полке» и своими товарами.
import { state } from '../state.js';
import { checkout } from '../core/checkout.js';
import { homeMap } from './catalog.js';

// «Нет на полке» помним 3 недели
// Если в этом же магазине взяли замену — товар в этой неделе остаётся в его походе (P5: после замены он уезжал в другой магазин),
// а «нет на полке» продолжает действовать для следующих недель
export const unavailableSet = (plan = state.plan) => {
  const swaps = state.swaps?.[plan?.id] || {};
  const tookHere = new Set(Object.entries(swaps).map(([key, s]) => `${s.here || s.store}|${key}`));
  return new Set(Object.keys(state.unavailable).filter((k) => Date.now() - state.unavailable[k] < 21 * 86400000 && !tookHere.has(k)));
};

export function checkoutNow(plan = state.plan, scope = 'rest', now = new Date(), prefs = state.prefs) {
  return checkout(plan, {
    recipeMap: state.recipeMap, products: state.data.products, storage: state.data.storage, prefs,
    home: homeMap(), unavailable: unavailableSet(plan), cart: state.cart, checked: state.checked[plan.id] || {}, swaps: state.swaps?.[plan.id] || {}, now, scope,
  });
}

// Бюджет, с которым сравниваем неделю: весь, если завтраки и перекусы в плане, иначе — за вычетом резерва на них
export const weekBudget = (plan = state.plan) => ((plan?.extras || []).length ? state.profile.budget : state.profile.budget - state.profile.reserve);
