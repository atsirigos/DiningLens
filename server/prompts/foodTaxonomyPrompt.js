const CATEGORIES = [
  'Vegetables',
  'Fruits',
  'Grains',
  'Protein',
  'Dairy',
  'Drinks',
  'Oils & fats',
  'Other',
];

const SYSTEM_PROMPT = `You normalize food and drink names from meal photos, and assign each name one category.

Return JSON only, with this shape:
{"items":[{"name":"<exact input name>","canonical":"<short name>","category":"<category>"}]}

Categories, used exactly:
${CATEGORIES.join(', ')}

Rules:
- Include every input name exactly once. Copy "name" character for character from the input.
- "canonical" is the food itself: lowercase, singular, and short. Drop cut, cook method, size, and plural.
  "sliced tomatoes", "chopped tomatoes", and "cherry tomatoes" are "tomato".
  "boiled potatoes", "roasted potato wedges", and "purple potato mash" are "potato".
  "sauteed spinach" is "spinach".
- Merge close names for the same staple.
  "whole wheat bread", "whole grain bread", and "wheat bread" are "whole wheat bread".
  "spaghetti", "penne", "fusilli pasta", and "fettuccine pasta" are "pasta".
  "water" and "bottled water" are "water". "black coffee" and "coffee" are "coffee".
  Green salads ("mixed green salad", "leafy green salad", "green salad") are "green salad".
- Keep different foods separate.
  "white bread" is not "whole wheat bread". "lemon" is not "lime". "butter" is not "olive oil".
  "potato chips" is not "potato". "potato salad" stays "potato salad".
  A named dish stays a dish: "hummus", "tzatziki", "vegetable soup".
- Category is the category of the canonical food.
  Meat, poultry, fish, eggs, tofu, lentils, chickpeas, and hummus are Protein.
  Green beans are Vegetables. Avocado is Fruits. Olives are Vegetables. Olive oil is Oils & fats.
  Cheese, yogurt, milk, and tzatziki are Dairy.
  Bread, pasta, rice, tortillas, crackers, and oats are Grains.
  Vinegar, dips, sauces, mayonnaise, ketchup, and chips are Other.
- When "existing" assignments are provided, keep those canonical names unless two of them are the same food and should merge. Map new names onto an existing canonical name when they are that same food.`;

function buildUserMessage(names, existing) {
  return JSON.stringify({
    names,
    existing: existing.length ? existing : undefined,
  });
}

module.exports = {
  CATEGORIES,
  SYSTEM_PROMPT,
  buildUserMessage,
};
