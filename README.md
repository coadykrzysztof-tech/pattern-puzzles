# CueLab Arena — Pattern Puzzles, Spin Lab & Practice Planner

Interactive 8-Ball, 9-Ball, and 10-Ball Pattern Puzzles, Spin Lab physics trainer, and Instructor Practice Planner.

## Features
- **75 Racks / 100 Physics-Verified Run-Outs** across 9-Ball, 10-Ball, 8-Ball Solids, and 8-Ball Stripes
- **Shooter-Perspective Table Rotation** (`Auto-Flip ↑`, `Shooter Line ↑`, `Fixed`) with choreographed rotation settle pauses
- **Interactive Cue-Tip & Tangent Explorer** with real-time 90° tangent line, multi-rail English paths, and squirt/throw miss visualization
- **Spin Lab Sandbox & Custom Drill Library** with draggable balls, target leave zones (`🎯 Target Zone`), and saved reusable custom drills
- **Practice Planner & Isolated Student Links**
  - Build ordered practice plans from single rack shots, full pattern racks, or saved Spin Lab drills
  - Configure per-drill attempt & success targets (e.g., `7 of 10`) and coaching notes
  - Generate isolated capability links (`/?assignment=<token>`) with immutable layout & target snapshots per student
  - Phone-friendly student attempt logging (`✓ Success` / `✗ Miss`), 1-tap correction & undo, per-drill student notes, persistent progress, and instructor review
- **Surface / Tablet Expanded Mode** (`⛶ Expand Table`, `● Balls: Std / Lg / XL`, and Hover/Touch Ball Magnifier)

## Quick Start

Requires **Node.js 22.5+** (uses built-in `node:http` and `node:sqlite` — zero external npm dependencies).

```bash
cd app
npm start
```

Open `http://127.0.0.1:3000` in your browser, click **📋 Practice Planner**, and set your Instructor Passcode on first launch.

## Running Tests

```bash
cd app
npm test
```
