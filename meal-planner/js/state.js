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

export const state = {
  data: null, // { recipes, products, meta }
  recipeMap: new Map(),
  profile: { ...DEFAULT_PROFILE, ...(saved.profile || {}) },
  prefs: { ...DEFAULT_PREFS, ...(saved.prefs || {}) },
  plan: saved.plan || null,
  checked: saved.checked || {}, // planId → { key: true }
  cook: saved.cook || {}, // recipeId → { step, done: [] }
  altCursor: {}, // batchId → индекс следующей замены (не сохраняется)
  libFilters: saved.libFilters || {},
  savedAt: saved.savedAt || 0,
  sync: 'local', // 'local' | 'connecting' | 'cloud'
};

function snapshot() {
  // отметки покупок храним только для текущего плана — иначе запись растёт неделя за неделей
  const checked = state.plan && state.checked[state.plan.id] ? { [state.plan.id]: state.checked[state.plan.id] } : {};
  return JSON.parse(JSON.stringify({
    profile: state.profile, prefs: state.prefs, plan: state.plan, checked, cook: state.cook, savedAt: state.savedAt,
  }));
}

export function save() {
  state.savedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), libFilters: state.libFilters }));
  } catch {
    /* приватный режим или переполнение — работаем без локального сохранения */
  }
  scheduleCloud();
}

// ---------- Синхронизация через аккаунт (только в опубликованной версии) ----------
let cloudRef = null;
let timer = null;
let writing = false;
let dirty = false;

function scheduleCloud() {
  if (!cloudRef) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flushCloud, 900); // одна запись на паузу в действиях
}

async function flushCloud() {
  if (!cloudRef || writing || !dirty) return;
  writing = true;
  dirty = false;
  try {
    await cloudRef.set(snapshot());
  } catch (e) {
    if (e?.code === 'unavailable') dirty = true;
    else if (['invalid_argument', 'revoked', 'not_granted'].includes(e?.code)) { cloudRef = null; state.sync = 'local'; }
  } finally {
    writing = false;
    if (dirty && cloudRef) timer = setTimeout(flushCloud, 1500);
  }
}

function applyRemote(d) {
  state.profile = { ...DEFAULT_PROFILE, ...(d.profile || {}) };
  state.prefs = { ...DEFAULT_PREFS, ...(d.prefs || {}) };
  state.plan = d.plan || null;
  state.checked = d.checked || {};
  state.cook = d.cook || {};
  state.savedAt = d.savedAt || 0;
  try { localStorage.setItem(KEY, JSON.stringify({ ...snapshot(), libFilters: state.libFilters })); } catch { /* ignore */ }
}

export async function connectCloud(onChange) {
  if (!IS_ARTIFACT) return;
  state.sync = 'connecting';
  try {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    const id = user ? await user.id() : null;
    if (!db || !id) { state.sync = 'local'; onChange(false); return; }
    const ref = db.doc(`data/users/${id}/state`);
    const snap = await ref.get();
    cloudRef = ref;
    state.sync = 'cloud';
    const remote = snap.exists ? snap.data() : null;
    if (remote && (remote.savedAt || 0) > (state.savedAt || 0)) {
      applyRemote(remote);
      if (state.plan && state.recipeMap.size) state.plan.batches = state.plan.batches.filter((b) => state.recipeMap.has(b.recipeId));
      onChange(true);
    } else {
      if (state.savedAt) scheduleCloud();
      onChange(false);
    }
  } catch {
    cloudRef = null;
    state.sync = 'local';
    onChange(false);
  }
}

// Закрыли вкладку или свернули приложение — отправить несохранённое сразу, не дожидаясь паузы
if (typeof window !== 'undefined') {
  const flushNow = () => { if (dirty && cloudRef) { clearTimeout(timer); flushCloud(); } };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
}

export const targets = () => dailyTargets(state.profile);

export async function loadData() {
  const base = document.querySelector('meta[name="data-base"]')?.content || '../data/';
  const [r, p, st] = await Promise.all([
    fetch(base + 'recipes.json').then((x) => x.json()),
    fetch(base + 'products.json').then((x) => x.json()),
    fetch(base + 'storage.json').then((x) => x.json()).catch(() => ({})),
  ]);
  state.data = { recipes: r.recipes, products: p.products, meta: r.meta, storage: st };
  state.recipeMap = new Map(r.recipes.map((x) => [x.id, x]));
  // план мог ссылаться на удалённый рецепт — убираем такие приготовления
  if (state.plan) state.plan.batches = state.plan.batches.filter((b) => state.recipeMap.has(b.recipeId));
}

export function toggleIn(listName, id) {
  const list = new Set(state.prefs[listName] || []);
  list.has(id) ? list.delete(id) : list.add(id);
  state.prefs[listName] = [...list];
  save();
  return list.has(id);
}
