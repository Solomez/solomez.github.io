// Сборка рецепта из шаблона (data/kitchen/SCHEMA.md): замены → слоты, шаги из профилей ингредиентов и общих
// действий, проверки безопасности, таймлайн (что ставить раньше), время, таймеры, КБЖУ и цена.
// Один и тот же код — для карточки, режима готовки, плана, покупок и тестов.
import { renderText, refsOf, slotId, slotOf, slotGrams } from './cookbook.js';
import { timesOf, runningDuring } from './timeline.js';
import { assignVessels, vesselConflicts, markGlue, rawSlots, rawMeatLast, hygieneNeeds, hygieneStep, heatOff, ovenMoves, occupiedPan, markLeave, prepBeforeFire, prepClashes, markWhile, placeCut, miseStep, heatShift, holdWarm } from './flow.js';
import { allowedProduct } from './rules.js';
import { seasonSteps, seasonServe } from './season.js';
import { renameAfterSwap } from './rename.js';
import { softTools, buildGear, gearLabel, has as hasEquipment, pickTools, adaptRecipe } from './equipment.js';
import { tailorSteps } from './tailor.js';
import { bindMistakes, attachTips } from './mistakes.js';
import { describe } from './describe.js';
import { round2 } from './shopping.js';

const HARD = new Set(['oven', 'pan', 'pot', 'baking_dish', 'tray', 'blender', 'microwave']);
// чем можно обойтись: жарить на плите можно и в кастрюле, форма и противень взаимозаменяемы
const ALT = { pan: ['pan', 'pot'], tray: ['baking_dish', 'tray'], baking_dish: ['baking_dish', 'tray'] };
const toolOk = (t, hasTool) => (ALT[t] || [t]).some(hasTool);
const STARCH = new Set(['grain', 'pasta', 'potato']);
export const ACTIVE_LIMIT = 30;
// мясо не успевает дойти в блюде — готовить его до готовности сразу
const FALLBACK = { pan_brown: 'pan_pieces', sauce: 'pan_crumble' };

const isHeat = (s) => !!(s.heat || s.oven);
// жидкость способа (вода к крупе), а не соль в эту воду
const isLiquidOf = (x, slot) => x.derived?.from === slot && x.derived.by !== 'salt';
const span = (r) => (Array.isArray(r) ? r : r == null ? null : [r, r]);
const normTime = (t) => ({ active: span(t?.active) || [0, 0], passive: span(t?.passive) || [0, 0] });
// Обжарка на плите «помешивая раз в 1–2 минуты»: руки заняты не всё время. Если у шага с огнём на плите
// только активное время от 4 минут, считаем занятыми руками 40 % (помешать, перевернуть), остальное — ожидание
// у плиты, когда можно нарезать следующий продукт. Общее время шага не меняется (модель, а не данные).
export const ATTENDED_SHARE = 0.4;
// Время новичка (S53): нормы подготовки в профилях — как у повара (луковица кубиком за 2–3 минуты); у новичка
// нарезка, чистка, панировка, лепка идут в 1,5–2 раза дольше. Показываем честное время, а в план берём по нормам
// повара (time.active_pro) — предел недели 30 минут остался прежним, решение — в research/full-test/fixes/stage-5.md
export const NOVICE = [1.5, 2];
const PREP_TIME = /нарежь|наруби|порежь|разрежь|очисти|почисти|натри|срежь|нашинкуй|поруби|раздави|сними (сухую )?шелуху|сформуй|слепи|скатай|отбей|обваляй|вырежь|разбери на соцветия/;
function noviceTime(s, kind) {
  if (isHeat(s) || s.background || !(kind === 'prep' || PREP_TIME.test(String(s.text || '').toLowerCase()))) return null;
  const t = normTime(s.time);
  if (!(t.active[1] > 0)) return null;
  const r = (x) => Math.round(x * 2) / 2;
  return { ...t, active: [r(t.active[0] * NOVICE[0]), r(t.active[1] * NOVICE[1])] };
}

// Таймер шага (S54). Шаг, где всё идёт само (томится, маринуется, запекается), — таймер на ожидание, как в тексте
// («оставь минимум на 30 минут» — 30, а не 31 с минутой на то, чтобы залить); остальное — нижняя граница шага
export function timerOf(s) {
  const t = normTime(s.time);
  if (!(t.passive[1] > 0) && !isHeat(s)) return null;
  const v = t.passive[0] >= 1 && !t.attended && !s.time?.attended ? t.passive[0] : t.active[0] + t.passive[0];
  return v >= 1 ? v : null;
}
export function attendedTime(s) {
  const t = normTime(s.time);
  if (!s.heat || s.oven || t.passive[1] > 0 || t.active[0] < 4 || s.continuous) return t;
  const a = t.active.map((x) => Math.round(x * ATTENDED_SHARE * 2) / 2);
  return { active: a, passive: [t.active[0] - a[0], t.active[1] - a[1]], attended: true };
}

// Подходящий способ профиля для контекста слота (и утвари, что есть дома)
export function pickMethod(prof, context, prefer, hasTool = () => true) {
  if (!prof?.methods) return null;
  const ok = (name) => {
    const m = prof.methods[name];
    return m && (!context || (m.contexts || []).includes(context)) && (m.equipment || []).filter((t) => HARD.has(t)).every((t) => toolOk(t, hasTool));
  };
  if (prefer && ok(prefer)) return prefer;
  return Object.keys(prof.methods).find(ok) || null;
}

// Способ для шага карточки. S08: способ без шагов и подготовки (ветчина ломтиками целиком) — только если продукт
// назван в другом шаге карточки (сборка бутерброда); иначе — способ того же контекста с шагом («нарежь полосками»),
// чтобы было сказано, что с ним делать
function methodFor(prof, card, st, env, hasTool) {
  const ctx = env.ctxOverride?.[st.use] || st.context;
  const name = pickMethod(prof, ctx, env.ctxOverride?.[st.use] ? null : st.method, hasTool);
  const m = prof?.methods?.[name];
  const prep = m && (m.prep !== undefined ? m.prep : prof.prep);
  if (!m || (m.steps || []).length || prep || st.method) return name;
  const re = new RegExp(`\\{[qanN]:${st.use}[.*}]`);
  const named = card.steps.some((x) => x.use !== st.use && re.test(JSON.stringify([x.text, x.with, x.late])));
  if (named) return name;
  return Object.keys(prof.methods).find((k) => k !== name && (prof.methods[k].contexts || []).includes(ctx) && (prof.methods[k].steps || []).length && pickMethod(prof, ctx, k, hasTool) === k) || name;
}

const factorOf = (prof) => (prof?.yield?.factor || 1) * (prof?.edible || 1);

// ---------- S52: после замены — глаголы и приёмы нового продукта ----------
// {k:слот=ключ1,ключ2:текст|иначе} — в карточке: текст, если в слоте сейчас один из этих продуктов («добавь сушёный
// чеснок» вместо «выдави чеснок через пресс»). Скобки могут вкладываться (как у {t:…})
export function pickProduct(text, keyOf) {
  const s = String(text ?? '');
  if (!s.includes('{k:')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('{k:', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    let depth = 0;
    let j = at;
    const cuts = [];
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) break; } else if (s[j] === '|' && depth === 1) cuts.push(j);
    }
    const head = s.slice(at + 3, cuts[0] ?? j);
    const m = head.match(/^([\w-]+)=([\w,-]+):([\s\S]*)$/);
    const yes = m ? m[3] : '';
    const no = cuts.length ? s.slice(cuts[0] + 1, j) : '';
    out += pickProduct(m && m[2].split(',').includes(keyOf(m[1])) ? yes : no, keyOf);
    i = j + 1;
  }
  return out;
}
// Глагол по виду продукта: жидкость — «влей», бульонный кубик — «раскроши», сыпучее — «всыпь», остальное — «добавь».
// Слот заменён (кубик → соевый соус, томаты → пассата, горошек из пакета → кукуруза из банки) — глагол и приёмы
// старого продукта в тексте карточки меняются: «раскроши соевый соус» → «влей соевый соус»
const VERB_KIND = { раскроши: 'crumble', всыпь: 'dry', высыпь: 'dry', насыпь: 'dry', влей: 'liquid', налей: 'liquid' };
const LIQ_KEYS = /^(water|milk|cream|cooking_cream|kefir|oil|olive_oil|soy_sauce|vinegar|passata|lemon_juice|coconut_milk)$/;
function kindOf(key, kitchen) {
  const m = kitchen?.measures?.[key];
  if (LIQ_KEYS.test(key) || m?.liquid) return 'liquid';
  if (key === 'stock_cube') return 'crumble';
  if (m && ['cup', 'spoon', 'pinch'].includes(m.kind)) return 'dry';
  return 'pieces';
}
export function agreeVerbs(text, r, kitchen) {
  let t = String(text ?? '');
  for (const ing of r.ingredients.filter((x) => x.replaced)) {
    const id = slotId(ing);
    const want = kindOf(ing.key, kitchen);
    const ref = `\\{[qan]:${id}(?:[.*][^}]*)?\\}`;
    t = t.replace(new RegExp(`(^|[\\s,(:])(раскроши|всыпь|высыпь|насыпь|влей|налей)(\\s+(?:в [^{,.]{0,30}\\s)?)(?=${ref})`, 'gi'), (all, pre, verb, sp) => {
      const k = VERB_KIND[verb.toLowerCase()];
      if (!k || k === want) return all;
      const nv = { liquid: 'влей', crumble: 'раскроши', dry: 'всыпь', pieces: 'добавь' }[want];
      return `${pre}${verb[0] === verb[0].toUpperCase() ? nv[0].toUpperCase() + nv.slice(1) : nv}${sp}`;
    });
    // «прямо из пакета» — только у замороженного; «раздавив крупные куски» — не у жидкости (пассата)
    if (!/^frozen_/.test(ing.key)) t = t.replace(new RegExp(`(${ref}[^.{]*?) прямо из пакета`, 'g'), '$1');
    if (want === 'liquid') t = t.replace(new RegExp(`(${ref}), раздавив крупные куски (?:\\{t:[^{}]*\\}|[^,.]*)`, 'g'), '$1');
  }
  return t;
}

// Заменимая утварь в тексте шага — для подсказок «нет сита — …» и списка посуды (core/equipment.js)
export { softTools };

// Слоты рецепта после замен: subs = { слот: новый ключ }
function substituteSlots(card, subs, env) {
  const { products = {}, kitchen } = env;
  const swapped = [];
  const ingredients = card.ingredients.map((ing) => {
    const id = slotId(ing);
    const to = subs?.[id];
    if (!to || to === ing.key) return { ...ing, id };
    const p = products[to];
    // количество: коэффициент из data/substitutes.json (специи: чили острее паприки), иначе — по выходу продукта
    const row = (env.substitutes?.[ing.key] || []).find(([k]) => k === to);
    const ratio = +row?.[2] > 0 ? +row[2] : factorOf(kitchen?.profiles?.[ing.key]) / factorOf(kitchen?.profiles?.[to]);
    const grams = Math.round((ing.grams || 0) * ratio * 10) / 10;
    swapped.push({ slot: id, from: ing.key, from_ru: ing.name_ru, to, to_ru: p?.name_ru || to, note: kitchen?.profiles?.[to]?.note_as_sub || null });
    return {
      ...ing, id, key: to, grams, name_ru: p?.name_ru || to, name_de: p?.name_de_generic || p?.name_de || to,
      note: kitchen?.profiles?.[to]?.note_as_sub || null, replaced: { key: ing.key, name_ru: ing.name_ru, grams: ing.grams },
    };
  });
  return { ingredients, swapped };
}

// Развернуть шаги шаблона: общие, действия (actions.json), из профилей ингредиентов
function expandSteps(r, card, env) {
  const { kitchen, hasTool = defaultKitchen } = env;
  const out = [];
  const methods = {};
  const errors = [];
  // способы слотов заранее: разогрев духовки берёт температуру из способа продукта («@chicken_legs»)
  const chosen = {};
  for (const st of card.steps.filter((x) => x.use)) {
    const ing = slotOf(r, st.use);
    const prof = kitchen?.profiles?.[ing?.key];
    const name = methodFor(prof, card, st, env, hasTool);
    if (name && !chosen[st.use]) chosen[st.use] = prof.methods[name];
  }
  const ovenOf = (slot) => (chosen[slot]?.steps || []).find((x) => x.oven)?.oven || null;
  // формулировка по кухне (S01): {t:тёрка|натри на тёрке|нарежь ножом} — что есть дома; чего не хватило — gear_lack
  // (в списке посуды и «Дома не хватает»)
  const pickedWith = new WeakMap();
  const push = (s0, base) => {
    const used = { has: new Set(), lack: new Set() };
    // продукт слота после замены: {k:…} и глаголы по виду продукта (S52)
    const keyOf = (id) => slotOf(r, id)?.key;
    const prod = (t) => (typeof t === 'string' ? agreeVerbs(pickProduct(t, keyOf), r, kitchen) : t);
    const pick = (t) => (typeof t === 'string' ? pickTools(prod(t), hasTool, used) : t);
    const s = { ...s0, text: pick(s0.text) };
    // вскипятить в чайнике (S47): если он есть, шаг без огня на плите — конфорку выключать не нужно
    if (s0.no_heat_with && hasTool(s0.no_heat_with)) delete s.heat;
    delete s.no_heat_with;
    // и признаки готовности, проверка, «если не готово», «если передержал»: «проведи лопаткой (ложкой) по дну»
    for (const k of ['why', 'note', 'check']) if (s[k]) s[k] = pick(s[k]);
    if (s.cues) s.cues = s.cues.map((c) => ({ ...c, text: pick(c.text) }));
    // «если не готово / передержал» — на всякий случай: в «Дома не хватает» их утварь не попадает
    const quiet = (t) => (typeof t === 'string' ? pickTools(prod(t), hasTool) : t);
    if (s.not_ready?.text) s.not_ready = { ...s.not_ready, text: quiet(s.not_ready.text) };
    if (s.overdone) s.overdone = { ...s.overdone, signs: quiet(s.overdone.signs), rescue: quiet(s.overdone.rescue) };
    const ctx = base.ctx || {};
    // параметры with тоже могут выбирать формулировку; один объект на шаг карточки (шаги одного use делят его)
    let w = ctx.with;
    if (w && Object.values(w).some((v) => typeof v === 'string' && (v.includes('{t:') || v.includes('{k:') || prod(v) !== v))) {
      if (!pickedWith.has(w)) pickedWith.set(w, Object.fromEntries(Object.entries(w).map(([k, v]) => [k, typeof v === 'string' ? pickTools(prod(v), hasTool) : v])));
      for (const v of Object.values(w)) pick(v);
      w = pickedWith.get(w);
    }
    // S53: подготовка — по времени новичка; нормы повара — для плана (time_pro)
    const nov = noviceTime(s, base.kind);
    out.push({
      ...s, track: base.track || 'main', time: attendedTime(nov ? { ...s, time: nov } : s), time_pro: nov ? normTime(s.time) : null, tpl: s.text, origin: base.origin, ci: base.ci ?? null,
      ctx: w !== ctx.with ? { ...ctx, with: w } : ctx, src: base.src || null, use: base.use || null, kind: base.kind || 'step',
      gear_lack: [...used.lack],
    });
  };
  card.steps.forEach((st, i) => {
    const track = st.track || 'main';
    if (st.use) {
      const ing = slotOf(r, st.use);
      const prof = kitchen?.profiles?.[ing?.key];
      const name = methodFor(prof, card, st, env, hasTool);
      if (!ing || !name) {
        errors.push(`шаг ${i + 1}: нет способа «${st.context}» для ${ing?.key || st.use}`);
        return;
      }
      methods[st.use] = name;
      const m = prof.methods[name];
      const liquid = r.ingredients.find((x) => isLiquidOf(x, st.use));
      // соль в воду для варки (S02, S03): {x:salt} в тексте способа — фраза способа со слотом соли этого продукта
      // («, всыпь половину чайной ложки соли»); нет соли (вода с бульонным кубиком) — пусто
      const salt = r.ingredients.find((x) => x.derived?.by === 'salt' && x.derived.from === st.use);
      const w0 = st.with || {};
      const w1 = m.salt && w0.salt == null ? { ...w0, salt: salt ? m.salt.text.replace('SALT', slotId(salt)) : '' } : w0;
      // вода от варки для соуса (S03): {x:reserve} — «Зачерпни кружкой треть стакана воды от варки…», если она нужна
      const res = m.reserve ? r.ingredients.find((x) => x.key === 'water' && x.for === st.use && !x.derived) : null;
      const ctx = { self: st.use, liquid: liquid ? slotId(liquid) : null, with: m.reserve && w1.reserve == null ? { ...w1, reserve: res ? m.reserve.text.replace('RES', slotId(res)) : '' } : w1 };
      const prep = m.prep !== undefined ? m.prep : prof.prep;
      // part: "prep" — только подготовка (профиль + шаги способа до первого огня), "cook" — остальное;
      // так подготовку можно поставить раньше в дорожке, не перечисляя id шагов профиля
      const firstHeat = (m.steps || []).findIndex((x) => isHeat(x));
      const cut = firstHeat < 0 ? (m.steps || []).length : firstHeat;
      if (prep?.text && st.prep !== false && st.part !== 'cook') push({ ...prep }, { track, origin: `${ing.key}:prep`, ctx, use: st.use, kind: 'prep', src: ing.key, ci: i });
      // skip — шаги способа, которые в этом рецепте не нужны (курица уже нарезана для маринада)
      const msteps = (m.steps || []).filter((x, j) => !(st.skip || []).includes(x.id) && (st.part === 'prep' ? j < cut : st.part === 'cook' ? j >= cut : true)).map((x) => ({ ...x }));
      // «late»: добавить что-то за N минут до конца основного этапа — этап делится на два шага
      if (st.late) {
        const k = Math.max(0, msteps.findIndex((x) => x.main));
        const main = msteps[k];
        const L = st.late.min || 0;
        const t = normTime(main.time);
        const first = { ...main, time: { active: t.active, passive: [Math.max(1, t.passive[0] - L), Math.max(1, t.passive[1] - L)] }, continues: true };
        delete first.cues; delete first.check; delete first.not_ready; delete first.overdone; delete first.halfway;
        // S07: первый этап в духовке — не до готовности: общий итог явно и признак перехода ко второму этапу
        if (main.oven) {
          first.text = `${String(main.text).replace(/\s+$/, '')} Всего в духовке ${t.passive[0]}–${t.passive[1]} минут, но через ${first.time.passive[0]} минут откроешь — это ещё не готовность.`;
          if (main.halfway) Object.assign(first, { cues: main.halfway.cues, check: main.halfway.check });
        }
        const late = { ...main, id: (main.id || 'main') + '-late', text: st.late.text, time: { active: [0, 1], passive: [L, L] }, late: true };
        delete late.halfway;
        // S49: признаки — к своему шагу. У добавки своё условие («добавь лук и жарь, пока лук не станет мягче») —
        // первая часть (обжарка мяса) со своими признаками, вторая — с признаками добавленного продукта;
        // «сними фольгу и запекай без неё» — признаки «под фольгой» у первой части (их видно, когда фольгу снимают)
        const lateText = String(st.late.text).toLowerCase();
        if (!main.oven && /(^|[^а-яё])пока /.test(lateText)) {
          Object.assign(first, { cues: main.cues, check: main.check, not_ready: main.not_ready, overdone: main.overdone });
          const added = addedCues(r, card, st, chosen, kitchen);
          if (added) Object.assign(late, added);
        }
        if (main.oven && /сними фольгу/.test(lateText) && (main.cues || []).some((c) => /фольг/.test(c.text))) {
          first.cues = main.cues.filter((c) => /фольг/.test(c.text));
          // без фольги — верх подрумянивается: это и видно
          late.cues = [{ type: 'look', text: 'верх подрумянился, по краям золотистые пятна' }, ...main.cues.filter((c) => !/фольг/.test(c.text))];
          if (main.check && /фольг/.test(main.check)) { first.check = main.check; late.check = 'Взгляни сверху: верх золотистый; проткни ложкой у края до дна — жидкости нет.'; }
        }
        // без своих признаков — по таймеру: что сделать, когда он прозвенит
        if (!(first.cues || []).length) first.on_timer = `сразу ${String(st.late.text).replace(/^([А-ЯЁ])/, (c) => c.toLowerCase()).replace(/\.$/, '')}`;
        // основной этап без огня (кускус запаривают): добавку кладут в кипящую жидкость перед ним
        if (!isHeat(main)) msteps.splice(k, 0, { id: 'late', text: st.late.text, time: { active: [0, 1] } });
        else msteps.splice(k, 1, first, late);
      }
      msteps.forEach((x) => push(x, { track, origin: `${ing.key}:${name}:${x.id || ''}`, ctx, use: st.use, src: ing.key, ci: i }));
      if (m.finishes_later) methods[`${st.use}#later`] = true;
    } else if (st.act) {
      const a = kitchen?.actions?.[st.act];
      if (!a) { errors.push(`шаг ${i + 1}: нет действия ${st.act}`); return; }
      // параметры действия: переданные в with или значения по умолчанию; "$имя" в огне и духовке — из параметров
      const w = { ...Object.fromEntries(Object.entries(a.params || {}).filter(([, v]) => v.default != null).map(([k, v]) => [k, String(v.default)])), ...(st.with || {}) };
      for (const [k, v] of Object.entries(w)) {
        const o = typeof v === 'string' && v.startsWith('@') ? ovenOf(v.slice(1)) : null;
        if (o) w[k] = String(k === 'mode' ? o.mode : o.c);
        else if (typeof v === 'string' && v.startsWith('@')) w[k] = String(a.params?.[k]?.default ?? '');
      }
      if (typeof (st.with || {}).temp === 'string' && st.with.temp.startsWith('@') && !(st.with || {}).mode) { const o = ovenOf(st.with.temp.slice(1)); if (o?.mode) w.mode = o.mode; }
      // S16: режим духовки словами («верх-низ — значок с полосками сверху и снизу»)
      if (a.mode_hints) w.mode_hint = a.mode_hints[w.mode] ?? '';
      const val = (v) => (typeof v === 'string' && v.startsWith('$') ? w[v.slice(1)] : v);
      const merged = { ...a, ...Object.fromEntries(Object.entries(st).filter(([k]) => !['act', 'with', 'track'].includes(k))) };
      // параметр не передан (нет жидкости) — свой текст без него: шаг не говорит о том, чего в рецепте нет
      for (const [k, t] of Object.entries(a.text_without || {})) if (!st.text && !(st.with || {})[k]) merged.text = t;
      // S17: признаки по продукту параметра (сливочное масло — своя ветка)
      for (const [param, byKey] of Object.entries(a.variants || {})) {
        const key = slotOf(r, String(w[param] ?? '').split('*')[0])?.key;
        if (byKey[key]) Object.assign(merged, byKey[key]);
      }
      delete merged.params;
      delete merged.text_without;
      delete merged.mode_hints;
      delete merged.variants;
      delete merged.engine;
      if (merged.heat) merged.heat = val(merged.heat);
      if (merged.oven) merged.oven = { c: +val(merged.oven.c), mode: val(merged.oven.mode) };
      push(merged, { track, origin: `act:${st.act}`, ctx: { with: w }, src: 'act', ci: i });
    } else {
      push(st, { track, origin: `card:${i}`, ctx: { with: st.with || {} }, src: 'card', ci: i });
    }
  });
  // разогрев духовки — на температуру первого шага с духовкой после него (при замене бедро 220 °C → грудка 200 °C)
  out.forEach((s, i) => {
    if (s.origin !== 'act:preheat_oven') return;
    const next = out.slice(i + 1).find((x) => x.oven && !x.background);
    if (next?.oven?.c) {
      s.oven = { ...next.oven };
      const mode = next.oven.mode || s.ctx.with?.mode;
      s.ctx = { ...s.ctx, with: { ...s.ctx.with, temp: String(next.oven.c), mode, mode_hint: kitchen?.actions?.preheat_oven?.mode_hints?.[mode] ?? s.ctx.with?.mode_hint ?? '' } };
    }
  });
  return { steps: out, methods, errors, push: (st, base) => { push(st, base); return out.pop(); } };
}

// S49: признаки продуктов, которые добавляют во второй части этапа («добавь лук и морковь и жарь, пока овощи не станут
// мягче»): из их способа — шаг с огнём, который карточка пропустила (продукт готовится здесь). Подстановки {n:self}
// — на сам продукт. Продукт уже готовили раньше (фарш вернули в сковороду) — признаки прогрева
function addedCues(r, card, st, chosen, kitchen) {
  const ids = [...new Set(refsOf(st.late.text).map((x) => x.id))].filter((id) => id !== st.use && slotOf(r, id));
  const cues = [];
  let check = null;
  let notReady = null;
  let warm = false;
  for (const id of ids) {
    const m = chosen[id];
    const skipped = new Set(card.steps.filter((x) => x.use === id).flatMap((x) => x.skip || []));
    const h = (m?.steps || []).find((x) => (x.heat || x.oven) && (x.cues || []).length && skipped.has(x.id));
    const own = (t) => String(t).replace(/\{([qanN]):self/g, `{$1:${id}`);
    if (h) {
      cues.push(...h.cues.slice(0, 2).map((c) => ({ ...c, text: own(c.text) })));
      check = check || (h.check ? own(h.check) : null);
      notReady = notReady || (h.not_ready?.text ? { ...h.not_ready, text: own(h.not_ready.text) } : null);
    } else if ((m?.steps || []).some((x) => x.heat || x.oven)) warm = true;
  }
  if (cues.length && new Set(cues.map((c) => c.type)).size > 1) return { cues: cues.slice(0, 3), check, not_ready: notReady, overdone: null };
  const w = kitchen?.actions?.warm_through;
  return warm && w ? { cues: w.cues, check: w.check, not_ready: w.not_ready, overdone: null } : null;
}

// S47: продукт «вода горячая» / «кипяток», которую ни один шаг не греет. Первый шаг с ней — с огнём (влить в
// сковороду и довести до кипения): подойдёт самая горячая из-под крана — пометка у ингредиента. Без огня (растворить
// кубик и влить в форму): шаг «вскипяти» в начале его дорожки — в чайнике, если он есть, иначе в кастрюле, если она в рецепте
// больше ни для чего не нужна; иначе — тоже самая горячая из-под крана.
const HOT = /горяч|кипят/;
function hotWater(raw, r, env, push0) {
  const { kitchen, hasTool = defaultKitchen } = env;
  for (const ing of r.ingredients) {
    if (ing.key !== 'water' || !HOT.test(String(ing.name_ru || '').toLowerCase())) continue;
    const id = slotId(ing);
    const k = raw.findIndex((s) => allRefs(s).includes(id));
    if (k < 0) continue;
    const U = raw[k];
    // уже греют: «налей воду и вскипяти», «доведи до кипения» с этим слотом раньше или в этом же шаге
    const tap = hasTool('kettle') ? 'из чайника или самая горячая из-под крана' : 'самая горячая из-под крана';
    const heated = raw.slice(0, k + 1).find((s) => allRefs(s).includes(id) && (s.origin === 'act:boil_water' || /вскипяти|до кипения/.test(String(s.text).toLowerCase())));
    // её доводят до кипения прямо в блюде — горячая из-под крана только быстрее закипит
    if (heated === U) ing.note = [ing.note, `${tap} — закипит быстрее`].filter(Boolean).join('; ');
    if (heated) continue;
    const potFree = !raw.some((s) => isHeat(s) && /кастрюл/.test(String(s.text).toLowerCase()));
    if (isHeat(U) || !(hasTool('kettle') || potFree) || !kitchen?.actions?.heat_water) {
      ing.note = [ing.note, tap].filter(Boolean).join('; ');
      continue;
    }
    const a = kitchen.actions.heat_water;
    const st = { ...a, params: undefined, engine: undefined };
    delete st.params; delete st.engine;
    const step = push0(st, { track: U.track, origin: 'act:heat_water', ctx: { with: { water: id } }, src: 'act' });
    step.text = renderText(r, step.tpl, { ...step.ctx, kitchen }).text;
    step.slots = stepRefs(step);
    step.tools = softTools(step.text);
    // в начале своей дорожки: вода греется, пока режут (и до того, как руки трогали сырое мясо)
    raw.splice(raw.findIndex((x) => x.track === U.track && !x.background), 0, step);
  }
}

// ---------- S40: одна кастрюля на два дела ----------
// Две дорожки держат одну кастрюлю одновременно и ни одна её не освобождает, а второй кастрюли нет: гарнир (рис,
// булгур, картофель) варится первым, потом — шаг «переложи в глубокую тарелку и накрой» (держит тепло 20–30 минут),
// и посуда свободна для другой дорожки. Ждать дольше 30 минут — в холодильник и прогреть в сковороде перед подачей.
const SECOND = { pot: 'pot2', pan: 'pan2' };
const HOLD_MIN = 30;
function holdable(raw, occ, v, r, kitchen) {
  const ok = occ.filter((o) => {
    const own = raw.filter((x) => x.track === o.track && isHeat(x) && !x.oven);
    return own.length && own.every((x) => x.vessel === v && x.ctx?.self && STARCH.has(kitchen?.profiles?.[slotOf(r, x.ctx.self)?.key]?.role));
  });
  return ok.sort((x, y) => (x.to - x.from) - (y.to - y.from))[0] || null;
}
function actionStep(kitchen, id) {
  const a = kitchen?.actions?.[id];
  if (!a) return null;
  const st = { ...a };
  delete st.params; delete st.engine;
  return st;
}
function holdOne(raw, o, v, r, kitchen, push0) {
  const self = raw.filter((x) => x.track === o.track && isHeat(x)).pop().ctx.self;
  const st = actionStep(kitchen, 'hold_side');
  if (!st) return false;
  const step = push0(st, { track: o.track, origin: 'act:hold_side', ctx: { with: { food: self, vessel: v === 'pot' ? 'Кастрюлю' : 'Сковороду' } }, src: 'act' });
  step.text = renderText(r, step.tpl, { ...step.ctx, kitchen }).text;
  step.slots = stepRefs(step);
  step.tools = softTools(step.text);
  step.hold_one = v;
  step.hold_slot = self;
  const last = raw.map((x, i) => (x.track === o.track && !x.background ? i : -1)).filter((i) => i >= 0).pop();
  raw.splice(last + 1, 0, step);
  return true;
}
// следующий шаг с этим продуктом (по времени) и сколько ждать
function holdWait(raw, plan, R, refs) {
  const i = raw.indexOf(R);
  const end = plan.at[i]?.end ?? 0;
  const next = raw.map((x, j) => j).filter((j) => j !== i && raw[j].track !== R.track && plan.at[j] && plan.at[j].start >= end - 0.5 && refs(raw[j]).includes(R.hold_slot))
    .sort((x, y) => plan.at[x].start - plan.at[y].start)[0];
  // никто из шагов его не берёт (подают в финале рецепта: «подавай гуляш на рисе») — ждёт до конца
  return next == null ? { next: null, wait: Math.max(...raw.map((x, j) => plan.at[j]?.end ?? 0)) - end } : { next, wait: plan.at[next].start - end };
}
function reheatOne(raw, plan, r, kitchen, push0, refs) {
  let added = false;
  for (const R of raw.filter((x) => x.hold_one && !x.reheat_added)) {
    const w = holdWait(raw, plan, R, refs);
    if (w.wait <= HOLD_MIN) continue;
    // сковорода нужна под конец другому — прогреть негде: только холодильник и «накрытым» (без прогрева)
    const end = Math.max(...raw.map((x, j) => plan.at[j]?.end ?? 0));
    if (raw.some((x, j) => isHeat(x) && !x.oven && x.vessel === 'pan' && plan.at[j] && plan.at[j].end > end - 10)) continue;
    const self = R.hold_slot;
    const st = actionStep(kitchen, 'reheat_side');
    if (!st) continue;
    const step = push0(st, { track: 'finish', origin: 'act:reheat_side', ctx: { with: { food: self } }, src: 'act' });
    step.text = renderText(r, step.tpl, { ...step.ctx, kitchen }).text;
    step.slots = stepRefs(step);
    step.tools = softTools(step.text);
    step.vessel = 'pan';
    R.reheat_added = true;
    // в начале подачи: прогреть до того, как раскладывать (подачи нет — в конце)
    const k = raw.findIndex((x) => x.track === 'finish');
    raw.splice(k < 0 || w.next == null ? raw.length : k, 0, step);
    added = true;
  }
  return added;
}

// Все слоты, на которые ссылается шаг: текст, параметры with (и подстановки внутри них)
function allRefs(s) {
  const ids = new Set(stepRefs(s));
  // только те параметры with, что реально подставляются в текст шага ({x:имя})
  const used = new Set([...String(s.tpl || '').matchAll(/\{x:([^}]+)\}/g)].map((m) => m[1]));
  for (const [k, v] of Object.entries(s.ctx?.with || {})) {
    if (!used.has(k)) continue;
    for (const x of refsOf(String(v))) ids.add(x.id);
  }
  return [...ids];
}

// Доля слота в шаге: подстановки в тексте и в параметрах with, что подставляются в текст
function fracOf(x, id) {
  const used = new Set([...String(x.tpl || '').matchAll(/\{x:([^}]+)\}/g)].map((mm) => mm[1]));
  const all = [String(x.tpl || ''), ...Object.entries(x.ctx?.with || {}).filter(([k]) => used.has(k)).map(([, v]) => String(v))];
  let f = null;
  for (const t of all) for (const ref of refsOf(t)) {
    const rid = ref.id === 'self' ? x.ctx?.self : ref.id === 'liquid' ? x.ctx?.liquid : ref.id.startsWith('$') ? String(x.ctx?.with?.[ref.id.slice(1)] ?? '').split('*')[0] : ref.id;
    const extra = ref.id.startsWith('$') ? +String(x.ctx?.with?.[ref.id.slice(1)] ?? '').split('*')[1] || 1 : 1;
    if (rid === id) f = Math.max(f ?? 0, ref.frac * extra);
  }
  return f;
}

// Слоты, которых касается шаг (подстановки + свой слот)
function stepRefs(s) {
  const ids = new Set();
  for (const ref of refsOf(s.tpl)) {
    const id = ref.id === 'self' ? s.ctx.self : ref.id === 'liquid' ? s.ctx.liquid : ref.id.startsWith('$') ? String(s.ctx.with?.[ref.id.slice(1)] ?? '').split('*')[0] : ref.id;
    if (id) ids.add(id);
  }
  if (s.ctx.self) ids.add(s.ctx.self);
  return [...ids];
}

// Птица, свинина, фарш: проверка безопасности на шаге, где мясо доходит; на шагах до него — «ещё сырое внутри»
// S22: проверка мяса — одна: на шаге, где мясо доходит, «Как проверить» шага, если он про то же (разрезать кусок,
// разломить комок), уступает проверке безопасности; «внутри ещё сырое» — только на шагах, где это мясо в посуде
const SAME_CHECK = /разрежь|разломи|надрежь|проткни|сок прозрачн/;
function attachSafety(r, steps, kitchen, methods, hasTool = defaultKitchen) {
  for (const ing of r.ingredients) {
    const prof0 = kitchen?.profiles?.[ing.key];
    if (!prof0?.safety || !prof0.safety_check) continue;
    const id = slotId(ing);
    // у способа может быть своя проверка (фарш крошкой — не «разрежь котлету»)
    const prof = { ...prof0, safety_check: prof0.methods?.[methods[id]]?.safety_check || prof0.safety_check };
    const touched = steps.map((s, i) => (isHeat(s) && s.slots.includes(id) ? i : -1)).filter((i) => i >= 0);
    if (!touched.length) continue;
    const track = steps[touched[0]].track;
    let fin = touched[touched.length - 1];
    // обжарили и доготавливают в блюде — проверка на последнем шаге с огнём этой дорожки
    if (methods[`${id}#later`]) {
      const lastHeat = steps.map((s, i) => (isHeat(s) && s.track === track && i >= fin ? i : -1)).filter((i) => i >= 0).pop();
      if (lastHeat != null) fin = lastHeat;
    }
    const meatVessel = steps[touched[0]].vessel;
    // S73: мясо переложили на тарелку («переложи курицу на тарелку», в сковороде жарятся грибы) — пока его не
    // вернули, «внутри ещё сырое» на шагах в посуде не показываем: мяса там нет
    let out = false;
    for (let i = touched[0]; i <= fin; i++) {
      const s = steps[i];
      const mine = s.slots.includes(id);
      if (out && mine) out = false;
      const leaves = mine && /(переложи|выложи)[^.]*на (чистую )?тарелк/.test(String(s.text).toLowerCase());
      if (!isHeat(s) || (s.track !== track && !mine)) { if (leaves) out = true; continue; }
      if (out && i !== fin) continue;
      if (leaves) out = true;
      // другая посуда той же дорожки (морковь в кастрюле, мясо в сковороде) — мяса там нет
      if (!s.slots.includes(id) && meatVessel && s.vessel && s.vessel !== meatVessel && i !== fin) continue;
      const entry = i === fin
        ? { slot: id, stage: 'final', check: pickTools(prof.safety_check.check, hasTool), temp_c: prof.safety_check.temp_c, kind: prof.safety, src: prof.safety_check.src }
        : { slot: id, stage: 'partial', kind: prof.safety };
      s.safety = [...(s.safety || []).filter((x) => x.slot !== id), entry];
      if (!s.slots.includes(id)) s.slots.push(id);
      if (i === fin && s.check && SAME_CHECK.test(String(s.check).toLowerCase())) s.check = 'Проверь мясо так, как сказано в блоке «Безопасность», — это и есть проверка готовности.';
    }
  }
}

// КБЖУ и цена: поправка базовых значений карточки на изменившиеся слоты (как считает scripts/build_data.py)
function eurPerKg(p) {
  const packs = p?.packs || [];
  return packs[0]?.eur_per_kg || 0;
}
function recount(card, r, products) {
  const n = card.servings || 1;
  const ps = { ...card.per_serving };
  let breakdown = [...(card.cost_breakdown || [])];
  const changed = r.ingredients.filter((ing) => ing.replaced);
  if (!changed.length) return { per_serving: ps, cost_breakdown: breakdown };
  for (const ing of changed) {
    const a = products[ing.replaced.key]?.nutrition_per_100g;
    const b = products[ing.key]?.nutrition_per_100g;
    if (Array.isArray(a) && Array.isArray(b)) {
      ['kcal', 'protein', 'fat', 'carbs'].forEach((f, j) => { ps[f] = (ps[f] || 0) + (ing.grams * (+b[j] || 0) - ing.replaced.grams * (+a[j] || 0)) / 100 / n; });
    }
    const old = breakdown.find((c) => c.key === ing.replaced.key);
    const perKg = eurPerKg(products[ing.key]);
    const cost = round2(((ing.grams / n) * perKg) / 1000);
    ps.cost = (ps.cost || 0) - (old?.cost_per_serving || 0) + cost;
    const best = products[ing.key]?.packs?.[0];
    const row = { key: ing.key, name_ru: products[ing.key]?.name_ru || ing.name_ru, grams_per_serving: Math.round((ing.grams / n) * 10) / 10, cost_per_serving: cost, store: best?.store || null, is_estimate: !!(best?.is_estimate || best?.stale) };
    breakdown = old ? breakdown.map((c) => (c === old ? row : c)) : [...breakdown, row];
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    per_serving: { ...ps, cost: round2(Math.max(0, ps.cost)), kcal: Math.round(Math.max(0, ps.kcal)), protein: r1(Math.max(0, ps.protein)), fat: r1(Math.max(0, ps.fat)), carbs: r1(Math.max(0, ps.carbs)) },
    cost_breakdown: breakdown,
  };
}

// Строки цены одного продукта — в одну: граммы и деньги складываются, название — продукта (без «для мяса»)
function mergeCost(rows, products) {
  const by = new Map();
  for (const c of rows || []) {
    const cur = by.get(c.key);
    if (!cur) { by.set(c.key, { ...c }); continue; }
    cur.grams_per_serving = Math.round((cur.grams_per_serving + c.grams_per_serving) * 10) / 10;
    cur.cost_per_serving = round2(cur.cost_per_serving + c.cost_per_serving);
    cur.name_ru = products?.[c.key]?.name_ru || String(cur.name_ru).replace(/\s*\(.*\)$/, '');
    cur.is_estimate = cur.is_estimate || c.is_estimate;
  }
  return [...by.values()];
}

// Подпись шага для сравнения «до и после замены»
const sig = (s) => `${s.track}|${s.text}|${s.heat || ''}|${s.oven ? s.oven.c : ''}|${(s.time.active || []).join('-')}|${(s.time.passive || []).join('-')}|${(s.cues || []).map((c) => c.text).join('/')}`;

// card — карточка v2 из recipes.json; env: { kitchen, products, subs, equipment: hasTool(id) }
// утварь по умолчанию — кухня новичка из core/equipment.js (сковорода, кастрюля, духовка, блендер, нож, доска)
const defaultKitchen = (id) => hasEquipment({}, id);

export function compile(card, env0 = {}) {
  if (card.format !== 2) return card;
  const env = env0.hasTool ? env0 : { ...env0, hasTool: defaultKitchen };
  const { kitchen, products = {} } = env;
  const { ingredients, swapped } = substituteSlots(card, env.subs, env);
  // S46: соль и перец «по вкусу» — с количеством (граммы строки), «по вкусу» — в пояснение
  const r = { ...card, swapped, ingredients: ingredients.map((i) => ((i.key === 'salt' || i.key === 'black_pepper') && i.text && i.grams > 0 && !i.derived
    ? { ...i, text: null, note: [i.note, /вкус/.test(i.text) ? 'это начало: дальше — по вкусу, шаг скажет, когда пробовать' : null].filter(Boolean).join('; ') || null } : i)) };
  // S45: солёная замена (фета вместо гауды, ветчина вместо курицы) — соли в блюдо меньше на ту соль, что принёс
  // новый продукт (salt_per_100g профиля), но не меньше трети строки
  const salt0 = r.ingredients.find((i) => i.key === 'salt' && !i.derived && !i.for);
  if (salt0 && swapped.length) {
    let extra = 0;
    const why = [];
    for (const sw of swapped) {
      const ing = slotOf(r, sw.slot);
      const d = ((ing?.grams || 0) * (kitchen?.profiles?.[sw.to]?.salt_per_100g || 0) - (ing?.replaced?.grams || 0) * (kitchen?.profiles?.[sw.from]?.salt_per_100g || 0)) / 100;
      if (d > 0.3) { extra += d; why.push(String(sw.to_ru).replace(/^([А-ЯЁA-Z])(?=[а-яёa-z])/, (c) => c.toLowerCase())); }
    }
    if (extra > 0) {
      const g = Math.max(salt0.grams * 0.3, salt0.grams - extra);
      r.ingredients = r.ingredients.map((i) => (i === salt0 ? { ...i, grams: Math.round(g * 10) / 10, note: [i.note, `меньше обычного: ${why.join(', ')} — солёное`].filter(Boolean).join('; ') } : i));
    }
  }
  // у нового способа есть жидкость, а связанной воды в рецепте нет (картофель → рис) — добавляем слот воды;
  // связанная вода, которая новому способу не нужна (рис → картофель), уходит из рецепта
  for (const st of card.steps.filter((x) => x.use)) {
    const ing = slotOf(r, st.use);
    const prof = kitchen?.profiles?.[ing?.key];
    const m = prof?.methods?.[methodFor(prof, card, st, env, env.hasTool || (() => true))];
    const has = r.ingredients.some((x) => isLiquidOf(x, st.use));
    if (m?.liquid && !has) {
      r.ingredients = [...r.ingredients, { id: `${st.use}_water`, key: 'water', name_ru: 'Вода', name_de: 'Wasser', grams: 0, basic: true, optional: false, note: null, derived: { from: st.use, by: 'liquid' }, added: true }];
    }
    if (!m?.liquid && has && ing.replaced) r.ingredients = r.ingredients.filter((x) => !isLiquidOf(x, st.use));
    // соль в воду (S02, S03): у способа есть норма соли — строка «Соль (в воду…)» считается от воды или продукта
    // (карточная строка соли этого продукта становится производной; нет её — добавляется)
    const saltOf = (x) => x.key === 'salt' && (x.for === st.use || x.derived?.from === st.use);
    // в ту же воду идёт бульонный кубик — он солёный, соль не добавляем
    const stock = card.steps.filter((x) => x.use === st.use).some((x) => Object.values(x.with || {}).some((v) => refsOf(String(v)).some((y) => slotOf(r, y.id)?.key === 'stock_cube')));
    if (m?.salt && !stock) {
      const where = m.salt.label || (m.salt.per === 'liquid' ? 'в воду для варки' : 'в воду');
      // продукт заменён (рис → паста) — и подпись строки по новому способу: «Соль (в воду для варки)»
      if (r.ingredients.some(saltOf)) r.ingredients = r.ingredients.map((x) => (saltOf(x) ? { ...x, derived: { from: st.use, by: 'salt' }, for: st.use, ...(ing?.replaced ? { name_ru: `Соль (${where})` } : {}) } : x));
      else r.ingredients = [...r.ingredients, { id: `${st.use}_salt`, key: 'salt', name_ru: `Соль (${where})`, name_de: 'Salz', grams: 0, basic: true, optional: false, note: null, for: st.use, derived: { from: st.use, by: 'salt' }, added: true }];
    }
    // вода от варки для соуса (S03): нужна, если её кто-то берёт («отложенной воды от варки») — одно число в списке
    if (m?.reserve && !r.ingredients.some((x) => x.key === 'water' && x.for === st.use && !x.derived)) {
      const wanted = card.steps.some((x) => x.act === 'toss_in_sauce' || /от варки/.test(JSON.stringify([x.text, x.with, x.late])));
      if (wanted) r.ingredients = [...r.ingredients, { id: `${st.use}_reserve`, key: 'water', name_ru: 'Вода от варки (отложить)', name_de: 'Kochwasser', grams: Math.round(((ing?.grams || 0) * m.reserve.g_per_kg) / 1000 / 10) * 10, basic: true, optional: false, note: null, for: st.use, added: true }];
    }
    if (m?.salt && stock) {
      // соль не нужна
    } else if (!m?.salt && ing?.replaced) {
      // новому способу соль в воду не нужна (рис → картофель в духовке): производная строка уходит
      r.ingredients = r.ingredients.filter((x) => !(saltOf(x) && x.derived?.by === 'salt'));
    }
  }
  const { steps: raw, methods, errors, push: push0 } = expandSteps(r, card, env);
  r._methods = Object.fromEntries(Object.entries(methods).filter(([k]) => !k.includes('#')));
  // производные количества (жидкость к крупе) — по пропорции нового способа
  r.ingredients = r.ingredients.map((ing) => (ing.derived ? { ...ing, grams: ing.derived.by === 'salt' ? Math.round(slotGrams(r, ing, 1, kitchen) * 10) / 10 : Math.round(slotGrams(r, ing, 1, kitchen)) } : ing));
  // вода, на которую после замены не ссылается ни один шаг (вода для картофеля, а теперь рис), — из списка
  if (swapped.length) {
    // вода и соль «для картофеля» (ингредиент с for) — уходят, если картофель заменён продуктом другой роли
    // (рис, паста) и шаги на них больше не ссылаются
    const used0 = new Set(raw.flatMap(allRefs));
    const cross = new Set(swapped.filter((x) => kitchen?.profiles?.[x.from]?.role !== kitchen?.profiles?.[x.to]?.role).map((x) => x.slot));
    r.ingredients = r.ingredients.filter((i) => !(i.for && cross.has(i.for)) || used0.has(slotId(i)));
  }
  if (swapped.length && env.base) {
    const used = new Set(raw.flatMap(allRefs));
    const before = new Set(env.base.steps.flatMap(allRefs));
    // базовое (вода, соль), которое было нужно только замененному продукту (вода и соль для картофеля), — из списка
    r.ingredients = r.ingredients.filter((i) => !(i.basic || i.key === 'water') || used.has(slotId(i)) || !before.has(slotId(i)));
  }
  // в блюде несколько компонентов — шаг профиля без названия продукта («Сними с огня и оставь под крышкой»)
  // начинается с него: «Рис: сними с огня…»
  const multi = new Set(raw.filter((x) => x.track !== 'finish' && !x.background).map((x) => x.track)).size > 1;
  for (const s of raw) {
    if (multi && s.ctx.self && s.use && !/\{[qanN]:self/.test(s.tpl || '')) s.tpl = `{N:self}: ${s.tpl[0].toLowerCase()}${s.tpl.slice(1)}`;
  }
  for (const s of raw) {
    s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
    if (s.why) s.why = renderText(r, s.why, { ...s.ctx, kitchen, cap: false }).text;
    if (s.note) s.note = renderText(r, s.note, { ...s.ctx, kitchen }).text;
    s.slots = stepRefs(s);
    s.tools = softTools(s.text);
  }
  // S45: сливочное масло вместо растительного — оно горит на сильном огне: шаги в этой посуде — не сильнее среднего
  assignVessels(raw, r, kitchen);
  for (const sw of swapped.filter((x) => x.to === 'butter' || x.to === 'ghee')) {
    const first = raw.find((x) => isHeat(x) && !x.oven && (allRefs(x).includes(sw.slot) || String(x.ctx?.with?.fat || '').split('*')[0] === sw.slot));
    if (!first) continue;
    for (const x of raw.slice(raw.indexOf(first))) {
      if (x.track !== first.track || x.vessel !== first.vessel || x.oven || !/сильный/.test(String(x.heat))) continue;
      x.heat = 'средний';
      x.note = [x.note, 'Сливочное масло на сильном огне горит и чернеет — огонь средний, жарь на 1–2 минуты дольше.'].filter(Boolean).join(' ');
      x.tpl = x.tpl.replace(/(средне-)?сильн(ый|ом)( огон[ья]| огне)/g, (m, a, end, tail) => `средн${end === 'ом' ? 'ем' : 'ий'}${tail}`);
      if (/сильн/.test(String(x.ctx?.with?.heat || ''))) x.ctx = { ...x.ctx, with: { ...x.ctx.with, heat: 'средний' } };
      x.text = renderText(r, x.tpl, { ...x.ctx, kitchen }).text;
    }
  }
  // соль и перец числом в шагах, где солят, и «попробуй и досоли» — как и сколько (S46)
  for (const s of seasonSteps(raw, r)) {
    s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
    s.slots = stepRefs(s);
  }
  if (r.done_when?.serve) r.done_when = { ...r.done_when, serve: seasonServe(r.done_when.serve, r) };
  assignVessels(raw, r, kitchen);
  attachSafety(r, raw, kitchen, methods, env.hasTool);
  // S24: намазывание — чем и на чём, твёрдое масло (spread_hint профиля — в шаг, где этот продукт мажут)
  for (const ing of r.ingredients) {
    const hint = kitchen?.profiles?.[ing.key]?.spread_hint;
    if (!hint) continue;
    const id = slotId(ing);
    for (const x of raw) {
      if (isHeat(x) || !allRefs(x).includes(id) || !/намаж/.test(String(x.text).toLowerCase()) || x.tpl.includes(hint)) continue;
      x.tpl = `${x.tpl.replace(/\s+$/, '')} ${hint}`;
      x.text = renderText(r, x.tpl, { ...x.ctx, kitchen }).text;
    }
  }
  // S27: смазать форму — чем и как (grease_hint жира — в шаг «смажь форму / ячейки / бумагу»)
  for (const ing of r.ingredients) {
    const hint0 = kitchen?.profiles?.[ing.key]?.grease_hint;
    if (!hint0) continue;
    const hint = pickTools(hint0, env.hasTool);
    const id = slotId(ing);
    for (const x of raw) {
      if (isHeat(x) || !allRefs(x).includes(id) || !/смажь/.test(String(x.text).toLowerCase()) || String(x.note || '').includes(hint)) continue;
      // подсказка — под шагом: в тексте «смажь форму и высыпь перец» она разорвала бы порядок действий
      x.note = [x.note, hint].filter(Boolean).join(' ');
    }
  }
  // L: подсказка под шагом, где с продуктом делают что-то особое (step_hints профиля: «выжми сок» лимона — как без
  // соковыжималки и куда косточки), если шаг не из профиля этого продукта
  for (const ing of r.ingredients) {
    const hs = kitchen?.profiles?.[ing.key]?.step_hints;
    if (!hs) continue;
    const id = slotId(ing);
    for (const x of raw) {
      if (!allRefs(x).includes(id) || x.ctx?.self === id) continue;
      for (const hh of hs) {
        const hint = pickTools(hh.text, env.hasTool);
        if (new RegExp(hh.when).test(String(x.text).toLowerCase()) && !String(x.note || '').includes(hint)) x.note = [x.note, hint].filter(Boolean).join(' ');
      }
    }
  }
  // заметка к продукту в списке ингредиентов («хлеб целым куском — нарежь ломтиками толщиной с палец»)
  r.ingredients = r.ingredients.map((ing) => {
    const n = kitchen?.profiles?.[ing.key]?.ingredient_note;
    return n && !String(ing.note || '').includes(n) ? { ...ing, note: [ing.note, n].filter(Boolean).join('; ') } : ing;
  });
  // S17: пробный кусочек для горячего масла — продукт следующего шага этой дорожки («кусочек лука»)
  raw.forEach((s, i) => {
    if (s.origin !== 'act:heat_fat' || s.ctx.with?.probe) return;
    const next = raw.slice(i + 1).find((x) => x.track === s.track && !x.background && (x.slots || []).length);
    const id = next ? next.ctx?.self || next.slots.find((y) => !kitchen?.profiles?.[slotOf(r, y)?.key]?.role?.match(/fat|spice|seasoning/)) : null;
    const role = id ? kitchen?.profiles?.[slotOf(r, id)?.key]?.role : null;
    const [nom, acc] = !id ? ['кусочек того, что будешь жарить', 'кусочек того, что будешь жарить']
      : role === 'egg' || role === 'dairy' || role === 'sauce' ? [`капля {n:${id}.gen}`, `каплю {n:${id}.gen}`]
        : role === 'grain' || role === 'pasta' ? [`несколько зёрен {n:${id}.gen}`, `несколько зёрен {n:${id}.gen}`]
          : [`кусочек {n:${id}.gen}`, `кусочек {n:${id}.gen}`];
    s.ctx = { ...s.ctx, with: { ...s.ctx.with, probe: nom, probe_acc: acc } };
  });
  // S09: что сделать заранее из-за свойств купленного товара (H-молоко из шкафа — в холодильник с вечера);
  // cold — только если продукт едят холодным (ни один шаг с огнём его не греет)
  r.ahead = [];
  for (const ing of r.ingredients) {
    const a = kitchen?.profiles?.[ing.key]?.ahead;
    if (!a) continue;
    const id = slotId(ing);
    // «холодное молоко»: в шаге с этим продуктом или в финале блюда сказано «холодн…»
    const nom = String(kitchen?.measures?.[ing.key]?.ru?.nom || ing.name_ru || '').toLowerCase();
    const cold = raw.some((x) => !isHeat(x) && (x.slots || []).includes(id) && /холодн/.test(String(x.text).toLowerCase()))
      || (card.done_when?.signs || []).some((t) => /холодн/.test(String(t).toLowerCase()) && (String(t).includes(`{n:${id}`) || String(t).toLowerCase().includes(nom)));
    if (a.when === 'cold' && !cold) continue;
    // «намазать» (S24): сливочное масло мажут — достать заранее
    if (a.when === 'spread' && !raw.some((x) => !isHeat(x) && allRefs(x).includes(id) && /намаж|мажь/.test(String(x.text).toLowerCase()))) continue;
    if (!r.ahead.includes(a.text)) r.ahead.push(a.text);
  }
  // в посуде ещё сырое мясо — «попробуй» на этом шаге нельзя: признак-вкус убираем
  for (const s of raw) if ((s.safety || []).some((x) => x.stage === 'partial') && (s.cues || []).some((c) => c.type === 'taste')) s.cues = s.cues.filter((c) => c.type !== 'taste');
  // горячая вода и кипяток (S47): где её нигде не греют — шаг «вскипяти» перед первым использованием
  hotWater(raw, r, env, push0);
  // порядок внутри дорожек до таймлайна: нарезка — до огня или пока на огне что-то идёт само (S43), подготовка
  // овощей раньше сырого мяса (S13), «сразу следующий» (S39). Специи для «расцвета» в масле (S14) отмеряются в шаге
  // «Достань и отмерь» перед огнём
  const meat = rawSlots(r, kitchen);
  prepBeforeFire(raw);
  rawMeatLast(raw, meat);
  markGlue(raw);
  assignVessels(raw, r, kitchen);
  // жарка в занятой посуде (S21): «сдвинь лук к краю и на свободное место выложи…», «добавь к луку»
  for (const s of occupiedPan(raw, r, kitchen)) s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
  // посуда — ресурс (S40): кастрюля и сковорода по одной. Две дорожки в одной посуде одновременно: если одна
  // освобождает посуду (чай залили кипятком, макароны откинули) — она целиком раньше другой; иначе нужна вторая
  const cons = [];
  const plan0 = () => timesOf(raw, { after: cons.map((c) => ({ step: raw.indexOf(c.step), then: raw.indexOf(c.then), full: !!c.full })) });
  let t = plan0();
  const second = new Set();
  for (let n = 0; n < 4; n++) {
    const cs = vesselConflicts(raw, t.plan);
    if (!cs.length) break;
    let added = false;
    for (const { v, a, b } of cs) {
      // обе освобождают посуду — первой та, что дольше занимает посуду: короткая (чай) — свежей к подаче
      const first = a.rel != null && b.rel != null ? (a.to - a.from >= b.to - b.from ? a : b) : a.rel != null ? a : b.rel != null ? b : null;
      const then = first === a ? b : a;
      // S40: второй кастрюли нет — гарнир (рис) варится первым и ждёт в тарелке под тарелкой, посуда — другой дорожке
      if (!first && !env.hasTool(SECOND[v])) {
        const hold = holdable(raw, [a, b], v, r, kitchen);
        if (hold && !raw.some((x) => x.hold_one && x.track === hold.track) && holdOne(raw, hold, v, r, kitchen, push0)) {
          added = true;
          break;
        }
      }
      if (!first || cons.some((c) => c.step === raw[first.rel] && c.then === raw[then.first])) { second.add(v); continue; }
      const relStep = raw[first.rel];
      cons.push({ step: relStep, then: raw[then.first], full: (relStep.time?.passive?.[1] || 0) > 0 });
      added = true;
    }
    if (!added) break;
    t = plan0();
  }
  // гарнир ждёт дольше 30 минут — убрать в холодильник и прогреть перед подачей в сковороде (если она свободна)
  if (reheatOne(raw, t.plan, r, kitchen, push0, allRefs)) t = plan0();
  // нарезка не во время жарки другой дорожки (S43): подготовка — до начала огня той дорожки
  for (let n = 0; n < 4; n++) {
    let added = false;
    for (const c of prepClashes(raw, t.plan)) {
      if (cons.some((x) => x.step === c.step && x.then === c.then)) continue;
      cons.push(c);
      added = true;
    }
    if (!added) break;
    t = plan0();
  }
  // гигиена после сырого мяса (S13): «вымой руки, нож, доску» перед первым шагом с тем, что едят без готовки
  for (let n = 0; n < 4; n++) {
    const need = hygieneNeeds(raw, t.plan, meat);
    if (!need.length) break;
    for (const i of [...new Set(need)].sort((a, b) => b - a)) raw.splice(i + 1, 0, hygieneStep(raw[i], raw, meat));
    t = plan0();
  }
  // таймлайн: порядок шагов и что идёт параллельно
  const plan = t.plan;
  // связанные шаги (attach, glue) — сразу за своим предыдущим шагом дорожки
  const order = [...plan.order];
  raw.forEach((s, i) => {
    if (!s.attach && !s.glue) return;
    const prev = raw.slice(0, i).map((x, j) => j).filter((j) => raw[j].track === s.track && !raw[j].background).pop();
    if (prev == null) return;
    order.splice(order.indexOf(i), 1);
    order.splice(order.indexOf(prev) + 1, 0, i);
  });
  const ordered = order.map((i) => ({ ...raw[i], at: plan.at[i], parallel: runningDuring(plan, raw, i).map((j) => order.indexOf(j)) }));
  // «Достань и отмерь» — первым шагом перед огнём (S43; после «включи духовку», если она греется с самого начала)
  if (ordered.some((x) => isHeat(x) && !x.background)) {
    const pos = ordered[0]?.background && ordered[0].at.start < 0.01 ? 1 : 0;
    const D = [1, 2, 3];
    for (const x of ordered) {
      x.parallel = x.parallel.map((j) => (j >= pos ? j + 1 : j));
      if (!(x.background && x.at.start < 0.01)) x.at = { start: x.at.start + D[1], activeEnd: x.at.activeEnd + D[1], end: x.at.end + D[1] };
    }
    const at0 = pos ? ordered[0].at.activeEnd : 0;
    ordered.splice(pos, 0, { kind: 'mise', track: ordered.find((x) => !x.background)?.track || 'main', slots: [], tpl: '', text: '', ctx: { with: {} }, time: { active: [1, 3], passive: [0, 0] }, at: { start: at0, activeEnd: at0 + D[1], end: at0 + D[1] }, parallel: [] });
    t.total += D[1];
    t.total_range = [t.total_range[0] + D[0], t.total_range[1] + D[2]];
    t.passive = Math.max(0, t.total - t.active);
    // «Пока рис на огне, нарежь…» (S43)
    for (const x of markWhile(ordered, r, kitchen)) x.text = renderText(r, x.tpl, { ...x.ctx, kitchen }).text;
    // «Сложи на тарелку — понадобится в шаге N» (S32): что идёт в посуду одним шагом — на одну тарелку
    const before = new Map(ordered.map((x) => [x, x.tpl]));
    const plates = placeCut(ordered, meat, env.hasTool('bowl'), allRefs);
    for (const x of ordered) if (before.get(x) !== x.tpl) x.text = renderText(r, x.tpl, { ...x.ctx, kitchen }).text;
    const mise = miseStep(ordered, r, kitchen, { meat, hasTool: env.hasTool, plates, refs: allRefs, fracOf });
    Object.assign(ordered[pos], mise, { at: ordered[pos].at, parallel: [] });
    ordered[pos].text = renderText(r, mise.tpl, { ...mise.ctx, kitchen }).text;
  }
  // S16: «Пока духовка греется (10–15 минут), делай шаги N–M» — что успеть до того, как ставить форму
  ordered.forEach((p, k) => {
    if (p.origin !== 'act:preheat_oven' || !p.at) return;
    const js = ordered.map((x, j) => j).filter((j) => j > k && !ordered[j].oven && !ordered[j].background && ordered[j].at && ordered[j].at.start < p.at.end - 0.5);
    if (!js.length) return;
    const [a, b] = [js[0] + 1, js[js.length - 1] + 1];
    p.tpl = `${p.tpl.replace(/\s+$/, '')} Пока она греется (${p.time.passive[0]}–${p.time.passive[1]} минут), ${a === b ? `делай шаг ${a}` : `делай шаги ${a}–${b}`} — ставить в духовку будешь потом.`;
    p.text = renderText(r, p.tpl, { ...p.ctx, kitchen }).text;
  });
  ordered.forEach((s) => { s.timer_min = timerOf(s); });
  // шаг, который нельзя начинать, пока не закончился предыдущий шаг своей дорожки (таймер): «сначала дождись шага N»
  // (предыдущий — тот, что заканчивается позже всех: «вымой руки» идёт, пока мясо в духовке)
  ordered.forEach((s, k) => {
    const prev = ordered.slice(0, k).filter((x) => x.track === s.track && !x.background).reduce((a, x) => (!a || x.at.end > a.at.end ? x : a), null);
    if (prev && prev.time.passive[1] > 0 && s.track !== 'finish' && !s.attach) s.wait_for = ordered.indexOf(prev);
    if (s.track === 'finish' && k > 0) {
      const last = ordered.slice(0, k).filter((x) => x.track !== 'finish' && !x.background && x.time.passive[1] > 0 && x.at.end > s.at.start - 0.5);
      if (last.length && !ordered.slice(0, k).some((x) => x.track === 'finish')) s.wait_for = ordered.indexOf(last[last.length - 1]);
    }
  });
  // S11: то, что не едят (лавровый лист), — достать перед подачей: в первый шаг подачи, если шаги сами не говорят
  for (const ing of r.ingredients) {
    const rm = kitchen?.profiles?.[ing.key]?.remove_before_serving;
    const id = slotId(ing);
    if (!rm || !ordered.some((x) => x.kind !== 'mise' && allRefs(x).includes(id))) continue;
    if (ordered.some((x) => x.kind !== 'mise' && /(вынь|достань|убери|выбрось)[^.]*лавров/.test(String(x.text).toLowerCase()))) continue;
    const T = ordered.find((x) => x.track === 'finish') || ordered[ordered.length - 1];
    if (!T) continue;
    const m = T.tpl.match(/^(\{N:self\}:\s)(.*)$/s);
    const add = rm.replace(/\{n:self/g, `{n:${id}`);
    T.tpl = m ? `${add} ${m[1]}${m[2]}` : `${add} ${T.tpl}`;
    T.text = renderText(r, T.tpl, { ...T.ctx, kitchen }).text;
    if (!(T.slots || []).includes(id)) T.slots = [...(T.slots || []), id];
  }
  // S40: гарнир ждёт в тарелке — до какого шага; дольше 30 минут — в холодильник и прогреть в сковороде
  for (const R of ordered.filter((x) => x.hold_one)) {
    const k = ordered.indexOf(R);
    const U = ordered.slice(k + 1).find((x) => x.track !== R.track && allRefs(x).includes(R.hold_slot));
    const end = Math.max(...ordered.map((x) => x.at?.end ?? 0));
    const wait = Math.round((U ? U.at.start : end) - R.at.end);
    const until = U ? `до шага ${ordered.indexOf(U) + 1}` : 'до подачи';
    const warm = U?.origin === 'act:reheat_side';
    // тёплый рис дольше часа на столе держать нельзя (Bacillus cereus) — в холодильник, когда перестанет парить
    const fridge = wait > 60 ? ' Когда перестанет парить (минут через 20–30), убери в холодильник: тёплым дольше часа не держи.' : '';
    R.tpl = `${R.tpl.replace(/\s+$/, '')} ${wait <= HOLD_MIN ? `Пусть ждёт ${until}.`
      : `Пусть ждёт ${until} — это ≈ ${wait} минут, остынет.${fridge} ${warm ? `В шаге ${ordered.indexOf(U) + 1} прогреешь в сковороде.` : 'Перед едой прогрей до пара.'}`}`;
    R.text = renderText(r, R.tpl, { ...R.ctx, kitchen }).text;
  }
  // выключить конфорку и духовку после последнего шага с огнём (S37, S25) — в шаблон шага
  // горячая форма в духовку и из неё (S15): достать прихватками, поставить не на стол, вернуть на ту же полку
  const moves = ovenMoves(ordered, env.hasTool);
  for (const s of moves.changed) s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
  for (const s of heatOff(ordered, moves.left)) s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
  // смена огня словами: «Убавь огонь под сковородой до среднего» (S48)
  for (const s of heatShift(ordered)) s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
  // готовое ждёт своего шага — накрыть, оставить в тепле или переложить (S50)
  for (const s of holdWarm(ordered, env.hasTool)) s.text = renderText(r, s.tpl, { ...s.ctx, kitchen }).text;
  // «можно отойти» — только если нигде нет огня под присмотром (S38)
  markLeave(ordered);
  // ссылка «дойдёт на шаге N» для неготового мяса
  ordered.forEach((s) => (s.safety || []).forEach((x) => {
    if (x.stage === 'partial') x.final_step = ordered.findIndex((o) => (o.safety || []).some((y) => y.slot === x.slot && y.stage === 'final'));
  }));
  r.steps = ordered;
  r.time = { ...t, prep: t.active, cook: t.passive };
  delete r.time.plan;
  // руками по нормам повара — для предела недели (S53): новичку показываем честное время, план — как раньше
  const mid = (x) => (x[0] + x[1]) / 2;
  r.time.active_pro = Math.round(ordered.filter((x) => !x.chore && x.time).reduce((a, x) => a + mid((x.time_pro || x.time).active), 0));
  // посуда: способы ингредиентов добавляют обязательную утварь
  const tools = [...(card.tools || [])];
  for (const [slot, name] of Object.entries(r._methods)) {
    const m = kitchen?.profiles?.[slotOf(r, slot)?.key]?.methods?.[name];
    for (const tl of (m?.equipment || []).filter((x) => HARD.has(x))) if (!tools.some((g) => g.includes(tl))) tools.push(ALT[tl] || [tl]);
  }
  // вторая кастрюля или сковорода: две вещи готовятся в ней одновременно (S40) — видно заранее, в плане без неё не будет
  for (const v of second) {
    const id = v === 'pot' ? 'pot2' : 'pan2';
    if (!tools.some((g) => g.includes(id))) tools.push([id]);
  }
  r.tools = tools;
  // нет прихваток, нет формы (этап 8а): «сухим полотенцем, сложенным в несколько слоёв», «на противне» — во всех текстах
  adaptRecipe(r, env.hasTool);
  // посуда (S29): собирается из шагов (посуда для огня, форма, утварь в тексте, нарезка) + ручные добавки карточки;
  // названия — из одного словаря (core/equipment.js)
  r.gear = buildGear(r, card, env.hasTool);
  r.equipment = r.gear.map(gearLabel);
  // S73: «Зачем», признаки, «Если передержал», «Безопасность» — под посуду, способ и продукты этого рецепта
  tailorSteps(r);
  Object.assign(r, recount(card, r, products));
  // одна упаковка — одна строка (S54): масло «для мяса» и «для овощей», соль в воду и в блюдо — один продукт в цене
  r.cost_breakdown = mergeCost(r.cost_breakdown, products);
  // у одного продукта в списке — одно немецкое название (Rapsöl и Sonnenblumenöl для одного «растительного масла»)
  const de = {};
  r.ingredients = r.ingredients.map((i) => (de[i.key] ??= i.name_de) === i.name_de ? i : { ...i, name_de: de[i.key] });
  r.warnings = [];
  if (r.time.active_pro > ACTIVE_LIMIT) r.warnings.push(`активной готовки ≈ ${r.time.active} мин — больше ${ACTIVE_LIMIT}`);
  // мясо должно было дойти в блюде, а блюдо после замены готовится быстрее (кускус запаривают 5 минут) —
  // мясо дожаривается до готовности сразу: способ «обжарить» меняется на «жарить до готовности»
  if (!env.ctxOverride) {
    const over = {};
    for (const [slot, name] of Object.entries(r._methods)) {
      const ing = slotOf(r, slot);
      const meth = kitchen?.profiles?.[ing?.key]?.methods?.[name];
      if (!meth?.finishes_later || !meth.finish_min) continue;
      const own = r.steps.filter((x) => x.ctx?.self === slot && isHeat(x));
      const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === slot && y.stage === 'final'));
      const t = own.length && fin && fin !== own[own.length - 1] ? fin.at.end - own[own.length - 1].at.end : Infinity;
      const ctx = FALLBACK[card.steps.find((x) => x.use === slot)?.context];
      if (t < meth.finish_min[0] - 0.5 && ctx) over[slot] = ctx;
    }
    if (Object.keys(over).length) {
      const again = compile(card, { ...env, ctxOverride: over });
      again.adapted = Object.keys(over);
      return again;
    }
  }
  // мясо, которое доходит в блюде, а блюдо после замены готовится дольше: грудка станет суше — одна строка
  for (const [slot, name] of Object.entries(r._methods)) {
    const ing = slotOf(r, slot);
    const meth = kitchen?.profiles?.[ing?.key]?.methods?.[name];
    if (!meth?.finishes_later || !meth.finish_max) continue;
    const own = r.steps.filter((x) => x.ctx?.self === slot && isHeat(x));
    const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === slot && y.stage === 'final'));
    const t = own.length && fin ? Math.round(fin.at.end - own[own.length - 1].at.end) : 0;
    if (t > meth.finish_max[1]) r.warnings.push(`${ing.name_ru.toLowerCase()} пробудет в блюде ≈ ${t} мин — станет суше (ей хватает до ${meth.finish_max[1]} мин): для долгого блюда лучше филе бёдер`);
  }
  r.errors = errors;
  // тексты вне шагов — под замену: название, описание, финал, ошибки, хранение, подписи строк (S44)
  // S74: каждый пункт «Частых ошибок» — к шагу, где её можно сделать (показывается в режиме готовки);
  // пункты о заменённом продукте — не про новый
  bindMistakes(r, card, env.base, kitchen);
  if (swapped.length) renameAfterSwap(r, card, kitchen, products, env.base?._methods || null);
  attachTips(r);
  // S76: числа в описании — из расчёта (белок порции, время, «быстрый» — только если за 30 минут)
  r.description = describe(r.description, r);
  // какие шаги изменились после замен
  if (swapped.length && env.base) {
    const before = new Set(env.base.steps.map(sig));
    r.steps.forEach((s) => { s.changed = !before.has(sig(s)); });
  }
  r.compiled = true;
  return r;
}

// Варианты замены слота: из data/substitutes.json, только совместимые (роль, способ для контекста, утварь, исключения)
export function subOptions(card, id, env) {
  const { kitchen, products = {}, substitutes = {}, hasTool = defaultKitchen } = env;
  const ing = card.ingredients.find((i) => slotId(i) === id);
  if (!ing || ing.key === 'water') return [];
  const from = kitchen?.profiles?.[ing.key];
  const uses = card.steps.filter((s) => s.use === id);
  return (substitutes[ing.key] || []).map(([key, note]) => {
    const prof = kitchen?.profiles?.[key];
    const p = products[key];
    let reason = null;
    if (!p?.packs?.length) reason = 'нет в магазинах';
    else if (!allowedProduct(key, p)) reason = 'исключено';
    else if (!prof || !from) reason = 'нет профиля приготовления';
    else if (card.ingredients.some((x) => x.key === key)) reason = 'уже есть в блюде';
    else {
      const sameRole = prof.role === from.role;
      for (const s of uses) {
        const cross = STARCH.has(prof.role) && STARCH.has(from.role) && s.context === 'side';
        if (!sameRole && !cross) { reason = 'другая роль в блюде'; break; }
        if (!pickMethod(prof, s.context, null, () => true)) { reason = 'так не готовят'; break; }
        if (!pickMethod(prof, s.context, null, hasTool)) { reason = 'нужна посуда, которой нет'; break; }
      }
      if (!uses.length && !sameRole) reason = 'другая роль в блюде';
      // S24: продукт мажут на хлеб, а замена не мажется (растительное масло вместо сливочного)
      if (!reason && prof.spreadable === false && card.steps.some((x) => new RegExp(`\\{[qanN]:${id}[.*}]`).test(JSON.stringify([x.text, x.with])) && /намаж|мажь/.test(String(x.text).toLowerCase()))) reason = 'не намазывается';
      // мясо, которое доходит в блюде: после обжарки должно быть не меньше finish_min минут на огне
      if (!reason && uses.length) {
        const r = compile(card, { ...env, subs: { [id]: key } });
        if (r.errors.length) reason = 'так не готовят';
        for (const s of uses) {
          const meth = prof.methods[r._methods[id]];
          if (reason || !meth?.finishes_later || !meth.finish_min) continue;
          const mine = r.steps.filter((x) => x.ctx?.self === id && (x.heat || x.oven));
          const fin = r.steps.find((x) => (x.safety || []).some((y) => y.slot === id && y.stage === 'final'));
          const last = mine[mine.length - 1];
          if (last && fin && fin !== last && fin.at.end - last.at.end < meth.finish_min[0] - 0.5) reason = `не успеет дойти: в блюде ${Math.round(fin.at.end - last.at.end)} мин, нужно от ${meth.finish_min[0]}`;
        }
      }
    }
    return { key, name_ru: p?.name_ru || key, note: prof?.note_as_sub || note || null, allowed: !reason, reason };
  });
}

// Что изменится до подтверждения замены
export function previewSub(card, subs, id, key, env) {
  const base = compile(card, { ...env, subs });
  const next = compile(card, { ...env, subs: { ...subs, [id]: key }, base: compile(card, { ...env, subs: {} }) });
  const a = base.ingredients.find((i) => slotId(i) === id);
  const b = next.ingredients.find((i) => slotId(i) === id);
  const m0 = base._methods[id];
  const m1 = next._methods[id];
  return {
    base, recipe: next,
    time: next.time.total - base.time.total,
    active: next.time.active - base.time.active,
    kcal: next.per_serving.kcal - base.per_serving.kcal,
    protein: Math.round((next.per_serving.protein - base.per_serving.protein) * 10) / 10,
    cost: round2(next.per_serving.cost - base.per_serving.cost),
    from: a, to: b,
    method: m0 !== m1 ? { from: m0, to: m1 } : null,
    changedSteps: next.steps.filter((s) => s.changed).length,
    warnings: next.warnings.filter((w) => !base.warnings.includes(w)),
    note: env.kitchen?.profiles?.[key]?.note_as_sub || null,
  };
}
