/**
 * Unit tests for F-27 — Get Current Location Button
 *
 * Tests:
 *  F-27.1 — HTML structure (locate-control, locate-btn)
 *  F-27.2 — CSS rules (locate-control position, locate-btn size, tow-legend top update)
 *  F-27.3 — Button wiring in initBrowserApp()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { AppState } from "../../app/app";
import type { SavedSpot } from "../../shared/storage";

// ─── Read static files ────────────────────────────────────────────────────────

const HTML_PATH = join(__dirname, "../../app/index.html");
const CSS_PATH  = join(__dirname, "../../app/style.css");

function readHtml(): string {
  return readFileSync(HTML_PATH, "utf-8");
}

function readCss(): string {
  return readFileSync(CSS_PATH, "utf-8");
}

// ─── F-27.1 HTML tests ────────────────────────────────────────────────────────

describe("F-27.1 index.html locate-control", () => {
  it("GIVEN app/index.html source, THEN it contains an element with id='locate-control'", () => {
    expect(readHtml()).toContain('id="locate-control"');
  });

  it("GIVEN app/index.html source, THEN it contains a button with id='locate-btn'", () => {
    expect(readHtml()).toContain('id="locate-btn"');
  });

  it("GIVEN app/index.html source, THEN #locate-btn has type='button'", () => {
    const html = readHtml();
    // Find the locate-btn element and verify it has type="button"
    const locateBtnMatch = html.match(/id="locate-btn"[^>]*>/);
    if (locateBtnMatch) {
      // The button tag containing id="locate-btn" should also have type="button"
      // Find the opening <button tag that contains locate-btn
      const startIdx = html.indexOf('<button') ;
      const locateBtnIdx = html.indexOf('id="locate-btn"');
      // Search backward from locate-btn position to find its opening tag
      const beforeBtn = html.substring(0, locateBtnIdx);
      const lastButtonOpen = beforeBtn.lastIndexOf('<button');
      const openingTag = html.substring(lastButtonOpen, locateBtnIdx + 50);
      expect(openingTag).toContain('type="button"');
    } else {
      // Try alternative: just check both strings appear near each other
      expect(html).toContain('type="button"');
      expect(html).toContain('id="locate-btn"');
    }
  });

  it("GIVEN app/index.html source, THEN #locate-btn has aria-label='Get my current location'", () => {
    expect(readHtml()).toContain('aria-label="Get my current location"');
  });

  it("GIVEN app/index.html source, THEN #locate-control appears before #tow-legend in the DOM", () => {
    const html = readHtml();
    const locateIdx = html.indexOf('id="locate-control"');
    const towIdx = html.indexOf('id="tow-legend"');
    expect(locateIdx).toBeGreaterThanOrEqual(0);
    expect(towIdx).toBeGreaterThanOrEqual(0);
    expect(locateIdx).toBeLessThan(towIdx);
  });
});

// ─── F-27.2 CSS tests ─────────────────────────────────────────────────────────

describe("F-27.2 style.css locate-control rules", () => {
  it("GIVEN app/style.css source, THEN it contains #locate-control with position: fixed", () => {
    const css = readCss();
    // Find the #locate-control block
    const locateControlIdx = css.indexOf("#locate-control");
    expect(locateControlIdx).toBeGreaterThanOrEqual(0);
    // Get the content of the block following it
    const blockStart = css.indexOf("{", locateControlIdx);
    const blockEnd = css.indexOf("}", blockStart);
    const block = css.substring(blockStart, blockEnd);
    expect(block).toContain("position: fixed");
  });

  it("GIVEN app/style.css source, THEN it contains top: 84px for #locate-control", () => {
    const css = readCss();
    const locateControlIdx = css.indexOf("#locate-control");
    expect(locateControlIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf("{", locateControlIdx);
    const blockEnd = css.indexOf("}", blockStart);
    const block = css.substring(blockStart, blockEnd);
    expect(block).toContain("top: 84px");
  });

  it("GIVEN app/style.css source, THEN it contains left: 10px for #locate-control", () => {
    const css = readCss();
    const locateControlIdx = css.indexOf("#locate-control");
    expect(locateControlIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf("{", locateControlIdx);
    const blockEnd = css.indexOf("}", blockStart);
    const block = css.substring(blockStart, blockEnd);
    expect(block).toContain("left: 10px");
  });

  it("GIVEN app/style.css source, THEN #locate-btn has width: 34px and height: 34px", () => {
    const css = readCss();
    const locateBtnIdx = css.indexOf("#locate-btn");
    expect(locateBtnIdx).toBeGreaterThanOrEqual(0);
    // Find the first non-pseudo-class block for #locate-btn
    // (skip :active and :disabled variants by finding the standalone #locate-btn { block)
    let searchFrom = locateBtnIdx;
    let foundBlock = "";
    while (searchFrom < css.length) {
      const blockStart = css.indexOf("{", searchFrom);
      if (blockStart === -1) break;
      const blockEnd = css.indexOf("}", blockStart);
      const block = css.substring(blockStart, blockEnd);
      // The main #locate-btn block should have both width and height
      if (block.includes("width: 34px") && block.includes("height: 34px")) {
        foundBlock = block;
        break;
      }
      searchFrom = blockEnd + 1;
    }
    expect(foundBlock).toContain("width: 34px");
    expect(foundBlock).toContain("height: 34px");
  });

  it("GIVEN app/style.css source, THEN #tow-legend has top: 126px (not top: 84px)", () => {
    const css = readCss();
    // Find #tow-legend block
    const towLegendIdx = css.indexOf("#tow-legend {");
    expect(towLegendIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf("{", towLegendIdx);
    const blockEnd = css.indexOf("}", blockStart);
    const block = css.substring(blockStart, blockEnd);
    expect(block).toContain("top: 126px");
    expect(block).not.toContain("top: 84px");
  });
});

// ─── F-27.3 main.ts button wiring ────────────────────────────────────────────

// Mocks for all imported modules
const mockRenderPositionMarker = vi.fn();
const mockCenterOnSpot = vi.fn();
const mockRegisterMapClickHandler = vi.fn();
const mockInitMap = vi.fn();
const mockRenderSignPins = vi.fn();
const mockRenderSpotMarker = vi.fn();
const mockClearPositionMarker = vi.fn();
const mockClearSpotMarker = vi.fn();
const mockSetTowSignsVisible = vi.fn();
const mockInitRoadGeometry = vi.fn();
const mockRenderTowSegments = vi.fn();
const mockShowStreetPopup = vi.fn();

vi.mock("../../app/map", () => ({
  initMap: mockInitMap,
  registerMapClickHandler: mockRegisterMapClickHandler,
  renderPositionMarker: mockRenderPositionMarker,
  renderSignPins: mockRenderSignPins,
  renderTowSegments: mockRenderTowSegments,
  renderSpotMarker: mockRenderSpotMarker,
  clearPositionMarker: mockClearPositionMarker,
  clearSpotMarker: mockClearSpotMarker,
  centerOnSpot: mockCenterOnSpot,
  showStreetPopup: mockShowStreetPopup,
  initRoadGeometry: mockInitRoadGeometry,
  setTowSignsVisible: mockSetTowSignsVisible,
  clearViolationHighlights: vi.fn(),
  renderViolationHighlights: vi.fn(),
  setViolationHighlightsVisible: vi.fn(),
  renderUpcomingSignPins: vi.fn(),
  renderUpcomingTowSegments: vi.fn(),
  setUpcomingSignsVisible: vi.fn(),
}));

vi.mock("../../app/ui", () => ({
  showSpotToast: vi.fn(),
  renderLoading: vi.fn(),
  hideLoading: vi.fn(),
  renderBrowsingMode: vi.fn(),
  renderWarningBanner: vi.fn(),
  renderClearBanner: vi.fn(),
  TOAST_DURATION_MS: 4000,
}));

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

let mockAppState: AppState = {
  mode: "browsing",
  userLat: 40.744,
  userLng: -74.032,
  allSigns: [],
  activeSigns: [],
};
const mockAppGetState = vi.fn<[], AppState>(() => mockAppState);
const mockAppOnSaveSpot = vi.fn<[SavedSpot], void>();
const mockAppOnClearSpot = vi.fn<[], void>();
const mockAppSetUserPosition = vi.fn<[number, number], void>();
const mockAppTick = vi.fn<[Date], void>();
const mockAppOnHereNow = vi.fn<[], void>();

const mockCreateApp = vi.fn(
  (deps: { storage: unknown; renderState: (state: AppState) => void }) => {
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

vi.mock("../../app/geo", () => ({
  getStreetName: vi.fn().mockResolvedValue(null),
  geocodeCrossStreet: vi.fn().mockResolvedValue(null),
  seedGeocodeCache: vi.fn(),
}));

let mockFetchImpl: (() => Promise<Response>) | null = null;
global.fetch = vi.fn().mockImplementation(() => {
  if (mockFetchImpl) return mockFetchImpl();
  return Promise.reject(new Error("fetch not configured"));
});

// ─── DOM helpers ──────────────────────────────────────────────────────────────

interface MockButton {
  id: string;
  _disabled: boolean;
  _listeners: Record<string, Array<() => void>>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(event: string, fn: () => void): void;
  click(): void;
  querySelector<T>(sel: string): T | null;
}

function makeMockButton(id: string): MockButton {
  const btn: MockButton = {
    id,
    _disabled: false,
    _listeners: {},
    getAttribute(name: string) {
      if (name === "disabled") return this._disabled ? "" : null;
      return null;
    },
    setAttribute(name: string, _value: string) {
      if (name === "disabled") this._disabled = true;
    },
    removeAttribute(name: string) {
      if (name === "disabled") this._disabled = false;
    },
    addEventListener(event: string, fn: () => void) {
      if (!this._listeners[event]) this._listeners[event] = [];
      (this._listeners[event] as Array<() => void>).push(fn);
    },
    click() {
      (this._listeners["click"] ?? []).forEach((fn) => fn());
    },
    querySelector<T>(_sel: string): T | null {
      return null;
    },
  };
  return btn;
}

type DocumentElements = Record<string, unknown>;

function installDocumentMock(extraElements: DocumentElements = {}): {
  locateBtn: MockButton;
  elements: DocumentElements;
} {
  const locateBtn = makeMockButton("locate-btn");
  const elements: DocumentElements = {
    "locate-btn": locateBtn,
    "tow-legend": {
      classList: { contains: vi.fn(() => false), toggle: vi.fn() },
      querySelector: vi.fn(() => null),
    },
    "tow-toggle": {
      querySelector: vi.fn(() => null),
      addEventListener: vi.fn(),
      setAttribute: vi.fn(),
    },
    "clear-btn": makeMockButton("clear-btn"),
    "here-btn": makeMockButton("here-btn"),
    "banner": { style: { display: "none" }, textContent: "" },
    ...extraElements,
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
  return { locateBtn, elements };
}

function removeDocumentMock(): void {
  delete (globalThis as Record<string, unknown>)["document"];
  delete (globalThis as Record<string, unknown>)["localStorage"];
  delete (globalThis as Record<string, unknown>)["navigator"];
}

describe("F-27.3 locate button wiring in initBrowserApp", () => {
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
    mockCreateApp.mockImplementation(
      (deps: { storage: unknown; renderState: (state: AppState) => void }) => ({
        getState: mockAppGetState,
        onSaveSpot: mockAppOnSaveSpot,
        onClearSpot: mockAppOnClearSpot,
        setUserPosition: mockAppSetUserPosition,
        tick: mockAppTick,
        onHereNow: mockAppOnHereNow,
      })
    );
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

  it("GIVEN a DOM with #locate-btn and navigator.geolocation available, WHEN the button is clicked, THEN disabled is set on the button during the geolocation call", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    // Install navigator.geolocation that never calls back (simulates pending)
    const getCurrentPositionMock = vi.fn();
    (globalThis as Record<string, unknown>)["navigator"] = {
      geolocation: { getCurrentPosition: getCurrentPositionMock },
    };

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Click the button
    locateBtn.click();

    // disabled should have been set synchronously before geolocation resolves
    expect(locateBtn._disabled).toBe(true);
    expect(getCurrentPositionMock).toHaveBeenCalledOnce();
  });

  it("GIVEN geolocation succeeds, THEN renderPositionMarker is called with the returned coordinates", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    // Use a holder object to avoid TypeScript narrowing successCallback to never
    const holder: { success: ((pos: GeolocationPosition) => void) | null } = { success: null };
    const getCurrentPositionMock = vi.fn((success: (pos: GeolocationPosition) => void) => {
      holder.success = success;
    });
    (globalThis as Record<string, unknown>)["navigator"] = {
      geolocation: { getCurrentPosition: getCurrentPositionMock },
    };

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    locateBtn.click();

    // Simulate GPS success
    const cb = holder.success;
    if (cb !== null) {
      const fakePos = {
        coords: { latitude: 40.745, longitude: -74.031 },
      } as GeolocationPosition;
      cb(fakePos);
    }

    expect(mockRenderPositionMarker).toHaveBeenCalledWith(40.745, -74.031);
  });

  it("GIVEN geolocation succeeds, THEN centerOnSpot is called with lat and lng matching the returned coordinates", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    const holder: { success: ((pos: GeolocationPosition) => void) | null } = { success: null };
    const getCurrentPositionMock = vi.fn((success: (pos: GeolocationPosition) => void) => {
      holder.success = success;
    });
    (globalThis as Record<string, unknown>)["navigator"] = {
      geolocation: { getCurrentPosition: getCurrentPositionMock },
    };

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    locateBtn.click();

    const cb = holder.success;
    if (cb !== null) {
      const fakePos = {
        coords: { latitude: 40.745, longitude: -74.031 },
      } as GeolocationPosition;
      cb(fakePos);
    }

    expect(mockCenterOnSpot).toHaveBeenCalledOnce();
    const arg = mockCenterOnSpot.mock.calls[0]?.[0] as { lat: number; lng: number };
    expect(arg.lat).toBeCloseTo(40.745, 5);
    expect(arg.lng).toBeCloseTo(-74.031, 5);
  });

  it("GIVEN geolocation succeeds, THEN disabled is removed from the button", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    const holder: { success: ((pos: GeolocationPosition) => void) | null } = { success: null };
    const getCurrentPositionMock = vi.fn((success: (pos: GeolocationPosition) => void) => {
      holder.success = success;
    });
    (globalThis as Record<string, unknown>)["navigator"] = {
      geolocation: { getCurrentPosition: getCurrentPositionMock },
    };

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    locateBtn.click();
    // Button should be disabled while waiting
    expect(locateBtn._disabled).toBe(true);

    const cb = holder.success;
    if (cb !== null) {
      const fakePos = {
        coords: { latitude: 40.745, longitude: -74.031 },
      } as GeolocationPosition;
      cb(fakePos);
    }

    // After success, disabled should be removed
    expect(locateBtn._disabled).toBe(false);
  });

  it("GIVEN geolocation fails (error callback fires), THEN disabled is removed from the button", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    const errHolder: { error: ((err: GeolocationPositionError) => void) | null } = { error: null };
    const getCurrentPositionMock = vi.fn(
      (_success: (pos: GeolocationPosition) => void, error: (err: GeolocationPositionError) => void) => {
        errHolder.error = error;
      }
    );
    (globalThis as Record<string, unknown>)["navigator"] = {
      geolocation: { getCurrentPosition: getCurrentPositionMock },
    };

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    locateBtn.click();
    expect(locateBtn._disabled).toBe(true);

    const ecb = errHolder.error;
    if (ecb !== null) {
      const fakeErr = { code: 1, message: "User denied" } as GeolocationPositionError;
      ecb(fakeErr);
    }

    // After error, disabled should be removed
    expect(locateBtn._disabled).toBe(false);
  });

  it("GIVEN navigator.geolocation is not defined, WHEN the button is clicked, THEN no error is thrown", async () => {
    const signsPayload = { fetched_at: "2026-06-09T12:00:00Z", signs: [] };
    mockFetchImpl = () =>
      Promise.resolve({ ok: true, json: async () => signsPayload } as Response);

    // Import before installing document mock so the IIFE does not fire
    const { initBrowserApp } = await import("../../app/main");

    // navigator exists but has no geolocation property
    (globalThis as Record<string, unknown>)["navigator"] = {};

    const { locateBtn } = installDocumentMock();
    await initBrowserApp();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Should not throw
    expect(() => locateBtn.click()).not.toThrow();
  });
});
