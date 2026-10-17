import { h, eur, num, icon, seg, plural } from '../ui.js';
import { state, save, toggleIn } from '../state.js';
import { missingTools } from '../core/equipment.js';
import { hideToggle } from './recipe.js';

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
  if (!f.showNoTools && missingTools(r, state.prefs.equipment).length) return false;
  const hidden = (state.prefs.hidden || []).includes(r.id);
  if (hidden && !f.showHidden) return false;
  return true;
}

export function renderLibrary(root, rerender) {
  const f = state.libFilters;
  // фильтр времени раньше был по активному времени — старое значение сбрасываем один раз, иначе список молча сужается
  if (!f.totalTime) { f.time = null; f.totalTime = 1; save(); }
  const set = (k, v) => { f[k] = v; save(); rerender({ keepFocus: k === 'q' }); };
  const { recipes, products } = state.data;
  const ingOptions = Object.values(products).filter((p) => !p.basic).sort((a, b) => (a.name_ru || '').localeCompare(b.name_ru || '', 'ru'));

  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Рецепты'), h('span', { class: 'muted' }, `${recipes.length} ${plural(recipes.length, 'рецепт', 'рецепта', 'рецептов')}`)));
  root.append(h('div', { style: { marginBottom: '12px' } }, seg([['main', 'Обеды и ужины'], ['breakfast', 'Завтраки'], ['snack', 'Перекусы']], f.kind || 'main', (v) => set('kind', v))));
  // Быстрые фильтры — одним касанием; полный набор ниже, в «Фильтрах»
  const quick = [
    ['time', 30, 'до 30 мин'], ['price', 2.4, 'до €2,40'], ['protein', 45, '45+ г белка'], ['fav', true, 'Избранное'],
  ];
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
    (r.tags || []).includes('спорное') || missing.length ? h('div', { class: 'row' },
      (r.tags || []).includes('спорное') ? h('span', { class: 'badge', title: 'Сочетание продуктов на любителя' }, 'необычное') : null,
      missing.length ? h('span', { class: 'badge warn' }, `нужно: ${missing.join(', ').toLowerCase()}`) : null) : null);
}

function activeCount(f) {
  return ['time', 'price', 'protein', 'kcalMax', 'kcalMin', 'ingredient', 'type'].filter((k) => f[k]).length;
}

function sel(label, value, options, onChange) {
  return h('label', { class: 'field' }, h('span', null, label),
    h('select', { onchange: (e) => onChange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(value ?? '') === String(v) }, l))));
}
