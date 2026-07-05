# Problem & Motivation

## The bottleneck

Dietary assessment is a major bottleneck in precision medicine and nutrition research:

- **Self-reported intake** is often inaccurate and hard to sustain in long studies
- **Manual logging** creates participant burden
- **Multi-subject dining** (e.g. a shared table) needs per-person tracking from one camera
- **Privacy constraints** (IRB, HIPAA-adjacent concerns) mean photos cannot casually leave the institution

## What researchers need

1. Passive, objective meal documentation
2. Structured, exportable dietary phenotypes
3. Local processing with optional cloud AI (user-controlled API keys)
4. Repeatable fixed-camera lab deployments

## DiningLens's role

DiningLens addresses the **data collection layer** — turning meal photos into structured intake signals that downstream pipelines (cohort analytics, validation studies, future EHR integration) can consume.

## Internship context

This project was developed during my **first summer internship** at **NYU Langone Health (Precision Medicine, July 2026)**. I worked on building a practical tool that researchers could deploy in lab settings with minimal cloud dependency.

## Design principles

1. **Local-first** — photos, settings, and telemetry stay on the machine
2. **User-controlled AI** — only your API keys; no DiningLens cloud
3. **Research-ready export** — JSON output for downstream analysis
4. **Hardware-flexible** — file drop, one-shot snap, or automated timelapse recording
