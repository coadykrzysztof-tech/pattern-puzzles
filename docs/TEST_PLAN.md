# CueLab Arena — Comprehensive QA Test Plan

This document defines the automated and manual Quality Assurance (QA) test plan for **CueLab Arena** (`app/`), covering the 100 prebuilt pattern racks, Spin Lab Sandbox & Custom Drills, Practice Planner, Instructor Passcode auth, SQLite backend, isolated Student Share links, and the in-app Help / User Manual viewer.

---

## 1. Test Environment & Automated Verification

### Prerequisites
- **Node.js 22.5+** (built-in `node:http`, `node:sqlite`, `node:crypto`, `node:test`).
- **Local Server**: Start with `cd app && npm start` (default `http://127.0.0.1:3000`).
- **Browsers**: Desktop Chromium/Safari/Firefox (`1440×900`+) and Mobile viewport (`390×844` iOS/Android or DevTools mobile emulation).
- **Test Database Isolation**: Never run destructive tests against a production `cuelab.db`. Pass `DB_PATH=/tmp/cuelab-qa.db` (or `:memory:` in automated tests).

### Automated Test Suites

| Suite | Command | Coverage |
| :--- | :--- | :--- |
| **Backend API, Auth, Snapshots & Static Security** | `cd app && npm test` (`test/practice-planner.test.js`) | Static file allowlist (serves `index.html`, `docs/USER_MANUAL.md`, `docs/screenshots/*.png`; blocks `server.js`, `cuelab.db`, `docs/TEST_PLAN.md`, path traversal), first-time passcode setup & duplicate setup `409`, wrong passcode `401`, custom drill CRUD, plan CRUD, multi-student assignments, post-share plan & custom drill edit immutability, student token `401` on instructor routes, cross-student `drillId` mutation `404`, attempt count overflow `400`, progress & notes persistence. |
| **Syntax & Inline Script Validation** | `node --check server.js && node --check planner.js` | Ensures zero syntax errors across server and client modules. |
| **Multi-Browser Headless Chrome E2E & Screenshot Refresh** | `cd app && npm run docs:screenshots` (`scripts/capture-docs-screenshots.mjs`) | Spins up an isolated server + temporary SQLite DB, drives 3 isolated browser contexts (Instructor desktop + Student 1 mobile + Student 2 mobile), exercises Spin Lab, Plan Builder, Sharing, Student logging/corrections, and Instructor review, and refreshes all 9 screenshots in `docs/screenshots/`. |

---

## 2. Manual QA Test Suites

### Suite A: Prebuilt Pattern Rack Library (100 Run-Outs) & Viewing Modes

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **A-01** | Switch across all 4 disciplines (100 run-outs) | Click `9-Ball`, `10-Ball`, `8-Ball Solids`, and `8-Ball Stripes`. Step through Rack 1 and Rack 25 in each tab using `◀` / `▶` and the dropdown. | Each discipline loads 25 valid racks (`9-Ball` 9 balls, `10-Ball` 10 balls, `8-Ball` 15 balls with distinct `solidsStrokes` vs. `stripesStrokes` and BIH coordinates). No blank canvas or console errors. |
| **A-02** | Shot playback, rotation settle pause & Auto-Run | On 9-Ball Rack 1, click **Start Run-Out ▶**, **↺ Replay**, **▶ Auto-Run**, **◀ Prev**, and **⏮ Setup**. | Balls animate along paths cleanly; when the table rotates 180°, the yellow phase chip (`↻ Rotating Table`) appears and pauses before cue impact. Clicking any `#1`–`#9` pill jumps directly to that shot. |
| **A-03** | POV rotation modes & Manual Flip | Switch between `Auto-Flip ↑`, `Shooter Line ↑`, and `Fixed`. Click **↻ Flip** (and press `F`). | `Auto-Flip ↑` keeps shots aiming upward; `Shooter Line ↑` aligns cue-to-ghost straight up (12 o'clock); `Fixed` holds orientation and `↻ Flip` rotates 180° smoothly. |
| **A-04** | Expanded Table Mode, Ball Size & Coords | Toggle **⛶ Expand Table** (`E`), cycle **● Balls: Std → Lg → XL**, toggle **# Coords**, and switch Cloth colors. Reload the page. | Table fills viewport with unclipped rails and compact single-row bottom dock; ball numbers scale crisply; grid coordinates stay upright when rotated; Expanded, Ball Size, and Cloth preferences persist in `localStorage`. |
| **A-05** | Hover / Tap Ball Magnifier | Move cursor over (desktop) or tap (touch/mobile) any ball on the table. | Cyan halo and high-contrast floating dark-glass magnifier badge appear with ball number, color name, and grid coordinate (e.g., `#1 Yellow · C11`), clamped inside canvas bounds. |
| **A-06** | Interactive Cue-Tip Explorer | Drag the green tip dot on the cue ball widget to Follow, Draw, Left, and Right English; toggle **Aim: Fixed / Adjusted**; click Power `1`–`5`; click **↺ Snap to Coach**. | Green spin curve updates in real time; fixed-aim side spin shows Red Squirt/Throw Miss arrow + X rail impact when missing; **↺ Snap to Coach** restores coach tip & power cleanly. |
| **A-07** | Personal 5-Try Table Scorecard persistence | On 9-Ball Rack 1, click `T1` (✓), `T2` (✓), `T3` twice (✗). Reload browser. Click **Clear Rack**. | Status chip displays `✓ PASSED (2/5)` and `Discipline Mastery: 1 / 25 Racks`. State survives reload (`localStorage` key `cuelab_arena_tries`). Clear resets all 5 slots. |
| **A-08** | Keyboard shortcut guard inside inputs | Focus any `<input>` or `<textarea>` (e.g., Plan Name or Student Note) and type letters `r`, `f`, `e`, and arrow keys. | Characters enter the input normally; table does NOT flip, reset, or toggle Expanded Mode. |

---

### Suite B: Spin Lab Sandbox & Saved Custom Drills

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **B-01** | Drag balls, blockers & target pocket | Open **🧪 Spin Lab**. Drag Cue Ball, 1-Ball, and 8-Ball blocker across the felt. Click **+ Blocker**, **Clear**, and pockets `P1`–`P6` on canvas and side grid. | Balls clamp inside table rails, trajectories & ghost ball recalculate live, blockers trigger `⚠️ HITS #8` or `Blocked by #8-Ball` warnings when obstructing paths, and **▶ Shoot & Roll** animates the shot. |
| **B-02** | Target Leave Zone toggle & drag | Click **🎯 Target Zone** in Spin Lab, then drag the glowing cyan zone circle to another spot on the felt. | Button highlights active; cyan target zone appears at current simulated stop coordinate and drags smoothly with live `TARGET ZONE: <coord>` pill updates. |
| **B-03** | Save, Load, Update & Delete Custom Drill | Click **💾 Save Drill**, enter title & note, save. Click **📂 Saved Drills** → **Load & Edit**, move Cue Ball, click **💾 Save Drill** with "Update existing" checked. Then delete a test custom drill. | Custom drill persists in SQLite (`custom_drills`), reloads exact coordinates/tip/power/targetZone into Spin Lab, updates cleanly, and disappears on delete without breaking previously shared assignments. |

---

### Suite C: Instructor Passcode Auth & Security Boundaries

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **C-01** | First-time passcode setup | Launch with a fresh DB, click **📋 Practice Planner**, enter `< 4` chars (rejected), then enter a valid passcode (`4+` chars) and submit. | Passcode is stored hashed (`scryptSync` + salt) in `app_settings`; session token is issued and saved in instructor browser `localStorage`; Practice Planner unlocks. |
| **C-02** | Duplicate setup blocked | After setup, send `POST /api/instructor/auth/setup` with a new passcode. | Server responds `409 Conflict`; existing passcode remains intact. |
| **C-03** | Lock, Wrong Passcode & Re-login | Click **🔒 Lock**, attempt login with wrong passcode, then login with correct passcode. | Lock revokes session in SQLite; wrong passcode shows error (`401`); correct passcode unlocks Planner again. |
| **C-04** | Unauthorized Instructor API rejection | From an incognito session (no token) AND using a valid Student Assignment token as `Authorization: Bearer <studentToken>`, request `GET /api/instructor/plans` and `GET /api/instructor/assignments`. | Every `/api/instructor/*` endpoint returns `401 Unauthorized`. |
| **C-05** | Static file allowlist & path traversal | Request `/server.js`, `/cuelab.db`, `/.env`, `/docs/TEST_PLAN.md`, `/GEMINI.md`, and `/docs/screenshots/../../server.js`. | All return `404 Not Found` (or `403`); only `index.html`, `data.js`, `planner.js`, `planner.css`, `docs/USER_MANUAL.md`, and valid `docs/screenshots/*.png` files are served. |

---

### Suite D: Practice Plan Creation, Ordering & Immutable Snapshots

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **D-01** | Create multi-drill plan with all 3 drill types | Click **+ New Plan**, enter Plan Name & summary, add: (1) a Single Rack Shot, (2) a Full Pattern Rack, and (3) a Saved Spin Lab Drill. Set custom titles, targets (`7 of 10`, `2 of 5`, `4 of 6`), and coaching notes. Save. | Plan persists in SQLite (`practice_plans` + `practice_plan_drills`) and appears in Saved Plans sidebar with accurate drill count. |
| **D-02** | Drill ordering & Preview on Table | Use **↑** / **↓** to reorder drills, click **👁 Preview** on a drill, verify canvas renders the layout, and click **← Back to Practice Planner**. | Reordering updates numbered badges and persists on save; Preview renders the full table diagram with return banner and restores the Planner cleanly. |
| **D-03** | Target input boundary validation | Attempt to set `targetAttempts = 0`, `targetAttempts = 51`, or `targetSuccesses > targetAttempts` (both via UI and API). | UI auto-clamps targets (`1..50`, `successes <= attempts`); backend rejects invalid values with `400 Bad Request`. |
| **D-04** | Post-share Plan & Custom Drill Immutability | Share Plan P1 with Student A (`7 of 10`, Custom Drill Cue at `R18`). Afterward, edit Custom Drill (move Cue to `E5`), edit Plan P1 (change title, reorder drills, change target to `12 of 15`), and even delete Plan P1. Open Student A's link. | Student A's link still displays the exact original Plan Name, original drill order, original `7 of 10` target, original coaching notes, and original Cue Ball position (`R18`). |
| **D-05** | Multiple students on the same plan | Share Plan P1 with Student A ("Alex") and again with Student B ("Jordan"). | Each receives a unique `student_token` URL; both appear separately in **Student Assignments** with independent progress counters. |

---

### Suite E: Student Practice Mode, Mobile UX & Data Persistence

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **E-01** | Isolated Student DOM & Locked Layout | Open Student A's `?assignment=<token>` link in a fresh/incognito mobile browser (`390×844`). Try tapping/dragging balls on a Custom Spin Lab drill. | `#gameTabs` (9-Ball, Spin Lab, Practice Planner) and `#rackNavBox` are removed from DOM; tapping balls opens the coordinate magnifier but NEVER drags balls or changes the target pocket; `? Help` and viewing tools remain accessible. |
| **E-02** | Mobile layout & tap ergonomics | Inspect Student Mode at `390×844` width. | Header does not stick over attempt cards; **✓ Success** and **✗ Miss** buttons are large (`≥58px` tall), full-width side-by-side, and placed directly below Shot Command (ahead of the optional Cue-Tip Explorer). |
| **E-03** | Log attempts, Undo Last & Tap-to-Flip correction | Tap **✓ Success** and **✗ Miss** 3 times. Tap **↶ Undo Last** (removes #3). Tap slot `#2` directly to flip `✓ ↔ ✗`. Finish remaining attempts to hit `6 of 10` (target `7`). | `Undo Last` removes last entry; tapping any recorded slot toggles its outcome immediately; once `10 of 10` logged, **✓ Success** / **✗ Miss** disable while slot tap-to-flip and **↶ Undo Last** remain active for final corrections. |
| **E-04** | Target Met vs. Target Not Met banners | Complete Drill 1 with `6 of 10` (Target `7`) and Drill 2 with `4 of 5` (Target `3`). | Drill 1 displays `Target Not Met — 6 of 10 successful · Target was 7` (rose banner). Drill 2 displays `✓ Target Met — 4 of 5 successful · Target was 3` (emerald banner). Header pill updates to `✓ Plan Complete · 1 of 2 Targets Met`. |
| **E-05** | Student notes auto-save & reload persistence | Type a note on Drill 1 and Drill 2, wait for `✓ Progress saved`, then hard-reload the browser (and open the same link in a second browser window). | All logged attempts, flipped corrections, target banners, and student notes persist identically from SQLite. |
| **E-06** | Cross-student isolation & invalid token | Open Student B's link; confirm `0` attempts and zero mention of Student A. Also test `PUT /api/student/assignments/<tokenA>/drills/<drillIdOfStudentB>` and `/?assignment=invalid-token`. | Student B starts completely clean; cross-student drill update returns `404`; invalid URL shows clean "Could not open practice link" error state without leaking data. |
| **E-07** | Instructor Review Sync | In Instructor browser, open **Student Assignments** → click **↻ Refresh**, inspect Student A and Student B, and click **👁 View Layout**. | Instructor sees exact updated attempt counts, attempt-by-attempt `#1 ✓`/`#2 ✗` strips, Target Met / Not Met badges, and student notes for each student separately; **👁 View Layout** renders that student's frozen layout. |

---

### Suite F: In-App `? Help` User Manual Viewer

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **F-01** | Open `? Help` on Desktop (Standard/Instructor Mode) | Click **? Help** in the top navigation bar. | Opens scrollable dark-glass modal rendering `docs/USER_MANUAL.md` with all 9 screenshots (`naturalWidth > 0`), role pills, tables, and formatted callouts. Default tab is **📚 All Guide**. |
| **F-02** | Audience filter tabs & Screenshot Lightbox | Click **🎱 Players & Spin Lab**, **🎯 Student Practice**, and **📋 Instructor Guide**. Click any screenshot, then press `Esc` (and `Esc` again). | Each tab cleanly filters visible manual sections; clicking an image opens full-screen zoom lightbox; first `Esc` closes lightbox, second `Esc` closes modal. |
| **F-03** | Open `? Help` in Student Mobile Mode (`390×844`) | Open a Student Assignment link on mobile viewport and tap **? Help**. | Modal opens cleanly edge-to-edge on mobile, defaults straight to **🎯 Student Practice**, renders mobile & desktop screenshots responsively, and exposes zero passcodes or backend endpoint URLs. |
| **F-04** | Graceful `file://` Offline Fallback | Open `app/index.html` directly via `file://` (without `npm start`) and click **? Help**. | Displays the built-in Offline Quick Help fallback explaining `cd app && npm start` (`http://127.0.0.1:3000`) plus core table & keyboard shortcuts — zero unhandled exceptions. |

---

### Suite G: Phase 2 Readiness Regression Checks

| ID | Test Case | Steps | Expected Result |
| :--- | :--- | :--- | :--- |
| **G-01** | Server-side API key hygiene | Set `GEMINI_API_KEY=test-secret-123` in `.env` (or env), call `GET /api/health` and inspect all client JS/HTML responses. | `/api/health` returns `{ "ok": true, "phase2VideoReady": true }` without ever returning or embedding the key value anywhere in responses or client bundles. |
| **G-02** | Video extension table provisioned | Inspect SQLite tables after server boot. | `assignment_drill_videos` table exists with foreign key `assignment_drill_id -> assignment_drills(id) ON DELETE CASCADE`. |
