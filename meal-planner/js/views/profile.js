import { h, num, eur, seg, toast, download } from '../ui.js';
import { state, save, targets, IS_ARTIFACT } from '../state.js';
import { ACTIVITY, GOALS, DEFAULT_PROFILE } from '../core/nutrition.js';

export function renderProfile(root, rerender) {
  const p = state.profile;
  const pr = state.prefs;
  const setP = (k, v, live) => {
    p[k] = v;
    save();
    if (live) markSaved();
    else rerender({ keepScroll: true, keepFocus: true });
  };
  const setPr = (k, v) => { pr[k] = v; save(); rerender({ keepScroll: true }); };
  const t = targets();

  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Профиль'),
    h('span', { class: 'save-status muted', id: 'save-status', 'aria-live': 'polite' }, state.savedAt ? 'Сохранено' : '')));
  root.append(h('p', { class: 'muted', style: { marginTop: '-8px' } }, 'Ответы сохраняются автоматически. ', whereText()));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'О вас'),
    h('div', null, h('div', { class: 'muted', style: { marginBottom: '6px' } }, 'Пол'),
      seg([['male', 'Мужской'], ['female', 'Женский']], p.sex, (v, live) => setP('sex', v, live))),
    h('div', { class: 'grid two' },
      numField('Возраст, лет', p.age, (v, live) => setP('age', v, live), { min: 14, max: 99, id: 'f-age' }),
      numField('Рост, см', p.height, (v, live) => setP('height', v, live), { min: 120, max: 230, id: 'f-height' }),
      numField('Вес, кг', p.weight, (v, live) => setP('weight', v, live), { min: 35, max: 250, step: 0.1, id: 'f-weight' })),
    h('fieldset', { class: 'radios' }, h('legend', null, 'Активность'),
      ACTIVITY.map((a) => h('label', { class: 'radio' + (a.id === p.activity ? ' on' : '') },
        h('input', { type: 'radio', name: 'activity', id: `act-${a.id}`, value: a.id, checked: a.id === p.activity, onchange: () => setP('activity', a.id) }),
        h('span', null, a.label), h('span', { class: 'muted' }, `×${String(a.factor).replace('.', ',')}`)))),
    h('label', { class: 'field' }, h('span', null, 'Цель'),
      h('select', { onchange: (e) => { setP('goal', e.target.value); } }, Object.entries(GOALS).map(([id, g]) => h('option', { value: id, selected: id === p.goal }, g.label)))),
    p.goal === 'gain' ? numField('Профицит калорий, %', p.surplusPct, (v, live) => setP('surplusPct', v, live), { min: 0, max: 25, id: 'f-surplus' }) : null,
    numField('Белок, г на кг веса', p.proteinPerKg, (v, live) => setP('proteinPerKg', v, live), { min: 1.2, max: 3, step: 0.1, id: 'f-ppk' })));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Ваша норма'),
    !t.complete ? h('p', { class: 'notice' }, 'Заполните пол, рост и вес — пока показан расчёт для 178 см / 72 кг.') : null,
    h('div', { class: 'kpis' },
      kpi(`${num(t.kcal)} ккал`, `в день (поддержание ${num(t.tdee)})`),
      kpi(`${num(t.protein)} г`, 'белка в день'),
      kpi(`${num(t.perMeal.kcal)} ккал`, 'на обед или ужин'),
      kpi(`${num(t.perMeal.protein)} г`, 'белка на обед или ужин')),
    h('p', { class: 'muted', style: { margin: 0 } },
      `Формула Миффлина — Сан-Жеора: базовый обмен ${num(t.bmr)} ккал × активность = ${num(t.tdee)} ккал (поддержание)`,
      p.goal === 'gain' ? `, плюс ${num(p.surplusPct)}% для набора.` : '.',
      ` Жиры ≈ ${num(t.fat)} г, углеводы ≈ ${num(t.carbs)} г в день.`),
    numField('Доля нормы на обед + ужин, %', p.mealShare, (v, live) => setP('mealShare', v, live), { min: 40, max: 90, id: 'f-share' }),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Остальное — завтрак и перекусы (в плане не готовятся).')));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Бюджет'),
    h('div', { class: 'grid two' },
      numField('Бюджет на продукты, € в неделю', p.budget, (v, live) => setP('budget', v, live), { min: 20, max: 300, id: 'f-budget' }),
      numField('Из них на завтраки и перекусы, €', p.reserve, (v, live) => setP('reserve', v, live), { min: 0, max: 200, id: 'f-reserve' })),
    h('p', { class: 'muted', style: { margin: 0 } }, `На обед и ужин остаётся ${eur(p.budget - p.reserve)} в неделю — генератор старается уложиться в эту сумму.`)));

  const products = Object.values(state.data.products).filter((x) => !x.basic).sort((a, b) => (a.name_ru || '').localeCompare(b.name_ru || '', 'ru'));
  const excluded = new Set(pr.excludedKeys || []);
  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Рацион и ограничения'),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: pr.batchCooking !== false, onchange: (e) => setPr('batchCooking', e.target.checked) }),
      h('span', null, 'Готовить ужин сразу на 2 порции (вторая — обед следующего дня)')),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: pr.planBreakfast !== false, onchange: (e) => setPr('planBreakfast', e.target.checked) }),
      h('span', null, 'Добавлять завтрак и перекусы, чтобы закрыть дневную норму целиком')),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!pr.showBorderline, onchange: (e) => setPr('showBorderline', e.target.checked) }),
      h('span', null, 'Предлагать спорные блюда (шакшука, дал)')),
    h('label', { class: 'field' }, h('span', null, 'Одно блюдо — не чаще N раз в неделю'),
      h('select', { onchange: (e) => setPr('maxRepeats', +e.target.value) }, [1, 2, 3].map((n) => h('option', { value: n, selected: n === pr.maxRepeats }, `${n} ${n === 1 ? 'раз' : 'раза'}`)))),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Всегда исключены: каши и гречка, супы, рыба и морепродукты. Брокколи, баклажаны, кабачки и шпинат встречаются только в мелких количествах.'),
    h('div', null, h('div', { class: 'muted', style: { marginBottom: '6px' } }, 'Не предлагать блюда с продуктом:'),
      h('div', { class: 'chips' }, products.map((x) => h('button', {
        class: 'chip' + (excluded.has(x.key) ? ' on' : ''), 'aria-pressed': String(excluded.has(x.key)),
        onclick: () => { excluded.has(x.key) ? excluded.delete(x.key) : excluded.add(x.key); setPr('excludedKeys', [...excluded]); },
      }, x.name_ru || x.key)))),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Изменения применятся при следующей генерации недели.')));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Данные'),
    h('p', { class: 'muted', style: { margin: 0 } }, `Цены от ${state.data.meta.price_date}. `, syncText()),
    h('div', { class: 'row' },
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('mealplanner-backup.json', JSON.stringify({ profile: state.profile, prefs: state.prefs, plan: state.plan }, null, 1)) }, 'Сохранить копию настроек'),
      !IS_ARTIFACT && h('label', { class: 'btn' }, 'Загрузить копию', h('input', { type: 'file', id: 'f-import', accept: 'application/json', class: 'sr-only', onchange: (e) => importBackup(e, rerender) })),
      resetButton(rerender))));
}

function whereText() {
  if (state.sync === 'cloud') return 'Они в вашем аккаунте claude.ai — одинаковые на телефоне и компьютере.';
  if (state.sync === 'connecting') return 'Подключаю сохранение в аккаунте…';
  if (IS_ARTIFACT) return 'Сейчас — только в этом браузере: чтобы видеть их и на других устройствах, войдите в claude.ai.';
  return `Они хранятся в этом браузере для адреса ${location.host}; другой адрес или устройство — отдельный профиль.`;
}

let savedTimer = null;
function markSaved() {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = 'Сохранено ✓';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.textContent = 'Сохранено'; }, 1500);
}

function syncText() {
  if (state.sync === 'cloud') return 'Профиль, план и отметки сохраняются в вашем аккаунте claude.ai и одинаковы на телефоне и компьютере.';
  if (state.sync === 'connecting') return 'Подключаю сохранение в аккаунте…';
  return 'Профиль, план и отметки хранятся только в этом браузере.';
}

// Сброс в два нажатия: первое спрашивает, второе выполняет (окна confirm() в опубликованной версии не работают)
let resetArmed = false;
function resetButton(rerender) {
  if (!resetArmed) return h('button', { class: 'btn ghost', onclick: () => { resetArmed = true; rerender({ keepScroll: true }); } }, 'Сбросить всё');
  return h('div', { class: 'row' },
    h('span', { class: 'muted' }, 'Удалить профиль, план и отметки?'),
    h('button', { class: 'btn small', onclick: () => {
      resetArmed = false;
      Object.assign(state.profile, DEFAULT_PROFILE);
      state.plan = null; state.checked = {}; state.cook = {};
      save(); rerender();
    } }, 'Да, сбросить'),
    h('button', { class: 'btn small ghost', onclick: () => { resetArmed = false; rerender({ keepScroll: true }); } }, 'Отмена'));
}

async function importBackup(e, rerender) {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (data.profile) Object.assign(state.profile, data.profile);
    if (data.prefs) Object.assign(state.prefs, data.prefs);
    if (data.plan) state.plan = data.plan;
    save();
    toast('Настройки загружены');
    rerender();
  } catch {
    toast('Не удалось прочитать файл');
  }
}

function numField(label, value, onChange, { min, max, step = 1, id } = {}) {
  return h('label', { class: 'field' }, h('span', null, label),
    h('input', { type: 'number', inputmode: 'decimal', id, 'aria-label': label, min, max, step, value: value ?? '',
      // при вводе — сразу сохраняем (на телефоне поле часто не теряет фокус перед закрытием браузера),
      // при выходе из поля — пересчитываем норму на экране
      oninput: (e) => { const v = parseNum(e.target.value); if (v != null) onChange(v, true); },
      onchange: (e) => onChange(parseNum(e.target.value), false) }));
}
function parseNum(x) {
  const v = parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}
function kpi(v, l) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}
