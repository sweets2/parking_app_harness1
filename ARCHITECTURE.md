# Hoboken Parking — Architecture

A static PWA. No backend server. One daily cron job keeps the data fresh.

---

## System

```
Hoboken City API
        │  once daily (GitHub Action)
        ▼
fetcher/fetch.ts  →  data/latest.json  →  Netlify CDN
                                                │
                                         iPhone / Android / Browser
                                         (PWA, installs to home screen)
```

The app fetches `latest.json` at startup. All filtering and logic runs client-side.
If the daily fetch fails, the previous day's data is still served.

---

## Data Flow (inside the browser)

```
latest.json  (116 signs, some expired)
     │
     │  filterLoadTimeNoise()  — once at startup
     ▼
allSigns  (~93 valid signs)
     │
     │  filterActive()  — every 60 seconds
     ▼
activeSigns
     │
     ├─ BROWSING mode  →  map pins for all active signs
     │
     └─ PARKED mode    →  filterNearby(spot, 150m)
                               →  sign cards + countdown
```

---

## User Flows

**Flow 1 — Just parked**
Tap map to set position → map shows colored sign pins → tap SAVE MY SPOT → pick street side → spot saved to localStorage

**Flow 2 — Returning**
App detects saved spot → centers map on spot → checks for nearby active signs → green clear / red warning with countdown

**Flow 3 — Monitor / Reminder** *(planned, not yet implemented)*
Proactively warns the user when their parked car is approaching a violation, without requiring them to remember to check.

Two layers:

- **Layer 1 — Automatic (on every app open):** If a saved spot exists, the app re-fetches `latest.json` before rendering anything else. If a new violation appeared overnight near the saved spot, the very first thing the user sees is a warning — not a map. This handles the overnight scenario: park Thursday evening, new restriction posted Friday morning, user picks up their phone and sees the alert immediately.

- **Layer 2 — Manual refresh (user-initiated):** A "Refresh signs" button visible whenever a spot is saved. Tapping it re-fetches `latest.json` bypassing the browser cache and re-evaluates the saved spot. The button displays the data freshness timestamp from the file (e.g., *"Signs last updated today at 6:02 AM"*) so the user understands what they are refreshing and why it might have changed since they parked.

Both layers run the same pipeline: fetch → filter → evaluate spot → update banner. No new logic — only new triggers. Background push notifications and Periodic Background Sync are explicitly out of scope; iOS does not support them reliably in a static PWA without a server.

---

## File Structure

```
hoboken-parking/
├── shared/
│   ├── types.ts            sign types shared between fetcher and app
│   ├── parking-logic.ts    all pure logic: filtering, distance, countdowns
│   └── storage.ts          localStorage interface (injectable for tests)
├── fetcher/
│   └── fetch.ts            hits Hoboken API, validates, writes latest.json
├── app/
│   ├── index.html          single HTML shell
│   ├── style.css           mobile-first styles
│   ├── app.ts              state machine, wires all modules together
│   ├── map.ts              Leaflet wrapper (only file that touches L.*)
│   ├── ui.ts               DOM rendering helpers
│   ├── geo.ts              street name lookup via Nominatim reverse geocoding
│   ├── manifest.json       PWA install metadata
│   └── sw.ts               service worker (offline caching)
├── data/
│   └── latest.json         written daily by fetcher, read by app
├── docs/                   API and schema documentation written by discovery features
├── harness/
│   └── stuck/              stuck-reason files written when a feature exceeds MAX_REVISIONS
├── specs/                  feature specs written before any code
├── tests/                  Vitest test suite using latest.json as fixture
└── .github/workflows/      GitHub Action: test → typecheck → fetch → deploy
```

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript (strict) |
| App framework | None — vanilla JS |
| Map | Leaflet.js + OpenStreetMap |
| Storage | localStorage |
| Bundler | esbuild |
| Tests | Vitest |
| Hosting | Netlify (free tier, auto-deploy on push) |
| CI/CD | GitHub Actions |

---

## App State

```typescript
type AppState =
  | { mode: "loading" }
  | { mode: "browsing"; tappedLat: number | null; tappedLng: number | null }
  | { mode: "parked";   spot: SavedSpot; nearbySigns: Sign[] }
```

State lives in `app.ts`. Logic lives in `shared/`. The map and UI modules only render what they're given.

**Planned addition for Flow 3** *(not yet implemented):* The parked state will also carry a `nextViolation` field — the result of a `nextViolationWindow()` function in `shared/parking-logic.ts` that computes the nearest upcoming conflict window for the saved spot. This is what drives the warning banner: not just "there are nearby signs" but "this sign becomes active in 2 hours, move before then."

---

## Sign Data

Signs come from the Hoboken city API as temporary no-parking records. Each has a location, a reason (CONSTRUCTION / MOVING / EVENT / DELIVERY), and a time window. About 100–120 signs are in each fetch; ~60–90 are active at any given time. Fifteen are permanent (end date 2030). One has a bad coordinate and is filtered out at startup.
