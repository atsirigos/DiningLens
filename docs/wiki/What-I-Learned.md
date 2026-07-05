# What I Learned

This was my **first summer internship**, and DiningLens became a full-stack project spanning software, hardware integration, and research context.

## Technical skills

- **Full-stack web development** — Express REST API + vanilla JS SPA without a framework
- **Database design** — SQLite for settings, health telemetry, and API usage tracking
- **Computer vision integration** — prompt engineering, structured JSON output, multi-provider AI (Gemini + Claude)
- **Image processing** — Sharp for rotation and zone cropping
- **Mobile/hardware integration** — Android Debug Bridge for remote camera control over Wi-Fi/USB
- **Systems thinking** — designing for privacy, offline-first storage, and long-running capture sessions
- **Developer tooling** — diagnostic CLI, Windows launch scripts, standalone HTML utilities

## Soft skills

- Translating **research requirements** (privacy, multi-subject dining, passive capture) into software features
- Writing documentation for reproducible lab deployments
- Scoping honestly — prototype vs. clinical product
- Iterating from file-drop MVP → phone capture → scheduled recording → health monitoring

## Challenges I solved

| Challenge | Solution |
|-----------|----------|
| Browsers can't run ADB | Local server bridge: browser → Express → `adb shell` |
| Multi-subject overhead camera | Zone-based cropping and per-region AI analysis |
| Long recording sessions | Battery charge control + phone health monitoring with SQLite history |
| Research data sovereignty | Local-only storage; user-controlled cloud AI keys only |
| Server not running for recording | `start-recording.bat` bootstrap + HTML wait overlay |

## Project evolution

1. **Phase 1** — File-drop gallery + Gemini analysis
2. **Phase 2** — Settings, zones, batch processing, analytics
3. **Phase 3** — Android ADB capture (USB + Wi-Fi)
4. **Phase 4** — Scheduled recording, phone health, charge control
5. **Phase 5** — Standalone recording launcher, presentation deck, documentation

## What I'd tell an admissions reader

I didn't just learn to code — I learned to build tools that fit real constraints: IRB privacy, unreliable hardware, and the gap between "cool AI demo" and "something a lab could actually use."

DiningLens taught me that good engineering means understanding the **problem domain** (nutrition research, precision medicine) as deeply as the **tech stack**.

## Skills demonstrated

- JavaScript (Node.js + browser)
- REST API design
- SQL / SQLite
- Git version control
- Technical writing (wiki, integration guides, presentation)
- Hardware-software integration (ADB)
- AI/ML product integration (not training models, but shipping vision AI responsibly)
