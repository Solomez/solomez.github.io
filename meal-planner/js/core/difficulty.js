import { count } from './qty.js';
import { TOOL } from './equipment.js';

const joinRu = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : xs[0] || '');

// Сложность готовки для новичка: уровень и почему. Считается по самому рецепту — шагам, времени, приёмам и посуде.
// Не «оценка вкуса», а ответ на вопрос «справлюсь ли я сегодня, если устал».

export const LEVELS = [
  { id: 'none', label: 'Без готовки', short: 'без готовки' },
  { id: 'easy', label: 'Очень просто', short: 'очень просто' },
  { id: 'simple', label: 'Просто', short: 'просто' },
  { id: 'medium', label: 'Средне', short: 'средне' },
  { id: 'hard', label: 'Посложнее', short: 'посложнее' },
];

// S76: приём — только если шаг его делает: сухари в фарше — не панировка, хлебец — не котлеты, «не взбивай блендером» — не блендер
const TECH = [
  [/обваля|в панировк|панируй/, 'панировка', 2],
  [/отбе?й|отбив/, 'отбить мясо', 1],
  [/(сформуй|слепи|сформируй)[^.]*(хлебец|батон|рулет)/, 'сформовать хлебец', 1],
  [/скатай|(сформуй|слепи|сформируй)[^.]*тефтел/, 'скатать тефтели', 1],
  [/(сформуй|слепи|сформируй)[^.]*(котлет|лепёшк|лепешк)/, 'слепить котлеты', 1],
  [/тесто|замеси/, 'тесто', 2],
  [/(сложи|положи|налей|переложи|выложи)[^.]*в блендер|(взбей|измельчи|пюрируй)[^.]*блендер/, 'блендер', 1],
  [/внутри не розов|сок прозрачн|без розового/, 'проверить готовность мяса', 1],
];
// Делать две вещи сразу (S76): по таймлайну — шаги разных частей блюда (рис и соус) идут в одно время. Разогрев
// духовки, мытьё рук и «достань и отмерь» не в счёт. Собранного таймлайна нет (старые рецепты) — по словам в тексте
const PARALLEL = /пока (он|она|оно|они|рис|картофель|картошка|паста|макароны|вода|булгур|кускус|лапша|мясо|курица|соус)\S* (вар|жар|запека|туш|кипит|печ|готов)|тем временем|одновременно|параллельно|займись/;
function twoAtOnce(steps, text) {
  const xs = steps.filter((s) => s.at && !s.background && !s.chore && s.kind !== 'mise' && s.kind !== 'hygiene');
  if (!xs.length) return PARALLEL.test(text);
  return xs.some((a, i) => xs.slice(i + 1).some((b) => a.track !== b.track && a.track !== 'finish' && b.track !== 'finish'
    && a.at.start < b.at.end - 0.5 && b.at.start < a.at.end - 0.5));
}

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
  if (steps.length > 10) reasons.push(count(steps.length, ['шаг', 'шага', 'шагов']));
  const parallel = twoAtOnce(steps, text);
  if (parallel) { score += 2; reasons.push('две вещи одновременно'); }
  for (const [re, label, w] of TECH) if (re.test(text)) { score += w; reasons.push(label); }
  if (oven) { score += 1; reasons.push('духовка'); }
  // посуда называется словами (S54: «3 вида посуды» при пяти строках в «Посуде» читалось как ошибка)
  const tools = (r.tools || []).length;
  // из «или» — то, что в посуде рецепта (противень, а не «форма»); одно название — один раз (S76)
  const inGear = new Set((r.gear || []).map((g) => g.id));
  const names = [...new Set((r.tools || []).map((g) => (TOOL[g.find((id) => inGear.has(id)) || g[0]]?.ru || g[0]).toLowerCase()))];
  if (tools >= 3) { score += 1; reasons.push(`нужны ${joinRu(names)}`); }
  const main = r.main_ingredient_count ?? (r.ingredients || []).filter((i) => !i.basic).length;
  if (main >= 9) { score += 1; reasons.push(`${main} продуктов`); }
  const level = score <= 2 ? LEVELS[1] : score <= 5 ? LEVELS[2] : score <= 8 ? LEVELS[3] : LEVELS[4];
  if (!reasons.length) reasons.push(steps.length <= 4 ? count(steps.length, ['шаг', 'шага', 'шагов']) : 'обычные шаги, без сложных приёмов');
  const tip = level.id === 'hard' || level.id === 'medium'
    ? (parallel ? `Прочитайте шаги заранее и нарежьте всё до того, как включать ${heats ? 'плиту' : 'духовку'} — тогда «пока готовится» не застанет врасплох.`
      : 'Прочитайте шаги заранее и подготовьте продукты до начала готовки.')
    : null;
  return { ...level, score, reasons, tip };
}

// Короткая подпись для списков: «Просто · 9 шагов»
export function difficultyText(r) {
  const d = difficulty(r);
  return d ? `${d.label}${d.reasons.length && d.id !== 'easy' ? ' · ' + d.reasons.slice(0, 2).join(', ') : ''}` : '';
}
