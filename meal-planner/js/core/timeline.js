// Таймлайн готовки: дорожки (рис, курица, соус…) идут параллельно, повар один — активные шаги не пересекаются,
// пассивные (варится под крышкой, в духовке) идут сами. Всё должно быть готово одновременно, поэтому
// расписание строится от конца: самая длинная дорожка начинается раньше (бурый рис ставят до того, как жарить курицу).
// Дорожка «finish» — после всех остальных (смешать, разложить, подать).

const mid = (r) => (r ? (r[0] + r[1]) / 2 : 0);
const lo = (r) => (r ? r[0] : 0);
const hi = (r) => (r ? r[1] : 0);

// steps: [{ track, time: { active: [a, b], passive: [a, b] } }] → { order, at: [{ start, activeEnd, end }], total }
// Связки внутри дорожки (шаг ставится сразу за предыдущим шагом своей дорожки, другие дорожки не вклиниваются):
//   attach — во время предыдущего: после его активной части (мясо в духовке — вымой руки), а у шага с огнём без
//            пассивной части («выложи и не трогай 2–3 минуты») — в его последние минуты;
//   glue   — сразу после конца предыдущего («обжарь специи — сразу добавляй следующий ингредиент»).
// opts.after: [{ step, then }] — активная часть шага step заканчивается до начала шага then (одна кастрюля:
//   воду для чая вскипятили и залили в кружку — кастрюля свободна, теперь в ней варят яйца).
export function schedule(steps, pick = mid, opts = {}) {
  const A0 = steps.map((s) => pick(s.time?.active));
  const P0 = steps.map((s) => pick(s.time?.passive));
  const A = [...A0];
  const P = [...P0];
  // блоки связанных шагов: root — первый шаг блока, off — сдвиг начала шага от начала блока
  const root = steps.map((_, i) => i);
  const off = steps.map(() => 0);
  const prevOf = {};
  steps.forEach((s, i) => {
    const t = s.track || 'main';
    if (t === 'finish' || s.background) return;
    const p = prevOf[t];
    prevOf[t] = i;
    if (p == null || !(s.attach || s.glue)) return;
    root[i] = root[p];
    // attach к шагу с огнём без пассивной части («выложи и не трогай 2–3 минуты») — в последние минуты этого шага
    const busyFire = steps[p].heat && !steps[p].oven && !(P0[p] > 0);
    off[i] = off[p] + (s.attach ? (busyFire ? Math.max(0, A0[p] - A0[i]) : A0[p]) : A0[p] + P0[p]);
  });
  const members = (r) => steps.map((_, i) => i).filter((i) => root[i] === r);
  steps.forEach((_, r) => {
    if (root[r] !== r) return;
    const ms = members(r);
    if (ms.length < 2) return;
    const a = Math.max(...ms.map((i) => off[i] + A0[i]));
    const e = Math.max(...ms.map((i) => off[i] + A0[i] + P0[i]));
    A[r] = a;
    P[r] = e - a;
  });
  const tracks = new Map();
  steps.forEach((s, i) => {
    const t = s.track || 'main';
    if (t === 'finish' || s.background || root[i] !== i) return;
    if (!tracks.has(t)) tracks.set(t, []);
    tracks.get(t).push(i);
  });
  const finish = steps.map((s, i) => i).filter((i) => (steps[i].track || 'main') === 'finish');
  const after = (opts.after || []).filter((c) => c.step >= 0 && c.then >= 0 && c.step !== c.then)
    .map((c) => ({ step: root[c.step], own: c.step, then: root[c.then], shift: off[c.then], full: !!c.full }));

  // от конца: время отсчитывается назад от начала «finish»
  const back = new Array(steps.length);
  const state = [...tracks.entries()].map(([name, list]) => ({ name, list, k: list.length - 1, avail: 0 }));
  const remaining = (st) => st.list.slice(0, st.k + 1).reduce((a, i) => a + A[i] + P[i], 0);
  let cook = 0;
  let free = false; // ограничения посуды не выполнить — дальше без них
  for (;;) {
    const ready = state.filter((st) => st.k >= 0);
    if (!ready.length) break;
    // шаг, чью активную часть можно поставить ближе всего к концу; при равенстве — дорожка длиннее
    let best = null;
    for (const st of ready) {
      const i = st.list[st.k];
      // посуда занята другой дорожкой: шаг step (содержимое ушло из посуды) — до начала шага then
      let bound = 0;
      let blocked = false;
      if (!free) {
        for (const c of after.filter((x) => x.step === i)) {
          if (!back[c.then]) blocked = true;
          // конец активной части шага (со сдвигом в блоке) ≤ начала шага then
          // full — посуда свободна только после всего шага (яйца остывают в кастрюле под струёй)
          else bound = Math.max(bound, back[c.then].activeTo - c.shift + off[c.own] + A0[c.own] + (c.full ? P0[c.own] : 0) - A[i]);
        }
      }
      if (blocked) continue;
      // шаг с огнём, после которого дорожка продолжается (довести до кипения → убавить огонь): следующий шаг
      // должен начаться ровно когда он закончится — иначе вода выкипит. Короткое действие (≤ 1 мин) повар делает
      // между другими делами, поэтому такой шаг не ждёт, пока освободятся руки
      const strict = (steps[i].heat || steps[i].oven) && P[i] > 0 && st.k < st.list.length - 1 && A[i] <= 1;
      const startActive = Math.max(bound, strict ? st.avail + P[i] : Math.max(st.avail + P[i], A[i] > 0 ? cook : 0));
      const key = [startActive, -remaining(st)];
      if (!best || key[0] < best.key[0] - 1e-9 || (Math.abs(key[0] - best.key[0]) < 1e-9 && key[1] < best.key[1])) best = { st, i, startActive, key };
    }
    if (!best) { free = true; continue; }
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
  // шаги блока — от начала блока со своим сдвигом и своим временем
  steps.forEach((_, i) => {
    const r = root[i];
    if (!at[r] || members(r).length < 2) return;
    const start = (i === r ? at[r].start : at[r].start + off[i]);
    at[i] = { start, activeEnd: start + A0[i], end: start + A0[i] + P0[i] };
  });
  steps.forEach((_, r) => { if (root[r] === r) { A[r] = A0[r]; P[r] = P0[r]; } });
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
export function timesOf(steps, opts = {}) {
  const m = schedule(steps, mid, opts);
  const a = schedule(steps, lo, opts);
  const b = schedule(steps, hi, opts);
  // chore — «вымой руки, нож и доску»: как и мытьё посуды, в «руками N мин» не входит (в общее время — входит)
  const own = steps.filter((x) => !x.chore);
  const active = own.reduce((s, x) => s + mid(x.time?.active), 0);
  return {
    total: Math.round(m.total),
    total_range: [Math.round(a.total), Math.round(b.total)],
    active: Math.round(active),
    active_range: [Math.round(own.reduce((s, x) => s + lo(x.time?.active), 0)), Math.round(own.reduce((s, x) => s + hi(x.time?.active), 0))],
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
