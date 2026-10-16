// План походов в магазин: в один день — один магазин, скоропортящееся — ближе ко дню готовки,
// долгохранящееся — в любой из походов, чтобы походов было как можно меньше.
// Дни — номера дней плана (0 = первый день, могут быть отрицательными: до начала плана).

// Магазины в Австрии закрыты по воскресеньям и в праздники (8 декабря большинство открыто)
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-06', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-06-04', '2026-08-15', '2026-10-26', '2026-11-01', '2026-12-25', '2026-12-26',
  '2027-01-01', '2027-01-06', '2027-03-29', '2027-05-01', '2027-05-06', '2027-05-17', '2027-05-27', '2027-08-15', '2027-10-26', '2027-11-01', '2027-12-25', '2027-12-26',
]);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const storesClosed = (date) => date.getDay() === 0 || HOLIDAYS.has(iso(date));

// Сколько дней до готовки продукт можно покупать, не теряя свежести
export function buyAheadDays(key, storage) {
  const s = storage?.[key];
  if (!s) return 7;
  if (['freezer', 'pantry', 'cool'].includes(s.place)) return 14;
  if (s.place === 'counter') return ['bread', 'toast_bread'].includes(key) ? 3 : 4;
  if (/mince/.test(key)) return 1;
  if (s.place === 'fridge' && /нижняя/.test(s.shelf || '')) return 2;
  if (['mushrooms', 'spring_onion', 'parsley', 'lettuce', 'cucumber', 'mozzarella'].includes(key)) return 3;
  if (['cottage_cheese', 'skyr', 'magertopfen', 'natural_yogurt', 'sour_cream', 'bell_pepper', 'cauliflower', 'leek', 'tomato'].includes(key)) return 5;
  return 10; // яйца, твёрдый сыр, масло, морковь, капуста, молоко, сливки
}

/**
 * items: [{ key, store, cost }]
 * needDay(key) — день, когда продукт нужен впервые; aheadOf(key) — дней свежести;
 * altCost(key, store) — цена продукта в другом магазине (null — там его нет): чтобы не ходить в два магазина в один день;
 * firstDay — первый день, когда можно идти в магазин; dateOf(day) — дата дня (для выходных и праздников).
 * Возвращает [{ day, store, items, total, early }] по возрастанию дня; early — пришлось купить раньше и заморозить.
 */
export function planTrips(items, { needDay, aheadOf, firstDay, dateOf, altCost = () => null, canFreeze = () => false, maxExtra = 2 }) {
  const open = (d) => !storesClosed(dateOf(d));
  const win = items.map((it) => {
    const b = Math.max(firstDay, needDay(it.key));
    const a = Math.max(firstDay, b - aheadOf(it.key));
    return { it, a, b };
  });
  const latestOpen = (a, b, avoid = new Set()) => {
    for (let d = b; d >= a; d--) if (open(d) && !avoid.has(d)) return d;
    return null;
  };

  // 1) по каждому магазину — минимум походов: жадное покрытие окон точками (по концу окна)
  const byStore = new Map();
  for (const w of win) {
    if (!byStore.has(w.it.store)) byStore.set(w.it.store, []);
    byStore.get(w.it.store).push(w);
  }
  let trips = [];
  for (const [store, ws] of byStore) {
    ws.sort((x, y) => x.b - y.b || x.a - y.a);
    const mine = [];
    for (const w of ws) {
      const t = mine.find((t) => t.day >= w.a && t.day <= w.b);
      if (t) { t.ws.push(w); continue; }
      let day = latestOpen(w.a, w.b);
      let early = false;
      if (day == null) { day = latestOpen(firstDay, w.a); early = true; } // в окне только выходные — купить раньше
      if (day == null) day = w.b;
      mine.push({ store, day, ws: [w], early });
    }
    trips.push(...mine);
  }

  // 2) разводим магазины по разным дням: меньший поход переносим на свободный день внутри общего окна
  const rangeOf = (t) => ({ a: Math.max(...t.ws.map((w) => w.a)), b: Math.min(...t.ws.map((w) => w.b)) });
  const total = (t) => t.ws.reduce((s, w) => s + (w.it.cost || 0), 0);
  for (let pass = 0; pass < 6; pass++) {
    const byDay = new Map();
    for (const t of trips) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); }
    let moved = false;
    for (const [day, ts] of byDay) {
      const stores = new Set(ts.map((t) => t.store));
      if (stores.size < 2) continue;
      ts.sort((x, y) => total(y) - total(x));
      const keep = ts[0].store;
      for (const t of ts.filter((x) => x.store !== keep)) {
        const used = new Set(trips.filter((x) => x !== t && x.store !== t.store).map((x) => x.day));
        const r = rangeOf(t);
        // сначала — день, где этот магазин уже есть (сольются), затем любой свободный
        const same = trips.find((x) => x !== t && x.store === t.store && x.day >= r.a && x.day <= r.b && !used.has(x.day));
        if (same) { same.ws.push(...t.ws); trips = trips.filter((x) => x !== t); moved = true; continue; }
        const d = latestOpen(r.a, r.b, used);
        if (d != null) { t.day = d; moved = true; continue; }
        // целиком не переносится — раскладываем товары: в другой поход того же магазина, где позволяет свежесть,
        // иначе покупаем в магазине, куда и так идём (если продукт там продаётся)
        const rest = [];
        for (const w of t.ws) {
          const other = trips.find((x) => x !== t && x.store === t.store && x.day >= w.a && x.day <= w.b && !used.has(x.day));
          if (other) { other.ws.push(w); moved = true; continue; }
          const hosts = trips.filter((x) => x !== t && x.store !== t.store && x.day >= w.a && x.day <= w.b)
            .map((x) => ({ x, cost: altCost(w.it.key, x.store) })).filter((o) => o.cost != null)
            .sort((p, q) => p.cost - q.cost || (q.x.day === day) - (p.x.day === day)); // сначала дешевле
          if (hosts.length) {
            const { x, cost } = hosts[0];
            x.ws.push({ ...w, it: { ...w.it, store: x.store, cost, switchedFrom: w.it.store, extra: Math.round((cost - (w.it.cost || 0)) * 100) / 100 } });
            moved = true;
          } else rest.push(w);
        }
        t.ws = rest;
      }
      trips = trips.filter((t) => t.ws.length);
    }
    if (!moved) break;
  }

  // 3) меньше походов: маленький поход (до 3 товаров) отменяем, если его товары можно взять в других походах —
  //    там же, где позволяет свежесть, или раньше с заморозкой (мясо, фарш); доплата за всё — не больше maxExtra
  for (let changed = true; changed;) {
    changed = false;
    const small = trips.filter((t) => t.ws.length <= 3).sort((x, y) => total(x) - total(y));
    for (const t of small) {
      const moves = [];
      let extraSum = 0;
      for (const w of t.ws) {
        let best = null;
        for (const x of trips) {
          if (x === t) continue;
          const inWin = x.day >= w.a && x.day <= w.b;
          const frozen = !inWin && x.day >= firstDay && x.day < w.a && canFreeze(w.it.key);
          if (!inWin && !frozen) continue;
          const cost = x.store === w.it.store ? w.it.cost : altCost(w.it.key, x.store);
          if (cost == null) continue;
          const extra = cost - (w.it.cost || 0);
          const score = extra + (frozen ? 0.3 : 0);
          if (!best || score < best.score) best = { x, cost, extra, frozen, score };
        }
        if (!best) { extraSum = Infinity; break; }
        moves.push({ w, ...best });
        extraSum += Math.max(0, best.extra);
      }
      if (extraSum > maxExtra) continue;
      for (const m of moves) {
        const it = m.x.store === m.w.it.store ? { ...m.w.it } : { ...m.w.it, store: m.x.store, cost: m.cost, switchedFrom: m.w.it.switchedFrom || m.w.it.store, extra: Math.round(((m.w.it.extra || 0) + m.extra) * 100) / 100 };
        if (m.frozen) it.freezeUntil = m.w.b;
        m.x.ws.push({ ...m.w, it });
      }
      trips = trips.filter((x) => x !== t);
      changed = true;
      break;
    }
  }

  // одинаковые магазин+день сливаем
  const merged = new Map();
  for (const t of trips) {
    const k = t.store + '|' + t.day;
    if (merged.has(k)) { merged.get(k).ws.push(...t.ws); merged.get(k).early ||= t.early; } else merged.set(k, { ...t, ws: [...t.ws] });
  }
  return [...merged.values()]
    .map((t) => ({ day: t.day, store: t.store, early: t.early, items: t.ws.map((w) => (w.it.store === t.store ? w.it : { ...w.it, store: t.store })), total: Math.round(total(t) * 100) / 100 }))
    .sort((x, y) => x.day - y.day || y.total - x.total);
}
