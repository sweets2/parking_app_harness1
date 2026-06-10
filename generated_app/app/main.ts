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

import {
  initMap,
  registerMapClickHandler,
  renderPositionMarker,
  clearPositionMarker,
  renderSignPins,
  renderSpotMarker,
  clearSpotMarker,
  centerOnSpot,
  showStreetPopup,
} from "./map";
import { getStreetName } from "./geo";
import { createApp } from "./app";
import type { App, AppState } from "./app";
import {
  filterLoadTimeNoise,
  filterActive,
  filterNearby,
} from "../shared/parking-logic";
import { createSpotStorage } from "../shared/storage";
import type { SavedSpot } from "../shared/storage";
import type { Sign, StreetCleaningEntry, StreetCleaningData } from "../shared/types";
import {
  renderLoading,
  hideLoading,
  renderBrowsingMode,
  renderWarningBanner,
  renderClearBanner,
  renderRefreshButton,
  setRefreshLoading,
  showRefreshError,
  showStreetSidePicker,
  showSpotToast,
} from "./ui";
import type { Side } from "./ui";

// ─── Module state ─────────────────────────────────────────────────────────────

let cleaningEntries: StreetCleaningEntry[] = [];
let appMode: "browsing" | "parked" = "browsing";

/** ISO string of when sign data was last successfully fetched — used by renderRefreshButton. */
let _fetchedAt: string = new Date().toISOString();

/**
 * Tracks whether the map has been centered on the saved spot for the current
 * parked session. Reset to false whenever the app leaves parked mode.
 * Used to center once on initial parked load (F-11.1) without re-centering
 * on every 60-second tick.
 */
let _centeredOnSpot = false;

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
    .replace(/\bst\b/g, "street")
    .replace(/\bave\b/g, "avenue")
    .replace(/\bblvd\b/g, "boulevard")
    .replace(/\bdr\b/g, "drive")
    .replace(/\bpl\b/g, "place")
    .replace(/\bhwy\b/g, "highway");
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

// ─── Street-side offset ───────────────────────────────────────────────────────

/** ~10 meters in degrees at Hoboken's latitude. */
const SIDE_OFFSET = 0.00009;

/**
 * Apply a small positional offset based on which side of the street the user
 * is parked on.
 */
function applyStreetSideOffset(
  lat: number,
  lng: number,
  side: Side
): { lat: number; lng: number } {
  switch (side) {
    case "N":
      return { lat: lat + SIDE_OFFSET, lng };
    case "S":
      return { lat: lat - SIDE_OFFSET, lng };
    case "E":
      return { lat, lng: lng + SIDE_OFFSET };
    case "W":
      return { lat, lng: lng - SIDE_OFFSET };
  }
}

// ─── renderState callback ─────────────────────────────────────────────────────

/**
 * Called by the app state machine whenever state changes.
 * Updates the map and UI to reflect the new state.
 * Only used in browser context where document is defined.
 */
function renderState(state: AppState): void {
  const now = new Date();

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
    renderBrowsingMode(state.activeSigns, now);
    renderSignPins(state.activeSigns, now);

    // Disable save button when no position is set
    const saveBtn = document.getElementById("save-btn");
    if (saveBtn instanceof HTMLButtonElement) {
      saveBtn.disabled = state.userLat === null || state.userLng === null;
    }
    return;
  }

  if (state.mode === "parked") {
    appMode = "parked";

    // F-11.1: Center the map on the saved spot once per parked session.
    // Do not re-center on every 60-second tick.
    if (!_centeredOnSpot) {
      centerOnSpot(state.spot);
      _centeredOnSpot = true;
    }

    // F-11.2 / F-11.3: Show green "clear" banner or red warning banner.
    if (state.nearbySigns.length > 0) {
      renderWarningBanner(state.nearbySigns, now);
    } else {
      renderClearBanner();
    }

    // F-15: Show refresh button with freshness label in parked mode.
    renderRefreshButton(_fetchedAt, now);

    // F-11.3 / F-11.4: Show nearby sign pins in parked mode; spot marker visible.
    renderSignPins(state.nearbySigns, now);
    renderSpotMarker(state.spot);
    clearPositionMarker();
    return;
  }
}

// ─── Full browser app wiring ──────────────────────────────────────────────────

export async function initBrowserApp(): Promise<void> {
  renderLoading();
  initMap();

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

  // Update appMode to match the app's initial state
  const initialState = app.getState();
  if (initialState.mode === "parked") {
    appMode = "parked";
  }

  // Wire save button
  const saveBtn = document.getElementById("save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const state = app.getState();
      if (state.mode !== "browsing") return;
      const { userLat, userLng } = state;
      if (userLat === null || userLng === null) return;

      showStreetSidePicker((side: Side | null) => {
        if (side === null) return; // cancelled
        const offsetPos = applyStreetSideOffset(userLat, userLng, side);
        const spot: SavedSpot = {
          lat: offsetPos.lat,
          lng: offsetPos.lng,
          side,
          savedAt: new Date().toISOString(),
          address: null,
        };
        app.onSaveSpot(spot);
        showSpotToast(spot.address ?? "your spot", side);
      });
    });
  }

  // Wire clear button — F-11.4: removes spot from storage, transitions to browsing,
  // clears spot marker, shows all active signs as pins (via renderState browsing branch).
  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearSpotMarker();
      app.onClearSpot();
    });
  }

  // Wire "I'm Here Now" button — F-11.1: re-centers map on saved spot on demand.
  const hereBtn = document.getElementById("here-btn");
  if (hereBtn) {
    hereBtn.addEventListener("click", () => {
      const state = app.getState();
      if (state.mode === "parked") {
        centerOnSpot(state.spot);
      }
    });
  }

  // Wire refresh button — F-15: re-fetches sign data without cache and re-evaluates.
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      void (async () => {
        setRefreshLoading(true);
        try {
          const res = await fetch("data/latest.json", { cache: "no-cache" });
          const json = await res.json() as { fetched_at: string; signs: Sign[] };
          _fetchedAt = json.fetched_at;
          // Run the fetch pipeline on the fresh signs
          const now = new Date();
          const filteredSigns = filterLoadTimeNoise(json.signs, new Date(json.fetched_at));
          const activeNow = filterActive(filteredSigns, now);
          // Re-render based on current mode using fresh data
          const state = app.getState();
          if (state.mode === "parked") {
            const nearby = filterNearby(filteredSigns, state.spot.lat, state.spot.lng, 150, now);
            renderSignPins(nearby, now);
            if (nearby.length > 0) {
              renderWarningBanner(nearby, now);
            } else {
              renderClearBanner();
            }
          } else if (state.mode === "browsing") {
            renderSignPins(activeNow, now);
            renderBrowsingMode(activeNow, now);
          }
          renderRefreshButton(_fetchedAt, now);
          app.tick(now);
        } catch {
          showRefreshError();
        } finally {
          setRefreshLoading(false);
        }
      })();
    });
  }

  // Wire map click handler for both modes
  registerMapClickHandler(async (lat: number, lng: number) => {
    const currentState = app.getState();
    if (currentState.mode === "browsing") {
      renderPositionMarker(lat, lng);
      app.setUserPosition(lat, lng);
    } else if (currentState.mode === "parked") {
      const road = await getStreetName(lat, lng);
      if (road !== null) {
        showStreetPopup(lat, lng, road, findCleaningEntries(road));
      }
    }
  });

  // Start 60-second tick
  setInterval(() => {
    app.tick(new Date());
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
        showStreetPopup(lat, lng, road, findCleaningEntries(road));
      }
    }
  });
}

// ─── Browser entry point ──────────────────────────────────────────────────────

// Only run in browser context (not in Node test environment)
if (typeof document !== "undefined") {
  void initBrowserApp();
}
