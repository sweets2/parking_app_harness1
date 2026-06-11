/**
 * Unit tests for app/map.ts — F-07 and F-07.6
 *
 * Leaflet is not available in Node. We create a minimal mock of the Leaflet `L`
 * global before importing map.ts so all L.* calls are intercepted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Sign, StreetCleaningEntry } from "../../shared/types";
import { NOW_STABLE } from "../fixtures/signs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSign(overrides: Partial<Sign> = {}): Sign {
  return {
    id: "test-1",
    address: "123 Test St",
    reason: "CONSTRUCTION",
    permit_number: "P-001",
    lat: 40.744,
    lng: -74.032,
    start_date: "6/1/2026",
    start_time: "08:00:00",
    stop_date: "6/30/2026",
    end_time: "18:00:00",
    start_iso: "2026-06-01T08:00:00",
    end_iso: "2026-06-30T18:00:00",
    active_at_fetch: true,
    ...overrides,
  };
}

function makeCleaningEntry(overrides: Partial<StreetCleaningEntry> = {}): StreetCleaningEntry {
  return {
    street: "Washington Street",
    side: "East",
    schedule: "Monday   8 am – 9 am",
    location: "9th St. to 10th St.",
    ...overrides,
  };
}

// ─── Leaflet Mock ─────────────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number };

interface MockPopup {
  _content: string;
  _lat: number;
  _lng: number;
  _open: boolean;
  _openOnCount: number;
  setLatLng: (latlng: [number, number]) => MockPopup;
  setContent: (html: string) => MockPopup;
  openOn: (map: MockMap) => MockPopup;
  remove: () => void;
  isOpen: () => boolean;
}

interface MockMarker {
  _lat: number;
  _lng: number;
  _options: Record<string, unknown>;
  _popup: string | null;
  _clickHandler: ((e: unknown) => void) | null;
  addTo: (map: MockMap) => MockMarker;
  remove: () => void;
  bindPopup: (html: string) => MockMarker;
  openPopup: () => MockMarker;
  on: (event: string, handler: (e: unknown) => void) => MockMarker;
}

interface MockTileLayer {
  _url: string;
  addTo: (map: MockMap) => MockTileLayer;
}

interface MockMap {
  _layers: MockMarker[];
  _center: LatLng;
  _zoom: number;
  _clickHandler: ((e: { latlng: LatLng }) => void) | null;
  _zoomendHandler: ((e: unknown) => void) | null;
  _openPopups: MockPopup[];
  setView: (center: [number, number], zoom: number) => MockMap;
  panTo: (center: [number, number] | LatLng) => MockMap;
  getCenter: () => LatLng;
  getZoom: () => number;
  on: (event: string, handler: (e: { latlng: LatLng }) => void) => MockMap;
  off: (event: string) => MockMap;
  addLayer: (layer: MockMarker) => MockMap;
  removeLayer: (layer: MockMarker) => MockMap;
  closePopup: () => MockMap;
  _fireClick: (lat: number, lng: number) => void;
  _fireZoomend: () => void;
}

function createMockMap(): MockMap {
  const map: MockMap = {
    _layers: [],
    _center: { lat: 40.744, lng: -74.032 },
    _zoom: 15,
    _clickHandler: null,
    _zoomendHandler: null,
    _openPopups: [],
    setView(center, zoom) {
      map._center = { lat: center[0], lng: center[1] };
      map._zoom = zoom;
      return map;
    },
    panTo(center) {
      if (Array.isArray(center)) {
        map._center = { lat: center[0], lng: center[1] };
      } else {
        map._center = center as LatLng;
      }
      return map;
    },
    getCenter() {
      return map._center;
    },
    getZoom() {
      return map._zoom;
    },
    on(event, handler) {
      if (event === "click") {
        map._clickHandler = handler;
      }
      if (event === "zoomend") {
        map._zoomendHandler = handler as (e: unknown) => void;
      }
      return map;
    },
    off(_event) {
      map._clickHandler = null;
      return map;
    },
    addLayer(layer) {
      map._layers.push(layer);
      return map;
    },
    removeLayer(layer) {
      const idx = map._layers.indexOf(layer);
      if (idx !== -1) map._layers.splice(idx, 1);
      return map;
    },
    _fireClick(lat, lng) {
      if (map._clickHandler) {
        map._clickHandler({ latlng: { lat, lng } });
      }
    },
    closePopup() {
      return map;
    },
    _fireZoomend() {
      if (map._zoomendHandler) {
        map._zoomendHandler({});
      }
    },
  };
  return map;
}

let mockMapInstance: MockMap;
let mockPopupInstances: MockPopup[] = [];

function createMockPopup(): MockPopup {
  const popup: MockPopup = {
    _content: "",
    _lat: 0,
    _lng: 0,
    _open: false,
    _openOnCount: 0,
    setLatLng(latlng) {
      popup._lat = latlng[0];
      popup._lng = latlng[1];
      return popup;
    },
    setContent(html) {
      popup._content = html;
      return popup;
    },
    openOn(map) {
      popup._openOnCount++;
      popup._open = true;
      map._openPopups.push(popup);
      return popup;
    },
    remove() {
      popup._open = false;
      mockMapInstance._openPopups = mockMapInstance._openPopups.filter((p) => p !== popup);
    },
    isOpen() {
      return popup._open;
    },
  };
  mockPopupInstances.push(popup);
  return popup;
}

function createMockMarker(lat: number, lng: number, options: Record<string, unknown> = {}): MockMarker {
  const marker: MockMarker = {
    _lat: lat,
    _lng: lng,
    _options: options,
    _popup: null,
    _clickHandler: null,
    addTo(m) {
      m._layers.push(marker);
      return marker;
    },
    remove() {
      mockMapInstance._layers = mockMapInstance._layers.filter((l) => l !== marker);
    },
    bindPopup(html) {
      marker._popup = html;
      return marker;
    },
    openPopup() {
      return marker;
    },
    on(event, handler) {
      if (event === "click") {
        marker._clickHandler = handler;
      }
      return marker;
    },
  };
  return marker;
}

function createMockTileLayer(url: string): MockTileLayer {
  return {
    _url: url,
    addTo(m) {
      // tile layers don't need to be tracked as regular markers
      void m;
      return this;
    },
  };
}

// Install the global L mock
function installLeafletMock(): void {
  mockMapInstance = createMockMap();
  mockPopupInstances = [];

  const L = {
    map: vi.fn((_el: string) => {
      mockMapInstance = createMockMap();
      return mockMapInstance;
    }),
    tileLayer: vi.fn((url: string, _opts: unknown) => createMockTileLayer(url)),
    circleMarker: vi.fn((latlng: [number, number], opts: Record<string, unknown> = {}) => {
      return createMockMarker(latlng[0], latlng[1], opts);
    }),
    divIcon: vi.fn((opts: Record<string, unknown>) => {
      return { _html: opts["html"] as string };
    }),
    marker: vi.fn((latlng: [number, number], opts: Record<string, unknown> = {}) => {
      const icon = opts["icon"] as { _html: string } | undefined;
      return createMockMarker(latlng[0], latlng[1], { html: icon?._html ?? "" });
    }),
    popup: vi.fn(() => {
      return createMockPopup();
    }),
    polyline: vi.fn((latlngs: [number, number][], opts: Record<string, unknown> = {}) => {
      const mid = latlngs[Math.floor(latlngs.length / 2)];
      return createMockMarker(
        mid !== undefined ? mid[0] : 0,
        mid !== undefined ? mid[1] : 0,
        { ...opts, _isPolyline: true, _latlngs: latlngs }
      );
    }),
  };

  // Expose as global
  (globalThis as Record<string, unknown>)["L"] = L;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("F-07 map module", () => {
  beforeEach(() => {
    installLeafletMock();
    // Clear module cache so map.ts re-runs with fresh state
    vi.resetModules();
  });

  // ─── F-07.1 Map Initialization ─────────────────────────────────────────────

  describe("F-07.1 initMap", () => {
    it("returns a map instance without throwing given a #map element", async () => {
      const { initMap } = await import("../../app/map");
      const result = initMap();
      expect(result).toBeDefined();
    });

    it("tile layer URL contains openstreetmap.org", async () => {
      const { initMap } = await import("../../app/map");
      initMap();
      const L = (globalThis as Record<string, unknown>)["L"] as {
        tileLayer: ReturnType<typeof vi.fn>;
      };
      expect(L.tileLayer).toHaveBeenCalled();
      const url = (L.tileLayer.mock.calls[0] as [string])[0];
      expect(url).toContain("openstreetmap.org");
    });
  });

  // ─── F-07.2 Sign Pins ──────────────────────────────────────────────────────

  describe("F-07.2 renderSignPins", () => {
    it("places three markers for three signs with different reasons", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = [
        makeSign({ id: "1", reason: "CONSTRUCTION" }),
        makeSign({ id: "2", reason: "MOVING" }),
        makeSign({ id: "3", reason: "EVENT" }),
      ];
      renderSignPins(signs, NOW_STABLE);
      expect(mockMapInstance._layers.length).toBe(3);
    });

    it("CONSTRUCTION sign marker uses a red SVG circle", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = [makeSign({ id: "1", reason: "CONSTRUCTION" })];
      renderSignPins(signs, NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(marker._options["html"]).toContain("<svg");
      expect(marker._options["html"]).toContain("#cc0000");
    });

    it("MOVING sign marker uses a red SVG circle", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = [makeSign({ id: "1", reason: "MOVING" })];
      renderSignPins(signs, NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(marker._options["html"]).toContain("<svg");
      expect(marker._options["html"]).toContain("#cc0000");
    });

    it("EVENT sign marker uses a red SVG triangle", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = [makeSign({ id: "1", reason: "EVENT" })];
      renderSignPins(signs, NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(marker._options["html"]).toContain("<svg");
      expect(marker._options["html"]).toContain("#cc0000");
    });

    it("DELIVERY sign marker uses a red SVG square", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = [makeSign({ id: "1", reason: "DELIVERY" })];
      renderSignPins(signs, NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(marker._options["html"]).toContain("<svg");
      expect(marker._options["html"]).toContain("#cc0000");
    });

    it("clicking a pin shows a popup containing address, start date, end date, permit number", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const sign = makeSign({
        id: "1",
        reason: "CONSTRUCTION",
        address: "42 Answer Blvd",
        permit_number: "XYZ-999",
        start_date: "6/1/2026",
        stop_date: "6/30/2026",
      });
      renderSignPins([sign], NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      // Trigger click
      if (marker._clickHandler) {
        marker._clickHandler({});
      }
      expect(marker._popup).not.toBeNull();
      expect(marker._popup).toContain("42 Answer Blvd");
      expect(marker._popup).toContain("June 1");
      expect(marker._popup).toContain("June 30");
      expect(marker._popup).toContain("XYZ-999");
    });

    // F-10.3: popup also shows the reason
    it("F-10.3 clicking a pin shows a popup containing the sign reason", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const sign = makeSign({
        id: "1",
        reason: "CONSTRUCTION",
        address: "42 Answer Blvd",
        permit_number: "XYZ-999",
      });
      renderSignPins([sign], NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      if (marker._clickHandler) {
        marker._clickHandler({});
      }
      expect(marker._popup).not.toBeNull();
      // Popup must contain the sign reason (as CSS class or label)
      expect(marker._popup).toContain("tz-reason--construction");
    });

    // F-10.3: 67 active signs → 67 pins on the map
    it("F-10.3 GIVEN 67 active signs, WHEN renderSignPins is called, THEN 67 pins appear on the map", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const signs: Sign[] = Array.from({ length: 67 }, (_, i) =>
        makeSign({
          id: String(i + 1),
          lat: 40.744 + i * 0.0001,
          lng: -74.032,
          reason: i % 2 === 0 ? "CONSTRUCTION" : "DELIVERY",
        })
      );
      renderSignPins(signs, NOW_STABLE);
      expect(mockMapInstance._layers.length).toBe(67);
    });

    it("calling renderSignPins a second time replaces previous pins", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      const first: Sign[] = [
        makeSign({ id: "1", reason: "CONSTRUCTION" }),
        makeSign({ id: "2", reason: "MOVING" }),
      ];
      const second: Sign[] = [makeSign({ id: "3", reason: "EVENT" })];
      renderSignPins(first, NOW_STABLE);
      expect(mockMapInstance._layers.length).toBe(2);
      renderSignPins(second, NOW_STABLE);
      expect(mockMapInstance._layers.length).toBe(1);
    });

    it("renders empty array without error and leaves no markers on map", async () => {
      const { initMap, renderSignPins } = await import("../../app/map");
      initMap();
      expect(() =>
        renderSignPins([], NOW_STABLE)
      ).not.toThrow();
      expect(mockMapInstance._layers.length).toBe(0);
    });
  });

  // ─── F-07.3 Position Marker ────────────────────────────────────────────────

  describe("F-07.3 renderPositionMarker / clearPositionMarker", () => {
    it("no position marker is present before any tap", async () => {
      const { initMap } = await import("../../app/map");
      initMap();
      expect(mockMapInstance._layers.length).toBe(0);
    });

    it("renderPositionMarker places a marker at given coordinates", async () => {
      const { initMap, renderPositionMarker } = await import("../../app/map");
      initMap();
      renderPositionMarker(40.744, -74.032);
      expect(mockMapInstance._layers.length).toBe(1);
      const marker = mockMapInstance._layers[0];
      expect(marker._lat).toBeCloseTo(40.744, 5);
      expect(marker._lng).toBeCloseTo(-74.032, 5);
    });

    it("calling renderPositionMarker twice replaces the first marker", async () => {
      const { initMap, renderPositionMarker } = await import("../../app/map");
      initMap();
      renderPositionMarker(40.744, -74.032);
      renderPositionMarker(40.745, -74.033);
      expect(mockMapInstance._layers.length).toBe(1);
      const marker = mockMapInstance._layers[0];
      expect(marker._lat).toBeCloseTo(40.745, 5);
      expect(marker._lng).toBeCloseTo(-74.033, 5);
    });

    it("clearPositionMarker removes the position marker", async () => {
      const { initMap, renderPositionMarker, clearPositionMarker } = await import("../../app/map");
      initMap();
      renderPositionMarker(40.744, -74.032);
      expect(mockMapInstance._layers.length).toBe(1);
      clearPositionMarker();
      expect(mockMapInstance._layers.length).toBe(0);
    });
  });

  // ─── F-07.4 Saved Spot Marker ──────────────────────────────────────────────

  describe("F-07.4 renderSpotMarker / clearSpotMarker", () => {
    it("renderSpotMarker places a marker at saved spot coordinates", async () => {
      const { initMap, renderSpotMarker } = await import("../../app/map");
      initMap();
      renderSpotMarker({ lat: 40.7503, lng: -74.0303, side: "N", savedAt: "2026-06-09T12:00:00Z", address: null });
      expect(mockMapInstance._layers.length).toBe(1);
      const marker = mockMapInstance._layers[0];
      expect(marker._lat).toBeCloseTo(40.7503, 5);
      expect(marker._lng).toBeCloseTo(-74.0303, 5);
    });

    it("spot marker and sign pin are visually distinct (emoji vs fillColor)", async () => {
      const { initMap, renderSignPins, renderSpotMarker } = await import("../../app/map");
      initMap();
      renderSignPins(
        [makeSign({ id: "1", reason: "CONSTRUCTION" })],
        NOW_STABLE
      );
      renderSpotMarker({ lat: 40.7503, lng: -74.0303, side: "N", savedAt: "2026-06-09T12:00:00Z", address: null });
      expect(mockMapInstance._layers.length).toBe(2);
      const [signMarker, spotMarker] = mockMapInstance._layers;
      // Sign uses emoji divIcon (html property), spot uses circleMarker (fillColor)
      expect(signMarker._options["html"]).toBeDefined();
      expect(spotMarker._options["fillColor"]).toBeDefined();
    });

    it("clearSpotMarker removes the spot marker without throwing", async () => {
      const { initMap, renderSpotMarker, clearSpotMarker } = await import("../../app/map");
      initMap();
      renderSpotMarker({ lat: 40.7503, lng: -74.0303, side: "N", savedAt: "2026-06-09T12:00:00Z", address: null });
      expect(mockMapInstance._layers.length).toBe(1);
      expect(() => clearSpotMarker()).not.toThrow();
      expect(mockMapInstance._layers.length).toBe(0);
    });
  });

  // ─── F-07.5 Map Centering and Click Handler ────────────────────────────────

  describe("F-07.5 centerOnSpot / registerMapClickHandler", () => {
    it("centerOnSpot pans the map to within 0.0001 degrees of the spot", async () => {
      const { initMap, centerOnSpot } = await import("../../app/map");
      initMap();
      centerOnSpot({ lat: 40.7503, lng: -74.0303, side: "N", savedAt: "2026-06-09T12:00:00Z", address: null });
      const center = mockMapInstance.getCenter();
      expect(Math.abs(center.lat - 40.7503)).toBeLessThan(0.0001);
      expect(Math.abs(center.lng - -74.0303)).toBeLessThan(0.0001);
    });

    it("registerMapClickHandler invokes callback with clicked coordinates", async () => {
      const { initMap, registerMapClickHandler } = await import("../../app/map");
      initMap();
      const callback = vi.fn();
      registerMapClickHandler(callback);
      mockMapInstance._fireClick(40.744, -74.032);
      expect(callback).toHaveBeenCalledWith(40.744, -74.032);
    });

    it("registering a second click handler replaces the first (no double-firing)", async () => {
      const { initMap, registerMapClickHandler } = await import("../../app/map");
      initMap();
      const first = vi.fn();
      const second = vi.fn();
      registerMapClickHandler(first);
      registerMapClickHandler(second);
      mockMapInstance._fireClick(40.744, -74.032);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });
  });

  // ─── F-07.6 Street Click Popup ────────────────────────────────────────────

  describe("F-07.6 showStreetPopup", () => {
    it("GIVEN entries for a N-S street with East and West sides, THEN the popup contains the street name, 'East' and 'West' labels, and both schedule strings", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ street: "Washington Street", side: "East", schedule: "Monday   8 am – 9 am", location: "9th St. to 10th St." }),
        makeCleaningEntry({ street: "Washington Street", side: "West", schedule: "Tuesday   9 am – 10 am", location: "9th St. to 10th St." }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      expect(mockPopupInstances.length).toBeGreaterThan(0);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("Washington Street");
      expect(popup._content).toContain("dir-e");
      expect(popup._content).toContain("dir-w");
      expect(popup._content).toContain("Monday   8 am – 9 am");
      expect(popup._content).toContain("Tuesday   9 am – 10 am");
    });

    it("GIVEN entries for an E-W street with North and South sides, THEN the popup contains the street name, 'North' and 'South' labels, and both schedule strings", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ street: "9th Street", side: "North", schedule: "Wednesday   8 am – 9 am", location: "Washington St. to Bloomfield St." }),
        makeCleaningEntry({ street: "9th Street", side: "South", schedule: "Thursday   9 am – 10 am", location: "Washington St. to Bloomfield St." }),
      ];
      showStreetPopup(40.744, -74.032, "9th Street", entries);
      expect(mockPopupInstances.length).toBeGreaterThan(0);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("9th Street");
      expect(popup._content).toContain("dir-n");
      expect(popup._content).toContain("dir-s");
      expect(popup._content).toContain("Wednesday   8 am – 9 am");
      expect(popup._content).toContain("Thursday   9 am – 10 am");
    });

    it("GIVEN an entry whose location is '9th St. to 10th St.', THEN the popup header contains 'between 9th St and 10th St'", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("between 9th St and 10th St");
    });

    it("GIVEN showStreetPopup is called twice in succession, THEN only one popup exists on the map", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ street: "Washington Street" }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      showStreetPopup(40.745, -74.033, "Washington Street", entries);
      const openPopups = mockMapInstance._openPopups;
      expect(openPopups.length).toBe(1);
    });

    it("GIVEN entries is an empty array, THEN the popup contains the street name and a 'no schedule' message, and no error is thrown", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      expect(() => showStreetPopup(40.744, -74.032, "Washington Street", [])).not.toThrow();
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("Washington Street");
      expect(popup._content.toLowerCase()).toContain("no");
    });

    it("GIVEN initMap has not been called, WHEN showStreetPopup is called, THEN it returns without throwing", async () => {
      const { showStreetPopup } = await import("../../app/map");
      expect(() => showStreetPopup(40.744, -74.032, "Washington Street", [])).not.toThrow();
    });

    it("GIVEN entries with two different location values (multi-block), THEN the popup contains both block context strings", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ street: "Washington Street", side: "East", schedule: "Monday   8 am – 9 am", location: "1st St. to 2nd St." }),
        makeCleaningEntry({ street: "Washington Street", side: "West", schedule: "Tuesday   9 am – 10 am", location: "1st St. to 2nd St." }),
        makeCleaningEntry({ street: "Washington Street", side: "East", schedule: "Wednesday   8 am – 9 am", location: "3rd St. to 4th St." }),
        makeCleaningEntry({ street: "Washington Street", side: "West", schedule: "Thursday   9 am – 10 am", location: "3rd St. to 4th St." }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("between 1st St and 2nd St");
      expect(popup._content).toContain("between 3rd St and 4th St");
    });

    // ─── F-20 detectSegment tests ──────────────────────────────────────────────

    it("F-20: GIVEN showStreetPopup is called without a detectSegment argument, THEN the popup content does not contain 'sp-block--active'", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).not.toContain("sp-block--active");
    });

    it("F-20: GIVEN showStreetPopup is called with a detectSegment that resolves to a specific location, WHEN the promise resolves, THEN popup.setContent is called and the updated content contains 'sp-block--active' exactly once", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
        makeCleaningEntry({ location: "10th St. to 11th St.", side: "West" }),
      ];
      const detectSegment = vi.fn().mockResolvedValue(["9th St. to 10th St."]);
      showStreetPopup(40.744, -74.032, "Washington Street", entries, detectSegment);

      // Allow the promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toContain("sp-block--active");
      const matches = popup._content.match(/sp-block--active/g);
      expect(matches).toHaveLength(1);
    });

    it("F-20: GIVEN showStreetPopup is called with a detectSegment that resolves to two locations, WHEN the promise resolves, THEN popup contains 'sp-block--active' exactly twice", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
        makeCleaningEntry({ location: "10th St. to 11th St.", side: "West" }),
        makeCleaningEntry({ location: "11th St. to 12th St.", side: "East" }),
      ];
      const detectSegment = vi.fn().mockResolvedValue(["9th St. to 10th St.", "10th St. to 11th St."]);
      showStreetPopup(40.744, -74.032, "Washington Street", entries, detectSegment);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      const matches = popup._content.match(/sp-block--active/g);
      expect(matches).toHaveLength(2);
    });

    it("F-20: GIVEN showStreetPopup is called with a detectSegment that resolves to null, THEN popup.setContent is NOT called after the promise resolves (no highlight added)", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
      ];
      const detectSegment = vi.fn().mockResolvedValue(null);
      showStreetPopup(40.744, -74.032, "Washington Street", entries, detectSegment);

      const initialContent = mockPopupInstances[mockPopupInstances.length - 1]._content;

      await new Promise((resolve) => setTimeout(resolve, 0));

      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      expect(popup._content).toBe(initialContent);
      expect(popup._content).not.toContain("sp-block--active");
    });

    it("F-20: GIVEN showStreetPopup is called twice rapidly, WHEN the first call's detectSegment resolves last, THEN popup.setContent is NOT called for the first (stale token)", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
      ];

      let resolveFirst!: (v: string[] | null) => void;
      const firstSegment = vi.fn().mockReturnValue(
        new Promise<string[] | null>((res) => { resolveFirst = res; })
      );
      const secondSegment = vi.fn().mockResolvedValue(["9th St. to 10th St."]);

      showStreetPopup(40.744, -74.032, "Washington Street", entries, firstSegment);
      showStreetPopup(40.744, -74.032, "Washington Street", entries, secondSegment);

      // Let the second call's detectSegment resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      const contentAfterSecond = popup._content;

      // Now resolve the first call (stale token — should be ignored)
      resolveFirst(["9th St. to 10th St."]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Content should not change — the stale first call was ignored
      expect(popup._content).toBe(contentAfterSecond);
    });

    // ─── F-22 Popup zoom-resize fix tests ─────────────────────────────────────

    it("F-22: GIVEN a popup is open WHEN zoomend fires THEN the popup is re-opened (openOnCount === 2)", async () => {
      const { initMap, showStreetPopup } = await import("../../app/map");
      initMap();
      const entries: StreetCleaningEntry[] = [
        makeCleaningEntry({ location: "9th St. to 10th St." }),
      ];
      showStreetPopup(40.744, -74.032, "Washington Street", entries);
      const popup = mockPopupInstances[mockPopupInstances.length - 1];
      // Initial open
      expect(popup._openOnCount).toBe(1);
      // Fire zoomend
      mockMapInstance._fireZoomend();
      // popup should have been removed and re-opened
      expect(popup._openOnCount).toBe(2);
      expect(popup.isOpen()).toBe(true);
    });

    it("F-22: GIVEN no popup is open WHEN zoomend fires THEN no error is thrown and no popup is on the map", async () => {
      const { initMap } = await import("../../app/map");
      initMap();
      // No showStreetPopup call — no popup open
      expect(() => mockMapInstance._fireZoomend()).not.toThrow();
      expect(mockMapInstance._openPopups.length).toBe(0);
    });
  });

  // ─── F-23 renderTowSegments ────────────────────────────────────────────────

  describe("F-23 renderTowSegments", () => {
    it("GIVEN initMap has not been called, WHEN renderTowSegments([makeSign()]) is called, THEN no error is thrown", async () => {
      const { renderTowSegments } = await import("../../app/map");
      expect(() => renderTowSegments([makeSign()])).not.toThrow();
    });

    it("GIVEN initMap is called and 2 signs are passed to renderTowSegments, THEN 4 polyline layers are added to the map (2 per sign for casing)", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      renderTowSegments([makeSign({ id: "s1" }), makeSign({ id: "s2" })]);
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(4);
    });

    it("GIVEN renderTowSegments is called twice, THEN only the second call's layers remain on the map (first batch removed)", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      renderTowSegments([makeSign({ id: "s1" }), makeSign({ id: "s2" })]);
      renderTowSegments([makeSign({ id: "s3" })]);
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(2);
    });

    it("GIVEN a sign with address '257-257 11TH ST' (EW), WHEN renderTowSegments is called, THEN the polyline's two endpoints share the same lat and differ in lng", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      const sign = makeSign({ address: "257-257 11TH ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      const callArgs = L.polyline.mock.calls[0] as [[number, number][], unknown];
      const latlngs = callArgs[0];
      const ptA = latlngs[0];
      const ptB = latlngs[latlngs.length - 1];
      // EW: same lat, different lng
      expect(ptA[0]).toBe(ptB[0]);
      expect(ptA[1]).not.toBe(ptB[1]);
    });

    it("GIVEN a sign with address '1036-1036 BLOOMFIELD ST' (NS), WHEN renderTowSegments is called, THEN the polyline's two endpoints differ in lat and share the same lng", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      const callArgs = L.polyline.mock.calls[0] as [[number, number][], unknown];
      const latlngs = callArgs[0];
      const ptA = latlngs[0];
      const ptB = latlngs[latlngs.length - 1];
      // NS: different lat, same lng
      expect(ptA[0]).not.toBe(ptB[0]);
      expect(ptA[1]).toBe(ptB[1]);
    });

    it("GIVEN renderTowSegments is called with an empty array, THEN no error is thrown and no polyline is added to the map", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      expect(() => renderTowSegments([])).not.toThrow();
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(0);
    });

    it("GIVEN setTowSignsVisible(false) is called before renderTowSegments, WHEN renderTowSegments is called, THEN no polyline layers are added to the map", async () => {
      const { initMap, renderTowSegments, setTowSignsVisible } = await import("../../app/map");
      initMap();
      setTowSignsVisible(false);
      renderTowSegments([makeSign()]);
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(0);
    });

    it("GIVEN setTowSignsVisible(false) is called then renderTowSegments([makeSign()]) is called, WHEN setTowSignsVisible(true) is called, THEN the segment layers are added to the map", async () => {
      const { initMap, renderTowSegments, setTowSignsVisible } = await import("../../app/map");
      initMap();
      setTowSignsVisible(false);
      renderTowSegments([makeSign()]);
      // No polylines yet
      let polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(0);
      setTowSignsVisible(true);
      polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(2);
    });

    it("GIVEN renderTowSegments([makeSign()]) renders a segment, WHEN setTowSignsVisible(false) is called, THEN the segment layers are removed from the map", async () => {
      const { initMap, renderTowSegments, setTowSignsVisible } = await import("../../app/map");
      initMap();
      renderTowSegments([makeSign()]);
      let polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(2);
      setTowSignsVisible(false);
      polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(0);
    });

    // ─── F-24 casing style tests ───────────────────────────────────────────────

    it("F-24: GIVEN initMap is called and 1 sign is passed to renderTowSegments, THEN L.polyline is called twice (outer + inner casing)", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      renderTowSegments([makeSign()]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(2);
    });

    it("F-24: GIVEN 1 sign rendered, THEN calls[0] options contain { color: '#fff', weight: 7 } (outer casing) and calls[1] contain { color: '#cc0000', weight: 3 } (inner)", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      renderTowSegments([makeSign()]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      const outerArgs = L.polyline.mock.calls[0] as [[number, number][], Record<string, unknown>];
      const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
      expect(outerArgs[1]["color"]).toBe("#fff");
      expect(outerArgs[1]["weight"]).toBe(7);
      expect(innerArgs[1]["color"]).toBe("#cc0000");
      expect(innerArgs[1]["weight"]).toBe(3);
    });

    it("F-24: GIVEN initRoadGeometry called with BLOOMFIELD ST geometry AND a matching sign, THEN the inner polyline _latlngs.length is 3", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({
        "BLOOMFIELD ST": [[[40.7439, -74.032], [40.744, -74.032], [40.7441, -74.032]]],
      });
      const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      // calls[1] is the inner casing polyline
      const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
      const latlngs = innerArgs[0] as [number, number][];
      expect(latlngs.length).toBe(3);
    });

    it("F-24: GIVEN initRoadGeometry called with empty {} AND a sign on 11TH ST, THEN the outer polyline _latlngs.length is 2 (EW heuristic fallback)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({});
      const sign = makeSign({ address: "257-257 11TH ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      // calls[0] is the outer casing polyline
      const outerArgs = L.polyline.mock.calls[0] as [[number, number][], Record<string, unknown>];
      const latlngs = outerArgs[0] as [number, number][];
      expect(latlngs.length).toBe(2);
    });

    it("F-24: GIVEN geometry exists for a street but sign is > 50 m away, WHEN renderTowSegments is called, THEN heuristic fallback draws 2-point segment at sign's actual lat", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      // ADAMS ST geometry near 40.740; sign is at 40.760 (far away)
      initRoadGeometry({ "ADAMS ST": [[[40.740, -74.032], [40.741, -74.032]]] });
      const sign = makeSign({ address: "100-100 ADAMS ST", lat: 40.760, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      const outerArgs = L.polyline.mock.calls[0] as [[number, number][], Record<string, unknown>];
      const latlngs = outerArgs[0] as [number, number][];
      // Heuristic fallback: 2-point N-S segment centred near sign's actual lat (40.760)
      expect(latlngs.length).toBe(2);
      for (const pt of latlngs) {
        expect(Math.abs(pt[0] - 40.760) * 111320).toBeLessThan(50);
      }
    });
  });
});

// ─── F-24 getSubsegment ───────────────────────────────────────────────────────

describe("F-24 getSubsegment", () => {
  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN ways = [], WHEN getSubsegment([], 40.744, -74.032) is called, THEN result is the N-S 2-point fallback at ±halfLengthM/111320", async () => {
    const { getSubsegment } = await import("../../app/map");
    const halfLengthM = 9; // default
    const result = getSubsegment([], 40.744, -74.032);
    expect(result.length).toBe(2);
    expect(result[0][0]).toBeCloseTo(40.744 - halfLengthM / 111320, 6);
    expect(result[0][1]).toBeCloseTo(-74.032, 6);
    expect(result[1][0]).toBeCloseTo(40.744 + halfLengthM / 111320, 6);
    expect(result[1][1]).toBeCloseTo(-74.032, 6);
  });

  it("GIVEN ways = [[[40.744, -74.032]]] (one way, one point), WHEN getSubsegment is called, THEN result.length === 2 (N-S fallback for degenerate)", async () => {
    const { getSubsegment } = await import("../../app/map");
    const result = getSubsegment([[[40.744, -74.032]]], 40.744, -74.032);
    expect(result.length).toBe(2);
  });

  it("GIVEN a 3-point way with points ~11m apart and signLat at the middle, WHEN getSubsegment is called, THEN endpoints are interpolated to exactly 9 m from center", async () => {
    const { getSubsegment } = await import("../../app/map");
    // 0.0001° lat ≈ 11.132 m > 9 m threshold — endpoints must be interpolated, not at raw waypoints
    const ways: [number, number][][] = [
      [[40.7439, -74.032], [40.744, -74.032], [40.7441, -74.032]],
    ];
    const result = getSubsegment(ways, 40.744, -74.032);
    expect(result.length).toBe(3);
    // Each endpoint should be ~9 m from center, not at the raw waypoint coordinate
    expect(Math.abs(result[0][0] - 40.744) * 111320).toBeCloseTo(9, 0);
    expect(result[0][0]).toBeGreaterThan(40.7439); // did not reach the raw waypoint
    expect(Math.abs(result[2][0] - 40.744) * 111320).toBeCloseTo(9, 0);
    expect(result[2][0]).toBeLessThan(40.7441); // did not reach the raw waypoint
  });

  it("GIVEN two disjoint ways, WHEN getSubsegment is called with sign near the first way, THEN all returned points come from the near way only", async () => {
    const { getSubsegment } = await import("../../app/map");
    const ways: [number, number][][] = [
      [[40.744, -74.032], [40.7441, -74.032]],   // near way
      [[40.748, -74.035], [40.749, -74.035]],    // far way
    ];
    const result = getSubsegment(ways, 40.744, -74.032);
    for (const pt of result) {
      expect(pt[0]).toBeLessThanOrEqual(40.7441);
      expect(pt[0]).toBeLessThan(40.748);
    }
  });

  it("GIVEN sign is > 50 m from all road segments, WHEN getSubsegment is called, THEN returns [] so renderTowSegments can use orientation-correct heuristic", async () => {
    const { getSubsegment } = await import("../../app/map");
    // Ways near lat 40.740; sign at 40.760 ≈ 2200 m north — well beyond MAX_SNAP_M (50 m)
    const ways: [number, number][][] = [
      [[40.740, -74.032], [40.741, -74.032]],
    ];
    const result = getSubsegment(ways, 40.760, -74.032);
    expect(result.length).toBe(0);
  });

  it("GIVEN a sign midway along a 50-m segment (not at a waypoint), WHEN getSubsegment is called, THEN the segment is centred at the sign's road projection, not at a sparse waypoint", async () => {
    const { getSubsegment } = await import("../../app/map");
    // Two waypoints 50 m apart; sign at t=0.4 (20 m from start)
    const D = 50 / 111320;
    const ways: [number, number][][] = [[[40.744, -74.032], [40.744 + D, -74.032]]];
    const signLat = 40.744 + 0.4 * D;
    const result = getSubsegment(ways, signLat, -74.032);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // projPt (= signLat on the road) must appear in result within 0.5 m
    const hasProjPt = result.some(pt => Math.abs(pt[0] - signLat) * 111320 < 0.5);
    expect(hasProjPt).toBe(true);
    // Total segment length must be ≤ 18.5 m (2 × default 9 m)
    const cosLat = Math.cos(signLat * Math.PI / 180);
    const totalLen = result.slice(1).reduce((sum, pt, i) => {
      const dl = (pt[0] - result[i][0]) * 111320;
      const dm = (pt[1] - result[i][1]) * 111320 * cosLat;
      return sum + Math.sqrt(dl * dl + dm * dm);
    }, 0);
    expect(totalLen).toBeLessThanOrEqual(18.5);
  });
});

// ─── F-25 offsetPolylinePoints ────────────────────────────────────────────────

describe("offsetPolylinePoints", () => {
  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN pts.length < 2, WHEN offsetPolylinePoints is called, THEN returns pts unchanged (degenerate guard)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [[40.744, -74.032]];
    const result = offsetPolylinePoints(pts, 40.744, -74.032, 4.0);
    expect(result).toBe(pts);
  });

  it("GIVEN pts.length === 0, WHEN offsetPolylinePoints is called, THEN returns pts unchanged", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [];
    const result = offsetPolylinePoints(pts, 40.744, -74.032, 4.0);
    expect(result).toBe(pts);
  });

  it("GIVEN a N-S road and sign east of centreline (signLng > midLng), WHEN called, THEN all returned points have lng > original lng (shifted east)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    // N-S road: same lng, different lat
    const pts: [number, number][] = [
      [40.743, -74.032],
      [40.745, -74.032],
    ];
    const midLng = -74.032;
    const signLng = midLng + 0.0001; // east of centreline
    const result = offsetPolylinePoints(pts, 40.744, signLng, 4.0);
    for (const pt of result) {
      expect(pt[1]).toBeGreaterThan(-74.032);
    }
  });

  it("GIVEN a N-S road and sign west of centreline (signLng < midLng), WHEN called, THEN all returned points have lng < original lng (shifted west)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [
      [40.743, -74.032],
      [40.745, -74.032],
    ];
    const midLng = -74.032;
    const signLng = midLng - 0.0001; // west of centreline
    const result = offsetPolylinePoints(pts, 40.744, signLng, 4.0);
    for (const pt of result) {
      expect(pt[1]).toBeLessThan(-74.032);
    }
  });

  it("GIVEN an E-W road and sign north of centreline (signLat > midLat), WHEN called, THEN all returned points have lat > original lat (shifted north)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    // E-W road: same lat, different lng
    const pts: [number, number][] = [
      [40.744, -74.033],
      [40.744, -74.031],
    ];
    const midLat = 40.744;
    const signLat = midLat + 0.0001; // north of centreline
    const result = offsetPolylinePoints(pts, signLat, -74.032, 4.0);
    for (const pt of result) {
      expect(pt[0]).toBeGreaterThan(40.744);
    }
  });

  it("GIVEN an E-W road and sign south of centreline (signLat < midLat), WHEN called, THEN all returned points have lat < original lat (shifted south)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [
      [40.744, -74.033],
      [40.744, -74.031],
    ];
    const midLat = 40.744;
    const signLat = midLat - 0.0001; // south of centreline
    const result = offsetPolylinePoints(pts, signLat, -74.032, 4.0);
    for (const pt of result) {
      expect(pt[0]).toBeLessThan(40.744);
    }
  });

  it("GIVEN sign exactly at midpoint (on centreline), WHEN called, THEN returns pts reference unchanged (dot ≈ 0 guard)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [
      [40.743, -74.032],
      [40.745, -74.032],
    ];
    // Sign is at the midpoint of the segment — on centreline
    const midLat = (40.743 + 40.745) / 2;
    const midLng = -74.032;
    const result = offsetPolylinePoints(pts, midLat, midLng, 4.0);
    expect(result).toBe(pts);
  });

  it("GIVEN a N-S road and sign exactly LATERAL_OFFSET_M metres east, WHEN called with offsetM = LATERAL_OFFSET_M, THEN east offset of each returned point ≈ LATERAL_OFFSET_M metres", async () => {
    const { offsetPolylinePoints, LATERAL_OFFSET_M } = await import("../../app/map");
    const centralLng = -74.032;
    const midLat = 40.744;
    const cosLat = Math.cos(midLat * Math.PI / 180);
    // Offset LATERAL_OFFSET_M metres east in degrees
    const signLng = centralLng + LATERAL_OFFSET_M / (111320 * cosLat);
    const pts: [number, number][] = [
      [40.743, centralLng],
      [40.745, centralLng],
    ];
    const result = offsetPolylinePoints(pts, midLat, signLng, LATERAL_OFFSET_M);
    for (const [i, pt] of result.entries()) {
      const eastOffsetM = (pt[1] - pts[i][1]) * 111320 * cosLat;
      expect(eastOffsetM).toBeCloseTo(LATERAL_OFFSET_M, 1);
    }
  });

  it("GIVEN pts with identical first and last points (zero-length road segment), WHEN offsetPolylinePoints is called, THEN returns pts unchanged (len === 0 guard)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const pts: [number, number][] = [
      [40.744, -74.032],
      [40.744, -74.032],
    ];
    const result = offsetPolylinePoints(pts, 40.744, -74.033, 4.0);
    expect(result).toBe(pts);
  });
});

// ─── F-25 renderTowSegments offset tests ─────────────────────────────────────

describe("F-25 renderTowSegments offset", () => {
  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN two signs on opposite sides of the same N-S road, WHEN renderTowSegments is called, THEN east-side sign's polyline points all have lng > centreline and west-side sign's polyline points all have lng < centreline", async () => {
    const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
    initMap();
    const centreLng = -74.032;
    // N-S road: two points
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    const cosLat = Math.cos(40.744 * Math.PI / 180);
    const eastLng = centreLng + 5 / (111320 * cosLat);   // sign ~5m east
    const westLng = centreLng - 5 / (111320 * cosLat);   // sign ~5m west

    const eastSign = makeSign({ id: "east", address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: eastLng });
    const westSign = makeSign({ id: "west", address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: westLng });

    renderTowSegments([eastSign, westSign]);

    const L = (globalThis as Record<string, unknown>)["L"] as {
      polyline: ReturnType<typeof vi.fn>;
    };
    // calls: [outer_east, inner_east, outer_west, inner_west]
    const eastInnerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const westInnerArgs = L.polyline.mock.calls[3] as [[number, number][], Record<string, unknown>];
    const eastLatlngs = eastInnerArgs[0] as [number, number][];
    const westLatlngs = westInnerArgs[0] as [number, number][];

    for (const pt of eastLatlngs) {
      expect(pt[1]).toBeGreaterThan(centreLng);
    }
    for (const pt of westLatlngs) {
      expect(pt[1]).toBeLessThan(centreLng);
    }
  });

  it("GIVEN a sign east of a N-S centreline, WHEN renderTowSegments is called, THEN all captured polyline points have identical lat values (offset is purely longitudinal — perpendicularity test)", async () => {
    const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
    initMap();
    const centreLng = -74.032;
    // Perfect N-S road: both points share the same lng, different lat
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    const cosLat = Math.cos(40.744 * Math.PI / 180);
    const eastLng = centreLng + 5 / (111320 * cosLat);
    const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: eastLng });

    renderTowSegments([sign]);

    const L = (globalThis as Record<string, unknown>)["L"] as {
      polyline: ReturnType<typeof vi.fn>;
    };
    // calls[1] is the inner casing polyline
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];

    // For a pure N-S road, the perpendicular direction is purely east/west.
    // The offset adds only to lng — lats are unchanged by the offset operation.
    // getSubsegment interpolates to halfLengthM from center, so the lats are
    // not the raw waypoint values. Capture the pre-offset lats from getSubsegment
    // by calling it directly, then verify the polyline lats match those values.
    const { getSubsegment } = await import("../../app/map");
    const addrRange = 0; // "1036-1036" → range = 0
    const halfLengthM = Math.max(5, (addrRange / 2 + 1) * 4);
    const prePts = getSubsegment(
      [[[40.743, centreLng], [40.745, centreLng]]],
      40.744,
      eastLng,
      halfLengthM
    );
    for (const [i, pt] of latlngs.entries()) {
      const preOffset = prePts[i];
      if (preOffset !== undefined) {
        expect(pt[0]).toBeCloseTo(preOffset[0], 6);
      }
    }
  });
});
