// Расчёт дневной нормы: формула Миффлина — Сан-Жеора, коэффициент активности, цель.

export const ACTIVITY = [
  { id: 'sedentary', label: 'Сидячий образ жизни, без тренировок', factor: 1.2 },
  { id: 'light', label: 'Лёгкая активность: 1–3 тренировки в неделю', factor: 1.375 },
  { id: 'moderate', label: 'Средняя: 3–5 тренировок в неделю', factor: 1.55 },
  { id: 'high', label: 'Высокая: 6–7 тренировок в неделю', factor: 1.725 },
  { id: 'very_high', label: 'Очень высокая: физическая работа + спорт', factor: 1.9 },
];

export const GOALS = {
  gain: { label: 'Набор мышц (+10% к норме)', kcalFactor: 1.1, proteinPerKg: 2.0 },
  maintain: { label: 'Поддержание веса', kcalFactor: 1.0, proteinPerKg: 1.6 },
  cut: { label: 'Снижение веса (−15%)', kcalFactor: 0.85, proteinPerKg: 2.2 },
};

export const DEFAULT_PROFILE = {
  sex: null, // 'male' | 'female'
  age: 22,
  height: null, // см
  weight: null, // кг
  activity: 'moderate',
  goal: 'gain',
  surplusPct: 10, // профицит для набора, %
  proteinPerKg: 2.0,
  mealShare: 65, // доля дневной нормы на обед + ужин, %
  budget: 70, // € в неделю на продукты
  reserve: 20, // € в неделю на завтраки и перекусы (не входят в план)
};

export function isProfileComplete(p) {
  return Boolean(p && (p.sex === 'male' || p.sex === 'female') && p.height > 0 && p.weight > 0 && p.age > 0);
}

// Базовый обмен (ккал/сутки)
export function bmr({ sex, weight, height, age }) {
  return 10 * weight + 6.25 * height - 5 * age + (sex === 'male' ? 5 : -161);
}

export function activityFactor(id) {
  return (ACTIVITY.find((a) => a.id === id) || ACTIVITY[2]).factor;
}

// Если профиль не заполнен, берём средние значения, чтобы приложение работало, и помечаем это
const FALLBACK = { sex: 'male', age: 22, height: 178, weight: 72 };

export function dailyTargets(profile) {
  const p = { ...DEFAULT_PROFILE, ...(profile || {}) };
  const complete = isProfileComplete(p);
  const base = complete ? p : { ...p, ...FALLBACK };
  const b = bmr(base);
  const tdee = b * activityFactor(p.activity);
  let factor = GOALS[p.goal]?.kcalFactor ?? 1.1;
  if (p.goal === 'gain') factor = 1 + (p.surplusPct == null || p.surplusPct === '' || !Number.isFinite(+p.surplusPct) ? 10 : +p.surplusPct) / 100;
  const kcal = tdee * factor;
  const ppk = Number.isFinite(+p.proteinPerKg) && +p.proteinPerKg > 0 ? +p.proteinPerKg : (GOALS[p.goal]?.proteinPerKg ?? 2);
  const protein = base.weight * ppk;
  const fat = Math.max(base.weight * 0.9, (kcal * 0.25) / 9);
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  const share = Math.min(1, Math.max(0.3, (+p.mealShare || 65) / 100));
  return {
    complete,
    bmr: Math.round(b),
    tdee: Math.round(tdee),
    kcal: Math.round(kcal),
    protein: Math.round(protein),
    fat: Math.round(fat),
    carbs: Math.round(carbs),
    mealShare: share,
    // цель на один приём пищи (обед или ужин)
    perMeal: { kcal: Math.round((kcal * share) / 2), protein: Math.round((protein * share) / 2) },
    // цель на обед + ужин за день
    plannedDay: { kcal: Math.round(kcal * share), protein: Math.round(protein * share) },
  };
}
