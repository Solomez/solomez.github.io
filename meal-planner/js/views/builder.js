// «Свой приём пищи»: собрать завтрак, перекус или обед из любых продуктов — хлопья, снеки, бутерброды.
// КБЖУ и цена считаются сразу; сохранённое становится обычным рецептом (рецепты, план, покупки, запасы).
import { h, eur, num, icon, seg, toast, sheet } from '../ui.js';
import { state, save, targets, applyCustom } from '../state.js';
import { buildCustomRecipe, unitOf, gramsOf, autoTitle, productFromCatalog, mealHint, similarNutrition } from '../core/custom.js';
import { aisles } from '../core/catalog.js';
import { photo, thumbPack } from './products.js';
import { pickFromCatalog } from './catalog.js';
import { manualItemSheet } from './manual.js';
import { putInPlan } from './library.js';

// Категории для быстрого выбора — сначала то, из чего обычно собирают перекус и завтрак
const CATEGORIES = [
  ['cereal', 'Хлопья и хлеб', ['cornflakes', 'bread', 'toast_bread', 'crispbread', 'rice_cakes', 'tortilla', 'croissant']],
  ['dairy', 'Молочное', ['milk', 'kefir', 'skyr', 'magertopfen', 'cottage_cheese', 'greek_yogurt', 'natural_yogurt', 'protein_pudding', 'fruit_yogurt', 'butter', 'cream_cheese']],
  ['sweet', 'Снеки и сладкое', null], // всё из отделов сладкого и снеков, плюс арахис, батончики, мёд
  ['fruit', 'Фрукты и овощи', ['banana', 'apple', 'dates', 'cucumber', 'tomato', 'carrot', 'bell_pepper']],
  ['savory', 'Колбаса, сыр, яйца', ['ham', 'cabanossi', 'sausage_frankfurter', 'gouda', 'mozzarella', 'feta', 'eggs', 'hummus']],
  ['drinks', 'Напитки', ['black_tea', 'fruit_tea', 'cocoa_drink', 'milk', 'kefir']],
  ['all', 'Всё', null],
];
const SWEET_ZONES = new Set(['sweets', 'snacks', 'breakfast']);
const SWEET_EXTRA = ['croissant', 'fruit_yogurt', 'protein_pudding'];
const SWEET_KEYS = ['peanuts', 'peanut_butter', 'honey', 'dark_chocolate', 'protein_bar', 'dates'];

// Готовые заготовки — чтобы не начинать с пустого листа
const TEMPLATES = [
  ['Хлопья с молоком', 'breakfast', [['cornflakes', 60], ['milk', 250]]],
  ['Хлопья + скир + банан', 'breakfast', [['cornflakes', 50], ['milk', 200], ['skyr', 150], ['banana', 1]]],
  ['Тарелка снеков', 'snack', [['cabanossi', 50], ['gouda', 30], ['crispbread', 20], ['cucumber', 0.5]]],
  ['Бутерброд и чай', 'snack', [['bread', 50], ['butter', 1], ['ham', 50]], 'black_tea'],
  ['Сладкое к чаю', 'snack', [['dark_chocolate', 20], ['peanuts', 20]], 'fruit_tea'],
];

const ui = { draft: null, forId: undefined, cat: 'cereal', q: '', plan: true };

function startDraft(id, params) {
  const saved = id ? (state.custom?.recipes || []).find((r) => r.id === id) : null;
  ui.draft = saved ? JSON.parse(JSON.stringify(saved)) : { title: '', meal_type: ['breakfast', 'snack', 'main'].includes(params?.get('type')) ? params.get('type') : 'snack', items: [], tea: null, note: '' };
  ui.forId = id || null;
  ui.plan = saved ? !(state.prefs.hidden || []).includes(id) : true;
  ui.q = '';
}

export function renderBuilder(root, rerender, id, params) {
  if (ui.forId !== (id || null) || !ui.draft) startDraft(id, params);
  const d = ui.draft;
  const products = state.data.products;
  const redraw = (o = {}) => rerender({ keepScroll: true, ...o });
  const recipe = buildCustomRecipe({ ...d, id: id || 'draft' }, products);

  root.append(h('div', { class: 'row between', style: { marginBottom: '6px' } },
    h('a', { class: 'btn icon ghost', href: id ? `#/recipe/${id}` : '#/recipes', 'aria-label': 'Назад', onclick: () => { ui.draft = null; } }, icon('back'))));
  root.append(h('h1', null, id ? 'Изменить свой вариант' : 'Свой приём пищи'));
  root.append(h('p', { class: 'muted', style: { marginTop: '-4px' } }, 'Соберите из любых продуктов — хлопья, снеки, бутерброды. КБЖУ и цена считаются сразу; сохранённое появится в «Рецептах» и в подборе плана.'));

  root.append(h('div', { style: { margin: '6px 0 12px' } }, seg([['breakfast', 'Завтрак'], ['snack', 'Перекус'], ['main', 'Обед или ужин']], d.meal_type, (v) => { d.meal_type = v; redraw(); })));

  if (!d.items.length) {
    root.append(h('div', { class: 'eyebrow' }, 'Начать с заготовки'));
    root.append(h('div', { class: 'chips', style: { marginBottom: '14px' } }, TEMPLATES.filter(([, , items]) => items.every(([k]) => products[k])).map(([label, type, items, tea]) =>
      h('button', { class: 'chip', onclick: () => { d.meal_type = type; d.items = items.map(([key, qty]) => ({ key, qty })); d.tea = tea || null; redraw(); } }, label))));
  }

  // Итог: КБЖУ и цена — сверху, чтобы видеть, как меняется от каждого продукта
  const ps = recipe.per_serving;
  const hint = d.items.length ? mealHint(recipe, targets()) : null;
  root.append(h('section', { class: 'builder-sum' },
    h('div', { class: 'row between' },
      h('span', null, h('span', { class: 'big' }, `${num(ps.kcal)} ккал`), h('span', { class: 'muted' }, ` · ${eur(ps.cost)} за порцию`)),
      h('span', { class: 'muted' }, `Б ${num(ps.protein)} · Ж ${num(ps.fat)} · У ${num(ps.carbs)} г`)),
    hint ? h('div', { class: 'need-line small' }, hint) : null,
    recipe.noPriceKeys.length ? h('div', { class: 'need-line small' }, 'Цена не посчитана — нет веса упаковки: ',
      recipe.noPriceKeys.map((k, j) => [j ? ', ' : '', state.data.products[k]?.custom ? h('button', { class: 'linkbtn', onclick: () => editCustomProduct(k, () => redraw()) }, `${state.data.products[k].name_ru} — указать вес`) : state.data.products[k]?.name_ru])) : null,
    recipe.unknownKeys.length ? h('div', { class: 'need-line small' }, 'Без КБЖУ — не учтены в калориях: ',
      recipe.unknownKeys.map((k, j) => [j ? ', ' : '', state.data.products[k]?.custom ? h('button', { class: 'linkbtn', onclick: () => editCustomProduct(k, () => redraw()) }, `${state.data.products[k].name_ru} — указать`) : state.data.products[k]?.name_ru])) : null));

  // Что входит
  root.append(h('h2', null, d.items.length ? 'Что входит' : 'Добавьте продукты'));
  if (d.items.length) root.append(h('ul', { class: 'home-list' }, d.items.map((it, idx) => itemRow(it, idx, products, redraw))));

  // Горячий чай
  root.append(h('div', { class: 'row', style: { margin: '12px 0' } }, h('span', { class: 'muted' }, 'К этому:'),
    seg([['', 'без чая'], ['black_tea', 'чёрный чай'], ['fruit_tea', 'фруктовый чай']].filter(([k]) => !k || products[k]), d.tea || '', (v) => { d.tea = v || null; redraw(); })));

  // Добавить продукт
  root.append(h('div', { class: 'eyebrow', style: { marginTop: '10px' } }, 'Добавить продукт'));
  const catSeg = seg(CATEGORIES.map(([k, l]) => [k, l]), ui.cat, (v) => { ui.cat = v; ui.q = ''; redraw(); });
  catSeg.classList.add('scroll');
  root.append(catSeg);
  root.append(h('input', { type: 'search', id: 'builder-q', style: { marginTop: '8px' }, placeholder: 'Найти: хлопья, Snickers, скир, арахис…', value: ui.q, 'aria-label': 'Найти продукт',
    oninput: (e) => { ui.q = e.target.value; redraw({ keepFocus: true }); } }));
  root.append(h('ul', { class: 'home-list' }, candidates(products).slice(0, 40).map((k) => pickRow(k, products, d, redraw))));
  root.append(h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Нет нужного? ',
    h('button', { class: 'linkbtn', onclick: () => addFromCatalog(d, redraw) }, 'Найти в каталоге магазинов'), ' — любой из 22 000 товаров Billa, Spar и Penny, КБЖУ — с этикетки. Купили в Hofer, Lidl или азиатском магазине? ',
    h('button', { class: 'linkbtn', onclick: () => manualItemSheet({ name: ui.q.trim(), onSave: (it) => addManual(it, d, redraw) }) }, 'Добавить вручную'), '.'));

  // Название и как собрать
  root.append(h('h2', null, 'Название и как собрать'));
  root.append(h('div', { class: 'stack' },
    h('input', { type: 'text', id: 'builder-title', value: d.title, placeholder: autoTitle(recipe.ingredients), 'aria-label': 'Название', oninput: (e) => { d.title = e.target.value; } }),
    h('textarea', { id: 'builder-note', rows: 2, placeholder: 'Как собрать (необязательно): например, «залей хлопья молоком прямо перед едой»', 'aria-label': 'Как собрать', oninput: (e) => { d.note = e.target.value; } }, d.note || ''),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: ui.plan, onchange: (e) => { ui.plan = e.target.checked; } }), 'Предлагать в плане')));

  root.append(h('div', { class: 'row', style: { marginTop: '16px' } },
    h('button', { class: 'btn primary', disabled: !d.items.length, onclick: () => saveDraft(id, rerender) }, icon('check'), 'Сохранить'),
    id ? h('button', { class: 'btn ghost', onclick: () => removeCustom(id) }, 'Удалить') : null));
}

function candidates(products) {
  const q = ui.q.trim().toLowerCase();
  const all = Object.keys(products).filter((k) => !products[k].basic && k !== 'water');
  const hay = (k) => [products[k].name_ru, products[k].name_de_generic, products[k].name_de, products[k].name_en, k].filter(Boolean).join(' ').toLowerCase();
  if (q) return all.filter((k) => hay(k).includes(q.length > 4 ? q.slice(0, -1) : q)).sort(byName(products));
  const [, , keys] = CATEGORIES.find(([c]) => c === ui.cat) || [];
  // свои продукты из каталога — сверху в «Снеки и сладкое» и «Всё»
  const mine = all.filter((k) => products[k].custom).sort(byName(products));
  if (ui.cat === 'sweet') return [...mine, ...all.filter((k) => !products[k].custom && k !== 'cornflakes' && (SWEET_ZONES.has(products[k].zone) || SWEET_KEYS.includes(k) || SWEET_EXTRA.includes(k))).sort(byName(products))];
  if (ui.cat === 'all' || !keys) return [...mine, ...all.filter((k) => !products[k].custom).sort(byName(products))];
  return keys.filter((k) => products[k]);
}
const byName = (products) => (a, b) => (products[a].name_ru || a).localeCompare(products[b].name_ru || b, 'ru');

function itemRow(it, idx, products, redraw) {
  const p = products[it.key];
  const u = unitOf(it.key, p);
  const g = gramsOf(it.key, p, it.qty);
  const n = p?.nutrition_per_100g;
  const set = (q) => { it.qty = Math.max(u.step, Math.round(q / u.step) * u.step); redraw(); };
  return h('li', { class: 'home-row' },
    photo(p, thumbPack(p), { cls: 'thumb sm', label: p?.name_ru }),
    h('div', { class: 'home-main' },
      h('span', { class: 'cat-name' }, p?.name_ru || it.key),
      h('span', { class: 'muted small' }, [u.unit !== 'г' && u.unit !== 'мл' ? `${Math.round(g)} г` : null,
        Array.isArray(n) ? `${num((g * n[0]) / 100)} ккал · ${num((g * n[1]) / 100, 1)} г белка` : 'КБЖУ не указано'].filter(Boolean).join(' · ')),
      p?.custom ? nutritionLink(p, redraw) : null),
    h('div', { class: 'home-actions' },
      h('div', { class: 'stepper', role: 'group', 'aria-label': `Сколько: ${p?.name_ru}` },
        h('button', { 'aria-label': 'Меньше', onclick: () => set(it.qty - u.step) }, '−'),
        h('span', null, `${String(Math.round(it.qty * 100) / 100).replace('.', ',')} ${u.unit}`),
        h('button', { 'aria-label': 'Больше', onclick: () => set(it.qty + u.step) }, '+')),
      h('button', { class: 'btn icon ghost small', 'aria-label': `Убрать: ${p?.name_ru}`, onclick: () => { ui.draft.items.splice(idx, 1); redraw(); } }, icon('close'))));
}

function pickRow(k, products, d, redraw) {
  const p = products[k];
  const n = p.nutrition_per_100g;
  const inIt = d.items.find((i) => i.key === k);
  return h('li', { class: 'home-row' },
    photo(p, thumbPack(p), { cls: 'thumb sm', label: p.name_ru }),
    h('div', { class: 'home-main' },
      h('span', { class: 'cat-name' }, p.name_ru, p.custom ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'свой') : null),
      h('span', { class: 'muted small' }, [Array.isArray(n) ? `${num(n[0])} ккал, ${num(n[1], 1)} г белка на 100 г` : 'КБЖУ не указано', p.packs?.[0] ? `от ${eur(Math.min(...p.packs.map((x) => x.price_eur || 99)))}` : null].filter(Boolean).join(' · ')),
      p.custom ? nutritionLink(p, redraw) : null),
    h('div', { class: 'home-actions' },
      h('button', { class: 'btn small' + (inIt ? ' on' : ''), onclick: () => { if (inIt) inIt.qty += unitOf(k, p).step; else d.items.push({ key: k, qty: unitOf(k, p).def }); redraw(); } },
        icon('plus'), inIt ? 'Ещё' : 'Добавить')));
}

// «Указать КБЖУ» / «изменить КБЖУ» у своего продукта
function nutritionLink(p, redraw) {
  const has = Array.isArray(p.nutrition_per_100g);
  return h('button', { class: 'linkbtn small-link', style: { justifySelf: 'start' }, onclick: () => editCustomProduct(p.key, redraw) }, has ? 'изменить КБЖУ' : 'Указать КБЖУ');
}

// Форма своего продукта: название и КБЖУ на 100 г с этикетки; «как у похожих» — средние по той же полке из базы.
// fields: дополнительные поля (вес упаковки, вес штуки) — только при добавлении из каталога
function productForm({ title, intro, product, fields = [], submit, onSave }) {
  let close;
  const n = product.nutrition_per_100g || [];
  const f = (id, label, val) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 0.1, id, value: val ?? '' }));
  const name = h('input', { type: 'text', value: product.custom && product.name_ru !== product.name_de_generic ? product.name_ru : '', placeholder: product.name_de_generic || product.name_ru, 'aria-label': 'Название по-русски' });
  const sim = similarNutrition(product, state.data.products);
  const ids = ['cf-k', 'cf-p', 'cf-f', 'cf-c'];
  const content = h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, intro),
    h('label', { class: 'field' }, h('span', null, 'Как назвать (по-русски)'), name),
    h('div', { class: 'eyebrow' }, 'В 100 г — с этикетки (Nährwerte pro 100 g)'),
    h('div', { class: 'filters' }, f('cf-k', 'Ккал (kcal)', n[0]), f('cf-p', 'Белки (Eiweiß), г', n[1]), f('cf-f', 'Жиры (Fett), г', n[2]), f('cf-c', 'Углеводы (Kohlenhydrate), г', n[3])),
    sim ? h('button', { class: 'btn small', style: { justifySelf: 'start' }, onclick: () => ids.forEach((id, j) => { document.getElementById(id).value = sim.values[j]; }) },
      `Этикетки нет под рукой — как у похожих: ${num(sim.values[0])} ккал, ${num(sim.values[1], 1)} г белка`) : null,
    sim ? h('div', { class: 'muted small' }, `Среднее по: ${sim.names.join(', ')}. Это приблизительно — с этикетки точнее.`) : null,
    ...fields.map(([id, label, val]) => f(id, label, val)),
    h('button', { class: 'btn primary wide', onclick: () => {
      const v = (id) => +(document.getElementById(id)?.value || 0);
      onSave({ name: name.value.trim(), nutrition: ids.map(v), v });
      close();
    } }, submit));
  close = sheet(title, content);
}

export function editCustomProduct(key, after) {
  const p = state.custom?.products?.[key];
  if (!p) return;
  const pack = p.packs?.[0];
  const noWeight = pack && !pack.loose && !(pack.grams > 0);
  productForm({ title: p.name_ru, intro: `${pack?.name_de || p.name_de} · ${pack?.store || ''}. Перепишите с этикетки, сколько в 100 г — калории и белок пересчитаются во всех ваших вариантах с этим продуктом.`,
    product: p, submit: 'Сохранить', fields: [
      ...(p.manual ? [['cf-price', 'Цена упаковки, €', pack?.price_eur]] : []),
      ...(noWeight ? [['cf-size', `Вес всей упаковки, г${pack.pack_unit === 'pcs' ? ` (${pack.pack_size} шт.)` : ''} — чтобы посчитать цену`]] : []),
    ],
    onSave: ({ name, nutrition, v }) => {
      const has = nutrition.some((x) => x > 0);
      const size = noWeight ? v('cf-size') : 0;
      const price = p.manual && v('cf-price') > 0 ? Math.round(v('cf-price') * 100) / 100 : pack?.price_eur;
      const grams = size > 0 ? size : pack?.grams;
      const packs = size > 0 || price !== pack?.price_eur
        ? [{ ...pack, grams: grams || null, price_eur: price, eur_per_kg: grams > 0 && price > 0 ? Math.round((price / grams) * 1000 * 100) / 100 : 0 }, ...p.packs.slice(1)] : p.packs;
      state.custom.products = { ...state.custom.products, [key]: { ...p, packs, name_ru: name || p.name_ru, nutrition_per_100g: has ? nutrition : null } };
      applyCustom();
      save();
      after?.();
      toast(has ? `КБЖУ сохранено: ${name || p.name_ru}` : 'КБЖУ не указано');
    } });
}

// Свой товар, введённый вручную: продукт уже сохранён (с КБЖУ, если указали) — просто кладём в приём пищи
function addManual(it, d, redraw) {
  const p = state.data.products[it.pkey];
  if (!p) return;
  if (!d.items.some((i) => i.key === p.key)) d.items.push({ key: p.key, qty: unitOf(p.key, p).def });
  ui.q = '';
  redraw();
  toast(`Добавлено: ${p.name_ru}`);
}

// Товар из каталога: КБЖУ с этикетки (на 100 г), вес упаковки — если в каталоге нет
function addFromCatalog(d, redraw) {
  pickFromCatalog({ title: 'Добавить из каталога', pickLabel: 'Выбрать', onPick: (it) => {
    if (it.manual) return addManual(it, d, redraw);
    const zone = aisles(state.data).shelf[it.shelf]?.zone || null;
    const draftP = { ...productFromCatalog(it, { zone }), name_ru: it.name };
    const fields = [...(!it.size && !it.byWeight ? [['cf-size', 'Вес упаковки, г']] : []), ...(it.unit === 'pcs' ? [['cf-piece', 'Вес одной штуки, г']] : [])];
    productForm({ title: 'Свой продукт', intro: `${it.name} · ${it.store} · ${eur(it.price)}. Перепишите с этикетки, сколько в 100 г — тогда калории и белок посчитаются. Можно пропустить и указать позже.`,
      product: draftP, fields, submit: 'Добавить',
      onSave: ({ name, nutrition, v }) => {
        const p = productFromCatalog(it, { name, nutrition, sizeGrams: v('cf-size') || null, pieceGrams: v('cf-piece') || null, zone });
        state.custom.products = { ...(state.custom.products || {}), [p.key]: p };
        applyCustom();
        save();
        if (!d.items.some((i) => i.key === p.key)) d.items.push({ key: p.key, qty: unitOf(p.key, p).def });
        redraw();
        toast(`Добавлено: ${p.name_ru}`);
      } });
  } });
}

function saveDraft(id, rerender) {
  const d = ui.draft;
  const recId = id || `my-${Date.now().toString(36)}`;
  const entry = { id: recId, title: d.title.trim(), meal_type: d.meal_type, items: d.items.map((i) => ({ key: i.key, qty: i.qty })), tea: d.tea || null, note: d.note || '' };
  const list = (state.custom.recipes || []).filter((r) => r.id !== recId);
  state.custom = { ...state.custom, recipes: [...list, entry] };
  const hidden = new Set(state.prefs.hidden || []);
  if (ui.plan) hidden.delete(recId); else hidden.add(recId);
  state.prefs.hidden = [...hidden];
  applyCustom();
  save();
  ui.draft = null;
  const r = state.recipeMap.get(recId);
  location.hash = `#/recipe/${recId}`;
  toast(`Сохранено: «${r.title}» — в «Рецептах», фильтр «Мои»`, state.plan?.batches?.length ? { label: 'В план', onClick: () => putInPlan({ recipe: r }, rerender) } : undefined);
}

export function removeCustom(id) {
  const prev = state.custom;
  const r = state.recipeMap.get(id);
  state.custom = { ...state.custom, recipes: (state.custom.recipes || []).filter((x) => x.id !== id) };
  applyCustom();
  if (state.plan) { const used = state.plan.batches.some((b) => b.recipeId === id) || (state.plan.extras || []).some((x) => x.recipeId === id); if (used) toast('Блюдо было в плане — замените его там'); }
  save();
  ui.draft = null;
  location.hash = '#/recipes';
  toast(`Удалено: ${r?.title || 'свой вариант'}`, { label: 'Отменить', onClick: () => { state.custom = prev; applyCustom(); save(); location.hash = `#/recipe/${id}`; } });
}
