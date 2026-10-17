// Таймлайн готовки: дорожки (рис, курица, соус…) идут параллельно, повар один — активные шаги не пересекаются,
// пассивные (варится под крышкой, в духовке) идут сами. Всё должно быть готово одновременно, поэтому
// расписание строится от конца: самая длинная дорожка начинается раньше (бурый рис ставят до того, как жарить курицу).
// Дорожка «finish» — после всех остальных (смешать, разложить, подать).

const mid = (r) => (r ? (r[0] + r[1]) / 2 : 0);
const lo = (r) => (r ? r[0] : 0);
const hi = (r) => (r ? r[1] : 0);

// steps: [{ track, time: { active: [a, b], passive: [a, b] } }] → { order, at: [{ start, activeEnd, end }], total }
export function schedule(steps, pick = mid) {
  const A = steps.map((s) => pick(s.time?.active));
  const P = steps.map((s) => pick(s.time?.passive));
  const tracks = new Map();
  steps.forEach((s, i) => {
    const t = s.track || 'main';
    if (t === 'finish' || s.background) return;
    if (!tracks.has(t)) tracks.set(t, []);
    tracks.get(t).push(i);
  });
  const finish = steps.map((s, i) => i).filter((i) => (steps[i].track || 'main') === 'finish');

  // от конца: время отсчитывается назад от начала «finish»
  const back = new Array(steps.length);
  const state = [...tracks.entries()].map(([name, list]) => ({ name, list, k: list.length - 1, avail: 0 }));
  const remaining = (st) => st.list.slice(0, st.k + 1).reduce((a, i) => a + A[i] + P[i], 0);
  let cook = 0;
  for (;;) {
    const ready = state.filter((st) => st.k >= 0);
    if (!ready.length) break;
    // шаг, чью активную часть можно поставить ближе всего к концу; при равенстве — дорожка длиннее
    let best = null;
    for (const st of ready) {
      const i = st.list[st.k];
      // шаг с огнём, после которого дорожка продолжается (довести до кипения → убавить огонь): следующий шаг
      // должен начаться ровно когда он закончится — иначе вода выкипит. Короткое действие (≤ 1 мин) повар делает
      // между другими делами, поэтому такой шаг не ждёт, пока освободятся руки
      const strict = (steps[i].heat || steps[i].oven) && P[i] > 0 && st.k < st.list.length - 1 && A[i] <= 1;
      const startActive = strict ? st.avail + P[i] : Math.max(st.avail + P[i], A[i] > 0 ? cook : 0);
      const key = [startActive, -remaining(st)];
      if (!best || key[0] < best.key[0] - 1e-9 || (Math.abs(key[0] - best.key[0]) < 1e-9 && key[1] < best.key[1])) best = { st, i, startActive, key };
    }
    const { st, i, startActive } = best;
    const strictPick = (steps[i].heat || steps[i].oven) && P[i] > 0 && st.k < st.list.length - 1 && A[i] <= 1;
    // назад: [пассивная часть ближе к концу] [активная часть дальше]
    back[i] = { passiveFrom: startActive - P[i], activeFrom: startActive, activeTo: startActive + A[i] };
    if (A[i] > 0 && !strictPick) cook = startActive + A[i];
    else if (A[i] > 0) cook = Math.max(cook, startActive + A[i]);
    st.avail = startActive + A[i];
    st.k--;
  }
  const before = Math.max(0, ...back.filter(Boolean).map((b) => b.activeTo));
  const at = new Array(steps.length);
  steps.forEach((s, i) => {
    if (!back[i]) return;
    const b = back[i];
    at[i] = { start: before - b.activeTo, activeEnd: before - b.activeFrom, end: before - b.passiveFrom };
  });
  // «finish» — подряд после всех
  let t = before;
  for (const i of finish) {
    at[i] = { start: t, activeEnd: t + A[i], end: t + A[i] + P[i] };
    t += A[i] + P[i];
  }
  // фоновые шаги (разогрев духовки, вскипятить воду) — так, чтобы закончились к шагу, который их ждёт:
  // к следующему шагу с огнём в своей дорожке, а у духовки — к первому шагу с духовкой (в любой дорожке)
  let shift = 0;
  const bg = [];
  steps.forEach((s, i) => {
    if (!s.background) return;
    const own = s.track || 'main';
    const later = (j) => (steps[j].track || 'main') !== own || j > i;
    const cand = steps.map((x, j) => j).filter((j) => at[j] && !steps[j].background && later(j)
      && (s.oven ? steps[j].oven : (steps[j].track || 'main') === own && (steps[j].heat || steps[j].oven)));
    const target = cand.length ? Math.min(...cand.map((j) => at[j].start)) : t;
    bg.push([i, target]);
    shift = Math.max(shift, A[i] + P[i] - target);
  });
  // не успевает (духовка греется 10–15 мин, а ставить в неё через 5) — всё остальное сдвигается позже
  if (shift > 0) for (const x of at) if (x) { x.start += shift; x.activeEnd += shift; x.end += shift; }
  for (const [i, target] of bg) {
    const start = Math.max(0, target + Math.max(0, shift) - A[i] - P[i]);
    at[i] = { start, activeEnd: start + A[i], end: start + A[i] + P[i] };
  }
  t += Math.max(0, shift);
  const order = steps.map((_, i) => i).sort((x, y) => at[x].start - at[y].start || (at[x].end - at[y].end) || x - y);
  return { order, at, total: t };
}

// Время блюда: активное, пассивное, общее (с диапазоном)
export function timesOf(steps) {
  const m = schedule(steps, mid);
  const a = schedule(steps, lo);
  const b = schedule(steps, hi);
  const active = steps.reduce((s, x) => s + mid(x.time?.active), 0);
  return {
    total: Math.round(m.total),
    total_range: [Math.round(a.total), Math.round(b.total)],
    active: Math.round(active),
    active_range: [Math.round(steps.reduce((s, x) => s + lo(x.time?.active), 0)), Math.round(steps.reduce((s, x) => s + hi(x.time?.active), 0))],
    passive: Math.max(0, Math.round(m.total - active)),
    plan: m,
  };
}

// Что идёт параллельно, пока делается шаг i (пассивные части других дорожек): индексы шагов
export function runningDuring(plan, steps, i) {
  const s = plan.at[i];
  return steps.map((_, j) => j).filter((j) => j !== i && (steps[j].track || 'main') !== (steps[i].track || 'main')
    && plan.at[j].activeEnd <= s.start + 1e-9 && plan.at[j].end > s.start + 0.5);
}
