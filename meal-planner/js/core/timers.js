// Таймеры готовки (S61): хранятся в состоянии приложения и сохраняются вместе с ним — переживают перезагрузку,
// закрытие вкладки и уход из режима готовки. Хранится время окончания, а не остаток: после возврата досчитываем.
// Закончившийся таймер звенит, пока его не выключат: сигнал повторяется каждые RING_REPEAT_S секунд.
//
// all — объект { ключ: таймер }, ключ «рецепт#шаг». Таймер:
//   { rid, step, label, total, endAt | null, left, ringing, rangAt, beepAt, href, action }
// Чистые функции без DOM — проверяются тестами (tests/cook.test.mjs).

export const RING_REPEAT_S = 25;

export const timerKey = (rid, step) => `${rid}#${step}`;
export const leftOf = (t, now = Date.now()) => (t.endAt ? Math.max(0, Math.round((t.endAt - now) / 1000)) : Math.max(0, Math.round(t.left || 0)));
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

// Запустить (или продолжить после паузы). Закончившийся — заново на полное время
export function startTimer(all, key, { rid, step, label, seconds, href = null, action = null }, now = Date.now()) {
  const t = all[key] || { rid, step, label, total: seconds, left: seconds, endAt: null, ringing: false, href, action };
  if (t.ringing || leftOf(t, now) === 0) Object.assign(t, { total: seconds, left: seconds, ringing: false, over: false, rangAt: null, beepAt: null });
  Object.assign(t, { label: label || t.label, href: href || t.href, action: action ?? t.action });
  t.endAt = now + leftOf(t, now) * 1000;
  all[key] = t;
  return t;
}

export function pauseTimer(all, key, now = Date.now()) {
  const t = all[key];
  if (t?.endAt) { t.left = leftOf(t, now); t.endAt = null; }
  return t;
}

// «Ещё не готово»: тот же таймер ещё на N минут
export function extendTimer(all, key, seconds, now = Date.now()) {
  const t = all[key];
  if (!t) return null;
  Object.assign(t, { total: seconds, left: seconds, endAt: now + seconds * 1000, ringing: false, over: false, rangAt: null, beepAt: null });
  return t;
}

// Какие таймеры только что закончились (в том числе пока приложение было закрыто): отмечаем «звенит».
// Время звонка — время окончания, а не время, когда заметили: «вышел 12 минут назад»
export function finishDue(all, now = Date.now()) {
  const out = [];
  for (const [key, t] of Object.entries(all)) {
    if (t.endAt && t.endAt <= now) {
      Object.assign(t, { ringing: true, rangAt: t.endAt, beepAt: now, endAt: null, left: 0 });
      out.push({ key, t });
    }
  }
  return out;
}

// Звенящие таймеры, которым пора повторить сигнал (никто не выключил)
export function repeatDue(all, now = Date.now(), every = RING_REPEAT_S) {
  const out = [];
  for (const [key, t] of Object.entries(all)) {
    if (t.ringing && now - (t.beepAt || 0) >= every * 1000) { t.beepAt = now; out.push({ key, t }); }
  }
  return out;
}

// «Время вышло 3 минуты назад» — после возврата в приложение
export function agoText(t, now = Date.now()) {
  if (!t?.ringing || !t.rangAt) return '';
  const m = Math.floor((now - t.rangAt) / 60000);
  if (m < 1) return 'время вышло';
  const w = m % 10 === 1 && m % 100 !== 11 ? 'минуту' : [2, 3, 4].includes(m % 10) && ![12, 13, 14].includes(m % 100) ? 'минуты' : 'минут';
  return `время вышло ${m === 1 ? 'минуту' : `${m} ${w}`} назад`;
}

export const timersOf = (all, rid) => Object.entries(all || {}).filter(([, t]) => t.rid === rid).sort((a, b) => a[1].step - b[1].step);
export const running = (all) => Object.values(all || {}).some((t) => t.endAt);
export const anyActive = (all) => Object.values(all || {}).some((t) => t.endAt || t.ringing);

// Снять таймеры рецепта (новая готовка с первого шага, другие шаги после замены)
export function dropRecipe(all, rid) {
  for (const [k, t] of Object.entries(all)) if (t.rid === rid) delete all[k];
}
