// Запасы дома без весов. Человек отмечает примерно: «половина пачки», «3 шт.», «кончается».
// Дальше приложение ведёт учёт само: купленное в «Покупках» прибавляется, приготовленное по плану — вычитается.
// Граммы остаются внутри (ими считают список покупок и подбор блюд), человеку показываются упаковки и штуки.
//
// state.pantry[key] = { have, grams?, at, src?, freshAt? }:
//   have — есть ли дома; grams — сколько (нет — «есть, сколько не знаю»: считаем, что хватает);
//   at — когда отмечено (с этого момента считаются покупки и готовка); src — 'user' | 'auto' (перенесено с прошлой недели);
//   freshAt — когда продукт появился дома (для «скоро испортится»).
// Записи с ':' в ключе — товары каталога («billa:123»), к рецептам не относятся.
import { scaledIngredients, chooseOffer, fmtNum, proportionalCost } from './shopping.js';
import { dayDate, COOK_HOUR } from './calendar.js';
import { packShare } from './amounts.js';
import { keepDays, lifeOf, endOfDayAfter, PIECE_SPLIT, DAY_MS } from './shelf.js';

const DAY = 86400000;

// Продукты, которые считают штуками: вес одной штуки и как её назвать
export const PIECES = {
  eggs: [60, 'шт.'], bell_pepper: [150, 'шт.'], lemon: [100, 'шт.'], cucumber: [400, 'шт.'], lettuce: [300, 'кочан'],
  leek: [250, 'шт.'], cauliflower: [800, 'кочан'], white_cabbage: [1200, 'кочан'], onion: [100, 'шт.'], carrot: [80, 'шт.'],
  tomato: [100, 'шт.'], banana: [120, 'шт.'], potatoes: [150, 'шт.'], garlic: [50, 'головка'], sweet_potato: [300, 'шт.'],
  spring_onion: [100, 'пучок'], parsley: [30, 'пучок'], tortilla: [40, 'шт.'], sausage_frankfurter: [50, 'шт.'], apple: [150, 'шт.'],
  protein_bar: [45, 'шт.'], protein_pudding: [200, 'стаканчик'], fruit_yogurt: [180, 'стаканчик'], croissant: [25, 'шт.'],
  // батончики — штуками (вес одного батончика или упаковки из двух палочек)
  snickers: [50, 'шт.'], twix: [50, 'шт.'], mars: [51, 'шт.'], kitkat: [41.5, 'шт.'], bounty: [57, 'шт.'], kinder_bueno: [43, 'шт.'], manner_wafers: [75, 'пачка'],
};

// Уровни для продуктов в упаковках: доля обычной упаковки
export const PACK_LEVELS = [
  { id: 'none', f: 0, label: 'нет' }, { id: 'low', f: 0.15, label: 'почти нет' }, { id: 'quarter', f: 0.25, label: 'четверть' },
  { id: 'half', f: 0.5, label: 'половина' }, { id: 'most', f: 0.75, label: 'три четверти' }, { id: 'full', f: 1, label: 'целая' },
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

// Сколько дней продукт живёт дома — из данных о сроках (core/shelf.js), а не свои числа (блок В: курица 3 → 1–2 дня)
export { keepDays } from './shelf.js';

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
 * Запасы сейчас: отмеченное + купленное после отметки − приготовленное после отметки, с вскрытием и порчей (блок В).
 * Учёт ведётся по пачкам: купленное — упаковками (packGrams), отмеченное дома — одной «пачкой». Готовка берёт сначала
 * вскрытое, затем то, что раньше истекает; первая готовка вскрывает пачку (штучное и развес — без вскрытия).
 * Срок пачки: закрытой — от покупки, вскрытой — min(закрытый, от вскрытия) (core/shelf.js). exp — по нижней границе
 * («проверьте свежесть»), expMax — по верхней: после него остаток считается испорченным и из запасов уходит.
 * Замороженное (frozenUntil) не портится до разморозки; после — живёт закрытый срок от разморозки.
 * bought: Map key → { grams, t, packGrams?, loose?, cost?, frozen?: [{ grams, until }] } или массив таких покупок.
 * Возвращает { key: { grams, base, added, used, at, src, freshAt, unknown, openedAt, exp, expMax, frozen, spoiled,
 * spoiledAt, spoiledCost, usedCost, boughtCost, perG } } для всех продуктов, которые отмечены дома, куплены или нужны плану.
 */
export function currentStock({ pantry = {}, events = [], bought = new Map(), now = Date.now(), storage = null, products = null }) {
  const keys = new Set([...Object.keys(pantry).filter(isProductKey), ...bought.keys(), ...events.flatMap((e) => e.items.map((i) => i.key))]);
  const out = {};
  for (const key of keys) out[key] = stockOf(key, { rec: pantry[key], events, buys: [].concat(bought.get(key) || []), now, storage, product: products?.[key] });
  return out;
}

function stockOf(key, { rec, events, buys, now, storage, product }) {
  const at = rec?.at || 0;
  const unknown = !!rec?.have && !(rec.grams > 0);
  const base = rec?.have ? (rec.grams > 0 ? rec.grams : Infinity) : 0;
  const life = lifeOf(key, storage);
  const dated = !!storage;
  const whole = PIECE_SPLIT.has(key);
  const refPerG = product ? proportionalCost(product, 1000) / 1000 : 0;
  const mkUnit = (grams, t, extra = {}) => {
    const u = { grams, rem: grams, t, openedAt: null, frozenUntil: null, perG: refPerG, ...extra };
    setExp(u);
    return u;
  };
  const setExp = (u) => {
    if (!dated) { u.exp = u.expMax = Infinity; return; }
    const from = u.frozenUntil != null ? u.frozenUntil : u.t;
    u.exp = endOfDayAfter(from, life.closed[0]);
    u.expMax = endOfDayAfter(from, life.closed[1]);
    if (u.openedAt != null) {
      u.exp = Math.min(u.exp, endOfDayAfter(u.openedAt, life.opened[0]));
      u.expMax = Math.min(u.expMax, endOfDayAfter(u.openedAt, life.opened[1]));
    }
  };
  const units = [];
  // отмеченное дома: одна «пачка»; неполная упаковка — уже вскрыта (с момента отметки или как было перенесено)
  if (base > 0 && base !== Infinity) {
    const pg = refPack(product)?.grams || 0;
    // в морозилке (перенесено с прошлой недели) — отдельно: не портится, берётся последним
    const fz = Math.min(base, Math.max(0, +rec.frozen || 0));
    if (fz > 0) units.push(mkUnit(fz, rec.freshAt || at, { frozenUntil: Infinity, home: true }));
    const g = base - fz;
    const partial = pg > 0 && !whole && Math.abs(g / pg - Math.round(g / pg)) > 0.1;
    if (g > 0) {
      const u = mkUnit(g, rec.freshAt || at, { openedAt: rec.openedAt ?? (partial ? at : null), home: true });
      if (rec.exp && dated) { u.exp = Math.min(u.exp, rec.exp); u.expMax = Math.min(u.expMax, rec.expMax || rec.exp); }
      units.push(u);
    }
  }
  // события по времени: покупки (после отметки) и готовки (после отметки)
  const timeline = [];
  for (const b of buys) if (b && b.t > at && b.t <= now) timeline.push({ t: b.t, buy: b });
  for (const e of events) if (e.t > at && e.t <= now) for (const i of e.items) if (i.key === key) timeline.push({ t: e.t, use: i.grams });
  timeline.sort((x, y) => x.t - y.t || (x.buy ? -1 : 1));
  let added = 0;
  let used = 0;
  let debt = 0; // готовка, на которую в учёте не было продукта (купили позже, чем отметили) — вычитается из следующей покупки
  let spoiled = 0;
  let spoiledAt = null;
  let spoiledCost = 0;
  let usedCost = 0;
  let boughtCost = 0;
  const spoilUntil = (t) => {
    for (const u of units) {
      if (!(u.rem > 0.5)) continue;
      if (u.frozenUntil != null && t < u.frozenUntil) continue; // в морозилке не портится
      if (u.expMax <= t) { spoiled += u.rem; spoiledCost += u.rem * u.perG; spoiledAt = Math.max(spoiledAt || 0, u.expMax); u.spoiled = u.rem; u.rem = 0; }
    }
  };
  const take = (g, t) => {
    const cand = units.filter((u) => u.rem > 1e-6 && (u.frozenUntil == null || u.frozenUntil <= t))
      .sort((a, b) => (b.openedAt != null) - (a.openedAt != null) || a.exp - b.exp);
    // замороженное, если больше нечего, — тоже берётся (разморозили раньше)
    for (const u of [...cand, ...units.filter((x) => x.rem > 1e-6 && x.frozenUntil != null && x.frozenUntil > t)]) {
      if (g <= 1e-6) break;
      const k = Math.min(g, u.rem);
      u.rem -= k; g -= k; usedCost += k * u.perG;
      if (u.openedAt == null && !whole && !u.loose) { u.openedAt = t; setExp(u); }
    }
    return g;
  };
  for (const ev of timeline) {
    spoilUntil(ev.t);
    if (ev.buy) {
      const b = ev.buy;
      const g = b.grams;
      added += g;
      const perG = b.cost && g > 0 ? b.cost / g : refPerG;
      boughtCost += g * perG;
      // покупка гасит «долг» готовки, на которую продукта по учёту не было
      let rest = g;
      if (debt > 0) { const k = Math.min(debt, rest); debt -= k; rest -= k; }
      const frozen = (b.frozen || []).filter((f) => f.grams > 0);
      for (const f of frozen) { const k = Math.min(rest, f.grams); if (k > 0) { units.push(mkUnit(k, b.t, { perG, frozenUntil: f.until, loose: !!b.loose })); rest -= k; } }
      const pg = b.packGrams > 0 && !b.loose && !whole ? b.packGrams : 0;
      const n = pg ? Math.max(1, Math.round(rest / pg)) : 1;
      for (let i = 0; i < n && rest > 1e-6; i++) { const k = i === n - 1 ? rest : Math.min(rest, pg); units.push(mkUnit(k, b.t, { perG, loose: !!b.loose })); rest -= k; }
    } else {
      used += ev.use;
      debt += take(ev.use, ev.t);
    }
  }
  spoilUntil(now);
  const left = units.filter((u) => u.rem > 0.5);
  const grams = unknown ? Infinity : Math.max(0, left.reduce((a, u) => a + u.rem, 0) - debt);
  const lastBuy = buys.filter((b) => b && b.t > at && b.t <= now).reduce((m, b) => Math.max(m, b.t), 0);
  const freshAt = lastBuy || rec?.freshAt || at || null;
  const opened = left.filter((u) => u.openedAt != null);
  return {
    grams, base, added, used, at, src: rec?.src || (rec ? 'user' : null), freshAt, unknown,
    openedAt: opened.length ? Math.min(...opened.map((u) => u.openedAt)) : null,
    exp: left.length && dated ? Math.min(...left.map((u) => (u.frozenUntil != null && u.frozenUntil > now ? Infinity : u.exp))) : null,
    expMax: left.length && dated ? Math.min(...left.map((u) => (u.frozenUntil != null && u.frozenUntil > now ? Infinity : u.expMax))) : null,
    frozen: left.filter((u) => u.frozenUntil != null && u.frozenUntil > now).reduce((a, u) => a + u.rem, 0),
    thawAt: left.filter((u) => u.frozenUntil != null && u.frozenUntil > now).reduce((m, u) => Math.min(m, u.frozenUntil), Infinity),
    spoiled, spoiledAt, spoiledCost, usedCost, boughtCost,
    leftCost: left.reduce((a, u) => a + u.rem * u.perG, 0), perG: refPerG,
  };
}

// Для списка покупок «на оставшееся»: отмеченное дома минус уже приготовленное с тех пор.
// Купленное не прибавляем — оно и так отмечено в списке. { key: граммы | true }
export function homeAt(pantry = {}, events = [], now = Date.now()) {
  const out = {};
  for (const [key, v] of Object.entries(pantry)) {
    if (!v?.have || !isProductKey(key)) continue;
    if (!(v.grams > 0)) { out[key] = true; continue; }
    if (v.expMax && now >= v.expMax && !(v.frozen > 0)) continue; // перенесённое с прошлой недели уже испортилось
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

// Скоро испортится: срок (по нижней границе, с учётом вскрытия) кончается в ближайшие полтора дня или прошло 60 % срока.
// [{ key, days, left, over, exp }]; без данных о сроках — по дням от покупки (keepDays)
export function expiringSoon(stock, storage, now = Date.now()) {
  const out = [];
  for (const [key, s] of Object.entries(stock)) {
    if (!(s.grams > 0) || s.grams === Infinity || !s.freshAt) continue;
    if (s.frozen >= s.grams - 0.5) continue; // всё в морозилке
    if (s.exp != null && Number.isFinite(s.exp)) {
      const life = (s.exp - s.freshAt) / DAY;
      if (life > 30) continue;
      const leftD = (s.exp - now) / DAY;
      const days = (now - s.freshAt) / DAY;
      if (leftD <= 1.5 || days >= life * 0.6) out.push({ key, days: Math.floor(days), left: Math.max(0, Math.ceil(leftD - 1e-9)), over: now >= s.exp, exp: s.exp, opened: s.openedAt != null });
      continue;
    }
    const keep = keepDays(key, storage);
    if (keep > 30) continue;
    const days = (now - s.freshAt) / DAY;
    if (days >= keep * 0.6) out.push({ key, days: Math.floor(days), left: Math.max(0, Math.ceil(keep - days)), over: days > keep });
  }
  return out.sort((a, b) => a.left - b.left);
}

// Новая неделя: остатки прошлой (по учёту) становятся отметками «дома». Испорченное уже не в запасах — не переносится;
// вскрытое переносится со временем вскрытия и сроком, замороженное — отдельно. Товары каталога — как были.
export function rolloverPantry(pantry, stock, now = Date.now()) {
  const out = Object.fromEntries(Object.entries(pantry).filter(([k]) => !isProductKey(k)));
  for (const [key, s] of Object.entries(stock)) {
    const prev = pantry[key];
    if (s.unknown) { out[key] = { ...prev, have: true, grams: null, at: now }; continue; }
    if (s.grams > 1) {
      const r = { have: true, grams: Math.round(s.grams), at: now, src: s.added || s.used ? 'auto' : prev?.src || 'user', freshAt: s.freshAt || now };
      if (s.openedAt != null) r.openedAt = s.openedAt;
      if (s.exp != null && Number.isFinite(s.exp)) { r.exp = s.exp; r.expMax = s.expMax; }
      if (s.frozen > 1) r.frozen = Math.round(s.frozen);
      out[key] = r;
    } else if (prev) out[key] = { have: false, grams: null, at: now, src: 'auto', ...(s.spoiled > 1 ? { spoiled: Math.round(s.spoiled) } : {}) };
  }
  return out;
}

// Итог недели по учёту: что куплено, использовано, испорчено (выброшено) и осталось — граммы и евро по продуктам.
// stock — currentStock на момент now (сейчас или конец недели по плану). Базовые (масло, соль, специи) не считаются.
export function weekLedger(stock, products = {}) {
  const rows = [];
  const tot = { bought: 0, used: 0, spoiled: 0, left: 0 };
  for (const [key, s] of Object.entries(stock)) {
    const p = products[key];
    if (!p || p.basic || s.unknown) continue;
    if (!(s.added > 0) && !(s.base > 0)) continue;
    const row = { key, name: p.name_ru, bought: s.added, boughtCost: s.boughtCost, used: s.used, usedCost: s.usedCost, spoiled: s.spoiled, spoiledCost: s.spoiledCost,
      spoiledAt: s.spoiledAt, left: s.grams === Infinity ? 0 : s.grams, leftCost: s.leftCost, exp: s.exp, openedAt: s.openedAt, frozen: s.frozen };
    rows.push(row);
    tot.bought += s.boughtCost || 0; tot.used += s.usedCost || 0; tot.spoiled += s.spoiledCost || 0; tot.left += s.leftCost || 0;
  }
  const all = tot.used + tot.spoiled + tot.left;
  return { rows, tot, usedPct: all > 0 ? Math.round((100 * tot.used) / all) : null, spoiledPct: all > 0 ? Math.round((100 * tot.spoiled) / all) : null };
}
