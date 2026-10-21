// Свои приёмы пищи: человек сам собирает завтрак, перекус или обед из продуктов базы или любых товаров каталога.
// Результат — обычный рецепт (тот же формат, что в data/recipes.json): он попадает в подбор плана, список покупок
// и учёт запасов. Товар каталога становится своим продуктом (КБЖУ — с этикетки, вводит человек).
import { chooseOffer, round2 } from './shopping.js';
import { PIECES } from './stock.js';
import { qty as qtyWords } from './qty.js';

// Меры для человека: во что удобно считать продукт. per — граммов в одной мере, step — шаг кнопок ±
const SPOONS = { peanut_butter: 15, honey: 20, butter: 10, hummus: 30, cream_cheese: 30, pesto: 15, sugar: 10, cocoa_drink: 15, sour_cream: 20, mustard: 10 };
const BAGS = { black_tea: 2, fruit_tea: 2 };
// Типичная порция, если человек добавил продукт впервые
const DEFAULT_G = { cornflakes: 50, milk: 250, kefir: 250, skyr: 150, magertopfen: 150, cottage_cheese: 150, greek_yogurt: 150, natural_yogurt: 150,
  protein_pudding: 200, bread: 50, toast_bread: 50, crispbread: 20, rice_cakes: 16, peanuts: 30, dark_chocolate: 20, dates: 40, ham: 50, gouda: 30,
  cabanossi: 50, protein_bar: 45, potato_chips: 30, salt_sticks: 30, popcorn: 25, gummy_bears: 25, milk_chocolate: 25, butter_biscuits: 30 };

export function unitOf(key, product) {
  if (BAGS[key]) return { unit: 'пакетик', per: BAGS[key], step: 1, def: 1 };
  if (SPOONS[key]) return { unit: 'столовая ложка', per: SPOONS[key], step: 1, def: 1 };
  if (PIECES[key]) return { unit: PIECES[key][1], per: PIECES[key][0], step: key === 'eggs' || PIECES[key][0] <= 60 ? 1 : 0.5, def: 1 };
  // свой товар, введённый вручную, в небольшой упаковке (пачка лапши, стаканчик) — считаем упаковками
  const own = product?.manual && (product.packs || [])[0];
  if (own && own.pack_unit !== 'pcs' && own.grams > 0 && own.grams <= 250) return { unit: 'упаковка', per: own.grams, step: 0.5, def: 1 };
  const ml = (product?.packs || []).some((p) => p.pack_unit === 'ml');
  if (ml) return { unit: 'мл', per: 1, step: 50, def: DEFAULT_G[key] || 200 };
  const pcsPack = (product?.packs || []).find((p) => p.pack_unit === 'pcs' && p.grams > 0 && p.pack_size > 0);
  if (pcsPack && product?.custom) return { unit: 'шт.', per: pcsPack.grams / pcsPack.pack_size, step: 1, def: 1 };
  return { unit: 'г', per: 1, step: (DEFAULT_G[key] || 50) <= 30 ? 5 : 10, def: DEFAULT_G[key] || 50 };
}

// Бытовая мера для карточки словами: «1 стакан (250 мл)», «полторы штуки», «2 столовые ложки», «50 г»
export function amountText(key, product, qty) {
  const u = unitOf(key, product);
  if (u.unit === 'мл') return qty === 250 ? '1 стакан (250 мл)' : `${Math.round(qty)} мл`;
  if (u.unit === 'г') return `${Math.round(qty)} г`;
  return qtyWords(qty, u.unit === 'шт.' ? 'штука' : u.unit);
}
export const gramsOf = (key, product, qty) => {
  const u = unitOf(key, product);
  const g = qty * u.per;
  // молоко и кефир чуть тяжелее воды — как в данных цен (build_data.py: DENSITY)
  return u.unit === 'мл' && ['milk', 'kefir'].includes(key) ? g * 1.03 : g;
};

// Цена за кг для «сколько стоит съеденное»: самая выгодная обычная упаковка
function eurPerKg(product) {
  const packs = (product?.packs || []).filter((p) => p.grams > 0 && p.eur_per_kg > 0);
  const fresh = packs.filter((p) => !p.stale && !p.is_estimate);
  const list = fresh.length ? fresh : packs;
  return list.length ? Math.min(...list.map((p) => p.eur_per_kg)) : 0;
}

/**
 * Черновик → рецепт. draft: { id?, title, meal_type, items: [{ key, qty }], note?, tea?: 'black_tea' | 'fruit_tea' | null, plan? }
 * Возвращает рецепт с per_serving (КБЖУ и цена на 1 порцию) и cost_breakdown, как у рецептов из data/.
 */
export function buildCustomRecipe(draft, products) {
  const items = [...(draft.items || [])].filter((i) => products[i.key] && i.qty > 0);
  if (draft.tea && products[draft.tea] && !items.some((i) => i.key === draft.tea)) items.push({ key: draft.tea, qty: 1 });
  const ingredients = items.map((i) => {
    const p = products[i.key];
    return { key: i.key, name_ru: p.name_ru, name_de: p.name_de_generic || p.name_de || p.name_ru, amount: amountText(i.key, p, i.qty), grams: Math.round(gramsOf(i.key, p, i.qty) * 10) / 10, basic: false, optional: false, note: null, qty: i.qty };
  });
  const tot = [0, 0, 0, 0];
  let cost = 0;
  const unknown = [];
  const unknownKeys = [];
  const noPriceKeys = []; // нет веса упаковки — цену за кг не посчитать
  const breakdown = ingredients.map((i) => {
    const p = products[i.key];
    const n = p.nutrition_per_100g;
    if (Array.isArray(n)) for (let j = 0; j < 4; j++) tot[j] += (i.grams * (+n[j] || 0)) / 100;
    else { unknown.push(p.name_ru); unknownKeys.push(i.key); }
    const perKg = eurPerKg(p);
    if (!perKg) noPriceKeys.push(i.key);
    const c = (i.grams * perKg) / 1000;
    cost += c;
    const best = chooseOffer(p, i.grams || 1)?.pack;
    return { key: i.key, name_ru: i.name_ru, grams_per_serving: i.grams, cost_per_serving: round2(c), store: best?.store || null, is_estimate: false };
  });
  const tea = ingredients.some((i) => BAGS[i.key]);
  const steps = [
    ...(tea ? [{ text: 'Вскипяти чайник и залей пакетик чая кипятком, настаивай 3–4 минуты.', timer_min: 4, heat: null }] : []),
    ...ingredients.filter((i) => !BAGS[i.key]).map((i) => ({ text: `${i.name_ru} — ${i.amount}.`, timer_min: null, heat: null })),
    ...(draft.note?.trim() ? [{ text: draft.note.trim(), timer_min: null, heat: null }] : []),
  ];
  const title = draft.title?.trim() || autoTitle(ingredients);
  const active = Math.max(1, Math.min(10, ingredients.filter((i) => !BAGS[i.key]).length));
  return {
    id: draft.id || `my-${Date.now().toString(36)}`,
    custom: true,
    title,
    title_de: null,
    description: draft.description?.trim() || `Свой вариант: ${ingredients.map((i) => i.name_ru.toLowerCase()).join(', ')}`,
    source: { name: 'свой вариант', url: null },
    tags: ['моё', ...(tea ? ['с чаем'] : []), 'без готовки'],
    protein_type: 'other',
    meal_type: draft.meal_type || 'snack',
    servings: 1,
    time: { prep: active, cook: tea ? 4 : 0, total: active + (tea ? 4 : 0), active },
    equipment: tea ? ['Чайник', 'Кружка'] : [],
    tools: [],
    ingredients,
    steps: steps.length ? steps : [{ text: 'Собери всё на тарелке.', timer_min: null, heat: null }],
    mistakes: [],
    substitutions: [],
    storage: { fridge_days: 0, freezable: false, freeze_note: '', reheat: null },
    per_serving: { cost: round2(cost), kcal: Math.round(tot[0]), protein: Math.round(tot[1] * 10) / 10, fat: Math.round(tot[2] * 10) / 10, carbs: Math.round(tot[3] * 10) / 10 },
    cost_breakdown: breakdown,
    main_ingredient_count: ingredients.length,
    unknownNutrition: unknown,
    unknownKeys,
    noPriceKeys,
    draft: { items: draft.items || [], tea: draft.tea || null, note: draft.note || '', title: draft.title || '', meal_type: draft.meal_type || 'snack' },
  };
}

export function autoTitle(ingredients) {
  const names = ingredients.filter((i) => !BAGS[i.key]).map((i) => i.name_ru);
  if (!names.length) return 'Свой вариант';
  const head = names.slice(0, 3).map((n, k) => (k ? n.toLowerCase() : n)).join(', ');
  const tea = ingredients.some((i) => BAGS[i.key]);
  return `${head}${names.length > 3 ? '…' : ''}${tea ? ' + чай' : ''}`;
}

// Свой продукт из товара каталога: цена и фото — из магазина, КБЖУ на 100 г — с этикетки (вводит человек).
// sizeGrams — вес упаковки, если в каталоге его нет; pieceGrams — вес одной штуки для товаров «в штуках»
export function productFromCatalog(it, { name, nutrition, sizeGrams, pieceGrams, zone } = {}) {
  const unit = it.unit || (sizeGrams ? 'g' : null);
  const size = it.size || sizeGrams || null;
  const piece = pieceGrams || it.pieceGrams; // у товара, введённого вручную, вес штуки уже в нём
  const grams = unit === 'pcs' ? (size && piece ? size * piece : null) : size;
  const key = `my_${String(it.ref || `${it.store}_${it.id}`).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
  const pack = {
    store: it.store, name_de: [it.brand, it.name].filter(Boolean).join(' · ').replace(/^(.+) · \1/, '$1'), brand: it.brand || null, budget_line: false,
    pack_size: size || 1, pack_unit: unit || 'g', grams: grams || null, price_eur: it.price,
    eur_per_kg: it.byWeight ? it.price : grams ? round2((it.price / grams) * 1000) : it.per || 0,
    url: it.url || null, date: null, stale: false, is_estimate: false, loose: !!it.byWeight, image: it.image || null,
  };
  return {
    key, custom: true, ref: it.ref || null, ...(it.manual ? { manual: true } : {}),
    name_ru: name?.trim() || it.name, name_de: pack.name_de, name_de_generic: it.name, name_en: null,
    department: zone || 'pantry', zone: zone || null, shelf: it.shelf || null, basic: false,
    nutrition_per_100g: Array.isArray(nutrition) && nutrition.some((x) => +x > 0) ? nutrition.map((x) => +x || 0) : null,
    packs: [pack],
  };
}

// Товар, которого нет в каталоге (Hofer, Lidl, азиатский магазин или просто нет в онлайн-магазине): человек вводит
// название, магазин, цену и упаковку сам. Возвращает товар в формате каталога — его принимают те же «В список»,
// «Есть дома» и productFromCatalog. unit: 'g' | 'ml' | 'pcs'; pieceGrams — вес одной штуки для «шт.»
export const MANUAL_STORES = ['Billa', 'Spar', 'Penny', 'Hofer', 'Lidl', 'Азиатский магазин'];
export function manualItem({ id, name, store, price, size, unit, pieceGrams, shelf } = {}) {
  const u = ['g', 'ml', 'pcs'].includes(unit) ? unit : 'g';
  const s = +size > 0 ? +size : null;
  const pr = +price > 0 ? round2(+price) : null;
  const uid = id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const per = pr && s ? round2(u === 'pcs' ? pr / s : (pr / s) * 1000) : null;
  return {
    ref: `own:${uid}`, key: 'own', id: uid, store: (store || '').trim() || 'Другой магазин', name: (name || '').trim(), brand: '', shelf: shelf || null,
    price: pr, size: s, unit: s ? u : null, per, image: null, url: null, concepts: [], byWeight: false, manual: true,
    pieceGrams: u === 'pcs' && +pieceGrams > 0 ? +pieceGrams : null,
  };
}

// Свои товары, введённые вручную, — обратно в формат каталога: чтобы находились в поиске «Добавить из каталога»
export function manualItems(customProducts, store) {
  return Object.values(customProducts || {}).filter((p) => p.manual && p.packs?.[0] && (!store || p.packs[0].store === store)).map((p) => {
    const pk = p.packs[0];
    return {
      ref: p.ref, key: 'own', id: String(p.ref || p.key).replace(/^own:/, ''), store: pk.store, name: p.name_ru, brand: p.name_ru !== p.name_de_generic ? p.name_de_generic : '',
      shelf: p.shelf, price: pk.price_eur, size: pk.pack_size > 0 && (pk.grams > 0 || pk.pack_unit === 'pcs') ? pk.pack_size : null, unit: pk.pack_unit,
      per: pk.eur_per_kg || null, image: null, url: null, concepts: [], byWeight: false, manual: true, pkey: p.key,
    };
  });
}

// «Как у похожих»: средние КБЖУ продуктов базы с той же полки (хлопья — как у хлопьев, батончик — как у батончиков),
// если на этой полке нет — из того же отдела. null — сравнить не с чем
export function similarNutrition(product, products) {
  // почти без калорий (чай) — не пример для сравнения
  const base = Object.values(products).filter((p) => !p.custom && !p.basic && Array.isArray(p.nutrition_per_100g) && p.nutrition_per_100g[0] > 20);
  for (const same of [base.filter((p) => product.shelf && p.shelf === product.shelf), base.filter((p) => product.zone && p.zone === product.zone)]) {
    if (!same.length) continue;
    const avg = [0, 1, 2, 3].map((j) => Math.round((same.reduce((a, p) => a + +p.nutrition_per_100g[j], 0) / same.length) * 10) / 10);
    return { values: avg, names: same.map((p) => p.name_ru).slice(0, 4) };
  }
  return null;
}

// Подсказка под тип приёма пищи: чего не хватает до привычной нормы приложения
export function mealHint(recipe, targets) {
  const ps = recipe.per_serving;
  if (recipe.meal_type === 'breakfast' && ps.protein < 25) return `Для завтрака маловато белка: ${Math.round(ps.protein)} г из 25+. Добавьте скир, творог, яйца или стакан молока.`;
  if (recipe.meal_type === 'main' && targets?.perMeal && ps.protein < targets.perMeal.protein * 0.7) return `Для обеда или ужина мало белка: ${Math.round(ps.protein)} г, цель ≈ ${Math.round(targets.perMeal.protein)} г.`;
  if (recipe.meal_type === 'snack' && ps.kcal > 600) return `Для перекуса многовато: ${Math.round(ps.kcal)} ккал. Может, это завтрак?`;
  return null;
}
