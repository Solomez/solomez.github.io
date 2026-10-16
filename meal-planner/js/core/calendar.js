// Календарь плана: день 0 плана — это конкретная дата (plan.startDate), приёмы пищи — по времени суток.
// Всё считается в местном времени устройства.

const DAY_MS = 86400000;
export const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Когда приём пищи считается прошедшим (час, местное время). Для готовки — время начала готовки.
export const MEAL_END_HOUR = { breakfast: 10, lunch: 14, snack: 17, dinner: 20 };
export const COOK_HOUR = { breakfast: 8, lunch: 12, snack: 16, dinner: 18 };

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

// Дата начала плана. У старых планов (до привязки к датам) неделя считалась с понедельника недели создания.
export function planStart(plan) {
  if (plan?.startDate) return parseDate(plan.startDate);
  return mondayOf(plan?.createdAt ? new Date(plan.createdAt) : new Date());
}

export const dayDate = (plan, i) => addDays(planStart(plan), i);
export const weekdayIndex = (date) => (date.getDay() + 6) % 7;
export const dayName = (plan, i) => WEEKDAYS[weekdayIndex(dayDate(plan, i))];
export const dayShort = (plan, i) => WEEKDAYS_SHORT[weekdayIndex(dayDate(plan, i))];
export const dayLabel = (plan, i) => { const d = dayDate(plan, i); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; };

// Номер сегодняшнего дня в плане: <0 — план ещё не начался, ≥7 — уже закончился
export function todayIndex(plan, now = new Date()) {
  return Math.round((startOfDay(now) - planStart(plan)) / DAY_MS);
}

const at = (plan, day, hour) => { const d = dayDate(plan, day); d.setHours(hour, 0, 0, 0); return d; };
export const mealPast = (plan, day, meal, now = new Date()) => now >= at(plan, day, MEAL_END_HOUR[meal] ?? 20);
// Приготовление (batch) уже сделано, если наступило время его готовки
export const cookPast = (plan, day, meal, now = new Date()) => now >= at(plan, day, COOK_HOUR[meal] ?? 18);

// План только с тем, что ещё предстоит приготовить и съесть: по нему считается список покупок
export function remainingPlan(plan, now = new Date()) {
  return {
    ...plan,
    batches: plan.batches.filter((b) => {
      const first = b.slots[0]; // первый приём пищи приготовления — момент готовки
      return !cookPast(plan, first.day, first.meal, now);
    }),
    extras: (plan.extras || []).filter((x) => !mealPast(plan, x.day, x.meal, now)),
  };
}

export function planFinished(plan, now = new Date()) {
  const rest = remainingPlan(plan, now);
  return rest.batches.length === 0 && rest.extras.length === 0;
}

// Подпись «на что» рассчитан список: от первого оставшегося приёма пищи до конца плана
export function remainingRange(plan, now = new Date()) {
  const rest = remainingPlan(plan, now);
  const slots = [...rest.batches.flatMap((b) => b.slots), ...rest.extras.map((x) => ({ day: x.day, meal: x.meal }))];
  if (!slots.length) return null;
  const order = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };
  slots.sort((a, b) => a.day - b.day || order[a.meal] - order[b.meal]);
  return { from: slots[0] };
}

// Варианты начала новой недели
export function startOptions(now = new Date()) {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const nextMonday = addDays(mondayOf(today), 7);
  const opts = [
    { id: 'today', date: today, label: 'Сегодня' },
    { id: 'tomorrow', date: tomorrow, label: 'Завтра' },
  ];
  if (weekdayIndex(today) !== 0) opts.push({ id: 'monday', date: weekdayIndex(tomorrow) === 0 ? null : nextMonday, label: 'С понедельника' });
  return opts.filter((o) => o.date);
}
export const fmtDate = (d) => `${WEEKDAYS_SHORT[weekdayIndex(d)]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
// По умолчанию: до полудня — с сегодня, позже — с завтра
export const defaultStart = (now = new Date()) => (now.getHours() < 12 ? startOfDay(now) : addDays(startOfDay(now), 1));
