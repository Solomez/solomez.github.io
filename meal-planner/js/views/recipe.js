import { h, eur, num, icon, factorText, humanDate, nb, plural, toast } from '../ui.js';
import { state, save, toggleIn } from '../state.js';
import { formatAmount, chooseOffer, buildShoppingList } from '../core/shopping.js';
import { scaleMeasure, scaleWords, packShare } from '../core/amounts.js';
import { photo, thumbPack, showVariants, substitutesOf } from './products.js';
import { missingTools, stepHints, has } from '../core/equipment.js';
import { difficulty } from '../core/difficulty.js';
import { missingFromHome } from '../core/planner.js';
import { homeForPlanning } from './money.js';
import { editCustomProduct } from './builder.js';

const storeHint = (p) => {
  const best = p?.packs?.find((x) => !x.stale) || p?.packs?.[0];
  if (!best) return '';
  return `${best.store}: ${best.name_de}${best.is_estimate ? ' (цена — оценка)' : ''}`;
};

// Количество для человека. При другом размере порции бытовая мера пересчитывается («1,5 ст. л.» × 0,8 → «1¼ ст. л.»),
// без множителей; у продуктов с весом — граммы и доля упаковки, которую покупают (а не мера базового рецепта)
export function ingredientAmount(ing, scale, products, servings = 2, packOf = null) {
  const same = Math.abs(scale - 1) < 0.01;
  if (same) return { main: ing.amount, sub: ing.grams ? `${Math.round(ing.grams)} г` : '' };
  if (ing.basic || !ing.grams) return { main: scaleMeasure(ing.amount, scale) ?? scaleWords(ing.amount, scale), sub: '' };
  const g = ing.grams * scale;
  const p = products[ing.key];
  // доля той упаковки, что в списке покупок этой недели (купили 1 кг — «половина упаковки 1 кг», а не «почти вся 500 г»)
  const pack = packOf?.get(ing.key) || (p ? chooseOffer(p, g)?.pack : null);
  const unit = pack?.pack_unit === 'ml' ? 'мл' : 'г';
  const share = pack && !pack.loose && pack.pack_unit !== 'pcs' ? packShare(g, pack.grams, unit) : null;
  const measure = /шт|зубч|ломт|филе|яйц|кубик|стакан|ст\. л|ч\. л/.test(ing.amount) ? scaleMeasure(ing.amount.split(' (')[0].split(' — ')[0], scale) : null;
  return { main: formatAmount(ing.key, g, p), sub: [measure, share].filter(Boolean).join(' · ') };
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

export function ingredientList(r, scale, { checkable = true, onToggle } = {}) {
  const products = state.data.products;
  const packs = weekPacks();
  const prep = prepState(r.id);
  const row = (i) => {
    const a = ingredientAmount(i, scale, products, r.servings, packs);
    const done = prep.ings.includes(i.key);
    const toggle = () => {
      const s = new Set(prep.ings);
      s.has(i.key) ? s.delete(i.key) : s.add(i.key);
      prep.ings = [...s];
      save();
      onToggle?.();
    };
    return h('li', { class: 'ing-row' + (checkable ? '' : ' no-check') + (i.basic ? ' no-thumb' : '') + (done ? ' done' : '') },
      checkable ? h('input', { type: 'checkbox', id: `ing-${r.id}-${i.key}`, checked: done, onchange: toggle, 'aria-label': `Подготовлено: ${i.name_ru}` }) : null,
      !i.basic && products[i.key] ? photo(products[i.key], thumbPack(products[i.key]), { cls: 'thumb sm', label: i.name_ru }) : null,
      h('label', { class: 'ing-text', for: checkable ? `ing-${r.id}-${i.key}` : null },
        h('span', { class: 'ing-name' }, i.name_ru, i.optional ? h('span', { class: 'muted' }, ' · по желанию') : null),
        h('span', { class: 'de' }, [i.name_de, !i.basic ? storeHint(products[i.key]) : null].filter(Boolean).join(' · ')),
        (products[i.key]?.packs || []).length > 1 || substitutesOf(i.key).length ? h('button', { class: 'linkbtn small-link', type: 'button', onclick: (e) => { e.preventDefault(); showVariants(products[i.key]); } }, substitutesOf(i.key).length ? 'варианты и замены' : 'варианты в магазинах') : null,
        i.note ? h('span', { class: 'de' }, i.note) : null,
        swapOf(i.key) ? h('span', { class: 'swap-note' }, `На этой неделе куплено вместо: ${swapOf(i.key).name}`) : null),
      h('span', { class: 'ing-amount' }, a.main, a.sub ? h('span', { class: 'de' }, a.sub) : null));
  };
  const main = r.ingredients.filter((i) => !i.basic);
  const basic = r.ingredients.filter((i) => i.basic);
  return h('div', null,
    h('ul', { class: 'ing-list' }, main.map(row)),
    basic.length ? [h('div', { class: 'eyebrow', style: { marginTop: '14px' } }, 'Базовое: масло, соль, специи'), h('ul', { class: 'ing-list' }, basic.map(row))] : null);
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
  const fav = (state.prefs.favorites || []).includes(r.id);
  const hidden = (state.prefs.hidden || []).includes(r.id);
  const setPortions = (n) => { location.replace(`#/recipe/${r.id}?f=${factor}&p=${n}`); };
  const kcal = ps.kcal * factor;

  // Шапка: назад, название, действия
  root.append(h('div', { class: 'row between no-print', style: { marginBottom: '6px', flexWrap: 'wrap', gap: '6px' } },
    h('a', { class: 'btn icon ghost', href: lastListRoute, 'aria-label': 'Назад', title: 'Назад' }, icon('back')),
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
      h('button', { class: 'btn small', 'aria-pressed': String(fav), title: 'Избранное чаще попадает в новые недели',
        onclick: () => { const on = toggleIn('favorites', r.id); rerender({ keepScroll: true }); toast(on ? 'В избранном — будет чаще в новых неделях' : 'Убрано из избранного'); } }, icon(fav ? 'starOn' : 'star'), fav ? 'В избранном' : 'В избранное'),
      h('button', { class: 'btn small', 'aria-pressed': String(hidden),
        onclick: () => hideToggle(r, rerender) }, icon(hidden ? 'eye' : 'eyeOff'), hidden ? 'Вернуть' : 'Не предлагать'),
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
      h('span', null, h('b', null, `${r.time.total} мин всего`), ` · активно ${r.time.active} мин`,
        h('span', { class: 'muted' }, ` (подготовка ${r.time.prep}, готовка ${r.time.cook})`))),
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
  const { home } = homeForPlanning();
  const lacking = missingFromHome(r, factor, portions, home);
  root.append(h('section', { class: 'diff-box' },
    h('div', null, h('b', null, `Сложность: ${d.label.toLowerCase()}`), d.reasons.length ? h('span', { class: 'muted' }, ` — ${d.reasons.join(', ')}`) : null),
    d.tip ? h('div', { class: 'muted small' }, d.tip) : null,
    lacking.length
      ? h('div', { class: 'need-line small' }, `Дома не хватает: ${lacking.map((m) => state.data.products[m.key]?.name_ru?.toLowerCase() || m.key).join(', ')}`)
      : h('div', { class: 'have-line small' }, 'Всё нужное есть дома')));

  root.append(h('div', { class: 'no-print', style: { margin: '16px 0 4px' } },
    h('a', { class: 'btn primary wide', href: `#/cook/${r.id}?f=${factor}&p=${portions}` }, icon('pot'), 'Готовить по шагам')));

  // Ингредиенты с отметками «подготовлено»
  const prep = prepState(r.id);
  root.append(h('div', { class: 'row between', style: { marginTop: '22px' } },
    h('h2', { style: { margin: 0 } }, 'Ингредиенты'),
    h('div', { class: 'stepper no-print', role: 'group', 'aria-label': 'Число порций' },
      h('button', { 'aria-label': 'Меньше порций', onclick: () => setPortions(Math.max(1, portions - 1)) }, '−'),
      h('span', null, `${portions} порц.`),
      h('button', { 'aria-label': 'Больше порций', onclick: () => setPortions(Math.min(8, portions + 1)) }, '+'))));
  root.append(h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Отмечайте, что уже достали и отмерили.',
    prep.ings.length ? h('button', { class: 'linkbtn', onclick: () => { prep.ings = []; save(); rerender({ keepScroll: true }); } }, ' Снять отметки') : null));
  root.append(ingredientList(r, scale, { onToggle: () => rerender({ keepScroll: true }) }));

  root.append(h('details', { class: 'plain', style: { marginTop: '12px' } },
    h('summary', null, `Из чего складывается ${eur(ps.cost * factor)} за порцию`),
    h('div', { class: 'table-wrap', tabindex: '0', 'aria-label': 'Из чего складывается цена, таблица' }, h('table', null, h('tbody', null, r.cost_breakdown.filter((c) => c.cost_per_serving > 0.004).sort((a, b) => b.cost_per_serving - a.cost_per_serving).map((c) =>
      h('tr', null, h('td', null, c.name_ru, c.is_estimate ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'оценка') : null),
        h('td', { class: 'muted' }, `${num(c.grams_per_serving * factor)} г · ${c.store || ''}`),
        h('td', { class: 'num' }, eur(c.cost_per_serving * factor))))))),
    h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Стоимость — по доле упаковки, которая уходит в блюдо (самая выгодная обычная цена, без акций).')));

  const eq = state.prefs.equipment;
  const missing = missingTools(r, eq);
  if (r.equipment?.length || missing.length) root.append(h('h2', null, 'Посуда'));
  if (missing.length) root.append(h('p', { class: 'notice' }, `Для этого блюда нужно то, чего у вас нет: ${missing.join(', ').toLowerCase()}. В план оно не попадает. `, h('a', { href: '#/profile' }, 'Изменить в профиле')));
  root.append(h('div', { class: 'chips' }, r.equipment.map((e) => h('span', { class: 'chip static' }, e))));

  root.append(h('div', { class: 'row between no-print', style: { marginTop: '1.75rem' } }, h('h2', { style: { margin: 0 } }, 'Как готовить'),
    h('a', { class: 'btn primary', href: `#/cook/${r.id}?f=${factor}&p=${portions}` }, icon('pot'), 'Готовить по шагам')));
  root.append(h('ol', { class: 'steps' }, r.steps.map((s) => h('li', null, nb(s.text),
    stepHints(s, eq).map((t) => h('div', { class: 'tool-hint' }, t)),
    s.heat || s.timer_min ? h('div', { class: 'row', style: { marginTop: '4px' } },
      s.heat ? h('span', { class: 'badge' }, `огонь: ${s.heat}`) : null,
      s.timer_min ? h('span', { class: 'badge accent' }, `${num(s.timer_min, 1)} мин`) : null) : null))));

  if (r.mistakes?.length) {
    root.append(h('h2', null, 'Частые ошибки'));
    root.append(h('ul', { class: 'clean' }, r.mistakes.map((m) => h('li', null, m))));
  }

  const st = r.storage || {};
  root.append(h('h2', null, 'Хранение и разогрев'));
  root.append(h('div', { class: 'stack' },
    h('p', { style: { margin: 0 } }, st.fridge_days ? `В холодильнике: до ${st.fridge_days} ${st.fridge_days === 1 ? 'дня' : 'дней'} в закрытом контейнере.` : 'Лучше есть сразу — блюдо не для хранения.'),
    h('p', { style: { margin: 0 } }, st.freezable ? `Можно заморозить${st.freeze_note ? ': ' + st.freeze_note : ''}.` : `Замораживать не стоит${st.freeze_note ? ': ' + st.freeze_note : ''}.`),
    has(eq, 'microwave') ? h('p', { style: { margin: 0 } }, h('b', null, 'В микроволновке: '), 'под крышкой или перевёрнутой тарелкой 2–3 мин на полной мощности, перемешать на середине. Если суховато — добавь 1 ст. л. воды.') : null,
    st.reheat ? h('p', { style: { margin: 0 } }, h('b', null, has(eq, 'microwave') ? 'Без микроволновки: ' : 'Разогрев: '), st.reheat) : null));

  if (r.substitutions?.length) {
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
  toast(on ? `Не будет в новых неделях${inPlan ? '. В этой неделе — замените в плане' : ''}` : 'Снова предлагается в плане',
    { label: 'Отменить', onClick: () => { toggleIn('hidden', r.id); rerender({ keepScroll: true }); } });
}

export function amountCell(a) {
  return h('td', { class: 'num' }, a.main, a.sub ? h('div', { class: 'de' }, a.sub) : null);
}
