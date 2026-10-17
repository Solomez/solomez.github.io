import { h, icon, closeAllLayers, toast } from './ui.js';
import { state, loadData, connectCloud } from './state.js';
import { renderPlan } from './views/plan.js';
import { renderLibrary } from './views/library.js';
import { renderRecipe, rememberRoute } from './views/recipe.js';
import { renderShop } from './views/shop.js';
import { renderCook, leaveCook } from './views/cook.js';
import { renderStats } from './views/stats.js';
import { renderProfile, refreshSyncText } from './views/profile.js';
import { renderProducts } from './views/catalog.js';
import { renderBuilder } from './views/builder.js';
import { takeSessionFromUrl, startAccount, ACCOUNTS_ENABLED } from './account.js';

const TABS = [
  ['plan', 'План', 'plan'],
  ['recipes', 'Рецепты', 'book'],
  ['shop', 'Покупки', 'cart'],
  ['products', 'Продукты', 'box'],
  ['profile', 'Профиль', 'user'],
];
const TITLES = { plan: 'План', recipes: 'Рецепты', recipe: 'Рецепт', builder: 'Свой вариант', shop: 'Покупки', products: 'Продукты', stats: 'Итоги', profile: 'Профиль', cook: 'Готовка' };

const main = document.getElementById('main');
const nav = document.getElementById('nav');

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'plan';
  const [path, query] = raw.split('?');
  const [view, id] = path.split('/');
  let dec = id;
  try { dec = id && decodeURIComponent(id); } catch { /* битая ссылка — покажем «не найдено» */ }
  return { view, id: dec, params: new URLSearchParams(query || '') };
}

function renderNav(view) {
  const active = view === 'recipe' || view === 'builder' ? 'recipes' : view === 'stats' ? 'plan' : view;
  // крупный системный шрифт: подписи разделов не помещаются — оставляем значки (с названием для экранного диктора)
  // и подпись только текущего раздела (F35)
  document.documentElement.classList.toggle('big-text', parseFloat(getComputedStyle(document.documentElement).fontSize) >= 22);
  nav.replaceChildren(h('div', { class: 'nav-inner' }, TABS.map(([v, label, ic]) =>
    h('a', { href: `#/${v}`, class: v === active ? 'active' : '', 'aria-current': v === active ? 'page' : null, 'aria-label': label }, icon(ic), h('span', null, label)))));
}

function render(opts = {}) {
  const { view, id, params } = parseHash();
  const scrollY = window.scrollY;
  const focusId = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  if (view !== 'cook') leaveCook();
  nav.hidden = view === 'cook';
  renderNav(view);
  const root = h('div');
  const rerender = (o) => render(o);
  try {
    switch (view) {
      case 'recipes': renderLibrary(root, rerender, params); break;
      case 'recipe': renderRecipe(root, rerender, id, params); break;
      case 'builder': renderBuilder(root, rerender, id, params); break;
      case 'cook': renderCook(root, rerender, id, params); break;
      case 'shop': renderShop(root, rerender); break;
      case 'stats': renderStats(root); break;
      case 'products': renderProducts(root, rerender, params); break;
      case 'profile': renderProfile(root, rerender); break;
      default: renderPlan(root, rerender);
    }
  } catch (err) {
    console.error(err);
    root.append(h('p', { class: 'notice' }, 'Что-то пошло не так: ', String(err.message || err)));
  }
  main.replaceChildren(root);
  document.title = `${TITLES[view] || 'План'} · Питание`;
  if (opts.keepScroll || opts.keepFocus) window.scrollTo(0, scrollY);
  if (opts.keepFocus && focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { if (caret != null) el.setSelectionRange(caret, caret); } catch { /* number inputs */ }
    }
  }
}

// Наверх — только при переходе на другой экран; смена параметров (порций) сохраняет прокрутку
// Окна (листы, просмотр фото) при смене экрана закрываются — в том числе по кнопке «назад» на телефоне
window.addEventListener('hashchange', (e) => {
  const oldHash = e.oldURL ? new URL(e.oldURL).hash : location.hash; // без oldURL — перерисовка того же экрана
  rememberRoute(oldHash);
  const samePage = oldHash.split('?')[0] === location.hash.split('?')[0];
  if (!samePage) closeAllLayers();
  render({ keepScroll: samePage });
  if (!samePage) window.scrollTo(0, 0);
});

// Вход по ссылке из письма: токены приходят в адресе — забираем их до первой отрисовки
const fromLink = ACCOUNTS_ENABLED ? takeSessionFromUrl() : null;
const onSync = (changed) => { if (changed) render({ keepScroll: true, keepFocus: true }); else refreshSyncText(); };

// размер шрифта мог измениться (настройки системы, масштаб) — пересчитать меню
window.addEventListener('resize', () => renderNav(parseHash().view));
// размер шрифта могут поменять и без изменения окна (настройки браузера, масштаб текста) — следим за шириной 1rem
if (typeof ResizeObserver === 'function') {
  const probe = h('span', { 'aria-hidden': 'true', style: { position: 'fixed', left: '0', top: '0', visibility: 'hidden', width: '1rem', height: '1px', pointerEvents: 'none' } });
  document.body.append(probe);
  let last = 0;
  new ResizeObserver(() => { const w = probe.getBoundingClientRect().width; if (Math.abs(w - last) > 0.5) { last = w; renderNav(parseHash().view); } }).observe(probe);
}
window.__appStarted = true; // модули загрузились — запасной экран ошибки из index.html больше не нужен
loadData()
  .then(() => {
    render();
    connectCloud(onSync);
    if (ACCOUNTS_ENABLED) startAccount(onSync).then((ok) => { if (fromLink) render(); if (fromLink?.error) alertLink(fromLink.error); else if (fromLink && ok) toastIn(); });
  })
  .catch((err) => {
    console.error(err);
    main.replaceChildren(h('div', { class: 'notice', role: 'alert' },
      h('p', null, 'Не удалось загрузить рецепты и цены. Проверьте интернет и попробуйте ещё раз.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Повторить')));
  });

// Офлайн (F39): service worker «сначала сеть» — свежая версия при сети, последнее загруженное без сети.
// На claude.ai (window.claude) не регистрируется — там своя среда.
if ('serviceWorker' in navigator && !window.claude && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Индикатор «нет сети»: отметки сохраняются в браузере и уйдут в аккаунт, когда сеть вернётся
const offlineBar = h('div', { class: 'offline-bar', role: 'status', hidden: navigator.onLine }, 'Нет сети — отметки сохраняются на этом устройстве');
document.body.append(offlineBar);
const setOnline = (on) => { offlineBar.hidden = on; document.documentElement.classList.toggle('is-offline', !on); };
setOnline(navigator.onLine);
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));

function toastIn() { toast(`Вы вошли: ${state.account?.email || ''}. Данные синхронизируются.`); }
function alertLink(msg) { toast(`Ссылка для входа не сработала: ${msg}. Введите код из письма в Профиле.`); }
