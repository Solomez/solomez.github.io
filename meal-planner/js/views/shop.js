import { h, eur, num, sheet, copyText, download, icon, meter } from '../ui.js';
import { state, save, IS_ARTIFACT } from '../state.js';
import { buildShoppingList, formatAmount, formatPack, chooseOffer } from '../core/shopping.js';
import { planTrips, buyAheadDays } from '../core/trips.js';
import { shoppingToText } from '../core/export.js';
import { photo, thumbPack, showVariants, showAlternatives, substitutesOf, storageOf, storageChip, PLACES } from './products.js';
import { remainingPlan, todayIndex, dayDate, fmtDate, weekdayIndex } from '../core/calendar.js';
import { MEALS } from '../core/planner.js';

const STORES = ['Billa', 'Spar', 'Hofer', 'Penny', 'Lidl'];
const ui = { group: 'days', showInfo: false, openUses: null, scope: 'rest' };

export function renderShop(root, rerender) {
  const redraw = () => rerender({ keepScroll: true });
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Покупки'),
    state.plan?.batches?.length ? h('button', { class: 'btn icon ghost no-print', 'aria-label': 'Экспорт списка', title: 'Экспорт', onclick: () => exportList(list, products, departments, checked) }, icon('share')) : null));
  if (!state.plan?.batches?.length) {
    root.append(h('p', null, 'Сначала составьте план. ', h('a', { href: '#/plan' }, 'К плану')));
    return;
  }
  const products = state.data.products;
  const departments = state.data.meta.departments;
  // Список — на то, что ещё предстоит приготовить (по текущим дате и времени), или на всю неделю
  const now = new Date();
  const plan = state.plan;
  const rest = remainingPlan(plan, now);
  const listPlan = ui.scope === 'rest' ? rest : plan;
  const list = buildShoppingList(listPlan, state.recipeMap, products, { stores: state.prefs.stores });
  const checked = (state.checked[state.plan.id] = state.checked[state.plan.id] || {});
  const toggle = (k, v) => { checked[k] = v; save(); redraw(); };
  const bought = list.items.filter((i) => checked[i.key]);
  const boughtSum = bought.reduce((a, i) => a + (i.offer?.cost || 0), 0);

  const first = rest.batches[0]?.slots[0];
  const firstExtra = [...(rest.extras || [])].sort((a, b) => a.day - b.day)[0];
  const from = [first, firstExtra].filter(Boolean).sort((a, b) => a.day - b.day || (order[a.meal] - order[b.meal]))[0];
  root.append(h('div', { class: 'scope no-print' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'На какой период' },
      [['rest', 'Оставшееся'], ['week', 'Вся неделя']].map(([v, l]) =>
        h('button', { class: ui.scope === v ? 'on' : '', 'aria-pressed': String(ui.scope === v), onclick: () => { ui.scope = v; redraw(); } }, l))),
    h('p', { class: 'muted', style: { margin: 0 } }, ui.scope === 'rest'
      ? (from ? `С ${MEALS[from.meal].toLowerCase()}а ${fmtDate(dayDate(plan, from.day))} по ${fmtDate(dayDate(plan, 6))}: то, что уже приготовлено или съедено, не входит.` : 'В плане больше ничего не осталось — составьте следующую неделю.')
      : `Весь план: ${fmtDate(dayDate(plan, 0))} – ${fmtDate(dayDate(plan, 6))}.`)));
  if (!list.items.length && !list.basics.length) return;

  // Прогресс и итог
  root.append(h('section', { class: 'summary' },
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'big' }, eur(list.total)), h('span', { class: 'muted' }, ` · ${list.items.length} позиций`)),
      h('span', { class: 'muted' }, `куплено ${bought.length} из ${list.items.length}`)),
    meter(boughtSum, list.total || 1, 'progress'),
    h('div', { class: 'store-sums' }, Object.entries(list.byStore).sort((a, b) => b[1].total - a[1].total).map(([s, v]) =>
      h('span', null, h('b', null, s), ` ${eur(v.total)}`)))));

  // Где покупать и как группировать — компактно, пояснение по кнопке
  const stores = state.prefs.stores || [];
  root.append(h('div', { class: 'shop-controls no-print' },
    h('div', { class: 'chips' },
      STORES.map((s) => h('button', {
        class: 'chip' + (stores.includes(s) ? ' on' : ''), 'aria-pressed': String(stores.includes(s)),
        onclick: () => { const set = new Set(stores); set.has(s) ? set.delete(s) : set.add(s); state.prefs.stores = [...set]; save(); redraw(); },
      }, s)),
      h('button', { class: 'btn icon ghost small', 'aria-label': 'Как выбираются магазины', 'aria-expanded': String(ui.showInfo), onclick: () => { ui.showInfo = !ui.showInfo; redraw(); } }, icon('info'))),
    ui.showInfo ? h('p', { class: 'muted', style: { margin: 0 } }, stores.length
      ? 'Показываются только выбранные магазины. Если продукта в них нет, он берётся из любого.'
      : 'Без выбора — для каждого продукта самая выгодная обычная цена из всех магазинов. Lidl и Penny публикуют онлайн в основном акции, поэтому их цен в базе меньше.') : null,
    h('div', { class: 'seg scroll', role: 'group', 'aria-label': 'Группировка' },
      [['days', 'По дням'], ['department', 'По отделам'], ['store', 'По магазинам'], ['storage', 'Как разложить']].map(([v, l]) =>
        h('button', { class: ui.group === v ? 'on' : '', 'aria-pressed': String(ui.group === v), onclick: () => { ui.group = v; redraw(); } }, l)))));

  // Когда продукт понадобится впервые (день готовки), считая от сегодня: фарш хранится 1–2 дня,
  // остальное сырое мясо 2–3 дня — что нужно позже, лучше заморозить сразу после покупки
  const firstDay = firstNeededDay(listPlan);
  const today = Math.max(0, todayIndex(plan, now));
  const inDays = (it) => Math.max(0, (firstDay[it.key] ?? today) - today);
  const placeOf = (it) => {
    const s = storageOf(it.key);
    if (!s) return 'pantry';
    const raw = s.place === 'fridge' && /нижняя/.test(s.shelf || '');
    const mince = /mince/.test(it.key);
    if (raw && inDays(it) >= (mince ? 2 : 3)) return 'freezer';
    return s.place;
  };
  const freezeNote = (it) => {
    if (placeOf(it) !== 'freezer' || storageOf(it.key)?.place === 'freezer') return null;
    const d = firstDay[it.key];
    return `Заморозь сразу: понадобится ${dayIn(plan, d)}. Переложи в холодильник ${dayIn(plan, d - 1)}, вечером.`;
  };

  if (ui.group === 'storage') {
    root.append(h('p', { class: 'storage-guide' }, 'Покупки удобно разложить так. Мясо и фарш, которые понадобятся позже, чем через 1–2 дня, лучше сразу заморозить. Сроки — ориентир; главное — дата на упаковке: «zu verbrauchen bis» для мяса строгая, «mindestens haltbar bis» — срок качества.'));
  }

  // По дням: план походов — один магазин в день, скоропортящееся ближе ко дню готовки
  if (ui.group === 'days') {
    renderTrips(root, { list, listPlan, plan, now, products, checked, toggle, redraw, freezeNote, placeOf });
    renderBasics(root, list, checked, toggle);
    return;
  }

  // Группы; купленное остаётся на своём месте, только зачёркивается
  const groups = ui.group === 'storage'
    ? Object.entries(PLACES).map(([id, p]) => ({ id, name: p.name, test: (i) => placeOf(i) === id }))
    : ui.group === 'store'
    ? Object.keys(list.byStore).sort((a, b) => list.byStore[b].total - list.byStore[a].total).map((s) => ({ id: s, name: s, test: (i) => i.offer?.pack.store === s }))
    : departments.map((d) => ({ id: d.id, name: d.name, test: (i) => i.department === d.id }));
  for (const g of groups) {
    const items = list.items.filter((i) => g.test(i));
    if (!items.length) continue;
    const left = items.filter((i) => !checked[i.key]);
    const sum = left.reduce((a, i) => a + (i.offer?.cost || 0), 0);
    root.append(h('div', { class: 'group-head' }, h('h2', null, g.name),
      h('span', { class: 'muted' }, left.length ? eur(sum) : 'всё куплено')));
    root.append(h('ul', { class: 'shop-list' }, items.map((it) => itemRow(it, products, !!checked[it.key], (v) => toggle(it.key, v), ui.group === 'store', redraw,
      { note: checked[it.key] ? null : freezeNote(it), place: ui.group === 'storage' ? null : placeOf(it) }))));
  }
  if (bought.length) {
    root.append(h('p', { style: { marginTop: '14px' } }, h('button', { class: 'linkbtn', onclick: () => { for (const it of bought) delete checked[it.key]; save(); redraw(); } }, `Снять все отметки (${bought.length})`)));
  }
  if (list.items.length && !list.items.some((i) => !checked[i.key])) root.append(h('p', { class: 'notice' }, 'Всё куплено. Хорошей готовки!'));

  renderBasics(root, list, checked, toggle);
}

function renderTrips(root, { list, listPlan, plan, now, products, checked, toggle, redraw, freezeNote, placeOf }) {
  const need = lastBuyDay(listPlan);
  // магазины работают примерно до 19:30 — вечером первый поход переносится на завтра
  const firstDay = todayIndex(plan, now) + (now.getHours() >= 19 ? 1 : 0);
  const byKey = new Map(list.items.map((i) => [i.key, i]));
  const allowTwo = !!state.prefs.allowTwoStores;
  const altCost = (key, store) => {
    const packs = (products[key]?.packs || []).filter((p) => p.store === store && !p.stale);
    return packs.length ? chooseOffer({ packs }, byKey.get(key).needGrams).cost : null;
  };
  const trips = planTrips(list.items.filter((i) => i.offer).map((i) => ({ key: i.key, store: i.offer.pack.store, cost: i.offer.cost })), {
    needDay: (k) => need[k] ?? firstDay, aheadOf: (k) => buyAheadDays(k, state.data.storage), firstDay,
    dateOf: (d) => dayDate(plan, d), altCost: allowTwo ? () => null : altCost,
    canFreeze: (k) => { const st = state.data.storage?.[k]; return !!st && st.place === 'fridge' && /нижняя/.test(st.shelf || '') && /^да/.test(st.freeze || ''); },
  });
  const extra = trips.reduce((a, t) => a + t.items.reduce((b, i) => b + (i.extra || 0), 0), 0);
  const twoStoreDays = Object.values(trips.reduce((m, t) => ((m[t.day] = (m[t.day] || 0) + 1), m), {})).filter((n) => n > 1).length;
  const relDay = (d) => { const t = todayIndex(plan, now); return d === t ? 'Сегодня' : d === t + 1 ? 'Завтра' : null; };

  root.append(h('section', { class: 'storage-guide trips-head' },
    h('div', null, h('b', null, `${trips.length} ${plural(trips.length, 'поход', 'похода', 'походов')}: `),
      trips.map((t, i) => [i ? ', ' : '', `${fmtDate(dayDate(plan, t.day)).split(',')[0]} — ${t.store}`])),
    h('div', { class: 'muted' }, 'Один магазин в день, походов — как можно меньше. Скоропортящееся — ближе ко дню готовки, а мясо и фарш, которые нужны позже, можно купить заранее и заморозить. По воскресеньям и праздникам магазины закрыты.'),
    extra > 0.01 ? h('div', null, `Чтобы походов было меньше, часть продуктов взята там, куда вы и так идёте: +${eur(extra)} к сумме.`) : null,
    allowTwo && twoStoreDays ? h('div', null, `Дней с двумя магазинами: ${twoStoreDays} — зато всё по самой низкой цене.`) : null,
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', id: 'allow-two', checked: allowTwo, onchange: (e) => { state.prefs.allowTwoStores = e.target.checked; save(); redraw(); } }),
      h('span', null, 'Разрешить два магазина в день, если так дешевле'))));

  for (const t of trips) {
    const date = dayDate(plan, t.day);
    const rel = relDay(t.day);
    const left = t.items.filter((i) => !checked[i.key]);
    root.append(h('div', { class: 'group-head trip-head' },
      h('h2', null, rel ? `${rel}, ${fmtDate(date).split(', ')[1]}` : fmtDate(date), h('span', { class: 'trip-store' }, ` · ${t.store}`)),
      h('span', { class: 'muted' }, left.length ? `${left.length} поз. · ${eur(left.reduce((a, i) => a + (i.cost || 0), 0))}` : 'всё куплено')));
    if (t.early) root.append(h('p', { class: 'freeze-note', style: { margin: '2px 0 0' } }, 'Ближе ко дню готовки магазины закрыты — купите заранее; мясо и фарш заморозьте.'));
    root.append(h('ul', { class: 'shop-list' }, t.items.map((ti) => {
      const base = byKey.get(ti.key);
      const it = ti.switchedFrom ? { ...base, offer: chooseOffer({ packs: (products[ti.key].packs || []).filter((p) => p.store === t.store && !p.stale) }, base.needGrams) } : base;
      const note = ti.switchedFrom ? `Здесь, а не в ${ti.switchedFrom}: ${ti.extra > 0 ? '+' + eur(ti.extra) : 'та же цена'} — зато на один поход меньше.` : null;
      // купили раньше срока свежести — заморозить и достать накануне
      const frozen = ti.freezeUntil != null
        ? `Купите сейчас и сразу заморозьте; переложите в холодильник ${dayIn(plan, ti.freezeUntil - 1)}, вечером.`
        : null;
      return itemRow(it, products, !!checked[it.key], (v) => toggle(it.key, v), true, redraw,
        { note: checked[it.key] ? null : [note, frozen || (t.day < (need[it.key] ?? t.day) - 1 ? freezeNote(it) : null)].filter(Boolean).join(' ') || null, place: ti.freezeUntil != null ? 'freezer' : placeOf(it) });
    })));
  }
}

function renderBasics(root, list, checked, toggle) {
  if (list.basics.length) {
    const products = state.data.products;
    root.append(h('div', { class: 'group-head' }, h('h2', null, 'Базовые продукты'), h('span', { class: 'muted' }, 'один раз')));
    root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, `Служат несколько недель. Отметьте, что уже есть дома. Всё с нуля — ${eur(list.basicsTotal)}.`));
    root.append(h('ul', { class: 'shop-list' }, list.basics.map((it) => {
      const k = 'basic:' + it.key;
      const pr = products[it.key];
      const pack = it.offer?.pack;
      return h('li', { class: 'shop-item with-thumb' + (checked[k] ? ' done' : '') },
        h('input', { type: 'checkbox', id: `sh-${k}`, checked: !!checked[k], onchange: (e) => toggle(k, e.target.checked) }),
        photo(pr, pack?.image ? pack : thumbPack(pr), { label: it.name_ru }),
        h('label', { for: `sh-${k}` }, h('span', { class: 'name' }, it.name_ru),
          h('span', { class: 'sub' }, [it.name_de_generic || it.name_de, pack ? `${pack.store}: ${pack.name_de}` : null].filter(Boolean).join(' · '))),
        h('span', { class: 'price' }, pack ? eur(pack.price_eur) : '—'),
        altLinks(pr, { pack }));
    })));
  }
}

// «N вариантов в магазинах» и «если нет» под товаром
function altLinks(product, { pack, needGrams, before } = {}) {
  const nPacks = (product?.packs || []).filter((p) => p.store !== 'любой').length;
  const hasAlt = pack && pack.store !== 'любой' && (substitutesOf(product.key).length || (product.packs || []).some((p) => p !== pack && p.store === pack.store));
  if (!before && nPacks < 2 && !hasAlt) return null;
  return h('div', { class: 'item-links' }, before || null,
    nPacks > 1 ? h('button', { class: 'uses-toggle linkbtn', onclick: () => showVariants(product, { needGrams }) }, `${nPacks} ${plural(nPacks, 'вариант', 'варианта', 'вариантов')} в магазинах`) : null,
    hasAlt ? h('button', { class: 'uses-toggle linkbtn', onclick: () => showAlternatives(product, { store: pack.store, needGrams, chosen: pack }) }, 'если нет') : null);
}

const DAYS_ACC = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const order = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };
// «во вторник, 20 октября» — по реальной дате дня плана
const dayIn = (plan, d) => {
  const date = dayDate(plan, d);
  const w = weekdayIndex(date);
  return `${w === 1 ? 'во' : 'в'} ${DAYS_ACC[w]}, ${fmtDate(date).split(', ')[1]}`;
};

// Первый день, когда продукт нужен (день готовки блюда)
function firstNeededDay(plan) {
  const out = {};
  const cooks = [...plan.batches.map((b) => ({ id: b.recipeId, day: Math.min(...b.slots.map((s) => s.day)) })),
    ...(plan.extras || []).map((x) => ({ id: x.recipeId, day: x.day }))];
  for (const c of cooks) {
    const r = state.recipeMap.get(c.id);
    for (const i of r?.ingredients || []) out[i.key] = Math.min(out[i.key] ?? 99, c.day);
  }
  return out;
}

// Последний день, когда можно успеть купить: к завтраку и обеду — накануне, к перекусу и ужину — в тот же день
function lastBuyDay(plan) {
  const out = {};
  const cooks = [...plan.batches.map((b) => ({ id: b.recipeId, slot: b.slots[0] })), ...(plan.extras || []).map((x) => ({ id: x.recipeId, slot: x }))];
  for (const c of cooks) {
    const d = c.slot.day - (c.slot.meal === 'breakfast' || c.slot.meal === 'lunch' ? 1 : 0);
    for (const i of state.recipeMap.get(c.id)?.ingredients || []) out[i.key] = Math.min(out[i.key] ?? 99, d);
  }
  return out;
}

function itemRow(it, products, isChecked, onToggle, byStore, redraw, extra = {}) {
  const o = it.offer;
  const flags = [];
  if (o?.pack.is_estimate) flags.push('цена — оценка');
  if (o?.pack.stale) flags.push('цена устарела');
  const open = ui.openUses === it.key;
  const id = `sh-${it.key}`;
  return h('li', { class: 'shop-item with-thumb' + (isChecked ? ' done' : '') },
    h('input', { type: 'checkbox', id, checked: isChecked, onchange: (e) => onToggle(e.target.checked) }),
    photo(products[it.key], o?.pack?.image ? o.pack : thumbPack(products[it.key]), { label: it.name_ru }),
    h('label', { for: id },
      h('span', { class: 'name' }, it.name_ru, o ? h('span', { class: 'qty' }, formatPack(o)) : null),
      h('span', { class: 'sub' }, [o ? (byStore ? o.pack.name_de : `${o.pack.store}: ${o.pack.name_de}`) : 'нет цены', ...flags].join(' · ')),
      extra.place ? h('span', null, storageChip(it.key, extra.place)) : null,
      extra.note ? h('span', { class: 'freeze-note' }, extra.note) : null),
    h('span', { class: 'price' }, o ? eur(o.cost) : '—'),
    altLinks(products[it.key], { pack: o?.pack, needGrams: it.needGrams,
      before: h('button', { class: 'uses-toggle linkbtn', 'aria-expanded': String(open), onclick: () => { ui.openUses = open ? null : it.key; redraw(); } },
        `нужно ${formatAmount(it.key, it.needGrams, products[it.key])} · ${it.uses.length === 1 ? '1 блюдо' : `${it.uses.length} блюд${it.uses.length < 5 ? 'а' : ''}`}`) }),
    open ? h('ul', { class: 'uses muted' }, it.uses.map((u) => h('li', null, `${u.title} — ${num(u.grams)} г`))) : null);
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function exportList(list, products, departments, checked) {
  const text = shoppingToText(list, products, departments, checked);
  let close;
  close = sheet('Экспорт списка', h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { copyText(text); close(); } }, 'Скопировать'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('pokupki.txt', text) }, 'Скачать .txt'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => { close(); setTimeout(() => window.print(), 50); } }, 'Печать')),
    h('textarea', { class: 'export-text', id: 'export-shop', readonly: true, rows: 10, 'aria-label': 'Текст списка', onfocus: (e) => e.target.select() }, text)));
}
