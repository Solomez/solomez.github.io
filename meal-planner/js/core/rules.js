// Жёсткие исключения из исходного задания — те же, что в scripts/build_data.py: каши (включая гречку),
// супы, рыба и морепродукты. Брокколи, баклажан, кабачок и шпинат — только понемногу, не основа блюда.
export const FORBIDDEN_KEYS = new Set(['fish_sauce', 'oyster_sauce', 'tuna', 'salmon', 'shrimp', 'anchovy', 'worcestershire',
  'worcestershire_sauce', 'buckwheat', 'oats', 'semolina', 'polenta']);
export const FORBIDDEN = [/каш[аиуе]\b/, /овсян/, /манк/, /гречк/, /гречн/, /\bсуп\b/, /\bсупа\b/, /\bсупы\b/, /на бульоне/, /рыб/,
  /тунец/, /тунц/, /лосос/, /кревет/, /кальмар/, /мидии/, /анчоус/, /вустер/, /устрич/, /морепродукт/, /fisch/, /thunfisch/,
  /garnele/, /worcester/, /oyster/, /fish/, /porridge/, /grieß/, /buchweizen/, /suppe/, /полент/];
export const SOFT = new Set(['broccoli', 'eggplant', 'zucchini', 'spinach_frozen', 'spinach']);
export const SOFT_MAX_G_PER_SERVING = 30;

export function forbiddenWord(text) {
  const t = String(text || '').toLowerCase();
  for (const re of FORBIDDEN) { const m = t.match(re); if (m) return m[0]; }
  return null;
}

// Можно ли продукт поставить в блюдо вместо другого: не запрещён и не «мягкое» исключение
export function allowedProduct(key, product) {
  if (FORBIDDEN_KEYS.has(key) || SOFT.has(key)) return false;
  return !forbiddenWord(`${product?.name_ru || ''} ${product?.name_de || ''} ${product?.name_de_generic || ''}`);
}
