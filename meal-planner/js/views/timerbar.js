// Таймеры готовки на всех экранах (S61): один общий отсчёт, пока есть идущий или звенящий таймер.
// Закончился — звук, вибрация, уведомление; сигнал повторяется каждые 25 секунд, пока его не выключат.
// Таймеры хранятся в state.timers (core/timers.js) — после перезагрузки отсчёт продолжается с того же места.
import { h, toast } from '../ui.js';
import { state, save } from '../state.js';
import { finishDue, repeatDue, anyActive, timersOf, leftOf, clock } from '../core/timers.js';

let tick = null;
let audioCtx = null;
let listener = null; // перерисовка открытого экрана (режим готовки) на каждом тике
let barUpdate = null; // плашка «идёт готовка» вне режима готовки (S64)

export function beep() {
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

// разрешение звука браузер даёт только по жесту пользователя — вызываем при «Запустить»
export function unlockSound() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { /* ignore */ }
}

const inCookOf = (rid) => location.hash.startsWith(`#/cook/${encodeURIComponent(rid)}`) || location.hash.startsWith(`#/cook/${rid}`);

function step() {
  const now = Date.now();
  const fresh = finishDue(state.timers, now);
  for (const { t } of fresh) {
    beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Таймер: ' + t.label + (t.action ? ` — ${t.action}` : '')); } catch { /* ignore */ }
    }
    // не в готовке этого блюда — сообщение со ссылкой на шаг звенящего таймера
    if (!inCookOf(t.rid) && !document.querySelector('.cook-bar')) toast(`⏰ ${t.label}: ${t.action || 'время вышло — проверь'}`, t.href ? { label: 'К шагу', onClick: () => { location.hash = t.href; } } : undefined);
  }
  for (const x of repeatDue(state.timers, now)) { void x; beep(); }
  if (fresh.length) save();
  listener?.(true);
  barUpdate?.(fresh.length > 0);
  if (!anyActive(state.timers)) stopTicker();
}

export function ensureTicker() {
  if (tick || !anyActive(state.timers)) return;
  tick = setInterval(step, 500);
}
function stopTicker() { clearInterval(tick); tick = null; }

// Экран, которому нужен каждый тик (режим готовки): fn(fromTick); null — снять
export function onTick(fn) { listener = fn; if (fn) ensureTicker(); }

// После загрузки: таймеры, которые шли до перезагрузки или закрытия вкладки, — продолжают (или уже звенят)
export function resumeTimers() {
  if (anyActive(state.timers)) { step(); ensureTicker(); }
}

// Начатая готовка (S64): шаг, на котором остановился, таймеры; null — не начинали, закончили или это было давно.
// Ссылка — с порциями, на которые начата готовка (S67), и на шаг звенящего таймера
export function cookResume(rid, { f = 1, p = null } = {}) {
  const prog = state.cook?.[rid];
  const r = state.recipeMap.get(rid);
  if (!prog || !r) return null;
  const ts = timersOf(state.timers, rid);
  const started = prog.step > 0 || (prog.done || []).length > 0 || ts.length > 0;
  if (!started || (prog.finished && !ts.some(([, t]) => t.endAt || t.ringing))) return null;
  if (prog.at && Date.now() - prog.at > 12 * 3600000 && !ts.length) return null;
  const ring = ts.find(([, t]) => t.ringing);
  const step = ring ? ring[1].step : prog.step;
  return {
    step,
    href: `#/cook/${rid}?f=${prog.factor || f}&p=${prog.portions || p || r.servings}&s=${step}`,
    label: `Продолжить готовку · шаг ${step + 1}`,
    timers: ts,
  };
}

// Плашка над нижним меню на всех экранах, кроме режима готовки: «⏱ Макароны · Вода (шаг 4) · 4:10 · Вернуться»;
// таймер вышел — красная «⏰ … время вышло — к шагу». Пусто — ничего
export function cookBar() {
  const ids = [...new Set(Object.values(state.timers || {}).filter((t) => t.endAt || t.ringing || t.left > 0).map((t) => t.rid))].filter((rid) => state.recipeMap.has(rid));
  if (!ids.length) { barUpdate = null; return null; }
  const bar = h('div', { class: 'cook-bar', role: 'status', 'aria-live': 'polite' });
  const clocks = [];
  const draw = () => {
    clocks.length = 0;
    bar.replaceChildren(...ids.map((rid) => {
      const r = state.recipeMap.get(rid);
      const ts = timersOf(state.timers, rid);
      const ring = ts.find(([, t]) => t.ringing);
      const [, t] = ring || ts.find(([, x]) => x.endAt) || ts[0];
      const res = cookResume(rid);
      const c = h('b', null, ring ? 'время вышло' : clock(leftOf(t)));
      if (!ring) clocks.push([c, t]);
      return h('a', { class: 'cook-bar-item' + (ring ? ' ring' : ''), href: res?.href || `#/cook/${rid}?s=${t.step}` },
        h('span', { class: 'cook-bar-text' }, `${ring ? '⏰' : '⏱'} Таймер: ${r.title} · ${t.label} · `, c),
        h('span', { class: 'cook-bar-go' }, ring ? 'К шагу →' : 'Вернуться →'));
    }));
  };
  draw();
  barUpdate = (changed) => { if (!bar.isConnected) { barUpdate = null; return; } if (changed) draw(); else for (const [el, t] of clocks) el.textContent = clock(leftOf(t)); };
  return bar;
}
