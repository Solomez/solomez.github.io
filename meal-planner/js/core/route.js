// Маршрут по магазину: в каком порядке обходить отделы (зоны). По умолчанию — типичный порядок
// австрийского супермаркета; дальше — как человек сам расставил или как он реально ходит
// (порядок, в котором он отмечает купленное, запоминается для каждого магазина).

const SESSION_GAP = 2 * 3600 * 1000; // отметки дальше двух часов друг от друга — уже другой поход

export function defaultOrder(data) {
  return (data?.aisles?.zones || []).map((z) => z.id);
}

// Порядок зон для магазина: своё (если расставлено вручную) → выученное → по умолчанию
export function routeOrder(data, routes, store) {
  const base = defaultOrder(data);
  const r = routes?.[store];
  if (r?.order?.length) return [...r.order.filter((z) => base.includes(z)), ...base.filter((z) => !r.order.includes(z))];
  const seen = r?.seen || {};
  if (!Object.keys(seen).length) return base;
  // средняя позиция зоны в реальных походах; априори — позиция по умолчанию с весом одного похода
  const pos = (z) => {
    const [sum, n] = seen[z] || [0, 0];
    return (base.indexOf(z) / base.length + sum) / (1 + n);
  };
  return [...base].sort((a, b) => pos(a) - pos(b));
}

// Отметили товар в магазине: запоминаем, какой по счёту в этом походе встретилась его зона
export function learnStep(routes, store, zone, now = Date.now()) {
  if (!store || !zone) return routes;
  const r = (routes[store] = routes[store] || {});
  r.seen = r.seen || {};
  if (!r.trip || now - r.trip.last > SESSION_GAP) r.trip = { zones: [], last: now };
  r.trip.last = now;
  if (!r.trip.zones.includes(zone)) {
    r.trip.zones.push(zone);
    // доля пути: 0 — в начале похода, ближе к 1 — в конце (из 19 зон обычно встречается 5–8)
    const rank = (r.trip.zones.length - 1) / 12;
    const [sum, n] = r.seen[zone] || [0, 0];
    r.seen[zone] = [Math.round((sum + Math.min(1, rank)) * 1000) / 1000, n + 1];
  }
  return routes;
}

export function setOrder(routes, store, order) {
  routes[store] = { ...(routes[store] || {}), order };
  return routes;
}
export function resetRoute(routes, store) {
  delete routes[store];
  return routes;
}
export const isCustom = (routes, store) => !!routes?.[store]?.order?.length;
export const isLearned = (routes, store) => !isCustom(routes, store) && Object.keys(routes?.[store]?.seen || {}).length > 0;
