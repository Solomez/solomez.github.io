// Сроки хранения — из данных (data/shelf-life.json → storage.json[key].life, собирает scripts/build_data.py):
// closed — дней в закрытой упаковке от покупки, opened — после вскрытия, freezer — месяцев в морозилке; [мин, макс].
// Приложение планирует по нижней границе (как в исследовании блока В): купил в Пн, срок 1 день — годно по Вт включительно.
// Своих чисел здесь нет: только запасной срок для продукта, которого нет в данных (свой товар, новый продукт).

export const DAY_MS = 86400000;

// Штучное, которое делится на отдельные штуки (вскрытая сетка лука не вскрывает каждую луковицу; батончики и стаканчики
// запечатаны по одному) — как в симуляции блока В. Мини-круассаны, сосиски, тортильи — пачкой: вскрыл — срок вскрытой.
export const PIECE_SPLIT = new Set(['eggs', 'bell_pepper', 'lemon', 'cucumber', 'leek', 'cauliflower', 'white_cabbage', 'onion', 'carrot', 'tomato',
  'banana', 'potatoes', 'garlic', 'apple', 'sweet_potato', 'protein_bar', 'protein_pudding', 'fruit_yogurt', 'snickers', 'twix', 'mars', 'kitkat', 'bounty', 'kinder_bueno']);
// Нет данных о сроке — осторожно, как у «обычного» охлаждённого продукта; помечается estimate
const FALLBACK = { closed: [7, 14], opened: [3, 5], freezer: null, perishable: false, estimate: true, src: [] };

export const lifeOf = (key, storage) => storage?.[key]?.life || FALLBACK;
export const hasLife = (key, storage) => !!storage?.[key]?.life;

// Дней в закрытой упаковке и после вскрытия (по нижней границе; hi — по верхней)
export const closedDays = (key, storage, hi = false) => lifeOf(key, storage).closed[hi ? 1 : 0];
export const openedDays = (key, storage, hi = false) => lifeOf(key, storage).opened[hi ? 1 : 0];
export const isPerishable = (key, storage) => !!lifeOf(key, storage).perishable;

// Сколько дней продукт живёт дома после покупки — для «скоро испортится»
export function keepDays(key, storage) {
  return closedDays(key, storage);
}

// За сколько дней до готовки можно покупать, не теряя свежести: срок в закрытой упаковке (не больше двух недель —
// дальше поход всё равно в пределах плана)
export function buyAheadDays(key, storage) {
  return Math.min(14, closedDays(key, storage));
}

// Можно ли заморозить как есть, в день покупки (не «нарезанным», не «не рекомендуется»): есть срок в морозилке
// и в советах по хранению — «да» или «можно»
export function canFreeze(key, storage) {
  const s = storage?.[key];
  return !!s?.life?.freezer && /^(да|можно)(?![а-яё])/i.test(s.freeze || "");
}

// Нужно ли заморозить сразу: продукт понадобится через inDays дней, а в закрытой упаковке столько не проживёт
export function mustFreeze(key, storage, inDays) {
  return inDays > closedDays(key, storage) && canFreeze(key, storage);
}

// Как размораживать: сырое мясо и фарш — в холодильнике с вечера; хлеб и выпечка — на столе; соусы и песто — сразу в готовку
export function thawWay(key, storage) {
  const s = storage?.[key] || {};
  if (s.place === 'fridge' && /нижняя/.test(s.shelf || '')) return 'fridge';
  if (s.place === 'counter' || ['bread', 'toast_bread', 'croissant', 'tortilla'].includes(key)) return 'counter';
  if (['pesto', 'tomato_paste', 'tomatoes_can', 'passata', 'ginger', 'cream'].includes(key)) return 'direct';
  return 'fridge';
}

// Срок «до конца дня»: начало дня покупки + (days + 1) суток
export function endOfDayAfter(t, days) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days + 1);
  return d.getTime();
}

// Подпись срока для карточки продукта: «1–2 дня в закрытой упаковке», с источником или «оценка»
const dn = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней');
export function rangeDays([a, b]) {
  if (a >= 365 && b >= 365) return a === b ? `${Math.round(a / 365)} г.` : `${Math.round(a / 365)}–${Math.round(b / 365)} г.`;
  if (a >= 60) return `${Math.round(a / 30)}–${Math.round(b / 30)} мес.`;
  if (a === 0 && b <= 1) return 'в тот же день, самое позднее — на следующий';
  return a === b ? `${a} ${dn(a)}` : `${a}–${b} ${dn(b)}`;
}
export function lifeWords(key, storage) {
  const l = storage?.[key]?.life;
  if (!l) return null;
  return {
    closed: rangeDays(l.closed),
    opened: rangeDays(l.opened),
    freezer: l.freezer ? `${l.freezer[0] === l.freezer[1] ? l.freezer[0] : l.freezer.join('–')} мес.` : null,
    source: l.estimate ? `оценка${l.src.length ? ` (с опорой на ${l.src.join(', ')})` : ''}` : l.src.join(', '),
  };
}
