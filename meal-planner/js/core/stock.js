// Запасы дома без весов. Человек отмечает примерно: «половина пачки», «3 шт.», «кончается».
// Дальше приложение ведёт учёт само: купленное в «Покупках» прибавляется, приготовленное по плану — вычитается.
// Граммы остаются внутри (ими считают список покупок и подбор блюд), человеку показываются упаковки и штуки.
//
// state.pantry[key] = { have, grams?, at, src?, freshAt? }:
//   have — есть ли дома; grams — сколько (нет — «есть, сколько не знаю»: считаем, что хватает);
//   at — когда отмечено (с этого момента считаются покупки и готовка); src — 'user' | 'auto' (перенесено с прошлой недели);
//   freshAt — когда продукт появился дома (для «скоро испортится»).
// Записи с ':' в ключе — товары каталога («billa:123»), к рецептам не относятся.
import { scaledIngredients, chooseOffer, fmtNum } from './shopping.js';
import { dayDate, COOK_HOUR } from './calendar.js';
import { packShare } from './amounts.js';

const DAY = 86400000;

// Продукты, которые считают штуками: вес одной штуки и как её назвать
export const PIECES = {
  eggs: [60, 'шт.'], bell_pepper: [150, 'шт.'], lemon: [100, 'шт.'], cucumber: [400, 'шт.'], lettuce: [300, 'кочан'],
  leek: [250, 'шт.'], cauliflower: [800, 'кочан'], white_cabbage: [1200, 'кочан'], onion: [100, 'шт.'], carrot: [80, 'шт.'],
  tomato: [100, 'шт.'], banana: [120, 'шт.'], potatoes: [150, 'шт.'], garlic: [50, 'головка'], sweet_potato: [300, 'шт.'],
  spring_onion: [100, 'пучок'], parsley: [30, 'пучок'], tortilla: [40, 'шт.'], sausage_frankfurter: [50, 'шт.'], apple: [150, 'шт.'],
  protein_bar: [45, 'шт.'], protein_pudding: [200, 'стаканчик'],
};

// Уровни для продуктов в упаковках: доля обычной упаковки
export const PACK_LEVELS = [
  { id: 'none', f: 0, label: 'нет' }, { id: 'low', f: 0.15, label: 'почти нет' }, { id: 'quarter', f: 0.25, label: '¼' },
  { id: 'half', f: 0.5, label: '½' }, { id: 'most', f: 0.75, label: '¾' }, { id: 'full', f: 1, label: 'целая' },
  { id: 'two', f: 2, label: '2 уп.' }, { id: 'three', f: 3, label: '3 уп.' },
];
// Базовые (масло, соль, специи): без количества
export const BASIC_LEVELS = [{ id: 'ok', label: 'есть' }, { id: 'low', label: 'кончается' }, { id: 'none', label: 'нет' }];

export const isProductKey = (ref) => !String(ref).includes(':');

export function stockKind(key, product) {
  if (product?.basic) return 'basic';
  if (PIECES[key]) return 'pcs';
  return 'pack';
}

// Обычная упаковка продукта — та, что дешевле всего купить одной штукой (не развес, не оценка)
export function refPack(product) {
  const packs = (product?.packs || []).filter((p) => !p.loose && p.grams > 0 && p.pack_unit !== 'pcs');
  if (!packs.length) return null;
  return chooseOffer({ packs }, 1)?.pack || packs[0];
}
export const packGrams = (product) => refPack(product)?.grams || 500;
const unitOf = (product) => (refPack(product)?.pack_unit === 'ml' ? 'мл' : 'г');

// Граммы → понятная фраза: «≈ 4 шт.», «≈ половина упаковки 500 г», «почти нет»
export function describeStock(key, grams, product) {
  if (grams === Infinity || grams === true) return 'есть, сколько — не отмечено';
  if (!(grams > 0)) return 'нет';
  const kind = stockKind(key, product);
  if (kind === 'basic') return grams < 0.2 * packGrams(product) ? 'кончается' : 'есть';
  if (kind === 'pcs') {
    const [per, unit] = PIECES[key];
    const n = grams / per;
    if (n < 0.4) return `почти нет (≈ ${Math.round(grams)} г)`;
    const shown = key === 'eggs' || per <= 60 ? Math.max(1, Math.round(n)) : Math.round(n * 2) / 2;
    return `≈ ${fmtNum(shown, 1)} ${unit}`;
  }
  const pg = packGrams(product);
  const r = grams / pg;
  if (r < 0.2) return `почти нет (≈ ${Math.round(grams)} ${unitOf(product)})`;
  return packShare(grams, pg, unitOf(product)) || `≈ ${Math.round(grams)} ${unitOf(product)}`;
}

// Уровень → граммы. pcs — число штук, pack — id уровня, basic — 'ok' | 'low' | 'none'
export function levelGrams(key, product, level) {
  const kind = stockKind(key, product);
  if (kind === 'pcs') return Math.max(0, +level || 0) * PIECES[key][0];
  if (kind === 'basic') return level === 'none' ? 0 : packGrams(product) * (level === 'low' ? 0.1 : 1);
  const l = PACK_LEVELS.find((x) => x.id === level);
  return l ? l.f * packGrams(product) : 0;
}

// Какой уровень подсветить для текущего количества
export function nearestLevel(key, grams, product) {
  const kind = stockKind(key, product);
  if (grams === Infinity) return kind === 'basic' ? 'ok' : null;
  if (kind === 'pcs') return Math.round((grams || 0) / PIECES[key][0]);
  if (kind === 'basic') return !(grams > 0) ? 'none' : grams < 0.2 * packGrams(product) ? 'low' : 'ok';
  if (!(grams > 0)) return 'none';
  const r = grams / packGrams(product);
  return PACK_LEVELS.filter((l) => l.f > 0).reduce((a, b) => (Math.abs(b.f - r) < Math.abs(a.f - r) ? b : a)).id;
}

// Сколько дней продукт живёт дома (открытый или купленный свежим) — для «скоро испортится»
export function keepDays(key, storage) {
  const s = storage?.[key];
  if (!s) return 14;
  if (s.place === 'freezer') return 90;
  if (s.place === 'pantry' || s.place === 'cool') return key === 'potatoes' || key === 'onion' ? 30 : 180;
  if (s.place === 'counter') return ['bread', 'toast_bread'].includes(key) ? 4 : key === 'banana' ? 5 : 10;
  if (/mince/.test(key)) return 2;
  if (s.place === 'fridge' && /нижняя/.test(s.shelf || '')) return 3;
  if (['mushrooms', 'spring_onion', 'parsley', 'lettuce', 'mozzarella', 'cucumber'].includes(key)) return 5;
  if (['cottage_cheese', 'skyr', 'magertopfen', 'natural_yogurt', 'greek_yogurt', 'sour_cream', 'cream', 'tomato', 'bell_pepper', 'cauliflower', 'leek', 'protein_pudding'].includes(key)) return 7;
  if (['gouda', 'emmentaler', 'parmesan', 'eggs', 'butter', 'feta'].includes(key)) return 21;
  return 14;
}

// ---------- Учёт: готовка по плану ----------
const cookTime = (plan, day, meal) => { const d = dayDate(plan, day); d.setHours(COOK_HOUR[meal] ?? 18, 0, 0, 0); return d.getTime(); };

// Готовки плана по времени: [{ t, recipeId, items: [{ key, grams }] }]. План — уже без «ем вне дома» и «не ел»
export function cookEvents(plan, recipeMap) {
  if (!plan) return [];
  const out = [];
  // отмечено «приготовил / съел» — списываем в момент отметки (если раньше планового времени)
  const add = (recipeId, factor, portions, day, meal, key) => {
    const r = recipeMap.get(recipeId);
    if (!r) return;
    const items = scaledIngredients(r, factor, portions).filter((i) => i.key !== 'water' && i.grams > 0 && !i.optional).map((i) => ({ key: i.key, grams: i.grams }));
    const planned = cookTime(plan, day, meal);
    const marked = plan.done?.[key];
    out.push({ t: marked ? Math.min(marked, planned) : planned, recipeId, items, key, marked: !!marked });
  };
  for (const b of plan.batches || []) if (b.slots.length) add(b.recipeId, b.factor, b.slots.length, b.slots[0].day, b.slots[0].meal, `${b.slots[0].day}|${b.slots[0].meal}`);
  for (const x of plan.extras || []) add(x.recipeId, x.factor, 1, x.day, x.meal, x.id);
  return out.sort((a, b) => a.t - b.t);
}

// Сколько продукта ушло в готовку в промежутке (from, to]
export function usedBetween(events, key, from, to) {
  let g = 0;
  for (const e of events) if (e.t > from && e.t <= to) for (const i of e.items) if (i.key === key) g += i.grams;
  return g;
}

/**
 * Запасы сейчас: отмеченное + купленное после отметки − приготовленное после отметки.
 * bought: Map key → { grams, t } — отмеченные в «Покупках» позиции (сколько куплено и когда).
 * Возвращает { key: { grams, base, added, used, at, src, freshAt, unknown } } для всех продуктов,
 * которые отмечены дома, куплены или нужны плану.
 */
export function currentStock({ pantry = {}, events = [], bought = new Map(), now = Date.now() }) {
  const keys = new Set([...Object.keys(pantry).filter(isProductKey), ...bought.keys(), ...events.flatMap((e) => e.items.map((i) => i.key))]);
  const out = {};
  for (const key of keys) {
    const rec = pantry[key];
    const at = rec?.at || 0;
    const unknown = !!rec?.have && !(rec.grams > 0);
    const base = rec?.have ? (rec.grams > 0 ? rec.grams : Infinity) : 0;
    const b = bought.get(key);
    const added = b && b.t > at && b.t <= now ? b.grams : 0;
    const used = usedBetween(events, key, at, now);
    const grams = unknown ? Infinity : Math.max(0, base + added - used);
    const freshAt = added ? b.t : rec?.freshAt || at || null;
    out[key] = { grams, base, added, used, at, src: rec?.src || (rec ? 'user' : null), freshAt, unknown };
  }
  return out;
}

// Для списка покупок «на оставшееся»: отмеченное дома минус уже приготовленное с тех пор.
// Купленное не прибавляем — оно и так отмечено в списке. { key: граммы | true }
export function homeAt(pantry = {}, events = [], now = Date.now()) {
  const out = {};
  for (const [key, v] of Object.entries(pantry)) {
    if (!v?.have || !isProductKey(key)) continue;
    if (!(v.grams > 0)) { out[key] = true; continue; }
    const left = v.grams - usedBetween(events, key, v.at || 0, now);
    if (left > 0.5) out[key] = left;
  }
  return out;
}

// Граммы для подбора блюд: { key: граммы } (Infinity — есть, сколько не знаем). Базовые продукты считаем всегда в наличии
// (если не отмечено «нет»), иначе почти ни одно блюдо не соберётся.
export function stockGrams(stock, products = {}, pantry = {}) {
  const out = {};
  for (const [key, s] of Object.entries(stock)) if (s.grams > 0) out[key] = s.grams;
  for (const [key, p] of Object.entries(products)) {
    if (!p.basic || key in out) continue;
    if (pantry[key]?.have === false) continue;
    out[key] = Infinity;
  }
  return out;
}

// Скоро испортится: свежие продукты, которые лежат дома дольше 60 % своего срока. [{ key, days, left, over }]
export function expiringSoon(stock, storage, now = Date.now()) {
  const out = [];
  for (const [key, s] of Object.entries(stock)) {
    if (!(s.grams > 0) || s.grams === Infinity || !s.freshAt) continue;
    const keep = keepDays(key, storage);
    if (keep > 30) continue;
    const days = (now - s.freshAt) / DAY;
    if (days >= keep * 0.6) out.push({ key, days: Math.floor(days), left: Math.max(0, Math.ceil(keep - days)), over: days > keep });
  }
  return out.sort((a, b) => a.left - b.left);
}

// Новая неделя: остатки прошлой (по учёту) становятся отметками «дома». Товары каталога — как были.
export function rolloverPantry(pantry, stock, now = Date.now()) {
  const out = Object.fromEntries(Object.entries(pantry).filter(([k]) => !isProductKey(k)));
  for (const [key, s] of Object.entries(stock)) {
    const prev = pantry[key];
    if (s.unknown) { out[key] = { ...prev, have: true, grams: null, at: now }; continue; }
    if (s.grams > 1) out[key] = { have: true, grams: Math.round(s.grams), at: now, src: s.added || s.used ? 'auto' : prev?.src || 'user', freshAt: s.freshAt || now };
    else if (prev) out[key] = { have: false, grams: null, at: now, src: 'auto' };
  }
  return out;
}
