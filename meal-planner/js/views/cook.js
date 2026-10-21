import { h, icon, num, sheet, nb, toast, hasLayer, onBack, plural } from '../ui.js';
import { state, save, stepsSig, targets } from '../state.js';
import { ingredientList, portionParams, weekPacks, swapNotice } from './recipe.js';
import { stepText, stepSlots, stepUses, slotOf, ingredientMeasure, renderText } from '../core/cookbook.js';
import { readyBlock, checkPanel, doneWhenBlock, hasReadiness } from './ready.js';
import { heatLabel, timeLabel } from './recipe.js';
import { stepHints } from '../core/equipment.js';
import { stepTerms, heatTerms } from '../core/amounts.js';
import { fmtDate, todayIndex, MEALS_ORDER, dayName } from '../core/calendar.js';
import { toggleDone, doneOf, skipOf, MEALS, planDays, swapBatch, swapExtra } from '../core/planner.js';
import { timerKey, leftOf, clock, startTimer, pauseTimer, extendTimer, timersOf, agoText, dropRecipe } from '../core/timers.js';
import { onTick, ensureTicker, unlockSound } from './timerbar.js';

// Таймеры — в state.timers (core/timers.js): переживают перезагрузку, закрытие вкладки и уход с шага (S61).
// Общий отсчёт и сигнал — views/timerbar.js
let wakeLock = null;
let keyHandler = null;
// Повторное нажатие (мокрые руки, двойной тап) в пределах полсекунды — не второй шаг (S62).
// Время — вне перерисовок: второй тап попадает уже в новую кнопку «Дальше»
let lastNav = 0;
let undoLog = null; // отметка «приготовил» в плане с финального экрана — для «Отменить»
const joinRu = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : String(xs[0] ?? ''));
// начало текста — до конца первой фразы или N знаков
const peek = (t, max = 110) => { const x = String(t || '').trim(); const dot = x.search(/[.!?](\s|$)/); const cut = dot > 0 && dot < max ? x.slice(0, dot + 1) : x.length > max ? `${x.slice(0, max).replace(/\s+\S*$/, '')}…` : x; return cut; };
const once = (fn) => (...a) => { const now = Date.now(); if (now - lastNav < 500) return; lastNav = now; fn(...a); };

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* ignore */ }
}
// Экран снова виден (вернулись в приложение) — браузер уже снял блокировку сна, просим снова
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && location.hash.startsWith('#/cook/')) keepAwake();
  });
}

export function leaveCook() {
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  onTick(null);
  onBack(null);
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  // ушли из режима готовки, а таймер идёт — общий отсчёт продолжает следить, чтобы сигнал прозвучал
  ensureTicker();
}

// «Готово» в режиме готовки = отметка «приготовил» у этого блюда в плане (ближайшее к сегодня, ещё не отмеченное):
// продукты сразу списываются из запасов дома. Возвращает подпись для экрана завершения или null
function markCookedInPlan(recipeId) {
  const plan = state.plan;
  if (!plan?.batches?.length) return null;
  const today = todayIndex(plan, new Date());
  const cands = [
    ...plan.batches.map((b) => ({ day: b.slots[0].day, meal: b.slots[0].meal, key: `${b.slots[0].day}|${b.slots[0].meal}`, recipeId: b.recipeId })),
    ...(plan.extras || []).map((x) => ({ day: x.day, meal: x.meal, key: x.id, recipeId: x.recipeId })),
  ].filter((c) => c.recipeId === recipeId && !doneOf(plan, c.key) && !skipOf(plan, c.key) && Math.abs(c.day - today) <= 1)
    .sort((a, b) => Math.abs(a.day - today) - Math.abs(b.day - today) || (MEALS_ORDER[a.meal] ?? 9) - (MEALS_ORDER[b.meal] ?? 9));
  const c = cands[0];
  if (!c) return null;
  state.plan = toggleDone(plan, c.key);
  return { prev: plan, text: `${MEALS[c.meal]} ${c.day === today ? 'сегодня' : c.day < today ? 'вчера' : 'завтра'}` };
}

// Карточки продуктов шага (S57). Продукт с количеством в тексте — его доля на этот шаг. Продукт, который в шаге
// только назван: на шаге подготовки (нарезать) — всё количество; там, где его добавляют (винительный падеж: «выложи
// лук»), — один раз: подготовленный раньше — серой строкой «всё, что подготовил в шаге N», иначе — количество.
// Дальше (уже в сковороде) и в упоминаниях («с макаронами вода поднимется») — без карточки, чтобы не положить второй раз
const cardsCache = new WeakMap();
export function stepCards(r, kitchen, k) {
  let all = cardsCache.get(r);
  if (!all) {
    all = [];
    const prepAt = new Map();
    const added = new Set();
    const misePart = new Map();
    r.steps.forEach((s, j) => {
      const out = [];
      for (const u of stepUses(r, s, kitchen)) {
        const sid = u.ing;
        if (u.quantified) {
          out.push({ ing: u.ing, frac: u.frac, how: 'amount' });
          if (s.kind === 'mise') misePart.set(sid, j); else added.add(sid);
          continue;
        }
        if (s.kind === 'mise') continue;
        // подготовка: шаг подготовки или холодный шаг с этим продуктом (нарезать кубиками) — не «положить в посуду»
        if ((s.kind === 'prep' || (!s.heat && !s.oven && s.kind === 'step')) && s.ctx?.self && slotOf(r, s.ctx.self) === u.ing) {
          if (!prepAt.has(sid)) { prepAt.set(sid, j); out.push({ ing: u.ing, frac: 1, how: 'amount' }); }
          continue;
        }
        if (u.cas !== 'acc' || added.has(sid)) continue;
        added.add(sid);
        if (prepAt.has(sid)) out.push({ ing: u.ing, how: 'used', at: prepAt.get(sid) });
        else out.push({ ing: u.ing, frac: 1, how: 'amount', at: misePart.get(sid) });
      }
      all.push(out);
    });
    cardsCache.set(r, all);
  }
  return all[k] || [];
}

// Блюдо не из плана (или уже отмечено) — «Записать как ужин сегодня?»: вместо сегодняшнего приёма того же типа,
// ещё не отмеченного. → { label, apply() } или null
function logOffer(r) {
  const plan = state.plan;
  if (!plan?.batches?.length) return null;
  const today = todayIndex(plan, new Date());
  if (today < 0 || today > 6) return null;
  const days = planDays(plan, state.recipeMap);
  const d = days[today];
  const type = r.meal_type || 'main';
  const slots = type === 'main' ? [['dinner', d.dinner], ['lunch', d.lunch]] : type === 'breakfast' ? [['breakfast', d.breakfast]] : d.snacks.map((e) => ['snack', e]);
  for (const [meal, e] of slots) {
    if (!e?.recipe || e.leftover) continue;
    const key = e.batch ? `${e.batch.slots[0].day}|${e.batch.slots[0].meal}` : e.extra.id;
    if (doneOf(plan, key) || skipOf(plan, key)) continue;
    return {
      label: `Записать как ${MEALS[meal].toLowerCase()} сегодня (вместо «${e.recipe.title}»)`,
      apply: () => {
        const swapped = e.batch ? swapBatch(plan, e.batch.id, r, targets()) : swapExtra(plan, e.extra.id, r, e.recipe);
        state.plan = toggleDone(swapped, key);
        return { prev: plan, text: `${MEALS[meal]} сегодня` };
      },
    };
  }
  return null;
}

// Где остаток: по плану (вторая порция ужина — обед завтра) или в холодильник до даты (S59)
function leftoverLine(r, portions) {
  if (portions <= 1) return null;
  const rest = portions - 1;
  const what = rest === 1 ? 'Вторую порцию' : `Остальные ${rest} ${plural(rest, 'порцию', 'порции', 'порций')}`;
  const plan = state.plan;
  const b = plan?.batches?.find((x) => x.recipeId === r.id && x.slots.length > 1 && Math.abs(x.slots[0].day - todayIndex(plan, new Date())) <= 1);
  const days = r.storage?.fridge_days || 0;
  const until = days ? fmtDate(new Date(Date.now() + days * 86400000)) : null;
  if (b) {
    const s2 = b.slots[1];
    return `${what} остуди и убери в контейнер в холодильник — по плану это ${MEALS[s2.meal].toLowerCase()} ${s2.day === b.slots[0].day + 1 ? 'завтра' : dayName(plan, s2.day).toLowerCase()}${until ? `; съесть до ${until}` : ''}.`;
  }
  return until ? `${what} остуди (до 1–2 часов) и убери в контейнер в холодильник — съесть до ${until}.` : `${what} лучше съесть сразу — блюдо не для хранения.`;
}

// Финальный экран (S59): отдельно от последнего шага — «Готово», без «осталось»; выключить плиту и духовку;
// запись в план; где остаток; хранение. Таймер ещё идёт — «Ждём…» вместо финала
function finalScreen(r, portions, prog, { live, restart, rerender }) {
  if (live.length) {
    return h('div', { class: 'final-screen' },
      h('h2', null, 'Ждём…'),
      live.map(([, t]) => h('p', { class: 'final-wait' }, h('b', null, `${t.label}: `), t.ringing ? 'время вышло — проверь (кнопка выше)' : `ещё ${clock(leftOf(t))}`, t.action ? ` — потом ${t.action}` : '')),
      h('p', { class: 'muted' }, 'Когда таймер прозвенит — проверь и нажми «Сделал» или «Готово ✓»; тогда блюдо готово.'));
  }
  const heat = (r.steps || []).some((s) => s.heat || s.oven);
  const oven = (r.steps || []).some((s) => s.oven);
  const st = r.storage || {};
  const logged = prog.logged;
  const offer = logged?.text ? null : logOffer(r);
  return h('div', { class: 'final-screen' },
    h('h2', null, 'Готово — приятного аппетита!'),
    heat ? h('label', { class: 'final-check' }, h('input', { type: 'checkbox', checked: !!prog.offChecked, onchange: (e) => { prog.offChecked = e.target.checked; save(); } }),
      h('span', null, h('b', null, oven ? 'Плита и духовка выключены' : 'Плита выключена'), ' — проверь ручки конфорок', oven ? ' и духовки' : '', '.')) : null,
    r.done_when?.serve ? h('p', null, h('b', null, 'Подача: '), renderText(r, r.done_when.serve, { kitchen: state.data.kitchen }).text) : null,
    logged?.text ? h('p', { class: 'have-line' }, `Записано в план: ${logged.text.toLowerCase()} — приготовлено, продукты списаны из запасов. `,
      undoLog?.rid === r.id ? h('button', { class: 'linkbtn', onclick: () => { state.plan = undoLog.prev; undoLog = null; prog.logged = { none: true }; save(); rerender(); } }, 'Отменить') : null)
      : offer ? h('button', { class: 'btn', onclick: () => { const m = offer.apply(); prog.logged = { text: m.text }; undoLog = { rid: r.id, prev: m.prev }; save(); rerender(); } }, offer.label)
        : h('p', { class: 'muted' }, state.plan?.batches?.length ? 'В плане на сегодня нет приёма пищи, вместо которого записать это блюдо.' : 'Плана на неделю нет — блюдо никуда не записывается.'),
    leftoverLine(r, portions) ? h('p', null, leftoverLine(r, portions)) : null,
    st.reheat && portions > 1 ? h('p', { class: 'muted' }, `Разогрев: ${st.reheat}`) : null,
    st.freezable && portions > 1 ? h('p', { class: 'muted' }, `Можно заморозить${st.freeze_note ? ': ' + st.freeze_note : ''}.`) : null,
    h('button', { class: 'linkbtn', onclick: restart }, 'Начать готовку заново'));
}

export function renderCook(root, rerender, id, params) {
  const r = state.recipeMap.get(id);
  if (!r) {
    document.getElementById('nav').hidden = false;
    root.append(h('p', null, 'Рецепт не найден. ', h('a', { href: '#/recipes' }, 'К рецептам')));
    return;
  }
  const asked = portionParams(params, r);
  let { factor, portions } = asked;
  const T = state.timers;
  const fresh = () => ({ step: 0, done: [], ings: [], checks: {} });
  let prog = (state.cook[id] = state.cook[id] || fresh());
  prog.checks = prog.checks || {};
  prog.ings = prog.ings || [];
  const restart = (keep = {}) => { dropRecipe(T, id); return (prog = state.cook[id] = { ...fresh(), ings: prog.ings, ...keep }); };
  // готовка, начатая больше 12 часов назад, — это прошлый раз: начинаем с первого шага (отметки ингредиентов сохраняем)
  if (prog.at && Date.now() - prog.at > 12 * 3600000 && !timersOf(T, id).length) restart();
  prog.at = Date.now();
  // шаги изменились (замена ингредиента, новая версия рецепта) — начинаем с первого шага
  if (r.compiled && prog.sig !== stepsSig(r)) restart({ at: prog.at, sig: stepsSig(r) });
  // начатая готовка хранит свои порции (S67): зашёл из Плана с другим числом — готовим дальше на начатые, с пометкой
  const begun = prog.step > 0 || prog.done.length > 0 || timersOf(T, id).length > 0;
  let otherPortions = null;
  if (begun && prog.portions && (prog.portions !== portions || Math.abs((prog.factor || 1) - factor) > 0.01)) {
    otherPortions = { ...asked };
    portions = prog.portions;
    factor = prog.factor || 1;
  } else { prog.portions = portions; prog.factor = factor; }
  const scale = (factor * portions) / r.servings;
  const n = r.steps.length;
  // ссылка на шаг (сигнал таймера «К шагу»): ?s=N — открыть этот шаг один раз, адрес без s
  const sParam = params.get('s');
  if (sParam != null && Number.isFinite(+sParam)) {
    prog.step = +sParam;
    prog.finished = false;
    save();
    params.delete('s');
    try { history.replaceState(history.state, '', `#/cook/${id}${params.toString() ? '?' + params : ''}`); } catch { /* ignore */ }
  }
  prog.step = Math.min(Math.max(0, prog.step), n - 1);
  keepAwake();
  const href = (k) => `#/cook/${id}?f=${factor}&p=${portions}&s=${k}`;

  const markDone = (k) => {
    prog.done = [...new Set([...prog.done, k])];
    if (prog.retry?.step === k) prog.retry = null;
  };
  // ближайший невыполненный шаг после k (затем — с начала); всё выполнено — последний шаг
  const nearestUndone = (k) => {
    for (let j = k + 1; j < n; j++) if (!prog.done.includes(j)) return j;
    for (let j = 0; j < k; j++) if (!prog.done.includes(j)) return j;
    return n - 1;
  };
  let confirmWait = false;
  const go = once((d) => { if (d < 0) prog.finished = false; prog.step = Math.min(n - 1, Math.max(0, prog.step + d)); save(); rerender(); });
  const finish = () => {
    prog.finished = true;
    prog.logged = null;
    // блюдо готово — не запущенные и остановленные таймеры не нужны; идущий (например, духовка) остаётся со своим сигналом
    for (const [k, t] of timersOf(T, id)) if (!t.endAt && !t.ringing) delete T[k];
    save();
    rerender();
  };
  // «Дальше» = шаг сделан и следующий (S61): шаг с идущим таймером не отмечается — он идёт в фоне, его таймер наверху;
  // звенящий таймер этого шага выключается. Пролистывание и стрелки только листают, ничего не отмечая
  const next = once(() => {
    // шаг ждёт другой, чей таймер ещё идёт: «Дальше» — только с подтверждением (S56)
    const pend = waitIdx.filter((j) => T[timerKey(id, j)]?.endAt);
    if (pend.length && !confirmWait) {
      let close = null;
      close = sheet('Таймер ещё идёт', h('div', { class: 'stack' },
        h('p', null, `Этот шаг начинают, когда закончится ${joinRu(pend.map((j) => `шаг ${j + 1} (ещё ${clock(leftOf(T[timerKey(id, j)]))})`))}. Уже сделал его?`),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onclick: () => close() }, 'Подожду'),
          h('button', { class: 'btn', onclick: () => { close(); confirmWait = true; lastNav = 0; next(); } }, 'Да, сделал'))));
      return;
    }
    confirmWait = false;
    const t = T[timerKey(id, prog.step)];
    if (t?.endAt || (t && !t.ringing && leftOf(t) > 0)) { /* идёт или на паузе — шаг не закрыт */ } else {
      if (t) delete T[timerKey(id, prog.step)];
      markDone(prog.step);
    }
    if (prog.step < n - 1) { prog.step++; save(); rerender(); return; }
    finish();
  });
  // «Готово» после звонка или все признаки отмечены: шаг выполнен, таймер шага снят; дальше — ближайший невыполненный
  const confirmDone = once((k, { move = true } = {}) => {
    delete T[timerKey(id, k)];
    markDone(k);
    if (move) prog.step = nearestUndone(k);
    save();
    rerender();
  });
  // Выйти из готовки: идёт таймер — спросить (он продолжит звонить на других экранах)
  const exitHref = `#/recipe/${id}?f=${factor}&p=${portions}`;
  const askExit = () => {
    const live = timersOf(T, id).filter(([, t]) => t.endAt || t.ringing);
    let close = null;
    const body = h('div', { class: 'stack' },
      h('p', null, live.length ? `Идёт таймер: ${live.map(([, t]) => `${t.label} — ${t.ringing ? 'звенит' : clock(leftOf(t))}`).join(', ')}. Он продолжит звонить и на других экранах; вернуться — плашкой внизу экрана или кнопкой «Продолжить готовку».` : 'Шаг и отметки сохранятся — продолжить можно со страницы рецепта.'),
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', onclick: () => close() }, 'Остаться'),
        h('button', { class: 'btn', onclick: () => { close(); location.hash = exitHref; } }, 'Выйти из готовки')));
    close = sheet('Выйти из готовки?', body);
  };
  // системная «Назад» телефона: предыдущий шаг; на первом — «Выйти из готовки?» (S62)
  try { if (!history.state?.cookGuard) history.pushState({ cookGuard: id }, ''); } catch { /* ignore */ }
  onBack((e) => {
    if (!location.hash.startsWith('#/cook/') || e.state?.cookGuard) return;
    try { history.pushState({ cookGuard: id }, ''); } catch { /* ignore */ }
    if (prog.step > 0 && !prog.finished) go(-1); else askExit();
  });
  const step = r.steps[prog.step];
  const tkey = timerKey(id, prog.step);
  // подпись таймера по смыслу (S61): «Вода (шаг 4)», «Духовка (шаг 2)», «Лук (шаг 7)», а не номер
  const tlabel = (k) => {
    const s = r.steps[k];
    const short = (x) => String(x || '').replace(/\s*\(.*\)\s*/g, ' ').trim();
    const what = s.id === 'boil' || /^act:(boil_water|bring_to_boil|heat_water)/.test(s.origin || '') ? 'Вода'
      : /preheat_oven/.test(s.origin || '') ? 'Духовка'
        : /heat_fat/.test(s.origin || '') ? 'Масло'
          : short(stepSlots(r, s).find((x) => x.ing && !x.ing.basic && !/^water/.test(x.ing.key))?.ing?.name_ru);
    return `${what || short(r.title)} (шаг ${k + 1})`;
  };
  const checksOf = (k) => prog.checks[k] || [];
  const onCheck = (k) => (list) => {
    prog.checks[k] = list;
    const s = r.steps[k];
    // все признаки отмечены — шаг выполнен, его таймер больше не нужен (иначе он неожиданно зазвонит позже)
    if (s.cues?.length && list.length === s.cues.length && !prog.done.includes(k)) {
      const had = !!T[timerKey(id, k)];
      delete T[timerKey(id, k)];
      markDone(k);
      save();
      rerender();
      toast(`Шаг ${k + 1} выполнен — все признаки совпали${had ? ', таймер остановлен' : ''}`);
      return;
    }
    save();
  };

  const timersBar = h('div', { class: 'timers-bar' });
  const stepTimer = h('div', { class: 'cook-timer' });
  // Перестраиваем кнопки только при смене состояния; каждые полсекунды меняем лишь цифры,
  // иначе нажатие может попасть на момент перерисовки и потеряться
  let signature = '';
  const clocks = [];
  const live = []; // часы вне блока таймера (строка «Сначала дождись»)
  const drawTimers = (fromTick) => {
    const mine = timersOf(T, id);
    const sig = mine.map(([k, t]) => `${k}:${!!t.endAt}:${t.ringing}:${!!t.over}`).join('|') + '#' + (T[tkey] ? 1 : 0);
    if (fromTick === true && sig === signature) {
      for (const [el, t] of [...clocks, ...live]) el.textContent = el.dataset.prefix + clock(leftOf(t));
      return;
    }
    // таймер зазвонил (этого шага — панель «Проверь», другого — действие поверх шага, S56/S60) — экран заново;
    // открытую шторку не трогаем
    if (fromTick === true && signature && !hasLayer()) { signature = sig; rerender(); return; }
    signature = sig;
    clocks.length = 0;
    // плашки таймеров этого блюда: нажатие открывает шаг таймера (звенящий — в режиме «Проверь»), ничего не сбрасывает
    // звенящие другие — крупно поверх шага (ringOthers), в полосе — идущие и на паузе
    timersBar.replaceChildren(...mine.filter(([k, t]) => k !== tkey && !t.ringing).map(([k, t]) => {
      const span = h('span', { 'data-prefix': `${t.ringing ? '⏰ ' : t.endAt ? '⏱ ' : '⏸ '}${tlabel(t.step)}: ` });
      if (t.ringing || t.over) span.textContent = `${t.ringing ? '⏰' : '✓'} ${tlabel(t.step)}: ${t.action || agoText(t) || 'время вышло — проверь'}`;
      else { span.textContent = span.dataset.prefix + clock(leftOf(t)); clocks.push([span, t]); }
      return h('button', { class: 'btn small' + (t.ringing ? ' ring' : ''), onclick: () => { prog.step = t.step; save(); rerender(); }, title: 'Открыть шаг таймера' }, span);
    }));
    if (step.timer_min) {
      const t = T[tkey];
      const secs = Math.round(step.timer_min * 60);
      const left = t ? leftOf(t) : secs;
      const run = !!t?.endAt;
      const over = !!(t && (t.ringing || t.over));
      const big = h('span', { class: 'clock', 'data-prefix': '' }, clock(left));
      if (t && !over) clocks.push([big, t]);
      const start = () => {
        unlockSound();
        if (run) pauseTimer(T, tkey);
        else startTimer(T, tkey, { rid: id, step: prog.step, label: tlabel(prog.step), seconds: secs, href: href(prog.step), action: step.on_timer ? renderText(r, step.on_timer, { ...step.ctx, scale, kitchen: state.data.kitchen }).text : null });
        ensureTicker();
        save();
        drawTimers();
      };
      // сброс — отдельной кнопкой и с «Отменить» (S61)
      const reset = () => {
        const prev = JSON.parse(JSON.stringify(T[tkey]));
        delete T[tkey];
        save();
        drawTimers();
        toast('Таймер сброшен', { label: 'Отменить', onClick: () => { T[tkey] = prev; ensureTicker(); save(); rerender(); } });
      };
      const silence = () => { Object.assign(T[tkey], { ringing: false, over: true }); save(); drawTimers(); };
      stepTimer.replaceChildren(...[
        over ? h('span', { class: 'clock done' }, t.ringing ? '0:00' : '✓') : big,
        over ? h('span', { class: 'timer-ago' }, agoText(t) || 'время вышло') : null,
        over && hasReadiness(step)
          ? checkPanel(r, step, {
            checked: checksOf(prog.step), onCheck: onCheck(prog.step),
            onDone: () => confirmDone(prog.step),
            onNotReady: () => {
              const add = step.not_ready?.add?.[0] || 2;
              extendTimer(T, tkey, Math.round(add * 60));
              ensureTicker();
              prog.retry = { step: prog.step, text: step.not_ready?.text ? renderText(r, step.not_ready.text, { ...step.ctx, kitchen: state.data.kitchen }).text : `Ещё ${add} мин — и проверь снова.` };
              save();
              rerender();
              toast(`Добавили ${add} мин — таймер снова идёт`);
            },
          })
          : over ? h('span', { class: 'muted' }, 'Время вышло — переходи дальше') : null,
        t?.ringing ? h('button', { class: 'btn', onclick: silence }, 'Выключить сигнал') : null,
        over ? null : h('button', { class: 'btn primary', onclick: start },
          icon(run ? 'pause' : 'play'), run ? 'Пауза' : t ? 'Продолжить' : `Запустить ${num(step.timer_min, 1)} мин`),
        over && !t.ringing ? h('button', { class: 'btn reset', onclick: start }, `Ещё раз ${num(step.timer_min, 1)} мин`) : null,
        t && !over ? h('button', { class: 'btn reset', onclick: reset }, 'Сбросить') : null].filter(Boolean));
    } else {
      stepTimer.replaceChildren();
    }
  };
  drawTimers();
  onTick(drawTimers);
  // вежливо: спросим только когда на шаге есть таймер
  const notifyAsk = 'Notification' in window && Notification.permission === 'default' && step.timer_min
    ? h('button', { class: 'btn small ghost', onclick: (e) => { Notification.requestPermission(); e.currentTarget.remove(); } }, 'Уведомлять, когда таймер закончится') : null;
  const stepOver = !!(T[tkey] && (T[tkey].ringing || T[tkey].over));

  const isDone = prog.done.includes(prog.step);
  const showIngredients = () => {
    const box = h('div', { class: 'cook-ings' });
    const draw = () => box.replaceChildren(ingredientList(r, scale, { onToggle: draw }));
    draw();
    sheet('Ингредиенты', box);
  };

  // Продукты шага — из подстановок шаблона, с тем же количеством, что в тексте (часть или всё)
  const kitchen = state.data.kitchen;
  const showGrams = !!state.prefs.showGrams;
  const text = stepText(r, step, scale, kitchen, { showGrams });
  const packs = weekPacks();
  const ingAmounts = stepCards(r, kitchen, prog.step).map(({ ing, frac, how, at }) => {
    if (how === 'used') return { i: ing, used: at };
    const m = ingredientMeasure(r, ing, scale, kitchen, { frac, packOf: packs ? (k) => packs.get(k)?.grams : null });
    return { i: ing, a: m.measure, g: showGrams && m.unit !== 'g' && m.unit !== 'text' ? m.gramsText : '', part: frac < 0.999, from: at };
  });
  // огонь — по среде шага (вода, масло, сухая сковорода, молоко) и типу плиты из профиля, только уровни этого шага (S55)
  const terms = [...heatTerms(step, text, state.prefs.stove), ...stepTerms(text, ...ingAmounts.map((x) => x.a || ''))];
  // Осталось (S67): по таймлайну от текущего места (шаг выполнен — от его конца) и по идущим таймерам: таймер
  // ещё N минут + всё, что после его шага; всё выполнено — не показываем
  const timersAhead = r.steps.reduce((a, s, i) => a + (prog.done.includes(i) ? 0 : (s.timer_min || 0)), 0);
  const total = r.time?.total || n;
  const byLine = r.compiled && step.at ? total - (isDone ? step.at.end : step.at.start) : total * (n - prog.done.length) / n;
  const byTimers = Math.max(0, ...timersOf(T, id).filter(([, t]) => t.endAt).map(([, t]) => leftOf(t) / 60 + (r.steps[t.step]?.at ? Math.max(0, total - r.steps[t.step].at.end) : 0)));
  const allDone = prog.done.length >= n;
  const leftMin = allDone || prog.finished ? 0 : Math.max(1, Math.round(Math.max(byLine, byTimers, r.compiled ? 0 : timersAhead)));

  // S56: от чего зависит шаг — шаг wait_for и (на завершающих шагах) все ещё идущие таймеры; признак — чем проверить
  const dueOf = (j) => {
    const s2 = r.steps[j];
    const t = T[timerKey(id, j)];
    const sign = s2.check ? renderText(r, s2.check, { ...s2.ctx, kitchen: state.data.kitchen }).text : s2.cues?.[0] ? renderText(r, s2.cues[0].text, { ...s2.ctx, kitchen: state.data.kitchen }).text : '';
    let tm = null;
    if (t?.endAt) { tm = h('span', { 'data-prefix': 'таймер ещё ' }, `таймер ещё ${clock(leftOf(t))}`); live.push([tm, t]); } else if (t?.ringing) tm = 'таймер звенит — проверь';
    return [`шаг ${j + 1}`, tm ? [' (', tm, ')'] : '', sign ? ` — ${peek(sign, 90)}` : ''];
  };
  const waitIdx = isDone ? [] : [...new Set([
    ...(step.wait_for != null && !prog.done.includes(step.wait_for) ? [step.wait_for] : []),
    ...(step.track === 'finish' || prog.step === n - 1 ? timersOf(T, id).filter(([, t]) => t.endAt && t.step < prog.step).map(([, t]) => t.step) : []),
  ])].sort((a, b) => a - b);
  const waits = waitIdx.map(dueOf);
  // параллельные шаги до этого, ещё не выполненные и без таймера (их таймер и так в полосе наверху)
  const onStove = (step.parallel || []).filter((j) => j < prog.step && !prog.done.includes(j) && !T[timerKey(id, j)] && r.steps[j].heat);
  // длинный процесс на этом шаге: следующие шаги, которые идут параллельно с ним
  const goOn = r.steps.map((s2, j) => (j > prog.step && (s2.parallel || []).includes(prog.step) ? j : -1)).filter((j) => j >= 0);
  // таймер другого шага звенит — действие поверх текущего шага (S56)
  const ringing = timersOf(T, id).filter(([k, t]) => k !== tkey && t.ringing);
  const ringOthers = ringing.length ? h('div', { class: 'ring-banner', role: 'alert' }, ringing.map(([k, t]) => h('div', { class: 'ring-row' },
    h('div', null, h('b', null, `⏰ ${t.label}: `), t.action ? `сейчас — ${t.action}.` : `${agoText(t) || 'время вышло'} — проверь.`),
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      t.action || !hasReadiness(r.steps[t.step])
        ? h('button', { class: 'btn primary', onclick: () => confirmDone(t.step, { move: false }) }, 'Сделал')
        : h('button', { class: 'btn primary', onclick: () => { prog.step = t.step; save(); rerender(); } }, `Проверить шаг ${t.step + 1}`),
      h('button', { class: 'btn', onclick: () => { Object.assign(T[k], { ringing: false, over: true }); save(); rerender(); } }, 'Выключить сигнал'))))) : null;

  // блюдо готово и таймеров больше нет — отметка «приготовил» в плане (один раз, с «Отменить» на экране)
  const liveTimers = timersOf(T, id).filter(([, t]) => t.endAt || t.ringing);
  if (prog.finished && !liveTimers.length && !prog.logged) {
    const m = markCookedInPlan(id);
    prog.logged = m ? { text: m.text } : { none: true };
    undoLog = m ? { rid: id, prev: m.prev } : null;
    save();
  }
  const final = prog.finished ? finalScreen(r, portions, prog, { live: liveTimers, rerender, restart: () => { restart(); save(); rerender(); } }) : null;
  const el = h('div', { class: 'cook', tabindex: '-1' },
    h('div', { class: 'cook-head' },
      // выход при идущем таймере — с вопросом (S64)
      h('button', { class: 'btn icon ghost cook-close', 'aria-label': 'Выйти из режима готовки', onclick: () => (timersOf(T, id).some(([, t]) => t.endAt || t.ringing) ? askExit() : (location.hash = exitHref)) }, icon('close')),
      // название в две строки и число порций (S67): готовить на 8, думая, что на 2, — нельзя
      h('div', { class: 't' }, h('span', { class: 't-name' }, r.title), h('span', { class: 't-sub' }, `на ${portions} ${plural(portions, 'порцию', 'порции', 'порций')}`)),
      h('button', { class: 'btn small', onclick: showIngredients }, 'Ингредиенты')),
    h('div', { class: 'cook-progress', 'aria-hidden': 'true' }, r.steps.map((_, i) => h('i', { class: prog.done.includes(i) ? 'done' : i === prog.step ? 'cur' : T[timerKey(id, i)] ? 'run' : '' }))),
    timersBar,
    h('div', { class: 'cook-body' }, prog.finished ? [ringOthers, final] : [
      prog.step === 0 ? swapNotice(r) : null,
      ringOthers,
      otherPortions ? h('div', { class: 'notice' }, `Готовка начата на ${portions} ${plural(portions, 'порцию', 'порции', 'порций')} — количества в шагах на них. `,
        h('button', { class: 'linkbtn', onclick: () => { restart(); location.replace(`#/cook/${id}?f=${otherPortions.factor}&p=${otherPortions.portions}`); } }, `Начать заново на ${otherPortions.portions}`)) : null,
      waits.length ? h('div', { class: 'notice wait-first' }, h('b', null, 'Сначала дождись: '), waits.map((w, j) => [j ? '; ' : '', w])) : null,
      h('div', { class: 'cook-step-n' }, `Шаг ${prog.step + 1} из ${n}`, isDone ? ' · выполнен ✓' : '', leftMin > 0 ? ` · осталось ≈ ${leftMin} мин` : '',
        step.changed ? h('span', { class: 'badge warn swap-badge' }, 'изменено заменой') : null),
      h('div', { class: 'cook-text' }, nb(text)),
      heatLabel(step) || timeLabel(step) ? h('div', { class: 'row', style: { gap: '6px', margin: '6px 0' } },
        heatLabel(step) ? h('span', { class: 'badge accent' }, icon('flame'), heatLabel(step)) : null,
        timeLabel(step) ? h('span', { class: 'badge' }, icon('clock'), `≈ ${timeLabel(step)}`) : null) : null,
      // таймер — сразу под текстом шага, на всех шагах в одном месте (S60); после звонка здесь же «Проверь»
      prog.finished ? null : stepTimer,
      notifyAsk,
      onStove.length ? h('div', { class: 'muted small' }, `На плите ещё ${onStove.length > 1 ? 'идут шаги' : 'идёт шаг'} ${joinRu(onStove.map((j) => j + 1))} — не забудь ${onStove.length > 1 ? 'про них' : 'про него'}: «Назад» или полоса прогресса.`) : null,
      goOn.length && step.timer_min && !isDone ? h('div', { class: 'tool-hint' }, h('b', null, 'Не жди у плиты: '), `${T[tkey]?.endAt ? 'пока идёт таймер' : 'запусти таймер и'} делай ${goOn.length > 1 ? `шаги ${goOn[0] + 1}–${goOn[goOn.length - 1] + 1}` : `шаг ${goOn[0] + 1}`} («Дальше»), он позовёт сигналом.`) : null,
      prog.retry?.step === prog.step && !isDone ? h('div', { class: 'notice' }, h('b', null, 'Ещё не готово: '), prog.retry.text) : null,
      stepHints(step, state.prefs.equipment).map((t) => h('div', { class: 'tool-hint' }, t)),
      // «Частые ошибки» — на шаге, где их можно сделать (S74)
      (step.tips || []).map((t) => h('div', { class: 'tool-hint tip-mistake' }, h('b', null, 'Частая ошибка: '), t)),
      step.why ? h('div', { class: 'muted' }, `Зачем: ${step.why}`) : null,
      step.note ? h('div', { class: 'tool-hint' }, step.note) : null,
      // карточки продуктов шага (S57): всё, что добавляется, с количеством на этот шаг; подготовленное раньше — серым
      ingAmounts.length ? h('ul', { class: 'step-ings' }, ingAmounts.map(({ i, a, g, part, used, from }) => used != null
        ? h('li', { class: 'used' }, h('span', null, i.name_ru), h('span', { class: 'muted' }, `всё, что подготовил в шаге ${used + 1}`))
        : h('li', null, h('span', null, i.name_ru, i.replaced ? h('span', { class: 'badge warn swap-badge' }, 'замена') : null),
          h('b', null, a, part ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ' — часть на этот шаг') : null, g ? h('span', { class: 'muted grams', style: { fontWeight: 400 } }, ` (${g})`) : null,
            from != null ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ` — отмерил в шаге ${from + 1}`) : null)))) : null,
      terms.length ? h('details', { class: 'step-terms' }, h('summary', null, 'Что значит?'), h('ul', null, terms.map((t) => h('li', null, t)))) : null,
      // после звонка признаки — в панели «Проверь» под текстом шага, второй раз не повторяем (S60)
      prog.finished || (stepOver && hasReadiness(step)) ? null : readyBlock(r, step, { big: true, checkable: true, checked: checksOf(prog.step), onCheck: onCheck(prog.step) }),
      prog.step === n - 1 ? doneWhenBlock(r) : null,
      // что дальше — заранее, чтобы не искать, пока на огне специи (S56)
      prog.step < n - 1 ? h('p', { class: 'next-peek muted small' }, h('b', null, `Дальше, шаг ${prog.step + 2}: `), peek(stepText(r, r.steps[prog.step + 1], scale, kitchen))) : null]),
    h('div', { class: 'cook-foot' },
      h('button', { class: 'btn', disabled: prog.step === 0 && !prog.finished, onclick: () => go(-1) }, '← Назад'),
      prog.finished
        // «Выйти» не уводит молча в План: блюдо из плана — «К плану», иначе — к рецепту
        ? h('a', { class: 'btn primary', href: prog.logged?.text ? '#/plan' : exitHref }, prog.logged?.text ? 'К плану' : 'К рецепту')
        // на последнем шаге одна кнопка завершения — не путать с «Готово ✓» в панели «Проверь» (S59)
        : h('button', { class: 'btn primary', onclick: next }, prog.step === n - 1 ? 'Завершить готовку ✓' : 'Дальше →')));

  // свайпы и клавиатура
  let x0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 70) go(dx < 0 ? 1 : -1);
    x0 = null;
  });
  // клавиатура: слушаем документ, чтобы стрелки работали, даже если фокус ушёл с кнопки
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = (e) => {
    // поверх открыт список ингредиентов или фото — клавиши для них; с модификаторами — браузеру
    if (hasLayer() || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'ArrowLeft') go(-1);
    const onControl = e.target.closest?.('a, button, input, select, textarea, label');
    if ((e.key === ' ' || e.key === 'Enter') && !onControl) { e.preventDefault(); next(); }
  };
  document.addEventListener('keydown', keyHandler);
  root.append(el);
  setTimeout(() => {
    el.focus({ preventScroll: true });
    // таймер шага звенит — кнопки «Готово / Ещё не готово» на экране, а не через несколько прокруток (S60)
    if (T[tkey]?.ringing) el.querySelector('.check-actions, .cook-timer')?.scrollIntoView({ block: 'end' });
  }, 0);
}
