// Мелкие помощники интерфейса: создание элементов, форматирование, всплывающие окна.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // только для своих статичных SVG
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// Неразрывный пробел между числом и единицей: «~4 минуты», «180 °C», «2 ст. л.» не разрываются на две строки
export const nb = (t) => String(t ?? '').replace(/(\d)\s+(?=(мин|минут|сек|секунд|ч\b|час|°|г\b|кг|мл|л\b|ст\.|ч\.|шт|см|мм|раз|порц))/g, '$1\u00a0');

export const eur = (x) => '€' + (Math.round((x || 0) * 100) / 100).toFixed(2).replace('.', ',');
export const num = (x, d = 0) => Number(x || 0).toLocaleString('ru-RU', { maximumFractionDigits: d });
export const factorText = (f) => '×' + String(f).replace('.', ',');

const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11 12 4l8 7v8.5a1 1 0 0 1-1 1h-4.5V15h-5v5.5H5a1 1 0 0 1-1-1z"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 3v3M16 3v3"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h10.5A3.5 3.5 0 0 1 19 8v11.5H8.5A3.5 3.5 0 0 1 5 16z"/><path d="M5 16a3.5 3.5 0 0 1 3.5-3.5H19"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2.2l2.1 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L20.5 8H6.1"/><circle cx="10" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20h16M7 16V10M12 16V5M17 16v-4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.3-3.6 4.2-5.4 7.5-5.4s6.2 1.8 7.5 5.4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4.5 9 6-.3.8-1.3 2.3-2.9 3.7M6.3 7.8C4.6 9.1 3.4 10.8 3 12c.5 1.5 4 6 9 6 1.3 0 2.5-.3 3.6-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12c.5-1.5 4-6 9-6s8.5 4.5 9 6c-.5 1.5-4 6-9 6s-8.5-4.5-9-6z"/><circle cx="12" cy="12" r="3"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM2 10h2M20 10h2M9 6c0-1 1-1.5 1-2.5M13 6c0-1 1-1.5 1-2.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
export const icon = (name) => h('span', { 'aria-hidden': 'true', style: { display: 'inline-flex' }, html: ICONS[name] || '' });

// Всплывающее сообщение; с action — кнопка (например, «Отменить»), висит дольше
export function toast(msg, action) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = h('div', { class: 'toast', role: 'status' }, h('span', null, msg),
    action ? h('button', { class: 'toast-action', onclick: () => { t.remove(); action.onClick(); } }, action.label) : null);
  document.body.append(t);
  setTimeout(() => t.remove(), action ? 10000 : 2600); // с «Отменить» — дольше: успеть прочитать и нажать
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// «2026-10-16» → «16 октября 2026»
export function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : iso || '';
}

// Полоска прогресса к цели: value/goal, отметка цели, перебор подсвечивается
export function meter(value, goal, cls = '') {
  const max = Math.max(goal * 1.25, value, 1);
  // бюджет: любой перерасход — красным; белок выше нормы — не ошибка (для набора это нормально); калории — с запасом 15 %
  const over = cls === 'budget' ? value > goal + 0.005 : cls === 'protein' ? false : value > goal * 1.15;
  const bar = h('div', { class: 'meter ' + cls + (over ? ' over' : ''), role: 'img', 'aria-label': `${Math.round(value)} из ${Math.round(goal)}${over ? ', больше нормы' : ''}` },
    h('i', { style: { width: `${Math.min(100, (value / max) * 100)}%` } }),
    h('span', { class: 'goal', style: { left: `${(goal / max) * 100}%` } }));
  // перерасход бюджета — не только цветом: подпись рядом со шкалой (research/ui, A10)
  return over && cls === 'budget' ? h('div', { class: 'meter-wrap' }, bar, h('span', { class: 'meter-flag' }, 'перерасход')) : bar;
}

// Окна поверх страницы (листы снизу, просмотр фото): Escape и смена раздела закрывают верхнее,
// пока окно открыто — страница под ним не прокручивается
const layers = [];
export const hasLayer = () => layers.length > 0;
export const isTopLayer = (close) => layers[layers.length - 1] === close;
export function openLayer(close) {
  layers.push(close);
  document.body.style.overflow = 'hidden';
}
export function closedLayer(close) {
  const i = layers.indexOf(close);
  if (i >= 0) layers.splice(i, 1);
  if (!layers.length) document.body.style.overflow = '';
}
export function closeAllLayers() {
  while (layers.length) layers[layers.length - 1]();
  document.body.style.overflow = '';
}
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    layers[layers.length - 1]();
  }, true);
}

export function sheet(title, content) {
  const opener = document.activeElement;
  document.querySelectorAll('.toast').forEach((x) => x.remove()); // сообщение снизу перекрывало кнопки шторки (UX-ревью)
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    closedLayer(close);
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
  };
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'sheet-head' }, h('h2', null, title),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Закрыть', onclick: close }, icon('close'))),
    content);
  const back = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === back && close() }, box);
  document.body.append(back);
  openLayer(close);
  box.focus({ preventScroll: true });
  return close;
}

// 1 рецепт, 2 рецепта, 5 рецептов
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

export function download(filename, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// Буфер обмена недоступен: выделяем текст в поле, чтобы скопировать его вручную
export function selectForCopy(id) {
  const ta = document.getElementById(id);
  if (!ta) return;
  ta.focus();
  ta.select();
  toast('Текст выделен — скопируйте его (долгое нажатие → «Скопировать»)');
}

// true — скопировано; false — буфер обмена недоступен (тогда текст нужно выделить и скопировать вручную)
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано в буфер обмена');
    return true;
  } catch {
    return false;
  }
}

export function seg(options, value, onChange) {
  return h('div', { class: 'seg', role: 'group' },
    options.map(([v, label]) => h('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label)));
}
