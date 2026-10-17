import { h, eur, num, icon, seg, plural, toast, sheet } from '../ui.js';
import { state, save, toggleIn, targets } from '../state.js';
import { missingTools } from '../core/equipment.js';
import { difficulty } from '../core/difficulty.js';
import { rankByHome, cookableNow, almostCookable, buySuggestions, runningLow } from '../core/suggest.js';
import { formatPack, chooseOffer } from '../core/shopping.js';
import { MEALS, planDays, swapBatch, swapExtra } from '../core/planner.js';
import { mealPast, dayName, dayDate } from '../core/calendar.js';
import { homeForPlanning } from './money.js';
import { cartEntryOf } from './catalog.js';
import { hideToggle } from './recipe.js';

// Сложность — маленькой плашкой: «очень просто», «средне»
export const diffBadge = (r) => { const d = difficulty(r); return d ? h('span', { class: `diff d-${d.id}`, title: d.reasons.join(', ') }, d.short) : null; };

const PROTEIN_TYPES = { chicken: 'Курица', turkey: 'Индейка', pork: 'Свинина', beef: 'Говядина', mince: 'Фарш', eggs: 'Яйца', legumes: 'Бобовые', sausage: 'Колбаски', dairy: 'Молочное', ham: 'Ветчина' };

export function matchRecipe(r, f) {
  const q = (f.q || '').trim().toLowerCase();
  if (q) {
    const hay = [r.title, r.title_de, r.description, ...(r.tags || []), ...r.ingredients.map((i) => `${i.name_ru} ${i.name_de}`)].join(' ').toLowerCase();
    // по основе слова (F33): «курицу» находит «курица», «котлеты» — «котлетами»
    // падежные окончания: «рисом» → «рис», «курицу» → «куриц», «котлеты» → «котлет»; «салат» остаётся «салат» (не «сало»)
    const stem = (w) => {
      if (!/[а-яё]/.test(w) || w.length < 4) return w;
      const end = ['ами', 'ями', 'ого', 'ему', 'ой', 'ей', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ую', 'юю', 'а', 'я', 'у', 'ю', 'ы', 'и', 'е', 'о'].find((x) => w.endsWith(x) && w.length - x.length >= 3);
      return end ? w.slice(0, -end.length) : w;
    };
    if (!q.split(/\s+/).every((w) => hay.includes(stem(w)))) return false;
  }
  if (f.time && r.time.total > f.time) return false; // по полному времени: «до 30 мин» — за 30 минут готово
  if (f.price && r.per_serving.cost > f.price) return false;
  if (f.protein && r.per_serving.protein < f.protein) return false;
  if (f.kcalMax && r.per_serving.kcal > f.kcalMax) return false;
  if (f.kcalMin && r.per_serving.kcal < f.kcalMin) return false;
  if (f.ingredient && !r.ingredients.some((i) => i.key === f.ingredient)) return false;
  if (f.type && r.protein_type !== f.type) return false;
  if (f.fav && !(state.prefs.favorites || []).includes(r.id)) return false;
  if (f.tea && !(r.tags || []).includes('с чаем')) return false;
  if (f.mine && !r.custom) return false;
  if (f.nocook && difficulty(r)?.id !== 'none') return false;
  if (!f.showNoTools && missingTools(r, state.prefs.equipment).length) return false;
  const hidden = (state.prefs.hidden || []).includes(r.id);
  if (hidden && !f.showHidden) return false;
  return true;
}

// Три режима экрана: все рецепты / из того, что дома / если докупить
const SOURCES = [['all', 'Все'], ['home', 'Из того, что дома'], ['shop', 'Если докупить']];
let appliedSrc = null; // режим из ссылки применяется один раз — дальше переключается как обычно

export function renderLibrary(root, rerender, params) {
  const f = state.libFilters;
  const want = params?.get('src');
  if (want && want !== appliedSrc && SOURCES.some(([v]) => v === want)) { f.src = want; save(); }
  appliedSrc = want || null;
  const src = f.src || 'all';
  if (src !== 'all') return renderFromHome(root, rerender, src);
  // фильтр времени раньше был по активному времени — старое значение сбрасываем один раз, иначе список молча сужается
  if (!f.totalTime) { f.time = null; f.totalTime = 1; save(); }
  const set = (k, v) => { f[k] = v; save(); rerender({ keepFocus: k === 'q' }); };
  const { recipes, products } = state.data;
  const ingOptions = Object.values(products).filter((p) => !p.basic).sort((a, b) => (a.name_ru || '').localeCompare(b.name_ru || '', 'ru'));

  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Рецепты'), h('span', { class: 'muted' }, `${recipes.length} ${plural(recipes.length, 'рецепт', 'рецепта', 'рецептов')}`)));
  root.append(sourceSwitch(src, rerender));
  root.append(h('div', { style: { marginBottom: '12px' } }, seg([['main', 'Обеды и ужины'], ['breakfast', 'Завтраки'], ['snack', 'Перекусы']], f.kind || 'main', (v) => set('kind', v))));
  // Быстрые фильтры — одним касанием; полный набор ниже, в «Фильтрах»
  const quick = [
    ['time', 30, 'до 30 мин'], ['price', 2.4, 'до €2,40'], ['protein', 45, '45+ г белка'], ['nocook', true, 'Без готовки'], ['fav', true, 'Избранное'],
  ];
  // «с горячим чаем» — только если такие блюда есть среди выбранного типа
  if (recipes.some((r) => (r.meal_type || 'main') === (f.kind || 'main') && (r.tags || []).includes('с чаем'))) quick.splice(3, 0, ['tea', true, 'С горячим чаем']);
  if (recipes.some((r) => r.custom)) quick.unshift(['mine', true, 'Мои']);
  // свой вариант — особенно для перекусов и завтраков (хлопья, снеки)
  root.append(h('div', { class: 'builder-cta' },
    h('span', null, h('b', null, 'Свой вариант'), h('span', { class: 'muted' }, ' — хлопья, снеки, бутерброды из любых продуктов, с КБЖУ и ценой')),
    h('a', { class: 'btn small primary', href: `#/builder?type=${f.kind === 'main' ? 'main' : f.kind || 'snack'}` }, icon('plus'), 'Собрать')));
  root.append(h('div', { class: 'chips', style: { marginBottom: '12px' } }, quick.map(([k, v, l]) => {
    const on = f[k] === v;
    return h('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => set(k, on ? null : v) }, l);
  })));
  root.append(h('div', { class: 'stack' },
    h('input', { type: 'search', id: 'lib-q', placeholder: 'Поиск: блюдо или продукт (курица, Topfen, булгур…)', value: f.q || '', oninput: (e) => set('q', e.target.value), 'aria-label': 'Поиск' }),
    h('details', { class: 'filter-box', open: state.ui?.filtersOpen ? true : null, ontoggle: (e) => { state.ui = { ...(state.ui || {}), filtersOpen: e.target.open }; } },
      h('summary', null, 'Фильтры', activeCount(f) ? ` · ${activeCount(f)}` : ''),
    h('div', { class: 'filters', style: { marginTop: '10px' } },
      sel('Время готовки целиком', f.time, [['', 'любое'], [20, 'до 20 мин'], [25, 'до 25 мин'], [30, 'до 30 мин'], [35, 'до 35 мин'], [40, 'до 40 мин']], (v) => set('time', +v || null)),
      sel('Цена порции', f.price, [['', 'любая'], [1.5, 'до €1,50'], [2, 'до €2,00'], [2.4, 'до €2,40'], [2.5, 'до €2,50'], [3, 'до €3,00']], (v) => set('price', +v || null)),
      sel('Белок в порции', f.protein, [['', 'любой'], [35, 'от 35 г'], [40, 'от 40 г'], [45, 'от 45 г']], (v) => set('protein', +v || null)),
      sel('Калорийность', f.kcalMax ? `max${f.kcalMax}` : f.kcalMin ? `min${f.kcalMin}` : '', [['', 'любая'], ['max700', 'до 700 ккал'], ['max850', 'до 850 ккал'], ['min800', 'от 800 ккал']], (v) => {
        f.kcalMax = v.startsWith('max') ? +v.slice(3) : null;
        f.kcalMin = v.startsWith('min') ? +v.slice(3) : null;
        save(); rerender();
      }),
      sel('Ингредиент', f.ingredient, [['', 'любой'], ...ingOptions.map((p) => [p.key, p.name_ru || p.key])], (v) => set('ingredient', v || null)),
      sel('Основа', f.type, [['', 'любая'], ...Object.entries(PROTEIN_TYPES)], (v) => set('type', v || null)))),
    h('div', { class: 'row' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!f.showHidden, onchange: (e) => set('showHidden', e.target.checked) }), 'Показать скрытые'),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!f.showNoTools, onchange: (e) => set('showNoTools', e.target.checked) }), 'Показать блюда, для которых нет утвари'),
      h('button', { class: 'btn small ghost', onclick: () => { state.libFilters = {}; save(); rerender(); } }, 'Сбросить фильтры'))));

  const sortBy = f.sort || 'score';
  const kind = f.kind || 'main';
  const found = recipes.filter((r) => (r.meal_type || 'main') === kind && matchRecipe(r, f));
  const sorters = {
    score: (a, b) => (b.per_serving.protein / b.per_serving.cost) - (a.per_serving.protein / a.per_serving.cost),
    price: (a, b) => a.per_serving.cost - b.per_serving.cost,
    protein: (a, b) => b.per_serving.protein - a.per_serving.protein,
    time: (a, b) => a.time.total - b.time.total || a.time.active - b.time.active,
  };
  found.sort(sorters[sortBy]);
  root.append(h('div', { class: 'row between', style: { margin: '16px 0 10px' } },
    h('span', { class: 'muted' }, `Найдено: ${found.length}`),
    h('label', { class: 'row muted' }, 'Сортировка',
      h('select', { style: { width: 'auto' }, onchange: (e) => set('sort', e.target.value) },
        [['score', 'белок на €'], ['price', 'дешевле'], ['protein', 'больше белка'], ['time', 'быстрее']].map(([v, l]) => h('option', { value: v, selected: v === sortBy }, l))))));

  root.append(h('div', { class: 'recipe-list' }, found.map((r) => recipeCard(r, rerender))));
  if (!found.length) root.append(h('p', { class: 'muted' }, 'Ничего не найдено — ослабьте фильтры.'));
}

export function recipeCard(r, rerender) {
  const fav = (state.prefs.favorites || []).includes(r.id);
  const hidden = (state.prefs.hidden || []).includes(r.id);
  const ps = r.per_serving;
  const missing = missingTools(r, state.prefs.equipment);
  return h('article', { class: 'card rcard' + (hidden ? ' hidden-r' : '') },
    h('div', { class: 'row between', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
      h('a', { class: 'title', href: `#/recipe/${r.id}` }, r.title),
      h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '2px' } },
        h('button', { class: 'btn icon ghost small', 'aria-label': fav ? 'Убрать из избранного' : 'В избранное', 'aria-pressed': String(fav), onclick: () => { toggleIn('favorites', r.id); rerender(); } }, icon(fav ? 'starOn' : 'star')),
        h('button', { class: 'btn icon ghost small', 'aria-label': hidden ? 'Вернуть в подбор' : 'Не предлагать в плане', title: hidden ? 'Вернуть в подбор' : 'Не предлагать в плане', onclick: () => hideToggle(r, rerender) }, icon(hidden ? 'eye' : 'eyeOff')))),
    h('div', { class: 'desc' }, r.description),
    h('div', { class: 'meta' }, `${r.time.total}\u00a0мин (активно ${r.time.active}) · ${eur(ps.cost)} · ${num(ps.protein)}\u00a0г белка · ${num(ps.kcal)}\u00a0ккал`),
    h('div', { class: 'row' },
      r.custom ? h('span', { class: 'badge accent' }, 'мой') : null,
      diffBadge(r),
      (r.tags || []).includes('спорное') ? h('span', { class: 'badge', title: 'Сочетание продуктов на любителя' }, 'необычное') : null,
      missing.length ? h('span', { class: 'badge warn' }, `нужно: ${missing.join(', ').toLowerCase()}`) : null));
}

function sourceSwitch(src, rerender) {
  const el = seg(SOURCES, src, (v) => { state.libFilters.src = v; save(); rerender(); });
  el.classList.add('scroll');
  return h('div', { class: 'source-switch' }, el);
}

// ---------- «Из того, что дома» и «Если докупить» ----------
function renderFromHome(root, rerender, src) {
  const f = state.libFilters;
  const { recipes, products } = state.data;
  const kind = f.kind || 'main';
  const { stock, home, expiring } = homeForPlanning();
  const opts = { prefs: state.prefs, targets: targets(), products, prefer: expiring.map((e) => e.key) };
  const marked = Object.keys(stock).filter((k) => products[k] && !products[k].basic && stock[k].grams > 0).length;
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Рецепты')));
  root.append(sourceSwitch(src, rerender));
  root.append(h('p', { class: 'muted source-note' }, src === 'home'
    ? 'Только то, что уже есть дома — в магазин идти не нужно. Соль, масло и специи считаются в наличии. '
    : 'Что купить, чтобы из того, что дома, получилось больше блюд, — и какие рецепты станут доступны. ',
  `Дома отмечено: ${marked} ${plural(marked, 'продукт', 'продукта', 'продуктов')}. `, h('a', { href: '#/products?tab=home' }, 'Изменить запасы')));
  root.append(h('div', { style: { marginBottom: '12px' } }, seg([['main', 'Обеды и ужины'], ['breakfast', 'Завтраки'], ['snack', 'Перекусы']], kind, (v) => { f.kind = v; save(); rerender(); })));
  if (!marked) {
    root.append(h('section', { class: 'empty' },
      h('h2', null, 'Сначала отметьте, что есть дома'),
      h('p', null, 'Хватит примерно: «половина пачки риса», «4 яйца». Купленное в Покупках добавится само.'),
      h('a', { class: 'btn primary', href: '#/products?tab=home' }, 'Отметить запасы')));
    if (src === 'home') return;
  }
  const ranked = rankByHome(recipes, home, { ...opts, type: kind });
  if (src === 'home') {
    const now = cookableNow(ranked);
    root.append(h('h2', null, now.length ? `Можно приготовить сейчас · ${now.length}` : 'Сейчас целиком ничего не собрать'));
    if (expiring.length && now.some((x) => x.expiring.length)) root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Сверху — блюда с продуктами, которые скоро испортятся.'));
    root.append(h('div', { class: 'recipe-list' }, now.map((x) => homeCard(x, rerender))));
    const almost = almostCookable(ranked, 2);
    if (almost.length) {
      root.append(h('h2', null, 'Не хватает одного-двух продуктов'));
      root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, h('a', { href: '#/recipes?src=shop', onclick: () => { f.src = 'shop'; save(); } }, 'Если докупить'), ' — что выгоднее всего купить.'));
      root.append(h('div', { class: 'recipe-list' }, almost.slice(0, 12).map((x) => homeCard(x, rerender))));
    }
    return;
  }
  // «Если докупить»: сначала — что купить, затем блюда, которые это откроет
  const lists = ['main', 'breakfast', 'snack'].map((t) => (t === kind ? ranked : rankByHome(recipes, home, { ...opts, type: t })));
  const { singles, bundles } = buySuggestions(lists, products);
  if (singles.length) {
    root.append(h('h2', null, 'Что докупить'));
    root.append(h('ul', { class: 'buy-list' }, singles.map((e) => buyRow(e, rerender))));
  }
  if (bundles.length) {
    root.append(h('div', { class: 'eyebrow', style: { marginTop: '14px' } }, 'Вместе'));
    root.append(h('ul', { class: 'buy-list' }, bundles.map((b) => h('li', { class: 'buy-item' },
      h('span', null, h('b', null, b.names.join(' + ')), h('span', { class: 'muted' }, ` · ≈ ${eur(b.cost)}`)),
      h('button', { class: 'btn small', onclick: () => { for (const k of b.keys) addProductToCart(k); rerender({ keepScroll: true }); toast(`В списке покупок: ${b.names.join(', ')}`); } }, icon('plus'), 'В список'),
      h('span', { class: 'muted buy-why' }, `откроют ${b.unlock.length} ${plural(b.unlock.length, 'блюдо', 'блюда', 'блюд')}: ${b.unlock.map((r) => r.title).join(', ')}`)))));
  }
  const low = runningLow(stock, recipes, products);
  if (low.length) {
    root.append(h('h2', null, 'Заканчивается'));
    root.append(h('ul', { class: 'buy-list' }, low.slice(0, 6).map((e) => h('li', { class: 'buy-item' },
      h('span', null, h('b', null, e.name), h('span', { class: 'muted' }, ` · нужно в ${e.uses} ${plural(e.uses, 'рецепте', 'рецептах', 'рецептах')}`)),
      h('button', { class: 'btn small', onclick: () => { addProductToCart(e.key); rerender({ keepScroll: true }); toast(`В списке покупок: ${e.name}`); } }, icon('plus'), 'В список')))));
  }
  const almost = almostCookable(ranked, 3);
  root.append(h('h2', null, almost.length ? 'Если докупить — можно приготовить' : 'Почти всё нужно покупать'));
  if (!almost.length) root.append(h('p', { class: 'muted' }, 'Из отмеченного дома почти ничего не собрать даже с 2–3 покупками. Проще составить неделю с покупками на Плане.'));
  root.append(h('div', { class: 'recipe-list' }, almost.slice(0, 20).map((x) => homeCard(x, rerender))));
}

// Добавить продукт рецептов в «Мой список» (встанет в поход в свой магазин): самая выгодная упаковка
export function addProductToCart(key, grams = 1) {
  const p = state.data.products[key];
  const ref = `plan:${key}`;
  if (!p || state.cart.some((c) => c.ref === ref && !c.done)) return;
  const offer = chooseOffer(p, grams);
  const pack = offer?.pack;
  const loose = !!pack?.loose;
  state.cart.push(cartEntryOf({ ref, name: pack ? `${p.name_ru} — ${pack.name_de}` : p.name_ru, store: pack && pack.store !== 'любой' ? pack.store : null, shelf: p.shelf,
    price: offer ? (loose ? offer.cost : pack.price_eur) : null, size: pack?.pack_size, unit: pack?.pack_unit, image: pack?.image, url: pack?.url, concepts: [] }, loose ? 1 : offer?.count || 1));
  save();
}

function buyRow(e, rerender) {
  const inCart = state.cart.some((c) => c.ref === `plan:${e.key}` && !c.done);
  const why = [e.unlock.length ? `откроет ${e.unlock.length} ${plural(e.unlock.length, 'блюдо', 'блюда', 'блюд')}: ${e.unlock.slice(0, 3).map((r) => r.title).join(', ')}${e.unlock.length > 3 ? '…' : ''}` : null,
    e.helps.length ? `нужен ещё в ${e.helps.length} ${plural(e.helps.length, 'блюде', 'блюдах', 'блюдах')} вместе с 1–2 другими продуктами` : null].filter(Boolean).join('; ');
  return h('li', { class: 'buy-item' },
    h('span', null, h('b', null, e.name), e.offer ? h('span', { class: 'muted' }, ` · ${formatPack(e.offer)} — ${eur(e.offer.cost)}${e.offer.pack.store !== 'любой' ? `, ${e.offer.pack.store}` : ''}`) : null),
    h('button', { class: 'btn small' + (inCart ? ' on' : ''), disabled: inCart, onclick: () => { addProductToCart(e.key, e.grams); rerender({ keepScroll: true }); toast(`В списке покупок: ${e.name}`, { label: 'Открыть', onClick: () => { location.hash = '#/shop'; } }); } }, inCart ? 'В списке' : [icon('plus'), 'В список']),
    h('span', { class: 'muted buy-why' }, why));
}

// Карточка блюда в режимах «дома» и «докупить»: что есть, чего нет, сложность и «В план»
function homeCard(x, rerender) {
  const r = x.recipe;
  const ps = r.per_serving;
  const href = `#/recipe/${r.id}?f=${x.factor}&p=${x.portions}`;
  const d = difficulty(r);
  return h('article', { class: 'card rcard' },
    h('a', { class: 'title', href }, r.title),
    h('div', { class: 'meta' }, `${r.time.total}\u00a0мин (активно ${r.time.active}) · ${num(ps.protein * x.factor)}\u00a0г белка · ${num(ps.kcal * x.factor)}\u00a0ккал${x.portions > 1 ? ' · на 2 порции' : ''}`),
    h('div', { class: 'row' }, diffBadge(r), d?.reasons?.length && d.id !== 'none' ? h('span', { class: 'muted small' }, d.reasons.slice(0, 2).join(', ')) : null),
    x.missing.length
      ? h('div', { class: 'need-line small' }, `Докупить: ${x.missing.map((m) => m.name.toLowerCase()).join(', ')} · ≈ ${eur(x.buyCost)}`)
      : h('div', { class: 'have-line small' }, `Всё есть дома${x.expiring.length ? ` · спасёт: ${x.expiring.map((k) => state.data.products[k]?.name_ru?.toLowerCase()).join(', ')}` : ''}`),
    h('div', { class: 'row' },
      h('a', { class: 'btn small', href }, 'Рецепт'),
      state.plan?.batches?.length ? h('button', { class: 'btn small', onclick: () => putInPlan(x, rerender) }, 'В план') : null,
      x.missing.length ? h('button', { class: 'btn small', onclick: () => { for (const m of x.missing) addProductToCart(m.key, m.grams); rerender({ keepScroll: true }); toast(`В списке покупок: ${x.missing.map((m) => m.name).join(', ')}`); } }, icon('plus'), 'Докупить')
        : h('a', { class: 'btn small primary', href: `#/cook/${r.id}?f=${x.factor}&p=${x.portions}` }, icon('pot'), 'Готовить')));
}

// «В план»: поставить блюдо вместо одного из ещё не наступивших приёмов пищи того же типа
export function putInPlan(x, rerender) {
  const plan = state.plan;
  const now = new Date();
  const type = x.recipe.meal_type || 'main';
  const days = planDays(plan, state.recipeMap);
  const slots = [];
  days.forEach((d, i) => {
    const entries = type === 'main' ? [['dinner', d.dinner], ['lunch', d.lunch]] : type === 'breakfast' ? [['breakfast', d.breakfast]] : d.snacks.map((e) => ['snack', e]);
    for (const [meal, e] of entries) {
      if (!e?.recipe || e.recipe.id === x.recipe.id || mealPast(plan, i, meal, now)) continue;
      if (e.batch && e.leftover) continue; // обед из второй порции меняется вместе с ужином
      slots.push({ day: i, meal, e });
    }
  });
  if (!slots.length) return toast('В плане нет свободных будущих приёмов пищи этого типа');
  let close;
  close = sheet(`«${x.recipe.title}» — вместо чего?`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, type === 'main' ? 'Ужин готовится на 2 порции: вторая станет обедом следующего дня, как в плане.' : 'Заменится только этот приём пищи.'),
    slots.slice(0, 14).map((s) => h('button', { class: 'alt', onclick: () => {
      close();
      const prev = state.plan;
      state.plan = s.e.batch ? swapBatch(plan, s.e.batch.id, x.recipe, targets()) : swapExtra(plan, s.e.extra.id, x.recipe, s.e.recipe);
      save();
      rerender({ keepScroll: true });
      toast(`В плане: ${x.recipe.title} — ${dayName(plan, s.day).toLowerCase()}`, { label: 'Отменить', onClick: () => { state.plan = prev; save(); rerender({ keepScroll: true }); } });
    } }, h('span', { class: 'alt-main' }, h('span', { class: 'alt-title' }, `${dayName(plan, s.day)}, ${dayDate(plan, s.day).getDate()} · ${MEALS[s.meal]}`),
      h('span', { class: 'muted' }, `сейчас: ${s.e.recipe.title}`))))));
}

function activeCount(f) {
  return ['time', 'price', 'protein', 'kcalMax', 'kcalMin', 'ingredient', 'type'].filter((k) => f[k]).length;
}

function sel(label, value, options, onChange) {
  return h('label', { class: 'field' }, h('span', null, label),
    h('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === String(v) }, l))));
}
