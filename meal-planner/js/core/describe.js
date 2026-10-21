// S76: числа в описании блюда — из расчёта, а не из оригинала. В карточке описание хранит подстановки:
//   {d:protein}            → «около 28 г белка» — белок порции (после замен — новый)
//   {d:total}              → «за 25 минут» — всё время, как в шапке рецепта
//   {d:active}             → «руками до 15 минут» — время работы руками (верхняя граница новичка, как в шапке)
//   {d:fast:текст|иначе}   → «быстрый ужин» — только если всё блюдо готово за 30 минут
// Так «за 5 минут» не спорит с «≈ 8 мин» в шапке, а «~18 г белка» — с таблицей КБЖУ после замены скира.
import { count } from './qty.js';

export const FAST_MIN = 30;
const MIN = ['минуту', 'минуты', 'минут'];

function parts(s, at) {
  // {d:fast:текст|иначе} — части по «|» верхнего уровня (скобки могут вкладываться)
  let depth = 0;
  let j = at;
  const cuts = [];
  for (; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) break; } else if (s[j] === '|' && depth === 1) cuts.push(j);
  }
  return { end: j, cuts };
}

export function describe(text, r) {
  let s = String(text ?? '');
  if (!s.includes('{d:')) return s;
  const total = Math.round(r.time?.total ?? 0);
  const active = Math.round(r.time?.active_range?.[1] ?? r.time?.active ?? 0);
  const protein = Math.round(r.per_serving?.protein ?? 0);
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('{d:', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    const { end, cuts } = parts(s, at);
    const head = s.slice(at + 3, cuts[0] ?? end);
    if (head.startsWith('fast:')) {
      const yes = head.slice(5);
      const no = cuts.length ? s.slice(cuts[0] + 1, end) : '';
      out += describe(total && total <= FAST_MIN ? yes : no, r);
    } else if (head === 'protein') out += `около ${protein} г белка`;
    else if (head === 'total') out += `за ${count(total, MIN)}`;
    else if (head === 'active') out += `руками до ${count(active, ['минуты', 'минут', 'минут'])}`;
    i = end + 1;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,—:]+/, '').replace(/^./, (c) => c.toUpperCase());
}
