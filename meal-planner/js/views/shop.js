import { h, eur, num, sheet, copyText, download, icon, meter, plural, selectForCopy, toast, seg } from '../ui.js';
import { state, save, IS_ARTIFACT } from '../state.js';
import { formatAmount, formatPack, chooseOffer } from '../core/shopping.js';
import { firstNeededDay as neededDay, lastBuyDay as buyDay, saveModeOf, ownCost, swapCost } from '../core/checkout.js';
import { storesClosed } from '../core/trips.js';
import { routeOrder } from '../core/route.js';
import { checkoutNow, unavailableSet, weekBudget } from './money.js';
import { shoppingToText, tripsToText } from '../core/export.js';
import { photo, thumbPack, showVariants, showAlternatives, substitutesOf, storageOf, storageChip, storageDetails, PLACES } from './products.js';
import { remainingPlan, todayIndex, dayDate, fmtDate, weekdayIndex, isoDate } from '../core/calendar.js';
import { effectivePlan } from '../core/planner.js';
import { MEALS } from '../core/planner.js';
import { learnStep } from '../core/route.js';
import { byZones, zoneHead, whereIs, zoneOfKey, whereLine, itemMenu, routeEditor } from './aisle.js';
import { setHome, cartRow, pickFromCatalog } from './catalog.js';
import { aisles } from '../core/catalog.js';

const STORES = ['Billa', 'Spar', 'Hofer', 'Penny', 'Lidl'];
const ui = { group: 'days', showInfo: false, openUses: null, scope: 'rest', frozen: {}, justChecked: new Set() };
// Порядок отделов фиксируется, пока экран Покупок открыт: отметка не пересортировывает список под пальцем (F11);
// выученный маршрут применится при следующем открытии
// Отмеченное в этот заход остаётся на месте (зачёркнутым), в «Куплено» уходит при следующем открытии — строки не съезжают под пальцем
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/shop')) { ui.frozen = {}; ui.justChecked = new Set(); ui.enteredAt = 0; } });

export function renderShop(root, rerender) {
  ui.enteredAt ||= Date.now();
  const redraw = () => rerender({ keepScroll: true });
  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Покупки'),
    state.plan?.batches?.length ? h('button', { class: 'btn small no-print', onclick: () => exportList(list, products, departments, checked, state.cart, ck) }, icon('share'), 'Поделиться') : null));
  if (!state.plan?.batches?.length) {
    root.append(h('p', null, 'Сначала составьте план. ', h('a', { href: '#/plan' }, 'К плану')));
    return;
  }
  const products = state.data.products;
  const departments = state.data.meta.departments;
  // Список — на то, что ещё предстоит приготовить (по текущим дате и времени), или на всю неделю
  const now = new Date();
  const plan = state.plan;
  const rest = remainingPlan(effectivePlan(plan, ['out']), now);
  const checked = (state.checked[state.plan.id] = state.checked[state.plan.id] || {});
  // одна сумма для всех экранов: список → походы → + свои товары (что дома и «нет на полке» уже учтены)
  const ck = checkoutNow(plan, ui.scope, now);
  const { list, listPlan } = ck;
  const unavailable = unavailableSet();
  const swaps = (state.swaps[state.plan.id] = state.swaps[state.plan.id] || {});
  // отметка в походе: заодно запоминаем порядок отделов в этом магазине
  const toggle = (k, v, store) => {
    checked[k] = v;
    if (v) ui.justChecked.add(k);
    if (v && store && !k.startsWith('basic:')) learnStep(state.routes, store, zoneOfKey(k, store));
    save();
    redraw();
  };
  const ctx = { products, checked, swaps, toggle, redraw, unavailable, plan };
  const bought = list.items.filter((i) => checked[i.key]);

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
  if (!list.items.length && !list.basics.length && !list.atHome.length && !state.cart.some((c) => !c.done)) return;

  // Прогресс и итог: «к оплате» — та же сумма, что на Плане и в Итогах
  const ownN = ck.own.length;
  const allN = list.items.length + ownN;
  const boughtN = bought.length + ck.own.filter((c) => c.done).length;
  const week = ui.scope === 'rest' ? checkoutNow(plan, 'week', now) : ck;
  root.append(h('section', { class: 'summary' },
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'big' }, eur(ck.toPay)), h('span', { class: 'muted' }, ` к оплате ${ui.scope === 'rest' ? 'с сегодня' : 'за неделю'} · ${allN} ${plural(allN, 'позиция', 'позиции', 'позиций')}`)),
      h('span', { class: 'muted' }, `куплено ${boughtN} из ${allN}`)),
    meter(ck.bought, ck.toPay || 1, 'progress'),
    h('div', { class: 'muted' }, [
      ui.scope === 'rest' && week.toPay > ck.toPay + 0.01 ? `За всю неделю — ${eur(week.toPay)}, как на Плане.` : null,
      allN ? `Осталось купить ≈ ${eur(ck.left)}.` : null, // строка всегда на месте: первая отметка не сдвигает список
      ck.ownTotal > 0 ? `В том числе ваши товары вне плана — ${eur(ck.ownTotal)}.` : null,
      saveModeOf(state.prefs) === 'trips' ? 'Режим «Меньше походов»: разница с «Дешевле» — в шапке походов.' : null,
    ].filter(Boolean).join(' ') || null),
    // базовые (масло, соль, специи) в сумму не входят — сказать прямо, сколько это, если их нет дома (P3: «скрытый расход»)
    basicsLeft(list, checked) > 0.01 ? (() => {
      const open = list.basics.filter((b) => !checked['basic:' + b.key]);
      return h('div', { class: 'muted' }, `Не входит в сумму: базовые продукты (${open.slice(0, 3).map((b) => b.name_ru.toLowerCase()).join(', ')}${open.length > 3 ? '…' : ''}) — обычно уже есть дома. Если чего-то нет — ещё до ${eur(basicsLeft(list, checked))}, список внизу.`);
    })() : null,
    // неделя дороже бюджета (свои товары, «меньше походов», «нет на полке») — сказать здесь же, а не только на Плане (P7)
    week.toPay > weekBudget(plan) + 0.01 ? h('div', { class: plan.acceptOver ? 'muted' : 'field-err' }, `Неделя — ${eur(week.toPay)}, это дороже бюджета ${eur(weekBudget(plan))} на ${eur(week.toPay - weekBudget(plan))}`
      + (plan.acceptOver ? ' — вы решили оставить так.' : ck.extra > 0.01 ? '. «Дешевле» уберёт доплату за меньшее число магазинов.' : ck.ownTotal > 0 ? ', с вашими товарами вне плана.' : '.')) : null,
    h('div', { class: 'store-sums' }, Object.entries(ck.byStore).sort((a, b) => b[1].total - a[1].total).map(([s, v]) =>
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
      [['days', 'Походы'], ['department', 'Отделы'], ['store', 'Магазины'], ['storage', 'Хранение']].map(([v, l]) =>
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
    renderTrips(root, { ck, list, listPlan, plan, now, products, checked, toggle, redraw, freezeNote, placeOf, ctx });
    renderBasics(root, list, checked, toggle);
    renderAtHome(root, list, ctx);
    return;
  }

  // Группы; купленное остаётся на своём месте, только зачёркивается
  // магазин и цена товара — как в походах (с учётом «здесь, а не в …»), чтобы суммы групп сходились с «к оплате»
  const tripOf = new Map(ck.trips.flatMap((t) => t.items.map((ti) => [ti.key, ti])));
  const storeOf = (i) => tripOf.get(i.key)?.store || i.offer?.pack.store;
  const costOf = (i) => tripOf.get(i.key)?.cost ?? i.offer?.cost ?? 0;
  const groups = ui.group === 'storage'
    ? Object.entries(PLACES).map(([id, p]) => ({ id, name: p.name, test: (i) => placeOf(i) === id }))
    : ui.group === 'store'
    ? Object.keys(ck.byStore).sort((a, b) => ck.byStore[b].total - ck.byStore[a].total).map((s) => ({ id: s, name: s, test: (i) => storeOf(i) === s }))
    : departments.map((d) => ({ id: d.id, name: d.de ? `${d.name} · ${d.de}` : d.name, test: (i) => i.department === d.id }));
  for (const g of groups) {
    const items = list.items.filter((i) => g.test(i));
    if (!items.length) continue;
    const left = items.filter((i) => !checked[i.key]);
    const sum = left.reduce((a, i) => a + costOf(i), 0);
    root.append(h('div', { class: 'group-head' }, h('h2', null, g.name),
      h('span', { class: 'muted' }, left.length ? eur(sum) : 'всё куплено')));
    root.append(h('ul', { class: 'shop-list' }, items.map((it) => itemRow(it, products, !!checked[it.key], (v) => toggle(it.key, v, it.offer?.pack.store), ui.group === 'store', redraw,
      { note: checked[it.key] ? null : freezeNote(it), place: ui.group === 'storage' ? null : placeOf(it), ctx }))));
  }
  // свои товары — тоже по отделам или по магазинам
  const own = state.cart.filter((c) => !c.done || Date.now() - (c.doneAt || 0) < 12 * 3600000);
  if (own.length) {
    root.append(h('div', { class: 'group-head' }, h('h2', null, 'Ваши товары'), h('a', { class: 'small-link', href: '#/products' }, 'каталог')));
    root.append(h('ul', { class: 'shop-list' }, own.map((c) => cartRow(c, redraw))));
  }
  if (bought.length) {
    root.append(h('p', { style: { marginTop: '14px' } }, h('button', { class: 'linkbtn', onclick: () => { for (const it of bought) delete checked[it.key]; save(); redraw(); } }, `Снять все отметки (${bought.length})`)));
  }
  if (list.items.length && !list.items.some((i) => !checked[i.key])) root.append(h('p', { class: 'notice' }, 'Всё куплено. Хорошей готовки!'));

  renderBasics(root, list, checked, toggle);
  renderAtHome(root, list, ctx);
}

// Что уже есть дома — не покупаем; можно вернуть в список
function renderAtHome(root, list, ctx) {
  if (!list.atHome.length) return;
  root.append(h('div', { class: 'group-head' }, h('h2', null, 'Уже дома'), h('a', { class: 'small-link', href: '#/products?tab=home' }, 'изменить запасы')));
  root.append(h('ul', { class: 'shop-list' }, list.atHome.map((it) => h('li', { class: 'shop-item home-done' },
    h('span', { class: 'home-mark', 'aria-hidden': 'true' }, icon('home')),
    h('div', { class: 'home-main' }, h('span', { class: 'name' }, it.name_ru), h('span', { class: 'sub' }, `нужно ${formatAmount(it.key, it.totalGrams, ctx.products[it.key])} — есть дома`)),
    h('button', { class: 'btn small ghost', onclick: () => { setHome(it.key, { have: false, grams: null }); ctx.redraw(); } }, 'Купить')))));
}

// Товар не нашёлся на полке: сначала спросить — замена здесь или купить в другом магазине.
// Раньше список сразу перестраивался и товар без вопроса уезжал в другой (иногда уже пройденный) поход — P1, S11
function markUnavailable(key, store, ctx, pack) {
  const p = ctx.products[key];
  const ukey = `${store}|${key}`;
  const others = (p?.packs || []).filter((x) => x.store !== store && x.store !== 'любой');
  let close;
  // замена здесь: «нет на полке» запоминается для следующих недель, а в этой товар остаётся в походе (unavailableSet)
  const pick = (choice) => { state.unavailable[ukey] = Date.now(); recordSwap(key, store, choice, ctx, () => { delete state.unavailable[ukey]; }); };
  const elsewhere = others.length ? h('button', { class: 'btn', onclick: () => {
    close?.();
    const before = checkoutNow(ctx.plan, 'week').toPay;
    state.unavailable[ukey] = Date.now();
    save();
    ctx.redraw();
    const t = checkoutNow(ctx.plan, ui.scope).trips.find((x) => x.items.some((i) => i.key === key));
    const d = checkoutNow(ctx.plan, 'week').toPay - before;
    const money = Math.abs(d) < 0.01 ? '' : ` · неделя ${d > 0 ? '+' : '−'}${eur(Math.abs(d))}`;
    toast(t ? `Запомнил: в ${store} нет. Перенёс в поход: ${fmtDate(dayDate(ctx.plan, t.day)).split(',')[0]}, ${t.store}${money}` : `Запомнил: в ${store} нет${money}`,
      { label: 'Отменить', onClick: () => { delete state.unavailable[ukey]; save(); ctx.redraw(); } });
  } }, 'Куплю в другом магазине') : null;
  // тот же товар, которого нет на полке, первым не предлагаем (F12)
  close = showAlternatives(p, { store, needGrams: undefined, chosen: pack, onPick: pick,
    extra: h('div', { class: 'stack' }, elsewhere, h('button', { class: 'btn ghost', onclick: () => close?.() }, 'Пока ничего не менять')) });
}

// «Взял другое вместо»: отмечаем купленным и запоминаем, что именно взяли (видно в рецептах этой недели)
// here — магазин, где стоите (замена могла быть товаром из другой сети, но куплена здесь); onUndo — что ещё отменить
function recordSwap(key, store, choice, ctx, onUndo) {
  ctx.swaps[key] = { ...choice, store: choice.store || store, here: store, at: Date.now() };
  ctx.checked[key] = true;
  save();
  ctx.redraw();
  toast(`Отмечено: вместо «${ctx.products[key]?.name_ru}» — ${choice.name}`, { label: 'Отменить', onClick: () => { delete ctx.swaps[key]; delete ctx.checked[key]; onUndo?.(); save(); ctx.redraw(); } });
}

function swapFlow(key, store, ctx) {
  showAlternatives(ctx.products[key], { store, onPick: (choice) => recordSwap(key, store, choice, ctx),
    extra: h('button', { class: 'btn', onclick: () => pickFromCatalog({ title: `Что взяли вместо «${ctx.products[key]?.name_ru}»?`, store, pickLabel: 'Взял это',
      onPick: (it) => recordSwap(key, store, { ref: it.ref, name: it.name, price: it.price, image: it.image, shelf: it.shelf }, ctx) }) }, icon('search'), 'Найти в каталоге магазина') });
}

function homeFlow(it, ctx) {
  const p = ctx.products[it.key];
  let close;
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, step: 10, placeholder: 'например, 200', 'aria-label': 'Сколько есть, г' });
  close = sheet(`${p?.name_ru}: есть дома`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, `Для плана нужно ${formatAmount(it.key, it.totalGrams || it.needGrams, p)}.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { setHome(it.key, { have: true, grams: null }); close(); ctx.redraw(); } }, 'Хватит — не покупать'),
      h('button', { class: 'btn', onclick: () => input.focus() }, 'Есть, но мало')),
    h('label', { class: 'field' }, h('span', null, 'Сколько есть, граммов — докуплю разницу'), input),
    h('button', { class: 'btn', onclick: () => { const g = Math.round(+input.value || 0); if (!g) { input.focus(); return; } setHome(it.key, { have: true, grams: g }); close(); ctx.redraw(); } }, 'Сохранить количество')));
}

function renderTrips(root, { ck, list, listPlan, plan, now, products, checked, toggle, redraw, freezeNote, placeOf, ctx }) {
  const need = buyDay(listPlan, state.recipeMap);
  const cookDay = neededDay(listPlan, state.recipeMap);
  const byKey = new Map(list.items.map((i) => [i.key, i]));
  const mode = saveModeOf(state.prefs);
  const trips = ck.trips;
  const perDay = Object.values(trips.reduce((m, t) => ((m[t.day] = (m[t.day] || 0) + 1), m), {}));
  const twoStoreDays = perDay.filter((n) => n > 1).length;
  const maxPerDay = Math.max(0, ...perDay);
  const relDay = (d) => { const t = todayIndex(plan, now); return d === t ? 'Сегодня' : d === t + 1 ? 'Завтра' : null; };

  root.append(h('section', { class: 'storage-guide trips-head' },
    h('div', null, h('b', null, `${trips.length} ${plural(trips.length, 'поход', 'похода', 'походов')}: `),
      trips.map((t, i) => [i ? ', ' : '', `${fmtDate(dayDate(plan, t.day)).split(',')[0]} — ${t.store}`])),
    state.prefs.saveMode == null ? h('div', { class: 'muted' }, 'Теперь по умолчанию — «Дешевле». Раньше было «один магазин в день» — его можно вернуть кнопкой «Меньше походов».') : null,
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, 'Что важнее:'),
      seg([['money', 'Дешевле'], ['trips', 'Меньше походов']], mode, (v) => { state.prefs.saveMode = v; save(); redraw(); })),
    // пояснения — по кнопке (i) над списком: до первого товара не должно быть экрана текста (F10)
    ui.showInfo ? h('div', { class: 'muted' }, mode === 'money'
      ? `Каждый продукт — там, где он дешевле всего, без доплат.${twoStoreDays ? ` Поэтому бывает ${maxPerDay > 2 ? 'два-три магазина' : 'два магазина'} в день (таких дней: ${twoStoreDays}) — если неудобно, выберите «Меньше походов».` : ''} Скоропортящееся — ближе ко дню готовки.`
      : 'Один магазин в день, походов — как можно меньше. Скоропортящееся — ближе ко дню готовки, мясо и фарш на потом можно купить заранее и заморозить.') : null,
    mode === 'trips' ? (() => {
      const d = ck.toPay - checkoutNow(plan, ui.scope, now, { ...state.prefs, saveMode: 'money' }).toPay;
      return d > 0.01 ? h('div', { class: 'muted' }, `«Меньше походов» дороже, чем «Дешевле», на ${eur(d)} — это уже в сумме к оплате.`) : null;
    })() : null));

  // свои товары: в первый поход в их магазин; если в этот магазин похода нет — отдельным блоком
  const ownOpen = state.cart.filter((c) => !c.done || Date.now() - (c.doneAt || 0) < 12 * 3600000);
  const ownByTrip = new Map();
  const ownElsewhere = [];
  for (const c of ownOpen) {
    const t = trips.find((x) => x.store === c.store);
    if (t) { if (!ownByTrip.has(t)) ownByTrip.set(t, []); ownByTrip.get(t).push(c); } else ownElsewhere.push(c);
  }
  const idx = aisles(state.data);
  // закрытые дни (воскресенья не считаем — это привычно) — заранее, баннером над походами (F14)
  const holidays = [...Array(7).keys()].map((i) => dayDate(plan, i)).filter((d) => d.getDay() !== 0 && storesClosed(d));
  if (holidays.length) root.append(h('p', { class: 'notice' }, `${holidays.map((d) => fmtDate(d)).join(', ')} — праздник, магазины закрыты. Продукты на эти дни — в походе накануне.`));
  for (const t of trips) {
    const date = dayDate(plan, t.day);
    const rel = relDay(t.day);
    const own = ownByTrip.get(t) || [];
    const left = t.items.filter((i) => !checked[i.key]);
    const ownLeft = own.filter((c) => !c.done);
    const all = t.items.length + own.length;
    const leftN = left.length + ownLeft.length;
    // закреплённая шапка похода: сколько осталось и на какую сумму
    root.append(h('div', { class: 'group-head trip-head' },
      h('h2', null, rel ? `${rel}, ${fmtDate(date).split(', ')[1]}` : fmtDate(date), h('span', { class: 'trip-store' }, ` · ${t.store}`),
        t.day < 0 ? h('span', { class: 'muted' }, ' · до начала плана') : null),
      h('span', { class: 'muted' }, leftN ? `осталось ${leftN} из ${all} · ${eur(left.reduce((a, i) => a + (i.cost || 0), 0) + ownLeft.reduce((a, c) => a + ownCost(c), 0))}` : 'всё куплено')));
    root.append(h('div', { class: 'trip-tools' },
      h('button', { class: 'linkbtn small-link', onclick: () => routeEditor(t.store, redraw) }, `Маршрут по ${t.store}: порядок отделов`),
      h('button', { class: 'linkbtn small-link', onclick: () => pickFromCatalog({ title: `Добавить в поход в ${t.store}`, store: t.store, pickLabel: 'В список', onPick: (it) => { state.cart.push({ ...cartEntryLite(it) }); save(); redraw(); } }) }, '+ свой товар'),
      t.day === todayIndex(plan, now) ? h('button', { class: 'linkbtn small-link', onclick: () => receiptSheet(t, redraw) }, plan.receipts?.[receiptKey(t.store)] != null ? `Чек: ${eur(plan.receipts[receiptKey(t.store)])}` : 'Сумма чека') : null));
    if (t.early) root.append(h('p', { class: 'freeze-note', style: { margin: '2px 0 0' } }, 'Ближе ко дню готовки магазины закрыты — купите заранее; мясо и фарш заморозьте.'));
    // по отделам — в порядке обхода этого магазина; купленное уходит вниз, в «Куплено»
    const isDone = (e) => (e.kind === 'own' ? !!e.c.done && !((e.c.doneAt || 0) >= ui.enteredAt) : !!checked[e.ti.key] && !ui.justChecked.has(e.ti.key));
    const entries = [...t.items.map((ti) => ({ kind: 'plan', ti })), ...own.map((c) => ({ kind: 'own', c }))];
    const zoneOf = (e) => (e.kind === 'plan' ? zoneOfKey(e.ti.key, t.store) : (idx.shelf[state.places[t.store]?.[e.c.ref] || e.c.shelf]?.zone || 'oils'));
    const order = (ui.frozen[t.store] ||= routeOrder(state.data, state.routes, t.store));
    for (const g of byZones(entries.filter((e) => !isDone(e)), t.store, zoneOf, order)) {
      root.append(zoneHead(g.zone));
      root.append(h('ul', { class: 'shop-list' }, g.list.map((e) => (e.kind === 'own' ? cartRow(e.c, redraw, { compact: true }) : tripRow(e.ti)))));
    }
    const done = entries.filter(isDone);
    if (done.length) {
      const k = `${t.store}|${t.day}`;
      root.append(h('details', { class: 'bought', open: ui.openBought === k ? true : null, ontoggle: (e) => { ui.openBought = e.target.open ? k : null; } },
        h('summary', null, `Куплено (${done.length})`),
        h('ul', { class: 'shop-list' }, done.map((e) => (e.kind === 'own' ? cartRow(e.c, redraw, { compact: true }) : tripRow(e.ti))))));
    }
  }
  if (ownElsewhere.length) {
    root.append(h('div', { class: 'group-head trip-head' }, h('h2', null, 'Ваши товары — в других магазинах'), h('a', { class: 'small-link', href: '#/products' }, 'каталог')));
    root.append(h('p', { class: 'muted', style: { margin: '2px 0 0' } }, 'В эти магазины по плану походов нет — купите при случае или найдите похожее там, куда идёте.'));
    for (const [store, list] of Object.entries(ownElsewhere.reduce((m, c) => ((m[c.store] = m[c.store] || []).push(c), m), {}))) {
      root.append(h('div', { class: 'zone-head' }, h('span', { class: 'zone-ru' }, store)));
      root.append(h('ul', { class: 'shop-list' }, list.map((c) => cartRow(c, redraw, { compact: true }))));
    }
  }

  function tripRow(ti) {
    const t = trips.find((x) => x.items.includes(ti));
    {
      const base = byKey.get(ti.key);
      const it = ti.switchedFrom ? { ...base, offer: chooseOffer({ packs: (products[ti.key].packs || []).filter((p) => p.store === t.store && !p.stale) }, base.needGrams) } : base;
      const note = [
        ti.lateFor != null ? `Нужно уже ${dayIn(plan, cookDay[ti.key] ?? ti.lateFor)}, а раньше магазины закрыты — проверьте, нет ли дома, или поменяйте блюда местами в плане.` : null,
        ti.switchedFrom ? `Здесь, а не в ${ti.switchedFrom}: ${ti.extra > 0 ? '+' + eur(ti.extra) : 'та же цена'} — зато на один поход меньше.` : null,
      ].filter(Boolean).join(' ') || null;
      // купили раньше срока свежести — заморозить и достать накануне
      const frozen = ti.freezeUntil != null
        ? `Купите сейчас и сразу заморозьте; переложите в холодильник ${dayIn(plan, ti.freezeUntil - 1)}, вечером.`
        : null;
      return compactRow(it, products, !!checked[it.key], (v) => toggle(it.key, v, t.store), redraw,
        { note: checked[it.key] ? null : [note, frozen || (t.day < (need[it.key] ?? t.day) - 1 ? freezeNote(it) : null)].filter(Boolean).join(' ') || null, ctx, store: t.store });
    }
  }
}

// Необязательная сумма чека похода (F05): «Итоги» покажут, сколько потрачено на самом деле
// чек привязан к дате ввода и магазину, а не к номеру дня похода: походы пересчитываются и «переезжают»
const receiptKey = (store) => `${isoDate(new Date())}|${store}`;
function receiptSheet(t, redraw) {
  const k = receiptKey(t.store);
  const input = h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 0.01, value: state.plan.receipts?.[k] ?? '', placeholder: 'например, 42,80', 'aria-label': 'Сумма чека, €' });
  let close;
  const done = (v) => {
    state.plan.receipts = { ...(state.plan.receipts || {}) };
    if (v == null) delete state.plan.receipts[k]; else state.plan.receipts[k] = v;
    save(); close(); redraw();
  };
  close = sheet(`Чек: ${t.store}`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, `По плану этот поход — ${eur(t.total)}. Впишите сумму с чека, если хотите видеть в итогах реальные траты.`),
    h('label', { class: 'field' }, h('span', null, 'Сумма чека, €'), input),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { const v = parseFloat(String(input.value).replace(',', '.')); if (!(v >= 0 && v < 1000)) { input.focus(); return; } done(Math.round(v * 100) / 100); } }, 'Сохранить'),
      state.plan.receipts?.[k] != null ? h('button', { class: 'btn ghost', onclick: () => done(null) }, 'Удалить') : null)));
  setTimeout(() => input.focus(), 50);
}

const cartEntryLite = (it) => ({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ref: it.ref, name: it.name, brand: it.brand || '', store: it.store, shelf: it.shelf,
  price: it.price, size: it.size, unit: it.unit, per: it.per, image: it.image, url: it.url, byWeight: it.byWeight, concepts: it.concepts, qty: 1, at: Date.now() });

// Сколько стоят базовые продукты, ещё не отмеченные (нет дома и не куплены)
const basicsLeft = (list, checked) => list.basics.filter((b) => !checked['basic:' + b.key]).reduce((a, b) => a + (b.offer?.cost || 0), 0);

function renderBasics(root, list, checked, toggle) {
  if (list.basics.length) {
    const products = state.data.products;
    root.append(h('div', { class: 'group-head' }, h('h2', null, 'Базовые продукты'), h('span', { class: 'muted' }, 'один раз')));
    root.append(h('p', { class: 'muted', style: { marginTop: 0 } }, `Не входят в «к оплате»: обычно уже есть дома и служат несколько недель. Отметьте то, что есть или уже купили. Всё с нуля — ${eur(list.basicsTotal)}.`));
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
  const hasAlt = pack && pack.store !== 'любой' && (substitutesOf(product.key).length || (product.packs || []).some((p) => p.store === pack.store && p.name_de !== pack.name_de));
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

const firstNeededDay = (plan) => neededDay(plan, state.recipeMap);

// сколько разных блюд (одно блюдо, приготовленное дважды, — одно)
const dishes = (it) => new Set(it.uses.map((u) => u.title)).size;
const usesByDish = (it) => [...it.uses.reduce((m, u) => m.set(u.title, (m.get(u.title) || 0) + u.grams), new Map())];

// Строка похода в магазине (F10): вся строка — отметка (большая зона касания), RU и DE в одну строку, количество и цена;
// где лежит, фраза продавцу, «нет на полке», «взял другое», для каких блюд — в «⋯»
function compactRow(it, products, isChecked, onToggle, redraw, extra = {}) {
  const o = it.offer;
  const store = extra.store;
  const swap = extra.ctx?.swaps?.[it.key];
  const id = `sh-${it.key}`;
  return h('li', { class: 'shop-item compact' + (isChecked ? ' done' : '') },
    h('input', { type: 'checkbox', id, checked: isChecked, onchange: (e) => onToggle(e.target.checked) }),
    h('label', { for: id, class: 'compact-main' },
      h('span', { class: 'name' }, it.name_ru, o ? h('span', { class: 'qty' }, formatPack(o)) : null),
      h('span', { class: 'sub', lang: 'de' }, o ? o.pack.name_de : 'нет цены'),
      it.homeGrams > 0 ? h('span', { class: 'sub' }, `дома есть ${num(it.homeGrams)} г — докупить ${formatAmount(it.key, it.needGrams, products[it.key])}${o && chooseOffer(products[it.key], it.totalGrams)?.count === o.count ? ' (упаковок столько же — оставшееся пригодится)' : ''}`) : null,
      swap ? h('span', { class: 'swap-note' }, `Взято вместо: ${swap.name}${swapCost(swap, o) != null && o ? ` — ${eur(swapCost(swap, o))} вместо ${eur(o.cost)}` : ''}`) : null,
      extra.note ? h('span', { class: 'freeze-note' }, extra.note) : null),
    h('span', { class: 'price' }, o ? eur(swapCost(swap, o) ?? o.cost) : '—'),
    extra.ctx && store ? h('button', { class: 'btn icon ghost item-more', 'aria-label': `Где лежит, нет на полке, взял другое: ${it.name_ru}`,
      onclick: () => itemMenu({ key: it.key, store, name: it.name_ru, de: products[it.key]?.name_de_generic || it.name_de_generic, en: it.name_en, pack: o?.pack,
        uses: usesByDish(it), need: formatAmount(it.key, it.needGrams, products[it.key]), details: storageDetails(it.key),
        onChanged: redraw, onSwap: () => swapFlow(it.key, store, extra.ctx), onUnavailable: () => markUnavailable(it.key, store, extra.ctx, o?.pack), onHome: () => homeFlow(it, extra.ctx) }) }, icon('more')) : null);
}

function itemRow(it, products, isChecked, onToggle, byStore, redraw, extra = {}) {
  const o = it.offer;
  const store = extra.store || o?.pack?.store;
  const swap = extra.ctx?.swaps?.[it.key];
  const place = store ? whereIs(it.key, store) : null;
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
      h('span', { class: 'sub' }, [o ? (byStore ? o.pack.name_de : `${o.pack.store}: ${o.pack.name_de}`) : 'нет цены', it.name_en ? `EN: ${it.name_en}` : null, ...flags].filter(Boolean).join(' · ')),
      it.homeGrams > 0 ? h('span', { class: 'sub' }, `дома есть ${num(it.homeGrams)} г — докупить ${formatAmount(it.key, it.needGrams, products[it.key])}`) : null,
      swap ? h('span', { class: 'swap-note' }, `Взято вместо: ${swap.name}${swap.price ? ` (${eur(swap.price)})` : ''}`) : null,
      extra.inTrip && !isChecked && place ? whereLine(place, { short: true }) : null,
      extra.place ? h('span', null, storageChip(it.key, extra.place)) : null,
      extra.note ? h('span', { class: 'freeze-note' }, extra.note) : null),
    h('span', { class: 'price' }, o ? eur(swapCost(swap, o) ?? o.cost) : '—'),
    extra.ctx && store ? h('button', { class: 'btn icon ghost small item-more', 'aria-label': `Действия: ${it.name_ru}`, title: 'Где лежит, нет на полке, взял другое',
      onclick: () => itemMenu({ key: it.key, store, name: it.name_ru, de: products[it.key]?.name_de_generic || it.name_de_generic, en: it.name_en, pack: o?.pack,
        onChanged: redraw, onSwap: () => swapFlow(it.key, store, extra.ctx), onUnavailable: () => markUnavailable(it.key, store, extra.ctx), onHome: () => homeFlow(it, extra.ctx) }) }, icon('more')) : null,
    altLinks(products[it.key], { pack: o?.pack, needGrams: it.needGrams,
      before: h('button', { class: 'uses-toggle linkbtn', 'aria-expanded': String(open), onclick: () => { ui.openUses = open ? null : it.key; redraw(); } },
        `нужно ${formatAmount(it.key, it.needGrams, products[it.key])} · ${dishes(it)} ${plural(dishes(it), 'блюдо', 'блюда', 'блюд')}`) }),
    open ? h('ul', { class: 'uses muted' }, usesByDish(it).map(([title, g]) => h('li', null, `${title} — ${num(g)} г`))) : null);
}

function exportList(list, products, departments, checked, cart, ck) {
  // по умолчанию — ближайший поход: именно его обычно отправляют тому, кто идёт в магазин
  let which = ck.trips.length > 1 ? 'next' : 'all';
  const area = h('textarea', { class: 'export-text', id: 'export-shop', readonly: true, rows: 10, 'aria-label': 'Текст списка', onfocus: (e) => e.target.select() });
  const textOf = () => (ck.trips.length ? tripsToText(ck, state.plan, products, { which, checked }) : shoppingToText(list, products, departments, checked, cart, ck));
  let text = (area.value = textOf());
  const pick = h('div');
  const choose = (v) => { which = v; text = area.value = textOf(); drawPick(); };
  const drawPick = () => pick.replaceChildren(ck.trips.length > 1 ? seg([['next', 'Ближайший поход'], ['all', 'Все походы']], which, choose) : '');
  drawPick();
  let close;
  close = sheet('Поделиться списком', h('div', { class: 'stack' }, pick,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { if (await copyText(text)) close(); else selectForCopy('export-shop'); } }, 'Скопировать'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('pokupki.txt', text) }, 'Скачать .txt'),
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => { close(); setTimeout(() => window.print(), 50); } }, 'Печать')),
    area));
}
