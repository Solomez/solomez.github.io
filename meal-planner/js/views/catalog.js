// «Продукты»: каталог магазинов с фото (поиск по-русски, по-английски и по-немецки, обзор по отделам),
// что есть дома (от этого зависит список покупок) и свои товары в списке покупок.
import { h, eur, num, sheet, toast, icon, seg, plural } from '../ui.js';
import { state, save } from '../state.js';
import { loadStore, search, asPack, packText, perText, conceptLabel, aisles, shelvesOf } from '../core/catalog.js';
import { buildShoppingList, formatAmount } from '../core/shopping.js';
import { remainingPlan } from '../core/calendar.js';
import { photo, thumbPack } from './products.js';

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

// ---------- Карточка товара каталога ----------
function itemCard(it, { onPick, pickLabel = 'Взял это' } = {}) {
  const label = conceptLabel(state.data, it);
  const shelf = aisles(state.data).shelf[it.shelf];
  const inCart = state.cart.filter((c) => c.ref === it.ref && !c.done).reduce((a, c) => a + c.qty, 0);
  const home = state.pantry[it.ref]?.have;
  const product = { name_ru: label?.ru || it.name, packs: [asPack(it)] };
  return h('li', { class: 'cat-item' },
    photo(product, asPack(it), { cls: 'thumb lg', label: it.name }),
    h('div', { class: 'cat-main' },
      h('span', { class: 'cat-name', lang: 'de' }, it.name),
      h('span', { class: 'muted' }, [it.brand, label ? `${label.ru} · ${label.en}` : shelf ? `${shelf.ru} · ${shelf.en}` : null].filter(Boolean).join(' · ')),
      h('span', null, h('b', null, eur(it.price)), h('span', { class: 'muted' }, ` · ${[packText(it), perText(it), it.store].filter(Boolean).join(' · ')}`)),
      h('div', { class: 'cat-actions' },
        onPick
          ? h('button', { class: 'btn small primary', onclick: () => onPick(it) }, pickLabel)
          : [
            h('button', { class: 'btn small' + (inCart ? ' on' : ''), onclick: () => { addToCart(it); window.dispatchEvent(new Event('hashchange')); } }, icon('plus'), inCart ? `В списке: ${inCart}` : 'В список'),
            h('button', { class: 'btn small ghost' + (home ? ' on' : ''), 'aria-pressed': String(!!home),
              onclick: () => { setHome(it.ref, home ? null : { have: true, name: it.name, store: it.store, shelf: it.shelf, image: it.image }); window.dispatchEvent(new Event('hashchange')); } },
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
export function pickFromCatalog({ title, store, query = '', onPick, pickLabel }) {
  const key = store ? storeKeyOf(store) : null;
  const keys = key ? [key] : selectedStores();
  const input = h('input', { type: 'search', placeholder: 'Что ищете? По-русски, по-немецки или по-английски', value: query, 'aria-label': 'Поиск в каталоге' });
  const out = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Загружаю каталог…'));
  let items = [];
  let close;
  const draw = () => {
    const found = search(state.data, items, input.value, { limit: 40 });
    out.replaceChildren(input.value.trim()
      ? (found.length ? h('ul', { class: 'cat-list' }, found.map((it) => itemCard(it, { onPick: (x) => { close(); onPick(x); }, pickLabel }))) : h('p', { class: 'muted' }, 'Ничего не нашлось. Попробуйте другое слово — например, по-немецки.'))
      : h('p', { class: 'muted' }, `Каталог ${key ? store : 'магазинов'}: ${items.length} товаров. Начните вводить название.`));
  };
  input.addEventListener('input', draw);
  close = sheet(title, h('div', { class: 'stack' }, input, out));
  ensureLoaded(keys).then((all) => { items = all; draw(); input.focus(); }).catch(() => out.replaceChildren(h('p', { class: 'notice' }, 'Не удалось загрузить каталог. Проверьте интернет.')));
}

// ---------- Экран ----------
export function renderProducts(root, rerender) {
  const redraw = () => rerender({ keepScroll: true });
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Продукты')));
  const cartOpen = state.cart.filter((c) => !c.done);
  root.append(h('div', { style: { marginBottom: '12px' } }, seg([['catalog', 'Каталог'], ['home', 'Дома'], ['cart', `Мой список${cartOpen.length ? ' · ' + cartOpen.length : ''}`]], ui.tab, (v) => { ui.tab = v; ui.limit = 60; redraw(); })));
  if (ui.tab === 'home') return renderHome(root, redraw);
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
    const found = search(state.data, items, ui.q, { limit: 400 });
    body.append(h('p', { class: 'muted', style: { marginTop: 0 } }, found.length ? `Найдено: ${found.length}${found.length === 400 ? '+' : ''}. Сначала — самые похожие, при равенстве — дешевле за кг.` : 'Ничего не нашлось. Попробуйте по-немецки или другое слово.'));
    body.append(itemList(found));
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
function renderHome(root, redraw) {
  const products = state.data.products;
  root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Отметьте, что уже есть дома — список покупок станет короче. Если есть, но мало, укажите сколько: докупится только разница.'));
  if (state.plan?.batches?.length) {
    const list = buildShoppingList(remainingPlan(state.plan, new Date()), state.recipeMap, products, { stores: state.prefs.stores });
    const all = [...list.items, ...list.atHome, ...list.basics].sort((a, b) => a.name_ru.localeCompare(b.name_ru, 'ru'));
    const plain = buildShoppingList(remainingPlan(state.plan, new Date()), state.recipeMap, products, { stores: state.prefs.stores, home: {} });
    const total = Object.fromEntries([...plain.items, ...plain.basics].map((i) => [i.key, i.needGrams]));
    root.append(h('h2', null, 'Нужно для плана'));
    root.append(h('ul', { class: 'home-list' }, all.map((it) => homeRow(it.key, products[it.key], total[it.key], redraw))));
  } else {
    root.append(h('p', null, 'Плана пока нет — составьте неделю, и здесь появится, что для неё нужно. ', h('a', { href: '#/plan' }, 'К плану')));
  }
  const other = Object.entries(state.pantry).filter(([ref, v]) => v?.have && ref.includes(':'));
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
  root.append(h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => pickFromCatalog({ title: 'Что есть дома?', pickLabel: 'Есть дома', onPick: (it) => { setHome(it.ref, { have: true, name: it.name, store: it.store, shelf: it.shelf, image: it.image }); redraw(); } }) }, icon('plus'), 'Добавить из каталога'));
}

function homeRow(key, p, need, redraw) {
  const v = state.pantry[key] || {};
  const st = v.have ? (v.grams > 0 ? 'some' : 'yes') : v.have === false ? 'no' : '';
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 10, class: 'grams', value: v.grams || '', placeholder: 'г', 'aria-label': `Сколько есть: ${p?.name_ru}`,
    onchange: (e) => { const g = Math.max(0, Math.round(+e.target.value || 0)); setHome(key, { have: g > 0 || st !== 'no', grams: g || null }); redraw(); } });
  return h('li', { class: 'home-row' },
    photo(p, thumbPack(p), { cls: 'thumb sm', label: p?.name_ru }),
    h('div', { class: 'home-main' },
      h('span', { class: 'cat-name' }, p?.name_ru || key),
      h('span', { class: 'muted' }, [p?.name_de_generic, p?.name_en].filter(Boolean).join(' · ')),
      need ? h('span', { class: 'muted' }, `для плана: ${formatAmount(key, need, p)}${p?.basic ? ' (базовое)' : ''}`) : null),
    h('div', { class: 'home-actions' },
      h('div', { class: 'seg small', role: 'group', 'aria-label': 'Есть ли дома' },
        h('button', { class: st === 'yes' || st === 'some' ? 'on' : '', onclick: () => { setHome(key, { have: true }); redraw(); } }, 'есть'),
        h('button', { class: st === 'no' ? 'on' : '', onclick: () => { setHome(key, { have: false, grams: null }); redraw(); } }, 'нет')),
      st === 'yes' || st === 'some' ? h('label', { class: 'grams-field' }, input, h('span', { class: 'muted' }, v.grams ? 'г' : 'сколько?')) : null));
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
  root.append(h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => pickFromCatalog({ title: 'Добавить в список', pickLabel: 'В список', onPick: (it) => { addToCart(it); redraw(); } }) }, icon('plus'), 'Добавить из каталога'));
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
