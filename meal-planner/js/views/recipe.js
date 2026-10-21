import { h, eur, num, icon, factorText, humanDate, nb, plural, toast } from '../ui.js';
import { state, save, toggleIn, setSub, cookEnv, validSubs } from '../state.js';
import { subOptions, previewSub } from '../core/compile.js';
import { buildShoppingList } from '../core/shopping.js';
import { ingredientMeasure, stepText, MEASURE_HINT } from '../core/cookbook.js';
import { minutesRange } from '../core/qty.js';
import { GLASS_MEASURE } from '../core/amounts.js';
import { photo, thumbPack, showVariants, substitutesOf } from './products.js';
import { missingTools, stepHints, has, missingGear, gearLabel, missingToolItems } from '../core/equipment.js';
import { difficulty } from '../core/difficulty.js';
import { missingFromHome } from '../core/planner.js';
import { homeForPlanning } from './money.js';
import { editCustomProduct } from './builder.js';
import { putInPlan } from './library.js';
import { readyBlock, doneWhenBlock } from './ready.js';
import { cookResume } from './timerbar.js';
// название со строчной — только первая буква: «батончик Snickers», а не «батончик snickers» (S75)
const lowFirst = (t) => String(t || '').replace(/^([А-ЯЁA-Z])(?=[а-яёa-z])/, (c) => c.toLowerCase());

const storeHint = (p) => {
  const best = p?.packs?.find((x) => !x.stale) || p?.packs?.[0];
  if (!best) return '';
  return `${best.store}: ${best.name_de}${best.is_estimate ? ' (цена — оценка)' : ''}`;
};

// Количество для человека: бытовая мера (стакан 250 мл, ложки, штуки, доля упаковки) из граммов — заново при
// каждом размере порции (core/measures.js). Граммы — мелко, если включено «Показывать граммы» в профиле.
// packOf — упаковки из списка покупок недели: «три четверти пачки (пачка 400 г)» по той пачке, что куплена
export function ingredientAmount(r, ing, scale, packOf = null) {
  const res = ingredientMeasure(r, ing, scale, state.data.kitchen, { packOf: packOf ? (k) => packOf.get(k)?.grams : null });
  return { main: res.measure, sub: state.prefs.showGrams && res.gramsText && res.unit !== 'g' && res.unit !== 'text' ? res.gramsText : '' };
}

// Пояснение замены без точки в конце — дальше идёт своя пунктуация (S54: «…меньше.. Шаги…»)
const noDot = (t) => String(t || '').replace(/[.\s]+$/, '');

// Сколько продукта на порцию в «Из чего складывается цена» (S54): специи и соль — бытовой мерой («четверть чайной
// ложки»), а не «0 г»; остальное — граммами
export function costAmount(r, c, factor = 1) {
  const g = c.grams_per_serving * factor;
  const ing = r.ingredients.find((i) => i.key === c.key && !i.derived) || r.ingredients.find((i) => i.key === c.key);
  if (g < 5 && ing && state.data.kitchen?.measures?.[c.key]) {
    const m = ingredientMeasure(r, { ...ing, grams: g * (r.servings || 1), text: null, derived: null }, 1 / (r.servings || 1), state.data.kitchen);
    if (m.measure && m.unit !== 'g') return m.measure;
  }
  if (g < 1) return 'меньше 1 г';
  return `${num(g, g < 10 ? 1 : 0)} г`;
}

// Огонь шага: «огонь: средний», «духовка 200 °C, верх-низ»
export function heatLabel(s) {
  if (s.oven) return `духовка ${s.oven.c} °C${s.oven.mode ? ', ' + s.oven.mode : ''}`;
  // две посуды на плите — чей огонь (S48)
  return s.heat ? `огонь${s.heat_where ? ` под ${s.heat_where}` : ''}: ${s.heat}` : '';
}
// Время шага диапазоном: «12–15 мин»; у шагов без времени — пусто
export function timeLabel(s) {
  if (!s.time) return s.timer_min ? `${minutesRange(s.timer_min)} мин` : '';
  const a = s.time.active[0] + s.time.passive[0];
  const b = s.time.active[1] + s.time.passive[1];
  if (!(b >= 1)) return '';
  // границы — целыми минутами (S54): «10–16 мин», а не «10–15,5»
  const r = minutesRange(a, b);
  // «можно отойти» — только если ни на одной конфорке нет огня под присмотром (compile.js → flow.js markLeave)
  const away = s.leave === false ? `, следи за ${s.watch || 'плитой'}` : ', можно отойти';
  return `${r} мин${s.time.attended ? ', у плиты' : s.time.passive[1] > s.time.active[1] ? away : ''}`;
}

// Параметры ссылки: размер порции (×0,25–4) и число порций (1–8); мусор — значения по умолчанию
export function portionParams(params, r) {
  const f = +params.get('f');
  const p = Math.round(+params.get('p'));
  return {
    factor: Number.isFinite(f) && f > 0 ? Math.min(4, Math.max(0.25, f)) : 1,
    portions: Number.isFinite(p) && p > 0 ? Math.min(8, p) : r.servings,
  };
}

// Отметки «уже подготовлено» — общие для карточки рецепта и режима готовки
export function prepState(id) {
  const c = (state.cook[id] = state.cook[id] || { step: 0, done: [] });
  c.ings = c.ings || [];
  return c;
}

// Упаковки из списка покупок текущей недели: key → упаковка
export function weekPacks() {
  if (!state.plan?.batches?.length) return null;
  const list = buildShoppingList(state.plan, state.recipeMap, state.data.products, { stores: state.prefs.stores });
  return new Map(list.items.filter((i) => i.offer).map((i) => [i.key, i.offer.pack]));
}

// onSwap — после замены ингредиента в блюде (кнопка «варианты и замены» → «Заменить в блюде»)
export function ingredientList(r, scale, { checkable = true, onToggle, onSwap } = {}) {
  const products = state.data.products;
  const packs = weekPacks();
  const prep = prepState(r.id);
  const row = (i) => {
    const a = ingredientAmount(r, i, scale, packs);
    const done = prep.ings.includes(i.key);
    const toggle = () => {
      const s = new Set(prep.ings);
      s.has(i.key) ? s.delete(i.key) : s.add(i.key);
      prep.ings = [...s];
      save();
      onToggle?.();
    };
    // фото и магазин — у всех продуктов, кроме воды (базовые — тоже: соль, масло, специи надо узнать на полке)
    const shown = products[i.key] && i.key !== 'water';
    return h('li', { class: 'ing-row' + (checkable ? '' : ' no-check') + (shown ? '' : ' no-thumb') + (done ? ' done' : '') },
      checkable ? h('input', { type: 'checkbox', id: `ing-${r.id}-${i.key}`, checked: done, onchange: toggle, 'aria-label': `Подготовлено: ${i.name_ru}` }) : null,
      shown ? photo(products[i.key], thumbPack(products[i.key]), { cls: 'thumb sm', label: i.name_ru }) : null,
      h('label', { class: 'ing-text', for: checkable ? `ing-${r.id}-${i.key}` : null },
        h('span', { class: 'ing-name' }, i.name_ru, i.optional ? h('span', { class: 'muted' }, ' · по желанию') : null),
        h('span', { class: 'de ing-de' }, [i.name_de, shown ? storeHint(products[i.key]) : null].filter(Boolean).join(' · ')),
        i.replaced ? h('span', { class: 'swap-note' }, `Замена: вместо «${i.replaced.name_ru}»`,
          onSwap ? [' · ', h('button', { class: 'linkbtn small-link', type: 'button', onclick: (e) => { e.preventDefault(); const was = i.key; setSub(r.id, i.id || i.key, null); onSwap(); toast(`Вернул: ${i.replaced.name_ru}`, { label: 'Отменить', onClick: () => { setSub(r.id, i.id || i.key, was); onSwap(); } }); } }, `Вернуть «${i.replaced.name_ru.toLowerCase()}»`)] : null) : null,
        variantsButton(r, i, products, onSwap, scale),
        i.note ? h('span', { class: 'de' }, i.note) : null,
        swapOf(i.key) ? h('span', { class: 'swap-note' }, `На этой неделе куплено вместо: ${swapOf(i.key).name}`) : null),
      h('span', { class: 'ing-amount' }, a.main, a.sub ? h('span', { class: 'de' }, a.sub) : null));
  };
  // S72: «Базовое» — только то, что есть почти в каждой кухне (масло, соль, перец); вода — отдельно; томатная паста,
  // кубик, мёд, специи — в основном списке (их может не быть дома). Пустую группу не показываем
  const main = r.ingredients.filter((i) => !(i.basic && (CORE_PANTRY.has(i.key) || i.key === 'water')));
  const basic = r.ingredients.filter((i) => i.basic && CORE_PANTRY.has(i.key));
  const water = r.ingredients.filter((i) => i.basic && i.key === 'water');
  return h('div', null,
    h('ul', { class: 'ing-list' }, main.map(row)),
    basic.length ? [h('div', { class: 'eyebrow', style: { marginTop: '14px' } }, `Базовое: ${[...new Set(basic.map((i) => BASIC_WORD[i.key]))].join(', ')}`), h('ul', { class: 'ing-list' }, basic.map(row))] : null,
    water.length ? [h('div', { class: 'eyebrow', style: { marginTop: '14px' } }, 'Вода — из-под крана'), h('ul', { class: 'ing-list' }, water.map(row))] : null);
}
// продукты кладовки, которые есть почти всегда; остальное «базовое» (паста, кубик, специи) — проверить дома
export const CORE_PANTRY = new Set(['salt', 'black_pepper', 'oil', 'olive_oil']);
const BASIC_WORD = { salt: 'соль', black_pepper: 'перец', oil: 'масло', olive_oil: 'масло' };
// «базовое» не из кладовки, которого не отмечено дома: томатная паста, бульонный кубик, мёд, специи
// (приложение считает их «есть дома», пока не отмечено «нет» — поэтому сказать прямо, что проверить)
export function checkAtHome(r, stock) {
  const known = (k) => state.pantry?.[k]?.have === true || state.pantry?.[k]?.have === false || (stock?.[k]?.grams > 0 && stock[k].grams !== Infinity);
  return [...new Map(r.ingredients.filter((i) => i.basic && !i.optional && !CORE_PANTRY.has(i.key) && i.key !== 'water' && !known(i.key))
    .map((i) => [i.key, (state.data.products[i.key]?.name_ru || i.name_ru).toLowerCase()])).values()];
}

// Замены в блюде: что заменено и чем отличается; у шаблонов шаги, время и признаки уже пересобраны под замену
export function swapNotice(r, { onRevert = null } = {}) {
  if (!r.swapped?.length) return null;
  if (r.compiled) {
    const changed = r.steps.map((st, k) => (st.changed ? k + 1 : 0)).filter(Boolean);
    return h('div', { class: 'notice swap-notice' },
      h('div', null, h('b', null, r.swapped.length > 1 ? 'Замены в этом блюде:' : 'Замена в этом блюде:')),
      h('ul', { class: 'clean' }, r.swapped.map((x) => h('li', null, h('b', null, x.to_ru), ` вместо «${lowFirst(x.from_ru)}»`, x.note ? h('span', { class: 'muted' }, ` — ${noDot(x.note).replace(/^./, (c) => c.toLowerCase())}.`) : '.'))),
      h('div', { class: 'muted' }, `Шаги, время, таймеры, признаки готовности, название и «Частые ошибки» собраны под замену${changed.length ? `; изменены шаги ${changed.join(', ')} (отмечены)` : ''}.`),
      onRevert ? h('button', { class: 'btn small', onclick: onRevert }, r.swapped.length > 1 ? 'Вернуть всё как в рецепте' : 'Вернуть как в рецепте') : null);
  }
  return h('p', { class: 'notice' }, 'В шагах — продукты из рецепта, у вас замена: ',
    r.swapped.map((x, j) => [j ? '; ' : '', h('b', null, lowFirst(x.to_ru)), ` вместо «${lowFirst(x.from_ru)}»`, x.note ? ` (${noDot(x.note)})` : '']), '.');
}

// «варианты и замены»: упаковки в магазинах и замены; со страницы блюда замену можно выбрать — блюдо пересчитается
function variantsButton(r, i, products, onSwap, scale = 1) {
  const orig = i.replaced?.key || i.key; // у заменённого — варианты исходного продукта: другая замена или вернуть
  const slot = i.id || i.key;
  const card = r.compiled ? state.data.cards?.get(r.id) : null;
  const options = card ? subOptions(card, slot, cookEnv()) : null;
  const subs = options ? options.length : substitutesOf(orig).length;
  if (!(subs || (products[i.key]?.packs || []).length > 1)) return null;
  const pick = (k) => {
    const prev = i.replaced ? i.key : null;
    setSub(r.id, slot, k);
    onSwap();
    const name = (key) => products[key]?.name_ru || key;
    toast(k ? `В этом блюде: ${name(k)} вместо «${name(orig)}» — шаги пересчитаны` : `Вернул: ${name(orig)}`, { label: 'Отменить', onClick: () => { setSub(r.id, slot, prev); onSwap(); } });
  };
  const swap = onSwap && subs ? {
    current: i.replaced ? i.key : null, onPick: pick, origName: products[orig]?.name_ru || orig, scale, portions: Math.round(scale * r.servings),
    ...(options ? { options, preview: (k) => previewSub(card, validSubs(card, state.custom?.subs?.[r.id], cookEnv()), slot, k, cookEnv()) } : {}),
  } : null;
  return h('button', { class: 'linkbtn small-link', type: 'button', onclick: (e) => { e.preventDefault(); showVariants(products[orig], { swap }); } },
    i.replaced ? 'другая замена' : subs ? 'варианты и замены' : 'варианты в магазинах');
}

// «Взял другое вместо» в магазине — показываем у ингредиента в рецептах текущей недели
const swapOf = (key) => (state.plan ? state.swaps?.[state.plan.id]?.[key] : null);

let lastListRoute = '#/recipes';
export const rememberRoute = (hash) => { if (!/^#\/(recipe|cook)\//.test(hash)) lastListRoute = hash || '#/recipes'; };

export function renderRecipe(root, rerender, id, params) {
  const r = state.recipeMap.get(id);
  if (!r) {
    root.append(h('p', null, 'Рецепт не найден. ', h('a', { href: '#/recipes' }, 'К рецептам')));
    return;
  }
  const { factor, portions } = portionParams(params, r);
  const scale = (factor * portions) / r.servings;
  const ps = r.per_serving;
  // недавно открытые — сверху в Рецептах (S66)
  const lf = state.libFilters;
  if (lf.recent?.[0] !== r.id) { lf.recent = [r.id, ...(lf.recent || []).filter((x) => x !== r.id)].slice(0, 5); save(); }
  const fav = (state.prefs.favorites || []).includes(r.id);
  const hidden = (state.prefs.hidden || []).includes(r.id);
  const setPortions = (n) => { location.replace(`#/recipe/${r.id}?f=${factor}&p=${n}`); };
  const kcal = ps.kcal * factor;

  // Шапка: назад, название, действия
  root.append(h('div', { class: 'row between no-print', style: { marginBottom: '6px', flexWrap: 'wrap', gap: '6px' } },
    h('a', { class: 'btn ghost back-link', href: lastListRoute }, icon('back'), 'Назад'),
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
      h('button', { class: 'btn small', 'aria-pressed': String(fav), title: 'Избранное чаще попадает в новые недели',
        onclick: () => { const on = toggleIn('favorites', r.id); rerender({ keepScroll: true }); toast(on ? 'В избранном — будет чаще в новых неделях' : 'Убрано из избранного'); } }, icon(fav ? 'starOn' : 'star'), fav ? 'В избранном' : 'В избранное'),
      h('button', { class: 'btn small', 'aria-pressed': String(hidden),
        onclick: () => hideToggle(r, rerender) }, icon(hidden ? 'eye' : 'eyeOff'), hidden ? 'Вернуть' : 'Не предлагать'),
      state.plan?.batches?.length ? h('button', { class: 'btn small', onclick: () => putInPlan({ recipe: r }, rerender) }, icon('plan'), 'В план') : null,
      r.custom ? h('a', { class: 'btn small', href: `#/builder/${r.id}` }, 'Изменить') : null)));
  root.append(h('h1', null, r.title));
  if (r.title_de) root.append(h('p', { class: 'muted', style: { marginTop: '-4px' } }, r.title_de));
  root.append(h('p', null, r.description));
  if ((r.tags || []).includes('спорное') || hidden) {
    root.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
      (r.tags || []).includes('спорное') ? h('span', { class: 'badge', title: 'Сочетание продуктов на любителя' }, 'необычное сочетание — на любителя') : null,
      hidden ? h('span', { class: 'badge' }, 'не предлагается в плане') : null));
  }

  // Время и КБЖУ — две строки вместо девяти плиток
  const macroK = { p: ps.protein * 4, f: ps.fat * 9, c: ps.carbs * 4 };
  const mk = macroK.p + macroK.f + macroK.c || 1;
  root.append(h('section', { class: 'facts-line' },
    h('div', { class: 'fl-row' }, icon('clock'),
      r.compiled
        ? h('span', null, h('b', null, `≈ ${r.time.total} мин всего`), r.time.total_range[0] !== r.time.total_range[1] ? h('span', { class: 'muted' }, ` (${r.time.total_range[0]}–${r.time.total_range[1]})`) : null,
          // руками — диапазоном до верхней границы (S53): у новичка нарезка идёт дольше, чем у повара
          ` · руками ${minutesRange(r.time.active_range?.[0] ?? r.time.active, r.time.active_range?.[1] ?? r.time.active)} мин`, h('span', { class: 'muted' }, ` · само готовится ${r.time.passive} мин`))
        : h('span', null, h('b', null, `${r.time.total} мин всего`), ` · активно ${r.time.active} мин`,
          h('span', { class: 'muted' }, ` (подготовка ${r.time.prep}, готовка ${r.time.cook})`))),
    (r.warnings || []).map((w) => h('div', { class: 'need-line small' }, `⚠ ${w}`)),
    h('div', { class: 'fl-row' },
      h('span', { class: 'big' }, eur(ps.cost * factor)), h('span', { class: 'muted' }, ' за порцию на 1 человека'),
      h('span', { class: 'fl-sep' }), h('b', null, `${num(kcal)} ккал`)),
    h('div', { class: 'macros' },
      h('div', { class: 'macro-bar', role: 'img', 'aria-label': 'Доля калорий из белков, жиров и углеводов' },
        h('i', { class: 'p', style: { width: `${(macroK.p / mk) * 100}%` } }),
        h('i', { class: 'f', style: { width: `${(macroK.f / mk) * 100}%` } }),
        h('i', { class: 'c', style: { width: `${(macroK.c / mk) * 100}%` } })),
      h('div', { class: 'macro-legend' },
        h('span', null, h('i', { class: 'p' }), `Белки ${num(ps.protein * factor)} г`),
        h('span', null, h('i', { class: 'f' }), `Жиры ${num(ps.fat * factor)} г`),
        h('span', null, h('i', { class: 'c' }), `Углеводы ${num(ps.carbs * factor)} г`))),
    h('p', { class: 'muted small-print' }, `На одну порцию для одного человека${Math.abs(factor - 1) > 0.01 ? ` — на ${Math.round(Math.abs(factor - 1) * 100)} % ${factor < 1 ? 'меньше' : 'больше'} базовой, под вашу норму` : ''}. Цены от ${humanDate(state.data.meta.price_date)}, состав — по этикеткам Billa или справочным таблицам.`)));

  // Свой вариант, у продукта которого нет КБЖУ: калории занижены — предлагаем указать
  if (r.custom && r.unknownKeys?.length) {
    root.append(h('p', { class: 'notice' }, 'Калории и белок без учёта: ',
      r.unknownKeys.map((k, j) => [j ? ', ' : '', h('button', { class: 'linkbtn', onclick: () => editCustomProduct(k, () => rerender({ keepScroll: true })) }, `${state.data.products[k]?.name_ru} — указать КБЖУ`)]),
      '. ', h('a', { href: `#/builder/${r.id}` }, 'Изменить вариант')));
  }

  // Сложность и что есть дома
  const d = difficulty(r);
  const { home, stock: stockAll } = homeForPlanning();
  const lacking = missingFromHome(r, factor, portions, home);
  // посуда, которой нет (вторая кастрюля, духовка), — так же заранее, рядом с продуктами; заменимая утварь
  // (тёрка, миска, дуршлаг…) — с тем, чем обойтись, и что купить, если захочется (S28)
  const noTools = missingToolItems(r, state.prefs.equipment);
  const noGear = missingGear(r, state.prefs.equipment);
  const firstBuy = noGear.find((g) => g.first);
  root.append(h('section', { class: 'diff-box' },
    h('div', null, h('b', null, `Сложность: ${d.label.toLowerCase()}`), d.reasons.length ? h('span', { class: 'muted' }, ` — ${d.reasons.join(', ')}`) : null),
    d.tip ? h('div', { class: 'muted small' }, d.tip) : null,
    ...(r.ahead || []).map((t) => h('div', { class: 'need-line small' }, h('b', null, 'Заранее: '), t)),
    lacking.length || noTools.length
      ? h('div', { class: 'need-line small' }, `Дома не хватает: ${[...noTools.map((t) => `${t.name.toLowerCase()}${t.de || t.price ? ` (${[t.de, t.price].filter(Boolean).join(', ')}${t.why ? ` — ${t.why}` : ''})` : ''}`), ...lacking.map((m) => state.data.products[m.key]?.name_ru?.toLowerCase() || m.key)].join(', ')}`)
      : h('div', { class: 'have-line small' }, noGear.length ? 'Продукты и обязательная посуда есть' : 'Всё нужное есть дома'),
    checkAtHome(r, stockAll).length ? h('div', { class: 'need-line small' }, `Проверь, есть ли дома: ${checkAtHome(r, stockAll).join(', ')} — в запасах не отмечены`) : null,
    noGear.length ? h('div', { class: 'need-line small' }, `Дома не хватает из утвари: ${noGear.map((g) => `${g.name.toLowerCase()}${g.alt ? ` (обойдёмся: ${g.alt})` : ''}`).join(', ')}`) : null,
    // что купить первым (дуршлаг: слив кипятка без него — самое опасное место) — отдельной строкой, с ценой-ориентиром
    firstBuy ? h('div', { class: 'need-line small' }, h('b', null, 'Купить первым: '), `${firstBuy.name.toLowerCase()} (${[firstBuy.de, firstBuy.price].filter(Boolean).join(', ')}) — ${firstBuy.first}.`) : null,
    noGear.length ? h('div', { class: 'muted small' }, `Шаги уже написаны так, чтобы обойтись без этого. Купить при случае (цены — ориентир): ${noGear.filter((g) => g !== firstBuy).map((g) => `${g.de}${g.price ? ` ${g.price}` : ''}`).filter(Boolean).join(', ') || '—'}. Есть дома — `,
      h('a', { href: '#/profile' }, 'отметьте в профиле'), '.') : null));

  // начатая готовка — «Продолжить готовку · шаг N» (с теми порциями, на которые начата) и «Начать заново» (S64)
  const resume = cookResume(r.id, { f: factor, p: portions });
  const cookBtn = (cls) => (resume
    ? h('a', { class: `btn primary ${cls}`, href: resume.href }, icon('pot'), resume.label)
    : h('a', { class: `btn primary ${cls}`, href: `#/cook/${r.id}?f=${factor}&p=${portions}` }, icon('pot'), 'Готовить по шагам'));
  root.append(h('div', { class: 'no-print', style: { margin: '16px 0 4px' } }, cookBtn('wide'),
    resume ? h('button', { class: 'linkbtn', onclick: () => { state.cook[r.id] = { step: 0, done: [], checks: {}, ings: state.cook[r.id]?.ings || [] }; for (const [k, t] of Object.entries(state.timers)) if (t.rid === r.id) delete state.timers[k]; save(); location.hash = `#/cook/${r.id}?f=${factor}&p=${portions}`; } }, `Начать заново на ${portions} ${plural(portions, 'порцию', 'порции', 'порций')}`) : null));

  // Ингредиенты с отметками «подготовлено»
  const prep = prepState(r.id);
  root.append(h('div', { class: 'row between', style: { marginTop: '22px' } },
    h('h2', { style: { margin: 0 } }, 'Ингредиенты'),
    h('div', { class: 'stepper no-print', role: 'group', 'aria-label': 'Число порций' },
      h('button', { 'aria-label': 'Меньше порций', onclick: () => setPortions(Math.max(1, portions - 1)) }, '−'),
      h('span', null, `${portions} порц.`),
      h('button', { 'aria-label': 'Больше порций', onclick: () => setPortions(Math.min(8, portions + 1)) }, '+'))));
  // «Какой стакан?» — только если у ингредиента мера «стакан» (не «стаканчик» йогурта, S70)
  const glass = r.ingredients.some((i) => GLASS_MEASURE.test(ingredientMeasure(r, i, scale, state.data.kitchen).measure || ''));
  root.append(h('div', { class: 'muted', style: { margin: '6px 0 0' } }, 'Отмечайте, что уже достали и отмерили. ', glass ? h('details', { class: 'measure-hint' }, h('summary', null, 'Какой стакан?'), h('span', null, MEASURE_HINT)) : null,
    prep.ings.length ? h('button', { class: 'linkbtn', onclick: () => { prep.ings = []; save(); rerender({ keepScroll: true }); } }, ' Снять отметки') : null));
  root.append(ingredientList(r, scale, { onToggle: () => rerender({ keepScroll: true }), onSwap: () => rerender({ keepScroll: true }) }));

  root.append(h('details', { class: 'plain', style: { marginTop: '12px' } },
    h('summary', null, `Из чего складывается ${eur(ps.cost * factor)} за порцию`),
    h('div', { class: 'table-wrap', tabindex: '0', 'aria-label': 'Из чего складывается цена, таблица' }, h('table', null, h('tbody', null, r.cost_breakdown.filter((c) => c.cost_per_serving > 0.004).sort((a, b) => b.cost_per_serving - a.cost_per_serving).map((c) =>
      h('tr', null, h('td', null, c.name_ru, c.is_estimate ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'оценка') : null),
        h('td', { class: 'muted' }, `${costAmount(r, c, factor)} · ${c.store || ''}`),
        h('td', { class: 'num' }, eur(c.cost_per_serving * factor))))))),
    h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Стоимость — по доле упаковки, которая уходит в блюдо (самая выгодная обычная цена, без акций).')));

  const eq = state.prefs.equipment;
  const missing = missingTools(r, eq);
  if (r.equipment?.length || missing.length) root.append(h('h2', null, 'Посуда'));
  const missingInfo = missingToolItems(r, eq);
  if (missing.length) root.append(h('p', { class: 'notice' }, `Для этого блюда нужно то, чего у вас нет: ${missingInfo.map((t) => `${t.name.toLowerCase()}${t.price ? ` (${[t.de, t.price].filter(Boolean).join(', ')})` : ''}${t.why ? ` — ${t.why}` : ''}`).join(', ')}. В план оно не попадает. `, h('a', { href: '#/profile' }, 'Изменить в профиле')));
  // собрана движком из шагов (core/equipment.js buildGear); чего нет дома — помечено и сказано, чем обойтись
  const lackIds = new Set(missingGear(r, eq).map((g) => g.id));
  root.append(h('div', { class: 'chips' }, r.gear
    ? r.gear.map((g) => h('span', { class: `chip static${lackIds.has(g.id) || (g.hard && g.id && !has(eq, g.id)) ? ' lack' : ''}` }, gearLabel(g),
      lackIds.has(g.id) && g.alt ? h('span', { class: 'muted' }, ` · нет дома: ${g.alt}`) : null))
    : (r.equipment || []).map((e) => h('span', { class: 'chip static' }, e))));

  root.append(h('div', { class: 'row between no-print', style: { marginTop: '1.75rem' } }, h('h2', { style: { margin: 0 } }, 'Как готовить'),
    cookBtn('')));
  const revertAll = () => {
    const prev = { ...(state.custom?.subs?.[r.id] || {}) };
    for (const k of Object.keys(prev)) setSub(r.id, k, null);
    rerender({ keepScroll: true });
    toast('Блюдо — как в рецепте', { label: 'Отменить', onClick: () => { for (const [k, v] of Object.entries(prev)) setSub(r.id, k, v); rerender({ keepScroll: true }); } });
  };
  const sw = swapNotice(r, { onRevert: revertAll });
  if (sw) root.append(sw);
  const showGrams = !!state.prefs.showGrams;
  root.append(h('ol', { class: 'steps' }, r.steps.map((s, k) => h('li', { class: s.changed ? 'changed' : null }, nb(stepText(r, s, scale, state.data.kitchen, { showGrams })),
    s.changed ? [' ', h('span', { class: 'badge warn swap-badge' }, 'изменено заменой')] : null,
    stepHints(s, eq).map((t) => h('div', { class: 'tool-hint' }, t)),
    s.why ? h('div', { class: 'muted small' }, `Зачем: ${s.why}`) : null,
    s.note ? h('div', { class: 'tool-hint' }, s.note) : null,
    readyBlock(r, s, { open: false }),
    s.wait_for != null ? h('div', { class: 'muted small' }, `Начни, когда закончится шаг ${s.wait_for + 1}.`) : null,
    s.parallel?.length ? h('div', { class: 'muted small' }, `Параллельно идёт шаг ${s.parallel.map((j) => j + 1).join(', ')} — не выключай его`) : null,
    heatLabel(s) || timeLabel(s) ? h('div', { class: 'row', style: { marginTop: '4px' } },
      heatLabel(s) ? h('span', { class: 'badge' }, heatLabel(s)) : null,
      timeLabel(s) ? h('span', { class: 'badge accent' }, timeLabel(s)) : null) : null))));

  const fin = doneWhenBlock(r);
  if (fin) root.append(fin);

  if (r.mistakes?.length) {
    root.append(h('h2', null, 'Частые ошибки'));
    // у пункта — его шаг (S74): в режиме готовки он показывается там же
    root.append(h('ul', { class: 'clean' }, r.mistakes.map((m, i) => h('li', null, m,
      r.mistake_steps?.[i] != null ? h('span', { class: 'muted small' }, ` — шаг ${r.mistake_steps[i] + 1}`) : null))));
  }

  const st = r.storage || {};
  root.append(h('h2', null, 'Хранение и разогрев'));
  root.append(h('div', { class: 'stack' },
    h('p', { style: { margin: 0 } }, st.fridge_days ? `В холодильнике: до ${st.fridge_days} ${st.fridge_days === 1 ? 'дня' : 'дней'} в закрытом контейнере.` : 'Лучше есть сразу — блюдо не для хранения.'),
    h('p', { style: { margin: 0 } }, st.freezable ? `Можно заморозить${st.freeze_note ? ': ' + st.freeze_note : ''}.` : `Замораживать не стоит${st.freeze_note ? ': ' + st.freeze_note : ''}.`),
    has(eq, 'microwave') ? h('p', { style: { margin: 0 } }, h('b', null, 'В микроволновке: '), 'под крышкой или перевёрнутой тарелкой 2–3 мин на полной мощности, перемешать на середине. Если суховато — добавь 1 столовую ложку воды.') : null,
    st.reheat ? h('p', { style: { margin: 0 } }, h('b', null, has(eq, 'microwave') ? 'Без микроволновки: ' : 'Разогрев: '), st.reheat) : null));

  // Замены шаблона: только совместимые с этим блюдом (роль, способ, посуда); выбрать — «варианты и замены» у ингредиента
  const card = r.compiled ? state.data.cards?.get(r.id) : null;
  // от того, что сейчас в блюде: заменённое — «сейчас: булгур (вместо риса) → другие варианты · вернуть рис» (S58)
  const subRows = card ? card.ingredients.map((i) => {
    const slot = i.id || i.key;
    const now = r.ingredients.find((x) => (x.id || x.key) === slot);
    const cur = now?.replaced ? now.key : null;
    const opts = subOptions(card, slot, cookEnv()).filter((o) => o.allowed && o.key !== cur);
    if (!opts.length && !cur) return null;
    return h('li', null, cur ? [h('b', null, now.name_ru), h('span', { class: 'muted' }, ` (вместо «${i.name_ru.toLowerCase()}»)`)] : h('span', null, i.name_ru),
      opts.length ? [h('span', { class: 'muted' }, ' → '), opts.map((o) => o.name_ru.toLowerCase()).join(', ')] : null,
      cur ? [' · ', h('button', { class: 'linkbtn', onclick: () => { setSub(r.id, slot, null); rerender({ keepScroll: true }); toast(`Вернул: ${i.name_ru}`, { label: 'Отменить', onClick: () => { setSub(r.id, slot, cur); rerender({ keepScroll: true }); } }); } }, `вернуть «${i.name_ru.toLowerCase()}»`)] : null);
  }).filter(Boolean) : [];
  if (subRows.length) {
    root.append(h('h2', null, 'Замены'));
    root.append(h('ul', { class: 'subs' }, subRows));
    root.append(h('p', { class: 'muted' }, 'Выбрать — «варианты и замены» у ингредиента: покажем, что изменится (время, количество, способ, белок, цена), шаги и таймеры пересоберутся.'));
  } else if (r.substitutions?.length) {
    root.append(h('h2', null, 'Замены'));
    root.append(h('ul', { class: 'subs' }, r.substitutions.map((s) =>
      h('li', null, h('span', null, s.from), h('span', { class: 'muted' }, ' → '), h('b', null, s.to), s.note ? h('div', { class: 'muted' }, s.note) : null))));
  }
  if (r.notes) root.append(h('p', { class: 'muted', style: { marginTop: '16px' } }, 'Адаптация: ', r.notes));
  if (r.source?.url) root.append(h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Оригинал: ', h('a', { href: r.source.url, target: '_blank', rel: 'noopener' }, r.source.name), '. Шаги пересказаны своими словами.'));
}

// «Не предлагать»: с отменой; подсказка — убрать блюдо из текущей недели можно через «Заменить» в плане
export function hideToggle(r, rerender) {
  const on = toggleIn('hidden', r.id);
  rerender({ keepScroll: true });
  const inPlan = on && state.plan?.batches?.some((b) => b.recipeId === r.id);
  toast(on ? `«${r.title}» больше не предлагается${inPlan ? '. В этой неделе — замените в плане' : ''}` : `«${r.title}» снова предлагается`,
    { label: 'Отменить', onClick: () => { toggleIn('hidden', r.id); rerender({ keepScroll: true }); } });
}

export function amountCell(a) {
  return h('td', { class: 'num' }, a.main, a.sub ? h('div', { class: 'de' }, a.sub) : null);
}
