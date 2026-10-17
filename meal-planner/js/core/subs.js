// Замена ингредиента в блюде: человек выбирает замену из data/substitutes.json («лук репчатый → лук-порей»),
// блюдо пересчитывается — количество (по коэффициенту замены), КБЖУ и цена на порцию, разбивка цены. Дальше
// это обычный рецепт: план, список покупок и запасы берут уже замену.
// subs — { ключ ингредиента: ключ замены } для одного блюда (state.custom.subs[recipeId])
import { round2 } from './shopping.js';

// Цена за кг для пересчёта: самая выгодная свежая упаковка (как в своих вариантах, core/custom.js)
function eurPerKg(product) {
  const packs = (product?.packs || []).filter((p) => p.grams > 0 && p.eur_per_kg > 0);
  const fresh = packs.filter((p) => !p.stale && !p.is_estimate);
  const list = fresh.length ? fresh : packs;
  return list.length ? Math.min(...list.map((p) => p.eur_per_kg)) : 0;
}

// Подходит ли замена: есть в списке замен этого продукта и у неё есть цена в магазинах
export function subOption(substitutes, products, key, subKey) {
  const row = (substitutes?.[key] || []).find(([k]) => k === subKey);
  return row && products?.[subKey]?.packs?.length ? { key: subKey, note: row[1] || null, ratio: +row[2] > 0 ? +row[2] : 1 } : null;
}

export function applySubs(recipe, subs, products, substitutes) {
  if (!subs || !Object.keys(subs).length) return recipe;
  const n = recipe.servings || 1;
  const ps = { ...recipe.per_serving };
  let breakdown = [...(recipe.cost_breakdown || [])];
  const swapped = [];
  const ingredients = recipe.ingredients.map((ing) => {
    const opt = subs[ing.key] && !ing.basic ? subOption(substitutes, products, ing.key, subs[ing.key]) : null;
    if (!opt || recipe.ingredients.some((x) => x.key === opt.key)) return ing; // такой продукт уже есть в блюде — не сливаем
    const from = products[ing.key];
    const to = products[opt.key];
    const grams = Math.round((ing.grams || 0) * opt.ratio * 10) / 10;
    // КБЖУ: убрать исходный продукт, добавить замену (если у обоих известно)
    const a = from?.nutrition_per_100g;
    const b = to.nutrition_per_100g;
    if (Array.isArray(a) && Array.isArray(b) && ing.grams) {
      ['kcal', 'protein', 'fat', 'carbs'].forEach((f, j) => { ps[f] = (ps[f] || 0) + ((grams * (+b[j] || 0)) - (ing.grams * (+a[j] || 0))) / 100 / n; });
    }
    // цена: строка разбивки исходного продукта → строка замены
    const perKg = eurPerKg(to);
    const old = breakdown.find((c) => c.key === ing.key);
    if (perKg > 0) {
      const cost = round2(((grams / n) * perKg) / 1000);
      ps.cost = (ps.cost || 0) - (old?.cost_per_serving || 0) + cost;
      const best = (to.packs || []).filter((p) => p.grams > 0 && !p.stale).sort((x, y) => x.eur_per_kg - y.eur_per_kg)[0];
      const row = { key: opt.key, name_ru: to.name_ru, grams_per_serving: Math.round((grams / n) * 10) / 10, cost_per_serving: cost, store: best?.store || null, is_estimate: false };
      breakdown = old ? breakdown.map((c) => (c === old ? row : c)) : [...breakdown, row];
    }
    swapped.push({ from: ing.key, from_ru: ing.name_ru, to: opt.key, to_ru: to.name_ru, note: opt.note });
    return {
      ...ing, key: opt.key, name_ru: to.name_ru, name_de: to.name_de_generic || to.name_de || to.name_ru,
      amount: grams ? `${Math.round(grams)} г` : ing.amount, grams,
      note: opt.note, replaced: { key: ing.key, name_ru: ing.name_ru, amount: ing.amount, grams: ing.grams },
    };
  });
  if (!swapped.length) return recipe;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    ...recipe, ingredients, cost_breakdown: breakdown, swapped,
    per_serving: { ...ps, cost: round2(Math.max(0, ps.cost)), kcal: Math.round(Math.max(0, ps.kcal)), protein: r1(Math.max(0, ps.protein)), fat: r1(Math.max(0, ps.fat)), carbs: r1(Math.max(0, ps.carbs)) },
  };
}
