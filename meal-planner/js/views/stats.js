import { h, eur, num, plural, icon } from '../ui.js';
import { state, targets } from '../state.js';
import { daySums, effectivePlan, slotKey } from '../core/planner.js';
import { dayShort, dayName, dayDate } from '../core/calendar.js';
import { buildShoppingList, consumedPlanCost } from '../core/shopping.js';
import { checkoutNow, weekBudget, stockNow, plannedBought, planEvents } from './money.js';
import { currentStock, weekLedger, describeStock } from '../core/stock.js';

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

  // «по плану» и «фактически» — раздельно (S68): съеденное — только то, что отмечено «Съел / Приготовил»
  const done = state.plan.done || {};
  const eatenPlan = { ...plan,
    batches: plan.batches.map((b) => ({ ...b, slots: b.slots.filter((s) => done[slotKey(s.day, s.meal)]) })).filter((b) => b.slots.length),
    extras: (plan.extras || []).filter((x) => done[x.id]) };
  const eatenN = eatenPlan.batches.reduce((a, b) => a + b.slots.length, 0) + eatenPlan.extras.length;
  const eaten = eatenN ? consumedPlanCost(eatenPlan, state.recipeMap, state.data.products, opts) : 0;
  const eatenSums = daySums(eatenPlan, state.recipeMap);
  const sumOf = (xs, k) => xs.reduce((a, s) => a + s[k], 0);
  root.append(h('div', { class: 'kpis' },
    kpi(eur(week.toPay), 'всего за неделю — покупки (как на Плане)'),
    kpi(eur(Math.abs(budget - week.toPay)), budget >= week.toPay ? 'остаток бюджета недели' : 'перерасход бюджета'),
    kpi(eur(consumed), 'съесть по плану — стоимость блюд'),
    kpi(eatenN ? eur(eaten) : '—', eatenN ? `съедено по отметкам — ${eatenN} ${plural(eatenN, 'приём', 'приёма', 'приёмов')} пищи` : 'съедено: отметок «Съел / Приготовил» пока нет')));
  root.append(h('p', { class: 'muted', style: { marginTop: '8px' } },
    `Белок за неделю: по плану ${num(sumOf(sums, 'protein'))} г, по отметкам ${num(sumOf(eatenSums, 'protein'))} г (норма ${num(t.protein * 7)} г). `,
    meals ? `Обед или ужин по плану — в среднем ${eur(consumedMain / meals)}.` : ''));
  const receipts = Object.values(state.plan.receipts || {});
  const skipped = Object.keys(state.plan.skips || {}).length;
  if (receipts.length || skipped) root.append(h('p', { class: 'notice', style: { marginTop: '10px' } },
    receipts.length ? `По чекам потрачено ${eur(receipts.reduce((a, v) => a + v, 0))} (${receipts.length} ${plural(receipts.length, 'поход', 'похода', 'походов')}). ` : '',
    skipped ? `Без ${skipped} ${plural(skipped, 'пропущенного приёма', 'пропущенных приёмов', 'пропущенных приёмов')} пищи — они не считаются съеденными.` : ''));
  root.append(h('p', { class: 'muted', style: { marginTop: '10px' } },
    week.ownTotal > 0 ? `Ваши товары вне плана (${eur(week.ownTotal)}) входят в сумму к оплате. ` : '',
    `Базовые продукты (масло, специи) не входят в сумму покупок, но входят в стоимость съеденного по доле.`));
  productsBlock(root);
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

// Продукты недели (блок В): использовано / осталось / выброшено — по учёту запасов с вскрытием и порчей (core/stock.js),
// сейчас и к концу недели, если готовить по плану. Раньше здесь было «остатки упаковок ≈ €X пригодятся», а по симуляции
// за ту же неделю портилось больше, чем оставалось годным
function productsBlock(root) {
  const plan = state.plan;
  const products = state.data.products;
  const now = new Date();
  const end = dayDate(plan, 7);
  const anyBought = Object.values(state.checked[plan.id] || {}).some(Boolean);
  const cur = weekLedger(stockNow(now), products);
  const fc = weekLedger(currentStock({ pantry: state.pantry, events: planEvents(), bought: plannedBought(plan, now), now: Math.max(now.getTime(), end.getTime() - 1),
    storage: state.data.storage, products }), products);
  root.append(h('h2', null, 'Продукты недели: использовано, осталось, выброшено'));
  const line = (L, label) => h('div', { class: 'kpis' },
    kpi(L.usedPct == null ? '—' : `${L.usedPct} %`, `${label}: использовано — ${eur(L.tot.used)}`),
    kpi(eur(L.tot.left), 'осталось годным'),
    kpi(eur(L.tot.spoiled), L.tot.spoiled > 0.01 ? 'выброшено — испортилось' : 'выброшено — ничего'));
  if (anyBought) root.append(line(cur, 'сейчас'));
  else root.append(h('p', { class: 'muted', style: { margin: '0 0 6px' } }, 'Покупки в «Покупках» ещё не отмечены — ниже прогноз: всё куплено по списку в дни походов, готовка по плану.'));
  root.append(h('div', { class: 'eyebrow', style: { marginTop: '8px' } }, 'К концу недели, если готовить по плану'));
  root.append(line(fc, 'к концу недели'));
  const spoiledRows = fc.rows.filter((r) => r.spoiled > 1 && r.spoiledCost >= 0.2).sort((a, b) => b.spoiledCost - a.spoiledCost);
  const leftRows = fc.rows.filter((r) => r.left > 1).sort((a, b) => b.leftCost - a.leftCost);
  const fmtDay = (t) => (t ? fmtShort(new Date(t)) : '');
  if (spoiledRows.length) root.append(h('p', { class: 'notice', style: { marginTop: '8px' } }, h('b', null, 'Испортится: '),
    spoiledRows.slice(0, 6).map((r) => `${r.name.toLowerCase()} ${describeStock(r.key, r.spoiled, products[r.key]).replace(/^≈ /, '')} (${eur(r.spoiledCost)}, к ${fmtDay(r.spoiledAt)})`).join(', '),
    '. Что можно — заморозить заранее (советы — в Покупках) или поставить блюда с этим раньше.'));
  if (leftRows.length) root.append(h('p', { class: 'muted', style: { marginTop: '6px' } }, h('b', null, 'Останется на следующую неделю: '),
    leftRows.slice(0, 8).map((r) => `${r.name.toLowerCase()} ${describeStock(r.key, r.left, products[r.key]).replace(/^≈ /, '')}${r.frozen > 1 ? ' (в морозилке)' : r.exp && Number.isFinite(r.exp) && r.exp - end.getTime() < 14 * 86400000 ? ` — годно до ${fmtDay(r.exp - 1)}` : ''}`).join(', '),
    '. Это попадёт в запасы «Дома» и в план следующей недели.'));
}
const fmtShort = (d) => `${dayShortOf(d)}, ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayShortOf = (d) => ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()];

function bar(v, target, cls) {
  return h('div', { class: 'bar ' + cls }, h('i', { style: { width: `${Math.min(100, v * 100)}%` } }), h('span', { class: 'target', style: { left: `${Math.min(100, target * 100)}%` } }));
}
function kpi(v, l) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}
