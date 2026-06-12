/**
 * app/main.ts — F-10 / F-11 / F-14 / F-15 / F-17.5
 *
 * Browser entry point. Initializes the map, fetches sign and street cleaning
 * data, creates the app state machine, wires UI buttons, and registers the
 * map click handler.
 *
 * In browsing mode: map tap sets position marker and updates app state.
 * In parked mode: map tap shows street cleaning popup.
 *
 * Exports: normalizeStreet, findCleaningEntries, init (for testing)
 */

import { initFeedback } from "./feedback";
import { track } from "./analytics";
import {
  initMap,
  registerMapClickHandler,
  renderPositionMarker,
  clearPositionMarker,
  renderSignPins,
  renderTowSegments,
  renderSpotMarker,
  clearSpotMarker,
  centerOnSpot,
  showStreetPopup,
  setTowSignsVisible,
  initRoadGeometry,
  clearViolationHighlights,
  renderViolationHighlights,
  setViolationHighlightsVisible,
  renderUpcomingSignPins,
  renderUpcomingTowSegments,
  setUpcomingSignsVisible,
  renderGarageMarkers,
  setGarageMarkersVisible,
  renderSnowEmergencyRoutes,
  setSnowRoutesVisible,
  initStreetParity,
} from "./map";
import { getStreetName, geocodeCrossStreet, seedGeocodeCache } from "./geo";
import { createApp } from "./app";
import type { App, AppState } from "./app";
import {
  filterLoadTimeNoise,
  filterActive,
  filterNearby,
  extractCrossStreets,
  detectMatchingSegment,
  isSignActive,
} from "../shared/parking-logic";
import { createSpotStorage } from "../shared/storage";
import type { SavedSpot } from "../shared/storage";
import type { Sign, StreetCleaningEntry, StreetCleaningData, RoadGeometry, Garage, SnowRoute } from "../shared/types";
import {
  renderLoading,
  hideLoading,
  renderBrowsingMode,
  renderWarningBanner,
  renderClearBanner,
} from "./ui";

// ─── Dev time override ────────────────────────────────────────────────────────
// Set DEV_FORCE_NOW to a Date to test the split-highlight on one street only.
// Only entries matching DEV_TEST_STREET are shown — all other streets hidden.
// Washington St East=active + West=upcoming: any weekday 8:00–8:59 am ET
// To enable: set DEV_FORCE_NOW = new Date("2026-06-09T12:30:00Z")
// To disable: set DEV_FORCE_NOW = null
const DEV_FORCE_NOW: Date | null = new Date("2026-06-09T12:30:00Z");
const DEV_TEST_STREET = "Washington St.";
function devNow(): Date { return DEV_FORCE_NOW ?? new Date(); }
function devEntries(entries: StreetCleaningEntry[]): StreetCleaningEntry[] {
  if (DEV_FORCE_NOW === null) return entries;
  return entries.filter(e => e.street === DEV_TEST_STREET);
}

// ─── Module state ─────────────────────────────────────────────────────────────

let cleaningEntries: StreetCleaningEntry[] = [];
let upcomingSignsData: Sign[] = [];
let appMode: "browsing" | "parked" = "browsing";

/** ISO string of when sign data was last successfully fetched — used for staleness detection. */
let _fetchedAt: string = new Date().toISOString();

/**
 * Tracks whether the map has been centered on the saved spot for the current
 * parked session. Reset to false whenever the app leaves parked mode.
 * Used to center once on initial parked load (F-11.1) without re-centering
 * on every 60-second tick.
 */
let _centeredOnSpot = false;

/**
 * Tracks the last banner state so tow-warning-shown and safe-banner-shown
 * fire only on transitions, not on every 60-second tick.
 */
let _lastAlertState: "warn" | "clear" | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lowercase and expand common street abbreviations so that Nominatim road
 * names can be matched against the scraped cleaning schedule entries.
 *
 * Expansions:
 *   St  → street
 *   Ave → avenue
 *   Blvd → boulevard
 *   Dr  → drive
 *   Pl  → place
 *   Hwy → highway
 */
export function normalizeStreet(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\bst\b/g, "street")
    .replace(/\bave\b/g, "avenue")
    .replace(/\bblvd\b/g, "boulevard")
    .replace(/\bdr\b/g, "drive")
    .replace(/\bpl\b/g, "place")
    .replace(/\bhwy\b/g, "highway")
    .replace(/\bfirst\b/g, "1st")
    .replace(/\bsecond\b/g, "2nd")
    .replace(/\bthird\b/g, "3rd")
    .replace(/\bfourth\b/g, "4th")
    .replace(/\bfifth\b/g, "5th")
    .replace(/\bsixth\b/g, "6th")
    .replace(/\bseventh\b/g, "7th")
    .replace(/\beighth\b/g, "8th")
    .replace(/\bninth\b/g, "9th")
    .replace(/\btenth\b/g, "10th")
    .replace(/\beleventh\b/g, "11th")
    .replace(/\btwelfth\b/g, "12th")
    .replace(/\bthirteenth\b/g, "13th")
    .replace(/\bfourteenth\b/g, "14th")
    .replace(/\bfifteenth\b/g, "15th")
    .replace(/\bsixteenth\b/g, "16th")
    .replace(/\bseventeenth\b/g, "17th")
    .replace(/\beighteenth\b/g, "18th")
    .replace(/\bnineteenth\b/g, "19th")
    .replace(/\btwentieth\b/g, "20th");
}

/**
 * Return all cleaning entries whose normalized street name equals the
 * normalized form of `roadName`.
 */
export function findCleaningEntries(roadName: string): StreetCleaningEntry[] {
  const normalizedRoad = normalizeStreet(roadName);
  return cleaningEntries.filter(
    (entry) => normalizeStreet(entry.street) === normalizedRoad
  );
}

// ─── F-20 buildDetectSegmentCallback ─────────────────────────────────────────

/**
 * Factory that returns a callback suitable for passing as the `detectSegment`
 * argument to `showStreetPopup`. The callback iterates a list of location strings,
 * geocodes their cross-street coordinates, and returns the first location that
 * brackets the click point.
 *
 * Requests are sequential so the shared rate-limit clock in geo.ts works correctly.
 */
function buildDetectSegmentCallback(
  clickLat: number,
  clickLng: number,
  roadName: string
): (locations: string[]) => Promise<string[] | null> {
  return async (locations: string[]) => {
    const matched: string[] = [];
    for (const location of locations) {
      const crossStreets = extractCrossStreets(location);
      if (crossStreets === null) continue;
      const [from, to] = crossStreets;
      const fromCoord = await geocodeCrossStreet(normalizeStreet(from), normalizeStreet(roadName));
      if (fromCoord === null) continue;
      const toCoord = await geocodeCrossStreet(normalizeStreet(to), normalizeStreet(roadName));
      if (toCoord === null) continue;
      if (detectMatchingSegment(clickLat, clickLng, fromCoord, toCoord)) {
        matched.push(location);
      }
    }
    return matched.length > 0 ? matched : null;
  };
}

// ─── renderState callback ─────────────────────────────────────────────────────

/**
 * Called by the app state machine whenever state changes.
 * Updates the map and UI to reflect the new state.
 * Only used in browser context where document is defined.
 */
function renderState(state: AppState): void {
  const now = devNow();

  if (state.mode === "loading") {
    renderLoading();
    return;
  }

  hideLoading();

  if (state.mode === "error") {
    const banner = document.getElementById("banner");
    if (banner) {
      banner.style.display = "";
      banner.textContent = state.message;
    }
    return;
  }

  if (state.mode === "browsing") {
    appMode = "browsing";
    // Reset the centering flag so the next parked session centers fresh (F-11.1).
    _centeredOnSpot = false;
    _lastAlertState = null;
    renderBrowsingMode(state.activeSigns, now);
    renderSignPins(state.activeSigns, now);
    renderTowSegments(state.activeSigns);
    renderViolationHighlights(devEntries(cleaningEntries), now);
    renderUpcomingSignPins(upcomingSignsData, now);
    renderUpcomingTowSegments(upcomingSignsData);
    return;
  }

  if (state.mode === "parked") {
    appMode = "parked";

    // F-11.1: Center the map on the saved spot once per parked session.
    // Do not re-center on every 60-second tick.
    if (!_centeredOnSpot) {
      centerOnSpot(state.spot);
      _centeredOnSpot = true;
      track("parked-mode-entered", { nearby_signs: state.nearbySigns.length });
      // Auto-open street popup for the saved spot's location (initial save and reload).
      void getStreetName(state.spot.lat, state.spot.lng).then((road) => {
        if (road !== null) {
          const detectSegment = buildDetectSegmentCallback(state.spot.lat, state.spot.lng, road);
          showStreetPopup(state.spot.lat, state.spot.lng, road, findCleaningEntries(road), detectSegment, devNow());
        }
      });
    }

    // F-11.2 / F-11.3: Show green "clear" banner or red warning banner.
    // Deduped: only fire analytics events on state transitions, not every 60-second tick.
    if (state.nearbySigns.length > 0) {
      renderWarningBanner(state.nearbySigns, now);
      if (_lastAlertState !== "warn") {
        track("tow-warning-shown", { sign_count: state.nearbySigns.length });
        _lastAlertState = "warn";
      }
    } else {
      renderClearBanner();
      if (_lastAlertState !== "clear") {
        track("safe-banner-shown");
        _lastAlertState = "clear";
      }
    }

    // Show all active sign pins in parked mode (not just nearby ones).
    renderSignPins(filterActive(state.allSigns, now), now);
    renderTowSegments(filterActive(state.allSigns, now));
    renderViolationHighlights(devEntries(cleaningEntries), now);
    renderUpcomingSignPins(upcomingSignsData, now);
    renderUpcomingTowSegments(upcomingSignsData);
    renderSpotMarker(state.spot);
    clearPositionMarker();
    return;
  }
}

// ─── Silent auto-refresh ──────────────────────────────────────────────────────

async function silentRefresh(app: App, now: Date): Promise<void> {
  try {
    const res = await fetch("data/latest.json", { cache: "no-cache" });
    const json = await res.json() as { fetched_at: string; signs: Sign[] };
    _fetchedAt = json.fetched_at;
    const filtered = filterLoadTimeNoise(json.signs, new Date(json.fetched_at));
    const activeNow = filterActive(filtered, now);
    const state = app.getState();
    if (state.mode === "parked") {
      const nearby = filterNearby(filtered, state.spot.lat, state.spot.lng, 150, now);
      renderSignPins(nearby, now);
      renderTowSegments(nearby);
      renderViolationHighlights(devEntries(cleaningEntries), now);
      if (nearby.length > 0) {
        renderWarningBanner(nearby, now);
      } else {
        renderClearBanner();
      }
    } else if (state.mode === "browsing") {
      renderSignPins(activeNow, now);
      renderTowSegments(activeNow);
      renderViolationHighlights(devEntries(cleaningEntries), now);
      renderBrowsingMode(activeNow, now);
    }
    // Refresh upcoming signs
    try {
      const futureRes = await fetch("data/future.json", { cache: "no-cache" });
      const futureJson = await futureRes.json() as { fetched_at: string; signs: Sign[] };
      upcomingSignsData = filterLoadTimeNoise(futureJson.signs, new Date(futureJson.fetched_at))
        .filter((s) => !isSignActive(s, now));
    } catch {
      // Silent — upcoming data stays as-is
    }
    renderUpcomingSignPins(upcomingSignsData, now);
    renderUpcomingTowSegments(upcomingSignsData);
    app.tick(now);
  } catch {
    // Silent — cached data remains in use
  }
}

// ─── F-34 scheduleViolationRefresh ───────────────────────────────────────────

function scheduleViolationRefresh(getState: () => AppState): void {
  const now = new Date();
  const secIntoHour = now.getMinutes() * 60 + now.getSeconds();
  const msUntilNextHour = (3600 - secIntoHour) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    const st = getState();
    if (st.mode !== "loading" && st.mode !== "error") {
      renderViolationHighlights(devEntries(cleaningEntries), devNow());
    }
    scheduleViolationRefresh(getState);
  }, msUntilNextHour);
}

// ─── Coffee button wiring ─────────────────────────────────────────────────────

/**
 * Wire the coffee-cup donation button and its popover card.
 * Exported for isolated testing without invoking initBrowserApp().
 */
export function initCoffee(): void {
  const coffeeBtn = document.getElementById('coffee-btn');
  const coffeePopover = document.getElementById('coffee-popover');

  coffeeBtn?.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const isOpen = coffeePopover?.classList.contains('open') ?? false;
    coffeePopover?.classList.toggle('open', !isOpen);
    coffeePopover?.setAttribute('aria-hidden', String(isOpen));
  });

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e: MouseEvent) => {
      if (coffeePopover?.classList.contains('open') &&
          !coffeePopover.contains(e.target as Node)) {
        coffeePopover.classList.remove('open');
        coffeePopover.setAttribute('aria-hidden', 'true');
      }
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        coffeePopover?.classList.remove('open');
        coffeePopover?.setAttribute('aria-hidden', 'true');
      }
    });
  }
}

// ─── Full browser app wiring ──────────────────────────────────────────────────

export async function initBrowserApp(): Promise<void> {
  renderLoading();
  initMap();
  initFeedback();
  initCoffee();

  // Fire-and-forget: fetch street cleaning schedule.
  fetch("data/street-cleaning.json")
    .then((res) => res.json())
    .then((data: unknown) => {
      cleaningEntries = (data as { entries: StreetCleaningEntry[] }).entries;
    })
    .catch(() => { /* non-fatal — cleaningEntries stays empty */ });

  // Fire-and-forget: seed the geocode cache from the build-time lookup table.
  // If the file is absent or stale, geocodeCrossStreet falls back to Nominatim.
  fetch("data/cross-streets.json")
    .then((res) => res.json())
    .then((data: unknown) => {
      seedGeocodeCache(data as Record<string, { lat: number; lng: number } | null>);
    })
    .catch(() => { /* non-fatal — runtime Nominatim calls serve as fallback */ });

  // Await road geometry + street parity before rendering signs — both are needed
  // before the first renderTowSegments call so offsets are applied on initial render.
  await Promise.all([
    fetch("data/road-geometry.json")
      .then((r) => r.json())
      .then((g: RoadGeometry) => { initRoadGeometry(g); })
      .catch(() => { /* non-fatal */ }),
    fetch("data/street-parity.json")
      .then((r) => r.json())
      .then((data: unknown) => { initStreetParity(data as Record<string, 1 | -1>); })
      .catch(() => { /* non-fatal */ }),
  ]);

  // Fetch sign data
  let signsData: { signs: Sign[]; fetchTime: Date };
  try {
    const res = await fetch("data/latest.json");
    const json = await res.json() as { fetched_at: string; signs: Sign[] };
    _fetchedAt = json.fetched_at;
    signsData = {
      signs: json.signs,
      fetchTime: new Date(json.fetched_at),
    };
  } catch {
    hideLoading();
    const banner = document.getElementById("banner");
    if (banner) {
      banner.style.display = "";
      banner.textContent = "Failed to load parking data.";
    }
    return;
  }

  // Fetch upcoming signs (fire-and-forget, non-fatal)
  try {
    const futureRes = await fetch("data/future.json");
    const futureJson = await futureRes.json() as { fetched_at: string; signs: Sign[] };
    const now = devNow();
    upcomingSignsData = filterLoadTimeNoise(futureJson.signs, new Date(futureJson.fetched_at))
      .filter((s) => !isSignActive(s, now));
  } catch {
    // file missing or network error — layer stays empty
  }

  // Create storage backed by localStorage
  const storage = createSpotStorage(localStorage);

  // F-14: If a saved spot exists, re-fetch latest.json with cache: "no-cache"
  // to get fresh sign data before rendering the parked view.
  const hasSavedSpot = storage.load() !== null;
  if (hasSavedSpot) {
    try {
      const freshRes = await fetch("data/latest.json", { cache: "no-cache" });
      const freshJson = await freshRes.json() as { fetched_at: string; signs: Sign[] };
      _fetchedAt = freshJson.fetched_at;
      signsData = {
        signs: freshJson.signs,
        fetchTime: new Date(freshJson.fetched_at),
      };
    } catch {
      // Fall back to the first fetch's signs — signsData is unchanged
    }
  }

  // Create app state machine
  const app: App = createApp({ storage, renderState }, signsData);
  track("app-loaded");

  // Update appMode to match the app's initial state
  const initialState = app.getState();
  if (initialState.mode === "parked") {
    appMode = "parked";
  }

  // F-34: initial violation highlight render + hourly schedule
  if (initialState.mode !== "loading" && initialState.mode !== "error") {
    renderViolationHighlights(devEntries(cleaningEntries), devNow());
  }
  scheduleViolationRefresh(app.getState.bind(app));

  // Fire-and-forget: fetch municipal garages and render markers.
  fetch("data/garages.json")
    .then((r) => r.json())
    .then((garages: Garage[]) => { renderGarageMarkers(garages, true); })
    .catch(() => { /* non-fatal */ });

  // Fire-and-forget: fetch snow emergency routes and render blue polylines.
  fetch("data/snow-emergency-routes.json")
    .then((r) => r.json())
    .then(({ routes }: { routes: SnowRoute[] }) => {
      renderSnowEmergencyRoutes(routes, true);
    })
    .catch(() => { /* non-fatal */ });

  // Wire tow-zones legend toggle
  const towLegend = document.getElementById("tow-legend");
  const towToggle = document.getElementById("tow-toggle");
  if (towLegend !== null && towToggle !== null) {
    const towStatus = towToggle.querySelector<HTMLElement>(".tow-status");
    towToggle.addEventListener("click", () => {
      const isOn = !towLegend.classList.contains("tow-off");
      setTowSignsVisible(!isOn);
      track("tow-zones-toggled", { enabled: !isOn });
      towLegend.classList.toggle("tow-off", isOn);
      towToggle.setAttribute("aria-pressed", String(!isOn));
      if (towStatus !== null) {
        towStatus.textContent = isOn ? "Disabled" : "Enabled";
      }
    });
  }

  // Wire violation highlights legend toggle
  const violationLegend = document.getElementById("violation-legend");
  const violationToggle = document.getElementById("violation-toggle");
  if (violationLegend !== null && violationToggle !== null) {
    const violationStatus = violationToggle.querySelector<HTMLElement>(".violation-status");
    violationToggle.addEventListener("click", () => {
      const isOn = !violationLegend.classList.contains("violation-off");
      setViolationHighlightsVisible(!isOn);
      track("violation-highlights-toggled", { enabled: !isOn });
      violationLegend.classList.toggle("violation-off", isOn);
      violationToggle.setAttribute("aria-pressed", String(!isOn));
      if (violationStatus !== null) {
        violationStatus.textContent = isOn ? "Disabled" : "Enabled";
      }
    });
  }

  // Wire upcoming signs legend toggle
  const upcomingToggle = document.getElementById("upcoming-toggle");
  upcomingToggle?.addEventListener("click", () => {
    const isOn = upcomingToggle.getAttribute("aria-pressed") === "true";
    const next = !isOn;
    setUpcomingSignsVisible(next);
    track("upcoming-signs-toggled", { enabled: next });
    upcomingToggle.setAttribute("aria-pressed", String(next));
    document.getElementById("upcoming-legend")?.classList.toggle("upcoming-off", !next);
    const status = document.getElementById("upcoming-legend")?.querySelector(".upcoming-status");
    if (status !== null && status !== undefined) {
      status.textContent = next ? "Enabled" : "Hidden";
    }
  });

  // Wire garage toggle
  const garageToggle = document.getElementById("garage-toggle");
  garageToggle?.addEventListener("click", () => {
    const isOn = garageToggle.getAttribute("aria-pressed") === "true";
    const next = !isOn;
    setGarageMarkersVisible(next);
    track("garages-toggled", { enabled: next });
    garageToggle.setAttribute("aria-pressed", String(next));
    document.getElementById("garage-legend")?.classList.toggle("garage-off", !next);
    const status = document.getElementById("garage-legend")?.querySelector(".garage-status");
    if (status !== null && status !== undefined) {
      status.textContent = next ? "Enabled" : "Hidden";
    }
  });

  // Wire snow routes toggle
  const snowToggle = document.getElementById("snow-toggle");
  snowToggle?.addEventListener("click", () => {
    const isOn = snowToggle.getAttribute("aria-pressed") === "true";
    const next = !isOn;
    setSnowRoutesVisible(next);
    track("snow-routes-toggled", { enabled: next });
    snowToggle.setAttribute("aria-pressed", String(next));
    document.getElementById("snow-legend")?.classList.toggle("snow-off", !next);
    const status = document.getElementById("snow-legend")?.querySelector(".snow-status");
    if (status !== null && status !== undefined) {
      status.textContent = next ? "Enabled" : "Hidden";
    }
  });

  // Wire "Get Current Location" button
  const locateBtn = document.getElementById("locate-btn");
  if (locateBtn !== null) {
    locateBtn.addEventListener("click", () => {
      track("locate-requested");
      if (!("geolocation" in navigator)) return;
      locateBtn.setAttribute("disabled", "");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          locateBtn.removeAttribute("disabled");
          renderPositionMarker(pos.coords.latitude, pos.coords.longitude);
          centerOnSpot({ lat: pos.coords.latitude, lng: pos.coords.longitude, savedAt: new Date().toISOString(), address: null });
        },
        () => {
          locateBtn.removeAttribute("disabled");
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }

  // Wire clear button — F-11.4: removes spot from storage, transitions to browsing,
  // clears spot marker, shows all active signs as pins (via renderState browsing branch).
  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      track("spot-cleared");
      clearSpotMarker();
      app.onClearSpot();
    });
  }

  // Wire "I'm Here Now" button — F-11.1: re-centers map on saved spot on demand.
  const hereBtn = document.getElementById("here-btn");
  if (hereBtn) {
    hereBtn.addEventListener("click", () => {
      track("here-now-tapped");
      const state = app.getState();
      if (state.mode === "parked") {
        centerOnSpot(state.spot);
      }
    });
  }

  // Wire map click handler — every click saves (or moves) the spot.
  registerMapClickHandler((lat: number, lng: number) => {
    // Reset so renderState re-centers and re-opens the popup for the new location.
    _centeredOnSpot = false;
    track(appMode === "parked" ? "spot-moved" : "spot-saved");
    const spot: SavedSpot = {
      lat,
      lng,
      savedAt: new Date().toISOString(),
      address: null,
    };
    app.onSaveSpot(spot);
  });

  // Start 60-second tick; auto-refresh data when it's from a previous UTC calendar day.
  setInterval(() => {
    const now = devNow();
    const fetched = new Date(_fetchedAt);
    const stale =
      fetched.getUTCFullYear() !== now.getUTCFullYear() ||
      fetched.getUTCMonth() !== now.getUTCMonth() ||
      fetched.getUTCDate() !== now.getUTCDate();
    if (stale) void silentRefresh(app, now);
    app.tick(now);
  }, 60_000);

  // F-12.2: Register service worker for PWA offline support.
  // Errors are caught and logged but do not prevent the app from functioning.
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.error("Service worker registration failed:", err);
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the app: set up the map, fetch street-cleaning data, and wire
 * the map click handler.
 *
 * The optional `initialMode` parameter is accepted for testing purposes;
 * production code omits it and defaults to "browsing".
 *
 * In a test environment (no document), only the map click handler is wired
 * so the F-17.5 click tests continue to work.
 */
export async function init(initialMode: "browsing" | "parked" = "browsing"): Promise<void> {
  appMode = initialMode;

  initMap();

  // Fire-and-forget: fetch street cleaning schedule after map is ready.
  // Failure is non-fatal — leave cleaningEntries empty.
  fetch("data/street-cleaning.json")
    .then((res) => res.json())
    .then((data: unknown) => {
      const typed = data as StreetCleaningData;
      cleaningEntries = typed.entries;
    })
    .catch(() => {
      // Non-fatal — cleaningEntries stays empty
    });

  registerMapClickHandler(async (lat: number, lng: number) => {
    if (appMode === "browsing") {
      // Browsing mode: set the tapped position marker
      renderPositionMarker(lat, lng);
    } else {
      // Parked mode: show street cleaning popup
      const road = await getStreetName(lat, lng);
      if (road !== null) {
        const detectSegment = buildDetectSegmentCallback(lat, lng, road);
        showStreetPopup(lat, lng, road, findCleaningEntries(road), detectSegment, devNow());
      }
    }
  });
}

// ─── Browser entry point ──────────────────────────────────────────────────────

// Only run in browser context (not in Node test environment)
if (typeof document !== "undefined") {
  void initBrowserApp();
}
