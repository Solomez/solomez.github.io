// «Как понять, что готово»: признаки из профиля ингредиента (или общего действия) — чек-лист крупно,
// как проверить, безопасность для птицы, свинины и фарша, что делать, если не готово или передержал.
// И финал блюда: «Блюдо готово, когда…», отдых, подача.
import { h } from '../ui.js';
import { state } from '../state.js';
import { renderText } from '../core/cookbook.js';

const TYPE = { look: 'Вид', texture: 'На ощупь', sound: 'Звук', smell: 'Запах', taste: 'Вкус' };
const SAFETY = { poultry: 'птица', pork: 'свинина', mince: 'фарш', mince_poultry: 'фарш птицы' };

// Текст признака с подстановками (названия продуктов шага)
const tx = (r, step, t) => (t ? renderText(r, t, { ...step.ctx, kitchen: state.data.kitchen }).text : '');

// есть что проверять по окончании таймера (у первой половины этапа, разделённого «late», признаков нет)
export function hasReadiness(step) {
  return !!step.cues?.length;
}

export function cueList(r, step, { big = false, checkable = false } = {}) {
  return h('ul', { class: 'ready-list' + (big ? ' big' : '') }, (step.cues || []).map((c) => h('li', null,
    checkable ? h('label', null, h('input', { type: 'checkbox' }), ' ', h('span', { class: 'cue-type' }, `${TYPE[c.type] || c.type}: `), tx(r, step, c.text))
      : [h('span', { class: 'cue-type' }, `${TYPE[c.type] || c.type}: `), tx(r, step, c.text)])));
}

// Безопасность: на шаге, где мясо доходит, — проверка разрезом и температура; раньше — «ещё сырое, это нормально»
export function safetyBlock(r, step) {
  return (step.safety || []).map((x) => {
    const ing = r.ingredients.find((i) => (i.id || i.key) === x.slot);
    const name = ing?.name_ru || SAFETY[x.kind] || 'мясо';
    if (x.stage === 'partial') {
      return h('div', { class: 'safety partial' }, h('b', null, `${name}: `),
        `внутри ещё может быть сырым — это нормально${x.final_step >= 0 ? `, дойдёт к шагу ${x.final_step + 1} — там проверка` : ''}. Не пробуй на вкус.`);
    }
    return h('div', { class: 'safety' }, h('b', null, `Безопасность — ${name.toLowerCase()}: `), tx(r, step, x.check),
      x.temp_c && !/°C/.test(x.check || '') ? h('div', { class: 'muted' }, `Есть кухонный термометр — в самом толстом месте не ниже ${x.temp_c} °C.`) : null);
  });
}

export function readyBlock(r, step, { big = false, checkable = false, open = true } = {}) {
  if (!hasReadiness(step)) return null;
  const body = [
    step.cues?.length ? cueList(r, step, { big, checkable }) : null,
    step.check ? h('p', { class: 'ready-check' }, h('b', null, 'Как проверить: '), tx(r, step, step.check)) : null,
    ...safetyBlock(r, step),
    step.not_ready?.text ? h('p', { class: 'muted' }, h('b', null, 'Ещё не готово? '), tx(r, step, step.not_ready.text)) : null,
    step.overdone ? h('details', { class: 'plain' }, h('summary', null, 'Если передержал'),
      h('p', null, tx(r, step, step.overdone.signs)), step.overdone.rescue ? h('p', null, h('b', null, 'Что делать: '), tx(r, step, step.overdone.rescue)) : null) : null,
    step.timer_min && step.cues?.length ? h('p', { class: 'muted small' }, 'Ориентируйся на признаки, таймер — только подсказка: всё совпало раньше — переходи дальше; таймер вышел, а признаков нет — подожди.') : null,
  ];
  if (!step.cues?.length && !step.check) return h('div', { class: 'ready-box' }, ...body);
  return open
    ? h('div', { class: 'ready-box' }, h('div', { class: 'ready-title' }, 'Как понять, что готово'), ...body)
    : h('details', { class: 'ready-box' }, h('summary', null, 'Как понять, что готово'), ...body);
}

// «Проверь:» — когда таймер шага закончился
export function checkPanel(r, step, { onDone, onNotReady }) {
  return h('div', { class: 'check-now' },
    h('div', { class: 'ready-title' }, 'Проверь:'),
    step.cues?.length ? cueList(r, step, { big: true, checkable: true }) : null,
    step.check ? h('p', { class: 'ready-check' }, tx(r, step, step.check)) : null,
    ...safetyBlock(r, step).filter((x) => !x.classList.contains('partial')),
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', onclick: onDone }, 'Готово'),
      h('button', { class: 'btn', onclick: onNotReady }, 'Ещё не готово')),
    h('p', { class: 'muted small' }, 'Ориентируйся на признаки, таймер — подсказка.'));
}

// Финал блюда
export function doneWhenBlock(r) {
  const d = r.done_when;
  if (!d) return null;
  const t = (x) => (x ? renderText(r, x, { kitchen: state.data.kitchen }).text : '');
  return h('div', { class: 'ready-box final' },
    h('div', { class: 'ready-title' }, 'Блюдо готово, когда…'),
    h('ul', { class: 'ready-list big' }, (d.signs || []).map((x) => h('li', null, t(x)))),
    d.rest ? h('p', null, h('b', null, `Дай постоять ${d.rest.min[0] === d.rest.min[1] ? d.rest.min[0] : `${d.rest.min[0]}–${d.rest.min[1]}`} мин: `), t(d.rest.why)) : null,
    d.serve ? h('p', null, h('b', null, 'Подача: '), t(d.serve)) : null);
}
