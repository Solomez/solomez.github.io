// Что приготовить из того, что дома, и что докупить, чтобы вариантов стало больше.
// home — { key: граммы | Infinity } (запасы сейчас; базовые продукты считаются в наличии).
import { eligibleRecipes, portionFactor, missingFromHome, haveOf } from './planner.js';
import { chooseOffer, round2 } from './shopping.js';

const mainIngs = (r) => r.ingredients.filter((i) => !i.basic && !i.optional && i.key !== 'water');

// Все подходящие блюда типа type с тем, чего не хватает дома. Обед или ужин — на 2 порции (ужин + обед завтра)
export function rankByHome(recipes, home, { prefs, targets, products = {}, type = 'main', prefer = [] }) {
  const pref = new Set(prefer);
  return eligibleRecipes(recipes, prefs, type).map((r) => {
    const factor = type === 'main' ? portionFactor(r, targets) : 1;
    const portions = type === 'main' ? r.servings || 2 : 1;
    const missing = missingFromHome(r, factor, portions, home).map((m) => {
      const offer = products[m.key] ? chooseOffer(products[m.key], m.grams) : null;
      return { ...m, name: products[m.key]?.name_ru || m.key, offer, cost: offer?.cost || 0 };
    });
    const ings = mainIngs(r);
    return {
      recipe: r, factor, portions, missing,
      buyCost: round2(missing.reduce((a, m) => a + m.cost, 0)),
      fromHome: ings.filter((i) => haveOf(home, i.key) > 0).length, total: ings.length,
      expiring: ings.filter((i) => pref.has(i.key) && haveOf(home, i.key) > 0).map((i) => i.key),
    };
  });
}

// Можно приготовить прямо сейчас: сначала то, что спасает продукты «скоро испортится», затем — где больше своего
export function cookableNow(ranked) {
  return ranked.filter((x) => !x.missing.length)
    .sort((a, b) => b.expiring.length - a.expiring.length || b.fromHome - a.fromHome
      || b.recipe.per_serving.protein / Math.max(0.3, b.recipe.per_serving.cost) - a.recipe.per_serving.protein / Math.max(0.3, a.recipe.per_serving.cost));
}

// Почти: не хватает 1–max продуктов — сначала дешевле докупить и меньше продуктов
export function almostCookable(ranked, max = 3) {
  return ranked.filter((x) => x.missing.length && x.missing.length <= max)
    .sort((a, b) => a.missing.length - b.missing.length || a.buyCost - b.buyCost || b.expiring.length - a.expiring.length);
}

/**
 * Что докупить: продукты, покупка которых открывает больше всего блюд.
 * unlock — блюда, которым не хватает только этого продукта; helps — блюда, где он один из 2–3 недостающих.
 * Пары — когда два продукта вместе открывают хотя бы два блюда, которые не открывает ни один из них поодиночке.
 */
export function buySuggestions(rankedLists, products = {}, { limit = 6 } = {}) {
  const all = rankedLists.flat();
  const by = new Map();
  for (const x of all) {
    if (!x.missing.length || x.missing.length > 3) continue;
    for (const m of x.missing) {
      const e = by.get(m.key) || { key: m.key, name: m.name, unlock: [], helps: [], grams: 0 };
      (x.missing.length === 1 ? e.unlock : e.helps).push(x.recipe);
      e.grams = Math.max(e.grams, m.grams);
      by.set(m.key, e);
    }
  }
  const singles = [...by.values()].map((e) => {
    const offer = products[e.key] ? chooseOffer(products[e.key], e.grams) : null;
    return { ...e, offer, cost: offer?.cost || 0, score: e.unlock.length * 3 + e.helps.length * 0.5 };
  }).filter((e) => e.unlock.length || e.helps.length >= 2)
    .sort((a, b) => b.score - a.score || a.cost - b.cost).slice(0, limit);
  const pairs = new Map();
  for (const x of all) {
    if (x.missing.length !== 2) continue;
    const keys = x.missing.map((m) => m.key).sort();
    const id = keys.join('+');
    const p = pairs.get(id) || { keys, names: x.missing.map((m) => m.name), unlock: [], cost: round2(x.missing.reduce((a, m) => a + m.cost, 0)) };
    p.unlock.push(x.recipe);
    pairs.set(id, p);
  }
  const bundles = [...pairs.values()].filter((p) => p.unlock.length >= 2).sort((a, b) => b.unlock.length - a.unlock.length || a.cost - b.cost).slice(0, 3);
  return { singles, bundles };
}

// Заканчивается: то, что идёт во многие блюда, а дома почти не осталось. [{ key, name, grams, uses }]
export function runningLow(stock, recipes, products = {}, { min = 4 } = {}) {
  const uses = {};
  for (const r of recipes) for (const i of r.ingredients) if (i.key !== 'water' && !i.optional) uses[i.key] = (uses[i.key] || 0) + 1;
  const out = [];
  for (const [key, s] of Object.entries(stock)) {
    const p = products[key];
    if (!p || s.grams === Infinity || !(s.base > 0 || s.added > 0)) continue; // только то, что было дома
    if ((uses[key] || 0) < min) continue;
    const typical = Math.max(...recipes.flatMap((r) => r.ingredients.filter((i) => i.key === key).map((i) => i.grams)), 1);
    if (s.grams < typical * 0.8) out.push({ key, name: p.name_ru, grams: s.grams, uses: uses[key] });
  }
  return out.sort((a, b) => b.uses - a.uses);
}
