// S74: «Частые ошибки» — к своему шагу. Пункт показывается в режиме готовки на шаге, где ошибку можно сделать
// (а не только внизу страницы), и уходит, если продукт, о котором он, заменён.
//
// Шаг пункта: карточка может указать его сама — `mistake_at` (массив той же длины, что `mistakes`: номер шага
// карточки с нуля, [номер, n] — n-й собранный шаг из него, false — ни к какому, null — найти самому). Иначе — по продуктам, которые пункт называет (формы названий из measures.json и
// списка), и по действию («огонь», «крышка», «нарезать», «соль», «мешать», «лепить», «панировка», «духовка»…).
// Из одинаково подходящих — самый ранний: совет нужен до того, как ошибку сделали. Не нашлось — null (пункт
// остаётся только в списке на странице рецепта).
import { slotId } from './cookbook.js';

const lc = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
const T = (s) => lc(s.text);
const HEAT = (s) => !!(s.heat || s.oven);
// [что в пункте, какой шаг подходит, вес]
const ACTIONS = [
  [/огон|огне|огня|конфорк/, (s) => !!s.heat],
  [/крышк/, (s) => /крышк/.test(T(s))],
  [/нарез|режь|резать|кубик|полукольц|брусоч|кружк|ломтик|полоск|наруб|соломк|толще|тоньше/, (s) => /нарежь|наруби|разрежь|порежь/.test(T(s))],
  [/терк|натер|натри/, (s) => /терк|натри|нарежь/.test(T(s))],
  [/(^|[^а-я])сол(и|ь|ью)(?![а-я])|посол|пересол|досол|досал|солен/, (s) => /(^|[^а-я])сол(и|ь|ью)(?![а-я])|посоли|досоли|соли \(|попробуй/.test(T(s))],
  [/меша|помеш/, (s) => /меша|помеш/.test(T(s))],
  [/отби|отбей|отбив/, (s) => /отбей|отбив/.test(T(s))],
  [/лепи|сформ|скатай|вымес|вымеш/, (s) => /сформуй|слепи|скатай|сформируй|вымеси|перемешай руками/.test(T(s))],
  [/панир|обвал|стряхив/, (s) => /обваляй|панир/.test(T(s))],
  [/духовк|запека|запеч/, (s) => !!s.oven],
  [/промы|промой|промок|обсуш/, (s) => /промой|промыв|промокни|обсуши|налей в банку/.test(T(s))],
  [/(^|[^а-я])сл(ей|ить|ивай)|дуршлаг|отцед/, (s) => /(^|[^а-я])слей|откинь/.test(T(s))],
  [/жар|обжар|румян|корочк|подгор|горч/, (s) => !!s.heat],
  [/вари|варк|кипи|кипят|разварив/, (s) => !!s.heat && /вари|кипен|кипит|кипят|доведи/.test(T(s))],
  [/туши|тушени|томи|уварив/, (s) => !!s.heat && /туши|томи|увари/.test(T(s))],
  [/холодн\S* (масл|сковород)|разогре/, (s) => s.origin === 'act:heat_fat' || /разогрет/.test(T(s))],
  [/намаж|мажь|намаз/, (s) => /намаж|мажь/.test(T(s))],
  [/завар|пакетик/, (s) => /завар|пакетик|залей кипятком/.test(T(s))],
  [/разбива|разбей|скорлуп/, (s) => /разбей|вбей/.test(T(s))],
];
// действия, которые говорят точно, где ошибка: вынуть рано, резать горячим — важнее остального
const LATE = [
  [/вынима|вынул|рано|розов|у кости|по таймеру вслепую/, (s) => (s.safety || []).some((x) => x.stage === 'final')],
  [/горяч\S* резать|резать горяч|сразу из духовки|отдохн|постоять|остын|остуди/, (s) => /отдохн|постоять|остуди|остынет|достань/.test(T(s)) && !s.heat],
];

// слова в названиях, которые не говорят, о каком продукте речь
const STOP = new Set(['соус', 'масло', 'масла', 'сливочное', 'растительное', 'оливковое', 'консервированн', 'консервированный', 'консервированная',
  'молотый', 'молотая', 'сушёный', 'сушеный', 'свежий', 'свежая', 'филе', 'репчатый', 'длиннозерный', 'длиннозёрный', 'красная', 'красный', 'белый',
  'зелёный', 'зеленый', 'сладкая', 'сладкий', 'чёрный', 'черный', 'пшеничная', 'кубиками', 'ломтиках', 'лучше', 'любой', 'обычный']);

// Формы названия продукта слота: «курица», «курицу», «куриное филе»…
function formsOf(ing, kitchen) {
  const ru = kitchen?.measures?.[ing.key]?.ru || {};
  const forms = new Set(Object.values(ru).map(lc).filter((x) => x.length >= 3 && !STOP.has(x)));
  for (const w of lc(ing.name_ru).split(/[^а-я]+/)) if (w.length >= 5 && !STOP.has(w)) forms.add(w.slice(0, Math.max(4, w.length - 2)));
  // «курица» — и у филе, бёдер, голеней; «мясо» — у любого мяса
  if (/chicken/.test(ing.key)) forms.add('куриц');
  if (/turkey/.test(ing.key)) forms.add('индейк');
  if (/mince/.test(ing.key)) { forms.add('фарш'); forms.add('котлет'); forms.add('тефтел'); forms.add('хлебец'); }
  if (/pork|beef/.test(ing.key)) forms.add('мясо');
  if (/rice|bulgur|couscous/.test(ing.key)) { forms.add('круп'); forms.add('зерн'); }
  if (/pasta|noodles/.test(ing.key)) { forms.add('макарон'); forms.add('паст'); }
  if (ing.key === 'eggs') { forms.add('желт'); forms.add('белок'); }
  return [...forms];
}

// Слоты, которые пункт называет
export function mistakeSlots(r, text, kitchen) {
  const t = lc(text);
  return r.ingredients.filter((i) => !i.derived && formsOf(i, kitchen).some((f) => new RegExp(`(^|[^а-я])${f}`).test(t))).map(slotId);
}

// Шаг пункта по тексту: индекс в r.steps или null
export function mistakeStep(r, text, kitchen) {
  const t = lc(text);
  const slots = new Set(mistakeSlots(r, text, kitchen));
  const late = LATE.filter(([re]) => re.test(t));
  const acts = late.length ? late : ACTIONS.filter(([re]) => re.test(t));
  // нужен и продукт, и действие; не нашлось шага с действием — по одному продукту; пункт без продукта — по действию
  for (const strict of [true, false]) {
    let best = null;
    let bestScore = 0;
    r.steps.forEach((s, k) => {
      if (s.kind === 'mise' || s.kind === 'hygiene' || s.chore || s.background) return;
      const own = new Set([...(s.slots || []), ...(s.ctx?.self ? [s.ctx.self] : [])]);
      const mine = [...own].filter((id) => slots.has(id)).length;
      if (slots.size && !mine) return;
      const fit = acts.filter(([, f]) => f(s)).length;
      if (strict && acts.length && !fit) return;
      const score = mine * 3 + fit * 2;
      if (score > bestScore) { best = k; bestScore = score; }
    });
    if (best != null || !slots.size) return best;
  }
  return null;
}

// Шаг пункта, указанный карточкой: номер шага карточки → первый собранный шаг с огнём из него (иначе — первый);
// [номер, n] — n-й собранный шаг из него (у шага-способа их несколько: закипание, варка, слив); false — ни к какому
function stepOfCard(r, at) {
  if (at === false) return null;
  const [ci, n] = Array.isArray(at) ? at : [at, null];
  const mine = r.steps.map((s, k) => (s.ci === ci && s.kind !== 'mise' ? k : -1)).filter((k) => k >= 0);
  if (n != null) return mine[Math.min(n, mine.length - 1)] ?? null;
  return mine.find((k) => HEAT(r.steps[k])) ?? mine[0] ?? null;
}

// r.mistakes и r.mistake_steps (шаг каждого пункта). После замены — без пунктов о заменённом продукте (по исходному
// рецепту: он назван или пункт стоит на шаге его способа): «не открывай крышку 18 минут» у риса — не про кускус
export function bindMistakes(r, card, base, kitchen) {
  const list = Array.isArray(card.mistakes) ? card.mistakes : [];
  const at = Array.isArray(card.mistake_at) ? card.mistake_at : [];
  const stepIn = (rr, m, i) => (at[i] != null ? stepOfCard(rr, at[i]) : mistakeStep(rr, m, kitchen));
  const swapped = new Set((r.swapped || []).map((x) => x.slot));
  const keep = list.map((m, i) => i).filter((i) => {
    if (!swapped.size || !base) return true;
    const k = stepIn(base, list[i], i);
    // шаг указан карточкой — пункт о продукте этого шага; иначе — и о тех, что он называет
    const own = [...(at[i] != null ? [] : mistakeSlots(base, list[i], kitchen)), ...(k != null && base.steps[k].ctx?.self ? [base.steps[k].ctx.self] : [])];
    return !own.some((id) => swapped.has(id));
  });
  r.mistakes = keep.map((i) => list[i]);
  r.mistake_steps = keep.map((i) => stepIn(r, list[i], i));
}

// У шага — tips: тексты его пунктов
export function attachTips(r) {
  for (const s of r.steps) delete s.tips;
  (r.mistakes || []).forEach((m, i) => {
    const k = r.mistake_steps?.[i];
    if (k != null && r.steps[k]) r.steps[k].tips = [...(r.steps[k].tips || []), m];
  });
}
