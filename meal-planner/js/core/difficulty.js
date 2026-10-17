// Сложность готовки для новичка: уровень и почему. Считается по самому рецепту — шагам, времени, приёмам и посуде.
// Не «оценка вкуса», а ответ на вопрос «справлюсь ли я сегодня, если устал».

export const LEVELS = [
  { id: 'none', label: 'Без готовки', short: 'без готовки' },
  { id: 'easy', label: 'Очень просто', short: 'очень просто' },
  { id: 'simple', label: 'Просто', short: 'просто' },
  { id: 'medium', label: 'Средне', short: 'средне' },
  { id: 'hard', label: 'Посложнее', short: 'посложнее' },
];

const TECH = [
  [/панир|сухар/, 'панировка', 2],
  [/отбе?й|отбив/, 'отбить мясо', 1],
  [/сформ|скатай|слепи/, 'сформовать котлеты или тефтели', 1],
  [/тесто|замеси/, 'тесто', 2],
  [/блендер/, 'блендер', 1],
  [/внутри не розов|сок прозрачн/, 'проверить готовность мяса', 1],
];
// Делать две вещи сразу: «пока рис варится, …», «тем временем», «займись мясом»
const PARALLEL = /пока (он|она|оно|они|рис|картофель|картошка|паста|макароны|вода|булгур|кускус|лапша|мясо|курица|соус)\S* (вар|жар|запека|туш|кипит|печ|готов)|тем временем|одновременно|параллельно|займись/;

export function difficulty(r) {
  if (!r) return null;
  const steps = r.steps || [];
  const text = steps.map((s) => s.text || '').join(' ').toLowerCase().replace(/ё/g, 'е');
  const heats = steps.filter((s) => s.heat).length;
  const active = r.time?.active ?? 0;
  const oven = /духовк/.test(text);
  const heated = heats > 0 || oven || /сковород|кастрюл|вари|жарь|обжар/.test(text);
  const reasons = [];
  let score = 0;
  if (!heated && active <= 10) {
    return { ...LEVELS[0], score: 0, reasons: [active <= 3 ? 'собрать за пару минут' : `собрать за ${active} мин`], tip: null };
  }
  score += active <= 10 ? 0 : active <= 18 ? 1 : active <= 25 ? 2 : 3;
  if (active > 18) reasons.push(`активно ${active} мин`);
  score += steps.length <= 4 ? 0 : steps.length <= 8 ? 1 : steps.length <= 12 ? 2 : 3;
  if (steps.length > 10) reasons.push(`${steps.length} шагов`);
  const parallel = PARALLEL.test(text);
  if (parallel) { score += 2; reasons.push('две вещи одновременно'); }
  for (const [re, label, w] of TECH) if (re.test(text)) { score += w; reasons.push(label); }
  if (oven) { score += 1; reasons.push('духовка'); }
  const tools = (r.tools || []).length;
  if (tools >= 3) { score += 1; reasons.push(`${tools} вида посуды`); }
  const main = r.main_ingredient_count ?? (r.ingredients || []).filter((i) => !i.basic).length;
  if (main >= 9) { score += 1; reasons.push(`${main} продуктов`); }
  const level = score <= 2 ? LEVELS[1] : score <= 5 ? LEVELS[2] : score <= 8 ? LEVELS[3] : LEVELS[4];
  if (!reasons.length) reasons.push(steps.length <= 4 ? `${steps.length} ${steps.length === 1 ? 'шаг' : 'шага'}` : 'обычные шаги, без сложных приёмов');
  const tip = level.id === 'hard' || level.id === 'medium'
    ? (parallel ? 'Прочитайте шаги заранее и нарежьте всё до того, как включать плиту — тогда «пока варится» не застанет врасплох.'
      : 'Прочитайте шаги заранее и подготовьте продукты до начала готовки.')
    : null;
  return { ...level, score, reasons, tip };
}

// Короткая подпись для списков: «Просто · 9 шагов»
export function difficultyText(r) {
  const d = difficulty(r);
  return d ? `${d.label}${d.reasons.length && d.id !== 'easy' ? ' · ' + d.reasons.slice(0, 2).join(', ') : ''}` : '';
}
