// Экспорт плана и списка покупок в простой текст (для заметок, мессенджера, печати).
import { MEALS, planDays, daySums } from './planner.js';
import { dayName, dayDate, fmtDate } from './calendar.js';
import { formatAmount, formatPack } from './shopping.js';

const eur = (x) => '€' + (Math.round(x * 100) / 100).toFixed(2).replace('.', ',');

export function planToText(plan, recipeMap) {
  const days = planDays(plan, recipeMap);
  const sums = daySums(plan, recipeMap);
  const lines = ['ПЛАН ПИТАНИЯ НА НЕДЕЛЮ', ''];
  days.forEach((d, i) => {
    lines.push(`${dayName(plan, i)}, ${fmtDate(dayDate(plan, i)).split(', ')[1]} — ${Math.round(sums[i].kcal)} ккал, белок ${Math.round(sums[i].protein)} г`);
    if (d.breakfast) lines.push(`  ${MEALS.breakfast}: ${d.breakfast.recipe.title}${d.breakfast.factor !== 1 ? ` (×${String(d.breakfast.factor).replace('.', ',')})` : ''}`);
    for (const m of ['lunch', 'dinner']) {
      const e = d[m];
      if (!e?.recipe) continue;
      const how = e.leftover ? 'остаток со вчерашнего ужина' : e.portions > 1 ? `готовим ×${e.portions} порции` : 'готовим 1 порцию';
      lines.push(`  ${MEALS[m]}: ${e.recipe.title} (порция ×${String(e.factor).replace('.', ',')}; ${how})`);
    }
    for (const sn of d.snacks) lines.push(`  ${MEALS.snack}: ${sn.recipe.title}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function shoppingToText(list, products, departments, checked = {}) {
  const lines = ['СПИСОК ПОКУПОК', ''];
  for (const dep of departments) {
    const items = list.items.filter((i) => i.department === dep.id);
    if (!items.length) continue;
    lines.push(dep.name.toUpperCase());
    for (const it of items) {
      const box = checked[it.key] ? '[x]' : '[ ]';
      const offer = it.offer ? ` — ${formatPack(it.offer)} ${it.offer.pack.name_de}, ${it.offer.pack.store}, ${eur(it.offer.cost)}` : '';
      lines.push(`${box} ${it.name_ru} (${it.name_de_generic || it.name_de}): нужно ${formatAmount(it.key, it.needGrams, products[it.key])}${offer}`);
    }
    lines.push('');
  }
  lines.push('ИТОГО ПО МАГАЗИНАМ');
  for (const [s, v] of Object.entries(list.byStore)) lines.push(`  ${s}: ${eur(v.total)} (${v.count} поз.)`);
  lines.push(`  Всего: ${eur(list.total)}`, '');
  if (list.basics.length) {
    lines.push('БАЗОВЫЕ ПРОДУКТЫ (купить один раз, если нет дома)');
    for (const it of list.basics) {
      const box = checked['basic:' + it.key] ? '[x]' : '[ ]';
      const offer = it.offer ? ` — ${formatPack({ ...it.offer, count: 1 })} ${it.offer.pack.name_de}, ${it.offer.pack.store}, ${eur(it.offer.pack.price_eur)}` : '';
      lines.push(`${box} ${it.name_ru} (${it.name_de_generic || it.name_de})${offer}`);
    }
  }
  return lines.join('\n');
}
