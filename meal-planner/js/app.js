import { h, icon, closeAllLayers } from './ui.js';
import { state, loadData, connectCloud } from './state.js';
import { renderPlan } from './views/plan.js';
import { renderLibrary } from './views/library.js';
import { renderRecipe, rememberRoute } from './views/recipe.js';
import { renderShop } from './views/shop.js';
import { renderCook, leaveCook } from './views/cook.js';
import { renderStats } from './views/stats.js';
import { renderProfile, refreshSyncText } from './views/profile.js';

const TABS = [
  ['plan', 'План', 'plan'],
  ['recipes', 'Рецепты', 'book'],
  ['shop', 'Покупки', 'cart'],
  ['stats', 'Итоги', 'chart'],
  ['profile', 'Профиль', 'user'],
];
const TITLES = { plan: 'План', recipes: 'Рецепты', recipe: 'Рецепт', shop: 'Покупки', stats: 'Итоги', profile: 'Профиль', cook: 'Готовка' };

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
  const active = view === 'recipe' ? 'recipes' : view;
  nav.replaceChildren(h('div', { class: 'nav-inner' }, TABS.map(([v, label, ic]) =>
    h('a', { href: `#/${v}`, class: v === active ? 'active' : '', 'aria-current': v === active ? 'page' : null }, icon(ic), h('span', null, label)))));
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
      case 'recipes': renderLibrary(root, rerender); break;
      case 'recipe': renderRecipe(root, rerender, id, params); break;
      case 'cook': renderCook(root, rerender, id, params); break;
      case 'shop': renderShop(root, rerender); break;
      case 'stats': renderStats(root); break;
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

loadData()
  .then(() => { render(); connectCloud((changed) => { if (changed) render({ keepScroll: true }); else refreshSyncText(); }); })
  .catch((err) => {
    console.error(err);
    main.replaceChildren(h('p', { class: 'notice' }, 'Не удалось загрузить данные (data/recipes.json). Запустите приложение командой python3 serve.py из папки проекта.'));
  });

// Офлайн-кэш отключён: он показывал устаревшие версии. Удаляем то, что осталось от прошлых версий.
if ('serviceWorker' in navigator && !window.claude) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
}
