// Фото товаров и варианты по магазинам. Фото показываются прямо с сайтов магазинов (не копируются).
// На claude.ai внешние картинки на странице запрещены, но ссылки разрешены: там фото открывается
// во весь экран в новой вкладке по кнопке с камерой.
import { h, eur, num, sheet, icon, openLayer, closedLayer, isTopLayer, seg } from '../ui.js';
import { IS_ARTIFACT, state } from '../state.js';
import { formatPack, chooseOffer } from '../core/shopping.js';
import { ingredientMeasure, stepText } from '../core/cookbook.js';
import { lifeWords } from '../core/shelf.js';

export const SHOW_PHOTOS = !IS_ARTIFACT;

export function bestPack(product) {
  const packs = product?.packs || [];
  return packs.find((p) => !p.stale && !p.is_estimate) || packs[0] || null;
}

// Для миниатюры: самая выгодная упаковка, а если у неё нет фото — любая с фото (продукт тот же)
export function thumbPack(product) {
  const best = bestPack(product);
  return best?.image ? best : (product?.packs || []).find((p) => p.image) || best;
}

// Billa и Penny хранят фото на commercetools: там есть уменьшенные копии (-small 150 px, -large 700 px).
// Миниатюре хватает маленькой (в 40 раз легче оригинала), для просмотра — крупная.
const sized = (url, size) => (/commercetools\.com\/.+\.(jpe?g|png)$/i.test(url || '') ? url.replace(/\.(jpe?g|png)$/i, `-${size}.$1`) : url);
const fallbackTo = (url) => (e) => { if (e.target.dataset.fb) return; e.target.dataset.fb = '1'; e.target.src = url; };

const sortedPacks = (product) => [...(product?.packs || [])].filter((p) => p.store !== 'любой')
  .sort((a, b) => (a.stale - b.stale) || (a.eur_per_kg - b.eur_per_kg));

// Миниатюра без действия; если фото нет или не загрузилось — пустая плашка того же размера
export function thumb(pack, alt, cls = 'thumb') {
  if (!SHOW_PHOTOS || !pack?.image) return h('span', { class: cls + ' empty', 'aria-hidden': 'true' });
  return h('img', {
    class: cls, src: sized(pack.image, cls.includes('lg') ? 'medium' : 'small'), alt: alt || pack.name_de || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
    onload: (e) => e.target.classList.add('loaded'),
    // нет уменьшенной копии — берём оригинал; нет и его — пустая плашка
    onerror: (e) => {
      if (!e.target.dataset.fb && e.target.src !== pack.image) { e.target.dataset.fb = '1'; e.target.src = pack.image; return; }
      e.target.replaceWith(h('span', { class: cls + ' empty', 'aria-hidden': 'true' }));
    },
  });
}

// Фото, которое открывается на весь экран: здесь — просмотрщик с листанием вариантов,
// на claude.ai — сама картинка магазина в новой вкладке
export function photo(product, pack, { cls = 'thumb', label } = {}) {
  if (!pack?.image) return h('span', { class: cls + ' empty', 'aria-hidden': 'true' });
  const name = label || product?.name_ru || pack.name_de;
  if (!SHOW_PHOTOS) {
    return h('a', { class: 'thumb-btn photo-link ' + cls, href: pack.image, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Фото: ${name} (откроется в новой вкладке)`, title: 'Открыть фото' }, icon('camera'));
  }
  return h('button', { class: 'thumb-btn', 'aria-label': `Фото на весь экран: ${name}`, onclick: () => openLightbox(product, pack) }, thumb(pack, name, cls));
}

const unitText = (p) => (p.loose ? 'за 1 кг (развес)' : `${num(p.pack_size)} ${p.pack_unit === 'pcs' ? 'шт.' : p.pack_unit === 'ml' ? 'мл' : 'г'}`);

// Просмотр на весь экран: фото крупно, подпись с магазином и ценой, листание между упаковками продукта
export function openLightbox(product, startPack) {
  const list = sortedPacks(product).filter((p) => p.image);
  if (!list.length) return;
  let i = Math.max(0, list.indexOf(startPack));
  const img = h('img', { class: 'lb-img', alt: '', referrerpolicy: 'no-referrer' });
  const cap = h('div', { class: 'lb-cap' });
  const count = h('span', { class: 'lb-count' });
  const prev = h('button', { class: 'lb-nav lb-prev', 'aria-label': 'Предыдущий вариант', onclick: (e) => { e.stopPropagation(); go(-1); } }, icon('back'));
  const next = h('button', { class: 'lb-nav lb-next', 'aria-label': 'Следующий вариант', onclick: (e) => { e.stopPropagation(); go(1); } }, icon('back'));
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); closedLayer(close); };
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Фото: ${product.name_ru}`, onclick: (e) => { if (e.target === box || e.target === stage) close(); } },
    h('div', { class: 'lb-top' }, count, h('button', { class: 'lb-close', 'aria-label': 'Закрыть', onclick: close }, icon('close'))));
  const stage = h('div', { class: 'lb-stage' }, img);
  box.append(...[stage, list.length > 1 ? prev : null, list.length > 1 ? next : null, cap].filter(Boolean));
  function draw() {
    const p = list[i];
    img.onerror = fallbackTo(p.image);
    delete img.dataset.fb;
    img.src = sized(p.image, 'large');
    img.alt = `${product.name_ru}: ${p.name_de}`;
    count.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    cap.replaceChildren(
      h('div', { class: 'lb-title' }, h('b', null, p.store), ' · ', p.name_de),
      h('div', { class: 'lb-sub' }, `${unitText(p)} · ${eur(p.price_eur)} · ${eur(p.eur_per_kg)}/кг`,
        p.url && /^https?:/.test(p.url) ? [' · ', h('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'в магазине')] : null));
  }
  const go = (d) => { i = (i + d + list.length) % list.length; draw(); };
  // Escape закрывает общий стек окон; стрелки листают, только пока просмотр — верхнее окно
  const onKey = (e) => {
    if (!isTopLayer(close)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.stopImmediatePropagation(); go(e.key === 'ArrowRight' ? 1 : -1); }
  };
  let x0 = null;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); x0 = null; });
  document.addEventListener('keydown', onKey, true);
  draw();
  document.body.append(box);
  openLayer(close);
}

// ---------- Хранение ----------
export const PLACES = {
  freezer: { name: 'Морозилка', short: 'морозилка', mark: '❄' },
  fridge: { name: 'Холодильник', short: 'холодильник', mark: '●' },
  cool: { name: 'Прохладное тёмное место', short: 'прохладное место', mark: '◐' },
  pantry: { name: 'Шкаф', short: 'шкаф', mark: '▢' },
  counter: { name: 'На столе', short: 'на столе', mark: '○' },
};
export const storageOf = (key) => state.data?.storage?.[key] || null;

export function storageChip(key, place) {
  const s = storageOf(key);
  const p = PLACES[place || s?.place];
  if (!p) return null;
  return h('span', { class: `place-chip place-${place || s.place}` }, p.short, !place && s?.shelf && s.place === 'fridge' && /нижняя/.test(s.shelf) ? ', нижняя полка' : '');
}

export function storageDetails(key) {
  const s = storageOf(key);
  if (!s || s.keep === '—') return null;
  const row = (label, text) => (text ? h('div', { class: 'st-row' }, h('span', { class: 'muted' }, label), h('span', null, text)) : null);
  // сроки — числами из данных (USDA FoodKeeper, AGES…; без источника — «оценка»), а не прежним текстом «обычно 2–4 дня»
  const lw = lifeWords(key, state.data.storage);
  return h('section', { class: 'storage-box' },
    h('div', { class: 'eyebrow' }, 'Как хранить'),
    h('div', { class: 'st-place' }, storageChip(key, s.place), s.shelf ? h('span', { class: 'muted' }, ` · ${s.shelf}`) : null),
    row('Срок', lw ? `${lw.closed} в закрытой упаковке${/zu verbrauchen/.test(s.keep || '') ? ' — и не позже даты «zu verbrauchen bis»' : ''}` : s.keep),
    row('После вскрытия', lw ? lw.opened : s.opened),
    row('Заморозка', s.freeze),
    lw ? row('Откуда сроки', lw.source) : null,
    s.tip ? h('p', { class: 'st-tip' }, s.tip) : null);
}

// Все упаковки продукта в разных магазинах: фото, название как на ценнике, цена, €/кг.
// swap — из рецепта: { current, onPick(subKey | null) } — у замен кнопка «Заменить в блюде», у выбранной — «Вернуть»
export function showVariants(product, { needGrams, swap } = {}) {
  if (!product) return;
  let close;
  const packs = sortedPacks(product);
  const best = needGrams ? chooseOffer(product, needGrams)?.pack : bestPack(product);
  const shops = h('ul', { class: 'variants' }, packs.map((p) => {
      const offer = needGrams ? chooseOffer({ packs: [p] }, needGrams) : null;
      return h('li', { class: 'variant' + (p === best ? ' best' : '') },
        photo(product, p, { cls: 'thumb lg' }),
        h('div', { class: 'variant-main' },
          h('span', { class: 'variant-store' }, p.store, p === best ? h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, 'выгоднее всего') : null,
            p.stale ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, 'цена устарела') : null),
          h('span', { class: 'variant-name' }, p.name_de),
          h('span', { class: 'muted' }, `${unitText(p)} · ${eur(p.price_eur)} · ${eur(p.eur_per_kg)}/кг`),
          offer ? h('span', { class: 'muted' }, `на неделю: ${formatPack(offer)} — ${eur(offer.cost)}`) : null,
          p.url && /^https?:/.test(p.url) ? h('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'variant-link' }, 'Открыть в магазине ↗') : null));
    }));
  const shopPart = [shops,
    !SHOW_PHOTOS ? h('p', { class: 'muted' }, 'Нажмите на значок камеры — фото товара откроется на весь экран в новой вкладке.') : null,
    h('p', { class: 'muted small-print' }, 'Фото — с сайтов магазинов; упаковка в конкретном магазине может отличаться.')];
  const head = h('p', { class: 'muted', style: { marginTop: 0 } }, product.name_de_generic || product.name_de || '', needGrams ? ` · на неделю нужно ${num(needGrams)} г` : '');
  const swapPart = swap ? swapSection(product, swap, () => close?.()) : null;
  let content;
  if (swapPart) {
    // из блюда: шторка открывается на заменах, «Заменить» видна сразу; магазины и хранение — вкладками (S58)
    const body = h('div');
    const tabs = [['subs', 'Замены', () => [swapPart]], ['shops', `Магазины (${packs.length})`, () => shopPart], ['store', 'Хранение', () => [storageDetails(product.key) || h('p', { class: 'muted' }, 'Особых правил хранения нет.')]]];
    const show = (id) => { body.replaceChildren(seg(tabs.map(([v, l]) => [v, l]), id, show), ...tabs.find(([v]) => v === id)[2]()); };
    show('subs');
    content = h('div', null, head, body);
  } else {
    content = h('div', null, head, storageDetails(product.key), ...shopPart, substituteList(product, best?.store, needGrams, 3));
  }
  close = sheet(product.name_ru || 'Варианты', content);
}

// Замены в блюде-шаблоне: только совместимые; до подтверждения — что изменится (время, количество, способ,
// белок и калории, цена, предупреждения), после — пересобранный рецепт с подсветкой изменённых шагов
function swapSectionTemplate(product, { current, onPick, options, preview, origName, scale = 1, portions = null }, close) {
  const ok = options.filter((o) => o.allowed && !(state.prefs?.excludedKeys || []).includes(o.key));
  const no = options.filter((o) => !o.allowed);
  const signed = (x, unit, digits = 0) => (Math.abs(x) < (digits ? 0.05 : 0.5) ? 'так же' : `${x > 0 ? '+' : '−'}${num(Math.abs(x), digits)}${unit}`);
  const row = (o) => {
    const sp = productOf(o.key);
    const on = o.key === current;
    const box = h('div', { class: 'swap-preview', hidden: true });
    const show = () => {
      if (!box.hidden) { box.hidden = true; return; }
      const pv = preview(o.key);
      const kit = state.data.kitchen;
      const r0 = pv.base;
      const r1 = pv.recipe;
      // количества — на выбранные порции, как на странице рецепта (S58)
      const qty = (r, ing) => (ing ? ingredientMeasure(r, ing, scale, kit).measure : '—');
      const changed = r1.steps.map((st, k) => [k, st]).filter(([, st]) => st.changed);
      const liq0 = r0.ingredients.find((x) => x.derived?.from === (pv.from.id || pv.from.key) && x.derived.by !== 'salt');
      const liq1 = r1.ingredients.find((x) => x.derived?.from === (pv.to.id || pv.to.key) && x.derived.by !== 'salt');
      box.replaceChildren(
        h('ul', { class: 'clean swap-diff' },
          h('li', null, h('b', null, 'Время: '), `${signed(pv.time, ' мин')} — всего ≈ ${r1.time.total} мин, руками ${r1.time.active} мин`),
          h('li', null, h('b', null, `Количество${portions ? ` на ${portions} порц.` : ''}: `), `${pv.from.name_ru} — ${qty(r0, pv.from)} → ${pv.to.name_ru} — ${qty(r1, pv.to)}`),
          liq0 || liq1 ? h('li', null, h('b', null, 'Жидкость: '), `${qty(r0, liq0)} → ${qty(r1, liq1)}`) : null,
          pv.method ? h('li', null, h('b', null, 'Способ: '), `${methodLabel(pv.method.from)} → ${methodLabel(pv.method.to)}`) : null,
          h('li', null, h('b', null, 'На порцию: '), `белок ${signed(pv.protein, ' г', 1)}, калории ${signed(pv.kcal, ' ккал')}, цена ${Math.abs(pv.cost) < 0.005 ? 'так же' : (pv.cost > 0 ? '+' : '−') + eur(Math.abs(pv.cost))}`),
          changed.length ? h('li', null, h('details', { class: 'plain' }, h('summary', null, `Шаги: изменится ${changed.length} — показать`),
            h('ol', { class: 'clean swap-steps' }, changed.map(([k, st]) => h('li', null, h('b', null, `Шаг ${k + 1}: `), stepText(r1, st, scale, kit)))))) : h('li', null, h('b', null, 'Шаги: '), 'те же'),
          pv.note && pv.note !== o.note ? h('li', null, h('b', null, 'Вкус и текстура: '), pv.note) : null,
          ...pv.warnings.map((w) => h('li', { class: 'need-line' }, `⚠ ${w}`))),
      );
      box.hidden = false;
    };
    return h('li', { class: 'variant' + (on ? ' best' : '') },
      photo(sp, bestPack(sp), { cls: 'thumb lg', label: sp.name_ru }),
      h('div', { class: 'variant-main' },
        h('span', { class: 'variant-store' }, sp.name_ru),
        o.note ? h('span', { class: 'alt-note' }, o.note) : null,
        on ? h('span', { class: 'badge accent', style: { justifySelf: 'start', marginTop: '6px' } }, 'Сейчас в блюде')
          : h('div', { class: 'row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } },
            h('button', { class: 'btn small primary', onclick: () => { close(); onPick(o.key); } }, 'Заменить'),
            h('button', { class: 'btn small', 'aria-expanded': 'false', onclick: (e) => { show(); e.currentTarget.setAttribute('aria-expanded', String(!box.hidden)); } }, 'Что изменится?')),
        box));
  };
  return h('section', { class: 'alt-section' },
    h('div', { class: 'eyebrow' }, 'Чем заменить в этом блюде'),
    current ? h('p', { style: { margin: '4px 0 8px' } }, h('button', { class: 'btn small', onclick: () => { close(); onPick(null); } }, `Вернуть как в рецепте: ${origName || product.name_ru}`)) : null,
    ok.length ? h('ul', { class: 'variants' }, ok.map(row)) : h('p', { class: 'muted' }, 'Подходящих замен для этого блюда нет.'),
    no.length ? h('details', { class: 'plain' }, h('summary', null, `Не подходят к этому блюду (${no.length})`),
      h('ul', { class: 'clean' }, no.map((o) => h('li', { class: 'muted' }, `${o.name_ru} — ${o.reason}`)))) : null,
    h('p', { class: 'muted small-print' }, 'Замена — только в этом блюде: пересчитаются количество, шаги, жидкость, огонь, время, таймеры, признаки готовности, КБЖУ, цена и список покупок.'));
}
const METHOD = { absorb: 'варить под крышкой', steep: 'запарить кипятком', boil_drain: 'отварить и слить воду', in_dish: 'в той же посуде', boil: 'отварить' };
const methodLabel = (m) => METHOD[m] || String(m || '').replace(/_/g, ' ');

// Замены в блюде: выбранная — сверху с «Вернуть как в рецепте», остальные — «Заменить в блюде»
function swapSection(product, swap, close) {
  if (swap.options) return swapSectionTemplate(product, swap, close);
  const { current, onPick } = swap;
  const subs = substitutesOf(product.key);
  if (!subs.length) return null;
  return h('section', { class: 'alt-section' },
    h('div', { class: 'eyebrow' }, 'Чем заменить в этом блюде'),
    current ? h('p', { style: { margin: '4px 0 8px' } }, h('button', { class: 'btn small', onclick: () => { close(); onPick(null); } }, `Вернуть: ${product.name_ru}`)) : null,
    h('ul', { class: 'variants' }, subs.map(([k, note, ratio = 1]) => {
      const sp = productOf(k);
      const on = k === current;
      return altRow(sp, bestPack(sp), { note: [note, ratio !== 1 ? `в блюде — ×${String(ratio).replace('.', ',')} по весу` : null].filter(Boolean).join(' · '), best: on, otherStore: true,
        pickLabel: on ? 'Сейчас в блюде' : 'Заменить в блюде', onPick: on ? null : () => { close(); onPick(k); } });
    })),
    h('p', { class: 'muted small-print' }, 'Замена — только в этом блюде: пересчитаются количество, КБЖУ, цена и список покупок.'));
}

// ---------- Если нет в наличии ----------
const productOf = (key) => state.data?.products?.[key] || null;
// без продуктов, которые человек исключил в профиле
export const substitutesOf = (key) => (state.data?.substitutes?.[key] || [])
  .filter(([k]) => productOf(k)?.packs?.length && !(state.prefs?.excludedKeys || []).includes(k));

// Лучшая упаковка продукта в магазине (с учётом нужного количества); null — там его нет
function packIn(product, store, needGrams) {
  const packs = sortedPacks(product).filter((p) => p.store === store);
  if (!packs.length) return null;
  return needGrams ? chooseOffer({ ...product, packs }, needGrams)?.pack : packs[0];
}

function altRow(product, p, { note, needGrams, best, otherStore, onPick, pickLabel = 'Взял это' } = {}) {
  const offer = needGrams ? chooseOffer({ packs: [p] }, needGrams) : null;
  return h('li', { class: 'variant' + (best ? ' best' : '') },
    photo(product, p, { cls: 'thumb lg', label: product.name_ru }),
    h('div', { class: 'variant-main' },
      h('span', { class: 'variant-store' }, product.name_ru, otherStore ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, p.store) : null),
      note ? h('span', { class: 'alt-note' }, note) : null,
      h('span', { class: 'variant-name' }, p.name_de),
      h('span', { class: 'muted' }, `${unitText(p)} · ${eur(p.price_eur)} · ${eur(p.eur_per_kg)}/кг`),
      offer ? h('span', { class: 'muted' }, `на неделю: ${formatPack(offer)} — ${eur(offer.cost)}`) : null,
      onPick ? h('button', { class: 'btn small primary', style: { justifySelf: 'start', marginTop: '6px' },
        onclick: () => onPick({ ref: product.key, name: `${product.name_ru} — ${p.name_de}`, price: p.price_eur, image: p.image, store: p.store }) }, pickLabel) : pickLabel !== 'Взял это' ? h('span', { class: 'badge accent', style: { justifySelf: 'start', marginTop: '6px' } }, pickLabel) : null));
}

// Замены другим продуктом: сначала те, что есть в этом же магазине, затем — где их найти
function substituteList(product, store, needGrams, limit = 99, onPick) {
  const subs = substitutesOf(product.key).slice(0, limit);
  if (!subs.length) return null;
  return h('section', { class: 'alt-section' },
    h('div', { class: 'eyebrow' }, 'Если нет в наличии — чем заменить'),
    h('ul', { class: 'variants' }, subs.map(([k, note, ratio = 1]) => {
      const sp = productOf(k);
      const g = needGrams ? Math.max(1, Math.round(needGrams * ratio)) : undefined;
      const here = store ? packIn(sp, store, g) : null;
      const p = here || packIn(sp, sortedPacks(sp)[0]?.store, g) || bestPack(sp);
      return altRow(sp, p, { note, needGrams: g, otherStore: !here, onPick: onPick ? (c) => { closeAlt?.(); onPick(c); } : null });
    })));
}

// «Нет на полке»: другие упаковки того же продукта в этом магазине, затем замены с пояснением
let closeAlt = null;
export function showAlternatives(product, { store, needGrams, chosen, onPick, extra } = {}) {
  if (!product) return;
  store ||= (needGrams ? chooseOffer(product, needGrams)?.pack : bestPack(product))?.store;
  const same = sortedPacks(product).filter((p) => p.store === store && p !== chosen && p.name_de !== chosen?.name_de);
  const subs = substituteList(product, store, needGrams, 99, onPick);
  let close;
  const content = h('div', null,
    h('p', { class: 'muted', style: { marginTop: 0 } }, store ? `Нет на полке в ${store}? Вот что взять вместо — лучшие варианты сверху.` : 'Что взять вместо — лучшие варианты сверху.'),
    same.length ? h('section', { class: 'alt-section' },
      h('div', { class: 'eyebrow' }, `Тот же продукт в ${store}, другая упаковка`),
      h('ul', { class: 'variants' }, same.map((p) => altRow(product, p, { needGrams, onPick: onPick ? (c) => { closeAlt?.(); onPick(c); } : null })))) : null,
    subs,
    !same.length && !subs ? h('p', null, 'Замены нет: этот продукт лучше купить в другом магазине.') : null,
    extra ? h('div', { style: { marginTop: '12px' } }, extra) : null,
    (product.packs || []).some((p) => p.store !== store && p.store !== 'любой')
      ? h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => { close?.(); showVariants(product, { needGrams }); } }, 'Этот же продукт в других магазинах') : null,
    h('p', { class: 'muted small-print' }, 'Количество замены — как в рецепте, по весу. Пояснения — чем замена отличается при готовке.'));
  close = sheet(`Если нет: ${product.name_ru}`, content);
  closeAlt = close;
  return close;
}
