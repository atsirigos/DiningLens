# Future Work

## Near term

- [ ] Wiki screenshots (Gallery, Phone Status, Recording summary, Analytics)
- [ ] Playback scrubber on standalone recording page
- [ ] Automated tests for API routes
- [ ] Nav link to recording page from main SPA sidebar

## Research integration

- [ ] EHR / REDCap export formats
- [ ] Cohort-level dashboards across study participants
- [ ] Human-in-the-loop review workflow for AI portion estimates
- [ ] Audit log for data access (shared lab PC deployments)

## Capture hardware

- [ ] Dedicated overhead camera rig documentation (see `table-cam-schematic.html`)
- [ ] Support for multiple simultaneous phones
- [ ] Raspberry Pi / kiosk deployment guide

## AI improvements

- [ ] Calorie estimation from food items + USDA or nutrition database lookup
- [ ] Confidence scores per food item
- [ ] Model comparison mode (run Gemini and Claude side-by-side)
- [ ] Before/after plate comparison (intake delta per meal)

## Product maturity

- [ ] Role-based access if deployed on shared lab PC
- [ ] Docker packaging for reproducible installs
- [ ] Dedicated `/health` liveness endpoint
- [ ] macOS/Linux launcher scripts (parity with `.bat` files)

## Known limitations

- Recording produces JPEG timelapse, not video files
- Charge control may require root on some Android devices
- GPS from `dumpsys location` depends on phone permissions and fix availability
- AI portion weights are estimates — not validated for clinical use
