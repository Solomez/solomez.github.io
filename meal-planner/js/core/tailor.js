// S73: шаблонные тексты шага вне основного — «Зачем», признаки, «Как проверить», «Ещё не готово», «Если передержал»,
// «Безопасность», «Когда таймер прозвенит» — под этот рецепт: его посуду, способ и продукты.
//
//   {v}, {v:gen} …            — посуда шага в падеже: сковорода / кастрюля / форма / противень (неизвестна — «посуда»);
//                               {v:в}, {v:из} — с предлогом: «в форме» / «на противне», «из формы» / «с противня»
//   {w:acc} …                 — другая посуда на плите (у шага в сковороде — кастрюля, и наоборот)
//   {f:текст|иначе}           — другая посуда на плите в рецепте не нужна (свободна): у новичка одна кастрюля и одна
//                               сковорода, «переложи в чистую посуду» — только если она правда есть
//   {o:в духовке|на плите}    — шаг в духовке или на плите
//   {h:ключи:текст|иначе}     — в рецепте есть один из продуктов (ключи через запятую; @sauce — в блюде есть соус;
//                               @cooked — продукт шага дальше готовится, а не едят сырым; @pan / @oven — жарят
//                               в сковороде / запекают)
//
// Скобки вкладываются, части — по «|» верхнего уровня. Кроме того, в шаге на плите слово другой посуды из общего
// шаблона («раздави о край сковороды» в кастрюле с луком) меняется на посуду шага — все они женского рода.
import { TOOL } from './equipment.js';

const CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'prep'];
export const VESSEL_FORMS = {
  pan: ['сковорода', 'сковороды', 'сковороде', 'сковороду', 'сковородой', 'сковороде'],
  pot: ['кастрюля', 'кастрюли', 'кастрюле', 'кастрюлю', 'кастрюлей', 'кастрюле'],
  dish: ['форма', 'формы', 'форме', 'форму', 'формой', 'форме'],
  tray: ['противень', 'противня', 'противню', 'противень', 'противнем', 'противне'],
  any: ['посуда', 'посуды', 'посуде', 'посуду', 'посудой', 'посуде'],
};
// соус в блюде: эти продукты или слово «соус» в шагах (творог, скир, йогурт — часто в массе или к подаче: только по слову)
const SAUCE_KEYS = new Set(['passata', 'tomatoes_can', 'tomato_paste', 'sour_cream', 'cream', 'pesto', 'soy_sauce', 'sriracha', 'coconut_milk']);

// {X:…} с вложенными скобками → fn(части) ; части — по «|» верхнего уровня
function expand(text, kind, fn) {
  const s = String(text ?? '');
  const open = `{${kind}`;
  if (!s.includes(open)) return s;
  let out = '';
  let i = 0;
  for (;;) {
    let at = s.indexOf(open, i);
    while (at >= 0 && !/[:}]/.test(s[at + open.length] || '')) at = s.indexOf(open, at + 1);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    let depth = 0;
    let j = at;
    const cuts = [];
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) break; } else if (s[j] === '|' && depth === 1) cuts.push(j);
    }
    const from = at + open.length + (s[at + open.length] === ':' ? 1 : 0);
    const parts = [from, ...cuts.map((c) => c + 1)].map((a, k) => s.slice(a, k < cuts.length ? cuts[k] : j));
    out += fn(parts);
    i = j + 1;
  }
  return out;
}

// {v:в} / {v:из} — с предлогом: «в сковороде», «на противне»; «из формы», «с противня»
// продукт шага (свой слот) дальше готовится на огне или в духовке — а не едят сырым
// @pan, @oven — продукт шага дальше жарят в сковороде / запекают
const cooked = (r, s, how = null) => !!s.ctx?.self && r.steps.some((x) => (x.heat || x.oven) && (x.slots || []).includes(s.ctx.self)
  && (!how || (how === 'oven' ? !!x.oven : x.vessel === 'pan' && !x.oven)));
const formOf = (v, cas) => {
  const F = VESSEL_FORMS[v] || VESSEL_FORMS.any;
  if (cas === 'в') return `${v === 'tray' ? 'на' : 'в'} ${F[5]}`;
  if (cas === 'из') return `${v === 'tray' ? 'с' : 'из'} ${F[1]}`;
  return F[Math.max(0, CASES.indexOf(cas || 'nom'))];
};
const keep = (src, word) => (/^[А-ЯЁ]/.test(src) ? word[0].toUpperCase() + word.slice(1) : word);

// Посуда шага в духовке: противень, если шаг о нём говорит или в рецепте нет формы
function ovenVessel(r, s) {
  const t = String(s.text || '').toLowerCase();
  if (TOOL.tray.re.test(t)) return 'tray';
  if (TOOL.baking_dish.re.test(t)) return 'dish';
  const ids = new Set((r.gear || []).map((g) => g.id));
  return ids.has('tray') && !ids.has('baking_dish') ? 'tray' : 'dish';
}

export function tailorText(text, { r, s, keys, sauce, free }) {
  if (typeof text !== 'string' || !text) return text;
  const v = s.vessel === 'oven' ? ovenVessel(r, s) : s.vessel || null;
  const other = v === 'pan' ? 'pot' : v === 'pot' ? 'pan' : null;
  let t = text;
  // слово другой посуды из общего шаблона — посуда шага (сковорода ↔ кастрюля); до подстановок: {w} — другая посуда
  if (v === 'pan' || v === 'pot') {
    const from = VESSEL_FORMS[v === 'pan' ? 'pot' : 'pan'];
    const to = VESSEL_FORMS[v];
    t = t.replace(new RegExp(`(?<![а-яё])(${[...new Set(from)].join('|')})(?![а-яё])`, 'gi'), (w) => keep(w, to[from.indexOf(w.toLowerCase())]));
  }
  t = expand(t, 'h', ([head = '', no = '']) => {
    const m = head.match(/^([@\w,-]+):([\s\S]*)$/);
    const want = m ? m[1].split(',') : [];
    const ok = want.some((k) => (k === '@sauce' ? sauce : k === '@cooked' ? cooked(r, s) : k === '@pan' ? cooked(r, s, 'pan') : k === '@oven' ? cooked(r, s, 'oven') : keys.has(k)));
    return tailorText(ok ? (m ? m[2] : '') : no, { r, s, keys, sauce, free });
  });
  t = expand(t, 'o', ([oven = '', stove = '']) => tailorText(s.oven ? oven : stove, { r, s, keys, sauce, free }));
  t = expand(t, 'f', ([yes = '', no = '']) => tailorText(other && free.has(other) ? yes : no, { r, s, keys, sauce, free }));
  t = expand(t, 'v', ([cas = '']) => formOf(v || 'any', cas.trim()));
  t = expand(t, 'w', ([cas = '']) => formOf(other || 'any', cas.trim()));
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').replace(/;\s*\./g, '.');
}

// Подстановка для одного шага рецепта: (текст) → текст под этот рецепт и этот шаг
export function tailorFor(r, s0) {
  const keys = new Set(r.ingredients.map((i) => i.key));
  const sauce = r.ingredients.some((i) => SAUCE_KEYS.has(i.key)) || r.steps.some((s) => /соус|подлив/.test(String(s.text || '').toLowerCase()));
  // посуда на плите, которая рецепту не нужна вовсе, — свободна
  const used = new Set(r.steps.map((s) => s.vessel).filter(Boolean));
  const free = new Set(['pan', 'pot'].filter((v) => !used.has(v)));
  // посуда шага без своего огня («расцвет» специй: «сними сковороду с огня…») — из параметра vessel или по
  // соседнему шагу с огнём той же дорожки
  let s = s0;
  if (!s0.vessel) {
    const k = r.steps.indexOf(s0);
    const p = String(s0.ctx?.with?.vessel || '').toLowerCase();
    const near = [...r.steps.slice(0, Math.max(0, k)).reverse(), ...r.steps.slice(k + 1)].find((x) => x.track === s0.track && x.vessel && x.vessel !== 'oven');
    const v = /сковород/.test(p) ? 'pan' : /кастрюл/.test(p) ? 'pot' : near?.vessel || null;
    if (v) s = { ...s0, vessel: v };
  }
  const o = { r, s, keys, sauce, free };
  return (x) => tailorText(x, o);
}

// Все тексты шагов рецепта вне основного — под рецепт
export function tailorSteps(r) {
  for (const s0 of r.steps) {
    const T = tailorFor(r, s0);
    for (const f of ['why', 'check', 'on_timer']) if (s0[f]) s0[f] = T(s0[f]);
    if (s0.cues) s0.cues = s0.cues.map((c) => ({ ...c, text: T(c.text) }));
    if (s0.not_ready?.text) s0.not_ready = { ...s0.not_ready, text: T(s0.not_ready.text) };
    if (s0.overdone) s0.overdone = { ...s0.overdone, signs: T(s0.overdone.signs), rescue: T(s0.overdone.rescue) };
    if (s0.safety) s0.safety = s0.safety.map((x) => (x.check ? { ...x, check: T(x.check) } : x));
  }
}
