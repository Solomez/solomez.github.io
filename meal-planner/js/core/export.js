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

// Список по походам (F15): «Вт, 20 октября · Billa», в каждой строке — название, количество и как на ценнике.
// which: 'next' — только ближайший поход, 'all' — все походы периода
export function tripsToText(ck, plan, products, { which = 'all', checked = {} } = {}) {
  const trips = which === 'next' ? ck.trips.slice(0, 1) : ck.trips;
  const lines = [which === 'next' ? 'СПИСОК НА БЛИЖАЙШИЙ ПОХОД' : 'СПИСОК ПОКУПОК ПО ПОХОДАМ', ''];
  for (const t of trips) {
    const d = dayDate(plan, t.day);
    lines.push(`${fmtDate(d)} · ${t.store}`);
    for (const ti of t.items) {
      const it = ck.list.items.find((i) => i.key === ti.key);
      if (!it) continue;
      const pack = it.offer ? `${formatPack(it.offer)}${it.offer.pack.name_de ? ` (${it.offer.pack.name_de})` : ''}` : formatAmount(it.key, it.needGrams, products[it.key]);
      lines.push(`${checked[it.key] ? '✓' : '—'} ${it.name_ru}, ${pack}`);
    }
    for (const c of ck.own.filter((c) => c.store === t.store)) lines.push(`— ${c.name}${c.byWeight ? '' : ` × ${c.qty}`}`);
    lines.push(`Итого: ${eur(t.total)}`, '');
  }
  if (which !== 'next') {
    const tripStores = new Set(ck.trips.map((t) => t.store));
    const elsewhere = ck.own.filter((c) => !c.done && !tripStores.has(c.store));
    if (elsewhere.length) lines.push('Ваши товары в других магазинах', ...elsewhere.map((c) => `— ${c.name}${c.byWeight ? '' : ` × ${c.qty}`} (${c.store})`), '');
    const noPrice = ck.list.items.filter((i) => !i.offer);
    if (noPrice.length) lines.push('Без цены — в любом магазине', ...noPrice.map((i) => `— ${i.name_ru}, ${formatAmount(i.key, i.needGrams, products[i.key])}`), '');
    if (ck.list.basics.length) lines.push('Базовое (купить, если нет дома)', ...ck.list.basics.map((i) => `— ${i.name_ru}${i.name_de_generic ? ` (${i.name_de_generic})` : ''}`), '');
    lines.push(`К оплате: ${eur(ck.toPay)}`);
  }
  return lines.join('\n').trim();
}

// ck — результат checkout(): итоги по магазинам и «к оплате» те же, что на экранах
export function shoppingToText(list, products, departments, checked = {}, cart = [], ck = null) {
  const lines = ['СПИСОК ПОКУПОК', ''];
  for (const dep of departments) {
    const items = list.items.filter((i) => i.department === dep.id);
    if (!items.length) continue;
    lines.push(dep.de ? `${dep.name.toUpperCase()} · ${dep.de}` : dep.name.toUpperCase());
    for (const it of items) {
      const box = checked[it.key] ? '[x]' : '[ ]';
      const offer = it.offer ? ` — ${formatPack(it.offer)} ${it.offer.pack.name_de}, ${it.offer.pack.store}, ${eur(it.offer.cost)}` : '';
      lines.push(`${box} ${it.name_ru} (${[it.name_de_generic || it.name_de, it.name_en].filter(Boolean).join(' / ')}): нужно ${formatAmount(it.key, it.needGrams, products[it.key])}${offer}`);
    }
    lines.push('');
  }
  const own = cart.filter((c) => !c.done);
  if (own.length) {
    lines.push('ВАШИ ТОВАРЫ');
    for (const c of own) lines.push(`[ ] ${c.name}${c.byWeight ? '' : ` × ${c.qty}`} — ${c.store}${c.price ? `, ${eur(c.price)}${c.byWeight ? '/кг' : ''}` : ''}`);
    lines.push('');
  }
  if (list.atHome?.length) lines.push(`УЖЕ ДОМА (не покупать): ${list.atHome.map((i) => i.name_ru).join(', ')}`, '');
  lines.push('ИТОГО ПО МАГАЗИНАМ');
  for (const [s, v] of Object.entries(ck ? ck.byStore : list.byStore)) lines.push(`  ${s}: ${eur(v.total)} (${v.count} поз.)`);
  lines.push(`  К оплате: ${eur(ck ? ck.toPay : list.total)}`, '');
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
