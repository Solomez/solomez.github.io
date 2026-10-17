// «Добавить вручную»: товар, которого нет в каталоге (Hofer, Lidl, азиатский магазин или нет в онлайн-магазине).
// Название, магазин, цена, упаковка и, если под рукой этикетка, КБЖУ на 100 г. Сохраняется своим продуктом
// (state.custom.products — синхронизируется вместе с остальным) и дальше работает как товар каталога:
// «В список», «Есть дома», конструктор приёма пищи.
import { h, sheet, toast } from '../ui.js';
import { state, save, applyCustom } from '../state.js';
import { manualItem, productFromCatalog, MANUAL_STORES } from '../core/custom.js';

export function manualItemSheet({ title = 'Добавить вручную', name = '', store = null, submit = 'Добавить', onSave }) {
  let close;
  let picked = store && MANUAL_STORES.includes(store) ? store : store ? '' : null;
  const nameIn = h('input', { type: 'text', id: 'mi-name', value: name, placeholder: 'Например, Nongshim Shin Ramyun', autocomplete: 'off', 'aria-label': 'Название','aria-describedby': 'mi-name-err' });
  const nameErr = h('p', { class: 'field-err', id: 'mi-name-err', hidden: true }, 'Как называется товар?');
  const otherIn = h('input', { type: 'text', id: 'mi-store', value: store && !MANUAL_STORES.includes(store) ? store : '', placeholder: 'Другой: Asia Markt, Merkur, рынок…', 'aria-label': 'Другой магазин',
    oninput: () => { if (otherIn.value.trim()) { picked = ''; drawStores(); } } });
  const stores = h('div', { class: 'chips', role: 'group', 'aria-label': 'Магазин' });
  const drawStores = () => stores.replaceChildren(...MANUAL_STORES.map((s) => h('button', { type: 'button', class: 'chip' + (picked === s ? ' on' : ''), 'aria-pressed': String(picked === s),
    onclick: () => { picked = s; otherIn.value = ''; drawStores(); } }, s)));
  drawStores();
  const num = (id, label, attrs = {}) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 0.1, id, 'aria-label': label, ...attrs }));
  const unitSel = h('select', { id: 'mi-unit', 'aria-label': 'Единица упаковки', onchange: () => { pieceBox.hidden = unitSel.value !== 'pcs'; } },
    h('option', { value: 'g' }, 'г'), h('option', { value: 'ml' }, 'мл'), h('option', { value: 'pcs' }, 'шт.'));
  const pieceBox = num('mi-piece', 'Вес одной штуки, г — чтобы считать калории и цену за кг');
  pieceBox.hidden = true;
  // отдел — чтобы в походе товар встал на свою полку; необязательно
  const shelfSel = h('select', { id: 'mi-shelf', 'aria-label': 'Отдел магазина' }, h('option', { value: '' }, 'Не важно'),
    (state.data?.aisles?.zones || []).map((z) => h('optgroup', { label: z.ru }, (state.data.aisles.shelves || []).filter((s) => s.zone === z.id).map((s) => h('option', { value: s.id }, s.ru)))));
  const kbju = [['mi-k', 'Ккал (kcal)'], ['mi-p', 'Белки (Eiweiß), г'], ['mi-f', 'Жиры (Fett), г'], ['mi-c', 'Углеводы (Kohlenhydrate), г']];

  const content = h('div', { class: 'stack' },
    h('p', { class: 'muted', style: { margin: 0 } }, 'Товар, которого нет в каталоге: из Hofer, Lidl, азиатского магазина. Обязательно только название — остальное можно указать позже.'),
    h('label', { class: 'field' }, h('span', null, 'Название'), nameIn, nameErr),
    h('div', { class: 'field' }, h('span', { class: 'muted small' }, 'Магазин'), stores, otherIn),
    h('div', { class: 'filters' },
      num('mi-price', 'Цена, €', { step: 0.01, placeholder: '1,49' }),
      h('label', { class: 'field' }, h('span', null, 'Упаковка'), h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        h('input', { type: 'number', inputmode: 'decimal', min: 0, step: 1, id: 'mi-size', placeholder: '120', 'aria-label': 'Размер упаковки' }), unitSel))),
    pieceBox,
    h('label', { class: 'field' }, h('span', null, 'Где лежит в магазине (необязательно)'), shelfSel),
    h('div', { class: 'eyebrow' }, 'В 100 г — с этикетки (Nährwerte pro 100 g), необязательно'),
    h('div', { class: 'filters' }, kbju.map(([id, label]) => num(id, label))),
    h('button', { class: 'btn primary wide', onclick: () => {
      const v = (id) => +(String(document.getElementById(id)?.value || '').replace(',', '.') || 0);
      const nm = nameIn.value.trim();
      if (!nm) { nameErr.hidden = false; nameIn.setAttribute('aria-invalid', 'true'); nameIn.focus(); return; }
      const it = manualItem({ name: nm, store: otherIn.value.trim() || picked || '', price: v('mi-price'), size: v('mi-size'), unit: unitSel.value, pieceGrams: v('mi-piece'), shelf: shelfSel.value || null });
      const zone = state.data?.aisles?.shelves?.find((s) => s.id === it.shelf)?.zone || null;
      const p = productFromCatalog(it, { name: nm, nutrition: kbju.map(([id]) => v(id)), pieceGrams: it.pieceGrams, zone });
      state.custom = { ...state.custom, products: { ...(state.custom?.products || {}), [p.key]: p } };
      applyCustom();
      save();
      close();
      onSave?.({ ...it, pkey: p.key }, p);
      if (!onSave) toast(`Добавлено: ${nm}`);
    } }, submit));
  close = sheet(title, content);
  setTimeout(() => (name ? document.getElementById('mi-price') : nameIn)?.focus(), 50);
  return close;
}
