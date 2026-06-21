# Meal Analysis: AI Prompt + Cursor Implementation Guide

---

## Part 1: Engineered Claude Prompt for Meal Photo Analysis

Use this as the **system prompt** (or prepend it to the user message) when sending a meal photo to Claude.

---

### System Prompt

```
You are a registered dietitian and nutritional analysis expert. When given a photo of a meal, your job is to identify all visible food items and provide a detailed, structured nutritional breakdown.

Follow these rules strictly:

IDENTIFICATION
- Identify every distinct food item visible in the image, including garnishes, sauces, dressings, and drinks.
- Estimate portion sizes based on visual cues (plate size, utensils, standard serving sizes, context clues).
- If an item is partially obscured, note it and estimate conservatively.
- If a food is ambiguous (e.g. "could be chicken or tofu"), list the most likely option and flag it.

NUTRITIONAL ANALYSIS
For each food item, estimate:
- Calories (kcal)
- Protein (g)
- Total fat (g)
- Saturated fat (g)
- Total carbohydrates (g)
- Dietary fiber (g)
- Sugars (g)
- Sodium (mg)

Also calculate meal-level totals for all of the above.

CONFIDENCE & TRANSPARENCY
- Assign a confidence level to the overall analysis: High / Medium / Low
- List specific items or factors that reduce your confidence (hidden ingredients, sauces, cooking methods not visible, etc.)
- Note if any item significantly changes the nutritional profile depending on preparation (e.g. "if fried vs. baked, calories could differ by ~150 kcal")

HEALTH INSIGHTS
- Briefly evaluate the meal against general dietary guidelines (protein adequacy, fiber content, sodium level, saturated fat)
- Flag any notable nutritional concerns (e.g. very high sodium, low protein, excessive added sugars)
- Note any standout positives (e.g. high fiber, good micronutrient sources)

OUTPUT FORMAT
Respond only with a JSON object in this exact structure — no prose, no markdown fences:

{
  "meal_name": "string — short descriptive name of the meal",
  "confidence": "High | Medium | Low",
  "confidence_notes": "string — what affects confidence",
  "items": [
    {
      "name": "string",
      "portion_estimate": "string (e.g. '1 cup', '150g', '1 medium slice')",
      "flagged": false,
      "flag_reason": "string or null",
      "calories": number,
      "protein_g": number,
      "fat_total_g": number,
      "fat_saturated_g": number,
      "carbs_total_g": number,
      "fiber_g": number,
      "sugars_g": number,
      "sodium_mg": number
    }
  ],
  "totals": {
    "calories": number,
    "protein_g": number,
    "fat_total_g": number,
    "fat_saturated_g": number,
    "carbs_total_g": number,
    "fiber_g": number,
    "sugars_g": number,
    "sodium_mg": number
  },
  "health_insights": {
    "concerns": ["string"],
    "positives": ["string"],
    "summary": "string — 1–2 sentence overall assessment"
  }
}
```

---

### User Message (sent with each photo)

```
Please analyze this meal photo and return the full nutritional breakdown in the specified JSON format.

[OPTIONAL — append any of these if the user provides context]:
- "This is a restaurant meal from [cuisine type]."
- "Estimated plate diameter is about 10 inches."
- "I ate approximately half of what's shown."
- "The dressing is on the side."
```

---

### Prompt Engineering Notes

| Design Decision | Rationale |
|---|---|
| JSON-only output | Enables clean parsing; no need to strip markdown |
| Confidence field | Sets user expectations; prevents over-trust in estimates |
| Per-item + totals | Lets users drill down or just read the summary |
| `flagged` field on items | Surfaces ambiguous items for user review without hiding them |
| Structured health_insights | Gives actionable feedback without burying it in macros |
| Optional user context appended | Improves accuracy when users provide extra info |

---

---

## Part 2: Cursor Instructions — Implementing Photo Meal Analysis

Copy and paste the following into Cursor as a prompt (or into a `AGENTS.md` / task file).

---

### Cursor Implementation Prompt

```
I need you to add a meal photo analysis feature to this app. The feature uses the Anthropic Claude API (claude-sonnet-4-6) with vision to analyze a photo of a meal and return structured nutritional data. Follow these instructions precisely.

---

## 1. Install dependencies (if not already present)

If this is a React/Next.js app:
- No new packages needed beyond the existing fetch API

If using the Anthropic SDK:
- npm install @anthropic-ai/sdk

---

## 2. Environment variable

Add to .env.local (or .env):
  ANTHROPIC_API_KEY=your_key_here

Never expose this key on the client side. All API calls must go through a server-side route.

---

## 3. Create the API route

Create a new file: /app/api/analyze-meal/route.ts  (Next.js App Router)
OR: /pages/api/analyze-meal.ts  (Pages Router)
OR: /server/routes/analyze-meal.js  (Express)

This route must:
a) Accept a POST request with a body of { imageBase64: string, mimeType: string, userContext?: string }
b) Validate that imageBase64 and mimeType are present
c) Call the Anthropic API with the vision-capable model "claude-sonnet-4-6"
d) Use the following system prompt verbatim:

SYSTEM PROMPT START ---
You are a registered dietitian and nutritional analysis expert. When given a photo of a meal, your job is to identify all visible food items and provide a detailed, structured nutritional breakdown.

Follow these rules strictly:

IDENTIFICATION
- Identify every distinct food item visible in the image, including garnishes, sauces, dressings, and drinks.
- Estimate portion sizes based on visual cues (plate size, utensils, standard serving sizes, context clues).
- If an item is partially obscured, note it and estimate conservatively.
- If a food is ambiguous, list the most likely option and flag it.

NUTRITIONAL ANALYSIS
For each food item, estimate: Calories (kcal), Protein (g), Total fat (g), Saturated fat (g), Total carbohydrates (g), Dietary fiber (g), Sugars (g), Sodium (mg). Also calculate meal-level totals.

CONFIDENCE & TRANSPARENCY
- Assign a confidence level: High / Medium / Low
- List specific items or factors that reduce confidence
- Note if preparation method significantly changes nutritional profile

HEALTH INSIGHTS
- Evaluate the meal against general dietary guidelines
- Flag nutritional concerns (high sodium, low protein, excessive sugars)
- Note nutritional positives (high fiber, good micronutrient sources)

OUTPUT FORMAT
Respond only with a JSON object — no prose, no markdown fences:

{
  "meal_name": "string",
  "confidence": "High | Medium | Low",
  "confidence_notes": "string",
  "items": [
    {
      "name": "string",
      "portion_estimate": "string",
      "flagged": false,
      "flag_reason": "string or null",
      "calories": number,
      "protein_g": number,
      "fat_total_g": number,
      "fat_saturated_g": number,
      "carbs_total_g": number,
      "fiber_g": number,
      "sugars_g": number,
      "sodium_mg": number
    }
  ],
  "totals": {
    "calories": number,
    "protein_g": number,
    "fat_total_g": number,
    "fat_saturated_g": number,
    "carbs_total_g": number,
    "fiber_g": number,
    "sugars_g": number,
    "sodium_mg": number
  },
  "health_insights": {
    "concerns": ["string"],
    "positives": ["string"],
    "summary": "string"
  }
}
--- SYSTEM PROMPT END

e) Build the user message as:
   - An image content block: { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } }
   - A text block: "Please analyze this meal photo and return the full nutritional breakdown in the specified JSON format." + (userContext if provided)

f) Parse the response: extract the text from data.content[0].text, strip any accidental markdown fences (```json ... ```), then JSON.parse() it.

g) Return the parsed JSON as the response body with status 200, or return a structured error with status 500.

---

## 4. Create the image upload utility

Create /lib/imageUtils.ts (or .js):

This file must export a function:
  convertImageToBase64(file: File): Promise<{ base64: string, mimeType: string }>

It must:
- Accept a File object from an <input type="file"> or drag-and-drop
- Use FileReader to read the file as a Data URL
- Strip the data URL prefix (everything before and including the comma)
- Return { base64: string, mimeType: string } where mimeType is file.type

Also export: ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]
And: MAX_FILE_SIZE_MB = 20

---

## 5. Create the MealAnalyzer component

Create /components/MealAnalyzer.tsx (or .jsx):

This component must:

STATE
- photo: File | null
- preview: string | null (object URL for display)
- userContext: string
- isLoading: boolean
- result: MealAnalysisResult | null  (use the JSON shape from the system prompt as your TypeScript type)
- error: string | null

BEHAVIOR
- Render a file input (accept="image/*") and a drag-and-drop zone
- On file selection: validate file type and size, set photo state, create preview URL with URL.createObjectURL()
- Render an optional text input for userContext (placeholder: "Add context — e.g. 'half portion' or 'restaurant meal'")
- Render an "Analyze meal" button — disabled when no photo is selected or isLoading is true
- On button click:
    1. Set isLoading = true, clear error
    2. Call convertImageToBase64(photo)
    3. POST to /api/analyze-meal with { imageBase64, mimeType, userContext }
    4. On success: set result, set isLoading = false
    5. On error: set error message, set isLoading = false

DISPLAY — Results section (shown when result is not null):
- Show meal_name as a heading
- Show confidence badge (color: green for High, amber for Medium, red for Low) with confidence_notes in a tooltip or subtext
- Show a "Totals" summary card with: Calories, Protein, Carbs, Fat (use large number + label layout)
- Show a breakdown table with each item: name, portion_estimate, calories, protein_g, carbs_total_g, fat_total_g — flag ambiguous items with a ⚠ icon and flag_reason tooltip
- Show health_insights: list concerns in red, positives in green, summary in regular text
- Show a "Log this meal" button (for now, log to console or call a placeholder onLogMeal prop)

ACCESSIBILITY
- All inputs must have labels
- Loading state must use aria-busy and a visible spinner
- Error messages must use role="alert"

---

## 6. Add TypeScript types

Create /types/mealAnalysis.ts:

Export these interfaces matching the API response shape exactly:
- MealItem
- MealTotals
- HealthInsights
- MealAnalysisResult

---

## 7. Wire it up

Add MealAnalyzer to the appropriate page in the app (e.g. /app/log/page.tsx or wherever meal logging lives). Import it and render it. No additional props are required for initial functionality.

---

## 8. Error handling requirements

- If the API returns an error or the JSON is malformed, display: "We couldn't analyze this photo. Try a clearer image with better lighting."
- If the file is too large: "Please use an image under 20MB."
- If the file type is invalid: "Please upload a JPEG, PNG, WebP, or GIF."
- All errors must clear when the user selects a new photo.

---

## 9. Do NOT

- Do not expose ANTHROPIC_API_KEY in any client-side code
- Do not use any third-party nutrition database APIs — all analysis comes from Claude
- Do not store the base64 image in state longer than needed; revoke object URLs on component unmount
- Do not add any UI library dependencies beyond what's already in the project
```

---

## Quick Reference: API Call Structure

```typescript
// Server-side only
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,  // the full system prompt from Part 1
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,  // e.g. "image/jpeg"
              data: imageBase64
            }
          },
          {
            type: "text",
            text: `Please analyze this meal photo and return the full nutritional breakdown in the specified JSON format.${userContext ? `\n\nContext: ${userContext}` : ""}`
          }
        ]
      }
    ]
  })
});

const data = await response.json();
const rawText = data.content[0].text;
const cleaned = rawText.replace(/```json|```/g, "").trim();
const result = JSON.parse(cleaned);
```
