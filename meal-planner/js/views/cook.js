import { h, icon, num, sheet, nb, toast, hasLayer } from '../ui.js';
import { state, save, stepsSig } from '../state.js';
import { ingredientList, portionParams, weekPacks, swapNotice } from './recipe.js';
import { stepText, stepSlots, ingredientMeasure } from '../core/cookbook.js';
import { readyBlock, checkPanel, doneWhenBlock, hasReadiness } from './ready.js';
import { heatLabel, timeLabel } from './recipe.js';
import { stepHints } from '../core/equipment.js';
import { stepTerms } from '../core/amounts.js';
import { fmtDate, todayIndex, MEALS_ORDER } from '../core/calendar.js';
import { toggleDone, doneOf, skipOf, MEALS } from '../core/planner.js';

// Таймеры живут вне перерисовок: key → { label, total, endAt | null, left, ringing }
const timers = new Map();
let tick = null;
let wakeLock = null;
let audioCtx = null;
let keyHandler = null;

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.start(t0);
      o.stop(t0 + 0.3);
    }
  } catch { /* звук недоступен */ }
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

const leftOf = (t) => (t.endAt ? Math.max(0, Math.round((t.endAt - Date.now()) / 1000)) : t.left);
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function startTimer(key, label, seconds, href) {
  const t = timers.get(key) || { label, total: seconds, left: seconds, endAt: null, ringing: false, href };
  if (t.ringing || leftOf(t) === 0) Object.assign(t, { left: seconds, ringing: false });
  t.endAt = Date.now() + leftOf(t) * 1000;
  timers.set(key, t);
  // разрешение звука нужно получить по жесту пользователя
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* ignore */ }
}
function pauseTimer(key) {
  const t = timers.get(key);
  if (t?.endAt) { t.left = leftOf(t); t.endAt = null; }
}

// Закончившиеся таймеры: звук, вибрация, уведомление; вне режима готовки — ещё и сообщение со ссылкой
function ringFinished(inCook) {
  for (const t of timers.values()) {
    if (t.endAt && leftOf(t) === 0 && !t.ringing) {
      t.ringing = true;
      t.endAt = null;
      t.left = 0;
      beep();
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Таймер: ' + t.label); } catch { /* ignore */ }
      }
      if (!inCook) toast(`⏰ Таймер: ${t.label}`, t.href ? { label: 'К готовке', onClick: () => { location.hash = t.href; } } : undefined);
    }
  }
}

function ensureTick(update) {
  clearInterval(tick);
  tick = setInterval(() => { ringFinished(true); update(true); }, 500);
}

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
  clearInterval(tick);
  tick = null;
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  // ушли из режима готовки, а таймер идёт — продолжаем следить, чтобы сигнал прозвучал
  if ([...timers.values()].some((t) => t.endAt)) {
    tick = setInterval(() => {
      ringFinished(false);
      if (![...timers.values()].some((t) => t.endAt)) { clearInterval(tick); tick = null; }
    }, 1000);
  }
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

// Экран завершения: что делать со второй порцией и когда её съесть
function finishCard(r, portions, restart) {
  const days = r.storage?.fridge_days || 0;
  const until = days ? fmtDate(new Date(Date.now() + days * 86400000)) : null;
  return h('div', { style: { marginTop: '20px' } }, doneWhenBlock(r), h('div', { class: 'notice' },
    h('p', { style: { margin: '0 0 6px', fontWeight: 500 } }, r.done_when ? 'Всё совпало — приятного аппетита.' : 'Готово! Приятного аппетита.'),
    portions > 1 && until ? h('p', { style: { margin: '0 0 6px' } }, `Вторую порцию остудите и уберите в контейнер в холодильник — съесть до ${until}.`) : null,
    r.storage?.reheat ? h('p', { class: 'muted', style: { margin: '0 0 8px' } }, `Разогрев: ${r.storage.reheat}`) : null,
    h('p', { class: 'muted', style: { margin: '0 0 8px' } }, r.storage?.fridge_days ? `Хранение: в холодильнике до ${r.storage.fridge_days} ${r.storage.fridge_days === 1 ? 'дня' : 'дней'} в закрытом контейнере; горячее не убирай — сначала остуди (до 1–2 часов).${r.storage.freezable ? ' Можно заморозить' + (r.storage.freeze_note ? ': ' + r.storage.freeze_note : '') + '.' : ''}` : 'Лучше съесть сразу.'),
    h('button', { class: 'btn small', onclick: restart }, 'Начать заново')));
}

export function renderCook(root, rerender, id, params) {
  const r = state.recipeMap.get(id);
  if (!r) {
    document.getElementById('nav').hidden = false;
    root.append(h('p', null, 'Рецепт не найден. ', h('a', { href: '#/recipes' }, 'К рецептам')));
    return;
  }
  const { factor, portions } = portionParams(params, r);
  const scale = (factor * portions) / r.servings;
  let prog = (state.cook[id] = state.cook[id] || { step: 0, done: [] });
  // готовка, начатая больше 12 часов назад, — это прошлый раз: начинаем с первого шага (отметки ингредиентов сохраняем)
  if (prog.at && Date.now() - prog.at > 12 * 3600000) prog = state.cook[id] = { step: 0, done: [], ings: prog.ings };
  prog.at = Date.now();
  // шаги изменились (замена ингредиента, новая версия рецепта) — начинаем с первого шага
  if (r.compiled && prog.sig !== stepsSig(r)) { prog = state.cook[id] = { step: 0, done: [], ings: prog.ings, at: prog.at, sig: stepsSig(r) }; }
  const n = r.steps.length;
  prog.step = Math.min(Math.max(0, prog.step), n - 1);
  keepAwake();

  // ушли с шага — сработавшие и закончившиеся таймеры этого рецепта больше не нужны (сигнал услышан)
  const clearRung = () => { for (const [k, t] of timers) if (k.startsWith(id + '#') && (t.ringing || (!t.endAt && leftOf(t) === 0))) timers.delete(k); };
  const go = (d) => { clearRung(); if (d < 0) prog.finished = false; prog.step = Math.min(n - 1, Math.max(0, prog.step + d)); save(); rerender(); };
  // «Дальше» = шаг сделан и следующий; на последнем шаге — «Готово» и экран завершения
  const next = () => {
    clearRung();
    prog.done = [...new Set([...prog.done, prog.step])];
    if (prog.step < n - 1) prog.step++;
    // блюдо готово — сработавшие и не запущенные таймеры не нужны (P1); идущий (например, духовка) остаётся со своим сигналом
    else {
      prog.finished = true;
      for (const [k, t] of [...timers]) if (k.startsWith(id + '#') && (t.ringing || !t.endAt)) timers.delete(k);
      const m = markCookedInPlan(id);
      if (m) {
        save();
        rerender();
        toast(`Отмечено в плане: ${m.text.toLowerCase()} — приготовлено, продукты списаны из запасов`, { label: 'Отменить', onClick: () => { state.plan = m.prev; save(); } });
        return;
      }
    }
    save();
    rerender();
  };
  const step = r.steps[prog.step];
  const tkey = `${id}#${prog.step}`;

  const timersBar = h('div', { class: 'timers-bar' });
  const stepTimer = h('div', { class: 'cook-timer' });
  // Перестраиваем кнопки только при смене состояния; каждые полсекунды меняем лишь цифры,
  // иначе нажатие может попасть на момент перерисовки и потеряться
  let signature = '';
  const clocks = [];
  const drawTimers = (fromTick) => {
    const mine = [...timers.entries()].filter(([k]) => k.startsWith(id + '#'));
    const sig = mine.map(([k, t]) => `${k}:${!!t.endAt}:${t.ringing}`).join('|') + '#' + (timers.has(tkey) ? 1 : 0);
    if (fromTick === true && sig === signature) {
      for (const [el, t] of clocks) el.textContent = el.dataset.prefix + clock(leftOf(t));
      return;
    }
    signature = sig;
    clocks.length = 0;
    timersBar.replaceChildren(...[...timers.entries()].filter(([k]) => k.startsWith(id + '#')).map(([k, t]) => h('button', {
      class: 'btn small' + (t.ringing ? ' ring' : ''),
      onclick: () => { if (t.ringing) { timers.delete(k); drawTimers(); } else { prog.step = +k.split('#')[1]; save(); rerender(); } },
      title: t.ringing ? 'Выключить сигнал' : 'Перейти к шагу',
    }, (() => {
      const span = h('span', { 'data-prefix': `${t.ringing ? '⏰ ' : t.endAt ? '⏱ ' : '⏸ '}шаг ${+k.split('#')[1] + 1}: ` });
      span.textContent = span.dataset.prefix + clock(leftOf(t));
      clocks.push([span, t]);
      return span;
    })())));
    if (step.timer_min) {
      const t = timers.get(tkey);
      const secs = Math.round(step.timer_min * 60);
      const left = t ? leftOf(t) : secs;
      const running = !!t?.endAt;
      const big = h('span', { class: 'clock', 'data-prefix': '' }, clock(left));
      if (t) clocks.push([big, t]);
      stepTimer.replaceChildren(
        big,
        t?.ringing && hasReadiness(step)
          ? checkPanel(r, step, {
            onDone: () => { timers.delete(tkey); prog.retry = null; next(); },
            onNotReady: () => {
              const add = step.not_ready?.add?.[0] || 2;
              timers.delete(tkey);
              startTimer(tkey, `${r.title}, шаг ${prog.step + 1}`, Math.round(add * 60), `#/cook/${id}?f=${factor}&p=${portions}`);
              prog.retry = { step: prog.step, text: step.not_ready?.text || `Ещё ${add} мин — и проверь снова.` };
              save();
              rerender();
            },
          })
          : t?.ringing
          ? h('button', { class: 'btn primary', onclick: () => { timers.delete(tkey); drawTimers(); } }, 'Выключить сигнал')
          : h('button', { class: 'btn primary', onclick: () => { running ? pauseTimer(tkey) : startTimer(tkey, `${r.title}, шаг ${prog.step + 1}`, secs, `#/cook/${id}?f=${factor}&p=${portions}`); drawTimers(); } },
            icon(running ? 'pause' : 'play'), running ? 'Пауза' : t ? 'Продолжить' : `Запустить ${num(step.timer_min, 1)} мин`),
        ...(t ? [h('button', { class: 'btn', onclick: () => { timers.delete(tkey); drawTimers(); } }, 'Сброс')] : []));
    } else {
      stepTimer.replaceChildren();
    }
  };
  drawTimers();
  ensureTick(drawTimers);
  if ('Notification' in window && Notification.permission === 'default' && step.timer_min) {
    // вежливо: спросим только когда на шаге есть таймер
    stepTimer.append(h('button', { class: 'btn small ghost', onclick: () => Notification.requestPermission() }, 'Уведомлять, когда таймер закончится'));
  }

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
  const parted = new Set(r.steps.flatMap((s) => stepSlots(r, s).filter((x) => x.quantified && x.frac < 1).map((x) => x.ing)));
  const ingAmounts = stepSlots(r, step).filter((x) => x.quantified || !parted.has(x.ing)).map(({ ing, frac }) => {
    const m = ingredientMeasure(r, ing, scale, kitchen, { frac, packOf: packs ? (k) => packs.get(k)?.grams : null });
    return { i: ing, a: m.measure, g: showGrams && m.unit !== 'g' && m.unit !== 'text' ? m.gramsText : '', part: frac < 1 };
  });
  const terms = stepTerms(text, step.heat ? `огонь: ${step.heat}` : '', ...ingAmounts.map((x) => x.a));
  // Оставшееся время — доля полного времени рецепта по невыполненным шагам (как «всего N мин» в карточке)
  const timersAhead = r.steps.reduce((a, s, i) => a + (prog.done.includes(i) ? 0 : (s.timer_min || 0)), 0);
  // у собранных шаблонов — по таймлайну: от начала текущего шага до конца блюда
  const leftMin = r.compiled && step.at ? Math.round(Math.max(0, r.time.total - step.at.start)) : Math.round(Math.max((r.time?.total || n) * (n - prog.done.length) / n, timersAhead));

  const el = h('div', { class: 'cook', tabindex: '-1' },
    h('div', { class: 'cook-head' },
      h('a', { class: 'btn icon ghost', href: `#/recipe/${id}?f=${factor}&p=${portions}`, 'aria-label': 'Выйти из режима готовки' }, icon('close')),
      h('div', { class: 't' }, r.title),
      h('button', { class: 'btn small', onclick: showIngredients }, 'Ингредиенты')),
    h('div', { class: 'cook-progress', 'aria-hidden': 'true' }, r.steps.map((_, i) => h('i', { class: prog.done.includes(i) ? 'done' : i === prog.step ? 'cur' : '' }))),
    timersBar,
    h('div', { class: 'cook-body' },
      prog.step === 0 && !prog.finished ? swapNotice(r) : null,
      h('div', { class: 'cook-step-n' }, `Шаг ${prog.step + 1} из ${n}`, isDone ? ' · выполнен ✓' : '', leftMin > 0 ? ` · осталось ≈ ${leftMin} мин` : ''),
      h('div', { class: 'cook-text' }, nb(text)),
      heatLabel(step) || timeLabel(step) ? h('div', { class: 'row', style: { gap: '6px', margin: '6px 0' } },
        heatLabel(step) ? h('span', { class: 'badge accent' }, heatLabel(step)) : null,
        timeLabel(step) ? h('span', { class: 'badge' }, `≈ ${timeLabel(step)}`) : null) : null,
      step.parallel?.length ? h('div', { class: 'muted small' }, `Параллельно идёт шаг ${step.parallel.map((j) => j + 1).join(', ')} — следи за его таймером`) : null,
      step.wait_for != null && !prog.done.includes(step.wait_for) || step.wait_for != null && timers.get(`${id}#${step.wait_for}`)?.endAt
        ? h('div', { class: 'notice' }, h('b', null, 'Не спеши: '), `начни, когда закончится шаг ${step.wait_for + 1}${timers.get(`${id}#${step.wait_for}`)?.endAt ? ' (его таймер ещё идёт — наверху экрана)' : ''}.`) : null,
      prog.retry?.step === prog.step ? h('div', { class: 'notice' }, h('b', null, 'Ещё не готово: '), prog.retry.text) : null,
      stepHints(step, state.prefs.equipment).map((t) => h('div', { class: 'tool-hint' }, t)),
      step.why ? h('div', { class: 'muted' }, `Зачем: ${step.why}`) : null,
      step.note ? h('div', { class: 'tool-hint' }, step.note) : null,
      ingAmounts.length ? h('ul', { class: 'step-ings' }, ingAmounts.map(({ i, a, g, part }) => h('li', null, h('span', null, i.name_ru, i.replaced ? h('span', { class: 'muted' }, ` — вместо «${i.replaced.name_ru.toLowerCase()}»`) : null),
        h('b', null, a, part ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ' — часть на этот шаг') : null, g ? h('span', { class: 'muted grams', style: { fontWeight: 400 } }, ` (${g})`) : null)))) : null,
      terms.length ? h('details', { class: 'step-terms' }, h('summary', null, 'Что значит?'), h('ul', null, terms.map((t) => h('li', null, t)))) : null,
      prog.finished ? null : readyBlock(r, step, { big: true, checkable: true }),
      !prog.finished && prog.step === n - 1 ? doneWhenBlock(r) : null,
      prog.finished ? null : stepTimer, // на экране «Готово» таймер шага не нужен (UX-ревью Н10)
      prog.finished ? finishCard(r, portions, () => { state.cook[id] = { step: 0, done: [] }; save(); rerender(); }) : null),
    h('div', { class: 'cook-foot' },
      h('button', { class: 'btn', disabled: prog.step === 0, onclick: () => go(-1) }, '← Назад'),
      prog.finished
        ? h('a', { class: 'btn primary', href: '#/plan' }, 'Выйти')
        : h('button', { class: 'btn primary', onclick: next }, prog.step === n - 1 ? 'Готово ✓' : 'Дальше →')));

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
  setTimeout(() => el.focus(), 0);
}
