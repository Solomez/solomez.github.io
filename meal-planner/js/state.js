// Состояние приложения: данные (JSON) + настройки пользователя.
// Хранение: localStorage в этом браузере; в опубликованной версии (claude.ai) —
// ещё и личная запись в db аккаунта, чтобы план был одинаковым на телефоне и компьютере.
import { DEFAULT_PROFILE, dailyTargets } from './core/nutrition.js';
import { DEFAULT_PREFS } from './core/planner.js';

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
export const SECTIONS = ['profile', 'prefs', 'plan', 'checked', 'cook', 'pantry', 'cart', 'swaps', 'routes', 'places', 'unavailable'];

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
  stamps: saved.stamps || {}, // раздел → время изменения
  altCursor: {}, // batchId → индекс следующей замены (не сохраняется)
  libFilters: saved.libFilters || {},
  savedAt: saved.savedAt || 0,
  sync: 'local', // 'local' | 'connecting' | 'cloud'
  account: null, // { email } — вход через Supabase на своём сайте
};

function snapshot() {
  // отметки и замены храним только для текущего плана — иначе запись растёт неделя за неделей
  const only = (m) => (state.plan && m[state.plan.id] ? { [state.plan.id]: m[state.plan.id] } : {});
  // «нет в магазине» помним 3 недели
  const fresh = Object.fromEntries(Object.entries(state.unavailable).filter(([, t]) => Date.now() - t < 21 * 86400000));
  return JSON.parse(JSON.stringify({
    profile: state.profile, prefs: state.prefs, plan: state.plan, checked: only(state.checked), cook: state.cook,
    pantry: state.pantry, cart: state.cart, swaps: only(state.swaps), routes: state.routes, places: state.places, unavailable: fresh,
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
// backend: { name, pull(): Promise<данные | null>, push(данные): Promise<void> }
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
  } catch (e) {
    if (e?.fatal) { backend = null; state.sync = 'local'; } else dirty = true;
  } finally {
    writing = false;
    if (dirty && backend) timer = setTimeout(flushCloud, 3000);
  }
}

// Слияние: по каждому разделу берём более свежую версию. Возвращает true, если что-то пришло с другого устройства.
export function mergeRemote(d) {
  if (!d) return false;
  const rs = d.stamps || {};
  let changed = false;
  for (const k of SECTIONS) {
    // старые записи без меток разделов: доверяем общему времени сохранения
    const remoteT = rs[k] ?? (d.stamps ? 0 : d.savedAt || 0);
    const localT = state.stamps[k] ?? (Object.keys(state.stamps).length ? 0 : state.savedAt || 0);
    if (d[k] === undefined || remoteT <= localT) continue;
    state[k] = k === 'profile' ? { ...DEFAULT_PROFILE, ...(d[k] || {}) } : k === 'prefs' ? { ...DEFAULT_PREFS, ...(d[k] || {}) } : d[k];
    state.stamps[k] = remoteT;
    prints[k] = printOf(k);
    changed = true;
  }
  if (changed) {
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
    const changed = mergeRemote(remote);
    // на сервере нет того, что есть здесь (или здесь новее) — отправляем
    if (!remote || SECTIONS.some((k) => (state.stamps[k] || 0) > ((remote.stamps || {})[k] || 0))) { dirty = true; flushCloud(); }
    onChange(changed);
  } catch (e) {
    backend = null;
    state.sync = 'local';
    onChange(false, e);
  }
}
export function detachBackend() { backend = null; state.sync = 'local'; }

// Вернулись в приложение (или прошло полминуты) — проверить, не менялось ли что-то на другом устройстве
let pulling = false;
export async function pullNow(onChange) {
  if (!backend || pulling || writing) return;
  pulling = true;
  try { if (mergeRemote(await backend.pull())) onChange(true); } catch { /* сеть — попробуем позже */ } finally { pulling = false; }
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
  const [r, p, st, sub, ai] = await Promise.all([
    fetch(base + 'recipes.json').then((x) => x.json()),
    fetch(base + 'products.json').then((x) => x.json()),
    fetch(base + 'storage.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'substitutes.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'aisles.json').then((x) => x.json()).catch(() => ({ zones: [], shelves: [], concepts: [], stores: [] })),
  ]);
  state.data = { recipes: r.recipes, products: p.products, meta: r.meta, storage: st, substitutes: sub, aisles: ai, base };
  state.recipeMap = new Map(r.recipes.map((x) => [x.id, x]));
  // план мог ссылаться на удалённый рецепт — убираем такие приготовления
  dropMissing(state.plan);
}

export function toggleIn(listName, id) {
  const list = new Set(state.prefs[listName] || []);
  list.has(id) ? list.delete(id) : list.add(id);
  state.prefs[listName] = [...list];
  save();
  return list.has(id);
}
