import { h, num, eur, seg, toast, download, humanDate } from '../ui.js';
import { state, save, targets, IS_ARTIFACT, dropMissing } from '../state.js';
import { ACTIVITY, GOALS, DEFAULT_PROFILE } from '../core/nutrition.js';
import { TOOLS, has, canCook } from '../core/equipment.js';
import { ACCOUNTS_ENABLED, sendCode, verifyCode, startAccount, signOut, signedIn } from '../account.js';

export function renderProfile(root, rerender) {
  const p = state.profile;
  const pr = state.prefs;
  // Числа: сохраняем и обновляем только расчёт нормы и бюджета — поля ввода не пересоздаются,
  // иначе касание следующего поля теряет фокус (на blur срабатывает change, а страница перерисовывается)
  const setN = (k, v) => {
    p[k] = v;
    save();
    markSaved();
    drawLive();
  };
  const setP = (k, v) => { p[k] = v; save(); rerender({ keepScroll: true }); };
  const setPr = (k, v) => { pr[k] = v; save(); rerender({ keepScroll: true }); };

  const normSlot = h('div', { class: 'stack' });
  const budgetSlot = h('p', { class: 'muted', style: { margin: 0 } });
  function drawLive() {
    const t = targets();
    normSlot.replaceChildren(
      !t.complete ? h('p', { class: 'notice' }, 'Заполните пол, рост и вес — пока показан расчёт для 178 см / 72 кг.') : '',
      h('div', { class: 'kpis' },
        kpi(`${num(t.kcal)} ккал`, `в день (поддержание ${num(t.tdee)})`),
        kpi(`${num(t.protein)} г`, 'белка в день'),
        kpi(`${num(t.perMeal.kcal)} ккал`, 'на обед или ужин'),
        kpi(`${num(t.perMeal.protein)} г`, 'белка на обед или ужин')),
      h('p', { class: 'muted', style: { margin: 0 } },
        `Формула Миффлина — Сан-Жеора: базовый обмен ${num(t.bmr)} ккал × активность = ${num(t.tdee)} ккал (поддержание)`,
        p.goal === 'gain' ? `, плюс ${num(p.surplusPct)}% для набора.` : '.',
        ` Жиры ≈ ${num(t.fat)} г, углеводы ≈ ${num(t.carbs)} г в день.`));
    budgetSlot.textContent = `На обед и ужин остаётся ${eur((p.budget || 0) - (p.reserve || 0))} в неделю — генератор старается уложиться в эту сумму.`;
  }
  drawLive();

  root.append(h('div', { class: 'topbar' }, h('h1', null, 'Профиль'),
    h('span', { class: 'save-status muted', id: 'save-status', 'aria-live': 'polite' }, state.savedAt ? 'Сохранено' : '')));
  root.append(h('p', { class: 'muted', style: { marginTop: '-8px' } }, 'Ответы сохраняются автоматически. ', h('span', { id: 'where-text' }, whereText())));

  if (ACCOUNTS_ENABLED) root.append(accountCard(rerender));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'О вас'),
    h('div', null, h('div', { class: 'muted', style: { marginBottom: '6px' } }, 'Пол'),
      seg([['male', 'Мужской'], ['female', 'Женский']], p.sex, (v) => setP('sex', v))),
    h('div', { class: 'grid two' },
      numField('Возраст, лет', p.age, (v) => setN('age', v), { min: 14, max: 99, id: 'f-age' }),
      numField('Рост, см', p.height, (v) => setN('height', v), { min: 120, max: 230, id: 'f-height' }),
      numField('Вес, кг', p.weight, (v) => setN('weight', v), { min: 35, max: 250, step: 0.1, id: 'f-weight' })),
    h('fieldset', { class: 'radios' }, h('legend', null, 'Активность'),
      ACTIVITY.map((a) => h('label', { class: 'radio' + (a.id === p.activity ? ' on' : '') },
        h('input', { type: 'radio', name: 'activity', id: `act-${a.id}`, value: a.id, checked: a.id === p.activity, onchange: () => setP('activity', a.id) }),
        h('span', null, a.label), h('span', { class: 'muted' }, `×${String(a.factor).replace('.', ',')}`)))),
    h('label', { class: 'field' }, h('span', null, 'Цель'),
      h('select', { onchange: (e) => { setP('goal', e.target.value); } }, Object.entries(GOALS).map(([id, g]) => h('option', { value: id, selected: id === p.goal }, g.label)))),
    p.goal === 'gain' ? numField('Профицит калорий, %', p.surplusPct, (v) => setN('surplusPct', v), { min: 0, max: 25, id: 'f-surplus' }) : null,
    numField('Белок, г на кг веса', p.proteinPerKg, (v) => setN('proteinPerKg', v), { min: 1.2, max: 3, step: 0.1, id: 'f-ppk' })));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Ваша норма'),
    normSlot,
    numField('Доля нормы на обед + ужин, %', p.mealShare, (v) => setN('mealShare', v), { min: 40, max: 90, id: 'f-share' }),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Остальное — завтрак и перекусы (в плане не готовятся).')));

  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Бюджет'),
    h('div', { class: 'grid two' },
      numField('Бюджет на продукты, € в неделю', p.budget, (v) => setN('budget', v), { min: 20, max: 300, id: 'f-budget' }),
      numField('Из них на завтраки и перекусы, €', p.reserve, (v) => setN('reserve', v), { min: 0, max: 200, id: 'f-reserve' })),
    budgetSlot));

  // Кухонная утварь: обязательная меняет подбор блюд, заменимая — подсказки в шагах
  const eq = (pr.equipment = pr.equipment || {});
  const cookable = state.data.recipes.filter((r) => canCook(r, eq)).length;
  const toolRow = (t) => h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: has(eq, t.id), onchange: (e) => { eq[t.id] = e.target.checked; setPr('equipment', eq); } }),
    h('span', null, t.ru, h('span', { class: 'muted' }, ` · ${t.de}`)));
  root.append(h('div', { class: 'card stack' },
    h('h2', { style: { marginTop: 0 } }, 'Кухонная утварь'),
    h('p', { class: 'muted', style: { margin: 0 } }, `Отметьте, что есть дома. Можно приготовить ${cookable} из ${state.data.recipes.length} блюд.`),
    h('div', { class: 'eyebrow' }, 'Без этого блюдо не приготовить — оно не попадёт в план'),
    TOOLS.filter((t) => t.hard).map(toolRow),
    h('div', { class: 'eyebrow', style: { marginTop: '8px' } }, 'Можно обойтись — в рецепте будет подсказка как'),
    TOOLS.filter((t) => !t.hard).map(toolRow),
    has(eq, 'microwave') ? h('p', { class: 'muted', style: { margin: 0 } }, 'С микроволновкой в рецептах появится быстрый разогрев готового.') : null));

  const inRecipes = new Set(state.data.recipes.flatMap((r) => r.ingredients.map((i) => i.key)));
  // только то, что встречается в рецептах (продукты-замены из «если нет» сюда не попадают)
  const products = Object.values(state.data.products).filter((x) => !x.basic && inRecipes.has(x.key)).sort((a, b) => (a.name_ru || '').localeCompare(b.name_ru || '', 'ru'));
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
    h('p', { class: 'muted', style: { margin: 0 } }, `Цены от ${humanDate(state.data.meta.price_date)}. `, h('span', { id: 'sync-text' }, syncText())),
    h('div', { class: 'row' },
      !IS_ARTIFACT && h('button', { class: 'btn', onclick: () => download('mealplanner-backup.json', JSON.stringify({ profile: state.profile, prefs: state.prefs, plan: state.plan }, null, 1)) }, 'Сохранить копию настроек'),
      !IS_ARTIFACT && h('label', { class: 'btn' }, 'Загрузить копию', h('input', { type: 'file', id: 'f-import', accept: 'application/json', class: 'sr-only', onchange: (e) => importBackup(e, rerender) })),
      resetButton(rerender))));
}

// ---------- Аккаунт (Supabase): вход по коду из письма ----------
const acc = { step: 'email', email: '', busy: false, error: '' };
function accountCard(rerender) {
  const card = h('div', { class: 'card stack', id: 'account-card' });
  const draw = () => {
    if (signedIn() && state.account) {
      card.replaceChildren(
        h('h2', { style: { marginTop: 0 } }, 'Аккаунт'),
        h('p', { style: { margin: 0 } }, 'Вы вошли: ', h('b', null, state.account.email)),
        h('p', { class: 'muted', style: { margin: 0 } }, state.sync === 'cloud'
          ? 'План, отметки покупок, запасы дома, ваш список, профиль и настройки одинаковы на всех устройствах, где вы вошли.'
          : 'Подключаю синхронизацию…'),
        h('button', { class: 'btn ghost', onclick: async () => { await signOut(); acc.step = 'email'; toast('Вы вышли. Данные остались в этом браузере.'); rerender({ keepScroll: true }); } }, 'Выйти'));
      return;
    }
    const email = h('input', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', value: acc.email, 'aria-label': 'Почта' });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, placeholder: '123456', 'aria-label': 'Код из письма' });
    const err = acc.error ? h('p', { class: 'notice' }, acc.error) : null;
    const send = async () => {
      acc.email = email.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acc.email)) { acc.error = 'Проверьте адрес почты.'; draw(); return; }
      acc.busy = true; acc.error = ''; draw();
      try { await sendCode(acc.email); acc.step = 'code'; } catch (e) { acc.error = e.status === 429 ? 'Слишком много писем подряд — подождите минуту и попробуйте снова.' : `Не получилось отправить письмо: ${e.message}`; }
      acc.busy = false; draw();
    };
    const verify = async () => {
      acc.busy = true; acc.error = ''; draw();
      try {
        await verifyCode(acc.email, code.value);
        await startAccount((changed) => { rerender({ keepScroll: true }); if (changed) toast('Данные с другого устройства загружены'); });
        acc.step = 'email';
        toast('Вы вошли. Данные синхронизируются.');
        rerender({ keepScroll: true });
        return;
      } catch (e) { acc.error = 'Код не подошёл или устарел. Проверьте последнее письмо или запросите новый код.'; }
      acc.busy = false; draw();
    };
    card.replaceChildren(
      h('h2', { style: { marginTop: 0 } }, 'Аккаунт'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Войдите, чтобы план, список покупок и запасы были одинаковыми на телефоне и ноутбуке. Пароль не нужен — придёт письмо со ссылкой для входа. То, что уже есть в этом браузере, перенесётся в аккаунт.'),
      acc.step === 'email'
        ? h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, 'Почта'), email),
          h('button', { class: 'btn primary', disabled: acc.busy, onclick: send }, acc.busy ? 'Отправляю…' : 'Получить ссылку для входа'))
        : h('div', { class: 'stack' },
          h('p', { style: { margin: 0 } }, `Письмо отправлено на ${acc.email} (от Supabase Auth, проверьте и «Спам»). Откройте ссылку из письма на этом устройстве, в этом же браузере, — вход произойдёт сам. На другом устройстве запросите письмо там.`),
          h('label', { class: 'field' }, h('span', null, 'Или код из письма, если он там есть'), code),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', disabled: acc.busy, onclick: verify }, acc.busy ? 'Проверяю…' : 'Войти'),
            h('button', { class: 'btn ghost', disabled: acc.busy, onclick: () => { acc.step = 'email'; acc.error = ''; draw(); } }, 'Другая почта'))),
      err || '');
    if (acc.step === 'code') code.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
    else email.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  };
  draw();
  return card;
}

// Подключилось сохранение в аккаунте — обновить подписи, не перерисовывая форму (вдруг сейчас идёт ввод)
export function refreshSyncText() {
  const a = document.getElementById('where-text');
  const b = document.getElementById('sync-text');
  if (a) a.textContent = whereText();
  if (b) b.textContent = syncText();
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
    if (data.plan && Array.isArray(data.plan.batches)) { state.plan = data.plan; dropMissing(state.plan); }
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
