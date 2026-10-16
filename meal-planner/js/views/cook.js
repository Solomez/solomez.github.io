import { h, icon, num, sheet, nb, toast, hasLayer } from '../ui.js';
import { state, save } from '../state.js';
import { ingredientAmount, ingredientList, portionParams } from './recipe.js';
import { stepHints } from '../core/equipment.js';

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

export function renderCook(root, rerender, id, params) {
  const r = state.recipeMap.get(id);
  if (!r) {
    document.getElementById('nav').hidden = false;
    root.append(h('p', null, 'Рецепт не найден. ', h('a', { href: '#/recipes' }, 'К рецептам')));
    return;
  }
  const { factor, portions } = portionParams(params, r);
  const scale = (factor * portions) / r.servings;
  const prog = (state.cook[id] = state.cook[id] || { step: 0, done: [] });
  const n = r.steps.length;
  prog.step = Math.min(Math.max(0, prog.step), n - 1);
  keepAwake();

  const go = (d) => { prog.step = Math.min(n - 1, Math.max(0, prog.step + d)); save(); rerender(); };
  const toggleDone = () => {
    const s = new Set(prog.done);
    s.has(prog.step) ? s.delete(prog.step) : s.add(prog.step);
    prog.done = [...s];
    if (s.has(prog.step) && prog.step < n - 1) prog.step++;
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
        t?.ringing
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

  // Продукты, которые упоминаются в тексте шага, — с количеством, чтобы не листать список
  const stepText = step.text.toLowerCase();
  const stepIngs = r.ingredients.filter((i) => {
    const w = (i.name_ru || '').toLowerCase().split(/[^а-яёa-z]+/).find((x) => x.length >= 3);
    if (!w) return false;
    return stepText.includes(w.length > 5 ? w.slice(0, w.length - 2) : w);
  });
  // Оставшееся время: таймеры невыполненных шагов + ~1 минута на остальные
  const leftMin = Math.round(r.steps.reduce((a, s, i) => a + (prog.done.includes(i) ? 0 : (s.timer_min || 1)), 0));

  const el = h('div', { class: 'cook', tabindex: '-1' },
    h('div', { class: 'cook-head' },
      h('a', { class: 'btn icon ghost', href: `#/recipe/${id}?f=${factor}&p=${portions}`, 'aria-label': 'Выйти из режима готовки' }, icon('close')),
      h('div', { class: 't' }, r.title),
      h('button', { class: 'btn small', onclick: showIngredients }, 'Ингредиенты')),
    h('div', { class: 'cook-progress', 'aria-hidden': 'true' }, r.steps.map((_, i) => h('i', { class: prog.done.includes(i) ? 'done' : i === prog.step ? 'cur' : '' }))),
    timersBar,
    h('div', { class: 'cook-body' },
      h('div', { class: 'cook-step-n' }, `Шаг ${prog.step + 1} из ${n}`, isDone ? ' · выполнен ✓' : '', leftMin > 0 ? ` · осталось ≈ ${leftMin} мин` : ''),
      h('div', { class: 'cook-text' }, nb(step.text)),
      stepHints(step, state.prefs.equipment).map((t) => h('div', { class: 'tool-hint' }, t)),
      stepIngs.length ? h('ul', { class: 'step-ings' }, stepIngs.map((i) => h('li', null, h('span', null, i.name_ru), h('b', null, ingredientAmount(i, scale, state.data.products, r.servings).main)))) : null,
      step.heat ? h('div', { class: 'cook-heat' }, h('span', { class: 'badge accent' }, `Огонь: ${step.heat}`)) : null,
      stepTimer,
      prog.done.length === n ? h('p', { class: 'notice', style: { marginTop: '20px' } }, 'Все шаги выполнены. Приятного аппетита! ',
        h('button', { class: 'btn small', onclick: () => { state.cook[id] = { step: 0, done: [] }; save(); rerender(); } }, 'Начать заново')) : null),
    h('div', { class: 'cook-foot' },
      h('button', { class: 'btn', disabled: prog.step === 0, onclick: () => go(-1) }, '← Назад'),
      h('button', { class: 'btn primary', onclick: toggleDone }, isDone ? 'Снять отметку' : 'Готово ✓'),
      h('button', { class: 'btn', disabled: prog.step === n - 1, onclick: () => go(1) }, 'Дальше →')));

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
    if ((e.key === ' ' || e.key === 'Enter') && !onControl) { e.preventDefault(); toggleDone(); }
  };
  document.addEventListener('keydown', keyHandler);
  root.append(el);
  setTimeout(() => el.focus(), 0);
}
