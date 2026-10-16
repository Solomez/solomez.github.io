// Кухонная утварь: что есть дома. Без «обязательной» блюдо не приготовить — его нет в подборе;
// «заменимую» можно обойти — тогда в шаге рецепта подсказка, как обойтись без неё.

export const TOOLS = [
  { id: 'oven', ru: 'Духовка', en: 'Oven', de: 'Backofen', hard: true },
  { id: 'pan', ru: 'Сковорода', en: 'Frying pan', de: 'Pfanne', hard: true },
  { id: 'pot', ru: 'Кастрюля', en: 'Pot', de: 'Kochtopf', hard: true },
  { id: 'baking_dish', ru: 'Форма для запекания', en: 'Baking dish', de: 'Auflaufform', hard: true },
  { id: 'tray', ru: 'Противень', en: 'Baking tray', de: 'Backblech', hard: true },
  { id: 'blender', ru: 'Блендер', en: 'Blender', de: 'Mixer / Stabmixer', hard: true },
  { id: 'microwave', ru: 'Микроволновка', en: 'Microwave', de: 'Mikrowelle', hard: true },
  { id: 'lid', ru: 'Крышка для сковороды или кастрюли', en: 'Lid', de: 'Deckel', hard: false },
  { id: 'grater', ru: 'Тёрка', en: 'Grater', de: 'Reibe', hard: false },
  { id: 'sieve', ru: 'Сито или дуршлаг', en: 'Sieve / colander', de: 'Sieb', hard: false },
];
export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

// По умолчанию — как в исходных условиях: плита, сковорода, кастрюля, духовка, блендер; микроволновки нет
export const DEFAULT_EQUIPMENT = Object.fromEntries(TOOLS.map((t) => [t.id, t.id !== 'microwave']));

export const has = (equipment, id) => (equipment?.[id] ?? DEFAULT_EQUIPMENT[id]) !== false;

// Каких обязательных вещей не хватает для рецепта: [[варианты], ...] → названия
export function missingTools(recipe, equipment) {
  return (recipe.tools || []).filter((g) => !g.some((id) => has(equipment, id))).map((g) => g.map((id) => TOOL[id]?.ru || id).join(' или '));
}
export const canCook = (recipe, equipment) => missingTools(recipe, equipment).length === 0;

// Подсказки к шагу, если заменимой утвари нет
const WORKAROUND = {
  grate: 'Нет тёрки — нарежь как можно мельче ножом.',
  zest: 'Нет тёрки — тонко срежь ножом только жёлтый слой кожуры и мелко поруби.',
  rinse: 'Нет сита — промой прямо в кастрюле: залей холодной водой, перемешай рукой и аккуратно слей, придерживая крупу ладонью. Повтори 2–3 раза.',
  drain: 'Нет сита или дуршлага — сливай воду, придерживая содержимое крышкой (или приоткрытой крышкой банки); консервы потом промой в миске.',
  sift: 'Нет сита — посыпай муку тонким слоем через пальцы, всё время помешивая, чтобы не было комков.',
  cover: 'Нет крышки — накрой большой тарелкой, противнем или фольгой.',
};
export function stepHints(step, equipment) {
  return (step.tools || []).filter((u) => !has(equipment, u.tool)).map((u) => WORKAROUND[u.kind]).filter(Boolean);
}

// Разогрев готового: с микроволновкой — быстрее, без неё — на сковороде или в кастрюле
export function reheatHint(recipe, equipment) {
  if (has(equipment, 'microwave')) return 'Разогрев: в микроволновке под крышкой или тарелкой, 2–3 мин на полной мощности, перемешав на середине.';
  return 'Разогрев: на сковороде или в кастрюле на среднем огне 4–6 мин с 1–2 ст. л. воды, помешивая.';
}
