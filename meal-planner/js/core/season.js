// Соль и перец числом в каждом шаге, где солят (S46). Вызывается из compile.js; тексты — через шаблон tpl, поэтому
// количество пересчитывается при любом числе порций.
//   «Посоли и поперчи голени» → «Посоли (1 чайная ложка) и поперчи (2 щепотки) голени»: строка «Соль» из списка
//   делится между шагами, где солят без количества (то, что уже стоит в других шагах подстановкой, не трогаем);
//   «Попробуй и досоли» → как пробовать горячее и сколько добавить, если пресно.
import { slotId, refsOf } from './cookbook.js';

const lc = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
// глагол, после которого ставится количество: «посоли», «солью и перцем»; «посоли щепоткой» — количество уже есть
const SALT_AT = /(^|[^а-яё])([Пп]осоли|[Пп]одсоли)(?![а-яё])(?!\s*(щепотк|\(|\{a:))/;
const SALT_WITH = /(^|[^а-яё])солью(?![а-яё])(?!\s*\()/;
const PEPPER_AT = /(^|[^а-яё])([Пп]оперчи)(?![а-яё])(?!\s*(щепотк|\(|\{a:))/;
const PEPPER_WITH = /(солью(?: \([^)]*\))? и )перцем(?![а-яё])/;
// «Попробуй и досоли», «Попробуй дал и досоли», «попробуй, посоли и поперчи», «Попробуй и досоли по вкусу — кубик уже солёный»
const TASTE = /([Пп])опробуй( [^.,:]{1,30}?)?(?:,| и) (?:до|по)соли(?:,? и поперчи)?(?: по вкусу)?( — (?:бульонный )?кубик уже солёный)?/;
const SALTY = /кубик|сыр|фет|ветчин|колбас|соев|оливк|бекон|каперс/;

// slots — { salt, pepper }: общие строки соли и перца (не «соль в воду для риса»)
function seasonSlots(r) {
  const pick = (key) => r.ingredients.find((i) => i.key === key && !i.derived && !i.for) || null;
  return { salt: pick('salt'), pepper: pick('black_pepper') };
}

// Сколько слота уже разложено по шагам (доли из подстановок)
function usedShare(steps, id) {
  let a = 0;
  for (const s of steps) {
    let f = 0;
    for (const k of places(s)) for (const x of refsOf(getAt(s, k))) if ((x.kind === 'q' || x.kind === 'a') && x.id === id) f = Math.max(f, x.frac);
    a += f;
  }
  return a;
}

// Где в шаге слово: в шаблоне или в параметре with, который в него подставляется («, посоли и поперчи» в {x:extra})
function places(s) {
  const used = new Set([...String(s.tpl || '').matchAll(/\{x:([^}]+)\}/g)].map((m) => m[1]));
  return [null, ...Object.keys(s.ctx?.with || {}).filter((k) => used.has(k) && typeof s.ctx.with[k] === 'string')];
}
const getAt = (s, k) => (k == null ? s.tpl : s.ctx.with[k]);
function setAt(s, k, v) {
  if (k == null) s.tpl = v;
  else s.ctx = { ...s.ctx, with: { ...s.ctx.with, [k]: v } };
}
const findIn = (s, re) => places(s).find((k) => re.test(getAt(s, k)));

// steps — шаги до таймлайна (raw), с tpl. Меняет tpl (или параметр with); → изменённые шаги
export function seasonSteps(steps, r) {
  const slots = seasonSlots(r);
  const changed = new Set();
  // количество этого продукта в шаге уже есть: подстановка меры {q:…}/{a:…} (название {n:…} — не количество)
  const qRefs = (s) => places(s).flatMap((k) => refsOf(getAt(s, k)).filter((x) => x.kind === 'q' || x.kind === 'a').map((x) => (x.id === 'self' ? s.ctx?.self : x.id)));
  const hasKey = (s, key) => qRefs(s).some((id) => r.ingredients.find((i) => slotId(i) === id)?.key === key);
  const round = (f) => Math.round(f * 100) / 100;
  // доля строки списка — подстановкой; совсем мало осталось (строка уже разложена по другим шагам) — словами
  const amount = (ing, f, words) => (ing && f >= 0.05 ? `{a:${slotId(ing)}${Math.abs(f - 1) < 0.01 ? '' : `*${round(f)}`}}` : words);
  const has = (s, re) => findIn(s, re) !== undefined;
  const taste = steps.filter((s) => s.kind !== 'mise' && has(s, TASTE));
  // доли: проба в конце — четверть того, что не разложено (или всё, если больше нигде не солят), остальное — поровну
  // шагам, где солят без количества; сумма долей не больше строки списка
  const share = {};
  for (const [key, AT, WITH] of [['salt', SALT_AT, SALT_WITH], ['black_pepper', PEPPER_AT, PEPPER_WITH]]) {
    const ing = key === 'salt' ? slots.salt : slots.pepper;
    const naked = steps.filter((s) => s.kind !== 'mise' && !taste.includes(s) && (has(s, AT) || has(s, WITH)) && !hasKey(s, key));
    const tasted = key === 'salt' ? taste : taste.filter((s) => /поперчи/.test(getAt(s, findIn(s, TASTE)).match(TASTE)[0]));
    const left = ing ? Math.max(0, 1 - usedShare(steps.filter((s) => !naked.includes(s) && !tasted.includes(s)), slotId(ing))) : 0;
    const forTaste = tasted.length ? (naked.length ? left * 0.25 : left) : 0;
    const forNaked = naked.length ? (left - forTaste) / naked.length : 0;
    share[key] = { ing, naked, AT, WITH, taste: forTaste / Math.max(1, tasted.length), each: forNaked };
  }
  // 1) «Попробуй и досоли» — как пробовать горячее и сколько добавить, если пресно
  for (const s of taste) {
    const k = findIn(s, TASTE);
    const [all, P, what, cube] = getAt(s, k).match(TASTE);
    const S = share.salt;
    const B = share.black_pepper;
    const add = amount(S.ing, S.taste, 'ещё щепотку-другую соли');
    const salty = cube || SALTY.test(lc(steps.filter((x) => x.track === s.track || x.track === 'finish').map((x) => x.text).join(' ')));
    const pp = /поперчи/.test(all) ? `, поперчи (${amount(B.ing, B.taste, 'щепотка перца')})` : '';
    setAt(s, k, getAt(s, k).replace(all, `${P}опробуй${what || ''}: зачерпни чайной ложкой, подуй и подожди полминуты — горячее на вкус не понять. Пресно — досоли (${add})${pp}, перемешай и попробуй ещё раз${salty ? '; в блюде уже есть солёное — сначала проба, потом соль' : ''}`));
    changed.add(s);
  }
  // 2) «посоли», «поперчи», «с маслом и солью», «солью и перцем» без количества
  for (const [key, x] of Object.entries(share)) {
    const words = key === 'salt' ? 'щепотка' : 'щепотка';
    for (const s of x.naked) {
      const a = findIn(s, x.AT);
      if (a !== undefined) setAt(s, a, getAt(s, a).replace(x.AT, (all, pre, verb) => `${pre}${verb} (${amount(x.ing, x.each, words)})`));
      else {
        const w = findIn(s, x.WITH);
        setAt(s, w, getAt(s, w).replace(x.WITH, (all, pre) => (key === 'salt' ? `${pre}солью (${amount(x.ing, x.each, words)})` : `${pre}перцем (${amount(x.ing, x.each, words)})`)));
      }
      changed.add(s);
    }
  }
  return [...changed];
}

// Финал блюда («Подача: попробуй и досоли») — тот же текст пробы
export function seasonServe(text, r) {
  const { salt, pepper } = seasonSlots(r);
  const m = String(text || '').match(TASTE);
  if (!m) return text;
  const [all, P, what] = m;
  const add = salt ? `{a:${slotId(salt)}*0.25}` : 'четверть чайной ложки соли';
  const pep = /поперчи/.test(all) && pepper ? `, поперчи ({a:${slotId(pepper)}*0.5})` : '';
  return text.replace(all, `${P}опробуй${what || ''}: зачерпни чайной ложкой и подуй. Пресно — досоли (${add})${pep} и перемешай`);
}

