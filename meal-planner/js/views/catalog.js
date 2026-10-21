// «Продукты»: каталог магазинов с фото (поиск по-русски, по-английски и по-немецки, обзор по отделам),
// что есть дома (от этого зависит список покупок) и свои товары в списке покупок.
import { h, eur, num, sheet, toast, icon, seg, plural } from '../ui.js';
import { state, save, targets } from '../state.js';
import { loadStore, search, asPack, packText, perText, conceptLabel, aisles, shelvesOf } from '../core/catalog.js';
import { formatAmount, planNeeds } from '../core/shopping.js';
import { remainingPlan } from '../core/calendar.js';
import { effectivePlan } from '../core/planner.js';
import { describeStock, stockKind, levelGrams, nearestLevel, PACK_LEVELS, BASIC_LEVELS, PIECES, refPack, isProductKey } from '../core/stock.js';
import { rankByHome, cookableNow } from '../core/suggest.js';
import { homeForPlanning } from './money.js';
import { photo, thumbPack } from './products.js';
import { manualItems } from '../core/custom.js';
import { manualItemSheet } from './manual.js';

const STORE_KEYS = [['billa', 'Billa'], ['spar', 'Spar'], ['penny', 'Penny']];
const ui = { tab: 'catalog', q: '', zone: null, shelf: null, stores: null, limit: 60 };
let loaded = {}; // ключ магазина → { items } после загрузки

const storeKeyOf = (name) => (STORE_KEYS.find(([, n]) => n === name) || [])[0];
const selectedStores = () => ui.stores || state.prefs.catalogStores || STORE_KEYS.map(([k]) => k);

async function ensureLoaded(keys) {
  const base = state.data.base || 'data/';
  await Promise.all(keys.map(async (k) => { if (!loaded[k]) loaded[k] = await loadStore(base, k); }));
  return keys.flatMap((k) => loaded[k]?.items || []);
}

// ---------- Свои товары в списке покупок ----------
export function cartEntryOf(it, qty = 1) {
  return { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ref: it.ref, name: it.name, brand: it.brand || '', store: it.store,
    shelf: it.shelf, price: it.price, size: it.size, unit: it.unit, per: it.per, image: it.image, url: it.url, byWeight: it.byWeight, concepts: it.concepts, qty, at: Date.now() };
}
export function addToCart(it, qty = 1) {
  const same = state.cart.find((c) => c.ref === it.ref && !c.done);
  if (same) same.qty += qty;
  else state.cart.push(cartEntryOf(it, qty));
  save();
  toast(`В списке: ${it.name}`, { label: 'Отменить', onClick: () => { if (same) same.qty -= qty; else state.cart = state.cart.filter((c) => c.ref !== it.ref || c.done); save(); window.dispatchEvent(new Event('hashchange')); } });
}
export const cartTotal = (items) => Math.round(items.reduce((a, c) => a + (c.price || 0) * (c.byWeight ? 1 : c.qty), 0) * 100) / 100;

// ---------- Что есть дома ----------
export function setHome(ref, info) {
  if (info === null) delete state.pantry[ref];
  else state.pantry[ref] = { ...(state.pantry[ref] || {}), ...info, at: Date.now() };
  save();
}
// Для списка покупок: { key: граммы | true }
export function homeMap() {
  const out = {};
  for (const [ref, v] of Object.entries(state.pantry)) if (v?.have && !ref.includes(':')) out[ref] = v.grams > 0 ? v.grams : true;
  return out;
}

// «Есть дома» для товара каталога; свой товар, введённый вручную, — запасом своего продукта (уровни, учёт готовки)
function markHome(it) {
  const p = it.pkey && state.data.products[it.pkey];
  if (p) setStock(it.pkey, levelGrams(it.pkey, p, stockKind(it.pkey, p) === 'pcs' ? 1 : 'full'));
  else setHome(it.ref, { have: true, name: it.name, store: it.store, shelf: it.shelf, image: it.image });
  return p ? it.pkey : null;
}

// ---------- Карточка товара каталога ----------
function itemCard(it, { onPick, pickLabel = 'Взял это' } = {}) {
  const label = conceptLabel(state.data, it);
  const shelf = aisles(state.data).shelf[it.shelf];
  const inCart = state.cart.filter((c) => c.ref === it.ref && !c.done).reduce((a, c) => a + c.qty, 0);
  const home = state.pantry[it.pkey || it.ref]?.have;
  const product = { name_ru: label?.ru || it.name, packs: [asPack(it)] };
  return h('li', { class: 'cat-item' },
    photo(product, asPack(it), { cls: 'thumb lg', label: it.name }),
    h('div', { class: 'cat-main' },
      h('span', { class: 'cat-name', lang: it.manual ? null : 'de' }, it.name, it.manual ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'свой') : null),
      h('span', { class: 'muted' }, [it.brand, label ? `${label.ru} · ${label.en}` : shelf ? `${shelf.ru} · ${shelf.en}` : null].filter(Boolean).join(' · ')),
      h('span', null, it.price ? h('b', null, eur(it.price)) : h('span', { class: 'muted' }, 'цена не указана'), h('span', { class: 'muted' }, ` · ${[packText(it), perText(it), it.store].filter(Boolean).join(' · ')}`)),
      h('div', { class: 'cat-actions' },
        onPick
          ? h('button', { class: 'btn small primary', onclick: () => onPick(it) }, pickLabel)
          : [
            h('button', { class: 'btn small' + (inCart ? ' on' : ''), onclick: () => { addToCart(it); window.dispatchEvent(new Event('hashchange')); } }, icon('plus'), inCart ? `В списке: ${inCart}` : 'В список'),
            h('button', { class: 'btn small ghost' + (home ? ' on' : ''), 'aria-pressed': String(!!home),
              onclick: () => { if (home) setHome(it.pkey || it.ref, null); else markHome(it); window.dispatchEvent(new Event('hashchange')); } },
            icon('home'), home ? 'Есть дома' : 'Дома есть?'),
          ],
        it.url && /^https?:/.test(it.url) ? h('a', { class: 'small-link', href: it.url, target: '_blank', rel: 'noopener' }, 'в магазине') : null)));
}

// Результаты поиска или полки — подгружаются порциями
function itemList(items, opts) {
  const shown = items.slice(0, ui.limit);
  return h('div', null,
    h('ul', { class: 'cat-list' }, shown.map((it) => itemCard(it, opts))),
    items.length > shown.length ? h('button', { class: 'btn wide', onclick: (e) => { ui.limit += 60; e.target.closest('div').replaceWith(itemList(items, opts)); } }, `Показать ещё (${items.length - shown.length})`) : null);
}

// ---------- Выбор товара из каталога (для «взял другое» и «добавить в список») ----------
// Внизу всегда «Нет в каталоге — добавить вручную»: введённый товар становится своим и приходит в onPick как товар каталога
// (it.manual, it.pkey — ключ своего продукта); такие товары потом находятся здесь же поиском
export function pickFromCatalog({ title, store, query = '', onPick, pickLabel }) {
  const key = store ? storeKeyOf(store) : null;
  const keys = key ? [key] : selectedStores();
  const input = h('input', { type: 'search', placeholder: 'Что ищете? По-русски, по-немецки или по-английски', value: query, 'aria-label': 'Поиск в каталоге' });
  const out = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Загружаю каталог…'));
  const mine = manualItems(state.custom?.products, store);
  let items = mine;
  let close;
  const pick = (x) => { close(); onPick(x); };
  const manual = h('p', { class: 'muted', style: { margin: '4px 0 0' } }, 'Нет в каталоге? ',
    h('button', { class: 'linkbtn', onclick: () => { close(); manualItemSheet({ name: input.value.trim(), store, submit: pickLabel || 'Добавить', onSave: (it) => onPick(it) }); } }, 'Добавить вручную'),
    ' — любой товар из Hofer, Lidl, азиатского магазина, с ценой и КБЖУ.');
  const draw = () => {
    const found = search(state.data, items, input.value, { limit: 40 });
    out.replaceChildren(input.value.trim()
      ? (found.length ? h('ul', { class: 'cat-list' }, found.map((it) => itemCard(it, { onPick: pick, pickLabel }))) : h('p', { class: 'muted' }, navigator.onLine ? 'Ничего не нашлось. Попробуйте другое слово — например, по-немецки — или добавьте вручную.' : 'Нет сети — каталог магазина откроется, когда сеть вернётся. Можно добавить товар вручную.'))
      : h('div', { class: 'stack' },
        h('p', { class: 'muted' }, items.length > mine.length ? `Каталог ${key ? store : 'магазинов'}: ${items.length - mine.length} товаров. Начните вводить название.` : 'Загружаю каталог…'),
        mine.length ? h('div', { class: 'eyebrow' }, 'Ваши товары, добавленные вручную') : null,
        mine.length ? h('ul', { class: 'cat-list' }, mine.slice(0, 10).map((it) => itemCard(it, { onPick: pick, pickLabel }))) : null));
  };
  input.addEventListener('input', draw);
  close = sheet(title, h('div', { class: 'stack' }, input, out, manual));
  draw();
  ensureLoaded(keys).then((all) => { items = [...mine, ...all]; draw(); input.focus(); }).catch(() => out.replaceChildren(h('p', { class: 'notice' }, 'Не удалось загрузить каталог. Проверьте интернет — или добавьте товар вручную.')));
}

// «Нет в каталоге — добавить вручную» под поиском: сохранённый товар сразу находится этим поиском
function manualLink(redraw) {
  return h('p', { class: 'muted', style: { marginTop: '10px' } }, 'Нет нужного? Онлайн-магазины продают не всё — ',
    h('button', { class: 'linkbtn', onclick: () => manualItemSheet({ name: ui.q.trim(), submit: 'Сохранить', onSave: (it) => { ui.q = it.name; redraw(); toast(`Сохранено: ${it.name}. Теперь его можно добавить в список или отметить дома.`); } }) }, 'добавьте товар вручную'),
    ' (Hofer, Lidl, азиатский магазин), с ценой и КБЖУ.');
}

// ---------- Экран ----------
export function renderProducts(root, rerender, params) {
  const redraw = () => rerender({ keepScroll: true });
  // вкладка из ссылки («изменить запасы» → Дома) — только при переходе по ней, дальше переключается как обычно
  const want = params?.get('tab');
  if (want && want !== ui.appliedTab && ['catalog', 'home', 'cart'].includes(want)) ui.tab = want;
  ui.appliedTab = want || null;
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Продукты')));
  root.append(h('p', { class: 'muted', style: { marginTop: '-8px' } }, 'Что есть дома, свои товары и каталог Billa, Spar и Penny — чтобы добавить в список что-то сверх плана.'));
  const cartOpen = state.cart.filter((c) => !c.done);
  root.append(h('div', { style: { marginBottom: '12px' } }, seg([['catalog', 'Каталог'], ['home', 'Дома'], ['cart', `Мой список${cartOpen.length ? ' · ' + cartOpen.length : ''}`]], ui.tab, (v) => { ui.tab = v; ui.limit = 60; redraw(); })));
  if (ui.tab === 'home') return renderHome(root, redraw, rerender);
  if (ui.tab === 'cart') return renderCart(root, redraw);

  // Каталог
  const keys = selectedStores();
  root.append(h('div', { class: 'chips', style: { marginBottom: '10px' } }, STORE_KEYS.map(([k, name]) => {
    const on = keys.includes(k);
    return h('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => {
      const set = new Set(keys);
      if (on && set.size > 1) set.delete(k); else set.add(k);
      state.prefs.catalogStores = [...set];
      ui.stores = null;
      save();
      redraw();
    } }, name);
  })));
  const input = h('input', { type: 'search', id: 'cat-q', value: ui.q, placeholder: 'Поиск: сметана, sour cream, Sauerrahm…', 'aria-label': 'Поиск в каталоге',
    oninput: (e) => { ui.q = e.target.value; ui.limit = 60; clearTimeout(input._t); input._t = setTimeout(() => rerender({ keepScroll: true, keepFocus: true }), 250); } });
  root.append(input);
  const body = h('div', { style: { marginTop: '12px' } }, h('p', { class: 'muted' }, 'Загружаю каталог…'));
  root.append(body);
  const missing = keys.filter((k) => !loaded[k]);
  if (missing.length) {
    ensureLoaded(keys).then(() => redraw()).catch(() => body.replaceChildren(h('p', { class: 'notice' }, 'Не удалось загрузить каталог. Проверьте интернет и обновите страницу.')));
    return;
  }
  const items = keys.flatMap((k) => loaded[k].items);
  const idx = aisles(state.data);
  body.replaceChildren();

  if (ui.q.trim()) {
    const found = search(state.data, [...manualItems(state.custom?.products), ...items], ui.q, { limit: 400 });
    body.append(h('p', { class: 'muted', style: { marginTop: 0 } }, found.length ? `Найдено: ${found.length}${found.length === 400 ? '+' : ''}. Сначала — самые похожие, при равенстве — дешевле за кг.` : 'Ничего не нашлось. Попробуйте по-немецки или другое слово.'));
    body.append(itemList(found));
    body.append(manualLink(redraw));
    return;
  }
  // Полка
  if (ui.shelf) {
    const sh = idx.shelf[ui.shelf];
    const zone = idx.zone[sh.zone];
    const list = items.filter((it) => it.shelf === ui.shelf).sort((a, b) => (a.per ?? 1e9) - (b.per ?? 1e9));
    body.append(h('div', { class: 'crumbs' },
      h('button', { class: 'linkbtn', onclick: () => { ui.zone = null; ui.shelf = null; redraw(); } }, 'Все отделы'), ' › ',
      h('button', { class: 'linkbtn', onclick: () => { ui.shelf = null; redraw(); } }, zone.ru), ' › ', sh.ru));
    body.append(h('p', { class: 'muted' }, `${sh.de} · ${sh.en}. ${list.length} ${plural(list.length, 'товар', 'товара', 'товаров')}, сначала дешевле за кг.`));
    body.append(itemList(list));
    return;
  }
  // Отдел (зона): его полки
  if (ui.zone) {
    const zone = idx.zone[ui.zone];
    body.append(h('div', { class: 'crumbs' }, h('button', { class: 'linkbtn', onclick: () => { ui.zone = null; redraw(); } }, 'Все отделы'), ' › ', zone.ru));
    body.append(h('p', { class: 'muted' }, `${zone.de} · ${zone.en}. ${zone.hint ? zone.hint[0].toUpperCase() + zone.hint.slice(1) + '.' : ''}`));
    body.append(h('ul', { class: 'zone-list' }, shelvesOf(state.data, ui.zone, items).map((s) => h('li', null,
      h('button', { class: 'zone-btn', onclick: () => { ui.shelf = s.id; ui.limit = 60; redraw(); } },
        h('span', null, h('b', null, s.ru), h('span', { class: 'muted' }, ` · ${s.de}`)), h('span', { class: 'muted' }, String(s.n)))))));
    return;
  }
  // Все отделы
  const counts = {};
  for (const it of items) counts[idx.shelf[it.shelf]?.zone] = (counts[idx.shelf[it.shelf]?.zone] || 0) + 1;
  body.append(h('p', { class: 'muted', style: { marginTop: 0 } }, `${items.length} товаров. Рыбы, морепродуктов и алкоголя в каталоге нет. Фото и цены — с сайтов магазинов.`));
  body.append(h('ul', { class: 'zone-list' }, (state.data.aisles.zones || []).filter((z) => counts[z.id]).map((z) => h('li', null,
    h('button', { class: 'zone-btn', onclick: () => { ui.zone = z.id; redraw(); } },
      h('span', null, h('b', null, z.ru), h('span', { class: 'muted' }, ` · ${z.de}`)), h('span', { class: 'muted' }, String(counts[z.id])))))));
}

// ---------- Дома ----------
// Отмечается примерно (упаковки, штуки, «кончается»), дальше учёт ведётся сам: купленное в Покупках прибавляется,
// приготовленное по плану — вычитается (core/stock.js)
export function setStock(key, grams) {
  const prev = state.pantry[key];
  const had = prev?.have && (prev.grams > 0 || prev.grams == null);
  const have = grams !== 0;
  state.pantry[key] = { have, grams: have && grams > 0 ? Math.round(grams) : null, at: Date.now(), src: 'user', freshAt: have ? (had && prev.freshAt) || Date.now() : null };
  save();
}

function renderHome(root, redraw, rerender) {
  const { products, recipes } = state.data;
  const now = new Date();
  const { stock, home, expiring } = homeForPlanning(now);
  const t = targets();
  root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Отмечайте примерно: «половина пачки», «3 шт.», «кончается» — взвешивать не нужно. Дальше приложение считает само: купленное в Покупках прибавляется, приготовленное по плану — вычитается.'));

  // что можно приготовить из этого
  const opts = { prefs: state.prefs, targets: t, products, prefer: expiring.map((e) => e.key) };
  const mains = cookableNow(rankByHome(recipes, home, { ...opts, type: 'main' }));
  const breakfasts = cookableNow(rankByHome(recipes, home, { ...opts, type: 'breakfast' }));
  root.append(h('section', { class: 'home-summary' },
    h('div', null, h('b', null, mains.length || breakfasts.length
      ? `Из того, что дома: ${mains.length} ${plural(mains.length, 'обед или ужин', 'обеда или ужина', 'обедов или ужинов')}, ${breakfasts.length} ${plural(breakfasts.length, 'завтрак', 'завтрака', 'завтраков')}`
      : 'Из того, что отмечено дома, пока ничего не собрать')),
    h('div', { class: 'row' },
      h('a', { class: 'btn small primary', href: '#/recipes?src=home' }, 'Что приготовить'),
      h('a', { class: 'btn small', href: '#/recipes?src=shop' }, 'Что докупить'))));
  if (expiring.length) {
    root.append(h('p', { class: 'notice' }, h('b', null, 'Скоро испортится: '),
      expiring.slice(0, 5).map((e) => `${products[e.key]?.name_ru || e.key}${e.over ? ' (проверьте — срок мог пройти)' : e.left <= 1 ? ' (сегодня-завтра)' : ` (≈ ${e.left} дн.)`}`).join(', '),
      '. Блюда с ними — первыми в ', h('a', { href: '#/recipes?src=home' }, 'Что приготовить'), '.'));
  }
  // испортилось (срок вышел и по верхней границе) — из запасов убрано, в следующую неделю не переносится (блок В)
  const gone = Object.entries(stock).filter(([k, s]) => products[k] && !products[k].basic && s.spoiled > 1);
  if (gone.length) {
    root.append(h('p', { class: 'notice' }, h('b', null, 'Испортилось — убрано из запасов: '),
      gone.map(([k, s]) => `${products[k].name_ru.toLowerCase()} ${describeStock(k, s.spoiled, products[k]).replace(/^≈ /, '')}`).join(', '),
      '. Не ешьте, если сомневаетесь. Если ещё хорошее — отметьте количество заново.'));
  }

  const q = (ui.homeQ || '').trim().toLowerCase();
  root.append(h('input', { type: 'search', id: 'home-q', placeholder: 'Найти: творог, рис, Topfen…', value: ui.homeQ || '', 'aria-label': 'Найти продукт', oninput: (e) => { ui.homeQ = e.target.value; rerender({ keepScroll: true, keepFocus: true }); } }));
  const hit = (key) => { const p = products[key]; return !q || [p?.name_ru, p?.name_de_generic, p?.name_de, p?.name_en, key].filter(Boolean).join(' ').toLowerCase().includes(q.length > 4 ? q.slice(0, -1) : q); };
  const byName = (a, b) => (products[a]?.name_ru || a).localeCompare(products[b]?.name_ru || b, 'ru');

  // нужно плану (на оставшиеся дни)
  const need = {};
  if (state.plan?.batches?.length) for (const [k, v] of planNeeds(remainingPlan(effectivePlan(state.plan, ['out']), now), state.recipeMap)) need[k] = v.grams;
  const expSet = new Map(expiring.map((e) => [e.key, e]));
  const haveKeys = Object.keys(stock).filter((k) => products[k] && stock[k].grams > 0 && hit(k)).sort(byName);
  const missingKeys = Object.keys(need).filter((k) => products[k] && !(stock[k]?.grams > 0) && !products[k].basic && hit(k)).sort(byName);
  const basicsMissing = Object.keys(need).filter((k) => products[k]?.basic && k !== 'water' && !(stock[k]?.grams > 0) && hit(k)).sort(byName);
  const row = (k) => stockRow(k, products[k], stock[k], need[k], expSet.get(k), redraw);

  root.append(h('div', { class: 'row between' }, h('h2', null, `Есть дома${haveKeys.length ? ` · ${haveKeys.length}` : ''}`),
    h('button', { class: 'btn small', onclick: () => addProductSheet(redraw) }, icon('plus'), 'Добавить')));
  root.append(haveKeys.length ? h('ul', { class: 'home-list' }, haveKeys.map(row))
    : h('p', { class: 'muted' }, q ? 'Не нашлось.' : 'Пока ничего не отмечено. Нажмите «Добавить» или отметьте продукты из плана ниже.'));
  if (missingKeys.length) {
    root.append(h('h2', null, 'Нужно для плана — есть дома?'));
    root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Если что-то из этого уже есть, отметьте — список покупок станет короче.'));
    root.append(h('ul', { class: 'home-list' }, missingKeys.map(row)));
  }
  if (basicsMissing.length) {
    root.append(h('details', { class: 'plain', style: { marginTop: '10px' } }, h('summary', null, `Базовое для плана: масло, соль, специи · ${basicsMissing.length}`),
      h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Обычно есть дома. Отметьте «нет» — тогда они попадут в «купить один раз».'),
      h('ul', { class: 'home-list' }, basicsMissing.map(row))));
  }

  const other = Object.entries(state.pantry).filter(([ref, v]) => v?.have && !isProductKey(ref));
  root.append(h('h2', null, 'Другое дома'));
  root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Что угодно из каталога: отметьте «Есть дома» в карточке товара. Закончилось — отправьте в список покупок.'));
  if (other.length) {
    root.append(h('ul', { class: 'home-list' }, other.map(([ref, v]) => h('li', { class: 'home-row' },
      photo({ name_ru: v.name, packs: [] }, v.image ? { image: v.image, name_de: v.name, store: v.store } : null, { cls: 'thumb sm', label: v.name }),
      h('div', { class: 'home-main' }, h('span', { class: 'cat-name' }, v.name), h('span', { class: 'muted' }, [v.store, aisles(state.data).shelf[v.shelf]?.ru].filter(Boolean).join(' · '))),
      h('div', { class: 'home-actions' },
        h('button', { class: 'btn small', onclick: () => { setHome(ref, null); const c = state.cart.find((x) => x.ref === ref && !x.done); if (!c) state.cart.push({ ...cartEntryOf({ ref, name: v.name, store: v.store, shelf: v.shelf, image: v.image, price: null, concepts: [] }) }); save(); redraw(); toast('Закончилось — добавил в список'); } }, 'Закончилось'),
        h('button', { class: 'btn small ghost', 'aria-label': 'Убрать', onclick: () => { setHome(ref, null); redraw(); } }, icon('close')))))));
  }
  const homePicked = (it) => { const k = markHome(it); if (k) { ui.editKey = k; ui.homeQ = ''; } redraw(); toast(`Есть дома: ${it.name}`); };
  root.append(h('div', { class: 'row', style: { marginTop: '10px' } },
    h('button', { class: 'btn', onclick: () => pickFromCatalog({ title: 'Что есть дома?', pickLabel: 'Есть дома', onPick: homePicked }) }, icon('plus'), 'Добавить из каталога'),
    h('button', { class: 'btn ghost', onclick: () => manualItemSheet({ title: 'Есть дома: добавить вручную', submit: 'Есть дома', onSave: homePicked }) }, 'Добавить вручную')));
}

// Строка запаса: сколько есть (по-человечески), откуда это число, хватит ли плану; «Изменить» — уровни
function stockRow(key, p, s, need, exp, redraw) {
  const grams = s?.grams || 0;
  const open = ui.editKey === key;
  const auto = s && (s.added > 0 || s.used > 0);
  const enough = need ? grams >= need * 0.95 : null;
  const sub = [
    auto ? `считается само: ${[s.base > 0 && s.base !== Infinity ? `было ${describeStock(key, s.base, p).replace(/^≈ /, '')}` : null, s.added > 0 ? `куплено ${describeStock(key, s.added, p).replace(/^≈ /, '')}` : null, s.used > 0 ? `ушло в готовку ${describeStock(key, s.used, p).replace(/^≈ /, '').replace(/^почти нет \(≈ (.+)\)$/, '$1')}` : null].filter(Boolean).join(', ')}` : null,
    need && !p?.basic ? (grams === Infinity || enough ? 'для плана хватает' : grams > 0 ? `для плана нужно ещё ${needText(key, need - grams, p)}` : `для плана: ${needText(key, need, p)}`) : null,
    freshLine(s),
  ].filter(Boolean);
  return h('li', { class: 'home-row stock-row' + (open ? ' open' : '') },
    photo(p, thumbPack(p), { cls: 'thumb sm', label: p?.name_ru }),
    h('div', { class: 'home-main' },
      h('span', { class: 'cat-name' }, p?.name_ru || key, exp ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, exp.over ? 'проверьте свежесть' : 'скоро испортится') : null),
      h('span', { class: grams > 0 ? 'stock-amount' : 'muted' }, grams > 0 ? describeStock(key, grams, p) : s?.at ? 'нет' : 'не отмечено'),
      sub.length ? h('span', { class: 'muted small' }, sub.join(' · ')) : null),
    h('div', { class: 'home-actions' },
      open ? levelPicker(key, p, grams, redraw) : [
        h('button', { class: 'btn small', 'aria-expanded': 'false', onclick: () => { ui.editKey = key; redraw(); } }, grams > 0 ? 'Изменить' : 'Есть дома'),
        grams > 0 ? h('button', { class: 'btn small ghost', onclick: () => { const prev = state.pantry[key] ? { ...state.pantry[key] } : null; setStock(key, 0); redraw(); toast(`${p?.name_ru}: закончилось`, { label: 'Отменить', onClick: () => { if (prev) state.pantry[key] = prev; else delete state.pantry[key]; save(); redraw(); } }); } }, 'Закончилось') : null,
      ]));
}

// Свежесть: вскрыто когда и годно до какого дня (по нижней границе срока), замороженное — отдельно
function freshLine(s) {
  if (!(s?.grams > 0) || s.grams === Infinity) return null;
  const d = (t) => { const x = new Date(t); return `${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][x.getDay()]} ${x.getDate()}.${String(x.getMonth() + 1).padStart(2, '0')}`; };
  const parts = [];
  if (s.frozen > 1) parts.push(`в морозилке ${Math.round(s.frozen)} г${Number.isFinite(s.thawAt) ? ` — достать ${d(s.thawAt)}` : ''}`);
  if (s.openedAt != null) parts.push(`вскрыто ${d(s.openedAt)}`);
  if (s.exp != null && Number.isFinite(s.exp) && s.exp - Date.now() < 21 * 86400000) parts.push(Date.now() >= s.exp ? 'срок вышел — проверьте запах и вид' : `${s.frozen > 1 ? 'остальное ' : ''}годно до ${d(s.exp - 1)}`);
  return parts.length ? parts.join(', ') : null;
}

// Сколько нужно — штуками для штучного («≈ 4 шт.»), иначе как в списке покупок
function needText(key, grams, p) {
  if (stockKind(key, p) !== 'pcs') return formatAmount(key, grams, p);
  const [per, unit] = PIECES[key];
  return `≈ ${Math.max(1, Math.ceil(grams / per - 0.15))} ${unit}`;
}

// Выбор уровня: упаковки (доли), штуки (− N +) или «есть / кончается / нет»
function levelPicker(key, p, grams, redraw) {
  const kind = stockKind(key, p);
  const cur = nearestLevel(key, grams, p);
  const done = () => { ui.editKey = null; redraw(); };
  const pick = (g) => { setStock(key, g); done(); };
  const box = h('div', { class: 'level-picker' });
  if (kind === 'pcs') {
    const [, unit] = PIECES[key];
    const n = Math.max(0, cur || 0);
    box.append(h('div', { class: 'row' },
      h('div', { class: 'stepper', role: 'group', 'aria-label': `Сколько: ${p?.name_ru}` },
        h('button', { 'aria-label': 'Меньше', onclick: () => { setStock(key, levelGrams(key, p, Math.max(0, n - 1))); redraw(); } }, '−'),
        h('span', null, `${n} ${unit}`),
        h('button', { 'aria-label': 'Больше', onclick: () => { setStock(key, levelGrams(key, p, n + 1)); redraw(); } }, '+')),
      h('button', { class: 'btn small primary', onclick: done }, 'Готово')));
  } else {
    const levels = kind === 'basic' ? BASIC_LEVELS : PACK_LEVELS;
    const pg = refPack(p);
    if (kind === 'pack' && pg) box.append(h('span', { class: 'muted small' }, `Сколько упаковок по ${Math.round(pg.pack_size)} ${pg.pack_unit === 'ml' ? 'мл' : 'г'}:`));
    box.append(h('div', { class: 'chips' }, levels.map((l) => h('button', { class: 'chip' + (cur === l.id ? ' on' : ''), 'aria-pressed': String(cur === l.id), onclick: () => pick(levelGrams(key, p, l.id)) }, l.label)),
      kind === 'pack' ? h('button', { class: 'chip' + (grams === Infinity ? ' on' : ''), onclick: () => pick(null) }, 'есть, не знаю сколько') : null));
  }
  // кто знает граммы — может ввести
  box.append(h('details', { class: 'plain' }, h('summary', { class: 'muted small' }, 'Точнее, в граммах'),
    h('label', { class: 'grams-field' }, h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 10, class: 'grams', value: grams > 0 && grams !== Infinity ? Math.round(grams) : '', 'aria-label': `Граммы: ${p?.name_ru}`,
      onchange: (e) => pick(Math.max(0, Math.round(+e.target.value || 0))) }), h('span', { class: 'muted' }, 'г'))));
  box.append(h('button', { class: 'linkbtn small', onclick: done }, 'Закрыть'));
  return box;
}

// «Добавить»: любой продукт из рецептов (не только из плана)
function addProductSheet(redraw) {
  const products = state.data.products;
  const input = h('input', { type: 'search', placeholder: 'Рис, яйца, Topfen…', 'aria-label': 'Найти продукт' });
  const list = h('ul', { class: 'home-list' });
  let close;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const keys = Object.keys(products).filter((k) => k !== 'water' && (!q || [products[k].name_ru, products[k].name_de_generic, products[k].name_en].filter(Boolean).join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (products[a].basic - products[b].basic) || (products[a].name_ru || a).localeCompare(products[b].name_ru || b, 'ru'));
    list.replaceChildren(...keys.slice(0, 60).map((k) => h('li', { class: 'home-row' },
      photo(products[k], thumbPack(products[k]), { cls: 'thumb sm', label: products[k].name_ru }),
      h('div', { class: 'home-main' }, h('span', { class: 'cat-name' }, products[k].name_ru), h('span', { class: 'muted' }, [products[k].name_de_generic, products[k].basic ? 'базовое' : null].filter(Boolean).join(' · '))),
      h('div', { class: 'home-actions' }, h('button', { class: 'btn small', onclick: () => { close(); ui.editKey = k; ui.homeQ = ''; if (!(state.pantry[k]?.have)) setStock(k, levelGrams(k, products[k], stockKind(k, products[k]) === 'pcs' ? 1 : stockKind(k, products[k]) === 'basic' ? 'ok' : 'full')); redraw(); } }, 'Есть дома')))));
  };
  input.addEventListener('input', draw);
  draw();
  const manual = h('p', { class: 'muted', style: { margin: 0 } }, 'Нет в списке? ',
    h('button', { class: 'linkbtn', onclick: () => { close(); manualItemSheet({ title: 'Есть дома: добавить вручную', name: input.value.trim(), submit: 'Есть дома', onSave: (it) => { const k = markHome(it); ui.editKey = k; ui.homeQ = ''; redraw(); toast(`Есть дома: ${it.name}`); } }); } }, 'Добавить вручную'),
    ' — например, рамен из азиатского магазина.');
  close = sheet('Что есть дома?', h('div', { class: 'stack' }, input, manual, list));
  setTimeout(() => input.focus(), 50);
}

// ---------- Мой список ----------
function renderCart(root, redraw) {
  root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Товары, которые вы добавили сами. В «Покупках» они встают в поход в нужный магазин, в свой отдел.'));
  const open = state.cart.filter((c) => !c.done);
  const done = state.cart.filter((c) => c.done);
  if (!state.cart.length) root.append(h('p', null, 'Пока пусто. Найдите товар в каталоге и нажмите «В список».'));
  if (open.length) {
    root.append(h('div', { class: 'row between' }, h('h2', null, 'Купить'), h('span', { class: 'muted' }, `≈ ${eur(cartTotal(open))}`)));
    root.append(h('ul', { class: 'home-list' }, open.map((c) => cartRow(c, redraw))));
  }
  if (done.length) {
    root.append(h('div', { class: 'row between' }, h('h2', null, 'Куплено'),
      h('button', { class: 'linkbtn', onclick: () => { state.cart = state.cart.filter((c) => !c.done); save(); redraw(); } }, 'Очистить')));
    root.append(h('ul', { class: 'home-list' }, done.map((c) => cartRow(c, redraw))));
  }
  root.append(h('div', { class: 'row', style: { marginTop: '10px' } },
    h('button', { class: 'btn', onclick: () => pickFromCatalog({ title: 'Добавить в список', pickLabel: 'В список', onPick: (it) => { addToCart(it); redraw(); } }) }, icon('plus'), 'Добавить из каталога'),
    h('button', { class: 'btn ghost', onclick: () => manualItemSheet({ title: 'В список: добавить вручную', submit: 'В список', onSave: (it) => { addToCart(it); redraw(); } }) }, 'Добавить вручную')));
}

export function cartRow(c, redraw, { compact = false } = {}) {
  const setQty = (q) => { c.qty = Math.max(1, q); save(); redraw(); };
  const label = conceptLabel(state.data, c);
  return h('li', { class: 'home-row' + (c.done ? ' done' : '') },
    h('input', { type: 'checkbox', checked: !!c.done, 'aria-label': `Куплено: ${c.name}`, onchange: (e) => { c.done = e.target.checked; c.doneAt = Date.now(); save(); redraw(); } }),
    photo({ name_ru: c.name, packs: [] }, c.image ? { image: c.image, name_de: c.name, store: c.store } : null, { cls: 'thumb sm', label: c.name }),
    h('div', { class: 'home-main' },
      h('span', { class: 'cat-name', lang: 'de' }, c.name),
      h('span', { class: 'muted' }, [label ? `${label.ru} · ${label.en}` : null, compact ? null : c.store, c.price ? `${eur(c.price)}${c.byWeight ? '/кг' : ''}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'home-actions' },
      c.byWeight ? null : h('div', { class: 'stepper', role: 'group', 'aria-label': 'Количество' },
        h('button', { 'aria-label': 'Меньше', onclick: () => setQty(c.qty - 1) }, '−'), h('span', null, `${c.qty} шт.`), h('button', { 'aria-label': 'Больше', onclick: () => setQty(c.qty + 1) }, '+')),
      h('button', { class: 'btn icon ghost small', 'aria-label': 'Убрать из списка', onclick: () => { state.cart = state.cart.filter((x) => x !== c); save(); redraw(); } }, icon('close'))));
}
