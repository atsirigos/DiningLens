# GitHub Wiki source files

This folder contains the source Markdown for the [DiningLens GitHub Wiki](https://github.com/atsirigos/DiningLens/wiki).

## Pages

| File | Wiki page title |
|------|-----------------|
| `Home.md` | Home |
| `Problem-and-Motivation.md` | Problem & Motivation |
| `Architecture.md` | Architecture |
| `Features.md` | Features |
| `Getting-Started.md` | Getting Started |
| `Phone-and-Recording-Setup.md` | Phone & Recording Setup |
| `AI-Analysis-Pipeline.md` | AI Analysis Pipeline |
| `API-Reference.md` | API Reference |
| `What-I-Learned.md` | What I Learned |
| `Future-Work.md` | Future Work |

## How to publish to GitHub Wiki

### Option A — Manual (simplest)

1. Open your repo on GitHub → **Wiki** tab
2. If Wikis are disabled: **Settings → Features → Wikis** → Enable
3. Click **Create the first page**, title it **Home**
4. Copy the contents of `Home.md` into the editor and save
5. For each other file: **New Page**, use the **Wiki page title** from the table above, paste content, save

GitHub Wiki page titles with `&` are fine (e.g. "Problem & Motivation"). The filename `Problem-and-Motivation.md` maps to that title when you create the page manually.

### Option B — Clone the wiki repo

GitHub Wikis are separate git repos:

```bash
git clone https://github.com/atsirigos/DiningLens.wiki.git
```

Copy all `*.md` files from this folder into the clone (rename if needed to match GitHub's slug convention), then:

```bash
git add .
git commit -m "Add DiningLens wiki documentation"
git push
```

> **Note:** GitHub Wiki uses `Home` (not `Home.md`) as the filename in the wiki git repo. Other pages use the page title with spaces replaced by hyphens.

### Option C — gh CLI (if installed)

There is no single `gh wiki publish` command. Use Option A or B.

## Keeping in sync

Edit files in `docs/wiki/` in this repo, then re-copy to GitHub Wiki when documentation changes. The wiki source lives here so it is version-controlled alongside the code.

## Link from README

Add to your README:

```markdown
📖 [Full documentation (Wiki)](https://github.com/atsirigos/DiningLens/wiki)
```
