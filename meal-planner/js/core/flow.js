// Ход готовки поверх таймлайна (вызывается из compile.js; тексты — через шаблон tpl, поэтому работают при любом
// числе порций):
//   S39 — «сразу добавляй следующее»: следующий шаг дорожки идёт сразу, подготовка к нему — заранее;
//   S40 — посуда как ресурс: одна кастрюля и одна сковорода; две дорожки в одной посуде одновременно нельзя;
//   S13 — гигиена после сырого мяса: руки, нож, доска (и миска) — до первого шага с тем, что едят без готовки;
//   S37/S25 — после последнего шага с огнём выключить конфорку и духовку;
//   S38 — «можно отойти» только когда ни на одной конфорке нет огня под присмотром.
import { slotOf, slotId } from './cookbook.js';
import { DISH_OR, pickTools } from './equipment.js';

const isHeat = (s) => !!(s.heat || s.oven);
const lc = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
const hi = (r) => (Array.isArray(r) ? r[1] : r || 0);

// ---------- посуда ----------
// (\b в JS не видит границ кириллических слов — границы явно)
export const VESSEL_RE = { pot: /кастрюл|сотейник|ковш/, pan: /сковород|(^|[^а-яё])вок(?![а-яё])/ };
export const VESSEL_INS = { pot: 'кастрюлей', pan: 'сковородой' };
const VESSEL_ACC = { pot: 'кастрюлю', pan: 'сковороду' };
// первая упомянутая посуда для огня: «Поставь кастрюлю…», «Выложи в сковороду…»
export function vesselIn(text) {
  const l = lc(text);
  const hits = Object.entries(VESSEL_RE).map(([k, re]) => [k, l.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return hits[0]?.[0] || null;
}

// Посуда каждого шага с огнём: духовка; кастрюля или сковорода — по тексту, иначе как у предыдущего шага с огнём
// этой дорожки (блюдо продолжают в той же посуде), иначе по способу продукта
// Шаг без огня, который кладёт в посуду («Верни курицу в сковороду, добавь лапшу»), тоже говорит, где дальше греют
// (S37: сборка в сковороде после варки лапши в кастрюле — огонь под сковородой, а не под кастрюлей)
const INTO_VESSEL = /(верни|добавь|выложи|переложи|положи|влей|вылей|перелей|высыпь|всыпь|опусти|сложи)(?:[^.{]|\{[^}]*\})*?\s(в|на) (кастрюл|сотейник|ковш|сковород)/g;
export function intoVessel(text) {
  const all = [...lc(text).matchAll(INTO_VESSEL)];
  const m = all[all.length - 1];
  return m ? (/сковород/.test(m[3]) ? 'pan' : 'pot') : null;
}
export function assignVessels(steps, r, kitchen) {
  const last = {};
  for (const s of steps) {
    if (!isHeat(s)) {
      s.vessel = null;
      const v = intoVessel(s.text);
      if (v) last[s.track] = v;
      continue;
    }
    if (s.oven) { s.vessel = 'oven'; continue; }
    let v = vesselIn(s.text) || last[s.track] || null;
    if (!v && s.use) {
      const eq = kitchen?.profiles?.[slotOf(r, s.use)?.key]?.methods?.[r._methods?.[s.use]]?.equipment || [];
      v = eq.includes('pot') ? 'pot' : eq.includes('pan') ? 'pan' : null;
    }
    if (v) last[s.track] = v;
    s.vessel = v;
  }
}

// Содержимое уходит из посуды (заварили кипятком, откинули, переложили) — посуда свободна для другой дорожки
const RELEASE = /залей кипятком|откинь[^.]*(сито|дуршлаг)|переложи|выложи[^.]*(на|в) тарелк|налей[^.]*в (кружк|чашк|стакан)|разлей/;

// Дорожки, которые держат одну и ту же кастрюлю или сковороду в одно время: [{ v, a, b }].
// Дорожка держит посуду от первого шага с огнём в ней до шага, где содержимое уходит (rel: залили кипятком, откинули,
// переложили), а если такого нет — до своего последнего шага.
export function vesselConflicts(steps, plan) {
  const byTrack = {};
  steps.forEach((s, i) => { if ((s.track || 'main') !== 'finish' && plan.at[i]) (byTrack[s.track || 'main'] = byTrack[s.track || 'main'] || []).push(i); });
  const occ = [];
  for (const [track, idx] of Object.entries(byTrack)) {
    for (const v of ['pot', 'pan']) {
      const hs = idx.filter((i) => steps[i].vessel === v);
      if (!hs.length) continue;
      const first = hs.reduce((a, i) => (plan.at[i].start < plan.at[a].start ? i : a));
      const end = Math.max(...idx.map((i) => plan.at[i].end));
      const rel = idx.find((i) => !steps[i].background && !isHeat(steps[i]) && plan.at[i].start >= plan.at[first].start && RELEASE.test(lc(steps[i].text))) ?? null;
      // освобождает посуду в конце шага, если в нём ещё ждут (яйца 5 минут под холодной водой в кастрюле)
      const relEnd = rel == null ? end : hi(steps[rel].time?.passive) > 0 ? plan.at[rel].end : plan.at[rel].activeEnd;
      occ.push({ track, v, first, rel, from: plan.at[first].start, to: relEnd, end });
    }
  }
  const out = [];
  for (const a of occ) for (const b of occ) {
    if (a.track >= b.track || a.v !== b.v) continue;
    if (a.from < b.to - 0.5 && b.from < a.to - 0.5) out.push({ v: a.v, a, b });
  }
  return out;
}

// ---------- S21: жарка в занятой посуде ----------
// «Выложи X в разогретое масло», а в сковороде уже лук или фарш: мясо — «сдвинь лук к краю и на свободное место
// выложи», овощи — «добавь к луку». Что в посуде — по шагам с огнём этой дорожки; переложили на тарелку — посуда пуста.
const HOT_FAT = /(выложи|высыпь|добавь)( (?:[^.{]|\{[^}]*\})*?)? (в|на) (разогретое масло|разогретую сковороду( с маслом)?)/i;
const MEATY = new Set(['poultry', 'pork', 'beef', 'mince', 'cured']);
const SKIP_ROLES = /^(fat|spice|seasoning|herb|umami|acid|sweetener|flour|coating|condiment)$/;
export function occupiedPan(steps, r, kitchen) {
  const changed = [];
  const roleOf = (id) => kitchen?.profiles?.[slotOf(r, id)?.key]?.role || '';
  for (const t of [...new Set(steps.map((x) => x.track))]) {
    const inPan = { pan: [], pot: [] };
    for (const x of steps.filter((y) => y.track === t && !y.background)) {
      const l = lc(x.tpl);
      if (!isHeat(x)) {
        // переложили на тарелку / в миску — этого в посуде больше нет
        if (/переложи|выложи[^.]*(на тарелк|в миск)/.test(l)) {
          const ids = new Set(x.slots || []);
          for (const v of ['pan', 'pot']) inPan[v] = /(всё|все)/.test(l) ? [] : inPan[v].filter((id) => !ids.has(id));
        }
        continue;
      }
      const v = x.vessel;
      if (v !== 'pan' && v !== 'pot') continue;
      if (x.origin === 'act:heat_fat') { inPan[v] = []; continue; }
      const self = x.ctx?.self;
      const was = inPan[v].filter((id) => id !== self);
      const m = x.tpl.match(HOT_FAT);
      if (m && was.length && !/сдвин|поверх|к (луку|овощам)/.test(lc(x.text))) {
        const meat = MEATY.has(roleOf(self));
        const one = was.length === 1;
        const what = one ? `{n:${was[0]}.acc}` : `всё, что уже в ${v === 'pan' ? 'сковороде' : 'кастрюле'},`;
        x.tpl = x.tpl.replace(HOT_FAT, (all, verb, mid) => (meat
          ? `сдвинь ${what} к краю и на освободившееся место ${verb.toLowerCase()}${mid || ''}`
          : `добавь${mid || ''} ${one ? `к {n:${was[0]}.dat}` : 'к остальному'}`));
        x.tpl = x.tpl.replace(/^([а-яё])/, (c) => c.toUpperCase()).replace(/^(\{N:self\}:\s)([А-ЯЁ])/, (a, p, c) => p + c.toLowerCase());
        changed.push(x);
      }
      for (const id of [self, ...(x.slots || [])]) if (id && !SKIP_ROLES.test(roleOf(id)) && !inPan[v].includes(id)) inPan[v].push(id);
    }
  }
  return changed;
}

// ---------- S39: «сразу добавляй следующий ингредиент» ----------
const NOW = /сразу (добавляй|переходи|влей|вливай|всыпь|добавь|клади|выкладывай)|делай сразу/;
const zeroPassive = (s) => !(hi(s.time?.passive) > 0) && !s.time?.attended;
// Шаг требует сразу следующий — следующий шаг дорожки «приклеен» к нему (таймлайн не вклинивает другие дорожки).
// Подготовка следующего продукта (промыть, нарезать) не может ждать на горячем масле — она переезжает до начала
// цепочки шагов с огнём, к которой относится.
export function markGlue(steps) {
  const tracks = [...new Set(steps.filter((s) => s.track !== 'finish' && !s.background).map((s) => s.track))];
  for (const t of tracks) {
    for (let guard = 0; guard < 20; guard++) {
      const list = steps.filter((s) => s.track === t && !s.background);
      let moved = false;
      for (let k = 0; k < list.length - 1; k++) {
        const s = list[k];
        if (!NOW.test(lc(s.tpl)) || !zeroPassive(s)) continue;
        const next = list[k + 1];
        if (!isHeat(next) && next.kind === 'prep') {
          // начало цепочки: подряд идущие шаги с огнём (и связанные с ними) до s
          let c = k;
          while (c > 0 && (isHeat(list[c - 1]) || list[c].glue || NOW.test(lc(list[c - 1].tpl)))) c--;
          steps.splice(steps.indexOf(next), 1);
          steps.splice(steps.indexOf(list[c]), 0, next);
          moved = true;
          break;
        }
        next.glue = true;
      }
      if (!moved) break;
    }
  }
}

// ---------- S14: специи для шага в горячем масле — отмерить заранее ----------
// «Всыпь паприку и тмин в горячее масло… сразу» — искать банки, когда масло горит, нельзя. В последнем шаге подготовки
// своей дорожки перед этим — «отмерь … на блюдце и поставь у плиты»; если подготовки нет — в начале первого шага с огнём.
const SPICE_ACTS = new Set(['act:bloom_paprika', 'act:toast_spices']);
export function measureAhead(steps, r, kitchen, meat = new Set()) {
  // специи и соль — с мерой («1 чайную ложку паприки»), нарезанное заранее (чеснок) — просто названием
  const spoon = (id) => (kitchen?.measures?.[slotOf(r, id)?.key]?.kind === 'spoon');
  const changed = [];
  for (const b of steps.filter((s) => SPICE_ACTS.has(s.origin) && s.ctx?.with?.spices)) {
    const list = steps.filter((s) => s.track === b.track && !s.background);
    const k = list.indexOf(b);
    // шаг подготовки: до первого огня дорожки или нарезка из профиля (не «наклони сковороду», пока всё горячее)
    const fire = list.findIndex((s) => isHeat(s));
    // и не шаг с сырым мясом — руками после него банки со специями не берут
    const prep = list.slice(0, k).filter((s, j) => !isHeat(s) && !SPICE_ACTS.has(s.origin) && (fire < 0 || j < fire || s.kind === 'prep')
      && !(s.slots || []).some((id) => meat.has(id))).pop();
    const spices = String(b.ctx.with.spices).replace(/\{n:([\w-]+)\.acc\}/g, (m, id) => (spoon(id) ? `{q:${id}}` : m));
    if (prep && list.indexOf(prep) < k) {
      prep.tpl = `${prep.tpl.replace(/\s+$/, '')} Заодно положи на блюдце у плиты ${spices} — потом их всыпают в горячее масло без паузы.`;
      changed.push(prep);
    } else {
      const first = list.find((s) => isHeat(s)) || b;
      first.tpl = `Сначала положи на блюдце у плиты ${spices}. ${first.tpl}`;
      changed.push(first);
    }
  }
  return changed;
}

// ---------- S13: гигиена после сырого мяса ----------
export const RAW_ROLES = new Set(['poultry', 'pork', 'beef', 'mince']);
export function rawSlots(r, kitchen) {
  return new Set(r.ingredients.filter((i) => RAW_ROLES.has(kitchen?.profiles?.[i.key]?.role)).map(slotId));
}
// Шаги, где руками, ножом, доской, миской работают с сырым мясом: без огня до первого шага с огнём этого мяса
// и сам этот шаг (мясо выкладывают в сковороду или форму)
const KNIFE = /нарежь|разрежь|надрез|наруби|отбей|срежь|порежь/;
const PLACE = /выложи|уложи|положи|разложи|добавь|всыпь|опусти|клади|обваля/;
export function rawSteps(steps, ids) {
  const out = new Set();
  for (const id of ids) {
    const first = steps.findIndex((s) => isHeat(s) && !s.background && (s.slots || []).includes(id));
    steps.forEach((s, i) => {
      if (s.background || !(s.slots || []).includes(id)) return;
      // шаг с огнём — «сырой», только если в нём мясо кладут руками: «выложи», «уложи», «добавь»
      const puts = i === first && PLACE.test(lc(s.text));
      if (first < 0 ? !isHeat(s) : (i < first && !isHeat(s)) || puts) out.add(s);
    });
  }
  return out;
}

// В дорожке подряд идущие шаги без огня: сначала подготовка овощей, сыра, хлеба, потом сырое мясо — так доска и нож
// грязные только в конце подготовки
export function rawMeatLast(steps, ids) {
  if (!ids.size) return;
  const raw = rawSteps(steps, ids);
  // переставлять можно самостоятельную подготовку без мяса: шаг профиля другого продукта или шаг карточки со своими
  // продуктами («смешай соус из сметаны»); шаг без продуктов («оставь мариноваться») остаётся на месте
  // шаг, который продолжает мясную смесь («вмешай перец в массу», «разложи начинку»), — тоже не переставлять (S73/L:
  // иначе массу раскладывают раньше, чем её сделали в блендере)
  const MIX = /(^|[^а-яё])(масс|начинк|смес[ьи]|маринад)/;
  const movable = (s) => !raw.has(s) && !isHeat(s) && (s.slots || []).length > 0 && !(s.slots || []).some((id) => ids.has(id))
    && (s.use ? !ids.has(s.ctx?.self) : true) && !MIX.test(String(s.text || '').toLowerCase());
  const tracks = [...new Set(steps.map((s) => s.track))];
  for (const t of tracks) {
    if (t === 'finish') continue;
    const idx = steps.map((s, i) => i).filter((i) => steps[i].track === t && !steps[i].background);
    let run = [];
    const flush = () => {
      if (run.length > 1 && run.some((i) => raw.has(steps[i]))) {
        const firstRaw = run.findIndex((i) => raw.has(steps[i]));
        const before = run.slice(0, firstRaw).map((i) => steps[i]);
        const rest = run.slice(firstRaw).map((i) => steps[i]);
        const ordered = [...before, ...rest.filter(movable), ...rest.filter((s) => !movable(s))];
        run.forEach((i, k) => { steps[i] = ordered[k]; });
      }
      run = [];
    };
    for (const i of idx) {
      if (isHeat(steps[i])) flush();
      else run.push(i);
    }
    flush();
  }
}

// Куда продукт уходит готовиться: в форму, кастрюлю, сковороду, на противень
const INTO = /(влей|положи|добавь|высыпь|всыпь|выложи|залей|уложи|разложи|переложи)[^.]*\s(в|на) (форм|кастрюл|сковород|противен|противн)/;

// Где нужна гигиена: последний «сырой» шаг перед первым шагом с тем, что едят без готовки (овощи для салата, сыр,
// соус, хлеб, подача). Возвращает индексы «сырых» шагов, после которых вставить мытьё.
export function hygieneNeeds(steps, plan, ids) {
  if (!ids.size) return [];
  const raw = rawSteps(steps, ids);
  const pos = new Map(plan.order.map((i, p) => [i, p]));
  // моменты, когда продукт ещё будет готовиться: шаг с огнём с ним или «положи в форму» перед огнём своей дорожки
  const cookAt = {};
  steps.forEach((s, i) => {
    if (s.background || pos.get(i) == null) return;
    const into = !isHeat(s) && INTO.test(lc(s.text)) && steps.some((x, j) => j > i && x.track === s.track && isHeat(x));
    if (!isHeat(s) && !into) return;
    // «влей в форму» — продукт уходит готовиться в этом же шаге
    for (const id of s.slots || []) (cookAt[id] = cookAt[id] || []).push(pos.get(i) + (into ? 0.5 : 0));
  });
  // шаг способа после огня того же продукта (снять с огня, запарить, отдохнуть) — продукт ещё в своей посуде
  const heated = (s, p) => s.use && s.kind !== 'prep' && (cookAt[s.ctx?.self] || []).some((q) => q < p);
  const eaten = (s, p) => !isHeat(s) && !s.background && s.kind !== 'hygiene' && !raw.has(s)
    && ((s.track || 'main') === 'finish' || (!heated(s, p) && (s.slots || []).some((id) => !(cookAt[id] || []).some((q) => q > p))));
  // мясо нарезали или замариновали в миске в шаге R — в мытье будет «высыпай с тарелки / выкладывай ложкой»
  const cutBefore = (R) => !isHeat(steps[R]) && (KNIFE.test(lc(steps[R].text)) || /(в|из) миск/.test(lc(steps[R].text)));
  const needs = [];
  let dirty = null;
  let washed = false;
  plan.order.forEach((i, p) => {
    const s = steps[i];
    if (s.kind === 'hygiene') { dirty = null; washed = /не трогая руками|не руками/.test(lc(s.text)); return; }
    // мясо нарезали, переложили на тарелку и руки вымыли — в сковороду его высыпают с тарелки, руками не трогая
    if (raw.has(s) && isHeat(s) && washed && dirty == null) return;
    if (raw.has(s)) { dirty = i; return; }
    if (dirty != null && eaten(s, p)) { needs.push(dirty); washed = cutBefore(dirty); dirty = null; }
  });
  // дальше только подача (разложить, есть) — руки и доску всё равно вымыть
  if (dirty != null) needs.push(dirty);
  return needs;
}

// Шаг «вымой руки…»: что мыть — по тому, что делали с сырым мясом до этого места
export function hygieneStep(R, steps, ids) {
  const upto = steps.indexOf(R);
  const raw = [...rawSteps(steps, ids)].filter((x) => steps.indexOf(x) <= upto);
  const texts = raw.map((s) => lc(s.text));
  const r = lc(R.text);
  const knife = texts.some((t) => KNIFE.test(t));
  const before = steps.slice(0, upto + 1).filter((x) => x.track === R.track);
  const bowlUsed = texts.some((t) => /миск/.test(t)) || (texts.some((t) => /смес|паст|маринад|обмаж|обваля/.test(t)) && before.some((x) => /миск/.test(lc(x.text))));
  // мясо сейчас лежит в миске (замариновали) — миску мыть потом, когда освободится
  const inBowl = /(в|из) миск/.test(r);
  const later = !isHeat(R) && steps.some((x, j) => j > upto && isHeat(x) && (x.slots || []).some((id) => ids.has(id)));
  const items = ['руки', ...(knife ? ['нож', 'доску'] : []), ...(bowlUsed && !inBowl ? ['миску'] : [])];
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}` : items[0];
  const move = !later ? '' : inBowl ? 'Мясо из миски потом выкладывай ложкой или вилкой, не руками. '
    : KNIFE.test(r) ? 'Переложи нарезанное мясо с доски на тарелку — потом высыпай его с тарелки, не трогая руками. ' : '';
  const tail = [
    inBowl && steps.slice(upto + 1).some((x) => /миск/.test(lc(x.text))) ? 'Когда миска освободится, вымой и её, прежде чем мешать в ней что-то ещё.' : '',
    texts.some((t) => /блендер/.test(t)) ? 'Чашу блендера вымой так же, когда выложишь из неё массу.' : '',
  ].filter(Boolean).join(' ');
  const text = `${move}Вымой ${list} горячей водой с мылом — на них был сок сырого мяса.${tail ? ' ' + tail : ''}`;
  return {
    text, tpl: text, track: R.track, time: { active: [0.5, 1], passive: [0, 0] }, origin: 'engine:hygiene', kind: 'hygiene',
    ctx: { with: {} }, src: 'engine', use: null, slots: [], tools: [], attach: true, chore: true,
    why: 'сок сырого мяса и птицы переносит бактерии (сальмонелла, кампилобактер) на то, что едят без готовки',
  };
}

// ---------- S37 / S25: выключить огонь ----------
// «Сними с огня» навсегда — «выключи конфорку, сними с огня»; «сними с огня … верни на огонь» — не трогаем
const OFF_TPL = /(^|:\s|\.\s)([Сс])ними([^.]*?)с (огня|плиты)(?![^.]*верни)/;
const capFirst = (t) => t.replace(/^(\{[^}]+\}:\s)?([а-яё])/, (m, pre, ch) => `${pre || ''}${ch.toUpperCase()}`);
// «выключи» уже сказано (не в скобках «или выключи, если…» — это не команда)
// («выключи духовку» — не про конфорку)
const saysOff = (t) => /выключи/.test(lc(t).replace(/\([^)]*\)/g, '').replace(/выключи духовку/g, ''));
function addOff(s, word) {
  if (saysOff(s.tpl)) return false;
  if (OFF_TPL.test(s.tpl)) {
    // S25: куда поставить горячую посуду — на холодную конфорку или доску (электроплита ещё долго греет)
    s.tpl = s.tpl.replace(OFF_TPL, (m, pre, c, mid) => `${pre}${c === 'С' ? 'В' : 'в'}ыключи конфорку и переставь ${String(mid).trim() || VESSEL_ACC[s.vessel] || s._acc || 'посуду'} на соседнюю холодную конфорку или на доску (ручку бери прихваткой)`);
    return true;
  }
  if (word === 'prefix') {
    const m = s.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    // «затем {x:reserve}Слей…» — с маленькой буквы и после пустого параметра
    // шаг начинается с параметра ({x:reserve} → «зачерпни кружкой…») — после точки заглавная у самого параметра
    const x = !m && s.tpl.match(/^\{x:([^}]+)\}/);
    const v = x && s.ctx?.with?.[x[1]];
    if (typeof v === 'string' && /^[а-яё]/.test(v)) s.ctx = { ...s.ctx, with: { ...s.ctx.with, [x[1]]: v[0].toUpperCase() + v.slice(1) } };
    s.tpl = m ? `${m[1]}выключи конфорку, затем ${m[2][0].toLowerCase()}${m[2].slice(1)}` : capFirst(`Выключи конфорку под ${s._offVessel}. ${s.tpl}`);
    return true;
  }
  s.tpl = `${s.tpl.replace(/\s+$/, '')} Затем выключи конфорку.`;
  return true;
}

// ordered — шаги в порядке таймлайна (с at). Меняет tpl; возвращает изменённые шаги (их текст надо пересобрать)
export function heatOff(ordered, leftInOven = null) {
  const changed = new Set();
  const nextOf = (L) => {
    const k = ordered.indexOf(L);
    const sameTrack = ordered.slice(k + 1).find((x) => x.track === L.track && !x.background && !x.attach);
    if (sameTrack) return sameTrack;
    return L.ctx?.self ? ordered.slice(k + 1).find((x) => x.ctx?.self === L.ctx.self && !x.background) || null : null;
  };
  // плита: по каждой дорожке и посуде — последний шаг с огнём, если дальше эта посуда не продолжает греться
  const groups = new Map();
  // (вода, которая закипает сама, пока режут, — тоже огонь: его выключают, когда кипяток взяли)
  for (const s of ordered) if (s.heat && !s.oven && s.vessel) groups.set(`${s.track}|${s.vessel}`, s);
  for (const L of groups.values()) {
    const k = ordered.indexOf(L);
    // «выключи» уже сказано дальше в этой дорожке (кускус: «выключи огонь и сними посуду») — не дублируем
    if (ordered.slice(k + 1).some((x) => x.track === L.track && saysOff(x.tpl))) continue;
    // та же посуда греется дальше своей дорожкой или в подаче (соус → перемешать с пастой) — огонь не выключаем
    const cont = ordered.slice(k + 1).some((x) => x.heat && !x.oven && x.vessel === L.vessel && (x.track === L.track || x.track === 'finish') && x.at && L.at && x.at.start <= L.at.end + 3);
    if (cont) continue;
    // вода закипает сама и ждёт своего продукта (макароны в кипящую воду — шагом другой дорожки) — огонь нужен дальше
    if (L.background && ordered.slice(k + 1).some((x) => x.heat && !x.oven && x.vessel === L.vessel)) continue;
    if (OFF_TPL.test(L.tpl)) { if (addOff(L)) { changed.add(L); L.off_vessel = L.vessel; } continue; }
    const N = nextOf(L);
    // следующий шаг — со своим продуктом из этой посуды (слить, снять, перелить): выключить в нём; иначе — в конце L
    // (вскипятили воду — следующий шаг берёт кипяток из этой посуды: «раскроши в кипяток кубик»)
    if (N && !isHeat(N) && ((L.ctx?.self && N.ctx?.self === L.ctx.self) || RELEASE.test(lc(N.text)) || /(^|[^а-яё])слей(?![а-яё])/.test(lc(N.text)) || (/^act:(heat|boil)_water$/.test(L.origin) && /кипят/.test(lc(N.text))))) {
      N._offVessel = VESSEL_INS[L.vessel] || 'посудой';
      N._acc = VESSEL_ACC[L.vessel];
      if (addOff(N, 'prefix')) { changed.add(N); N.off_vessel = L.vessel; }
      delete N._offVessel;
      delete N._acc;
    } else if (addOff(L)) { changed.add(L); L.off_vessel = L.vessel; }
  }
  // духовка: в шаге, где достают форму, после последнего шага с духовкой
  const ovens = ordered.filter((s) => s.oven && !s.background);
  // последний по времени (картофель допекается после того, как курицу уже достали), а не по списку
  const Lo = ovens.reduce((a, x) => (!a || (x.at?.end ?? 0) >= (a.at?.end ?? 0) ? x : a), null);
  if (Lo && !ordered.some((x) => /выключи духовку/.test(lc(x.tpl)))) {
    // в чём запекается: последнее упоминание формы или противня в дорожке до этого шага
    const said = ordered.slice(0, ordered.indexOf(Lo) + 1).filter((x) => x.track === Lo.track).map((x) => lc(x.text).replace(DISH_OR, '')).join(' ');
    const last = (re) => Math.max(-1, ...[...said.matchAll(re)].map((m) => m.index));
    const what0 = last(/противен|противн/g) > last(/(^|[^а-яё])форм(а|у|е|ы|ой)(?![а-яё])/g) ? 'противень' : 'форму';
    // к концу в духовке несколько блюд (картофель на противне и котлеты в форме) — достать всё
    const all = [...new Set([what0, ...(leftInOven || [])])];
    const what = all.length > 1 ? `${all.join(' и ')}` : what0;
    // шаг после всех шагов с духовкой по списку (последний по времени может стоять в списке раньше): своей дорожки
    // или подача
    const k = Math.max(ordered.indexOf(Lo), ordered.indexOf(ovens[ovens.length - 1]));
    const N = ordered.slice(k + 1).find((x) => (x.track === Lo.track || (Lo !== ovens[ovens.length - 1] && x.track === 'finish')) && !x.background && !x.attach);
    if (N && !isHeat(N)) {
      const m = N.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
      // «достань» уже сказано (S15) — только выключить
      if (/достань[^.]*из духовки/.test(lc(N.tpl))) N.tpl = m ? `${m[1]}выключи духовку, затем ${m[2][0].toLowerCase()}${m[2].slice(1)}` : `Выключи духовку. ${N.tpl}`;
      else N.tpl = m ? `${m[1]}выключи духовку и достань ${what} прихватками, затем ${m[2][0].toLowerCase()}${m[2].slice(1)}` : `Выключи духовку и достань ${what} прихватками. ${N.tpl}`;
      changed.add(N);
    } else {
      Lo.tpl = `${Lo.tpl.replace(/\s+$/, '')} Когда будет готово — выключи духовку и достань ${what} прихватками.`;
      changed.add(Lo);
    }
  }
  return [...changed];
}

// ---------- S15: горячая форма в духовку и из неё ----------
// Достать посреди запекания (добавить сыр, перевернуть, полить глазурью): открыть дверцу и отступить (пар), сухими
// прихватками на выключенную конфорку или доску, не на стол; вернуть на ту же полку — таймер с этого момента.
// Блюдо уходит из духовки (переложить на тарелку, дать отдохнуть) — «достань из духовки». Что ещё стоит в духовке
// к концу — возвращается (последнее достаёт шаг «выключи духовку», heatOff).
const MITTS = '{t:mitts|сухими прихватками|сухим кухонным полотенцем, сложенным в несколько слоёв (мокрое пропускает жар)}';
const outText = (what, hasTool) => pickTools(`Открой дверцу и отступи на 2–3 секунды — выйдет пар. Достань ${what} ${MITTS} и поставь на выключенную конфорку или доску, не на стол.`, hasTool);
const backText = (what) => `Верни ${what === 'хлебец' ? 'его' : what} на ту же полку и закрой дверцу — таймер с этого момента.`;
const dishOf = (t) => (/противен|противн/.test(lc(t).replace(DISH_OR, '')) ? 'противень' : 'форму');
const lowFirst = (t) => t.replace(/^([А-ЯЁ])/, (c) => c.toLowerCase());
export function ovenMoves(ordered, hasTool = () => true) {
  const changed = new Set();
  const capFirstBody = (t) => t.replace(/^([а-яё])/, (c) => c.toUpperCase());
  const prefix = (x, text) => {
    const m = x.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    x.tpl = m ? `${m[1]}${lowFirst(text)} ${capFirstBody(m[2])}` : `${text} ${x.tpl}`;
  };
  // «и запекай» → «, верни форму на ту же полку, закрой дверцу и запекай»; иначе — фразой в конце
  const addBack = (x, what) => {
    const b = backText(what);
    if (/(,)? и запекай/.test(x.tpl)) x.tpl = x.tpl.replace(/(,)? и запекай/, `, ${lowFirst(b).replace(/ — таймер с этого момента\.$/, '')} и запекай`);
    else x.tpl = `${x.tpl.replace(/\s+$/, '')} ${b}`;
  };
  // что стоит в духовке по дорожкам: { what, at } — в порядке шагов
  const inOven = new Map();
  // S16: перед тем как ставить первую форму — взглянуть на индикатор нагрева
  const pre = ordered.find((x) => x.background && x.oven);
  const first = ordered.find((x) => x.oven && !x.background);
  if (pre && first && !/индикатор/.test(lc(first.tpl))) {
    const ind = 'Взгляни на индикатор нагрева: погас — духовка нагрелась (горит — подожди пару минут, в холодную не ставь).';
    const m = first.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    first.tpl = m ? `${ind} ${m[1]}${m[2]}` : `${ind} ${first.tpl}`;
    changed.add(first);
  }
  for (const x of ordered) {
    if (x.background || x.kind === 'mise') continue;
    const l = lc(x.tpl);
    if (x.oven) {
      let st = inOven.get(x.track);
      // подача (finish) добавляет сверху к блюду из другой дорожки (сыр на роллы) — это то же блюдо
      if (!st && x.track === 'finish' && inOven.size) {
        const [t0, st0] = [...inOven.entries()].pop();
        inOven.delete(t0);
        st = st0;
      }
      if (!st) {
        const what = dishOf(x.text);
        inOven.set(x.track, { what });
        // форму ставят в духовку — если шаг сам не говорит, как (S15)
        if (!/постав|верни|задвинь/.test(l)) {
          const put = pickTools(`открой дверцу, ${MITTS} поставь ${what} на решётку в середине духовки, закрой дверцу`, hasTool);
          x.tpl = /(,)? и запекай/.test(x.tpl) ? x.tpl.replace(/(,)? и запекай/, `, ${put} и запекай`) : `${x.tpl.replace(/\s+$/, '')} ${put[0].toUpperCase()}${put.slice(1)}.`;
          changed.add(x);
        }
        continue;
      }
      inOven.set(x.track, st);
      const what = st.what;
      const body = l.replace(/^\{n:self\}:\s*/, '');
      if (/достань|выдвини/.test(l)) {
        if (!/прихватк|полотенц/.test(l)) {
          x.tpl = x.tpl.replace(/([Дд])остань (форму|противень|хлебец)/, (all, d, w) => `${d === 'Д' ? 'О' : 'о'}ткрой дверцу и отступи на 2–3 секунды — выйдет пар. Достань ${w} ${pickTools(MITTS, hasTool)} и поставь на выключенную конфорку`);
          changed.add(x);
        }
        if (!/верни|задвинь/.test(lc(x.tpl))) { addBack(x, what); changed.add(x); }
      } else if (!/^(запекай|продолжай)/.test(body)) {
        // добавить что-то посреди запекания — достать, добавить, вернуть
        addBack(x, what);
        prefix(x, outText(what, hasTool));
        changed.add(x);
      }
      continue;
    }
    const st = inOven.get(x.track);
    if (!st || x.attach || x.during || x.kind === 'hygiene' || x.chore) continue;
    // блюдо уходит из духовки
    if (!/достань/.test(l)) {
      prefix(x, pickTools(`Достань ${st.what} из духовки ${MITTS} и поставь на выключенную конфорку или доску, не на стол.`, hasTool));
      changed.add(x);
    } else if (!/прихватк|полотенц/.test(l)) {
      x.tpl = x.tpl.replace(/([Дд]остань) (форму|противень|хлебец)/, (all, d, w) => `${d} ${w} из духовки ${pickTools(MITTS, hasTool)}`);
      changed.add(x);
    }
    inOven.delete(x.track);
  }
  return { changed: [...changed], left: [...inOven.values()].map((x) => x.what) };
}

// ---------- S38: «можно отойти» ----------
// Огонь под присмотром: жарка, закипание, «помешивая», средне-сильный и сильный огонь
export const attendedFire = (x) => !!x.heat && !x.oven && !x.background
  && (!!x.time?.attended || !(hi(x.time?.passive) > 0) || x.heat === 'сильный' || x.heat === 'средне-сильный'
    || /помешива|переворач|до кипения|мешай/.test(lc(x.text).replace(/не (мешай|трогай)/g, '')));
export function markLeave(ordered) {
  for (const s of ordered) {
    if (!(hi(s.time?.passive) > hi(s.time?.active)) || s.time?.attended || !s.at) continue;
    const others = ordered.filter((x) => x !== s && x.at && x.at.start < s.at.end - 0.01 && x.at.end > s.at.start + 0.01 && attendedFire(x));
    const own = attendedFire(s);
    s.leave = !own && !others.length;
    if (!s.leave) {
      const v = (own ? s : others[0]).vessel;
      s.watch = VESSEL_INS[v] || 'плитой';
    }
  }
}

// ---------- S43 / S32: подготовка до огня ----------
// Подготовка — шаг без огня, где режут, чистят, моют, открывают, смешивают холодное. Её место — до включения огня
// или в окне, когда на огне что-то идёт само (варится под крышкой, в духовке): тогда шаг говорит «Пока …».
const PREP_RE = /^(\{n:[\w-]+\}:?\s*)?(срежь|очисти|почисть|нарежь|наруби|порежь|разрежь|натри|настругай|раздави|прижми|вымой|промой|насыпь .* (в дуршлаг|в сито)|обсуши|промокни|открой|порви|раскроши|сделай .*надрез|в миске (смешай|размешай)|смешай|размешай|отожми)/;
// кладут в посуду для огня («выложи в сковороду», «влей в форму») — это не подготовка; «промой в кастрюле» — подготовка
const INTO_HOT = /(в|на) (разогрет|горяч)|(в|на) (сковороду|кастрюлю|противень|форму)(?![а-яё])/;
const stripSelf = (t) => lc(String(t || '').replace(/^\{N:self\}:\s*/, '')).replace(/^пока [^,]*, /, '');
export const isPrepStep = (s) => !isHeat(s) && !s.background && s.kind !== 'hygiene' && s.kind !== 'mise' && (s.track || 'main') !== 'finish'
  && (s.kind === 'prep' || PREP_RE.test(stripSelf(s.tpl))) && !INTO_HOT.test(lc(s.text));
// Огонь, у которого стоят: жарка «помешивая» (руки заняты не всё время, но отходить нельзя), шаг с огнём без
// пассивной части. Нарезать в это время — нельзя: подготовка переезжает до начала огня этой дорожки.
export const busyFire = (x) => !!x.heat && !x.oven && !x.background && (!!x.time?.attended || !(hi(x.time?.passive) > 0));

// В дорожке подготовка после шага с огнём: если перед ней огонь идёт сам (варится под крышкой, в духовке) —
// она идёт во время этого шага (attach, «Пока …»); иначе — переезжает до начала цепочки шагов с огнём.
export function prepBeforeFire(steps) {
  const tracks = [...new Set(steps.filter((s) => (s.track || 'main') !== 'finish' && !s.background).map((s) => s.track))];
  for (const t of tracks) {
    for (let guard = 0; guard < 30; guard++) {
      const list = steps.filter((s) => s.track === t && !s.background);
      let moved = false;
      for (let k = 1; k < list.length; k++) {
        const P = list[k];
        if (!isPrepStep(P) || P.attach || P.glue) continue;
        const H = list.slice(0, k).reverse().find((x) => isHeat(x));
        if (!H) continue;
        const prev = list[k - 1];
        if (prev === H && hi(H.time?.passive) > 0 && !H.time?.attended && !busyFire(H)) { P.attach = true; P.during = true; continue; }
        // начало цепочки: подряд идущие шаги с огнём и то, что кладут в посуду между ними
        let c = k - 1;
        while (c > 0 && !isPrepStep(list[c - 1])) c--;
        if (c === k - 1 && !isHeat(list[c])) continue;
        steps.splice(steps.indexOf(P), 1);
        steps.splice(steps.indexOf(list[c]), 0, P);
        moved = true;
        break;
      }
      if (!moved) break;
    }
  }
}

// Подготовка одной дорожки попала на жарку другой — ограничение таймлайну: подготовка до начала огня той дорожки
export function prepClashes(steps, plan) {
  const out = [];
  steps.forEach((P, i) => {
    if (!isPrepStep(P) || P.during || !plan.at[i]) return;
    const a = plan.at[i];
    steps.forEach((F, j) => {
      if (j === i || F.track === P.track || !busyFire(F) || !plan.at[j]) return;
      const f = plan.at[j];
      if (!(f.start < a.activeEnd - 0.01 && f.end > a.start + 0.01)) return;
      const first = steps.findIndex((x) => x.track === F.track && isHeat(x) && !x.background);
      if (first >= 0) out.push({ step: P, then: steps[first] });
    });
  });
  return out;
}

// Что идёт само, пока режут: «Пока рис на огне», «Пока куриные голени в духовке», «Пока греется духовка»
const VESSEL_NOM = { pot: 'кастрюля', pan: 'сковорода' };
function runningName(x, r, kitchen) {
  if (x.background && x.oven) return 'греется духовка';
  const ing = x.ctx?.self ? slotOf(r, x.ctx.self) : null;
  const name = ing ? (kitchen?.measures?.[ing.key]?.ru?.nom || ing.name_ru || '').toLowerCase() : '';
  if (x.oven) return name ? `${name} в духовке` : 'форма в духовке';
  if (/доведи до кипения|закипит|вскипяти/.test(lc(x.text)) && !name) return `закипает вода`;
  return name ? `${name} на огне` : `${VESSEL_NOM[x.vessel] || 'посуда'} на огне`;
}
// ordered — шаги в порядке таймлайна (с at). Подготовка после начала огня, пока на огне что-то идёт само, — «Пока …»
export function markWhile(ordered, r, kitchen) {
  // огонь — плита или духовка с продуктом (разогрев пустой духовки — нет: до него режут спокойно)
  const fire = ordered.filter((s) => isHeat(s) && !s.background && s.at);
  if (!fire.length) return [];
  const f0 = Math.min(...fire.map((s) => s.at.start));
  const changed = [];
  let last = null;
  for (const P of ordered) {
    if (!isPrepStep(P) || !P.at || P.at.start < f0 - 0.01 || /^(\{n:self\}:\s*)?пока /.test(lc(P.tpl))) continue;
    const run = ordered.filter((x) => x !== P && isHeat(x) && x.at && x.at.start < P.at.start + 0.01 && x.at.end > P.at.start + 0.5);
    if (!run.length) continue;
    const R = run.reduce((a, x) => (x.at.end > a.at.end ? x : a));
    const what = runningName(R, r, kitchen);
    // подряд несколько шагов подготовки в том же окне — «Пока …» только у первого
    const k = ordered.indexOf(P);
    if (last && last.what === what && ordered.slice(last.k + 1, k).every((x) => isPrepStep(x) || x.kind === 'hygiene')) { last.k = k; continue; }
    last = { what, k };
    const m = P.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    const body = (m ? m[2] : P.tpl).replace(/^\{N:/, '{n:');
    const low = body.replace(/^([А-ЯЁ])/, (c) => c.toLowerCase());
    P.tpl = m ? `${m[1]}пока ${what}, ${low}` : `Пока ${what}, ${low}`;
    changed.push(P);
  }
  return changed;
}

// Куда класть нарезанное (S32): «Сложи на тарелку — понадобится в шаге N»; продукты, которые идут в посуду одним
// шагом, — на одну тарелку. Сырое мясо — отдельно (об этом говорит шаг гигиены). → число тарелок
const CUT_RE = /нарежь|наруби|порежь|разрежь|натри|настругай|поруби|раздави/;
// «положи на доску боком» — как резать, а не куда класть нарезанное
const PUT_RE = /переложи|сложи|отложи|положи (на тарелк|в миск|в форм|на хлеб)|в миск|на тарелк|по тарелк|кучк|прямо в /;
export function placeCut(ordered, meat, hasBowl, refs = (x) => x.slots || []) {
  const groups = new Map();
  let n = 0;
  for (const P of ordered) {
    if (!isPrepStep(P) || !CUT_RE.test(lc(P.text)) || PUT_RE.test(lc(P.text))) continue;
    const ids = (P.slots || []).filter((id) => !meat.has(id));
    if (!ids.length || (P.slots || []).some((id) => meat.has(id))) continue;
    const k = ordered.indexOf(P);
    const U = ordered.slice(k + 1).find((x) => x.kind !== 'mise' && refs(x).some((id) => ids.includes(id)));
    if (!U) continue;
    const at = ordered.indexOf(U) + 1;
    // нужен сразу в следующем шаге — класть некуда и незачем
    if (at === k + 2) continue;
    const g = groups.get(U);
    if (g) P.tpl = `${P.tpl.replace(/\s+$/, '')} Сложи туда же, где {n:${g}.nom} — понадобится в шаге ${at}.`;
    else {
      n++;
      groups.set(U, ids[0]);
      P.tpl = `${P.tpl.replace(/\s+$/, '')} Сложи ${hasBowl ? 'в миску или на тарелку' : 'на тарелку или кучкой на край доски'} — понадобится в шаге ${at}.`;
    }
  }
  return n;
}

// ---------- S43: шаг «Достань и отмерь» перед огнём ----------
// Что понадобится у плиты (продукт впервые нужен в шаге с огнём или между ними, а не нарезается заранее):
// специи — на блюдце (по шагам), жидкости — отмерить, консервы — открыть, остальное — достать. Плюс куда класть
// нарезанное и какую посуду поставить. Количества — подстановками (при любом числе порций).
const LIQ = /^(water|stock(?!_cube)|broth|milk|cream|cooking_cream|coconut_milk|passata|soy_sauce|vinegar|lemon_juice|wine|kefir)/;
const CAN = /_can$|^tomatoes_can|canned/;
const FAT = /oil|butter|ghee|lard/;
const joinRu = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : xs[0] || '');
export function miseStep(ordered, r, kitchen, { meat = new Set(), hasTool = () => false, plates = 0, refs = (x) => x.slots || [], fracOf = () => 1 } = {}) {
  const firstFire = ordered.findIndex((s) => isHeat(s) && !s.background);
  if (firstFire < 0) return null;
  const chainOf = (s) => {
    const list = ordered.filter((x) => x.track === s.track && !x.background);
    const k = list.indexOf(s);
    return list.slice(0, k).some((x) => isHeat(x));
  };
  const firstHeat = new Set();
  for (const s of ordered) if (isHeat(s) && !s.background && !ordered.some((x) => x !== s && x.track === s.track && isHeat(x) && !x.background && ordered.indexOf(x) < ordered.indexOf(s))) firstHeat.add(s);
  const spice = new Map();
  const toMeasure = [];
  const toOpen = [];
  const toGet = [];
  const fats = [];
  let loose = false;
  for (const ing of r.ingredients) {
    const id = slotId(ing);
    if (meat.has(id)) continue;
    const k = ordered.findIndex((s) => s.kind !== 'mise' && refs(s).includes(id));
    if (k < 0) continue;
    const U = ordered[k];
    // нарезают, моют, открывают заранее — на тарелке; не у плиты (салат, подача) — не нужно
    if (isPrepStep(U) || (!isHeat(U) && !chainOf(U))) continue;
    const m = kitchen?.measures?.[ing.key] || {};
    // большая вода для варки (налить в кастрюлю в начале) — не отмеривать заранее
    if (ing.key === 'water' && (ing.grams || 0) > 600) continue;
    if (firstHeat.has(U) && ing.key === 'water') continue;
    if (ing.text) { loose = true; continue; }
    if (FAT.test(ing.key) || (m.kind === 'spoon' && (LIQ.test(ing.key) || m.liquid))) fats.push(`{n:${id}.acc}`);
    else if (m.kind === 'spoon' || (m.kind === 'pinch')) {
      // по шагам у плиты — та часть, что идёт в этот шаг («половину чайной ложки соли»)
      ordered.forEach((x, j) => {
        if (x.kind === 'mise' || !(isHeat(x) || chainOf(x)) || isPrepStep(x)) return;
        const f = fracOf(x, id);
        if (f == null) return;
        spice.set(j + 1, [...(spice.get(j + 1) || []), f < 0.999 ? `{q:${id}*${Math.round(f * 100) / 100}}` : `{q:${id}}`]);
      });
    } else if (CAN.test(ing.key)) toOpen.push(`{q:${id}}`);
    else if (LIQ.test(ing.key) || m.liquid) toMeasure.push(`{q:${id}}`);
    else toGet.push(`{q:${id}}`);
  }
  const oven = ordered.slice(0, firstFire).some((s) => s.background && s.oven) || (ordered[0]?.background && ordered[0]?.oven);
  const stove = ordered.some((s) => s.heat && !s.oven && !s.background);
  const parts = [`${oven ? 'Пока духовка греется' : 'Пока огонь не включён'}, достань и отмерь всё, что понадобится ${stove ? 'у плиты' : 'по ходу'}, — потом искать будет некогда.`];
  const bySteps = [...spice.entries()].sort((a, b) => a[0] - b[0]);
  if (bySteps.length === 1) parts.push(`На блюдце отмерь ${joinRu(bySteps[0][1])} — для шага ${bySteps[0][0]}.`);
  else if (bySteps.length > 1) parts.push(`На блюдца по шагам отмерь: ${bySteps.map(([at, xs]) => `для шага ${at} — ${joinRu(xs)}`).join('; ')}.`);
  if (loose) parts.push('Соль и перец поставь рядом.');
  if (fats.length) parts.push(`Поставь ${stove ? 'у плиты' : 'рядом'} ${joinRu([...fats, 'столовую ложку'])}.`);
  if (toMeasure.length) parts.push(`Отмерь в кружки или стаканы ${joinRu(toMeasure)}.`);
  if (toOpen.length) parts.push(`Открой ${joinRu(toOpen)}.`);
  if (toGet.length) parts.push(`Достань ${joinRu(toGet)}.`);
  const bowl = hasTool('bowl');
  if (plates) parts.push(`Для нарезанного приготовь ${plates === 1 ? 'тарелку' : plates < 5 ? `${plates} тарелки` : `${plates} тарелок`}${bowl ? ' или миски' : ' (или складывай кучками на край доски)'}${meat.size ? ', сырое мясо — на отдельную' : ''}.`);
  else if (ordered.some((s) => isPrepStep(s) && CUT_RE.test(lc(s.text)))) parts.push(`Нарезанное складывай ${bowl ? 'в миски или на тарелки' : 'на тарелки или кучками на край доски'}${meat.size ? ', сырое мясо — отдельно' : ''}.`);
  const vs = [...new Set(ordered.filter((s) => s.vessel === 'pot' || s.vessel === 'pan').map((s) => s.vessel))];
  const dish = ordered.some((s) => s.oven && !s.background);
  const put = [...vs.map((v) => VESSEL_NOM[v]), ...(dish ? ['форму или противень'] : [])];
  if (put.length) parts.push(`Приготовь ${joinRu([...put.map((x) => x.replace(/^кастрюля$/, 'кастрюлю').replace(/^сковорода$/, 'сковороду')), 'прихватки'])}.`);
  const tpl = parts.join(' ');
  return {
    text: tpl, tpl, track: ordered[firstFire].track, time: { active: [1, 3], passive: [0, 0] }, origin: 'engine:mise', kind: 'mise',
    ctx: { with: {} }, src: 'engine', use: null, slots: [], tools: [], chore: true,
    why: 'когда масло уже горячее, искать банки и отмерять ложкой некогда — что-то подгорит',
  };
}

// ---------- S48: смена огня словами ----------
// Огонь под той же посудой отличается от прошлого шага — первая фраза шага говорит, что сделать с ручкой плиты:
// «Убавь огонь под сковородой до среднего», «Прибавь огонь до сильного и подожди минуту». Конфорку выключили —
// «Поставь сковороду на средний огонь». Две посуды на плите — посуда названа (и в плашке огня: heat_where).
// Духовка: температура другая, чем у прошлого шага с духовкой, — «Переключи духовку на 190 °C».
const LEVEL = { 'слабый': 1, 'средне-слабый': 2, 'средний': 3, 'средне-сильный': 4, 'сильный': 5 };
const HEAT_GEN = { 'слабый': 'слабого', 'средне-слабый': 'средне-слабого', 'средний': 'среднего', 'средне-сильный': 'средне-сильного', 'сильный': 'сильного' };
const HEAT_ACC = { 'слабый': 'слабый', 'средне-слабый': 'средне-слабый', 'средний': 'средний', 'средне-сильный': 'средне-сильный', 'сильный': 'сильный' };
// шаг сам говорит, что делать с огнём
const SAYS_HEAT = /убав|прибав|увелич|уменьш|(постав|верни)[^.]*(на|огонь)[^.]*(слаб|средн|сильн)|огонь\s*—|включи (огонь|конфорку)/;
// шаг сам ставит посуду на огонь («доведи до кипения на сильном огне», «поставь на средний огонь»)
const SAYS_ON = /на (средне-)?(слаб|средн|сильн)\S* огн|на огонь|включи/;
export function heatShift(ordered) {
  const changed = new Set();
  const stove = (s) => s.heat && !s.oven && !s.background && (s.vessel === 'pot' || s.vessel === 'pan');
  const two = new Set(ordered.filter(stove).map((s) => s.vessel)).size > 1;
  const last = {};
  let lastOven = null;
  const up1 = (t) => t.replace(/^([а-яё])/, (c) => c.toUpperCase());
  // шаг начинается с параметра ({x:salt} → «посоли кипящую воду…») — заглавная у самого параметра
  const upTpl = (s, t) => {
    const x = t.match(/^\{x:([^}]+)\}/);
    const v = x && s.ctx?.with?.[x[1]];
    if (typeof v === 'string' && /^[а-яё]/.test(v)) s.ctx = { ...s.ctx, with: { ...s.ctx.with, [x[1]]: up1(v) } };
    return up1(t);
  };
  const prefix = (s, text) => {
    const m = s.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    s.tpl = m ? `${m[1]}${text[0].toLowerCase()}${text.slice(1)} ${upTpl(s, m[2])}` : `${text} ${upTpl(s, s.tpl)}`;
    changed.add(s);
  };
  const ovenOn = (s) => s.oven && !s.background && s.at;
  // S37: конфорку под посудой выключили (heatOff: off_vessel; или шаг сам говорит «выключи») — следующий шаг с огнём
  // в этой посуде начинается с «Включи конфорку под сковородой на средний огонь», даже если огонь тот же
  // (две дорожки в «одной» посуде одновременно — это вторая кастрюля: её огонь не тот же)
  const off = {};
  const trackVessel = {};
  const use = { pot: {}, pan: {} };
  const moved = {};
  for (const s of ordered) {
    const offHere = s.off_vessel || (saysOff(s.tpl) && !s.oven ? (stove(s) ? s.vessel : trackVessel[s.track]) : null);
    const o = stove(s) ? off[s.vessel] : null;
    if (o) {
      const mine = use[s.vessel][s.track];
      const theirs = use[s.vessel][o.track];
      const second = o.track !== s.track && mine && theirs && mine.to > theirs.from + 0.5 && theirs.to > mine.from + 0.5;
      off[s.vessel] = null;
      if (!second && !SAYS_HEAT.test(lc(s.text)) && !SAYS_ON.test(lc(s.text)) && LEVEL[s.heat]) {
        prefix(s, `Включи конфорку под ${VESSEL_INS[s.vessel]} на ${HEAT_ACC[s.heat]} огонь.`);
        if (two) s.heat_where = VESSEL_INS[s.vessel];
      }
      if (!second) last[s.vessel] = s;
    }
    if (stove(s) && s.at) {
      trackVessel[s.track] = s.vessel;
      const u = (use[s.vessel][s.track] ||= { from: s.at.start, to: s.at.end });
      u.to = Math.max(u.to, s.at.end);
    }
    if (offHere && (offHere === 'pot' || offHere === 'pan')) off[offHere] = { track: s.track };
    // «Сними сковороду с огня на минуту» (вмешать сметану) — следующий шаг с огнём возвращает её на конфорку
    const away = !stove(s) && /сними \S+ с огня на минуту/.test(lc(s.tpl)) && !/верни/.test(lc(s.tpl)) ? trackVessel[s.track] : null;
    if (away) moved[away] = true;
    if (stove(s) && moved[s.vessel]) {
      moved[s.vessel] = false;
      if (!/верни/.test(lc(s.text))) { s._back = `Верни ${VESSEL_ACC[s.vessel]} на конфорку.`; }
    }
    if (o && last[s.vessel] === s) { if (two) s.heat_where = VESSEL_INS[s.vessel]; continue; }
    if (ovenOn(s)) {
      // в духовке уже стоит другое блюдо на другой температуре — одна духовка: не переключаем, предупреждаем
      const inside = ordered.find((x) => x !== s && ovenOn(x) && x.track !== s.track && x.at.start <= s.at.start + 0.01 && x.at.end > s.at.start + 0.5);
      if (inside && inside.oven.c !== s.oven.c && Math.abs(inside.oven.c - s.oven.c) <= 20) {
        const hot = inside.oven.c > s.oven.c;
        s.oven = { ...s.oven, c: inside.oven.c };
        s.note = [s.note, `Духовка уже на ${inside.oven.c} °C — там ещё одно блюдо, не переключай. ${hot ? 'Горячее обычного — проверь на 2–3 минуты раньше' : 'Чуть прохладнее обычного — может понадобиться на 2–3 минуты дольше'}.`].filter(Boolean).join(' ');
        changed.add(s);
      } else if (lastOven && lastOven.oven.c !== s.oven.c && !/°c|температур/.test(lc(s.text))) prefix(s, `Переключи духовку на ${s.oven.c} °C.`);
      lastOven = s;
      continue;
    }
    if (!stove(s)) continue;
    if (two) s.heat_where = VESSEL_INS[s.vessel];
    const p = last[s.vessel];
    last[s.vessel] = s;
    if (!p || p.heat === s.heat || !LEVEL[p.heat] || !LEVEL[s.heat] || SAYS_HEAT.test(lc(s.text))) continue;
    const under = two ? ` под ${VESSEL_INS[s.vessel]}` : '';
    if (/выключи конфорку/.test(lc(p.tpl))) { prefix(s, `Поставь ${VESSEL_ACC[s.vessel]} на ${HEAT_ACC[s.heat]} огонь.`); continue; }
    const up = LEVEL[s.heat] > LEVEL[p.heat];
    const slow = !up && LEVEL[p.heat] - LEVEL[s.heat] >= 2 ? ` (электроплита остывает медленно — на минуту сдвинь ${VESSEL_ACC[s.vessel]} на холодную конфорку)` : '';
    prefix(s, up ? `Прибавь огонь${under} до ${HEAT_GEN[s.heat]} и подожди минуту, пока ${VESSEL_NOM[s.vessel]} прогреется.` : `Убавь огонь${under} до ${HEAT_GEN[s.heat]}${slow}.`);
  }
  for (const s of ordered) if (s._back) { prefix(s, s._back); delete s._back; }
  return [...changed];
}

// ---------- S50: готовое ждёт — под крышкой, в тепле ----------
// Таймлайн выравнивает дорожки по концу, но руки одни: гарнир или соус часто готовы раньше. Если готовое ждёт своего
// шага дольше 3 минут — последний шаг дорожки говорит, что с ним делать: накрыть и оставить на выключенной
// конфорке (посуда больше никому не нужна) или переложить на тарелку и накрыть (посуда нужна другой дорожке);
// остыло — прогреть. Мясо или овощи, отложенные на тарелку посреди дорожки и ждущие больше 5 минут, — накрыть.
const LID = '{t:lid|крышкой|перевёрнутой тарелкой}';
export function holdWarm(ordered, hasTool = () => false) {
  const changed = new Set();
  const pos = (s) => ordered.indexOf(s) + 1;
  const finish = ordered.filter((s) => s.track === 'finish' && s.at);
  for (const t of [...new Set(ordered.map((s) => s.track))].filter((x) => x !== 'finish')) {
    const own = ordered.filter((s) => s.track === t && !s.background && s.at && s.kind !== 'mise' && s.kind !== 'hygiene' && !s.chore);
    const heats = own.filter((s) => isHeat(s));
    if (!heats.length) continue;
    const L = heats.reduce((a, x) => (x.at.end >= a.at.end ? x : a));
    if (L.oven || !(L.vessel === 'pot' || L.vessel === 'pan')) continue;
    const H = own.reduce((a, x) => (x.at.end >= a.at.end ? x : a));
    if (ordered.indexOf(H) < ordered.indexOf(L)) continue;
    const slots = new Set(own.map((s) => s.ctx?.self).filter(Boolean));
    const k = ordered.indexOf(H);
    // шаг, где это готовое понадобится: другой дорожки или подачи, с этим продуктом (варка лапши в подаче — не он)
    const later = ordered.slice(k + 1).filter((x) => x.track !== t && x.at);
    const next = later.find((x) => (x.slots || []).some((id) => slots.has(id))) || later.find((x) => x.track === 'finish' && !isHeat(x));
    const F = next ? next.at.start : finish.length ? Math.min(...finish.map((x) => x.at.start)) : null;
    // едят холодным (яйца остужают под струёй) — греть не нужно
    if (F == null || F - H.at.end < 3 || /пусть ждет|подожд|остуд|остын|под (холодн|струе)/.test(lc(H.tpl))) continue;
    const at = next ? ` до шага ${pos(next)}` : ' до подачи';
    // посуда ещё понадобится другой дорожке, пока это ждёт, — переложить
    const busy = ordered.some((x) => x.track !== t && isHeat(x) && x.vessel === L.vessel && x.at.start >= H.at.end - 0.5 && x.at.start < F);
    const what = L.ctx?.self ? `{n:${L.ctx.self}.acc}` : 'всё';
    const drained = /(^|[^а-яё])слей(?![а-яё])/.test(lc(H.tpl));
    const text = busy
      ? `${VESSEL_NOM[L.vessel] === 'сковорода' ? 'Сковорода' : 'Кастрюля'} ещё понадобится: переложи ${what} на тарелку и накрой перевёрнутой тарелкой — пусть ждёт${at}, перед подачей прогрей вместе 2–3 минуты до пара.`
      : drained
        ? `Если до шага ${next ? pos(next) : 'подачи'} ещё есть время — высыпь ${what} обратно в пустую кастрюлю, перемешай с каплей масла, чтобы не слиплось, и накрой ${LID} — пусть ждёт${at}.`
        : `Накрой ${LID} и оставь на выключенной конфорке — пусть ждёт${at}; остынет — прогрей 1–2 минуты на слабом огне, помешивая.`;
    H.tpl = `${H.tpl.replace(/\s+$/, '')} ${pickTools(text, hasTool)}`;
    H.hold = true;
    changed.add(H);
  }
  // отложенное на тарелку посреди дорожки
  ordered.forEach((P, k) => {
    if (isHeat(P) || P.hold || P.track === 'finish' || !/(переложи|выложи)[^.]*на (чистую |отдельную )?тарелк/.test(lc(P.text)) || /накрой/.test(lc(P.text))) return;
    const ids = new Set((P.slots || []).length ? P.slots : [P.ctx?.self].filter(Boolean));
    const U = ordered.slice(k + 1).find((x) => x.at && (x.slots || []).some((id) => ids.has(id)));
    if (!U || !P.at || U.at.start - P.at.end < 5) return;
    // сразу после фразы «переложи … на тарелку»
    const m = P.tpl.match(/(переложи|выложи)(?:[^.{]|\{[^}]*\})*на (чистую |отдельную )?тарелк(?:[^.{]|\{[^}]*\})*\./i);
    const add = ` Тарелку накрой другой тарелкой, перевернув её, — так не остынет и не заветрится до шага ${pos(U)}.`;
    P.tpl = m ? P.tpl.replace(m[0], m[0] + add) : `${P.tpl.replace(/\s+$/, '')}${add}`;
    changed.add(P);
  });
  return [...changed];
}
