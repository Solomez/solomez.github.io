// Отделы в магазине: где лежит продукт, маршрут по залу, действия «нет на полке / взял другое / лежит не там».
import { h, sheet, toast, icon, eur } from '../ui.js';
import { state, save } from '../state.js';
import { aisles, placeOf } from '../core/catalog.js';
import { routeOrder, setOrder, resetRoute, isCustom, isLearned } from '../core/route.js';

// Где искать продукт из рецептов (по ключу) в магазине store — с учётом пометок пользователя
export function whereIs(key, store) {
  const p = state.data.products[key];
  return placeOf(state.data, { shelf: p?.shelf, store, ref: key }, state.places);
}
export const zoneOfKey = (key, store) => whereIs(key, store)?.zone?.id || state.data.products[key]?.zone || 'oils';

// Строка «Молочное › Йогурт и скир · Joghurt & Skyr»
export function whereLine(place, { short = false } = {}) {
  if (!place) return null;
  const { shelf, own } = place;
  return h('span', { class: 'where' + (own ? ' own' : '') }, icon('pin'), short ? shelf.ru : `${shelf.ru} · ${shelf.de}`, own ? ' (ваша пометка)' : '');
}

// Сгруппировать позиции по зонам в порядке маршрута магазина
export function byZones(entries, store, zoneOf) {
  const order = routeOrder(state.data, state.routes, store);
  const groups = new Map(order.map((z) => [z, []]));
  for (const e of entries) {
    const z = zoneOf(e);
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(e);
  }
  const idx = aisles(state.data);
  return [...groups].filter(([, list]) => list.length).map(([z, list]) => ({ zone: idx.zone[z] || { id: z, ru: z, de: '' }, list }));
}

export function zoneHead(zone) {
  return h('div', { class: 'zone-head' }, h('span', { class: 'zone-ru' }, zone.ru), h('span', { class: 'zone-de' }, zone.de));
}

// Порядок отделов в магазине: вручную стрелками, сброс к выученному/обычному
export function routeEditor(store, onDone) {
  const idx = aisles(state.data);
  let order = routeOrder(state.data, state.routes, store);
  const listEl = h('ol', { class: 'route-list' });
  const draw = () => listEl.replaceChildren(...order.map((z, i) => h('li', null,
    h('span', { class: 'route-name' }, idx.zone[z]?.ru || z, h('span', { class: 'muted' }, ` · ${idx.zone[z]?.de || ''}`)),
    h('span', { class: 'route-btns' },
      h('button', { class: 'btn icon ghost small', 'aria-label': 'Выше', disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); } }, '↑'),
      h('button', { class: 'btn icon ghost small', 'aria-label': 'Ниже', disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }, '↓')))));
  draw();
  let close;
  const status = isCustom(state.routes, store) ? 'Сейчас — ваш порядок.' : isLearned(state.routes, store) ? 'Сейчас — порядок, выученный по вашим походам.' : 'Сейчас — обычный порядок для австрийского супермаркета.';
  close = sheet(`Маршрут по ${store}`, h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, `Расставьте отделы в том порядке, в каком вы их проходите. ${status} Если ничего не менять, приложение само подстраивает порядок под то, как вы отмечаете купленное.`),
    listEl,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { setOrder(state.routes, store, order); save(); close(); onDone(); } }, 'Сохранить'),
      h('button', { class: 'btn', onclick: () => { resetRoute(state.routes, store); save(); close(); onDone(); toast('Порядок сброшен'); } }, 'Сбросить'))));
}

// Выбрать отдел, где продукт на самом деле лежит в этом магазине
export function pickShelf(store, ref, name, onDone) {
  const idx = aisles(state.data);
  const zones = state.data.aisles.zones || [];
  let close;
  const choose = (shelfId) => {
    state.places[store] = { ...(state.places[store] || {}), [ref]: shelfId };
    if (!shelfId) delete state.places[store][ref];
    save();
    close();
    onDone();
    toast(shelfId ? `Запомнил: в ${store} — ${idx.shelf[shelfId].ru.toLowerCase()}` : 'Вернул обычный отдел');
  };
  close = sheet(`Где лежит «${name}» в ${store}?`, h('div', { class: 'stack' },
    state.places[store]?.[ref] ? h('button', { class: 'btn', onclick: () => choose(null) }, 'Вернуть обычный отдел') : null,
    zones.map((z) => h('details', { class: 'plain' },
      h('summary', null, z.ru, h('span', { class: 'muted' }, ` · ${z.de}`)),
      h('div', { class: 'chips', style: { margin: '8px 0' } },
        (state.data.aisles.shelves || []).filter((s) => s.zone === z.id).map((s) => h('button', { class: 'chip', onclick: () => choose(s.id) }, s.ru)))))));
}

// Фраза для продавца: по-немецки и по-английски
export function askPhrase(de, en) {
  de = (de || '').split(/\s*\/\s*/)[0];
  en = (en || '').split(/\s*\/\s*/)[0];
  return h('div', { class: 'ask' },
    h('div', null, h('span', { class: 'muted' }, 'Спросить: '), h('b', { lang: 'de' }, `Entschuldigung, wo finde ich ${de}?`)),
    en ? h('div', { class: 'muted', lang: 'en' }, `Excuse me, where can I find ${en.toLowerCase()}?`) : null);
}

// Меню товара в списке покупок
export function itemMenu({ key, store, name, de, en, pack, onChanged, onSwap, onUnavailable, onHome }) {
  const place = whereIs(key, store);
  let close;
  const act = (label, sub, fn) => h('button', { class: 'menu-item', onclick: () => { close(); fn(); } }, h('b', null, label), sub ? h('span', { class: 'muted' }, sub) : null);
  close = sheet(name, h('div', { class: 'stack' },
    h('div', { class: 'names' },
      h('div', null, h('span', { class: 'muted' }, 'DE '), h('b', { lang: 'de' }, de || '—')),
      en ? h('div', null, h('span', { class: 'muted' }, 'EN '), h('span', { lang: 'en' }, en)) : null),
    place ? h('div', { class: 'where-box' },
      h('div', { class: 'eyebrow' }, `Где искать в ${store}`),
      h('div', null, h('b', null, place.zone?.ru), ' › ', place.shelf.ru),
      h('div', { class: 'muted', lang: 'de' }, `${place.zone?.de} › ${place.shelf.de}`),
      place.zone?.hint ? h('div', { class: 'muted' }, place.zone.hint) : null) : null,
    askPhrase(de, en),
    pack ? h('div', { class: 'muted' }, `В списке: ${pack.store} — ${pack.name_de}, ${eur(pack.price_eur)}`) : null,
    h('div', { class: 'menu' },
      act('Нет на полке', 'предложу другую упаковку, замену или другой магазин', onUnavailable),
      act('Взял другое вместо', 'отмечу, что куплено, и что именно', onSwap),
      act('Лежит в другом отделе', 'запомню для этого магазина', () => pickShelf(store, key, name, onChanged)),
      act('Уже есть дома', 'не покупать или купить меньше', onHome))));
}
