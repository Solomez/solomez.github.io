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
 * У товара lateFor — день, к которому его не успеть купить (до него магазины закрыты).
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
  const firstOpenFrom = (d) => { for (let x = d; x < d + 14; x++) if (open(x)) return x; return d; };

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
      if (day == null) {
        // в окне свежести магазины закрыты: купить раньше (и заморозить), а если раньше уже нельзя —
        // в первый рабочий день после (к этому приёму пищи не успеть). Окно расширяем до этого дня,
        // чтобы дальше продукт можно было перекладывать только в походы, которые реально возможны.
        day = latestOpen(firstDay, w.a);
        if (day != null) { early = true; w.forcedUntil = w.b; w.a = day; } else {
          day = firstOpenFrom(w.b + 1);
          w.it = { ...w.it, lateFor: w.b };
          w.b = day;
        }
      }
      mine.push({ store, day, ws: [w], early });
    }
    trips.push(...mine);
  }

  // 2) разводим магазины по разным дням: меньший поход переносим на свободный день внутри общего окна
  const rangeOf = (t) => ({ a: Math.max(...t.ws.map((w) => w.a)), b: Math.min(...t.ws.map((w) => w.b)) });
  const total = (t) => t.ws.reduce((s, w) => s + (w.it.cost || 0), 0);
  // Развести один день: оставляем магазин keep, остальные походы этого дня переносим или раскладываем.
  // Работает на копии; возвращает новые походы, сколько товаров не удалось развести и доплату.
  const resolveDay = (src, day, keep) => {
    let all = src.map((t) => ({ ...t, ws: [...t.ws] }));
    let left = 0;
    let extra = 0;
    for (const t of all.filter((x) => x.day === day && x.store !== keep)) {
      const used = new Set(all.filter((x) => x !== t && x.store !== t.store).map((x) => x.day));
      const r = rangeOf(t);
      // сначала — день, где этот магазин уже есть (сольются), затем любой свободный
      const same = all.find((x) => x !== t && x.store === t.store && x.day >= r.a && x.day <= r.b && !used.has(x.day));
      if (same) { same.ws.push(...t.ws); all = all.filter((x) => x !== t); continue; }
      const d = latestOpen(r.a, r.b, used);
      if (d != null) { t.day = d; continue; }
      // целиком не переносится — раскладываем товары: в другой поход того же магазина, где позволяет свежесть,
      // иначе покупаем в магазине, куда и так идём (если продукт там продаётся)
      const rest = [];
      for (const w of t.ws) {
        const other = all.find((x) => x !== t && x.store === t.store && x.day >= w.a && x.day <= w.b && !used.has(x.day));
        if (other) { other.ws.push(w); continue; }
        const hosts = all.filter((x) => x !== t && x.store !== t.store && x.day >= w.a && x.day <= w.b)
          .map((x) => ({ x, cost: altCost(w.it.key, x.store) })).filter((o) => o.cost != null)
          .sort((p, q) => p.cost - q.cost || (q.x.day === day) - (p.x.day === day)); // сначала дешевле
        if (hosts.length) {
          const { x, cost } = hosts[0];
          const home = w.it.switchedFrom || w.it.store;
          const it = { ...w.it, store: x.store, cost };
          if (x.store === home) { delete it.switchedFrom; delete it.extra; } else { it.switchedFrom = home; it.extra = Math.round(((w.it.extra || 0) + cost - (w.it.cost || 0)) * 100) / 100; }
          extra += cost - (w.it.cost || 0);
          x.ws.push({ ...w, it });
        } else { rest.push(w); left++; }
      }
      t.ws = rest;
    }
    return { all: all.filter((t) => t.ws.length), left, extra };
  };
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    const days = [...new Set(trips.map((t) => t.day))].sort((x, y) => x - y);
    for (const day of days) {
      const ts = trips.filter((t) => t.day === day);
      if (new Set(ts.map((t) => t.store)).size < 2) continue;
      // какой магазин оставить в этот день: тот, при котором всё разводится, затем — дешевле, затем — больший поход
      const keeps = [...new Set(ts.sort((x, y) => total(y) - total(x)).map((t) => t.store))];
      let best = null;
      for (const keep of keeps) {
        const r = resolveDay(trips, day, keep);
        if (!best || r.left < best.left || (r.left === best.left && r.extra < best.extra - 0.01)) best = r;
      }
      const before = JSON.stringify(trips.map((t) => [t.store, t.day, t.ws.length]));
      trips = best.all;
      if (JSON.stringify(trips.map((t) => [t.store, t.day, t.ws.length])) !== before) moved = true;
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
        const home = m.w.it.switchedFrom || m.w.it.store; // магазин, где продукт выгоднее всего
        let it;
        if (m.x.store === m.w.it.store) it = { ...m.w.it };
        else if (m.x.store === home) { it = { ...m.w.it, store: home, cost: m.cost }; delete it.switchedFrom; delete it.extra; }
        else it = { ...m.w.it, store: m.x.store, cost: m.cost, switchedFrom: home, extra: Math.round(((m.w.it.extra || 0) + m.extra) * 100) / 100 };
        delete it.freezeUntil;
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
    if (merged.has(k)) merged.get(k).ws.push(...t.ws); else merged.set(k, { ...t, ws: [...t.ws] });
  }
  return [...merged.values()]
    .map((t) => ({
      day: t.day, store: t.store, early: t.ws.some((w) => w.forcedUntil != null),
      items: t.ws.map((w) => {
        const it = { ...w.it, store: t.store };
        // купили раньше срока свежести из-за выходных — мясо и фарш сразу в морозилку
        if (w.forcedUntil != null && it.freezeUntil == null && canFreeze(it.key) && t.day < w.forcedUntil - 1) it.freezeUntil = w.forcedUntil;
        return it;
      }),
      total: Math.round(total(t) * 100) / 100,
    }))
    .sort((x, y) => x.day - y.day || y.total - x.total);
}
