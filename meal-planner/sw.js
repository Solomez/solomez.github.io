// Офлайн для магазина (F39): «сначала сеть» — при сети всегда свежая версия (раньше кэш «сначала кэш»
// показывал устаревшие версии и был отключён); без сети или при очень медленной сети (подвал магазина) — последнее
// загруженное: приложение, данные, каталог. Чужие адреса (фото магазинов, вход в аккаунт) не трогаем.
const CACHE = 'mealplanner-20261017094909'; // версия подставляется при сборке (scripts/build_site.py)
const SLOW_MS = 4000; // дольше — отдаём из кэша, а ответ сети дописываем в кэш в фоне

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // у навигации (mode: 'navigate') нельзя менять параметры запроса — её кэш задаёт сервер (no-cache в _headers);
  // остальное — no-cache: та же свежесть через ETag/If-None-Match, но с ответом 304 вместо полной загрузки.
  // Копию ответа снимаем сразу, до того как страница начнёт читать тело.
  const net = (req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' })).then((res) => ({ res, copy: res.ok ? res.clone() : null }));
  e.waitUntil(net.then(({ copy }) => copy && caches.open(CACHE).then((c) => c.put(req, copy))).catch(() => {})); // переполнение квоты — не ошибка
  e.respondWith((async () => {
    const cached = caches.match(req, { ignoreSearch: req.mode === 'navigate' })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match(new URL('./', self.location).href) : null));
    const slow = new Promise((ok) => setTimeout(ok, SLOW_MS, 'slow'));
    try {
      const first = await Promise.race([net, slow]);
      if (first !== 'slow') return first.res;
      return (await cached) || (await net).res; // кэша нет — ждём сеть
    } catch (err) {
      const hit = await cached;
      if (hit) return hit;
      throw err;
    }
  })());
});
