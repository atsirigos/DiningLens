# DiningLens

**AI-powered, privacy-first meal analytics for research and clinical innovation**

> *Built during my first summer internship (July 2026) at NYU Langone Health, Precision Medicine.*

---

## What is DiningLens?

DiningLens is a **local-only web application** that turns meal photos into structured dietary data. It was designed for research environments where:

- Manual food logging is burdensome and inaccurate
- Meal photos must stay on-premises
- Multiple subjects may share one fixed overhead camera
- Researchers still want modern vision AI (Gemini / Claude)

The app captures photos from an Android phone over ADB, stores everything locally, runs AI analysis to identify foods and estimate visible portions, and visualizes patterns over time.

**Tagline:** *Local Meal Analytics*

---

## Quick links

- [Problem & Motivation](Problem-and-Motivation)
- [Architecture](Architecture)
- [Features](Features)
- [Getting Started](Getting-Started)
- [Phone & Recording Setup](Phone-and-Recording-Setup)
- [AI Analysis Pipeline](AI-Analysis-Pipeline)
- [API Reference](API-Reference)
- [What I Learned](What-I-Learned)
- [Future Work](Future-Work)

---

## At a glance

| | |
|---|---|
| **Stack** | Node.js, Express 5, SQLite, Vanilla JS SPA |
| **AI** | Google Gemini, Anthropic Claude |
| **Capture** | Android phone via ADB (USB / Wi-Fi) |
| **Storage** | 100% local — `data/`, SQLite, JSON cache |
| **Modules** | 9 integrated tabs (Settings → Analytics) |

---

## How to run (30 seconds)

```bash
git clone https://github.com/atsirigos/DiningLens.git
cd DiningLens
npm install
cp .env.example .env   # add your API key
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

Or double-click **`start-recording.bat`** for the standalone recording launcher.

---

## Project status

DiningLens is a **research prototype** — a dietary data collection tool, not a diagnostic product. AI portion estimates require human review; EHR and genomics integration are future work.
