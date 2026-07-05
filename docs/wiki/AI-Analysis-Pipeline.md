# AI Analysis Pipeline

## What the AI returns

For each photo, vision models identify visible foods and estimate **visible portion weight in grams** — not standard serving sizes. The model does not calculate calories or macros directly; those are derived downstream from food names and weights.

Example JSON schema:

```json
{
  "items": [
    {
      "name": "grilled chicken",
      "estimated_weight_grams": 120,
      "count": 1,
      "is_composite": false
    },
    {
      "name": "white rice",
      "estimated_weight_grams": 85,
      "count": 1,
      "is_composite": false
    }
  ]
}
```

## Prompt design

The system prompt (`server/prompts/mealAnalysisPrompt.js`) instructs the model to:

- Estimate **visible** portions, not standard servings
- Split combined items ("rice and beans" → separate line items)
- Keep well-known dish names intact ("mac and cheese")
- Include visible sauces, dressings, and drinks when distinct
- Return structured JSON only

Optional user context can be passed at processing time (e.g. "half portion eaten").

## Supported providers

| Provider | Example models |
|----------|----------------|
| Google Gemini | 2.0 Flash, 2.5 Flash/Pro, 3.0 Flash |
| Anthropic Claude | Haiku 4.5, Sonnet 4.6 |

Configure in **Settings**. API keys can live in `.env` or the Settings UI (stored in SQLite).

## Zone-aware analysis

When zones are configured on a reference photo:

1. Each zone is cropped from the full image using Sharp (`server/utils/zoneCropper.js`)
2. AI analyzes each crop independently
3. Results are merged per zone name (`server/utils/mergeZoneResults.js`)

This enables tracking **multiple subjects** at one table from a single overhead camera.

## Processing flow

```
Image in data/
    ↓
(Optional) Zone crops
    ↓
AI provider API call (image + prompt)
    ↓
Parse JSON response
    ↓
Cache in processed/results.json
    ↓
Display in Gallery / Processing / Analytics
```

## Caching

- Results cached in `processed/results.json`
- Re-run from Processing tab to refresh
- Clear cache: `DELETE /api/process/:filepath`

## Cost tracking

Every API call is logged in SQLite with:

- Provider and model
- Token estimates
- Estimated cost (via `server/utils/aiPricing.js`)

View in Settings or `GET /api/usage`.

## Diagnostic CLI

```bash
npm run diagnose
npm run diagnose -- --file myphoto.jpg --verbose
```

Runs preflight checks (env, DB, settings, image files) and optionally a live API call.

## Limitations (honest scope)

- Portion estimates are **visual approximations** — human review recommended
- Not a medical diagnostic tool
- Nutrition/calorie charts in Analytics are derived estimates, not clinical measurements
- Composite dishes follow explicit prompt rules; edge cases may need manual correction
