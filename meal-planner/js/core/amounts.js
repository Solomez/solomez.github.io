// Количества для человека: бытовые меры при другом размере порции (без «×0,8»),
// доля купленной упаковки и продукты, которые упоминаются в тексте шага.

const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
// «1/2» — первым вариантом: иначе «1» съедается как целое, и «/2» остаётся в тексте («1¼/2 ст. л.»)
const NUM = String.raw`(\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔])?|[½¼¾⅓⅔])`;
// число в начале меры: «1,5 ст. л.», «½ ч. л.», «1½ стакана», «2–3 зубчика», «1/2 ч. л.»
const LEAD = new RegExp(String.raw`^(\s*(?:по вкусу \()?)` + NUM + String.raw`(?:\s*[–-]\s*` + NUM + ')?');

export function parseNum(t) {
  t = t.trim();
  if (FRAC[t] != null) return FRAC[t];
  if (/^\d+\/\d+$/.test(t)) { const [a, b] = t.split('/').map(Number); return b ? a / b : null; }
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*([½¼¾⅓⅔])?$/);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.')) + (m[2] ? FRAC[m[2]] : 0);
}

// Красивое число: до четверти (ложки, стаканы) или до половинки (штуки, зубчики)
export function fmtQty(x, step = 0.25) {
  const v = Math.max(step, Math.round(x / step) * step);
  const whole = Math.floor(v + 1e-9);
  const rest = Math.round((v - whole) * 4) / 4;
  const fr = rest === 0.25 ? '¼' : rest === 0.5 ? '½' : rest === 0.75 ? '¾' : '';
  if (!whole) return fr || '¼';
  return `${whole}${fr}`;
}

const COUNTABLE = /(шт|зубч|ломт|филе|яйц|кубик|банк|стаканчик|пучок|пучк|средн|больш|мал|кусоч|горст|упаков|пачк|лист|веточ|щепот|долек|дольк)/;

// Пересчитать бытовую меру на другой размер порции. null — числа в мере нет.
export function scaleMeasure(text, scale) {
  if (!text || Math.abs(scale - 1) < 0.01) return text;
  const m = String(text).match(LEAD);
  if (!m) return null;
  const a = parseNum(m[2]);
  const b = m[3] != null ? parseNum(m[3]) : null;
  if (a == null) return null;
  let rest = String(text).slice(m[0].length);
  const step = COUNTABLE.test(rest) ? 0.5 : 0.25;
  const q = (x) => fmtQty(x * scale, step);
  const last = Math.max(step, Math.round(((b ?? a) * scale) / step) * step);
  rest = agree(rest, last);
  // граммы и миллилитры в скобках — тоже под новый размер порции: «⅔ стакана (150 г)» → «½ стакана (120 г)»
  rest = rest.replace(/\((~?\s?)(\d+)\s*(г|мл)\)/g, (_, t, n, u) => `(${t}${Math.round((+n * scale) / 5) * 5 || 5} ${u})`);
  return `${m[1]}${q(a)}${b != null ? '–' + q(b) : ''}${rest}`;
}

// «1 стакан» → «¾ стакана», «2 зубчик» → «2 зубчика»: дробь и 2–4 — родительный падеж единственного числа
const FORMS = { 'стакан': ['стакан', 'стакана', 'стаканов'], 'зубчик': ['зубчик', 'зубчика', 'зубчиков'], 'ломтик': ['ломтик', 'ломтика', 'ломтиков'],
  'кубик': ['кубик', 'кубика', 'кубиков'], 'стаканчик': ['стаканчик', 'стаканчика', 'стаканчиков'], 'пучок': ['пучок', 'пучка', 'пучков'],
  'банка': ['банка', 'банки', 'банок'], 'упаковка': ['упаковка', 'упаковки', 'упаковок'], 'горсть': ['горсть', 'горсти', 'горстей'],
  'щепотка': ['щепотка', 'щепотки', 'щепоток'], 'веточка': ['веточка', 'веточки', 'веточек'], 'яйцо': ['яйцо', 'яйца', 'яиц'],
  'долька': ['долька', 'дольки', 'долек'], 'ломтика': ['ломтик', 'ломтика', 'ломтиков'] };
const ALL = new Map(Object.values(FORMS).flatMap((f) => f.map((w) => [w, f])));
function agree(rest, qty) {
  const m = rest.match(/^(\s*)([а-яё]+)/i);
  if (!m || !ALL.has(m[2].toLowerCase())) return rest;
  const f = ALL.get(m[2].toLowerCase());
  const n = Number.isInteger(qty) ? qty : null;
  const form = n == null ? f[1] : n % 10 === 1 && n % 100 !== 11 ? f[0] : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? f[1] : f[2];
  return m[1] + form + rest.slice(m[0].length);
}

// Мера без числа («щепотка», «по вкусу»): словами
export function scaleWords(text, scale) {
  if (Math.abs(scale - 1) < 0.12) return text;
  if (scale >= 1.75) return `${text} — примерно вдвое больше`;
  return scale > 1 ? `чуть больше: ${text}` : `чуть меньше: ${text}`;
}

// Доля упаковки: «≈ почти вся пачка 500 г», «≈ половина упаковки 400 г», «≈ 1 упаковка 500 г и ещё треть»
const SHARES = [[0.25, 'четверть'], [1 / 3, 'треть'], [0.5, 'половина'], [2 / 3, 'две трети'], [0.75, 'три четверти']];
export function packShare(grams, packGrams, unit = 'г') {
  if (!(grams > 0) || !(packGrams > 0)) return null;
  const r = grams / packGrams;
  const size = `${Math.round(packGrams)} ${unit}`;
  if (r < 0.2) return null;
  if (r >= 0.9 && r <= 1.05) return `≈ ${r < 0.97 ? 'почти вся' : 'вся'} упаковка ${size}`;
  if (r < 0.9) {
    const [, w] = SHARES.reduce((best, s) => (Math.abs(s[0] - r) < Math.abs(best[0] - r) ? s : best));
    return `≈ ${w} упаковки ${size}`;
  }
  const n = Math.floor(r + 0.05);
  const f = r - n;
  const tail = f < 0.15 ? '' : ` и ещё ${SHARES.reduce((best, s) => (Math.abs(s[0] - f) < Math.abs(best[0] - f) ? s : best))[1]}`;
  return `≈ ${n} ${n === 1 ? 'упаковка' : n < 5 ? 'упаковки' : 'упаковок'} ${size}${tail}`;
}

// Какие продукты упоминаются в тексте шага: по основам значимых слов названия, только с начала слова
const GENERIC = new Set(['свежий', 'свежая', 'свежие', 'замороженный', 'замороженная', 'замороженные', 'консервированный', 'консервированная',
  'консервированные', 'длиннозёрный', 'обезжиренный', 'натуральный', 'сладкий', 'острый', 'молотый', 'молотая', 'сушёный', 'сушёная', 'репчатый',
  'красный', 'красная', 'белый', 'белая', 'зелёный', 'зелёная', 'тёртый', 'твёрдый', 'густой', 'жирный', 'средний', 'целый', 'свежемолотый']);
const KEY_WORDS = { chicken: ['кур', 'филе'], pork: ['свинин', 'мяс'], beef: ['говядин', 'мяс'], mince: ['фарш'], turkey: ['индейк', 'мяс'] };
// Основы слова для поиска в тексте шага. У главного (первого значимого) слова названия — ещё и без последней гласной
// («мука» → «мук»: «муку», «мукой») и с беглой «е» («перец» → «перц»: «перца»). У остальных слов — нет:
// «томаты в собственном соку» не должны находиться по «соком лимона», «вода для риса» — по «с рисом»
const NO_SHORT = new Set(['вода']);
const stems = (w, head) => {
  const out = [w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 2))];
  if (head && w.length === 4 && /[аяоеиыуюьй]$/.test(w) && !NO_SHORT.has(w)) out.push(w.slice(0, 3));
  if (head && /ец$/.test(w) && w.length >= 5) out.push(w.slice(0, -2) + 'ц');
  return out;
};
const GEN = new Set([...GENERIC].map((w) => w.replace(/ё/g, 'е')));
export function stepIngredients(recipe, text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е') + ' ';
  const tokens = t.split(/[^а-яa-z]+/).filter(Boolean);
  const at = (s) => tokens.reduce((a, tok, i) => (tok.startsWith(s) ? [...a, i] : a), []);
  const found = recipe.ingredients.map((i) => {
    // у заменённого в блюде ингредиента шаги называют исходный продукт («нарежь лук» — это теперь лук-порей)
    const ws = (i.replaced?.name_ru || i.name_ru || '').toLowerCase().replace(/ё/g, 'е').split(/[^а-яa-z]+/).filter((w) => w.length >= 3 && !GEN.has(w));
    const pos = ws.map((w, k) => [w, stems(w, k === 0).flatMap(at)]).filter(([, p]) => p.length);
    return { i, got: pos.map(([w]) => w), pos };
  });
  // «чёрный перец» рядом в тексте называет именно его — «перец сладкий» (совпало только «перец») в этом шаге не нужен.
  // Только когда слова идут подряд: «лук …, порей» — это два продукта, оба остаются
  const phrase = (f) => f.got.length >= 2 && f.pos.every(([, p]) => f.pos.some(([, q]) => p.some((x) => q.some((y) => Math.abs(x - y) === 1))));
  const drop = new Set(found.filter((f) => f.got.length && found.some((o) => o !== f && phrase(o) && o.got.length > f.got.length && f.got.every((w) => o.got.includes(w)))).map((f) => f.i));
  return recipe.ingredients.filter((i) => {
    const f = found.find((x) => x.i === i);
    if (f.got.length) return !drop.has(i);
    const kw = Object.entries(KEY_WORDS).find(([k]) => (i.replaced?.key || i.key).startsWith(k));
    return !!kw && !i.basic && kw[1].some((s) => at(s).length);
  });
}

// Короткий словарь для новичка: термины, которые встретились в шаге (P2, P1 — S6: «щепотка», «ст. л.» угадывали)
const TERMS = [
  [/ст\.\s?л\./, 'ст. л. — столовая ложка, ≈ 15 мл (без горки)'],
  [/ч\.\s?л\./, 'ч. л. — чайная ложка, ≈ 5 мл'],
  [/щепот/, 'щепотка — сколько берётся тремя пальцами, ≈ 0,5 г'],
  [/по вкусу/, 'по вкусу — начните с малого, попробуйте и добавьте ещё, если нужно'],
  [/до кипени/, 'довести до кипения — нагревать, пока по всей поверхности не пойдут крупные пузыри'],
  [/слаб\S* (огн|кипени)|томит|огонь: слаб/, 'на слабом огне — едва заметные пузырьки, ничего не бурлит'],
  [/средн\S* огн|огонь: средн/, 'средний огонь — ручка плиты примерно посередине; масло шипит, но не дымит'],
  [/сильн\S* огн|огонь: сильн/, 'сильный огонь — почти максимум; продукты сразу шкворчат, помешивать часто'],
  [/до золотист/, 'до золотистого — светло-коричневый цвет, как у корочки хлеба'],
  [/до мягкости/, 'до мягкости — легко прокалывается ножом или вилкой, без сопротивления'],
  [/до прозрачност/, 'до прозрачности (лук) — стал прозрачным и мягким, но ещё не коричневым'],
  [/зубчик/, 'зубчик — одна долька из головки чеснока'],
];
export function stepTerms(...texts) {
  const t = texts.join(' ').toLowerCase().replace(/ё/g, 'е');
  return TERMS.filter(([re]) => re.test(t)).map(([, s]) => s);
}
