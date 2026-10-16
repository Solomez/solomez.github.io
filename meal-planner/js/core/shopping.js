// Список покупок: сумма ингредиентов плана → реальные упаковки → цена по магазинам.

const SKIP = new Set(['water']);

// Ингредиенты рецепта для заданного размера порции и числа порций
export function scaledIngredients(recipe, factor = 1, portions = recipe.servings) {
  const mult = (factor * portions) / (recipe.servings || 2);
  return recipe.ingredients.map((i) => ({ ...i, grams: i.grams * mult }));
}

// Суммарная потребность плана: key → { grams, uses: [{recipeId, title, grams}] }
export function planNeeds(plan, recipeMap, { only } = {}) {
  const needs = new Map();
  const cooks = [
    ...(only === 'extras' ? [] : plan.batches.map((b) => ({ recipeId: b.recipeId, factor: b.factor, portions: b.slots.length }))),
    ...(only === 'main' ? [] : (plan.extras || []).map((x) => ({ recipeId: x.recipeId, factor: x.factor, portions: 1 }))),
  ];
  for (const b of cooks) {
    const r = recipeMap.get(b.recipeId);
    if (!r) continue;
    for (const ing of scaledIngredients(r, b.factor, b.portions)) {
      if (SKIP.has(ing.key) || !(ing.grams > 0)) continue;
      const cur = needs.get(ing.key) || { grams: 0, uses: [] };
      cur.grams += ing.grams;
      cur.uses.push({ recipeId: r.id, title: r.title, grams: ing.grams, optional: !!ing.optional });
      needs.set(ing.key, cur);
    }
  }
  return needs;
}

function usablePacks(product, stores) {
  let packs = (product?.packs || []).filter((p) => p.grams > 0);
  if (stores && stores.length) {
    const f = packs.filter((p) => stores.includes(p.store));
    if (f.length) packs = f;
  }
  const fresh = packs.filter((p) => !p.stale);
  return fresh.length ? fresh : packs;
}

// Лучшая покупка для нужного количества: одна позиция, n упаковок (или развес)
export function chooseOffer(product, grams, { stores } = {}) {
  const packs = usablePacks(product, stores);
  let best = null;
  for (const p of packs) {
    let count, cost;
    if (p.loose) {
      const g = Math.max(50, Math.ceil(grams / 50) * 50);
      count = g / 1000;
      cost = (g * p.eur_per_kg) / 1000;
    } else {
      count = Math.max(1, Math.ceil(grams / p.grams - 1e-9));
      cost = count * p.price_eur;
    }
    const rank = cost + (p.is_estimate ? 0.001 : 0);
    if (!best || rank < best.rank) best = { pack: p, count, cost: round2(cost), rank, boughtGrams: p.loose ? count * 1000 : count * p.grams };
  }
  if (!best) return null;
  delete best.rank;
  return best;
}

// Пропорциональная стоимость (сколько стоит съеденное), по самой выгодной цене за кг
export function proportionalCost(product, grams, opts) {
  const packs = usablePacks(product, opts?.stores);
  if (!packs.length) return 0;
  const minPerKg = Math.min(...packs.map((p) => p.eur_per_kg));
  return (grams * minPerKg) / 1000;
}

// opts.home: { key: граммы | true } — что уже есть дома (true — есть, количество не указано: хватает);
// opts.unavailable: Set('магазин|key') — там этого продукта на полке не оказалось, предлагаем другой магазин
export function withoutUnavailable(product, key, unavailable) {
  if (!product || !unavailable?.size) return product;
  const packs = (product.packs || []).filter((p) => !unavailable.has(`${p.store}|${key}`));
  return packs.length ? { ...product, packs } : product;
}

export function buildShoppingList(plan, recipeMap, products, opts = {}) {
  const needs = planNeeds(plan, recipeMap, { only: opts.only });
  const items = [];
  const basics = [];
  const atHome = [];
  for (const [key, need] of needs) {
    const product = withoutUnavailable(products[key], key, opts.unavailable);
    const home = opts.home?.[key];
    const homeGrams = home === true ? Infinity : +home || 0;
    const toBuy = Math.max(0, need.grams - homeGrams);
    const offer = product && toBuy > 0 ? chooseOffer(product, toBuy, opts) : null;
    const item = {
      key,
      name_ru: product?.name_ru || key,
      name_en: product?.name_en || '',
      name_de: offer?.pack?.name_de || product?.name_de_generic || product?.name_de || '',
      name_de_generic: product?.name_de_generic || '',
      department: product?.zone || product?.department || 'pantry',
      zone: product?.zone || null,
      shelf: product?.shelf || null,
      basic: !!product?.basic,
      needGrams: toBuy,
      totalGrams: need.grams,
      homeGrams: homeGrams === Infinity ? null : homeGrams || 0,
      uses: need.uses,
      offer,
      consumedCost: product ? proportionalCost(product, need.grams, opts) : 0,
    };
    if (home && toBuy <= 0) atHome.push(item);
    else (item.basic ? basics : items).push(item);
  }
  const byStore = {};
  let total = 0;
  for (const it of items) {
    if (!it.offer) continue;
    const s = it.offer.pack.store;
    byStore[s] = byStore[s] || { total: 0, count: 0 };
    byStore[s].total += it.offer.cost;
    byStore[s].count += 1;
    total += it.offer.cost;
  }
  for (const s of Object.values(byStore)) s.total = round2(s.total);
  const basicsTotal = round2(basics.reduce((a, b) => a + (b.offer?.cost || 0), 0));
  const sortFn = (a, b) => a.name_ru.localeCompare(b.name_ru, 'ru');
  items.sort(sortFn);
  basics.sort(sortFn);
  atHome.sort(sortFn);
  return { items, basics, atHome, byStore, total: round2(total), basicsTotal };
}

// Стоимость, которую «съедает» план (без остатков упаковок), включая базовые продукты
export function consumedPlanCost(plan, recipeMap, products, opts = {}) {
  let sum = 0;
  for (const [key, need] of planNeeds(plan, recipeMap, { only: opts.only })) {
    if (products[key]) sum += proportionalCost(products[key], need.grams, opts);
  }
  return round2(sum);
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}

// Человеческое представление количества
export function formatAmount(key, grams, product) {
  const pcsPack = product?.packs?.find((p) => p.pack_unit === 'pcs');
  if (key === 'eggs') return `${Math.ceil(grams / 60 - 0.05)} шт.`;
  if (pcsPack && ['bell_pepper', 'lemon', 'cucumber', 'lettuce', 'leek', 'cauliflower', 'white_cabbage'].includes(key)) {
    const per = pcsPack.grams / pcsPack.pack_size;
    const n = grams / per;
    return n < 1 ? `≈ ${Math.round(grams)} г (${fmtNum(n, 1)} шт.)` : `≈ ${fmtNum(n, 1)} шт. (${Math.round(grams)} г)`;
  }
  if (grams >= 1000) return `${fmtNum(grams / 1000, 2)} кг`;
  return `${Math.round(grams)} г`;
}

export function formatPack(offer) {
  if (!offer) return '';
  const p = offer.pack;
  if (p.loose) return `развес, ≈ ${fmtNum(offer.count, 2)} кг`;
  const unit = p.pack_unit === 'pcs' ? 'шт.' : p.pack_unit === 'ml' ? 'мл' : 'г';
  return `${offer.count} × ${fmtNum(p.pack_size, 0)} ${unit}`;
}

export function fmtNum(x, d = 0) {
  return Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
