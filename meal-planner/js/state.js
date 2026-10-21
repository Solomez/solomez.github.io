// Состояние приложения: данные (JSON) + настройки пользователя.
// Хранение: localStorage в этом браузере; в опубликованной версии (claude.ai) —
// ещё и личная запись в db аккаунта, чтобы план был одинаковым на телефоне и компьютере.
import { DEFAULT_PROFILE, DEFAULTABLE, dailyTargets } from './core/nutrition.js';
import { DEFAULT_PREFS } from './core/planner.js';
import { buildCustomRecipe } from './core/custom.js';
import { applySubs } from './core/subs.js';
import { compile, subOptions } from './core/compile.js';
import { has as hasTool, OLD_DEFAULT_TRUE, OLD_DEFAULT_TRUE_5 } from './core/equipment.js';

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
  custom: saved.custom || { recipes: [], products: {} }, // свои приёмы пищи (черновики), свои продукты и замены в блюдах ({ subs: { блюдо: { ингредиент: замена } } })
  stamps: saved.stamps || {}, // раздел → время изменения
  libFilters: saved.libFilters || {},
  // таймеры готовки (core/timers.js) — только на этом устройстве: переживают перезагрузку и закрытие вкладки (S61)
  timers: saved.timers && typeof saved.timers === 'object' ? saved.timers : {},
  savedAt: saved.savedAt || 0,
  schema: saved.schema || 1, // версия формата сохранённых данных (2 — рецепты-шаблоны, migrateStored)
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
    stamps: state.stamps, savedAt: state.savedAt, schema: state.schema,
  }));
}

// Запись в этом браузере: всё синхронизируемое + то, что живёт только на этом устройстве (фильтры, таймеры)
const localJSON = () => JSON.stringify({ ...snapshot(), libFilters: state.libFilters, timers: state.timers });

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
    localStorage.setItem(KEY, localJSON());
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
    try { localStorage.setItem(KEY, localJSON()); } catch { /* ignore */ }
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
  try { localStorage.setItem(KEY, localJSON()); } catch { /* ignore */ }
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
  const [r, p, st, sub, ai, kit] = await Promise.all([
    get('recipes.json'),
    get('products.json'),
    fetch(base + 'storage.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'substitutes.json').then((x) => x.json()).catch(() => ({})),
    fetch(base + 'aisles.json').then((x) => x.json()).catch(() => ({ zones: [], shelves: [], concepts: [], stores: [] })),
    get('kitchen.json'),
  ]);
  clearTimeout(timer);
  state.data = { recipes: r.recipes, products: p.products, meta: r.meta, storage: st, substitutes: sub, aisles: ai, kitchen: kit, base, baseRecipes: r.recipes, baseProducts: p.products };
  applyCustom();
  // план мог ссылаться на удалённый рецепт — убираем такие приготовления
  dropMissing(state.plan);
  if (state.schema !== SCHEMA) {
    state.migrationNotes = migrateStored();
    save();
  }
}

// Свои продукты, приёмы пищи и замены ингредиентов — к данным приложения: рецепты пересобираются из черновиков
// (цены могли обновиться). Рецепты-шаблоны (формат 2) собираются движком core/compile.js: замена меняет не только
// количество, КБЖУ и цену, но и шаги, жидкость, огонь, время, порядок, таймеры и признаки готовности.
export const cookEnv = () => ({
  kitchen: state.data.kitchen, products: state.data.products, substitutes: state.data.substitutes,
  hasTool: (id) => hasTool(state.prefs.equipment, id),
});
export function applyCustom() {
  if (!state.data?.baseRecipes) return;
  const c = state.custom || {};
  const products = { ...state.data.baseProducts, ...(c.products || {}) };
  const mine = (c.recipes || []).map((d) => { try { return buildCustomRecipe(d, products); } catch { return null; } }).filter((r) => r && r.ingredients.length);
  const subs = c.subs || {};
  state.data.products = products;
  const env = cookEnv();
  state.data.cards = new Map(state.data.baseRecipes.map((r) => [r.id, r]));
  state.data.recipes = [...state.data.baseRecipes, ...mine].map((r) => {
    if (r.format === 2) {
      const base = compile(r, env);
      const ok = validSubs(r, subs[r.id], env);
      return Object.keys(ok).length ? compile(r, { ...env, subs: ok, base }) : base;
    }
    return subs[r.id] ? applySubs(r, subs[r.id], products, state.data.substitutes) : r;
  });
  state.recipeMap = new Map(state.data.recipes.map((x) => [x.id, x]));
}

// Только допустимые замены (те же правила, что в «Чем заменить»): слот → ключ
export function validSubs(card, map, env) {
  const out = {};
  for (const [slot, key] of Object.entries(map || {})) {
    const ing = card.ingredients.find((i) => (i.id || i.key) === slot) || card.ingredients.find((i) => i.key === slot);
    const id = ing && (ing.id || ing.key);
    if (id && subOptions(card, id, env).some((o) => o.key === key && o.allowed)) out[id] = key;
  }
  return out;
}

// Данные из прошлых версий (схема хранения 1 → 2): замены, которых нет среди допустимых по новым правилам
// (другая роль, нет такого способа, исключённый продукт), снимаются; прогресс готовки сбрасывается у блюд,
// чьи шаги изменились. Планы, избранное, профиль, свои продукты не трогаются. → [сообщения для человека]
// Схема 3 — кухня: заменимая утварь (крышка, тёрка, дуршлаг, миска…) по умолчанию теперь «нет» (core/equipment.js).
// Схема 4 — режим готовки (S61, S67): таймеры хранятся (state.timers), у прогресса — отметки признаков по шагам
// (checks), порции, на которые начата готовка (portions, factor). Старый прогресс дополняется, шаг и отметки остаются.
// Схема 5 (этап 8а) — форма для запекания и прихватки по умолчанию «нет», противень идёт с духовкой.
export const SCHEMA = 5;
export function migrateCook(cook) {
  let changed = false;
  for (const prog of Object.values(cook || {})) {
    if (!prog || typeof prog !== 'object') continue;
    if (!Array.isArray(prog.done)) { prog.done = []; changed = true; }
    if (!prog.checks || typeof prog.checks !== 'object') { prog.checks = {}; changed = true; }
    if (!Array.isArray(prog.ings)) { prog.ings = []; changed = true; }
    if (typeof prog.step !== 'number' || prog.step < 0) { prog.step = 0; changed = true; }
  }
  return changed;
}
// У тех, кто уже сохранил свою кухню (отметил хоть что-то в профиле), крышка, тёрка и дуршлаг, которые раньше
// считались по умолчанию, остаются отмеченными — ничего не теряется. Нетронутая кухня получает новые умолчания.
export function migrateEquipment(prefs, ids = OLD_DEFAULT_TRUE) {
  const eq = prefs?.equipment;
  if (!eq || !Object.keys(eq).length) return false;
  let changed = false;
  for (const id of ids) if (eq[id] === undefined) { eq[id] = true; changed = true; }
  return changed;
}
// Схема 5: форма и прихватки были «есть» по умолчанию — у сохранённой кухни остаются отмеченными; противень теперь
// идёт с духовкой (отдельной отметки в профиле нет) — прежняя отметка снимается
export function migrateEquipment5(prefs) {
  const eq = prefs?.equipment;
  if (!eq) return false;
  const had = Object.keys(eq).length > 0;
  let changed = false;
  if ('tray' in eq) { delete eq.tray; changed = true; }
  if (had && migrateEquipment(prefs, OLD_DEFAULT_TRUE_5)) changed = true;
  return changed;
}
export function migrateStored() {
  if ((state.schema || 1) < 3) migrateEquipment(state.prefs);
  if ((state.schema || 1) < 5) migrateEquipment5(state.prefs);
  if ((state.schema || 1) < 4) {
    migrateCook(state.cook);
    if (!state.timers || typeof state.timers !== 'object') state.timers = {};
  }
  if (!state.data?.baseRecipes) return [];
  const notes = [];
  const env = cookEnv();
  const subs = { ...(state.custom?.subs || {}) };
  let subsChanged = false;
  for (const [rid, map] of Object.entries(subs)) {
    const card = state.data.cards?.get(rid);
    if (!card || card.format !== 2) continue;
    const keep = {};
    for (const [slot, key] of Object.entries(map || {})) {
      // слот у старых данных — ключ продукта; у шаблона слот может называться иначе
      const ing = card.ingredients.find((i) => (i.id || i.key) === slot) || card.ingredients.find((i) => i.key === slot);
      const id = ing && (ing.id || ing.key);
      const opt = id && subOptions(card, id, env).find((o) => o.key === key);
      if (opt?.allowed) keep[id] = key;
      else notes.push(`«${card.title}»: замена ${state.data.products[key]?.name_ru || key} снята — ${opt?.reason || 'больше не подходит к этому блюду'}`);
    }
    if (JSON.stringify(keep) !== JSON.stringify(map)) { subsChanged = true; if (Object.keys(keep).length) subs[rid] = keep; else delete subs[rid]; }
  }
  // кухня могла измениться (схема 3) — рецепты пересобираются под неё (шаги без тёрки, без дуршлага…)
  if (subsChanged) state.custom = { ...state.custom, subs };
  applyCustom();
  // прогресс готовки: подпись шагов
  for (const [rid, prog] of Object.entries(state.cook || {})) {
    const r = state.recipeMap.get(rid);
    if (!r?.compiled) continue;
    const sig = stepsSig(r);
    if (prog.sig !== sig) {
      state.cook[rid] = { step: 0, done: [], ings: prog.ings || [], checks: {}, sig };
      for (const [k, t] of Object.entries(state.timers || {})) if (t.rid === rid) delete state.timers[k];
    }
  }
  state.schema = SCHEMA;
  return notes;
}
export const stepsSig = (r) => {
  let h = 0;
  for (const ch of r.steps.map((s) => s.tpl || s.text).join('|')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${r.steps.length}:${h}`;
};

// Замена ингредиента в одном блюде: subKey — чем заменить, null — вернуть как в рецепте
export function setSub(recipeId, key, subKey) {
  const all = { ...(state.custom?.subs || {}) };
  const mine = { ...(all[recipeId] || {}) };
  if (subKey) mine[key] = subKey; else delete mine[key];
  if (Object.keys(mine).length) all[recipeId] = mine; else delete all[recipeId];
  state.custom = { ...state.custom, subs: all };
  applyCustom();
  save();
}

export function toggleIn(listName, id) {
  const list = new Set(state.prefs[listName] || []);
  list.has(id) ? list.delete(id) : list.add(id);
  state.prefs[listName] = [...list];
  save();
  return list.has(id);
}
