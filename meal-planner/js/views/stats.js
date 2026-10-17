import { h, eur, num, plural, icon } from '../ui.js';
import { state, targets } from '../state.js';
import { daySums, effectivePlan } from '../core/planner.js';
import { dayShort, dayName, dayDate } from '../core/calendar.js';
import { buildShoppingList, consumedPlanCost } from '../core/shopping.js';
import { checkoutNow, weekBudget } from './money.js';

export function renderStats(root) {
  root.append(h('div', { class: 'row', style: { marginBottom: '6px' } }, h('a', { class: 'btn icon ghost', href: '#/plan', 'aria-label': 'К плану' }, icon('back'))));
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Итоги недели')));
  if (!state.plan?.batches?.length) {
    root.append(h('p', null, 'Пока нет плана. ', h('a', { href: '#/plan' }, 'Составить →')));
    return;
  }
  const t = targets();
  const plan = effectivePlan(state.plan); // съеденное — без пропущенного и «вне дома»
  const opts = { stores: state.prefs.stores };
  const list = buildShoppingList(plan, state.recipeMap, state.data.products, opts);
  const week = checkoutNow(plan, 'week'); // та же сумма, что на Плане и в Покупках
  const consumed = consumedPlanCost(plan, state.recipeMap, state.data.products, opts);
  const consumedMain = consumedPlanCost(plan, state.recipeMap, state.data.products, { ...opts, only: 'main' });
  const meals = plan.batches.reduce((a, b) => a + b.slots.length, 0);
  const hasExtras = (plan.extras || []).length > 0;
  const sums = daySums(plan, state.recipeMap);
  // цель для сравнения: вся норма, если завтраки в плане, иначе доля на обед + ужин
  const goal = hasExtras ? { kcal: t.kcal, protein: t.protein } : t.plannedDay;
  const avg = (k) => sums.reduce((a, s) => a + s[k], 0) / 7;
  const budget = weekBudget(plan);

  root.append(h('div', { class: 'kpis' },
    kpi(eur(week.toPay), 'к оплате за неделю (как в Покупках)'),
    kpi(eur(consumed), 'стоимость съеденного'),
    kpi(meals ? eur(consumedMain / meals) : '—', `средняя цена обеда или ужина`),
    kpi(eur(Math.abs(budget - week.toPay)), budget >= week.toPay ? 'остаток бюджета недели' : 'перерасход бюджета')));
  const receipts = Object.values(state.plan.receipts || {});
  const skipped = Object.keys(state.plan.skips || {}).length;
  if (receipts.length || skipped) root.append(h('p', { class: 'notice', style: { marginTop: '10px' } },
    receipts.length ? `По чекам потрачено ${eur(receipts.reduce((a, v) => a + v, 0))} (${receipts.length} ${plural(receipts.length, 'поход', 'похода', 'походов')}). ` : '',
    skipped ? `Без ${skipped} ${plural(skipped, 'пропущенного приёма', 'пропущенных приёмов', 'пропущенных приёмов')} пищи — они не считаются съеденными.` : ''));
  root.append(h('p', { class: 'muted', style: { marginTop: '10px' } },
    `Это расчёт по плану. Остатки упаковок после недели стоят ≈ ${eur(Math.max(0, list.total - list.items.reduce((a, i) => a + i.consumedCost, 0)))} — они пригодятся на следующей неделе. `,
    week.ownTotal > 0 ? `Ваши товары вне плана (${eur(week.ownTotal)}) входят в сумму к оплате. ` : '',
    `Базовые продукты (масло, специи) не входят в сумму покупок, но входят в стоимость съеденного по доле.`));

  root.append(h('h2', null, hasExtras ? 'Калории и белок по дням (все приёмы пищи)' : 'Калории и белок по дням (обед + ужин)'));
  root.append(h('div', { class: 'legend' },
    h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'ккал'),
    h('span', null, h('i', { style: { background: '#3b7fc4' } }), 'белок'),
    h('span', null, hasExtras ? `черта — дневная норма: ${num(goal.kcal)} ккал и ${num(goal.protein)} г белка` : `черта — цель на обед + ужин: ${num(goal.kcal)} ккал и ${num(goal.protein)} г белка (${Math.round(t.mealShare * 100)}% дневной нормы)`)));
  const maxK = Math.max(goal.kcal * 1.3, ...sums.map((s) => s.kcal));
  const maxP = Math.max(goal.protein * 1.3, ...sums.map((s) => s.protein));
  root.append(h('div', { class: 'card' }, sums.map((s, i) => h('div', null,
    h('div', { class: 'day-stat' }, h('b', null, dayShort(plan, i)), bar(s.kcal / maxK, goal.kcal / maxK, ''), h('span', { class: 'muted' }, `${num(s.kcal)} ккал`)),
    h('div', { class: 'day-stat', style: { marginTop: '-4px' } }, h('span'), bar(s.protein / maxP, goal.protein / maxP, 'protein'), h('span', { class: 'muted' }, `${num(s.protein)} г`))))));

  root.append(h('h2', null, 'КБЖУ по дням'));
  root.append(h('div', { class: 'card', tabindex: '0', 'aria-label': 'КБЖУ по дням, таблица', style: { overflowX: 'auto' } }, h('table', { class: 'stats-table' },
    h('thead', null, h('tr', null, h('th', null, 'День'), h('th', { class: 'num' }, 'Ккал'), h('th', { class: 'num' }, 'Белки'), h('th', { class: 'num' }, 'Жиры'), h('th', { class: 'num' }, 'Углев.'), h('th', { class: 'num' }, 'Цена'))),
    h('tbody', null,
      sums.map((s, i) => h('tr', null, h('td', { class: 'nowrap' }, `${dayShort(plan, i)}, ${dayDate(plan, i).getDate()}`), h('td', { class: 'num' }, num(s.kcal)), h('td', { class: 'num' }, num(s.protein)), h('td', { class: 'num' }, num(s.fat)), h('td', { class: 'num' }, num(s.carbs)), h('td', { class: 'num' }, eur(s.cost)))),
      h('tr', null, h('td', null, h('b', null, 'Среднее')), h('td', { class: 'num' }, h('b', null, num(avg('kcal')))), h('td', { class: 'num' }, h('b', null, num(avg('protein')))), h('td', { class: 'num' }, num(avg('fat'))), h('td', { class: 'num' }, num(avg('carbs'))), h('td', { class: 'num' }, eur(avg('cost'))))))));

  if (hasExtras) {
    const bf = list.total - buildShoppingList(plan, state.recipeMap, state.data.products, { ...opts, only: 'main' }).total;
    root.append(h('h2', null, 'Завтраки и перекусы'));
    root.append(h('p', { class: 'muted' }, `В плане ${plan.extras.length} ${plural(plan.extras.length, 'завтрак или перекус', 'завтрака и перекуса', 'завтраков и перекусов')}. Они добавляют к покупкам ≈ ${eur(bf)} (резерв в профиле — ${eur(state.profile.reserve)}). Отключить можно в профиле.`));
    return;
  }
  const restK = t.kcal - avg('kcal');
  const restP = t.protein - avg('protein');
  root.append(h('h2', null, 'Что остаётся на завтрак и перекусы'));
  root.append(h('div', { class: 'card stack' },
    h('p', { style: { margin: 0 } }, `Дневная норма: ${num(t.kcal)} ккал и ${num(t.protein)} г белка. Обед и ужин дают в среднем ${num(avg('kcal'))} ккал и ${num(avg('protein'))} г.`),
    h('p', { style: { margin: 0 } }, restK > 0 || restP > 0
      ? `Остаётся ≈ ${num(Math.max(0, restK))} ккал и ${num(Math.max(0, restP))} г белка. Например: 250 г Magertopfen или Skyr (≈ 30 г белка), 3 яйца (≈ 19 г), хлеб с Hüttenkäse, банан и горсть орехов.`
      : 'Обед и ужин уже закрывают дневную норму.'),
    h('p', { class: 'muted', style: { margin: 0 } }, `На это заложен резерв ${eur(state.profile.reserve)} в неделю (меняется в профиле).`)));
}

function bar(v, target, cls) {
  return h('div', { class: 'bar ' + cls }, h('i', { style: { width: `${Math.min(100, v * 100)}%` } }), h('span', { class: 'target', style: { left: `${Math.min(100, target * 100)}%` } }));
}
function kpi(v, l) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}
