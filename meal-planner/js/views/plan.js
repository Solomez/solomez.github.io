import { h, eur, num, icon, toast, sheet, copyText, download, meter, selectForCopy, seg } from '../ui.js';
import { state, save, targets, IS_ARTIFACT, toggleIn } from '../state.js';
import { missingTools } from '../core/equipment.js';
import { generatePlan, alternatives, swapBatch, planDays, daySums, MEALS, extraAlternatives, swapExtra, swapFactor, effectivePlan, skipOf, skipKeyOf, toggleSkip, moveBatch, refillPlan, canStore, dropRecipe } from '../core/planner.js';
import { dayName, dayShort, dayDate, todayIndex, mealPast, cookPast, startOptions, defaultStart, fmtDate, isoDate, planFinished } from '../core/calendar.js';
import { consumedPlanCost } from '../core/shopping.js';
import { checkoutNow, weekBudget } from './money.js';
import { planToText } from '../core/export.js';

// Чего из утвари нет (пустой список не меняет ключ — старые планы не считаются устаревшими)
const noTools = () => { const n = Object.entries(state.prefs.equipment || {}).filter(([k, v]) => v === false && k !== 'microwave').map(([k]) => k).sort(); return n.length ? [n] : []; };

// Настройки, от которых зависит план: если они изменились, план устарел
function settingsKey() {
  const p = state.profile;
  const pr = state.prefs;
  return JSON.stringify([p.sex, p.age, p.height, p.weight, p.activity, p.goal, p.surplusPct, p.proteinPerKg, p.mealShare, p.budget, p.reserve,
    pr.maxRepeats, pr.batchCooking, pr.showBorderline, pr.planBreakfast, [...(pr.excludedKeys || [])].sort(), [...(pr.hidden || [])].sort(),
    state.data?.meta?.generated, ...noTools()]);
}

const ui = { day: null, mode: 'day', prevPlan: null, note: null }; // note: { id, text } — что изменила последняя правка
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

export function regenerate(rerender, { withUndo = true, startDate, cheap = false } = {}) {
  const { recipes, products } = state.data;
  const prev = state.plan;
  state.plan = generatePlan({
    recipes, products, targets: targets(), prefs: state.prefs, cheap,
    budget: state.profile.budget, reserve: state.profile.reserve, seed: (Date.now() % 1e9) | 0,
  });
  state.plan.startDate = startDate || isoDate(defaultStart());
  state.plan.settingsKey = settingsKey();
  ui.day = null;
  save();
  rerender();
  if (withUndo && prev?.batches?.length) {
    ui.prevPlan = prev;
    toast('Составлена новая неделя', { label: 'Отменить', onClick: () => { state.plan = ui.prevPlan; ui.prevPlan = null; save(); rerender(); } });
  }
}

// Разница «к оплате за неделю» — та же сумма, что в шапке Плана (F04: раньше три разные цифры)
const weekDelta = (before, after) => checkoutNow(after, 'week').toPay - checkoutNow(before, 'week').toPay;
const signed = (d) => (Math.abs(d) < 0.005 ? '±€0' : (d > 0 ? '+' : '−') + eur(Math.abs(d)));

// «Досоставить оставшиеся дни»: прошедшее и правки вручную остаются (F21)
// Закреплено: уже приготовленное, сегодня и завтра (продукты под них могли быть уже куплены) — их «досоставить» не трогает
const lockedFor = (plan, now) => (d, m) => cookPast(plan, d, m, now) || d <= todayIndex(plan, now) + 1;

export function refill(rerender, { cheap = false } = {}) {
  const prev = state.plan;
  const now = new Date();
  const opts = { recipes: state.data.recipes, products: state.data.products, targets: targets(), prefs: state.prefs,
    budget: state.profile.budget, reserve: state.profile.reserve, isLocked: lockedFor(prev, now), isDone: (d, m) => cookPast(prev, d, m, now), cheap };
  const before = checkoutNow(prev, 'week').toPay;
  // несколько вариантов. «Дешевле» — самый дешёвый, и только если он правда дешевле текущего;
  // обычный — первый, что укладывается в бюджет, иначе самый дешёвый (P7: «досоставить» уводило неделю за бюджет)
  const budget = weekBudget(prev);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const cand = refillPlan(prev, { ...opts, seed: ((Date.now() % 1e9) + i * 7919) | 0 });
    const cost = checkoutNow(cand, 'week').toPay;
    const fits = cost <= budget;
    // «дешевле» — самый дешёвый; обычный — самый дешёвый из уложившихся в бюджет, иначе самый дешёвый вообще
    if (!best || (cheap || fits === best.fits ? cost < best.cost : fits)) best = { plan: cand, cost, fits };
  }
  if (cheap && best.cost >= before - 0.5) { prev.cheapTried = true; save(); rerender({ keepScroll: true }); toast('Дешевле с той же нормой белка не нашлось — оставил как есть'); return; }
  state.plan = best.plan;
  state.plan.settingsKey = settingsKey();
  save();
  rerender({ keepScroll: true });
  const d = best.cost - before;
  toast(`Оставшиеся дни подобраны заново: неделя ${signed(d)}. Сегодня, завтра и ваши замены — на месте, кроме блюд, которые теперь нельзя готовить`, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
}

// Перед новой неделей — что пропадёт (F21: раньше пересчёт молча стирал правки)
function confirmNew(rerender) {
  const plan = state.plan;
  const edits = (plan.edited || []).length;
  const marks = Object.keys(state.checked[plan.id] || {}).length;
  const skips = Object.keys(plan.skips || {}).length;
  const losses = [edits ? `ваши замены и переносы: ${edits}` : null, marks ? `отметки покупок: ${marks}` : null, skips ? `отметки «вне дома»: ${skips}` : null].filter(Boolean);
  if (!losses.length || planFinished(plan, new Date())) return askStart(rerender);
  let close;
  close = sheet('Составить новую неделю?', h('div', { class: 'stack' },
    h('p', { style: { margin: 0 } }, `Текущий план заменится целиком. Пропадут ${losses.join(', ')}.`),
    h('button', { class: 'btn primary', onclick: () => { close(); refill(rerender); } }, 'Досоставить оставшиеся дни — правки сохранятся'),
    h('button', { class: 'btn', onclick: () => { close(); askStart(rerender); } }, 'Всё равно новая неделя'),
    h('button', { class: 'btn ghost', onclick: () => close() }, 'Отмена')));
}

function doSwap(batchId, recipe, rerender) {
  const prev = state.plan;
  state.plan = swapBatch(state.plan, batchId, recipe, targets());
  const d = weekDelta(prev, state.plan);
  save();
  rerender({ keepScroll: true });
  const both = state.plan.batches.find((b) => b.id === batchId)?.slots.length > 1;
  const pOld = (state.recipeMap.get(prev.batches.find((b) => b.id === batchId)?.recipeId)?.per_serving.protein || 0) * (prev.batches.find((b) => b.id === batchId)?.factor || 1);
  const pNew = recipe.per_serving.protein * (state.plan.batches.find((b) => b.id === batchId)?.factor || 1);
  // «с сегодня» может меняться иначе, чем неделя: упаковки целые и делятся с другими днями (P3, P7 видели «противоречие»)
  const dRest = checkoutNow(state.plan, 'rest').toPay - checkoutNow(prev, 'rest').toPay;
  const restNote = Math.abs(dRest - d) > 0.3 ? ` (с сегодня ${signed(dRest)}: упаковки целые и общие с другими днями)` : '';
  ui.note = { plan: state.plan, id: batchId, text: `Заменено: неделя ${signed(d)}${restNote} · белок ${Math.round(pNew - pOld) >= 0 ? '+' : '−'}${Math.abs(Math.round(pNew - pOld))} г за приём` };
  rerender({ keepScroll: true });
  toast(`${recipe.title}${both ? ' — ужин и обед на следующий день' : ''} · неделя ${signed(d)}`, { label: 'Отменить', onClick: () => { state.plan = prev; ui.note = null; save(); rerender({ keepScroll: true }); } });
}

// «Заменить»: выбор из похожих блюд с разницей суммы и белка (раньше кнопка молча подставляла первое — P7)
function swapMenu(e, rerender) {
  const r = e.recipe;
  let close;
  const alts = (e.batch
    ? alternatives(state.plan, e.batch.id, { recipes: state.data.recipes, products: state.data.products, targets: targets(), prefs: state.prefs, limit: 8 })
      .map((a) => ({ ...a, deltaCost: weekDelta(state.plan, swapBatch(state.plan, e.batch.id, a.recipe, targets())) }))
    : extraAlternatives(state.plan, e.extra.id, { recipes: state.data.recipes, prefs: state.prefs }).slice(0, 8).map((x) => {
      const factor = swapFactor(state.recipeMap.get(e.extra.recipeId), e.extra.factor, x);
      return { recipe: x, factor, deltaCost: weekDelta(state.plan, swapExtra(state.plan, e.extra.id, x, state.recipeMap.get(e.extra.recipeId))) };
    }));
  if (!alts.length) return toast('Нет подходящих замен');
  const curP = r.per_serving.protein * e.factor;
  close = sheet(`Заменить: ${r.title}`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Справа — как изменится сумма к оплате за неделю. В скобках — белок за этот приём пищи.'),
    alts.map((a) => h('button', { class: 'alt', onclick: () => {
      close();
      if (e.batch) doSwap(e.batch.id, a.recipe, rerender);
      else { const prev = state.plan; state.plan = swapExtra(state.plan, e.extra.id, a.recipe, state.recipeMap.get(e.extra.recipeId)); const d = weekDelta(prev, state.plan); save(); rerender({ keepScroll: true }); toast(`${a.recipe.title} · неделя ${signed(d)}`, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } }); }
    } },
      h('span', { class: 'alt-main' },
        h('span', { class: 'alt-title' }, a.recipe.title),
        h('span', { class: 'muted' }, `${a.recipe.time.total} мин · ${num(a.recipe.per_serving.protein * a.factor)} г белка (${(() => { const d = Math.round(a.recipe.per_serving.protein * a.factor - curP); return d === 0 ? 'так же' : (d > 0 ? '+' : '−') + Math.abs(d) + ' г'; })()}) · ${num(a.recipe.per_serving.kcal * a.factor)} ккал`)),
      h('span', { class: 'muted nowrap' }, signed(a.deltaCost))))));
}

// «Ещё»: рецепт, готовка, этот приём пищи (вне дома, перенос), отношение к блюду (избранное, не предлагать)
function mealMenu(e, rerender) {
  const r = e.recipe;
  let close;
  const past = mealPast(state.plan, e.day, e.meal, new Date());
  const skip = skipOf(state.plan, skipKeyOf(e));
  const fav = (state.prefs.favorites || []).includes(r.id);
  const content = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `#/recipe/${r.id}?f=${e.factor}&p=${e.portions}`, onclick: () => close() }, 'Открыть рецепт'),
      !e.leftover && h('a', { class: 'btn primary', href: `#/cook/${r.id}?f=${e.factor}&p=${e.portions}`, onclick: () => close() }, icon('pot'), 'Готовить')),
    // факт и гибкость: «ем вне дома» (будущее) или «не ел / ел другое» (прошедшее), перенос ужина (F22, F05)
    h('div', { class: 'eyebrow' }, 'Этот приём пищи'),
    h('button', { class: 'btn', onclick: () => { close(); setSkip(e, past ? 'skipped' : 'out', rerender); } },
      skip ? (past ? 'Вернуть: ел по плану' : 'Вернуть в план') : (past ? 'Не ел это / ел другое' : 'Ем вне дома — не готовлю')),
    e.batch && !e.leftover && !past ? h('button', { class: 'btn', onclick: () => { close(); moveMenu(e, rerender); } }, 'Перенести на другой день') : null,
    h('div', { class: 'eyebrow', style: { marginTop: '8px' } }, 'Это блюдо'),
    h('button', { class: 'btn', onclick: () => {
      close();
      const on = toggleIn('favorites', r.id);
      toast(on ? 'В избранном — будет чаще в новых неделях' : 'Убрано из избранного', { label: 'Отменить', onClick: () => { toggleIn('favorites', r.id); rerender({ keepScroll: true }); } });
    } }, icon(fav ? 'starOn' : 'star'), fav ? 'Убрать из избранного' : 'В избранное'),
    h('button', { class: 'btn', onclick: () => { close(); dropFromPlan(r, rerender); } }, icon('eyeOff'), 'Не предлагать — и убрать из этой недели'));
  close = sheet(MEALS[e.meal] + ': ' + r.title, content);
}

// «Не предлагать» из плана действует сразу: ещё не приготовленные появления блюда заменяются (P7: блюдо оставалось в неделе)
function dropFromPlan(r, rerender) {
  const prev = state.plan;
  const prevHidden = [...(state.prefs.hidden || [])];
  // добавить, а не переключить: блюдо могло быть уже скрыто на странице рецепта
  state.prefs.hidden = [...new Set([...prevHidden, r.id])];
  const now = new Date();
  const res = dropRecipe(prev, r.id, { recipes: state.data.recipes, products: state.data.products, targets: targets(), prefs: state.prefs, isDone: (d, m) => cookPast(prev, d, m, now) });
  state.plan = res.plan;
  state.plan.settingsKey = settingsKey(); // план уже учитывает скрытое блюдо — без плашки «настройки изменились»
  const d = weekDelta(prev, state.plan);
  save();
  rerender({ keepScroll: true });
  toast(`«${r.title}» больше не предлагается${res.count ? `. Заменено в этой неделе: ${res.count} · неделя ${signed(d)}` : ''}${res.left ? `. Осталось ${res.left} — замен не нашлось, поменяйте вручную` : ''}`,
    { label: 'Отменить', onClick: () => { state.prefs.hidden = prevHidden; state.plan = prev; save(); rerender({ keepScroll: true }); } });
}

function setSkip(e, kind, rerender) {
  const prev = state.plan;
  state.plan = toggleSkip(state.plan, skipKeyOf(e), kind);
  const on = !!skipOf(state.plan, skipKeyOf(e));
  const d = weekDelta(prev, state.plan);
  save();
  rerender({ keepScroll: true });
  const money = Math.abs(d) < 0.01 ? 'сумма к оплате та же — нужны те же упаковки' : `покупки ${signed(d)}`;
  const msg = !on ? `Вернул в план · ${money}` : kind === 'out' ? `Едите вне дома — продукты под это не покупаются, ${money}` : 'Отмечено: не съедено — итоги это учтут';
  toast(msg, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
}

function moveMenu(e, rerender) {
  const now = new Date();
  const plan = state.plan;
  const rA = state.recipeMap.get(e.batch.recipeId);
  const targetsList = plan.batches.filter((b) => b.id !== e.batch.id && b.slots[0].meal === e.batch.slots[0].meal && !mealPast(plan, b.slots[0].day, b.slots[0].meal, now)
    && (b.slots.length < 2 || canStore(rA)) && (e.batch.slots.length < 2 || canStore(state.recipeMap.get(b.recipeId) || {})));
  let close;
  close = sheet(`Перенести «${e.recipe.title}»`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Блюда поменяются днями (вместе с обедом из второй порции).'),
    targetsList.map((b) => h('button', { class: 'alt', onclick: () => {
      close();
      const prev = state.plan;
      state.plan = moveBatch(plan, e.batch.id, b.slots[0].day);
      save(); rerender({ keepScroll: true });
      toast(`Перенесено на ${dayName(plan, b.slots[0].day).toLowerCase()}`, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
    } }, h('span', { class: 'alt-main' }, h('span', { class: 'alt-title' }, `${dayName(plan, b.slots[0].day)}, ${dayDate(plan, b.slots[0].day).getDate()}`),
      h('span', { class: 'muted' }, `сейчас: ${state.recipeMap.get(b.recipeId)?.title || '—'}`))))));
}

function exportPlan() {
  const text = planToText(state.plan, state.recipeMap);
  let close;
  close = sheet('Поделиться планом', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Текст для заметок и мессенджеров.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { if (await copyText(text)) close(); else selectForCopy('export-plan'); } }, 'Скопировать'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('plan.txt', text) }, 'Скачать .txt'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => { close(); ui.mode = 'week'; window.dispatchEvent(new Event('hashchange')); setTimeout(() => window.print(), 150); } }, 'Печать')),
    h('textarea', { class: 'export-text', id: 'export-plan', readonly: true, rows: 10, 'aria-label': 'Текст плана', onfocus: (e) => e.target.select() }, text)));
}

export function renderPlan(root, rerender) {
  const t = targets();
  const plan = state.plan;
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'План'),
    plan?.batches?.length ? h('div', { class: 'row no-print', style: { flexWrap: 'nowrap' } },
      h('a', { class: 'btn small', href: '#/stats' }, icon('chart'), 'Итоги'),
      h('button', { class: 'btn small', onclick: exportPlan }, icon('share'), 'Поделиться'),
      h('button', { class: 'btn', onclick: () => confirmNew(rerender) }, icon('refresh'), 'Новая неделя')) : null));

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
      h('button', { class: 'btn small', onclick: () => refill(rerender) }, 'Досоставить оставшиеся дни')));
  }
  const now = new Date();
  if (planFinished(plan, now)) {
    root.append(h('p', { class: 'notice row between' },
      h('span', null, `План на ${fmtDate(dayDate(plan, 0))} – ${fmtDate(dayDate(plan, 6))} закончился.`),
      h('button', { class: 'btn small', onclick: () => askStart(rerender) }, 'Составить следующую неделю')));
  } else if (todayIndex(plan, now) < 0) {
    root.append(h('p', { class: 'muted', style: { marginTop: '12px' } }, `План начнётся ${fmtDate(dayDate(plan, 0))}.`));
  }

  // Сводка недели: одна сумма «к оплате» — та же, что в Покупках и Итогах (походы + свои товары)
  const opts = { stores: state.prefs.stores };
  const hasExtras = (plan.extras || []).length > 0;
  const week = checkoutNow(plan, 'week', now);
  const rest = checkoutNow(plan, 'rest', now);
  const consumedMain = consumedPlanCost(plan, state.recipeMap, state.data.products, { ...opts, only: 'main' });
  const budget = weekBudget(plan);
  const over = week.toPay - budget;
  root.append(h('section', { class: 'summary' },
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'big' }, eur(week.toPay)), h('span', { class: 'muted' }, ` к оплате за неделю · бюджет ${eur(budget)}`)),
      h('a', { class: 'btn small', href: '#/shop' }, 'Покупки')),
    meter(week.toPay, budget, 'budget'),
    rest.toPay < week.toPay - 0.01 ? h('div', { class: 'muted' }, `С сегодняшнего дня — ${eur(rest.toPay)}${rest.bought > 0.01 ? `, из них уже куплено на ${eur(rest.bought)}` : ''} (как в Покупках, «Оставшееся»).`) : null,
    over > 0.01 && !plan.acceptOver ? overBudget(plan, over, rerender) : h('div', { class: 'muted' }, over > 0.01
      ? `Дороже бюджета на ${eur(over)} — вы решили оставить так.`
      : `${eur(consumedMain / 14)} за обед или ужин · цель ${num(t.kcal)} ккал и ${num(t.protein)} г белка в день`)));

  // Дни недели
  const days = planDays(plan, state.recipeMap);
  const sums = daySums(effectivePlan(plan), state.recipeMap);
  const goal = hasExtras ? { kcal: t.kcal, protein: t.protein } : t.plannedDay;
  const today = todayIndex(plan, now);
  if (ui.day == null) ui.day = clampDay(today);
  root.append(h('div', { class: 'row between no-print', style: { marginTop: '18px' } },
    h('div', { class: 'daystrip', role: 'tablist', 'aria-label': 'Дни недели' }, days.map((_, i) => h('button', {
      role: 'tab', 'aria-selected': String(ui.mode === 'day' && ui.day === i), 'aria-label': `${dayName(plan, i)}, ${dayDate(plan, i).getDate()}`,
      class: 'daybtn' + (ui.mode === 'day' && ui.day === i ? ' on' : '') + (i === today ? ' today' : '') + (i < today ? ' past' : ''),
      onclick: () => { ui.day = i; ui.mode = 'day'; ui.note = null; rerender({ keepScroll: true }); },
    }, h('span', { class: 'db-w' }, dayShort(plan, i)), h('span', { class: 'db-d' }, String(dayDate(plan, i).getDate()))))),
    seg([['day', 'День'], ['week', 'Неделя']], ui.mode, (v) => {
      ui.mode = v;
      rerender({ keepScroll: true });
      // раньше верх экрана не менялся и казалось, что кнопка не сработала (P5, P7): показываем начало списка дней
      if (v === 'week') setTimeout(() => document.getElementById(`day-${Math.max(0, todayIndex(plan, new Date()))}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
    })));
  if (ui.mode === 'week') root.append(h('p', { class: 'muted', style: { margin: '8px 0 0' } }, 'Вся неделя: 7 дней списком. Нажмите на день сверху, чтобы смотреть по одному.'));

  const shown = ui.mode === 'week' ? days.map((_, i) => i) : [ui.day];
  for (const i of shown) {
    const d = days[i];
    const sec = h('section', { class: 'day', id: `day-${i}` },
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
    const eff = new Map(effectivePlan(plan).batches.map((b) => [b.id, b]));
    for (const e of entries) {
      // после «ем вне дома» на ужин обед следующего дня — уже не остаток, а своя готовка на 1 порцию
      const b = e.batch && eff.get(e.batch.id);
      const real = b ? { ...e, leftover: !(b.slots[0].day === i && b.slots[0].meal === e.meal), portions: b.slots.length } : e;
      sec.append(mealRow({ ...real, day: i }, rerender, mealPast(plan, i, e.meal, now)));
    }
    root.append(sec);
  }
}

// Неделя дороже бюджета: сколько не хватает и что можно сделать. Белок не снижаем — это требование, а не настройка.
function overBudget(plan, over, rerender) {
  const raiseTo = Math.ceil(state.profile.budget + over);
  return h('div', { class: 'notice stack', style: { marginTop: '8px' } },
    h('p', { style: { margin: 0 } }, `Неделя дороже бюджета на ${eur(over)}.`, plan.cheapTried
      ? ' Дешевле с той же нормой белка подобрать не получилось: дешёвых блюд с таким белком в базе мало. Поднимите бюджет или оставьте так.' : ''),
    h('div', { class: 'row' },
      plan.cheapTried ? null : h('button', { class: 'btn small', onclick: () => refill(rerender, { cheap: true }) }, 'Подобрать дешевле'),
      h('button', { class: 'btn small', onclick: () => {
        state.profile.budget = raiseTo;
        state.profile.touched = [...new Set([...(state.profile.touched || []), 'budget'])];
        plan.settingsKey = settingsKey(); // план тот же — не помечаем его устаревшим
        save(); rerender({ keepScroll: true }); toast(`Бюджет — ${eur(raiseTo)} в неделю`);
      } }, `Поднять бюджет до ${eur(raiseTo)}`),
      h('button', { class: 'btn small ghost', onclick: () => { plan.acceptOver = true; save(); rerender({ keepScroll: true }); } }, 'Оставить так')));
}

function mealRow(e, rerender, past) {
  const r = e.recipe;
  const ps = r.per_serving;
  const href = `#/recipe/${r.id}?f=${e.factor}&p=${e.portions}`;
  const skip = skipOf(state.plan, skipKeyOf(e));
  const noTools = !past && !skip && !e.leftover ? missingTools(r, state.prefs.equipment) : [];
  const note = skip === 'out' ? 'ем вне дома' : skip === 'skipped' ? 'не съедено' : past ? 'прошло' : e.leftover ? 'остаток вчерашнего ужина' : e.portions > 1 ? 'готовим 2 порции' : e.batch && e.meal === 'lunch' && e.portions === 1 && e.batch.slots.length > 1 ? 'готовим 1 порцию' : null;
  // после следующей правки плана (другая версия) строка устаревает — UX-ревью: «Заменено: +€1,83» после отмены через «Не предлагать»
  const change = ui.note && ui.note.plan === state.plan && ui.note.id === (e.batch?.id || e.extra?.id) ? ui.note.text : null;
  return h('div', { class: 'meal' + (e.leftover ? ' leftover' : '') + (past || skip ? ' past' : '') },
    h('div', { class: 'when' }, MEALS[e.meal]),
    h('a', { class: 'meal-main', href },
      h('span', { class: 'title' }, r.title),
      h('span', { class: 'meta' },
        `${num(ps.protein * e.factor)}\u00a0г белка · ${num(ps.kcal * e.factor)}\u00a0ккал · ${eur(ps.cost * e.factor)}`,
        e.leftover ? '' : ` · ${r.time.total}\u00a0мин`),
      note || noTools.length || (r.tags || []).includes('спорное') ? h('span', { class: 'meal-tags' },
        note ? h('span', { class: 'badge' + (e.leftover || past ? '' : ' accent') }, note) : null,
        noTools.length ? h('span', { class: 'badge warn' }, `нет: ${noTools.join(', ').toLowerCase()} — замените`) : null,
        (r.tags || []).includes('спорное') ? h('span', { class: 'badge', title: 'Блюдо с необычным сочетанием — на любителя' }, 'необычное') : null) : null),
    change ? h('div', { class: 'freeze-note' }, change) : null,
    // действия с подписью: «Готовить» (у будущей готовки), «Заменить» и «Ещё»
    h('div', { class: 'meal-actions no-print' },
      e.batch && !e.leftover && !past && !skip ? h('a', { class: 'btn small', href: `#/cook/${r.id}?f=${e.factor}&p=${e.portions}` }, icon('pot'), 'Готовить') : null,
      past ? null : h('button', { class: 'btn small', 'aria-label': `Заменить: ${r.title}`, // прошедшее не заменяют (UX-ревью Н11)
        onclick: () => swapMenu(e, rerender) }, icon('swap'), 'Заменить'),
      h('button', { class: 'btn small', 'aria-label': `Ещё: ${r.title}`, onclick: () => mealMenu(e, rerender) }, icon('more'), 'Ещё')));
}
