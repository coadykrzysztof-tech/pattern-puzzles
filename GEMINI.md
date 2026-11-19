# CueLab Arena — Project Rules & Engineering Policy

These rules apply permanently to every future task, feature, bug fix, UI change, or workflow update in the **CueLab Arena** repository (`app/`).

---

## 1. Git Checkpoint & Rollback Safety Rule (Strict)

Before making edits for **any major or multi-file feature update**:
1. **Verify Clean Git State / Checkpoint**:
   - Run `git status` first. Ensure the current working tree is cleanly committed (or ask the user / create a clean checkpoint commit) **or** create a dedicated feature branch (e.g., `git checkout -b feat/<short-name>`) before modifying files.
   - Never mix uncommitted work from an unrelated task into a large feature update without establishing a clean Git rollback point first.
2. **Include Brief Rollback Steps in Completion Summary**:
   - Every completion summary for a major or multi-file change **must** include concise, exact Git rollback instructions (for example, `git revert <commit-hash>` or `git checkout main && git branch -D <feature-branch>`) so the user can safely undo the update in one step if needed.

---

## 2. Mandatory Documentation & QA Auto-Update Rule (Strict)

Whenever you implement **any new feature, UI change, keyboard shortcut, API behavior change, or workflow update**, you **MUST** complete all four steps below **before finishing the task**:

1. **Update the Illustrated User Manual (`docs/USER_MANUAL.md`)**:
   - Document the new or changed user-facing feature in clear, beginner-friendly language.
   - Preserve the `<!-- audience: all|player|student|instructor -->` section markers so the in-app `? Help` viewer's audience filter tabs continue working accurately.
   - **Security Rule**: Keep `docs/USER_MANUAL.md` strictly user-facing — **never** include real passcodes, secret tokens, API keys, database internals, or private `/api/instructor/*` endpoint paths.
2. **Refresh Affected Screenshots (`docs/screenshots/`) & Verify the In-App Help Viewer**:
   - If any visible UI, layout, or workflow changed, re-run `npm run docs:screenshots` (or update `scripts/capture-docs-screenshots.mjs` to add/update screenshots against an isolated temporary SQLite database — **never** modify the user's `cuelab.db`).
   - Confirm every screenshot referenced in `docs/USER_MANUAL.md` exists in `docs/screenshots/` and renders cleanly inside the in-app **`? Help`** modal on both desktop and mobile viewports (because the in-app Help viewer fetches `/docs/USER_MANUAL.md` directly, keeping `docs/USER_MANUAL.md` and `docs/screenshots/` up to date keeps the in-app viewer automatically synchronized).
3. **Update the QA Test Plan (`docs/TEST_PLAN.md`)**:
   - Add or update manual QA test cases (happy paths, edge cases, mobile responsiveness, security/isolation, and persistence) in `docs/TEST_PLAN.md` for every new or modified feature.
   - Add corresponding automated assertions in `test/practice-planner.test.js` (or new test files under `test/`) and verify `npm test` passes.
4. **Keep Security & Architecture Invariants Intact**:
   - Never expose `cuelab.db*`, `.env`, `server.js`, `docs/TEST_PLAN.md`, or `GEMINI.md` through the static file allowlist in `server.js`.
   - Keep student assignment links (`/?assignment=<token>`) strictly isolated to their own frozen snapshot and results.
   - Keep Phase 2 AI/video API keys (such as `GEMINI_API_KEY`) strictly server-side in `.env` / environment variables — never in frontend JS/HTML files.
