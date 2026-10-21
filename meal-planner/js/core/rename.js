// Замена продукта и тексты вне шагов (S44): название (рус. и нем.), описание, «Блюдо готово, когда…», «Частые
// ошибки», «Хранение», подписи производных строк («Вода для риса» → «Вода для булгура»). Шаги собираются из
// профиля нового продукта (compile.js), а эти тексты карточки называют продукт словами — их пересобираем по
// падежам из data/kitchen/measures.json. Вызывается из compile.js, когда есть замены.

const lc = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
const CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'prep'];
const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

// Формы продукта по падежам: measures.json → ru; иначе название из products (только именительный)
function formsOf(key, kitchen, products) {
  const ru = kitchen?.measures?.[key]?.ru;
  if (ru?.nom) return Object.fromEntries(CASES.map((c) => [c, ru[c] || ru.nom]));
  const n = String(products?.[key]?.name_ru || '').toLowerCase().replace(/\s*\(.*\)$/, '');
  return n ? Object.fromEntries(CASES.map((c) => [c, n])) : null;
}

// Заменить в тексте формы старого продукта формами нового (тот же падеж; заглавная — как была). Подстановки {…}
// не трогаем. → { text, hit }
export function swapWords(text, from, to) {
  if (!text || !from || !to) return { text, hit: false };
  // форма → падеж (первый, где она встречается); длинные формы раньше коротких
  const byForm = new Map();
  for (const c of CASES) if (!byForm.has(lc(from[c]))) byForm.set(lc(from[c]), c);
  const forms = [...byForm.keys()].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
  if (!forms.length) return { text, hit: false };
  const re = new RegExp(`(^|[^а-яёa-z{:-])(${forms.map((f) => esc(f).replace(/е/g, '[её]')).join('|')})(?![а-яёa-z-])`, 'gi');
  let hit = false;
  // род по творительному падежу («-ом» — мужской/средний, «-ой» — женский, «-ами» — множественное): другой род у
  // нового продукта — прилагательное перед ним («с отварным картофелем») не согласуется, его убираем
  const kind = (f) => (/(ами|ями)$/.test(lc(f.ins)) ? 'pl' : /(ой|ей|ью)$/.test(lc(f.ins)) ? 'f' : 'm');
  const regender = kind(from) !== kind(to);
  const out = String(text).split(/(\{[^}]*\})/).map((part) => (part.startsWith('{') ? part : part.replace(re, (all, pre, word, at, str) => {
    // одинаковая форма в разных падежах («сметане» — дательный и предложный): падеж по предлогу перед словом
    const same = CASES.filter((x) => lc(from[x]) === lc(word));
    const prev = lc(str.slice(0, at + pre.length)).match(/([а-яё]+)\s*$/)?.[1];
    const PREP = { prep: /^(в|во|на|о|об|при)$/, ins: /^(с|со|за|под|над|между)$/, gen: /^(для|из|без|от|до|у|около)$/, dat: /^(к|ко|по)$/, acc: /^(про|через)$/ };
    const c = same.find((x) => PREP[x]?.test(prev || '')) || byForm.get(lc(word));
    if (!c) return all;
    hit = true;
    const w = to[c];
    return pre + (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w);
  }).replace(regender ? new RegExp(`(^|\\s)[а-яё]+(?:ым|им|ой|ей|ую|юю|ая|яя|ое|ее|ий|ый|ых|их|ые|ие|ого|его|ому|ему)\\s+(?=(?:${[...new Set(CASES.map((c) => esc(to[c])))].join('|')})(?![а-яё]))`, 'gi') : /$^/, (all, sp) => sp))).join('');
  // убрали прилагательное в начале фразы — заглавная у следующего слова
  const cap = /^[А-ЯЁA-Z]/.test(String(text)) ? out.replace(/^([а-яё])/, (c) => c.toUpperCase()) : out;
  return { text: cap, hit };
}

// r — собранный рецепт с r.swapped; меняет тексты на месте
export function renameAfterSwap(r, card, kitchen, products, baseMethods = null) {
  for (const sw of r.swapped || []) {
    const from = formsOf(sw.from, kitchen, products);
    const to = formsOf(sw.to, kitchen, products);
    if (!from || !to) continue;
    // другая роль (рис → картофель) — пункты «Частых ошибок» и признаки финала про старый продукт не подходят
    const cross = kitchen?.profiles?.[sw.from]?.role !== kitchen?.profiles?.[sw.to]?.role || !!(baseMethods?.[sw.slot] && r._methods?.[sw.slot] && r._methods[sw.slot] !== baseMethods[sw.slot]);
    const sw1 = (t) => swapWords(t, from, to);
    const mentions = (t) => swapWords(t, from, to).hit;
    // название: «Рис карри…» → «Булгур карри…»; старый продукт в названии другим словом («рисовый боул») — пометка
    const t = sw1(r.title);
    r.title = t.text;
    const stem = lc(from.nom).slice(0, Math.max(3, lc(from.nom).length - 1));
    if (!t.hit && from.nom.length >= 3 && lc(r.title).split(/[^а-яё]+/).some((w) => w.startsWith(stem))) r.title = `${r.title} (${/^с[^аеёиоуыэюя]/i.test(to.ins) ? 'со' : 'с'} ${to.ins} вместо ${from.gen})`;
    if (t.hit || r.title !== card.title) {
      const de = (k) => String(products?.[k]?.name_de_generic || '').split(/\s*[/(]/)[0].trim();
      if (r.title_de && de(sw.to) && de(sw.from)) r.title_de = `${r.title_de} (mit ${de(sw.to)} statt ${de(sw.from)})`;
    }
    r.description = sw1(r.description).text;
    if (Array.isArray(r.mistakes)) {
      // шаг пункта (S74) — тот же индекс в r.mistake_steps
      let idx = r.mistakes.map((m, i) => i);
      if (cross && idx.some((i) => !mentions(r.mistakes[i]))) idx = idx.filter((i) => !mentions(r.mistakes[i]));
      if (r.mistake_steps) r.mistake_steps = idx.map((i) => r.mistake_steps[i]);
      r.mistakes = idx.map((i) => sw1(r.mistakes[i]).text);
    }
    if (r.storage) r.storage = Object.fromEntries(Object.entries(r.storage).map(([k, v]) => [k, typeof v === 'string' ? sw1(v).text : v]));
    if (r.done_when) {
      const signs = r.done_when.signs || [];
      const keep = cross ? signs.filter((x) => !mentions(x)) : signs;
      r.done_when = {
        ...r.done_when,
        signs: (keep.length >= 2 ? keep : signs).map((x) => sw1(x).text),
        serve: sw1(r.done_when.serve).text,
        rest: r.done_when.rest ? { ...r.done_when.rest, why: sw1(r.done_when.rest.why).text } : r.done_when.rest,
      };
    }
    // подписи строк, привязанных к продукту: «Вода для риса», «Соль (в рис)»
    r.ingredients = r.ingredients.map((i) => (i.replaced || !(i.derived || i.for) ? i : { ...i, name_ru: sw1(i.name_ru).text }));
  }
}
