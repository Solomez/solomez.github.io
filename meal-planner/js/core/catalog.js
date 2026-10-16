// Каталог продуктов магазинов (Billa, Spar, Penny): загрузка по требованию, поиск по-русски, по-английски
// и по-немецки, полки и зоны. Строка товара: [id, name, brand, shelf, price, size, unit, per, img, url, concepts, by_weight].

const cache = new Map(); // ключ магазина → Promise<{ store, items: [...] }>

export function aisles(data) {
  const a = data?.aisles || {};
  if (!a._index) {
    a._index = {
      zone: Object.fromEntries((a.zones || []).map((z) => [z.id, z])),
      shelf: Object.fromEntries((a.shelves || []).map((s) => [s.id, s])),
      concept: Object.fromEntries((a.concepts || []).map((c) => [c.id, c])),
    };
  }
  return a._index;
}

export function loadStore(base, key) {
  if (!cache.has(key)) {
    cache.set(key, fetch(`${base}catalog/${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`каталог ${key}: ${r.status}`);
      return r.json();
    }).then((doc) => ({
      key,
      store: doc.store,
      fetched: doc.fetched,
      items: doc.items.map((row) => toItem(key, doc, row)),
    })).catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

function toItem(key, doc, r) {
  const [id, name, brand, shelf, price, size, unit, per, img, url, concepts, byWeight] = r;
  return {
    ref: `${key}:${id}`, key, id: String(id), store: doc.store, name, brand, shelf, price, size, unit, per,
    image: img ? (/^https?:/.test(img) ? img : doc.img_base + img) : null,
    url: url ? (/^https?:/.test(url) ? url : doc.url_base + url) : null,
    concepts: concepts || [], byWeight: !!byWeight,
  };
}

// Упаковка как у продуктов из рецептов — чтобы работали миниатюры и просмотр фото
export const asPack = (it) => ({
  store: it.store, name_de: [it.brand, it.name].filter(Boolean).join(' · ').replace(/^(.+) · \1/, '$1'), price_eur: it.price, image: it.image, url: it.url,
  pack_size: it.size || 1, pack_unit: it.unit || 'pcs', grams: it.unit === 'pcs' ? null : it.size, eur_per_kg: it.per, loose: it.byWeight, stale: false,
});

export function packText(it) {
  if (it.byWeight) return 'на развес, цена за кг';
  if (!it.size) return '';
  if (it.unit === 'pcs') return `${it.size} шт.`;
  if (it.size >= 1000) return `${String(+(it.size / 1000).toFixed(2)).replace('.', ',')} ${it.unit === 'ml' ? 'л' : 'кг'}`;
  return `${Math.round(it.size)} ${it.unit === 'ml' ? 'мл' : 'г'}`;
}
export const perText = (it) => (it.per ? `${String(it.per.toFixed(2)).replace('.', ',')} €/${it.unit === 'pcs' ? 'шт.' : it.unit === 'ml' ? 'л' : 'кг'}` : '');

// Подпись вида продукта: «Сметана · Sour cream»
export function conceptLabel(data, it) {
  const c = aisles(data).concept[it.concepts?.[0]];
  return c ? { ru: c.ru, en: c.en, de: c.de } : null;
}

const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[ß]/g, 'ss').replace(/[äöü]/g, (m) => ({ ä: 'a', ö: 'o', ü: 'u' })[m]);

// Виды продуктов под слово запроса: id → вес совпадения.
// Основное название совпало целиком — 6, дополнительное целиком — 4, слово в названии начинается с запроса — 2.
const words = (s) => norm(s).split(/[\s,()/-]+/).filter(Boolean);
function conceptsFor(data, word) {
  const w = norm(word);
  const out = new Map();
  if (w.length < 2) return out;
  for (const c of data?.aisles?.concepts || []) {
    const main = [c.ru, c.en].map(norm);
    const alt = [...(c.ru_alt || []), ...(c.en_alt || [])].map(norm);
    let score = 0;
    if (main.some((n) => n === w || n.split(' (')[0] === w)) score = 6;
    else if (alt.some((n) => n === w)) score = 4;
    else if ([...main, ...alt].some((n) => words(n).some((p) => p.startsWith(w)))) score = 2;
    if (score) out.set(c.id, score);
  }
  return out;
}

// Фраза из нескольких слов («пекарская бумага», «chicken breast») — вид продукта, в одном названии которого есть все слова
function conceptsForPhrase(data, q) {
  const ws = words(q);
  const out = new Map();
  if (ws.length < 2) return out;
  for (const c of data?.aisles?.concepts || []) {
    const names = [c.ru, c.en, ...(c.ru_alt || []), ...(c.en_alt || [])];
    const hit = names.find((n) => { const nw = words(n); return ws.every((w) => nw.some((p) => p.startsWith(w))); });
    if (hit) out.set(c.id, words(hit).length === ws.length ? 8 : 6);
  }
  return out;
}

// Поиск: каждое слово должно найтись — в названии, бренде или в виде продукта (по-русски/по-английски);
// либо вся фраза — название вида продукта. Выше — точнее совпавшие, при равенстве — дешевле за кг.
export function search(data, items, q, { limit = 80 } = {}) {
  const ws = norm(q).split(/\s+/).filter(Boolean);
  if (!ws.length) return [];
  const byWord = ws.map((w) => conceptsFor(data, w));
  const phrase = conceptsForPhrase(data, q);
  const cScore = (it, m) => {
    let best = 0;
    it.concepts.forEach((c, i) => { const v = m.get(c); if (v) best = Math.max(best, i === 0 ? v : v * 0.6); });
    return best;
  };
  const scored = [];
  for (const it of items) {
    const hay = norm(` ${it.name} ${it.brand || ''} `);
    const ph = cScore(it, phrase);
    let score = ph * ws.length;
    let ok = ph > 0;
    if (!ok) {
      ok = true;
      score = 0;
      for (let i = 0; i < ws.length; i++) {
        const viaConcept = cScore(it, byWord[i]);
        const inName = hay.includes(ws[i]) ? (hay.includes(' ' + ws[i]) ? 3 : 1) : 0;
        if (!viaConcept && !inName) { ok = false; break; }
        score += Math.max(viaConcept, inName) + (viaConcept && inName ? 1 : 0);
      }
    }
    if (ok) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.it.per ?? 1e9) - (b.it.per ?? 1e9));
  return scored.slice(0, limit).map((x) => x.it);
}

// Полки зоны с числом товаров в загруженных магазинах
export function shelvesOf(data, zone, items) {
  const counts = {};
  for (const it of items) counts[it.shelf] = (counts[it.shelf] || 0) + 1;
  return (data?.aisles?.shelves || []).filter((s) => s.zone === zone && counts[s.id]).map((s) => ({ ...s, n: counts[s.id] }));
}

// Где лежит: полка → зона → подписи; свои пометки пользователя («лежит в другом отделе») важнее
export function placeOf(data, { shelf, store, ref }, places) {
  const idx = aisles(data);
  const own = store && ref ? places?.[store]?.[ref] : null;
  const sh = idx.shelf[own || shelf];
  const zn = sh ? idx.zone[sh.zone] : null;
  return sh ? { shelf: sh, zone: zn, own: !!own } : null;
}
