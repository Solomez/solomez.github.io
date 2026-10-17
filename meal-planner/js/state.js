// Состояние приложения: данные (JSON) + настройки пользователя.
// Хранение: localStorage в этом браузере; в опубликованной версии (claude.ai) —
// ещё и личная запись в db аккаунта, чтобы план был одинаковым на телефоне и компьютере.
import { DEFAULT_PROFILE, DEFAULTABLE, dailyTargets } from './core/nutrition.js';
import { DEFAULT_PREFS } from './core/planner.js';
import { buildCustomRecipe } from './core/custom.js';

const KEY = 'mealplanner.v1';
// Опубликованная страница работает внутри claude.ai: там есть window.claude, нет печати и скачивания файлов
export const IS_ARTIFACT = typeof window !== 'undefined' && !!window.claude?.use;

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

const saved = read();

// Разделы, которые синхронизируются между устройствами. У каждого — время последнего изменения,
// при встрече двух версий (ноутбук и телефон) берётся более свежая по каждому разделу.
export const SECTIONS = ['profile', 'prefs', 'plan', 'checked', 'cook', 'pantry', 'cart', 'swaps', 'routes', 'places', 'unavailable', 'custom'];

export const state = {
  data: null, // { recipes, products, meta, storage, substitutes, aisles }
  recipeMap: new Map(),
  profile: { ...DEFAULT_PROFILE, ...(saved.profile || {}) },
  prefs: { ...DEFAULT_PREFS, ...(saved.prefs || {}) },
  plan: saved.plan || null,
  checked: saved.checked || {}, // planId → { key: true }
  cook: saved.cook || {}, // recipeId → { step, done: [] }
  pantry: saved.pantry || {}, // что есть дома: ref → { have, grams?, at }
  cart: saved.cart || [], // свои товары в списке покупок: [{ id, ref, name, store, qty, at }]
  swaps: saved.swaps || {}, // planId → { key: { ref, name, store, at } } — «взял вместо»
  routes: saved.routes || {}, // магазин → { order: [зоны], seen: { зона: [сумма мест, раз] } }
  places: saved.places || {}, // магазин → { ref: полка } — «лежит в другом отделе»
  unavailable: saved.unavailable || {}, // 'магазин|ref' → дата, когда не нашли на полке
  custom: saved.custom || { recipes: [], products: {} }, // свои приёмы пищи (черновики) и свои продукты из каталога
  stamps: saved.stamps || {}, // раздел → время изменения
  libFilters: saved.libFilters || {},
  savedAt: saved.savedAt || 0,
  sync: 'local', // 'local' | 'connecting' | 'cloud'
  account: null, // { email } — вход через Supabase на своём сайте
};

// Профиль из старых версий: заполненный профиль считается проверенным (не помечаем его поля «по умолчанию»)
export function normalizeProfile(p) {
  if (!Array.isArray(p.touched)) p.touched = p.sex && p.height > 0 && p.weight > 0 ? [...DEFAULTABLE] : [];
  return p;
}
normalizeProfile(state.profile);

// У разделов без метки (данные до этого обновления) — время прошлого сохранения на этом устройстве.
// Фиксируем его сразу: иначе любое следующее сохранение сделало бы «свежими» и все нетронутые разделы.
for (const k of SECTIONS) if (state.stamps[k] == null) state.stamps[k] = saved.savedAt || 0;

function snapshot() {
  // отметки и замены храним только для текущего плана — иначе запись растёт неделя за неделей
  const only = (m) => (state.plan && m[state.plan.id] ? { [state.plan.id]: m[state.plan.id] } : {});
  // «нет в магазине» помним 3 недели
  const fresh = Object.fromEntries(Object.entries(state.unavailable).filter(([, t]) => Date.now() - t < 21 * 86400000));
  return JSON.parse(JSON.stringify({
    profile: state.profile, prefs: state.prefs, plan: state.plan, checked: only(state.checked), cook: state.cook,
    pantry: state.pantry, cart: state.cart, swaps: only(state.swaps), routes: state.routes, places: state.places, unavailable: fresh, custom: state.custom,
    stamps: state.stamps, savedAt: state.savedAt,
  }));
}

// Какие разделы изменились с прошлого сохранения — по отпечатку содержимого
const prints = {};
const printOf = (k) => JSON.stringify(state[k] ?? null);
for (const k of SECTIONS) prints[k] = printOf(k);

export function save() {
  state.savedAt = Date.now();
  for (const k of SECTIONS) {
    const p = printOf(k);
    if (p !== prints[k]) { prints[k] = p; state.stamps[k] = state.savedAt; }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), libFilters: state.libFilters }));
  } catch {
    /* приватный режим или переполнение — работаем без локального сохранения */
  }
  scheduleCloud();
}

// ---------- Синхронизация: облако — claude.ai (в опубликованной версии) или Supabase (на своём сайте) ----------
// backend: { name, pull(ifChanged?): Promise<данные | null | undefined — «не менялось»>, push(данные): Promise<void> }
let backend = null;
let timer = null;
let writing = false;
let dirty = false;

function scheduleCloud() {
  if (!backend) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flushCloud, 900); // одна запись на паузу в действиях
}

async function flushCloud() {
  if (!backend || writing || !dirty) return;
  writing = true;
  dirty = false;
  try {
    await backend.push(snapshot());
    state.lastSync = Date.now();
  } catch (e) {
    if (e?.fatal) { backend = null; state.sync = 'local'; } else dirty = true;
  } finally {
    writing = false;
    if (dirty && backend) timer = setTimeout(flushCloud, 3000);
  }
}

// Слияние: по каждому разделу берём более свежую версию. Возвращает true, если что-то пришло с другого устройства.
// Время изменения раздела; у раздела без метки (старые данные, или раздел не меняли после обновления) —
// время последнего сохранения на том устройстве
const stampOf = (d, k) => d?.stamps?.[k] ?? d?.savedAt ?? 0;
export const localStamp = (k) => stampOf(state, k);

export function mergeRemote(d) {
  if (!d) return false;
  let changed = false;
  for (const k of SECTIONS) {
    const remoteT = stampOf(d, k);
    const localT = localStamp(k);
    if (d[k] === undefined || remoteT <= localT) continue;
    state[k] = k === 'profile' ? normalizeProfile({ ...DEFAULT_PROFILE, ...(d[k] || {}) }) : k === 'prefs' ? { ...DEFAULT_PREFS, ...(d[k] || {}) } : d[k];
    state.stamps[k] = remoteT;
    prints[k] = printOf(k);
    changed = true;
  }
  if (changed) {
    applyCustom();
    dropMissing(state.plan);
    try { localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), libFilters: state.libFilters })); } catch { /* ignore */ }
  }
  return changed;
}

// Подключить облако: забрать свежее с сервера, отправить своё, затем подтягивать изменения при возврате в приложение
export async function attachBackend(b, onChange) {
  backend = b;
  state.sync = 'connecting';
  try {
    const remote = await b.pull();
    state.sync = 'cloud';
    state.lastSync = Date.now();
    const changed = mergeRemote(remote);
    // на сервере нет того, что есть здесь (или здесь новее) — отправляем
    if (newerHere(remote)) { dirty = true; flushCloud(); }
    onChange(changed);
  } catch (e) {
    backend = null;
    state.sync = 'local';
    onChange(false, e);
  }
}
export function detachBackend() { backend = null; state.sync = 'local'; }

// Вернулись в приложение (или прошло несколько минут) — проверить, не менялось ли что-то на другом устройстве
let pulling = false;
export async function pullNow(onChange) {
  if (!backend || pulling || writing) return;
  pulling = true;
  try {
    const remote = await backend.pull(true);
    state.lastSync = Date.now();
    if (remote === undefined) return; // на сервере то же, что мы уже видели
    if (mergeRemote(remote)) onChange(true);
    if (newerHere(remote)) { dirty = true; flushCloud(); } // здесь есть что-то новее, чем на сервере
  } catch { /* сеть — попробуем позже */ } finally { pulling = false; }
}

// Есть ли здесь разделы новее, чем на сервере (или на сервере ещё ничего нет)
function newerHere(remote) {
  return !remote || SECTIONS.some((k) => localStamp(k) > stampOf(remote, k));
}

// «Сделать данные этого устройства главными»: все разделы получают текущее время и уходят на сервер
export function claimAll() {
  const t = Date.now();
  for (const k of SECTIONS) { state.stamps[k] = t; prints[k] = printOf(k); }
  state.savedAt = t;
  try { localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), libFilters: state.libFilters })); } catch { /* ignore */ }
  if (backend) { dirty = true; clearTimeout(timer); return flushCloud(); }
  return Promise.resolve();
}

export async function connectCloud(onChange) {
  if (!IS_ARTIFACT) return;
  state.sync = 'connecting';
  try {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    const id = user ? await user.id() : null;
    if (!db || !id) { state.sync = 'local'; onChange(false); return; }
    const ref = db.doc(`data/users/${id}/state`);
    await attachBackend({
      name: 'claude',
      pull: async () => { const snap = await ref.get(); return snap.exists ? snap.data() : null; },
      push: async (d) => {
        try { await ref.set(d); } catch (e) {
          if (['invalid_argument', 'revoked', 'not_granted'].includes(e?.code)) e.fatal = true;
          throw e;
        }
      },
    }, onChange);
  } catch {
    state.sync = 'local';
    onChange(false);
  }
}

// Закрыли вкладку или свернули приложение — отправить несохранённое сразу, не дожидаясь паузы
if (typeof window !== 'undefined') {
  const flushNow = () => { if (dirty && backend) { clearTimeout(timer); flushCloud(); } };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
}

export const targets = () => dailyTargets(state.profile);

// План мог ссылаться на удалённые рецепты — убираем такие приготовления, завтраки и перекусы
export function dropMissing(plan) {
  if (!plan || !state.recipeMap.size) return;
  plan.batches = (plan.batches || []).filter((b) => state.recipeMap.has(b.recipeId));
  if (plan.extras) plan.extras = plan.extras.filter((x) => state.recipeMap.has(x.recipeId));
}

export async function loadData() {
  const base = document.querySelector('meta[name="data-base"]')?.content || '../data/';
  // тайм-аут: при очень плохой связи — экран «Не удалось загрузить» с «Повторить», а не вечная «Загрузка…»
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 25000);
  const get = (f) => fetch(base + f, { signal: ctl?.signal }).then((x) => { if (!x.ok) throw new Error(`${f}: ${x.status}`); return x.json(); });
  const [r, p, st, sub, ai] = await Promise.all([
    get('recipes.json'),
    get('products.json'),
    fetch(base + 'storage.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'substitutes.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'aisles.json').then((x) => x.json()).catch(() => ({ zones: [], shelves: [], concepts: [], stores: [] })),
  ]);
  clearTimeout(timer);
  state.data = { recipes: r.recipes, products: p.products, meta: r.meta, storage: st, substitutes: sub, aisles: ai, base, baseRecipes: r.recipes, baseProducts: p.products };
  applyCustom();
  // план мог ссылаться на удалённый рецепт — убираем такие приготовления
  dropMissing(state.plan);
}

// Свои продукты и приёмы пищи — к данным приложения: рецепты пересобираются из черновиков (цены могли обновиться)
export function applyCustom() {
  if (!state.data?.baseRecipes) return;
  const c = state.custom || {};
  const products = { ...state.data.baseProducts, ...(c.products || {}) };
  const mine = (c.recipes || []).map((d) => { try { return buildCustomRecipe(d, products); } catch { return null; } }).filter((r) => r && r.ingredients.length);
  state.data.products = products;
  state.data.recipes = [...state.data.baseRecipes, ...mine];
  state.recipeMap = new Map(state.data.recipes.map((x) => [x.id, x]));
}

export function toggleIn(listName, id) {
  const list = new Set(state.prefs[listName] || []);
  list.has(id) ? list.delete(id) : list.add(id);
  state.prefs[listName] = [...list];
  save();
  return list.has(id);
}
