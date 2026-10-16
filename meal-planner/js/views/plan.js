import { h, eur, num, icon, toast, sheet, copyText, download, meter } from '../ui.js';
import { state, save, targets, IS_ARTIFACT } from '../state.js';
import { generatePlan, alternatives, swapBatch, planDays, daySums, MEALS, extraAlternatives, swapExtra } from '../core/planner.js';
import { dayName, dayShort, dayDate, todayIndex, mealPast, startOptions, defaultStart, fmtDate, isoDate, planFinished, remainingPlan } from '../core/calendar.js';
import { buildShoppingList, consumedPlanCost } from '../core/shopping.js';
import { planToText } from '../core/export.js';

// Настройки, от которых зависит план: если они изменились, план устарел
function settingsKey() {
  const p = state.profile;
  const pr = state.prefs;
  return JSON.stringify([p.sex, p.age, p.height, p.weight, p.activity, p.goal, p.surplusPct, p.proteinPerKg, p.mealShare, p.budget, p.reserve,
    pr.maxRepeats, pr.batchCooking, pr.showBorderline, pr.planBreakfast, [...(pr.excludedKeys || [])].sort(), [...(pr.hidden || [])].sort(),
    state.data?.meta?.generated]);
}

const ui = { day: null, mode: 'day', prevPlan: null };
const clampDay = (i) => Math.max(0, Math.min(6, i));

// С какого дня начать: сегодня / завтра / с понедельника
function askStart(rerender, opts = {}) {
  let close;
  const now = new Date();
  const def = isoDate(defaultStart(now));
  close = sheet('С какого дня начать неделю?', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'План на 7 дней. Список покупок покажет только то, что ещё предстоит приготовить.'),
    h('div', { class: 'start-opts' }, startOptions(now).map((o) => h('button', {
      class: 'btn' + (isoDate(o.date) === def ? ' primary' : ''),
      onclick: () => { close(); regenerate(rerender, { ...opts, startDate: isoDate(o.date) }); },
    }, `${o.label} · ${fmtDate(o.date)}`)))));
}

export function regenerate(rerender, { withUndo = true, startDate } = {}) {
  const { recipes, products } = state.data;
  const prev = state.plan;
  state.plan = generatePlan({
    recipes, products, targets: targets(), prefs: state.prefs,
    budget: state.profile.budget, reserve: state.profile.reserve, seed: (Date.now() % 1e9) | 0,
  });
  state.plan.startDate = startDate || isoDate(defaultStart());
  state.plan.settingsKey = settingsKey();
  ui.day = null;
  state.altCursor = {};
  save();
  rerender();
  if (withUndo && prev?.batches?.length) {
    ui.prevPlan = prev;
    toast('Составлена новая неделя', { label: 'Отменить', onClick: () => { state.plan = ui.prevPlan; ui.prevPlan = null; save(); rerender(); } });
  }
}

function doSwap(batchId, recipe, rerender) {
  const prev = state.plan;
  state.plan = swapBatch(state.plan, batchId, recipe, targets());
  save();
  rerender({ keepScroll: true });
  const both = state.plan.batches.find((b) => b.id === batchId)?.slots.length > 1;
  toast(`${recipe.title}${both ? ' — ужин и обед на следующий день' : ''}`, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
}

// Одна кнопка: следующее похожее блюдо из списка альтернатив
function quickSwap(batchId, rerender) {
  const alts = alternatives(state.plan, batchId, { recipes: state.data.recipes, products: state.data.products, targets: targets(), prefs: state.prefs });
  if (!alts.length) return toast('Нет подходящих замен');
  const i = (state.altCursor[batchId] || 0) % alts.length;
  state.altCursor[batchId] = i + 1;
  doSwap(batchId, alts[i].recipe, rerender);
}

function mealMenu(e, rerender) {
  const r = e.recipe;
  let close;
  const alts = e.batch
    ? alternatives(state.plan, e.batch.id, { recipes: state.data.recipes, products: state.data.products, targets: targets(), prefs: state.prefs, limit: 12 })
    : extraAlternatives(state.plan, e.extra.id, { recipes: state.data.recipes, prefs: state.prefs }).slice(0, 12).map((x) => ({ recipe: x, factor: e.factor, deltaCost: null }));
  const content = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `#/recipe/${r.id}?f=${e.factor}&p=${e.portions}`, onclick: () => close() }, 'Открыть рецепт'),
      !e.leftover && h('a', { class: 'btn primary', href: `#/cook/${r.id}?f=${e.factor}&p=${e.portions}`, onclick: () => close() }, icon('pot'), 'Готовить')),
    h('div', null,
      h('div', { class: 'eyebrow' }, 'Заменить на'),
      alts.map((a) => h('button', { class: 'alt', onclick: () => {
        close();
        if (e.batch) doSwap(e.batch.id, a.recipe, rerender);
        else { const prev = state.plan; state.plan = swapExtra(state.plan, e.extra.id, a.recipe); save(); rerender({ keepScroll: true }); toast(a.recipe.title, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } }); }
      } },
        h('span', { class: 'alt-main' },
          h('span', { class: 'alt-title' }, a.recipe.title),
          h('span', { class: 'muted' }, `${a.recipe.time.active} мин · ${num(a.recipe.per_serving.protein * a.factor)} г белка · ${num(a.recipe.per_serving.kcal * a.factor)} ккал`)),
        a.deltaCost != null ? h('span', { class: 'muted nowrap' }, (a.deltaCost >= 0 ? '+' : '−') + eur(Math.abs(a.deltaCost))) : null))),
    e.batch ? h('p', { class: 'muted', style: { margin: 0 } }, 'Справа — насколько изменится сумма покупок за неделю.') : null);
  close = sheet(MEALS[e.meal] + ': ' + r.title, content);
}

function quickSwapExtra(e, rerender) {
  const alts = extraAlternatives(state.plan, e.extra.id, { recipes: state.data.recipes, prefs: state.prefs });
  if (!alts.length) return toast('Нет других вариантов');
  const i = (state.altCursor[e.extra.id] || 0) % alts.length;
  state.altCursor[e.extra.id] = i + 1;
  const prev = state.plan;
  state.plan = swapExtra(state.plan, e.extra.id, alts[i]);
  save();
  rerender({ keepScroll: true });
  toast(alts[i].title, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
}

function exportPlan() {
  const text = planToText(state.plan, state.recipeMap);
  let close;
  close = sheet('Экспорт плана', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Текст для заметок и мессенджеров.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { copyText(text); close(); } }, 'Скопировать'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('plan.txt', text) }, 'Скачать .txt'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => { close(); ui.mode = 'week'; window.dispatchEvent(new Event('hashchange')); setTimeout(() => window.print(), 150); } }, 'Печать')),
    h('textarea', { class: 'export-text', id: 'export-plan', readonly: true, rows: 10, 'aria-label': 'Текст плана', onfocus: (e) => e.target.select() }, text)));
}

export function renderPlan(root, rerender) {
  const t = targets();
  const plan = state.plan;
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'План'),
    plan?.batches?.length ? h('div', { class: 'row no-print', style: { flexWrap: 'nowrap' } },
      h('button', { class: 'btn icon ghost', 'aria-label': 'Экспорт плана', title: 'Экспорт', onclick: exportPlan }, icon('share')),
      h('button', { class: 'btn', onclick: () => askStart(rerender) }, icon('refresh'), 'Новая неделя')) : null));

  if (!t.complete) {
    root.append(h('p', { class: 'notice' }, 'Профиль не заполнен, поэтому порции посчитаны для среднего мужчины 178 см / 72 кг. ',
      h('a', { href: '#/profile' }, 'Заполнить профиль')));
  }

  if (!plan || !plan.batches.length) {
    root.append(h('section', { class: 'empty' },
      h('h2', null, 'Составим рацион на неделю'),
      h('p', null, `Завтрак, обед, ужин и перекусы на 7 дней. Порции подбираются под вашу цель: ${num(t.kcal)} ккал и ${num(t.protein)} г белка в день.`),
      h('p', { class: 'muted' }, state.prefs.batchCooking
        ? 'Ужин готовится сразу на 2 порции, вторая — обед следующего дня: 8 готовок вместо 14.'
        : 'Каждый обед и ужин готовится отдельно: 14 готовок.'),
      h('button', { class: 'btn primary', onclick: () => askStart(rerender, { withUndo: false }) }, 'Составить неделю')));
    return;
  }

  // Устаревший план: профиль, ограничения или цены изменились после генерации
  if (plan.settingsKey && plan.settingsKey !== settingsKey()) {
    root.append(h('p', { class: 'notice row between' },
      h('span', null, 'Профиль, ограничения или цены изменились после составления плана.'),
      h('button', { class: 'btn small', onclick: () => askStart(rerender) }, 'Пересчитать неделю')));
  }
  const now = new Date();
  if (planFinished(plan, now)) {
    root.append(h('p', { class: 'notice row between' },
      h('span', null, `План на ${fmtDate(dayDate(plan, 0))} – ${fmtDate(dayDate(plan, 6))} закончился.`),
      h('button', { class: 'btn small', onclick: () => askStart(rerender) }, 'Составить следующую неделю')));
  } else if (todayIndex(plan, now) < 0) {
    root.append(h('p', { class: 'muted', style: { marginTop: '12px' } }, `План начнётся ${fmtDate(dayDate(plan, 0))}.`));
  }

  // Сводка недели: бюджет — главное, остальное одной строкой
  const opts = { stores: state.prefs.stores };
  const hasExtras = (plan.extras || []).length > 0;
  const list = buildShoppingList(plan, state.recipeMap, state.data.products, opts);
  const consumedMain = consumedPlanCost(plan, state.recipeMap, state.data.products, { ...opts, only: 'main' });
  const budget = hasExtras ? state.profile.budget : state.profile.budget - state.profile.reserve;
  const over = list.total - budget;
  root.append(h('section', { class: 'summary' },
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'big' }, eur(list.total)), h('span', { class: 'muted' }, ` из ${eur(budget)} на неделю`)),
      h('a', { class: 'btn small', href: '#/shop' }, 'Покупки')),
    meter(list.total, budget, 'budget'),
    (() => {
      const left = buildShoppingList(remainingPlan(plan, new Date()), state.recipeMap, state.data.products, opts).total;
      return left < list.total - 0.01 ? h('div', { class: 'muted' }, `С учётом прошедших дней осталось купить ≈ ${eur(left)}.`) : null;
    })(),
    h('div', { class: 'muted' }, over > 0
      ? `Дороже бюджета на ${eur(over)} — замените дорогие блюда или составьте неделю заново.`
      : `${eur(consumedMain / 14)} за обед или ужин · цель ${num(t.kcal)} ккал и ${num(t.protein)} г белка в день`)));

  // Дни недели
  const days = planDays(plan, state.recipeMap);
  const sums = daySums(plan, state.recipeMap);
  const goal = hasExtras ? { kcal: t.kcal, protein: t.protein } : t.plannedDay;
  const today = todayIndex(plan, now);
  if (ui.day == null) ui.day = clampDay(today);
  root.append(h('div', { class: 'row between no-print', style: { marginTop: '18px' } },
    h('div', { class: 'daystrip', role: 'tablist', 'aria-label': 'Дни недели' }, days.map((_, i) => h('button', {
      role: 'tab', 'aria-selected': String(ui.mode === 'day' && ui.day === i), 'aria-label': `${dayName(plan, i)}, ${dayDate(plan, i).getDate()}`,
      class: 'daybtn' + (ui.mode === 'day' && ui.day === i ? ' on' : '') + (i === today ? ' today' : '') + (i < today ? ' past' : ''),
      onclick: () => { ui.day = i; ui.mode = 'day'; rerender({ keepScroll: true }); },
    }, h('span', { class: 'db-w' }, dayShort(plan, i)), h('span', { class: 'db-d' }, String(dayDate(plan, i).getDate()))))),
    h('button', { class: 'btn small ghost', 'aria-pressed': String(ui.mode === 'week'), onclick: () => { ui.mode = ui.mode === 'week' ? 'day' : 'week'; rerender({ keepScroll: true }); } },
      ui.mode === 'week' ? 'По дням' : 'Вся неделя')));

  const shown = ui.mode === 'week' ? days.map((_, i) => i) : [ui.day];
  for (const i of shown) {
    const d = days[i];
    const sec = h('section', { class: 'day' },
      h('div', { class: 'day-head' },
        h('h2', null, dayName(plan, i), h('span', { class: 'muted day-date' }, fmtDate(dayDate(plan, i)).split(', ')[1]),
          i === today ? h('span', { class: 'badge accent', style: { marginLeft: '8px' } }, 'сегодня') : null),
        h('div', { class: 'day-meters' },
          h('div', { class: 'dm' }, h('span', { class: 'muted' }, `${num(sums[i].kcal)} / ${num(goal.kcal)} ккал`), meter(sums[i].kcal, goal.kcal)),
          h('div', { class: 'dm' }, h('span', { class: 'muted' }, `${num(sums[i].protein)} / ${num(goal.protein)} г белка`), meter(sums[i].protein, goal.protein, 'protein')))));
    const entries = [
      d.breakfast && { ...d.breakfast, meal: 'breakfast' },
      d.lunch && { ...d.lunch, meal: 'lunch' },
      d.dinner && { ...d.dinner, meal: 'dinner' },
      ...d.snacks.map((x) => ({ ...x, meal: 'snack' })),
    ].filter((e) => e && e.recipe);
    for (const e of entries) sec.append(mealRow(e, rerender, mealPast(plan, i, e.meal, now)));
    root.append(sec);
  }
}

function mealRow(e, rerender, past) {
  const r = e.recipe;
  const ps = r.per_serving;
  const href = `#/recipe/${r.id}?f=${e.factor}&p=${e.portions}`;
  const note = past ? 'прошло' : e.leftover ? 'остаток вчерашнего ужина' : e.portions > 1 ? 'готовим 2 порции' : null;
  return h('div', { class: 'meal' + (e.leftover ? ' leftover' : '') + (past ? ' past' : '') },
    h('div', { class: 'when' }, MEALS[e.meal]),
    h('a', { class: 'meal-main', href },
      h('span', { class: 'title' }, r.title),
      h('span', { class: 'meta' },
        `${num(ps.protein * e.factor)}\u00a0г белка · ${num(ps.kcal * e.factor)}\u00a0ккал · ${eur(ps.cost * e.factor)}`,
        e.leftover ? '' : ` · ${r.time.active}\u00a0мин`),
      note || (r.tags || []).includes('спорное') ? h('span', { class: 'meal-tags' },
        note ? h('span', { class: 'badge' + (e.leftover || past ? '' : ' accent') }, note) : null,
        (r.tags || []).includes('спорное') ? h('span', { class: 'badge warn' }, 'спорное') : null) : null),
    h('div', { class: 'meal-actions no-print' },
      !e.leftover && e.batch ? h('a', { class: 'btn icon ghost', href: `#/cook/${r.id}?f=${e.factor}&p=${e.portions}`, 'aria-label': `Готовить: ${r.title}`, title: 'Готовить' }, icon('pot')) : null,
      h('button', { class: 'btn icon ghost', 'aria-label': `Заменить на похожее: ${r.title}`, title: 'Заменить на похожее',
        onclick: () => (e.batch ? quickSwap(e.batch.id, rerender) : quickSwapExtra(e, rerender)) }, icon('swap')),
      h('button', { class: 'btn icon ghost', 'aria-label': `Другие варианты: ${r.title}`, title: 'Другие варианты', onclick: () => mealMenu(e, rerender) }, icon('more'))));
}
