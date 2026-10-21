// Кухонная утварь: что есть дома и что нужно рецепту.
// Обязательная (hard) — без неё блюдо не приготовить: его нет в подборе. Заменимая — можно обойтись: движок
// пишет шаг без неё ({t:тёрка|с ней|без неё}) или под шагом подсказка, как обойтись (WORKAROUND).
// Один словарь посуды (S75): одно название предмета в списке «Посуда», в «Дома не хватает», в профиле.

const lc = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
// \b в JS не видит границ кириллических слов — границы явно
const W = '(?![а-яе])';
const B = '(^|[^а-яе])';

// name — в списке «Посуда»; ru — в профиле «Что есть на кухне»; re — как предмет называют в шагах;
// alt — чем обойтись (коротко, для «Дома не хватает»); hint — подсказка под шагом, если предмета нет;
// price — ориентир цены в Австрии (недорогой вариант: IKEA, Billa, Kik; оценка, не прайс), для «купить при случае»
export const TOOLS = [
  { id: 'oven', ru: 'Духовка', label: 'Духовка (с противнем и решёткой)', en: 'Oven', de: 'Backofen', hard: true, re: /духовк/ },
  { id: 'pan', ru: 'Сковорода', en: 'Frying pan', de: 'Pfanne', hard: true, re: new RegExp(`сковород|${B}вок${W}`) },
  { id: 'pot', ru: 'Кастрюля', en: 'Pot', de: 'Kochtopf', hard: true, re: /кастрюл|сотейник|ковш/ },
  // противень и решётка идут с духовкой (так в австрийских духовках): в профиле отдельной строки нет, есть духовка —
  // есть противень (has); в «Посуде» — «Противень (идёт с духовкой)»
  { id: 'tray', ru: 'Противень', en: 'Baking tray', de: 'Backblech', hard: true, with_oven: true, re: /противен|противн/ },
  { id: 'blender', ru: 'Блендер', en: 'Blender', de: 'Mixer / Stabmixer', hard: true, re: /блендер/, price: '≈ €20' },
  { id: 'microwave', ru: 'Микроволновка', en: 'Microwave', de: 'Mikrowelle', hard: true, def: false, re: /микроволн/, price: '≈ €60' },
  // вторая кастрюля или сковорода — для блюд, где две вещи готовятся одновременно (гуляш и рис)
  { id: 'pot2', ru: 'Вторая кастрюля', en: 'Second pot', de: 'zweiter Kochtopf', hard: true, def: false, price: '≈ €10' },
  { id: 'pan2', ru: 'Вторая сковорода', en: 'Second frying pan', de: 'zweite Pfanne', hard: true, def: false, price: '≈ €12' },
  // форма для запекания — утварь кухни, по умолчанию ЕСТЬ (решение пользователя, 2026-10-20); кто снимет отметку —
  // блюдо, которое можно запечь на противне (не жидкое), шаги пишут «на противне»; жидкому (запеканка из яиц, рис или
  // чечевица с бульоном, соус) форма обязательна — в tools у него [baking_dish] ("oven_dish": "form"), без неё его нет в подборе
  { id: 'baking_dish', ru: 'Форма для запекания', en: 'Baking dish', de: 'Auflaufform', plan: true, def: true, price: '≈ €5–8', re: new RegExp(`${B}форм(а|у|е|ы|ой|ам|ах)?${W}|ячейк`),
    alt: 'противень с бумагой для выпечки или фольгой — для жидкого блюда не подойдёт' },
  // можно обойтись: по умолчанию их нет (новичок: плита, одна сковорода, одна кастрюля, духовка, блендер, нож, доска)
  { id: 'lid', ru: 'Крышка', en: 'Lid', de: 'Deckel', price: '≈ €3', re: /крышк/, alt: 'накрыть тарелкой, противнем или фольгой',
    hint: { cover: 'Нет крышки — накрой большой плоской тарелкой или противнем (он закроет и сковороду); можно фольгой, прижав её по краю.' } },
  { id: 'sieve', ru: 'Дуршлаг или сито', en: 'Colander / sieve', de: 'Nudelsieb / Sieb', price: '≈ €3', first: 'без него сливать кипяток опаснее всего', re: new RegExp(`${B}сит(о|е|а|у|ом)${W}|дуршлаг`), alt: 'выловить вилкой и ложкой, потом слить воду (есть крышка — через щель у крышки)',
    hint: {
      rinse: 'Нет дуршлага и сита — промой прямо в кастрюле: залей холодной водой, перемешай рукой и аккуратно слей в раковину, придерживая крупу ладонью. Повтори 2–3 раза.',
      drain: 'Нет дуршлага — кипяток через край не сливай: выложи вилкой и ложкой в глубокую тарелку, потом слей воду в раковину (есть крышка — можно через щель у прижатой крышки; у консервов — приоткрытой крышкой банки); кастрюлю бери прихватками за обе ручки, лей от себя.',
      sift: 'Нет сита — посыпай муку тонким слоем через пальцы, всё время помешивая, чтобы не было комков.',
    } },
  { id: 'grater', ru: 'Тёрка', en: 'Grater', de: 'Reibe', price: '≈ €3', re: /терк/, alt: 'мелко нарезать ножом',
    hint: { grate: 'Нет тёрки — нарежь как можно мельче ножом.', zest: 'Нет тёрки — тонко срежь ножом только жёлтый слой кожуры и мелко поруби.' } },
  { id: 'bowl', ru: 'Миска', en: 'Mixing bowl', de: 'Schüssel', price: '≈ €2', re: /миск/, alt: 'глубокая тарелка или свободная кастрюля',
    hint: { any: 'Нет миски — возьми глубокую тарелку, а для большого количества — кастрюлю, если она сейчас свободна.' } },
  { id: 'spatula', ru: 'Лопатка', en: 'Spatula', de: 'Pfannenwender', price: '≈ €2', re: new RegExp(`${B}лопатк(ой|у|и|а)${W}`), alt: 'столовая ложка',
    hint: { any: 'Нет лопатки — мешай и переворачивай столовой ложкой (куски — вилкой, придерживая ложкой).' } },
  { id: 'whisk', ru: 'Венчик', en: 'Whisk', de: 'Schneebesen', price: '≈ €2', re: /венчик/, alt: 'вилка', hint: { any: 'Нет венчика — взбивай вилкой, быстро, круговыми движениями.' } },
  { id: 'peeler', ru: 'Овощечистка', en: 'Peeler', de: 'Sparschäler', price: '≈ €2', re: /овощечистк/, alt: 'нож', hint: { any: 'Нет овощечистки — срезай кожуру ножом тонкой полоской, от себя.' } },
  { id: 'press', ru: 'Пресс для чеснока', en: 'Garlic press', de: 'Knoblauchpresse', price: '≈ €4', re: new RegExp(`${B}пресс(ом|а)?${W}`), alt: 'нож',
    hint: { any: 'Нет пресса — раздави зубчик плоской стороной ножа и очень мелко поруби.' } },
  { id: 'masher', ru: 'Толкушка', en: 'Potato masher', de: 'Kartoffelstampfer', price: '≈ €3', re: /толкушк/, alt: 'вилка', hint: { any: 'Нет толкушки — разомни вилкой или дном крепкой кружки.' } },
  { id: 'towels', ru: 'Бумажные полотенца', en: 'Paper towels', de: 'Küchenrolle', price: '≈ €2', re: /бумажн\S* (полотен|салфет)/, alt: 'чистое кухонное полотенце',
    hint: { any: 'Нет бумажных полотенец — промокни чистым кухонным полотенцем; если на нём был сок сырого мяса — сразу в стирку.' } },
  { id: 'kettle', ru: 'Чайник', en: 'Kettle', de: 'Wasserkocher', price: '≈ €15', re: /чайник/, alt: 'вскипятить в кастрюле', hint: { any: 'Нет чайника — вскипяти воду в кастрюле на сильном огне.' } },
  { id: 'foil', ru: 'Фольга', en: 'Foil', de: 'Alufolie', price: '≈ €2', re: /фольг/, alt: 'перевёрнутая большая тарелка',
    hint: { any: 'Нет фольги — накрой перевёрнутой большой тарелкой.' } },
  { id: 'paper', ru: 'Бумага для выпечки', en: 'Baking paper', de: 'Backpapier', price: '≈ €2', re: /бумаг\S* для выпечки|пекарск\S* бумаг|пергамент/, alt: 'смазать маслом',
    hint: { any: 'Нет бумаги для выпечки — смажь противень или форму тонким слоем масла (кисточкой, ложкой или кусочком полотенца).' } },
  { id: 'tongs', ru: 'Щипцы', en: 'Tongs', de: 'Küchenzange', price: '≈ €3', re: /щипц/, alt: 'вилка и ложка', hint: { any: 'Нет щипцов — переворачивай вилкой, придерживая ложкой.' } },
  // прихватки — утварь кухни, по умолчанию нет (этап 8а): в каждом шаге — сухое полотенце в несколько слоёв (S15)
  { id: 'mitts', ru: 'Прихватки', en: 'Oven mitts', de: 'Topfhandschuhe', price: '≈ €4', re: /прихватк/, alt: 'сухое кухонное полотенце, сложенное в несколько слоёв (мокрое пропускает жар)',
    hint: { any: 'Нет прихваток — бери горячее сухим кухонным полотенцем, сложенным в несколько слоёв; мокрое пропускает жар и обожжёт.' } },
  { id: 'brush', ru: 'Кисточка', en: 'Pastry brush', de: 'Backpinsel', price: '≈ €2', re: /кисточк/, alt: 'ложка', hint: { any: 'Нет кисточки — размазывай ложкой.' } },
];
export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

// По умолчанию — как в исходных условиях: плита, одна сковорода, одна кастрюля, духовка (с противнем), форма для запекания, блендер, нож и доска.
// Остального (микроволновки, второй кастрюли, крышки, тёрки, дуршлага, миски, лопатки, чайника…) нет, пока не отмечено.
export const DEFAULT_EQUIPMENT = Object.fromEntries(TOOLS.map((t) => [t.id, t.hard ? t.def !== false : t.def === true]));
// Так было до этапа «посуда» (схема 2): крышка, тёрка и дуршлаг считались, а лишь микроволновки и второй посуды не было.
// У тех, кто уже сохранил свою кухню, эти отметки сохраняются (state.js, migrateStored).
export const OLD_DEFAULT_TRUE = ['lid', 'grater', 'sieve'];
// Так было до этапа 8а (схема 4): форма для запекания и прихватки считались (state.js, migrateStored, схема 5)
export const OLD_DEFAULT_TRUE_5 = ['baking_dish', 'mitts'];

// нож и доска есть всегда; неизвестное — считаем, что есть; противень — если есть духовка
export const has = (equipment, id) => {
  if (TOOL[id]?.with_oven && equipment?.[id] === undefined) return has(equipment, 'oven');
  return (equipment?.[id] ?? DEFAULT_EQUIPMENT[id]) !== false;
};

// Каких обязательных вещей не хватает для рецепта: [[варианты], ...] → названия
export function missingTools(recipe, equipment) {
  return (recipe.tools || []).filter((g) => !g.some((id) => has(equipment, id))).map((g) => g.map((id) => TOOL[id]?.ru || id).join(' или '));
}
export const canCook = (recipe, equipment) => missingTools(recipe, equipment).length === 0;

// ---------- шаг: выбор формулировки по кухне ----------
// {t:тёрка|натри на тёрке|нарежь ножом} — первая часть, если предмет есть, вторая — если нет (может быть пустой).
// Части могут содержать подстановки {n:…} и вложенные {t:…}. used: { has: Set, lack: Set } — что шаг использует
// и чего ему не хватило (для списка «Посуда» и «Дома не хватает»).
export function pickTools(text, hasTool = () => true, used = null) {
  const s = String(text ?? '');
  if (!s.includes('{t:')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('{t:', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    // конец {t:…} с учётом вложенных скобок; части — по «|» верхнего уровня
    let depth = 0;
    let j = at;
    const cuts = [];
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) break; } else if (s[j] === '|' && depth === 1) cuts.push(j);
    }
    const body = [at + 3, ...cuts.map((c) => c + 1)].map((from, k) => s.slice(from, k < cuts.length ? cuts[k] : j));
    const [id, yes = '', no = ''] = body;
    const ok = hasTool(id.trim());
    if (used) (ok ? used.has : used.lack).add(id.trim());
    out += pickTools(ok ? yes : no, hasTool, used);
    i = j + 1;
  }
  return out;
}

// ---------- нет прихваток, нет формы: слова в готовом тексте (этап 8а) ----------
// Литеральные «прихватками», «форму» в текстах профилей, действий, карточек и движка (flow.js) — под кухню: прихваток
// нет — сухое полотенце в несколько слоёв (мокрое пропускает жар); формы нет, а блюдо можно запечь на противне —
// «на противне», «с противня». Что заменили — в lack (список «Посуда» и «Дома не хватает»).
const MITT_LONG = 'сухим кухонным полотенцем, сложенным в несколько слоёв (мокрое пропускает жар)';
const MITT_SHORT = 'сухим сложенным полотенцем';
const cap = (src, out) => (/^[А-ЯЁ]/.test(src) ? out[0].toUpperCase() + out.slice(1) : out);
function noMitts(t, lack) {
  let n = 0;
  const out = t
    .replace(/(сухими |сухой )?прихватками/gi, (m) => { n++; return cap(m, n === 1 ? MITT_LONG : MITT_SHORT); })
    .replace(/(сухой )?прихваткой/gi, (m) => { n++; return cap(m, MITT_SHORT); })
    .replace(/в прихватках/gi, (m) => { n++; return cap(m, 'через сухое сложенное полотенце'); })
    .replace(/прихватки(?![а-яё])/gi, (m) => { n++; return cap(m, 'сухое кухонное полотенце (вместо прихваток)'); });
  if (n) lack.add('mitts');
  return out;
}
// «держит форму», «сохранили форму», «форму шарика» — не посуда
const NOT_DISH = /(держ|сохран|потер|теря|не держ)\S*\s*$/;
function noForm(t, lack) {
  let n = 0;
  let out = t
    .replace(/(на противн(?:е|ь)) или (?:в|на) форм(?:е|у)(?![а-яё])/gi, '$1')
    .replace(/(?:в|на) форм(?:е|у) или (на противн(?:е|ь))/gi, (m, x) => cap(m, x))
    .replace(/форм(?:у|а) или противень|противень или форм(?:у|а)(?![а-яё])/gi, (m) => cap(m, 'противень'));
  const sw = (re, to) => {
    out = out.replace(re, (m, pre, w, i, all) => {
      if (NOT_DISH.test(all.slice(Math.max(0, i - 16), i + pre.length)) || /^\s*(шарик|котлет)/.test(all.slice(i + m.length))) return m;
      n++;
      return pre + cap(w, typeof to === 'function' ? to(w) : to);
    });
  };
  sw(/(^|[^а-яё])(в форму)(?![а-яё])/gi, 'на противень');
  sw(/(^|[^а-яё])(в форме)(?![а-яё])/gi, 'на противне');
  sw(/(^|[^а-яё])(из формы)(?![а-яё])/gi, 'с противня');
  sw(/(^|[^а-яё])((?:по )?(?:краям|края|дно|дна|дну|стенки) формы)(?![а-яё])/gi, (w) => w.replace(/формы/i, 'противня'));
  sw(/(^|[^а-яё])(форму)(?![а-яё])/gi, 'противень');
  sw(/(^|[^а-яё])(формой)(?![а-яё])/gi, 'противнем');
  if (n) lack.add('baking_dish');
  return out;
}
// form: true — форма есть или блюду она обязательна (текст не трогаем); false — запекаем на противне
export function adaptText(text, { mitts = true, form = true } = {}, lack = new Set()) {
  if (typeof text !== 'string' || !text) return text;
  let t = text;
  if (!mitts && /прихватк/i.test(t)) t = noMitts(t, lack);
  if (!form && /форм/i.test(t)) t = noForm(t, lack);
  return t;
}
// Все тексты собранного рецепта: шаги (шаблон, текст, параметры, «Зачем», подсказки, признаки, проверки), финал, ошибки
export function adaptRecipe(r, hasTool) {
  const opts = { mitts: hasTool('mitts'), form: hasTool('baking_dish') || (r.tools || []).some((g) => g.includes('baking_dish') && !g.includes('tray')) };
  if (opts.mitts && opts.form) return;
  const A = (t, lack) => adaptText(t, opts, lack);
  for (const s of r.steps || []) {
    const lack = new Set();
    s.tpl = A(s.tpl, lack);
    s.text = A(s.text, lack);
    if (s.ctx?.with) s.ctx = { ...s.ctx, with: Object.fromEntries(Object.entries(s.ctx.with).map(([k, v]) => [k, A(v, lack)])) };
    for (const k of ['why', 'note', 'check', 'on_timer']) if (s[k]) s[k] = A(s[k], new Set());
    if (s.cues) s.cues = s.cues.map((c) => ({ ...c, text: A(c.text, new Set()) }));
    if (s.not_ready?.text) s.not_ready = { ...s.not_ready, text: A(s.not_ready.text, new Set()) };
    if (s.overdone) s.overdone = { ...s.overdone, signs: A(s.overdone.signs, new Set()), rescue: A(s.overdone.rescue, new Set()) };
    if (s.safety) s.safety = s.safety.map((x) => (x.check ? { ...x, check: A(x.check, new Set()) } : x));
    if (lack.size) {
      s.gear_lack = [...new Set([...(s.gear_lack || []), ...lack])];
      s.tools = softTools(s.text);
    }
  }
  if (r.done_when) r.done_when = { ...r.done_when, signs: (r.done_when.signs || []).map((t) => A(t, new Set())), serve: A(r.done_when.serve, new Set()) };
  if (r.mistakes) r.mistakes = r.mistakes.map((t) => A(t, new Set()));
}

// Заменимая утварь в готовом тексте шага: [{ tool, kind }] — для подсказок «нет сита — …» и списка посуды
export function softTools(text) {
  const t = lc(text);
  const uses = [];
  if (/терк/.test(t) && !/не на терк/.test(t)) uses.push({ tool: 'grater', kind: /цедр/.test(t) ? 'zest' : 'grate' });
  // «не промывай» после слива — это слив, а не промывка
  if (TOOL.sieve.re.test(t)) uses.push({ tool: 'sieve', kind: /просей/.test(t) ? 'sift' : /(^|[^а-яе])(слей|сливай|откинь)/.test(t) && /кипят|кастрюл/.test(t) ? 'drain' : /промой|(^|[^а-яе])промывай/.test(t.replace(/не промывай/g, '')) ? 'rinse' : 'drain' });
  // крышка банки и «без крышки» — не крышка посуды
  const lid = t.replace(/без крышк\S*|крышк\S* (от )?банк\S*/g, '');
  if (/крышк/.test(lid)) uses.push({ tool: 'lid', kind: 'cover' });
  // миска для еды («разложи по мискам») — посуда для подачи, не для смешивания
  if (/миск/.test(t.replace(/по мискам|по миск\S*/g, ''))) uses.push({ tool: 'bowl', kind: 'any' });
  // «свиная лопатка» — мясо, не лопатка
  if (TOOL.spatula.re.test(t.replace(/свин\S* лопатк\S*|лопатк\S* свин\S*/g, ''))) uses.push({ tool: 'spatula', kind: 'any' });
  for (const id of ['whisk', 'peeler', 'press', 'masher', 'towels', 'kettle', 'foil', 'paper', 'tongs', 'brush', 'mitts']) if (TOOL[id].re.test(t)) uses.push({ tool: id, kind: 'any' });
  return uses;
}

// Альтернатива уже в тексте шага («нет дуршлага — …», «лопаткой или ложкой») — подсказку второй раз не повторяем
const ALT_IN_TEXT = {
  grater: /нет терки|или (мелко )?(нарежь|поруби)|порви/,
  sieve: /нет (дуршлага|сита)|без дуршлага/,
  lid: /нет крышки|или (большой |плоской )?тарелк/,
  bowl: /нет миски|или (в )?(глубок|тарелк|кастрюл)/,
  spatula: /лопатк\S* или (столов\S* )?ложк|ложк\S* или лопатк|лопатк\S* \(или/,
  whisk: /венчик\S* или вилк|вилк\S* или венчик|нет венчика/,
  towels: /нет бумажн|или (чист\S* )?кухонн/,
  foil: /фольг\S* или|или фольг|нет фольги/,
  paper: /нет бумаги|или смажь/,
  kettle: /чайник\S* или|или (в )?(маленьк\S* )?кастрюл|нет чайника/,
  peeler: /или ножом|нет овощечистки/,
  press: /или (натри|мелко поруби|раздави)|нет пресса/,
  masher: /или вилк|вилк\S* или толкушк|нет толкушки/,
  tongs: /или вилк|нет щипцов/,
  brush: /или ложк|нет кисточки/,
  mitts: /нет прихваток|вместо прихваток|полотенц[^.]{0,40}(сло[её]в|слоя)/,
};

// Подсказки к шагу, если заменимой утвари нет
export function stepHints(step, equipment) {
  const t = lc(step.text);
  return (step.tools || []).filter((u) => !has(equipment, u.tool) && !ALT_IN_TEXT[u.tool]?.test(t))
    .map((u) => TOOL[u.tool]?.hint?.[u.kind] || TOOL[u.tool]?.hint?.any).filter(Boolean);
}

// ---------- список посуды рецепта (S29) ----------
// Собирается из шагов: посуда для огня, духовка и форма, утварь, названная в тексте, то, что шаг выбрал или хотел
// бы ({t:…}), нарезка — «Доска и нож». Плюс ручные добавки карточки (equipment): если это предмет словаря —
// сливается с ним (размер «2–3 л», «Ø 26–28 см» остаётся), иначе остаётся строкой как есть («Кружка»).
const CUT = /нарежь|наруби|порежь|разрежь|нашинкуй|срежь|надрежь|надрез|поруби|очисти|почисть|раздави/;
const SIZE = /Ø\s?\d+(?:[–-]\d+)?\s?см|~?\d+\s?×\s?\d+\s?см|\d+(?:,\d+)?(?:[–-]\d+(?:,\d+)?)?\s?л(?![а-яё])|на \d+ ячеек/g;
const ORDER = ['oven', 'pot', 'pot2', 'pan', 'pan2', 'baking_dish', 'tray', 'blender', 'microwave', 'knife', 'mitts', 'lid', 'sieve', 'grater', 'bowl', 'spatula', 'whisk', 'peeler', 'press', 'masher', 'tongs', 'brush', 'kettle', 'towels', 'foil', 'paper'];
const KNIFE = { id: 'knife', name: 'Доска и нож' };
const SIZED = new Set(['pot', 'pan', 'baking_dish', 'tray']);
export const DISH_OR = /\s+или\s+(в |на )?(форм\S*|противн\S*)/g;

// предметы словаря в строке карточки: «Глубокая сковорода или сотейник (Ø 26–28 см) с крышкой» → pan + lid;
// после «или» — запасной вариант, его не считаем («Скалка или дно кастрюли» — не кастрюля)
function cardItems(str) {
  const l = lc(str);
  const head = l.split(/\s+или\s+|\(или /)[0].replace(/\([^)]*\)/g, '');
  const ids = TOOLS.filter((t) => t.re && t.id !== 'lid' && t.re.test(head)).map((t) => t.id);
  if (/доск/.test(head) || /^нож$/.test(head.trim())) ids.push('knife');
  if (/с крышк|\+ крышк|и крышк/.test(l)) ids.push('lid');
  if (/^крышк/.test(head.trim())) ids.push('lid');
  return ids;
}

export function buildGear(r, card, hasTool = (id) => has({}, id)) {
  const items = new Map();
  const add = (id, from) => {
    if (!items.has(id)) items.set(id, { id, from, details: [] });
    return items.get(id);
  };
  // «на противне или в форме» — подойдёт любое: это одна вещь, а не две
  const text = (s) => lc(s.text).replace(DISH_OR, '');
  for (const s of r.steps || []) {
    if (s.oven) add('oven', 'steps');
    if (s.vessel === 'pot' || s.vessel === 'pan') add(s.vessel, 'steps');
    const t = text(s);
    for (const id of ['pot', 'pan', 'baking_dish', 'tray', 'blender']) if (TOOL[id].re.test(t)) add(id, 'steps');
    for (const u of s.tools || []) add(u.tool, 'steps');
    for (const id of s.gear_lack || []) add(id, 'steps').lack = true;
    if (CUT.test(t)) add('knife', 'steps');
  }
  if (r.done_when?.serve) for (const u of softTools(r.done_when.serve)) add(u.tool, 'steps');
  // горячая форма (S15): у каждого блюда с духовкой — прихватки
  if (items.has('oven')) add('mitts', 'steps');
  // обязательная утварь рецепта: форма или противень, блендер, вторая кастрюля (кастрюля и сковорода на плите
  // взаимозаменяемы — если шаги уже взяли одну из них, вторую не добавляем)
  // вода в чайнике (S47) — кастрюля для неё не нужна
  const stove = items.has('pot') || items.has('pan') || items.has('kettle');
  for (const g of r.tools || []) if (!g.some((id) => items.has(id)) && !(stove && g.every((id) => id === 'pot' || id === 'pan'))) add(g.find((id) => hasTool(id)) || g[0], 'tools');
  // одна кастрюля на два дела (S40): гарнир варится первым и ждёт в тарелке
  const one = {};
  for (const s of r.steps || []) if (s.hold_one) {
    const ing = (r.ingredients || []).find((i) => (i.id || i.key) === s.hold_slot);
    one[s.hold_one] = lc(ing?.name_ru || '').split(/\s|\(/)[0] || 'гарнир';
  }
  // ручные добавки карточки
  const extra = [];
  for (const e of card?.equipment || []) {
    const ids = cardItems(e);
    if (!ids.length) { extra.push(e); continue; }
    // размер — первой посуде строки («Духовка и форма (~20×30 см)» — размер формы); вторая кастрюля карточки
    // («Кастрюля 1,5 л для риса»), когда движок сказал, что нужна вторая, — её размер
    let sized = false;
    for (const id of ids) {
      let it = add(id, 'card');
      if (!sized && SIZED.has(id)) {
        sized = true;
        if (id === 'pot' && it.fromCard && items.has('pot2')) it = items.get('pot2');
        // вторая кастрюля карточки («1,5 л для риса»), а дома одна — рис варится в ней же первым (S40): размер не её
        else if (it.fromCard && one[id]) { it.fromCard = true; continue; }
        for (const m of String(e).matchAll(SIZE)) if (!it.details.includes(m[0])) it.details.push(m[0]);
      }
      it.fromCard = true;
      if (id === 'baking_dish' && /маффин/i.test(e)) it.name = 'Форма для маффинов';
    }
  }
  const gear = [...items.values()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)).map((it) => {
    const t = TOOL[it.id];
    const name = it.name || (it.id === 'knife' ? KNIFE.name : t?.ru || it.id);
    const have = it.id === 'knife' ? true : hasTool(it.id);
    return {
      id: it.id, name, detail: it.details.join(' или ') || null, hard: !!t?.hard, have,
      alt: !have && !t?.hard ? t?.alt || null : null, de: t?.de || null, from: it.from, lack: !!it.lack,
      note: it.id === 'pot2' ? 'две вещи варятся одновременно' : it.id === 'pan2' ? 'две вещи жарятся одновременно'
        : one[it.id] ? `одной хватит: ${one[it.id]} варится первым и ждёт в тарелке` : null,
      with_oven: !!t?.with_oven && hasTool('oven'), price: t?.price || null,
    };
  });
  for (const e of extra) gear.push({ id: null, name: e, detail: null, hard: false, have: true, alt: null, de: null, from: 'card', note: null });
  return gear;
}
// противень идёт с духовкой: «Противень (идёт с духовкой)»
export const gearLabel = (g) => `${g.name}${g.with_oven || g.detail ? ` (${[g.with_oven ? 'идёт с духовкой' : null, g.detail].filter(Boolean).join(', ')})` : ''}${g.note ? ` — ${g.note}` : ''}`;

// Заменимое, чего нет дома: [{ id, name, alt, de }] — для «Дома не хватает» на странице рецепта.
// Предмет, у которого запасной способ уже в тексте каждого шага («лопаткой или ложкой»), — не нехватка.
// Без чего блюдо не приготовить (форма у жидкого блюда) — в «Дома не хватает» обязательной строкой, не здесь.
// Что стоит купить первым (дуршлаг: слив кипятка без него — самое опасное место) — первым, с причиной; у всего — цена-ориентир
export function missingGear(r, equipment) {
  const optional = (id) => {
    const at = (r.steps || []).filter((s) => (s.tools || []).some((u) => u.tool === id));
    return at.length > 0 && at.every((s) => ALT_IN_TEXT[id]?.test(lc(s.text)));
  };
  const hardLack = new Set((r.tools || []).filter((g) => !g.some((id) => has(equipment, id))).flat());
  // «купить первым» — дуршлаг, только если в рецепте сливают кипяток из кастрюли (не жидкость из банки)
  const boilDrain = (r.steps || []).some((s) => (s.tools || []).some((u) => u.tool === 'sieve' && u.kind === 'drain') && /кипят|из кастрюли|кастрюлю/.test(lc(s.text)));
  return (r.gear || []).filter((g) => g.id && !g.hard && g.id !== 'knife' && !has(equipment, g.id) && !hardLack.has(g.id) && (g.lack || !optional(g.id)))
    .map((g) => ({ id: g.id, name: g.name, alt: TOOL[g.id]?.alt || null, de: g.de, price: TOOL[g.id]?.price || null, first: g.id === 'sieve' && boilDrain ? TOOL.sieve.first : null }))
    .sort((a, b) => !!b.first - !!a.first);
}
// Обязательная утварь, которой нет: [{ id, name, de, price }] — для «Дома не хватает: форма для запекания (≈ €5–8)»
export function missingToolItems(recipe, equipment) {
  return (recipe.tools || []).filter((g) => !g.some((id) => has(equipment, id))).map((g) => {
    const t = TOOL[g[0]];
    // жидкое блюдо: на противне растечётся (карточка "oven_dish": "form")
    const why = g.length === 1 && g[0] === 'baking_dish' ? 'блюдо жидкое, на противне растечётся' : null;
    return { id: g[0], name: g.map((id) => TOOL[id]?.ru || id).join(' или '), de: t?.de || null, price: t?.price || null, why };
  });
}

// Разогрев готового: с микроволновкой — быстрее, без неё — на сковороде или в кастрюле
export function reheatHint(recipe, equipment) {
  if (has(equipment, 'microwave')) return 'Разогрев: в микроволновке под крышкой или тарелкой, 2–3 мин на полной мощности, перемешав на середине.';
  return 'Разогрев: на сковороде или в кастрюле на среднем огне 4–6 мин с 1–2 столовыми ложками воды, помешивая.';
}
