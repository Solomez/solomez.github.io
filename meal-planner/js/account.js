// Вход в аккаунт и синхронизация через Supabase (на своём сайте; на claude.ai — синхронизация через аккаунт Claude).
// Вход без пароля: письмо с кодом и ссылкой. Данные — одна строка в таблице app_state, видна только владельцу.
// Адрес проекта и публичный ключ — в <meta name="supabase-url"> и <meta name="supabase-key"> (их подставляет build_site.py).
import { state, attachBackend, detachBackend, pullNow } from './state.js';

const meta = (n) => (typeof document !== 'undefined' ? document.querySelector(`meta[name="${n}"]`)?.content || '' : '');
const URL_ = meta('supabase-url').replace(/\/$/, '');
const KEY = meta('supabase-key');
const AUTH_KEY = 'mealplanner.auth';

export const ACCOUNTS_ENABLED = !!(URL_ && KEY) && !(typeof window !== 'undefined' && window.claude?.use);

function readSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}
function writeSession(s) {
  try { s ? localStorage.setItem(AUTH_KEY, JSON.stringify(s)) : localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
}
let session = readSession();

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const r = await fetch(URL_ + path, {
    method,
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error(data?.msg || data?.error_description || data?.message || `Ошибка ${r.status}`);
    err.status = r.status;
    err.code = data?.error_code || data?.code;
    throw err;
  }
  return data;
}

function keep(d) {
  session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at ? d.expires_at * 1000 : Date.now() + (d.expires_in || 3600) * 1000,
    user: d.user ? { id: d.user.id, email: d.user.email } : session?.user,
  };
  writeSession(session);
  state.account = session.user ? { email: session.user.email } : null;
}

// Действующий токен: за минуту до истечения обновляем
async function token() {
  if (!session) throw Object.assign(new Error('Не выполнен вход'), { fatal: true });
  if (Date.now() > session.expires_at - 60000) {
    try {
      keep(await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } }));
    } catch (e) {
      if (e.status === 400 || e.status === 401) { signOutLocal(); e.fatal = true; }
      throw e;
    }
  }
  return session.access_token;
}

// 1) письмо с кодом (и ссылкой) на почту
export async function sendCode(email) {
  const redirect = location.origin + location.pathname;
  await api(`/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', body: { email, create_user: true } });
}

// 2) код из письма → вход
export async function verifyCode(email, code) {
  let lastErr;
  // первый вход приходит как «подтверждение регистрации», повторные — как «ссылка для входа»
  for (const type of ['email', 'signup', 'magiclink']) {
    try {
      keep(await api('/auth/v1/verify', { method: 'POST', body: { email, token: String(code).trim(), type } }));
      return session.user;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Вход по ссылке из письма: Supabase возвращает на сайт с токенами в адресе (#access_token=…)
export function takeSessionFromUrl() {
  const h = typeof location !== 'undefined' ? location.hash : '';
  if (!/access_token=/.test(h)) {
    if (/error_description=/.test(h)) {
      const p = new URLSearchParams(h.slice(1));
      history.replaceState(null, '', location.pathname + '#/profile');
      return { error: p.get('error_description') };
    }
    return null;
  }
  const p = new URLSearchParams(h.slice(1));
  keep({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600, expires_at: +p.get('expires_at') || 0 });
  history.replaceState(null, '', location.pathname + '#/profile');
  return { ok: true };
}

async function loadUser() {
  if (session?.user?.email) return;
  const u = await api('/auth/v1/user', { token: await token() });
  session.user = { id: u.id, email: u.email };
  writeSession(session);
  state.account = { email: u.email };
}

// Время последней известной версии строки на сервере (как его вернул сервер) — чтобы не скачивать данные без изменений
let knownAt = null;
const backend = {
  name: 'supabase',
  // ifChanged: вернуть undefined, если строка не менялась с прошлого раза (ответ — пустой список, без данных)
  async pull(ifChanged) {
    const t = await token();
    const since = ifChanged && knownAt ? `&updated_at=neq.${encodeURIComponent(knownAt)}` : '';
    const rows = await api(`/rest/v1/app_state?select=data,updated_at&user_id=eq.${session.user.id}${since}`, { token: t });
    if (since && !rows?.length) return undefined;
    knownAt = rows?.[0]?.updated_at || null;
    return rows?.[0]?.data || null;
  },
  async push(data) {
    const t = await token();
    const rows = await api('/rest/v1/app_state?on_conflict=user_id&select=updated_at', {
      method: 'POST', token: t, headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: { user_id: session.user.id, data, updated_at: new Date().toISOString() },
    });
    // своя запись — скачивать её обратно не нужно
    if (rows?.[0]?.updated_at) knownAt = rows[0].updated_at;
  },
};

const POLL_MS = 5 * 60000;
let poll = null;
let listening = false;
let lastCheck = 0;
// После входа (или при запуске, если вход уже был): подключить синхронизацию
export async function startAccount(onChange) {
  if (!ACCOUNTS_ENABLED || !session) return false;
  try {
    await loadUser();
  } catch (e) {
    if (e.fatal) { onChange(false); return false; }
  }
  state.account = { email: session.user?.email };
  knownAt = null;
  await attachBackend(backend, onChange);
  lastCheck = Date.now();
  clearInterval(poll);
  // изменения с другого устройства: при возврате в приложение (не чаще раза в 5 секунд) и раз в 5 минут, пока оно открыто
  const check = (minGap) => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < minGap) return;
    lastCheck = Date.now();
    pullNow(onChange);
  };
  poll = setInterval(() => check(POLL_MS / 2), POLL_MS);
  if (!listening) {
    listening = true;
    const back = () => check(5000);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    window.addEventListener('online', back);
  }
  return true;
}

function signOutLocal() {
  session = null;
  writeSession(null);
  state.account = null;
  knownAt = null;
  clearInterval(poll);
  detachBackend();
}

export async function signOut() {
  try { if (session) await api('/auth/v1/logout', { method: 'POST', token: session.access_token }); } catch { /* всё равно выходим */ }
  signOutLocal();
}

export const signedIn = () => !!session;
