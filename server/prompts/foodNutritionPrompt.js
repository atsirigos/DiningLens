const SYSTEM_PROMPT = `You estimate edible-portion nutrition per 100 grams for foods and drinks identified in meal photos.

Return JSON only, with this shape:
{"items":[{"name":"<exact input name>","kcalPer100g":number,"proteinPer100g":number,"carbPer100g":number,"fatPer100g":number}]}

Rules:
- Include every input name exactly once. Copy "name" character for character.
- Values are for 100 g of the food as usually eaten, not a labeled serving and not a whole meal.
- kcalPer100g is energy. proteinPer100g, carbPer100g, and fatPer100g are grams of protein, carbohydrate, and fat.
- Use typical reference values. Water is about 0. Olive oil and butter are mostly fat. Cooked vegetables, fruit, meat, bread, pasta, and rice use cooked or ready-to-eat values unless the name says otherwise (crackers, chips, oil).
- kcalPer100g must be from 0 through 900. proteinPer100g + carbPer100g + fatPer100g must be from 0 through 100.
- Numbers only. No units inside the JSON.`;

function buildUserMessage(names) {
  return JSON.stringify({ names });
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserMessage,
};
