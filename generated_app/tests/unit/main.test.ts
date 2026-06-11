/**
 * Unit tests for app/main.ts — F-17.5 / F-10 / F-14
 *
 * Tests the street popup click wiring: normalizeStreet helper, findCleaningEntries
 * helper, and the map click handler behavior in browsing vs parked mode.
 *
 * Also tests F-10.4 initBrowserApp wiring: save button handler (street-side picker,
 * spot marker, sign pins, toast).
 *
 * Also tests F-14: automatic re-fetch on open when a saved spot exists.
 *
 * Leaflet and geo dependencies are mocked so this module runs in Node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreetCleaningEntry } from "../../shared/types";
import type { App, AppState } from "../../app/app";
import type { SavedSpot } from "../../shared/storage";
import { NOW_STABLE } from "../fixtures/signs";

// ─── Mock app/map ─────────────────────────────────────────────────────────────

const mockShowStreetPopup = vi.fn();
const mockRenderPositionMarker = vi.fn();
const mockRegisterMapClickHandler = vi.fn();
const mockInitMap = vi.fn();
const mockRenderSignPins = vi.fn();
const mockRenderSpotMarker = vi.fn();

vi.mock("../../app/map", () => ({
  initMap: mockInitMap,
  registerMapClickHandler: mockRegisterMapClickHandler,
  renderPositionMarker: mockRenderPositionMarker,
  renderSignPins: mockRenderSignPins,
  renderTowSegments: vi.fn(),
  renderSpotMarker: mockRenderSpotMarker,
  clearPositionMarker: vi.fn(),
  clearSpotMarker: vi.fn(),
  centerOnSpot: vi.fn(),
  showStreetPopup: mockShowStreetPopup,
  initRoadGeometry: vi.fn(),
  setTowSignsVisible: vi.fn(),
}));

// ─── Mock app/ui ──────────────────────────────────────────────────────────────

const mockShowSpotToast = vi.fn();
const mockRenderLoading = vi.fn();
const mockHideLoading = vi.fn();
const mockRenderBrowsingMode = vi.fn();
const mockRenderWarningBanner = vi.fn();
const mockRenderClearBanner = vi.fn();
vi.mock("../../app/ui", () => ({
  showSpotToast: mockShowSpotToast,
  renderLoading: mockRenderLoading,
  hideLoading: mockHideLoading,
  renderBrowsingMode: mockRenderBrowsingMode,
  renderWarningBanner: mockRenderWarningBanner,
  renderClearBanner: mockRenderClearBanner,
  TOAST_DURATION_MS: 4000,
}));

// ─── Mock shared/storage ──────────────────────────────────────────────────────

const mockStorageLoad = vi.fn<[], SavedSpot | null>(() => null);
const mockStorageSave = vi.fn<[SavedSpot], void>();
const mockStorageClear = vi.fn<[], void>();
const mockCreateSpotStorage = vi.fn(() => ({
  load: mockStorageLoad,
  save: mockStorageSave,
  clear: mockStorageClear,
}));

vi.mock("../../shared/storage", () => ({
  createSpotStorage: mockCreateSpotStorage,
}));

// ─── Mock app/app ─────────────────────────────────────────────────────────────

// We provide a controllable app mock for initBrowserApp tests
let mockAppState: AppState = {
  mode: "browsing",
  userLat: 40.744,
  userLng: -74.032,
  allSigns: [],
  activeSigns: [],
};
const mockAppGetState = vi.fn<[], AppState>(() => mockAppState);
const mockAppOnSaveSpot = vi.fn<[SavedSpot], void>((spot) => {
  mockAppState = { mode: "parked", spot, allSigns: [], nearbySigns: [] };
});
const mockAppOnClearSpot = vi.fn<[], void>();
const mockAppSetUserPosition = vi.fn<[number, number], void>();
const mockAppTick = vi.fn<[Date], void>();
const mockAppOnHereNow = vi.fn<[], void>();
let capturedRenderState: ((state: AppState) => void) | null = null;
const mockCreateApp = vi.fn<[{ storage: unknown; renderState: (state: AppState) => void }, unknown], App>(
  (deps) => {
    capturedRenderState = deps.renderState;
    return {
      getState: mockAppGetState,
      onSaveSpot: mockAppOnSaveSpot,
      onClearSpot: mockAppOnClearSpot,
      setUserPosition: mockAppSetUserPosition,
      tick: mockAppTick,
      onHereNow: mockAppOnHereNow,
    };
  }
);

vi.mock("../../app/app", () => ({
  createApp: mockCreateApp,
}));

// ─── Mock app/geo ─────────────────────────────────────────────────────────────

const mockGetStreetName = vi.fn<[number, number], Promise<string | null>>();
const mockGeocodeCrossStreet = vi.fn<[string, string?], Promise<{ lat: number; lng: number } | null>>();

vi.mock("../../app/geo", () => ({
  getStreetName: mockGetStreetName,
  geocodeCrossStreet: mockGeocodeCrossStreet,
}));

// ─── Mock fetch for street-cleaning.json ──────────────────────────────────────

// We'll configure this per test
let mockFetchImpl: (() => Promise<Response>) | null = null;
global.fetch = vi.fn().mockImplementation(() => {
  if (mockFetchImpl) {
    return mockFetchImpl();
  }
  return Promise.reject(new Error("fetch not configured"));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCleaningEntry(overrides: Partial<StreetCleaningEntry> = {}): StreetCleaningEntry {
  return {
    street: "Washington Street",
    side: "East",
    schedule: "Monday - 8 am to 9 am",
    location: "9th St. to 10th St.",
    ...overrides,
  };
}

// Capture the callback registered with registerMapClickHandler
function getCapturedClickHandler(): ((lat: number, lng: number) => void) | null {
  const calls = mockRegisterMapClickHandler.mock.calls;
  if (calls.length === 0) return null;
  const lastCall = calls[calls.length - 1];
  if (!lastCall || lastCall.length === 0) return null;
  return lastCall[0] as (lat: number, lng: number) => void;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("F-17.5 main.ts street popup click wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchImpl = null;
    vi.resetModules();
  });

  // ─── normalizeStreet ────────────────────────────────────────────────────────

  describe("normalizeStreet", () => {
    it("lowercases the input", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Washington Street")).toBe("washington street");
    });

    it("expands St abbreviation to street", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Washington St")).toBe("washington street");
    });

    it("expands Ave abbreviation to avenue", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Park Ave")).toBe("park avenue");
    });

    it("expands Blvd abbreviation to boulevard", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Sinatra Blvd")).toBe("sinatra boulevard");
    });

    it("expands Dr abbreviation to drive", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Sinatra Dr")).toBe("sinatra drive");
    });

    it("expands Pl abbreviation to place", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Monroe Pl")).toBe("monroe place");
    });

    it("expands Hwy abbreviation to highway", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Observer Hwy")).toBe("observer highway");
    });

    it("normalizes Seventeenth St to 17th street", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Seventeenth St")).toBe("17th street");
    });

    it("normalizes Nineteenth St to 19th street", async () => {
      const { normalizeStreet } = await import("../../app/main");
      expect(normalizeStreet("Nineteenth St")).toBe("19th street");
    });
  });

  // ─── findCleaningEntries ────────────────────────────────────────────────────

  describe("findCleaningEntries", () => {
    it("returns matching entries for a road name", async () => {
      // Load fresh module and set up cleaning entries via successful fetch
      const washingtonEntry = makeCleaningEntry({ street: "Washington Street" });
      const otherEntry = makeCleaningEntry({ street: "9th Street", side: "North" });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry, otherEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      const { init, findCleaningEntries } = await import("../../app/main");
      await init();
      // Wait a tick for the fire-and-forget fetch to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      const results = findCleaningEntries("Washington Street");
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(washingtonEntry);
    });

    it("returns empty array when no entries match", async () => {
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [makeCleaningEntry({ street: "9th Street" })],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      const { init, findCleaningEntries } = await import("../../app/main");
      await init();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const results = findCleaningEntries("Washington Street");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when cleaningEntries is empty (fetch failed)", async () => {
      mockFetchImpl = () => Promise.reject(new Error("Network error"));

      const { init, findCleaningEntries } = await import("../../app/main");
      await init();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const results = findCleaningEntries("Washington Street");
      expect(results).toHaveLength(0);
    });
  });

  // ─── Click handler — parked mode ───────────────────────────────────────────

  describe("click handler in parked mode", () => {
    it("GIVEN parked mode and getStreetName resolves to 'Washington Street', THEN showStreetPopup is called with road name and matching entries", async () => {
      const washingtonEntry = makeCleaningEntry({ street: "Washington Street" });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      expect(mockShowStreetPopup).toHaveBeenCalledOnce();
      const [lat, lng, road, entries] = mockShowStreetPopup.mock.calls[0] as [
        number,
        number,
        string,
        StreetCleaningEntry[]
      ];
      expect(lat).toBeCloseTo(40.744, 5);
      expect(lng).toBeCloseTo(-74.032, 5);
      expect(road).toBe("Washington Street");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(washingtonEntry);
    });

    it("GIVEN parked mode and getStreetName returns null, THEN showStreetPopup is not called", async () => {
      mockFetchImpl = () => Promise.reject(new Error("not needed"));
      mockGetStreetName.mockResolvedValue(null);

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      expect(mockShowStreetPopup).not.toHaveBeenCalled();
    });

    it("GIVEN street-cleaning.json fails to load, WHEN clicked in parked mode, THEN showStreetPopup is called with empty entries (no crash)", async () => {
      mockFetchImpl = () => Promise.reject(new Error("Network error"));
      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      expect(mockShowStreetPopup).toHaveBeenCalledOnce();
      const [, , , entries] = mockShowStreetPopup.mock.calls[0] as [
        number,
        number,
        string,
        StreetCleaningEntry[]
      ];
      expect(entries).toHaveLength(0);
    });
  });

  // ─── Click handler — browsing mode ─────────────────────────────────────────

  describe("click handler in browsing mode", () => {
    it("GIVEN browsing mode and map is clicked, THEN getStreetName is not called (position-setting branch runs)", async () => {
      mockFetchImpl = () => Promise.reject(new Error("not needed"));

      const { init } = await import("../../app/main");
      await init("browsing");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      expect(mockGetStreetName).not.toHaveBeenCalled();
      expect(mockRenderPositionMarker).toHaveBeenCalledWith(40.744, -74.032);
    });
  });

  // ─── F-20 buildDetectSegmentCallback ───────────────────────────────────────

  describe("F-20 buildDetectSegmentCallback via parked-mode click handler", () => {
    it("F-20: GIVEN the parked-mode click handler fires at a known coordinate, THEN showStreetPopup is called with a fifth argument that is a function", async () => {
      const washingtonEntry = makeCleaningEntry({ street: "Washington Street", location: "9th St. to 10th St." });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      expect(mockShowStreetPopup).toHaveBeenCalledOnce();
      const call = mockShowStreetPopup.mock.calls[0] as unknown[];
      // 5th argument should be a function (the detectSegment callback)
      expect(typeof call[4]).toBe("function");
    });

    it("F-20: GIVEN geocodeCrossStreet returns coordinates that bracket the click point, WHEN the detectSegment callback is called, THEN it resolves to the matching location string", async () => {
      // click at lat 40.745 (between 40.740 and 40.750)
      // N-S street: deltaLat(0.010) > deltaLng(0.000) => latitude check
      mockGeocodeCrossStreet
        .mockResolvedValueOnce({ lat: 40.740, lng: -74.032 }) // "9th St"
        .mockResolvedValueOnce({ lat: 40.750, lng: -74.032 }); // "10th St"

      const washingtonEntry = makeCleaningEntry({ street: "Washington Street", location: "9th St. to 10th St." });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.745, -74.032);

      expect(mockShowStreetPopup).toHaveBeenCalledOnce();
      const call = mockShowStreetPopup.mock.calls[0] as unknown[];
      const detectSegment = call[4] as (locations: string[]) => Promise<string[] | null>;
      expect(typeof detectSegment).toBe("function");

      const result = await detectSegment(["9th St. to 10th St."]);
      expect(result).toEqual(["9th St. to 10th St."]);
    });

    it("F-20: GIVEN geocodeCrossStreet returns null for all cross-streets, WHEN the callback is called, THEN it resolves to null", async () => {
      mockGeocodeCrossStreet.mockResolvedValue(null);

      const washingtonEntry = makeCleaningEntry({ street: "Washington Street", location: "9th St. to 10th St." });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      const call = mockShowStreetPopup.mock.calls[0] as unknown[];
      const detectSegment = call[4] as (locations: string[]) => Promise<string[] | null>;
      const result = await detectSegment(["9th St. to 10th St."]);
      expect(result).toBeNull();
    });

    it("F-20: GIVEN extractCrossStreets returns null for a location (uses ' and '), THEN that location is skipped and geocodeCrossStreet is not called for it", async () => {
      mockGeocodeCrossStreet.mockResolvedValue(null);

      const washingtonEntry = makeCleaningEntry({ street: "Washington Street", location: "8th St. and 9th St." });
      const streetCleaningData = {
        fetched_at: "2026-06-09T12:00:00Z",
        entries: [washingtonEntry],
      };

      mockFetchImpl = () =>
        Promise.resolve({
          ok: true,
          json: async () => streetCleaningData,
        } as Response);

      mockGetStreetName.mockResolvedValue("Washington Street");

      const { init } = await import("../../app/main");
      await init("parked");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const handler = getCapturedClickHandler();
      expect(handler).not.toBeNull();
      if (handler === null) return;

      await handler(40.744, -74.032);

      const call = mockShowStreetPopup.mock.calls[0] as unknown[];
      const detectSegment = call[4] as (locations: string[]) => Promise<string[] | null>;
      // "8th St. and 9th St." uses " and " — extractCrossStreets returns null, skip
      const result = await detectSegment(["8th St. and 9th St."]);
      expect(result).toBeNull();
      // geocodeCrossStreet should NOT have been called (location was skipped)
      expect(mockGeocodeCrossStreet).not.toHaveBeenCalled();
    });
  });
});

// ─── F-10.1 Open App Cold (No Saved Spot) ────────────────────────────────────

describe("F-10.1 initBrowserApp cold open", () => {
  function makeMockButton(id: string): HTMLButtonElement & { click(): void } {
    const listeners: Record<string, (() => void)[]> = {};
    const btn = {
      id,
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener(event: string, fn: () => void) {
        if (!listeners[event]) listeners[event] = [];
        (listeners[event] as (() => void)[]).push(fn);
      },
      click() {
        (listeners["click"] ?? []).forEach((fn) => fn());
      },
    } as unknown as HTMLButtonElement & { click(): void };
    return btn;
  }

  function installDocumentMock(): void {
    const elements: Record<string, unknown> = {
      "save-btn": makeMockButton("save-btn"),
      "clear-btn": makeMockButton("clear-btn"),
      "here-btn": makeMockButton("here-btn"),
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  function removeDocumentMock(): void {
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    mockFetchImpl = null;
    vi.resetModules();

    mockAppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);
    capturedRenderState = null;
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });
    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    mockStorageLoad.mockImplementation(() => null);
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) return mockFetchImpl();
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  afterEach(() => {
    removeDocumentMock();
  });

  it("F-10.1 GIVEN no saved spot and latest.json resolves, WHEN initBrowserApp completes, THEN createApp was called and initial state is browsing", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockCreateApp).toHaveBeenCalledOnce();
    expect(mockAppGetState().mode).toBe("browsing");
  });

  it("F-10.1 GIVEN no saved spot, WHEN initBrowserApp completes, THEN renderPositionMarker was not called (no stray position marker)", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRenderPositionMarker.mock.calls.length).toBe(0);
  });
});

// ─── F-10.2 Tap to Set Position ───────────────────────────────────────────────

describe("F-10.2 map tap sets position marker", () => {
  function makeMockButton(id: string): HTMLButtonElement & { click(): void } {
    const listeners: Record<string, (() => void)[]> = {};
    const btn = {
      id,
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener(event: string, fn: () => void) {
        if (!listeners[event]) listeners[event] = [];
        (listeners[event] as (() => void)[]).push(fn);
      },
      click() {
        (listeners["click"] ?? []).forEach((fn) => fn());
      },
    } as unknown as HTMLButtonElement & { click(): void };
    return btn;
  }

  function installDocumentMock(): void {
    const elements: Record<string, unknown> = {
      "save-btn": makeMockButton("save-btn"),
      "clear-btn": makeMockButton("clear-btn"),
      "here-btn": makeMockButton("here-btn"),
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  function removeDocumentMock(): void {
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    mockFetchImpl = null;
    vi.resetModules();

    mockAppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);
    capturedRenderState = null;
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });
    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    mockStorageLoad.mockImplementation(() => null);
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) return mockFetchImpl();
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  afterEach(() => {
    removeDocumentMock();
  });

  it("F-10.2 GIVEN browsing mode, WHEN map click fires, THEN onSaveSpot is called with the clicked coordinates", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = getCapturedClickHandler();
    expect(handler).not.toBeNull();
    if (handler === null) return;

    await handler(40.744, -74.032);

    expect(mockAppOnSaveSpot).toHaveBeenCalledOnce();
    const savedSpot = mockAppOnSaveSpot.mock.calls[0]?.[0] as SavedSpot;
    expect(savedSpot.lat).toBeCloseTo(40.744, 5);
    expect(savedSpot.lng).toBeCloseTo(-74.032, 5);
    expect(savedSpot.address).toBeNull();
  });

  it("F-10.2 GIVEN browsing mode, WHEN map click fires, THEN renderPositionMarker is NOT called", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = getCapturedClickHandler();
    expect(handler).not.toBeNull();
    if (handler === null) return;

    await handler(40.744, -74.032);

    expect(mockRenderPositionMarker).not.toHaveBeenCalled();
  });
});

// ─── F-10.3 signEmoji ─────────────────────────────────────────────────────────
//
// signEmoji is exported from app/map.ts. Since the top-level vi.mock replaces
// app/map for main.ts tests, we use vi.importActual to access the real module.

describe("F-10.3 signEmoji", () => {
  it("signEmoji('CONSTRUCTION') returns an SVG dot", async () => {
    const actual = await vi.importActual<typeof import("../../app/map")>("../../app/map");
    expect(actual.signEmoji("CONSTRUCTION")).toContain("<svg");
    expect(actual.signEmoji("CONSTRUCTION")).toContain("#cc0000");
  });

  it("signEmoji('DELIVERY') returns an SVG dot", async () => {
    const actual = await vi.importActual<typeof import("../../app/map")>("../../app/map");
    expect(actual.signEmoji("DELIVERY")).toContain("<svg");
    expect(actual.signEmoji("DELIVERY")).toContain("#cc0000");
  });

  it("signEmoji('UNKNOWN_REASON') returns a hollow SVG ring (fallback)", async () => {
    const actual = await vi.importActual<typeof import("../../app/map")>("../../app/map");
    expect(actual.signEmoji("UNKNOWN_REASON")).toContain("<svg");
    expect(actual.signEmoji("UNKNOWN_REASON")).toContain("stroke=\"#dc2626\"");
  });

  it("F-10.3 GIVEN browsing mode with 3 active signs, WHEN renderState fires, THEN renderSignPins is called with array of length 3", async () => {
    // Use the module-level mockRenderSignPins (set up by the top-level vi.mock) and
    // capturedRenderState (set by mockCreateApp). We just need to call capturedRenderState
    // with a browsing state that has 3 activeSigns and verify renderSignPins is called
    // with those 3 signs.
    // Note: capturedRenderState may be null if initBrowserApp hasn't been called in this
    // test context. We call it here with the document mock installed.
    vi.clearAllMocks();
    vi.resetModules();
    mockFetchImpl = null;

    // Use a container to avoid TypeScript narrowing capturedRenderState to null
    const renderStateHolder: { fn: ((state: AppState) => void) | null } = { fn: null };

    // Re-install mocks
    mockAppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      renderStateHolder.fn = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });
    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    mockStorageLoad.mockImplementation(() => null);

    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response)
    );

    // Install HTMLButtonElement shim before document mock and module import
    class HTMLButtonElementShim {}
    (globalThis as Record<string, unknown>)["HTMLButtonElement"] = HTMLButtonElementShim;

    // Install document mock with save-btn as an instance of the shim
    const saveBtnEl = Object.assign(new HTMLButtonElementShim(), {
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener: vi.fn(),
    });
    const elements: Record<string, unknown> = {
      "save-btn": saveBtnEl,
      "clear-btn": { style: { display: "" as string }, addEventListener: vi.fn() },
      "here-btn": { style: { display: "" as string }, addEventListener: vi.fn() },
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };

    const { initBrowserApp } = await import("../../app/main");
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Now simulate renderState being called with 3 active signs
    const threeSignState: AppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [
        { id: "1", address: "1 Test St", reason: "CONSTRUCTION", permit_number: "P1", lat: 40.744, lng: -74.032, start_date: "6/1/2026", start_time: "00:00:00", stop_date: "12/31/2026", end_time: "23:59:59", start_iso: "2026-06-01T00:00:00", end_iso: "2026-12-31T23:59:59", active_at_fetch: true },
        { id: "2", address: "2 Test St", reason: "DELIVERY", permit_number: "P2", lat: 40.744, lng: -74.031, start_date: "6/1/2026", start_time: "00:00:00", stop_date: "12/31/2026", end_time: "23:59:59", start_iso: "2026-06-01T00:00:00", end_iso: "2026-12-31T23:59:59", active_at_fetch: true },
        { id: "3", address: "3 Test St", reason: "MOVING", permit_number: "P3", lat: 40.745, lng: -74.032, start_date: "6/1/2026", start_time: "00:00:00", stop_date: "12/31/2026", end_time: "23:59:59", start_iso: "2026-06-01T00:00:00", end_iso: "2026-12-31T23:59:59", active_at_fetch: true },
      ],
    };

    // Call renderState via the holder (avoids TypeScript null narrowing issue)
    if (renderStateHolder.fn !== null) {
      renderStateHolder.fn(threeSignState);
    }

    // mockRenderSignPins from the top-level vi.mock should have been called with 3 signs
    expect(mockRenderSignPins).toHaveBeenCalled();
    const calls = mockRenderSignPins.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    expect((lastCall as unknown[])[0]).toHaveLength(3);

    // Cleanup
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
    delete (globalThis as Record<string, unknown>)["HTMLButtonElement"];
  });
});

// ─── F-10.3b normalizeStreet and findCleaningEntries ─────────────────────────

describe("F-10.3b normalizeStreet spec cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("normalizeStreet('11th St') returns '11th street'", async () => {
    const { normalizeStreet } = await import("../../app/main");
    expect(normalizeStreet("11th St")).toBe("11th street");
  });

  it("normalizeStreet('SINATRA DR') returns 'sinatra drive'", async () => {
    const { normalizeStreet } = await import("../../app/main");
    expect(normalizeStreet("SINATRA DR")).toBe("sinatra drive");
  });
});

describe("F-10.3b findCleaningEntries spec cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFetchImpl = null;

    // Re-install the fetch mock implementation after resets
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) return mockFetchImpl();
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  it("GIVEN cleaningEntries has entry with street 'Observer Hwy', findCleaningEntries('Observer Hwy') returns that entry", async () => {
    const observerEntry = makeCleaningEntry({ street: "Observer Hwy" });
    const streetCleaningData = {
      fetched_at: "2026-06-09T12:00:00Z",
      entries: [observerEntry],
    };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => streetCleaningData } as Response);

    const { init, findCleaningEntries } = await import("../../app/main");
    await init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = findCleaningEntries("Observer Hwy");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(observerEntry);
  });

  it("GIVEN cleaningEntries has entry with street 'Observer Hwy', findCleaningEntries('observer highway') also returns that entry (normalized match)", async () => {
    const observerEntry = makeCleaningEntry({ street: "Observer Hwy" });
    const streetCleaningData = {
      fetched_at: "2026-06-09T12:00:00Z",
      entries: [observerEntry],
    };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => streetCleaningData } as Response);

    const { init, findCleaningEntries } = await import("../../app/main");
    await init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = findCleaningEntries("observer highway");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(observerEntry);
  });

  it("GIVEN findCleaningEntries('Nonexistent St') is called, THEN it returns an empty array", async () => {
    const streetCleaningData = {
      fetched_at: "2026-06-09T12:00:00Z",
      entries: [makeCleaningEntry({ street: "Washington Street" })],
    };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => streetCleaningData } as Response);

    const { init, findCleaningEntries } = await import("../../app/main");
    await init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const results = findCleaningEntries("Nonexistent St");
    expect(results).toHaveLength(0);
  });
});

// ─── F-10.4 initBrowserApp map-click auto-save ───────────────────────────────
//
// These tests verify that clicking the map in browsing mode immediately calls
// onSaveSpot (auto-save), and that renderState correctly renders the parked UI.

describe("F-10.4 initBrowserApp map-click auto-save", () => {
  function makeMockButton(id: string): HTMLButtonElement & { click(): void } {
    const listeners: Record<string, (() => void)[]> = {};
    const btn = {
      id,
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener(event: string, fn: () => void) {
        if (!listeners[event]) listeners[event] = [];
        (listeners[event] as (() => void)[]).push(fn);
      },
      click() {
        (listeners["click"] ?? []).forEach((fn) => fn());
      },
    } as unknown as HTMLButtonElement & { click(): void };
    return btn;
  }

  function installDocumentMock(): void {
    const elements: Record<string, unknown> = {
      "clear-btn": makeMockButton("clear-btn"),
      "here-btn": makeMockButton("here-btn"),
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  function removeDocumentMock(): void {
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    mockFetchImpl = null;
    vi.resetModules();

    mockAppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);
    mockAppOnSaveSpot.mockImplementation((spot: SavedSpot) => {
      mockAppState = { mode: "parked", spot, allSigns: [], nearbySigns: [] };
    });
    capturedRenderState = null;
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });
    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    mockStorageLoad.mockImplementation(() => null);
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) return mockFetchImpl();
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  afterEach(() => {
    removeDocumentMock();
  });

  it("F-10.4 GIVEN browsing mode, WHEN map click fires, THEN onSaveSpot is called with clicked lat/lng", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const handler = getCapturedClickHandler();
    expect(handler).not.toBeNull();
    if (handler === null) return;

    await handler(40.744, -74.032);

    expect(mockAppOnSaveSpot).toHaveBeenCalledOnce();
    const savedSpot = mockAppOnSaveSpot.mock.calls[0]?.[0] as SavedSpot;
    expect(savedSpot.lat).toBeCloseTo(40.744, 5);
    expect(savedSpot.lng).toBeCloseTo(-74.032, 5);
    expect(savedSpot.address).toBeNull();
  });

  it("F-10.4 GIVEN browsing mode map click fires, WHEN renderState fires with parked state, THEN renderSpotMarker and renderSignPins are called", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);
    mockGetStreetName.mockResolvedValue(null);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedRenderState).not.toBeNull();

    const handler = getCapturedClickHandler();
    expect(handler).not.toBeNull();
    if (handler === null) return;

    // Click triggers onSaveSpot which updates mockAppState to parked
    await handler(40.744, -74.032);

    // Simulate renderState being called with the parked state
    if (capturedRenderState !== null) {
      capturedRenderState(mockAppState);
    }

    expect(mockRenderSpotMarker).toHaveBeenCalled();
    expect(mockRenderSignPins).toHaveBeenCalled();
  });
});

// ─── F-14 Automatic Re-Fetch on Open ─────────────────────────────────────────
//
// When a saved spot exists, initBrowserApp performs a second fetch with
// { cache: "no-cache" } before passing signs to createApp.

describe("F-14 automatic re-fetch on open", () => {
  // Minimal mock button factory (same as in F-10.4 suite)
  function makeMockButton(id: string): HTMLButtonElement & { click(): void } {
    const listeners: Record<string, (() => void)[]> = {};
    const btn = {
      id,
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener(event: string, fn: () => void) {
        if (!listeners[event]) listeners[event] = [];
        (listeners[event] as (() => void)[]).push(fn);
      },
      click() {
        (listeners["click"] ?? []).forEach((fn) => fn());
      },
    } as unknown as HTMLButtonElement & { click(): void };
    return btn;
  }

  function installDocumentMock(): void {
    const elements: Record<string, unknown> = {
      "save-btn": makeMockButton("save-btn"),
      "clear-btn": makeMockButton("clear-btn"),
      "here-btn": makeMockButton("here-btn"),
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  function removeDocumentMock(): void {
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
  }

  const savedSpot: SavedSpot = {
    lat: 40.744,
    lng: -74.032,
    side: "N",
    savedAt: "2026-06-09T12:00:00.000Z",
    address: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    mockFetchImpl = null;
    vi.resetModules();

    // Default app state: parked (spot is saved)
    mockAppState = {
      mode: "parked",
      spot: savedSpot,
      allSigns: [],
      nearbySigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);
    capturedRenderState = null;
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });

    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    // Default: storage has a saved spot
    mockStorageLoad.mockImplementation(() => savedSpot);

    // Default: getStreetName returns null (prevents TypeError when renderState auto-opens popup)
    mockGetStreetName.mockResolvedValue(null);

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) {
        return mockFetchImpl();
      }
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  afterEach(() => {
    removeDocumentMock();
  });

  it("F-14.1 GIVEN a saved spot exists, WHEN initBrowserApp runs, THEN fetch is called at least twice and the second call uses { cache: 'no-cache' }", async () => {
    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    const secondPayload = { fetched_at: "2026-06-09T12:01:00Z", signs: [] };

    let callCount = 0;
    mockFetchImpl = () => {
      callCount++;
      const payload = callCount === 1 ? firstPayload : secondPayload;
      return Promise.resolve({
        ok: true,
        json: async () => payload,
      } as Response);
    };

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    const calls = fetchSpy.mock.calls;

    // At least two calls to fetch
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Find a call that used { cache: "no-cache" }
    const noCacheCall = calls.find((call) => {
      const opts = call[1] as RequestInit | undefined;
      return opts !== undefined && (opts as RequestInit).cache === "no-cache";
    });
    expect(noCacheCall).toBeDefined();
  });

  it("F-14.1 GIVEN a saved spot exists and the no-cache fetch fails, WHEN initBrowserApp runs, THEN createApp is still called and mock app reaches parked state", async () => {
    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };

    // call 1 = street-cleaning fire-and-forget, call 2 = cross-streets fire-and-forget,
    // call 3 = road-geometry fire-and-forget, call 4 = data/latest.json (succeeds),
    // call 5 = data/latest.json no-cache (fails)
    let callCount = 0;
    mockFetchImpl = () => {
      callCount++;
      if (callCount <= 4) {
        return Promise.resolve({
          ok: true,
          json: async () => firstPayload,
        } as Response);
      }
      // Fifth call (no-cache) fails
      return Promise.reject(new Error("Network error on no-cache fetch"));
    };

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();

    // Should not throw
    await expect(initBrowserApp()).resolves.toBeUndefined();

    // createApp must have been called
    expect(mockCreateApp).toHaveBeenCalledOnce();

    // App state should still be parked
    expect(mockAppGetState().mode).toBe("parked");
  });

  it("F-14.1 GIVEN a saved spot exists and no-cache fetch returns 5 signs, WHEN createApp is called, THEN initialData.signs has length 5", async () => {
    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    // 5 signs in the fresh fetch — coordinates well within Hoboken, active window covers NOW_STABLE
    const freshSigns = Array.from({ length: 5 }, (_, i) => ({
      id: `fresh-${i}`,
      address: `${i} Test St`,
      reason: "CONSTRUCTION",
      permit_number: `P${i}`,
      lat: 40.744 + i * 0.0001,
      lng: -74.032,
      start_date: "6/1/2026",
      start_time: "00:00:00",
      stop_date: "12/31/2026",
      end_time: "23:59:59",
      start_iso: "2026-06-01T00:00:00",
      end_iso: "2026-12-31T23:59:59",
      active_at_fetch: true,
    }));
    const secondPayload = { fetched_at: "2026-06-09T12:01:00Z", signs: freshSigns };

    let callCount = 0;
    mockFetchImpl = () => {
      callCount++;
      const payload = callCount === 1 ? firstPayload : secondPayload;
      return Promise.resolve({
        ok: true,
        json: async () => payload,
      } as Response);
    };

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();

    expect(mockCreateApp).toHaveBeenCalledOnce();
    const createAppCall = mockCreateApp.mock.calls[0];
    const initialData = createAppCall?.[1] as { signs: unknown[]; fetchTime: Date };
    expect(initialData.signs).toHaveLength(5);
  });

  it("F-14.2 GIVEN saved spot and no-cache fetch returns a nearby active sign, WHEN initBrowserApp runs with NOW_STABLE, THEN renderWarningBanner is called", async () => {
    // Spot at 40.744, -74.032. Sign within 150m and active during NOW_STABLE window.
    const nearbyActiveSign = {
      id: "nearby-active",
      address: "123 Test St",
      reason: "CONSTRUCTION",
      permit_number: "P123",
      lat: 40.744,
      lng: -74.032,
      start_date: "6/1/2026",
      start_time: "00:00:00",
      stop_date: "12/31/2026",
      end_time: "23:59:59",
      start_iso: "2026-06-01T00:00:00",
      end_iso: "2026-12-31T23:59:59",
      active_at_fetch: true,
    };

    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    const secondPayload = { fetched_at: NOW_STABLE.toISOString(), signs: [nearbyActiveSign] };

    let callCount = 0;
    mockFetchImpl = () => {
      callCount++;
      const payload = callCount === 1 ? firstPayload : secondPayload;
      return Promise.resolve({
        ok: true,
        json: async () => payload,
      } as Response);
    };

    // Make the mock app actually call renderState with the right state when createApp is called.
    // We need to simulate what createApp would do: load the spot, find nearby signs, render parked+warning.
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      // Simulate initial renderState call from createApp, with nearbySigns populated
      const parkedState: AppState = {
        mode: "parked",
        spot: savedSpot,
        allSigns: [nearbyActiveSign as unknown as import("../../shared/types").Sign],
        nearbySigns: [nearbyActiveSign as unknown as import("../../shared/types").Sign],
      };
      deps.renderState(parkedState);
      mockAppState = parkedState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRenderWarningBanner).toHaveBeenCalled();
    expect(mockRenderClearBanner).not.toHaveBeenCalled();
  });

  it("F-14.2 GIVEN saved spot and no-cache fetch returns no nearby signs, WHEN initBrowserApp runs, THEN renderClearBanner is called", async () => {
    // Sign far from the saved spot (> 150m away)
    const farAwaySign = {
      id: "far-away",
      address: "999 Far St",
      reason: "CONSTRUCTION",
      permit_number: "P999",
      lat: 40.800,
      lng: -74.100,
      start_date: "6/1/2026",
      start_time: "00:00:00",
      stop_date: "12/31/2026",
      end_time: "23:59:59",
      start_iso: "2026-06-01T00:00:00",
      end_iso: "2026-12-31T23:59:59",
      active_at_fetch: true,
    };

    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    const secondPayload = { fetched_at: NOW_STABLE.toISOString(), signs: [farAwaySign] };

    let callCount = 0;
    mockFetchImpl = () => {
      callCount++;
      const payload = callCount === 1 ? firstPayload : secondPayload;
      return Promise.resolve({
        ok: true,
        json: async () => payload,
      } as Response);
    };

    // Simulate createApp with no nearby signs
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      const parkedState: AppState = {
        mode: "parked",
        spot: savedSpot,
        allSigns: [farAwaySign as unknown as import("../../shared/types").Sign],
        nearbySigns: [], // no nearby signs
      };
      deps.renderState(parkedState);
      mockAppState = parkedState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRenderClearBanner).toHaveBeenCalled();
    expect(mockRenderWarningBanner).not.toHaveBeenCalled();
  });

  it("F-14.1 GIVEN no saved spot, WHEN initBrowserApp runs, THEN fetch is called only once (no re-fetch)", async () => {
    // No saved spot
    mockStorageLoad.mockImplementation(() => null);
    mockAppState = {
      mode: "browsing",
      userLat: null,
      userLng: null,
      allSigns: [],
      activeSigns: [],
    };
    mockAppGetState.mockImplementation(() => mockAppState);

    const firstPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({
        ok: true,
        json: async () => firstPayload,
      } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    // Only one data/latest.json call (no re-fetch when no saved spot)
    const latestJsonCalls = fetchSpy.mock.calls.filter((call) => {
      const url = call[0] as string;
      return url === "data/latest.json";
    });
    expect(latestJsonCalls).toHaveLength(1);
  });
});

// ─── Auto-refresh staleness check ────────────────────────────────────────────
//
// When the 60-second tick fires and _fetchedAt is from a previous UTC calendar
// day, silentRefresh should fetch data/latest.json with cache: "no-cache".

describe("auto-refresh staleness check", () => {
  function makeMockButton(id: string) {
    return {
      id,
      style: { display: "" as string },
      disabled: false as boolean,
      addEventListener: vi.fn(),
    };
  }

  function installDocumentMockAR(): void {
    const elements: Record<string, unknown> = {
      "clear-btn": makeMockButton("clear-btn"),
      "here-btn": makeMockButton("here-btn"),
      "banner": { style: { display: "none" }, textContent: "" },
    };
    (globalThis as Record<string, unknown>)["document"] = {
      getElementById: (id: string) => elements[id] ?? null,
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>)["localStorage"] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }

  function removeDocumentMockAR(): void {
    delete (globalThis as Record<string, unknown>)["document"];
    delete (globalThis as Record<string, unknown>)["localStorage"];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
    mockFetchImpl = null;
    vi.resetModules();

    mockAppState = { mode: "browsing", allSigns: [], nearbySigns: [] } as unknown as AppState;
    mockAppGetState.mockImplementation(() => mockAppState);
    capturedRenderState = null;
    mockCreateApp.mockImplementation((deps: { storage: unknown; renderState: (state: AppState) => void }) => {
      capturedRenderState = deps.renderState;
      return {
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      };
    });
    mockCreateSpotStorage.mockImplementation(() => ({
      load: mockStorageLoad,
      save: mockStorageSave,
      clear: mockStorageClear,
    }));
    mockStorageLoad.mockImplementation(() => null);

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (mockFetchImpl) return mockFetchImpl();
      return Promise.reject(new Error("fetch not configured"));
    });
  });

  afterEach(() => {
    removeDocumentMockAR();
  });

  it("GIVEN _fetchedAt is from a previous UTC day, WHEN the 60s tick fires, THEN fetch is called with data/latest.json and cache: no-cache", async () => {
    // Initial fetch returns data timestamped yesterday so the staleness check fires
    const yesterdayPayload = { fetched_at: "2026-06-08T11:00:00Z", signs: [] };
    const todayPayload = { fetched_at: "2026-06-09T11:00:00Z", signs: [] };

    // Capture the 60-second tick callback by temporarily replacing setInterval
    const capturedCallbacks: Array<() => void> = [];
    const origSetInterval = globalThis.setInterval.bind(globalThis) as typeof setInterval;
    (globalThis as Record<string, unknown>)["setInterval"] = (fn: () => void, delay: number) => {
      if (delay === 60_000) { capturedCallbacks.push(fn); return 0; }
      return origSetInterval(fn as TimerHandler, delay);
    };

    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => yesterdayPayload } as Response);

    const { initBrowserApp } = await import("../../app/main");
    installDocumentMockAR();
    await initBrowserApp();
    await new Promise<void>((resolve) => origSetInterval(resolve as TimerHandler, 0));

    // Restore setInterval
    (globalThis as Record<string, unknown>)["setInterval"] = origSetInterval;

    const fetchSpy = global.fetch as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();

    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => todayPayload } as Response);
    fetchSpy.mockImplementation(() => mockFetchImpl ? mockFetchImpl() : Promise.reject(new Error()));

    // Fire the tick manually and allow async fetch to settle
    const tick = capturedCallbacks[0];
    if (tick) tick();
    await new Promise<void>((resolve) => origSetInterval(resolve as TimerHandler, 10));

    const calls = fetchSpy.mock.calls as [string, RequestInit | undefined][];
    const staleRefreshCall = calls.find((call) => {
      const opts = call[1];
      return call[0] === "data/latest.json" && opts?.cache === "no-cache";
    });
    expect(staleRefreshCall).toBeDefined();
  });
});
