> **Output directory:** All source files are written under `generated_app/`. Paths throughout this document are relative to that directory.

# Agent Operating Procedure

This document is the operating procedure for every agent that implements a feature in this project. Read it fully before writing any code.

---

## How to run this harness

This project uses the Claude Code **Workflow** tool. There is no `npm start`.

**Run the next TODO feature automatically:**
Open this project in Claude Code and invoke the Workflow tool with:
  scriptPath: harness/workflow.js

**Target a specific feature:**
Pass args to the Workflow tool:
  scriptPath: harness/workflow.js
  args: { "feature": "F-00" }

The workflow picks the first feature whose dependencies are all DONE (or the one you specify), runs the creator/evaluator loop, and writes the result back to `harness/features.json`.

---

## What you receive per run

Each agent run targets **one feature** from `specs/`. You receive:

1. A role/format instruction block from `harness/prompts/creator.md`
2. This document (`CLAUDE.md`)
3. The feature spec from `specs/<id>.md` (e.g., `specs/F-03.md`)
4. The files listed under **Context to load** for that feature (see table below)
5. The list of expected output files you must write to disk

You do not receive the full codebase. Do not import files that are not in your context unless they are listed as dependencies for the feature you are building.

---

## Process — follow this order exactly *(Creator agent only)*

1. **Read your feature spec** — understand the module contract, function signatures, behavioral contracts, and test list before writing a single line.
2. **Write all tests first** — one test per Given/When/Then in the spec. Tests must fail before the implementation exists.
3. **Write the implementation** — make the tests pass. Do not change the tests to match a broken implementation.
4. **Write all files to disk** — use the Write or Edit tools. Do not run `npm test`, `npm run typecheck`, or `npm run build`; the workflow's Verifier agent runs these in a separate step after you finish.
5. **Output** — TypeScript source files only. No explanatory prose, no markdown summaries.

---

## Hard constraints — these are non-negotiable

**Build hygiene — CRITICAL**
- Never run `npm run build` during feature implementation. The build emits `app/app.js` and `app/sw.js` into the source tree. These files shadow the TypeScript sources (`app/app.ts`, `app/sw.ts`) for vitest's module resolution (Node resolves `.js` before `.ts`). Any test that imports `app/app` will then receive the IIFE browser bundle instead of the TypeScript module and will fail with `TypeError: createApp is not a function` (and similar). The Verifier runs `npm run build` as a separate step after tests pass — do not pre-empt it.
- If a feature compiles a `.ts` file to `.js` at deploy time (e.g. `sw.ts → sw.js`), the feature's spec must update the `"build"` script in `package.json` to include that compilation step. The Verifier confirms the build works.

**TypeScript**
- `strict: true` is always on. No `as any` casts anywhere.
- No `!` non-null assertion operator anywhere.
- All exported symbols use named exports. No default exports.

**Pure logic modules (`shared/parking-logic.ts`)**
- Every time-sensitive function accepts `now: Date` as a parameter. No function ever calls `new Date()` internally.
- No imports of `window`, `document`, `navigator`, `localStorage`, or any browser global.
- No `fetch`, no `fs` reads, no I/O of any kind.
- Only allowed import: `type { Sign } from "../shared/types"` (type-only).

**Storage module (`shared/storage.ts`)**
- Must not call `localStorage` at module scope — only inside the returned factory object.
- All tests run in Node (`environment: "node"` in vitest.config). No browser globals available at test time.
- Injectable backend pattern: `createSpotStorage(backend: StorageBackend)` — real code passes `localStorage`, tests pass a fake `Map`-backed object.

**App entry point (`app/main.ts`)**
- `app/app.ts` exports the state machine only — no side effects, no DOM access.
- `app/main.ts` is the browser entry point: it calls `initMap()`, wires `createApp()`, attaches event listeners, and starts GPS watching. The esbuild command bundles from `main.ts`, not `app.ts`.

**Map module (`app/map.ts`)**
- The only file in the project that may touch `L.*` (Leaflet). All other modules must not import Leaflet.

**Tests**
- Use `NOW_STABLE`, `NOW_AFTER_EXPIRED`, and `FETCH_TIME` from `tests/fixtures/signs.ts` for time-sensitive assertions. Never use `new Date()` or `Date.now()` in tests.
- Test file location: `tests/unit/<module>.test.ts` for unit tests, `tests/integration/pipeline.test.ts` for integration.

---

## Feature dependency order

See `harness/features.json` for the authoritative feature dependency graph (`depends_on` field per feature). An agent must not import from a module that does not yet exist.

---

## Context to load per feature

*Human-readable reference — `harness/features.json` (`context_files` field) is authoritative.*

These are the files an agent must read before implementing each feature. Do not read beyond them unless a specific error or missing dependency requires it — and then read only the minimum needed to resolve it.

| Feature | Load these files |
|---------|-----------------|
| F-00 | `ARCHITECTURE.md` (file structure only) |
| F-D1 | nothing (discovery feature — no code context needed) |
| F-D2 | `docs/api-discovery.md` |
| F-00.5 | `data/latest.json`, `docs/data-schema.md`, `shared/types.ts` |
| F-01 | `shared/types.ts`, `docs/api-discovery.md`, `docs/data-schema.md` |
| F-02 | `docs/data-schema.md` |
| F-03 | `shared/types.ts`, `tests/fixtures/signs.ts` |
| F-04 | `shared/types.ts` |
| F-05 | nothing |
| F-06 | `shared/types.ts`, `shared/parking-logic.ts`, `shared/storage.ts` |
| F-07 | `shared/types.ts`, `shared/parking-logic.ts` |
| F-09 | `shared/types.ts`, `shared/parking-logic.ts` |
| F-10 | `app/index.html`, `app/style.css`, `app/app.ts`, `app/map.ts`, `app/ui.ts`, `app/main.ts` |
| F-11 | `app/index.html`, `app/style.css`, `app/app.ts`, `app/map.ts`, `app/ui.ts`, `app/main.ts` |
| F-12 | `app/app.ts` |
| F-13 | `shared/parking-logic.ts`, `app/ui.ts` |
| F-14 | `app/app.ts`, `shared/parking-logic.ts` |
| F-15 | `app/app.ts`, `app/ui.ts`, `shared/parking-logic.ts` |
| F-16 | `shared/types.ts`, `shared/parking-logic.ts`, `tests/fixtures/signs.ts` |
| F-01.9 | `shared/types.ts` (for StreetCleaningData), `fetcher/fetch-street-cleaning.ts` |
| F-02.5 | `shared/types.ts` |
| F-07.6 | `shared/types.ts`, `app/map.ts` |
| F-08.4 | nothing (creates `app/geo.ts` from scratch) |
| F-17.5 | `app/main.ts`, `app/map.ts`, `app/geo.ts`, `shared/types.ts` |
| F-18 | `app/index.html`, `app/manifest.json` |
| F-19 | `app/index.html`, `app/style.css`, `app/map.ts`, `app/main.ts` |
| F-20 | `shared/types.ts`, `shared/parking-logic.ts`, `app/geo.ts`, `app/map.ts`, `app/main.ts`, `tests/unit/parking-logic.test.ts`, `tests/unit/geo.test.ts`, `tests/unit/map.test.ts`, `tests/unit/main.test.ts` |
| F-20.5 | `app/map.ts`, `app/main.ts`, `tests/unit/map.test.ts`, `tests/unit/main.test.ts` |
| F-21 | `shared/parking-logic.ts`, `app/geo.ts`, `app/main.ts`, `package.json`, `tests/unit/geo.test.ts` |
| F-22 | `app/map.ts`, `tests/unit/map.test.ts` |
| F-34 | `app/map.ts`, `app/main.ts`, `app/index.html`, `app/style.css`, `shared/parking-logic.ts`, `tests/unit/map.test.ts` |

---

## Known gotchas

Discovered during implementation — read before working on the relevant features.

**F-01.9 — Hoboken street cleaning page layout**
The page at `https://www.hobokennj.gov/resources/street-cleaning-schedule` is built with Webflow CMS and uses `div` elements, not `<table>`. Do not use `table`, `tbody`, or `tr` selectors — they will match nothing. The correct selector is `div.w-dyn-item` for each row. Inside each item, skip the `div.table_wrapper` that has class `w-condition-invisible` (a hidden mobile duplicate); use the other one. The four `div.table-content` children hold Street, Side, Days & Hours, and Location.

**F-01.9 — Header row is a live data row**
The column headers (Street / Side / Days & Hours / Location) appear as a real `div.w-dyn-item` entry, not a `<thead>`. Filter it out explicitly: skip any parsed entry where `street === "Street"`.

**F-17.5 — street-cleaning.json must be fetched before clicks work**
`cleaningEntries` starts empty. The fetch of `"data/street-cleaning.json"` is fire-and-forget after `initMap()` — if a user clicks the map before it resolves, `findCleaningEntries` returns `[]` and `showStreetPopup` renders "No cleaning schedule found". This is acceptable graceful degradation, not a bug.

**F-21 — Nominatim requires a User-Agent in Node**
Node's built-in `fetch` sends no User-Agent and receives HTTP 403 from Nominatim. The browser sends a User-Agent automatically, which is why `geocodeCrossStreet` in `geo.ts` works at runtime without one. The build-time script runs in Node and must explicitly set `"User-Agent": "hoboken-parking-app/1.0 (build-time geocoder)"` on every Nominatim request or all lookups silently return empty arrays.

**F-34 — renderViolationHighlights is cleaning-only; do not add signs back**
`renderViolationHighlights(cleaningEntries, now)` takes no signs parameter by design. Adding tow signs flooded the map — 16 permanent permit signs (active 2023–2030) painted nearly every street red at all times. Tow zones already have their own polyline visual. Do not restore a signs argument.

**F-34 — normalizeToGeometryKey must strip periods and convert ordinals**
Street cleaning data uses abbreviated names with trailing periods ("Adams St.", "Eighth St.") while road-geometry keys use no periods and numeric ordinals ("ADAMS ST", "8TH ST"). `normalizeToGeometryKey` must: (1) call `.replace(/\./g, "")` before abbreviation expansion, and (2) replace spelled-out ordinals FIRST–SIXTEENTH with 1ST–16TH. Omitting either step causes nearly all cleaning streets to silently produce no highlight (geometry key lookup returns `undefined`).

**Layout — map fills full viewport, sign-list is hidden**
`#map` uses `height: 100vh` so the map fills the entire screen. `#sign-list` is `display: none` — the sign card panel has been intentionally removed from the UI. Do not restore the old `calc(100vh - 180px)` height or unhide `#sign-list`. The `#controls` bar is `position: fixed` and overlays the map at the bottom.

**F-37 — Snow route geometry bleeds into Jersey City Heights**
The OSM bounding box used to build `road-geometry.json` is slightly larger than Hoboken, so generic street names like "3RD ST", "4TH ST", "5TH ST" pick up Jersey City Heights ways at lat ~40.753 — about 0.013° north of Hoboken's actual 3rd St (~40.740). `renderSnowEmergencyRoutes` guards against this with a centroid-lat filter: `HOBOKEN_STREET_LAT` maps each numbered street to its expected Hoboken latitude, and any way whose centroid deviates more than `HOBOKEN_STREET_LAT_TOLERANCE` (0.008°) is skipped. Do not remove this guard — without it, 3 phantom routes appear visually in Jersey City.

**Static data files must be added to the build script's cp block**
Any feature that writes a new static JSON file to `data/` (e.g. `data/garages.json`, `data/snow-emergency-routes.json`) MUST also add a cp step to the `build` script in `package.json` so the file lands in `app/data/` where the browser fetch can reach it. Omitting this step causes the fire-and-forget fetch to 404 silently and the layer never renders — no console error, no test failure. The pattern is: `(cp data/yourfile.json app/data/yourfile.json 2>/dev/null || true)` chained at the end of the build command.

---

## Agent pipeline

Each feature runs these stages in order:

```
[Validate] → [Baseline?] → Creator → [File-check] → Verifier → Evaluator
                                                                     ↓ (if not PASS)
                                                                  Reviser → Verifier → Evaluator
                                                                                            ↓ (if not PASS, up to 2x)
                                                                                         Reviser → Verifier → Evaluator
```

> **Phase note:** In the revision cycles, the Reviser, re-Verify, and Evaluator all run under the **Evaluate** phase label (not a separate Verify phase). The diagram shows the logical sequence; `/workflows` shows them grouped under "Evaluate". The `[File-check]` step also runs within the **Create** phase in `/workflows`, not as its own phase.

**[Validate]** *(skipped for discovery features)* — before the Creator runs, the spec is checked: non-empty, at least one Given/When/Then test case, non-empty output_files list. If any check fails the feature is immediately marked BLOCKED and the Creator never runs.

**[Baseline]** *(only for mutation features; skipped for discovery features)* — a **mutation feature** is one whose `output_files` list contains a file already written by a DONE feature (i.e., it modifies existing code rather than creating new files). Before the Creator runs, the workflow identifies the DONE features that first wrote those files, finds their test files, and runs them to record a passing/failing baseline. During revision cycles, if those tests go from passing to failing after the Reviser's changes, a regression-attribution block is injected into the Reviser's prompt showing the before/after counts and the now-failing test names — so the Reviser knows the regression is its own fault and should fix only what it added.

**Creator** receives: this document + the full feature spec + the files listed in Context to load. Writes tests first, then implementation. Output is files written to disk only — no prose.

**[File-check]** — after the Creator writes its files, each expected output file is verified with `ls`. If any are missing, the Verifier is skipped and the Evaluator still runs — it receives synthetic failure results (`testsPassed: false`, skipped output) so it can diagnose what went wrong and produce a structured verdict.

**Verifier** runs tests in three passes and returns structured results. Not a reasoning agent — just a test runner.
0. `rm -f app/app.js app/sw.js` — removes stale build artifacts that would shadow TypeScript sources in vitest module resolution.
1. `npx vitest run <feature-test-files>` — feature tests only; isolates whether this feature's own implementation is correct.
2. `npm test` — full suite; catches regressions in other features. If the feature tests pass but the full suite fails, the results are labeled `REGRESSION` so agents know the new feature is not the cause.
3. `npm run typecheck`
4. `npm run build` — verifies the build script produces all compiled outputs. Skipped if `data/latest.json` is absent (data files are populated by the daily fetch, not committed with features).

**Evaluator** receives: CLAUDE.md + the full feature spec + all output files currently on disk + verifier results. It uses CLAUDE.md to verify hard constraints (no `as any`, named exports, module-specific rules) independently of the Creator's self-assessment. Does not see the creator's reasoning — only the output. Issues one verdict:
- `PASS` — tests pass, typecheck passes, all spec requirements met
- `NEEDS-REVISION` — tests pass but minor spec requirements incomplete
- `FAIL` — tests or typecheck failed, or spec requirements not met

**Reviser** receives: CLAUDE.md + the evaluator's verdict + the current files on disk + verifier failure details + the feature spec. Acts as a surgeon — patches only what was flagged. Does not receive the original context files and does not rewrite from scratch unless the implementation is fundamentally wrong.

Maximum two revision cycles (three evaluator passes total). If still failing, the feature is marked BLOCKED and a stuck-reason file is written to `harness/stuck/`.

**Metrics** — after every run (PASS or BLOCKED), the workflow appends one JSON record to `harness/metrics.jsonl` capturing the feature id, feature name, verdict, all per-revision evaluator verdicts, revision count, token cost, per-run test counts, and all evaluator failure strings.

**Discovery features** (`run_tests: false` in features.json) skip both the Validate and Verify phases. The Evaluator uses a documentation-completeness prompt instead of the code-correctness one. Currently F-D1 and F-D2.

**post_build_command** — some features carry this field in features.json. After a PASS verdict, the workflow runs the command in the project root. Non-fatal: failure does not revert the DONE status. Examples: F-00 runs `npm install`; F-01.9 runs `npm run fetch-cleaning`.

**Prompt templates** — Each agent's role instructions are embedded as constants in `harness/workflow.js`:
- `CREATOR_TEMPLATE` — prefixed to every Creator agent prompt
- `EVALUATOR_TEMPLATE` — prefixed to every Evaluator agent prompt
- `REVISER_TEMPLATE` — prefixed to every Reviser agent prompt

To change agent persona or output format, edit the constants directly in `workflow.js`. The `harness/prompts/` directory no longer exists.

---

## Definition of done

A feature is done when:
1. `npm test` passes with zero failures (all new tests + all pre-existing tests)
2. `npm run typecheck` passes with zero errors
3. `npm run build` passes (when data files are present), confirming all compiled outputs are produced
4. The evaluator agent issues `PASS`
5. Output files conform to the file structure in `ARCHITECTURE.md`

No feature is done based on the creator's own assessment alone.
