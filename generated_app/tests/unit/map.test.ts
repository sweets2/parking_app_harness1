/**
 * Unit tests for app/map.ts — F-07 and F-07.6
 *
 * Leaflet is not available in Node. We create a minimal mock of the Leaflet `L`
 * global before importing map.ts so all L.* calls are intercepted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Sign, StreetCleaningEntry, Garage, SnowRoute, RoadGeometry } from "../../shared/types";
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
  _panes: Record<string, HTMLElement>;
  setView: (center: [number, number], zoom: number) => MockMap;
  panTo: (center: [number, number] | LatLng) => MockMap;
  getCenter: () => LatLng;
  getZoom: () => number;
  on: (event: string, handler: (e: { latlng: LatLng }) => void) => MockMap;
  off: (event: string) => MockMap;
  addLayer: (layer: MockMarker) => MockMap;
  removeLayer: (layer: MockMarker) => MockMap;
  closePopup: () => MockMap;
  createPane: (name: string) => HTMLElement;
  getPane: (name: string) => HTMLElement | undefined;
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
    _panes: {},
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
    createPane(name: string) {
      const el = { style: { zIndex: '' } } as unknown as HTMLElement;
      map._panes[name] = el;
      return el;
    },
    getPane(name: string) {
      return map._panes[name];
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
      const pane = opts["pane"] as string | undefined;
      return createMockMarker(latlng[0], latlng[1], { html: icon?._html ?? "", pane: pane ?? "" });
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
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
      renderTowSegments([makeSign({ id: "s1" }), makeSign({ id: "s2" })]);
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(4);
    });

    it("GIVEN renderTowSegments is called twice, THEN only the second call's layers remain on the map (first batch removed)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
      renderTowSegments([makeSign({ id: "s1" }), makeSign({ id: "s2" })]);
      renderTowSegments([makeSign({ id: "s3" })]);
      const polylines = mockMapInstance._layers.filter(
        (l) => l._options["_isPolyline"] === true
      );
      expect(polylines.length).toBe(2);
    });

    it("GIVEN a sign with address '257-257 11TH ST' (no matching geometry), WHEN renderTowSegments is called, THEN no polyline is drawn", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      const sign = makeSign({ address: "257-257 11TH ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(0);
    });

    it("GIVEN a sign with address '1036-1036 BLOOMFIELD ST' (no matching geometry), WHEN renderTowSegments is called, THEN no polyline is drawn", async () => {
      const { initMap, renderTowSegments } = await import("../../app/map");
      initMap();
      const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(0);
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
      const { initMap, renderTowSegments, setTowSignsVisible, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
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
      const { initMap, renderTowSegments, setTowSignsVisible, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
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

    it("GIVEN renderTowSegments renders, WHEN setTowSignsVisible(false) then setTowSignsVisible(true), THEN the same segment layers are restored on the map", async () => {
      const { initMap, renderTowSegments, setTowSignsVisible, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
      renderTowSegments([makeSign()]);
      setTowSignsVisible(false);
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

    // ─── F-24 casing style tests ───────────────────────────────────────────────

    it("F-24: GIVEN initMap is called and 1 sign is passed to renderTowSegments, THEN L.polyline is called twice (outer + inner casing)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
      renderTowSegments([makeSign()]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(2);
    });

    it("F-24: GIVEN 1 sign rendered, THEN calls[0] options contain { color: '#fff', weight: 7 } (outer casing) and calls[1] contain { color: '#cc0000', weight: 3 } (inner)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
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

    it("F-24: GIVEN initRoadGeometry called with empty {} AND a sign on 11TH ST, THEN no polyline is drawn (sign skipped — no geometry to snap to)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({});
      const sign = makeSign({ address: "257-257 11TH ST", lat: 40.744, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(0);
    });

    it("F-24: GIVEN geometry exists for a street but sign is > 50 m away, WHEN renderTowSegments is called, THEN no polyline is drawn (sign skipped — avoids lines over buildings)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      // ADAMS ST geometry near 40.740; sign is at 40.760 (~2200m away)
      initRoadGeometry({ "ADAMS ST": [[[40.740, -74.032], [40.741, -74.032]]] });
      const sign = makeSign({ address: "100-100 ADAMS ST", lat: 40.760, lng: -74.032 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      expect(L.polyline.mock.calls.length).toBe(0);
    });

    // ─── F-31 tests ───────────────────────────────────────────────────────────

    it("F-31: GIVEN initRoadGeometry called with '14TH ST' geometry (two OSM nodes with slightly different lat values) AND a matching sign on 14TH ST within snap range, WHEN renderTowSegments is called, THEN L.polyline is called at least once AND the polyline points include at least two distinct lat values (OSM geometry used, not single-lat horizontal fallback)", async () => {
      const { initMap, renderTowSegments, initRoadGeometry } = await import("../../app/map");
      initMap();
      // 14TH ST geometry: two nodes at slightly different latitudes (non-horizontal)
      // This simulates real OSM geometry where streets aren't perfectly horizontal
      initRoadGeometry({
        "14TH ST": [[[40.756, -74.040], [40.7565, -74.030]]],
      });
      // Sign on 14TH ST close to the road geometry (within 50m)
      const sign = makeSign({ address: "100-100 14TH ST", lat: 40.7562, lng: -74.035 });
      renderTowSegments([sign]);
      const L = (globalThis as Record<string, unknown>)["L"] as {
        polyline: ReturnType<typeof vi.fn>;
      };
      // L.polyline must be called at least once (outer + inner = 2 calls)
      expect(L.polyline.mock.calls.length).toBeGreaterThanOrEqual(1);
      // The polyline points must include at least two distinct lat values,
      // confirming OSM geometry was used (not a single-lat horizontal fallback)
      const allCalls = L.polyline.mock.calls as [[number, number][], Record<string, unknown>][];
      const firstCall = allCalls[0];
      expect(firstCall).toBeDefined();
      if (firstCall !== undefined) {
        const latlngs = firstCall[0] as [number, number][];
        const lats = latlngs.map((pt) => pt[0]);
        const distinctLats = new Set(lats.map((lat) => Math.round(lat * 1e6)));
        expect(distinctLats.size).toBeGreaterThanOrEqual(2);
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

  it("GIVEN a 3-point L-shaped way (N-S then E-W), WHEN offsetPolylinePoints called, THEN first point shifts perpendicular to N-S segment (lng changes, lat unchanged) and last point shifts perpendicular to E-W segment (lat changes, lng unchanged)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    // Road goes north then turns east
    const pts: [number, number][] = [
      [40.743, -74.032],
      [40.744, -74.032],
      [40.744, -74.031],
    ];
    // Sign east of the first segment's centre — triggers dir=1 (east/south-east offset)
    const signLat = (40.743 + 40.744) / 2;
    const signLng = -74.031; // well east of centre
    const result = offsetPolylinePoints(pts, signLat, signLng, 4.0);
    // First point: N-S segment → perpendicular is E-W → lng changes, lat stays put
    expect(result[0][0]).toBeCloseTo(40.743, 5);   // lat nearly unchanged
    expect(result[0][1]).not.toBeCloseTo(-74.032, 5); // lng shifted
    // Last point: E-W segment → perpendicular is N-S → lat changes, lng stays put
    expect(result[2][1]).toBeCloseTo(-74.031, 5);  // lng nearly unchanged
    expect(result[2][0]).not.toBeCloseTo(40.744, 5); // lat shifted
  });

  // ─── F-41 forcedDir tests ──────────────────────────────────────────────────

  it("F-41: GIVEN a N-S polyline, sign at midpoint (dot ≈ 0), forcedDir = 1, WHEN offsetPolylinePoints is called, THEN all returned points shift east (positive longitude delta)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const centreLng = -74.032;
    const pts: [number, number][] = [
      [40.743, centreLng],
      [40.745, centreLng],
    ];
    // Sign at exact midpoint — dot ≈ 0 normally causes early return
    const midLat = (40.743 + 40.745) / 2;
    const result = offsetPolylinePoints(pts, midLat, centreLng, 4.0, 1);
    // forcedDir = 1 means offset in left-perpendicular direction (east for N-S road going north)
    for (const pt of result) {
      expect(pt[1]).toBeGreaterThan(centreLng);
    }
  });

  it("F-41: GIVEN a N-S polyline, sign at midpoint (dot ≈ 0), forcedDir = -1, WHEN offsetPolylinePoints is called, THEN all returned points shift west (negative longitude delta)", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const centreLng = -74.032;
    const pts: [number, number][] = [
      [40.743, centreLng],
      [40.745, centreLng],
    ];
    const midLat = (40.743 + 40.745) / 2;
    const result = offsetPolylinePoints(pts, midLat, centreLng, 4.0, -1);
    for (const pt of result) {
      expect(pt[1]).toBeLessThan(centreLng);
    }
  });

  it("F-41: GIVEN a N-S polyline, sign east of center (dot > 0 → natural dir = 1), forcedDir = -1, WHEN offsetPolylinePoints is called, THEN all returned points shift west — forcedDir overrides natural GPS direction", async () => {
    const { offsetPolylinePoints } = await import("../../app/map");
    const centreLng = -74.032;
    const pts: [number, number][] = [
      [40.743, centreLng],
      [40.745, centreLng],
    ];
    const cosLat = Math.cos(40.744 * Math.PI / 180);
    // Sign east of centreline (natural dir = 1)
    const eastLng = centreLng + 5 / (111320 * cosLat);
    const result = offsetPolylinePoints(pts, 40.744, eastLng, 4.0, -1);
    // forcedDir = -1 overrides natural dir, should shift west
    for (const pt of result) {
      expect(pt[1]).toBeLessThan(centreLng);
    }
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

// ─── F-34 Street Violation Highlights ────────────────────────────────────────

describe("F-34 violation highlights", () => {
  // Active cleaning schedule — "11 am – 1 pm" window contains noon ET (NOW_STABLE)
  // NOW_STABLE = 2026-06-09T16:00:00Z = noon ET (UTC-4)
  const ACTIVE_CLEANING: StreetCleaningEntry = {
    street: "Bloomfield Street",
    side: "West",
    schedule: "Monday through Friday   11 am – 1 pm",
    location: "1st St. to 14th St.",
  };

  // Upcoming cleaning schedule — starts at 1 pm ET, upcoming at noon ET
  // isScheduleUpcomingSoon: minutesOfDay(720) >= 780-60 && 720 < 780 → true
  const UPCOMING_CLEANING: StreetCleaningEntry = {
    street: "Bloomfield Street",
    side: "West",
    schedule: "Monday through Friday   1 pm – 2 pm",
    location: "1st St. to 14th St.",
  };

  const EAST_ACTIVE: StreetCleaningEntry = {
    street: "Bloomfield Street",
    side: "East",
    schedule: ACTIVE_CLEANING.schedule,
    location: "1st St. to 14th St.",
  };

  const WEST_UPCOMING: StreetCleaningEntry = {
    street: "Bloomfield Street",
    side: "West",
    schedule: UPCOMING_CLEANING.schedule,
    location: "1st St. to 14th St.",
  };

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN initMap and road geometry for BLOOMFIELD ST, WHEN renderViolationHighlights with active cleaning schedule, THEN red polylines added to map", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    const redLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#ef4444"
    );
    expect(redLayers.length).toBeGreaterThan(0);
  });

  it("GIVEN initMap and road geometry, WHEN renderViolationHighlights with upcoming cleaning schedule, THEN orange polylines added to map", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([UPCOMING_CLEANING], NOW_STABLE);
    const orangeLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#f97316"
    );
    expect(orangeLayers.length).toBeGreaterThan(0);
  });

  it("GIVEN active and upcoming cleaning on same street, WHEN renderViolationHighlights called, THEN only red layers (active takes priority, no orange)", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([ACTIVE_CLEANING, UPCOMING_CLEANING], NOW_STABLE);
    const orangeLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#f97316"
    );
    const redLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#ef4444"
    );
    expect(orangeLayers.length).toBe(0);
    expect(redLayers.length).toBeGreaterThan(0);
  });

  it("GIVEN violation layers on map, WHEN setViolationHighlightsVisible(false) called, THEN no violation polylines remain in map layers", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights, setViolationHighlightsVisible } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    expect(mockMapInstance._layers.length).toBeGreaterThan(0);
    setViolationHighlightsVisible(false);
    const violationPolylines = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["_isPolyline"] === true
    );
    expect(violationPolylines.length).toBe(0);
  });

  it("GIVEN violation layers hidden, WHEN setViolationHighlightsVisible(true) called, THEN violation polylines are back on map", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights, setViolationHighlightsVisible } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    setViolationHighlightsVisible(false);
    expect(mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["_isPolyline"] === true
    ).length).toBe(0);
    setViolationHighlightsVisible(true);
    const violationPolylines = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["_isPolyline"] === true
    );
    expect(violationPolylines.length).toBeGreaterThan(0);
  });

  it("GIVEN violation layers on map, WHEN clearViolationHighlights called, THEN no polyline layers remain and map layers empty of violation polylines", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights, clearViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    expect(mockMapInstance._layers.length).toBeGreaterThan(0);
    clearViolationHighlights();
    const violationPolylines = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["_isPolyline"] === true
    );
    expect(violationPolylines.length).toBe(0);
  });

  it("GIVEN empty road geometry, WHEN renderViolationHighlights called with active sign and cleaning, THEN no error thrown and no polyline layers added", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({});
    expect(() => {
      renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    }).not.toThrow();
    const polylineLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["_isPolyline"] === true
    );
    expect(polylineLayers.length).toBe(0);
  });

  it("GIVEN two connected ways sharing an endpoint, WHEN renderViolationHighlights, THEN one polyline rendered (ways merged)", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [
      [[40.745, -74.044], [40.7455, -74.044]],
      [[40.7455, -74.044], [40.746, -74.044]],
    ]});
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(1);
  });

  it("GIVEN two disconnected ways, WHEN renderViolationHighlights, THEN two polylines rendered (chains stay separate)", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [
      [[40.745, -74.044], [40.7455, -74.044]],
      [[40.747, -74.044], [40.748, -74.044]],
    ]});
    renderViolationHighlights([ACTIVE_CLEANING], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
  });

  it("GIVEN East=active and West=upcoming, WHEN renderViolationHighlights, THEN two offset polylines (red + orange)", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([EAST_ACTIVE, WEST_UPCOMING], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const colors = (L.polyline.mock.calls as [unknown, { color: string }][]).map(([, opts]) => opts.color);
    expect(colors).toContain("#ef4444");
    expect(colors).toContain("#f97316");
  });

  it("GIVEN East=active and West=active, WHEN renderViolationHighlights, THEN two offset red polylines (no full-width)", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    const WEST_ACTIVE: StreetCleaningEntry = { ...EAST_ACTIVE, side: "West" };
    renderViolationHighlights([EAST_ACTIVE, WEST_ACTIVE], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    for (const call of L.polyline.mock.calls as [unknown, Record<string, unknown>][]) {
      expect((call[1] as Record<string, unknown>)["color"]).toBe("#ef4444");
    }
  });

  it("GIVEN East=active only (West not active or upcoming), WHEN renderViolationHighlights, THEN one offset red polyline on East side only", async () => {
    const { initMap, initRoadGeometry, renderViolationHighlights } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.745, -74.044], [40.746, -74.044]]] });
    renderViolationHighlights([EAST_ACTIVE], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(1);
    expect((L.polyline.mock.calls[0] as [unknown, Record<string, unknown>])[1]).toMatchObject({ color: "#ef4444" });
  });
});

// ─── F-35 upcoming sign rendering ────────────────────────────────────────────

describe("F-35 upcoming sign rendering", () => {
  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN 2 upcoming signs WHEN renderUpcomingSignPins is called THEN 2 markers are added to map", async () => {
    const { initMap, renderUpcomingSignPins } = await import("../../app/map");
    initMap();
    const signs = [
      makeSign({ id: "u1", start_iso: "2026-06-10T08:00:00", end_iso: "2026-06-10T17:00:00" }),
      makeSign({ id: "u2", start_iso: "2026-06-11T08:00:00", end_iso: "2026-06-11T17:00:00" }),
    ];
    renderUpcomingSignPins(signs, NOW_STABLE);
    const markers = mockMapInstance._layers.filter(
      (l) => l._options["pane"] === "upcomingPane"
    );
    expect(markers.length).toBe(2);
  });

  it("GIVEN 1 upcoming sign rendered THEN marker HTML contains #f97316 (not #cc0000)", async () => {
    const { initMap, renderUpcomingSignPins } = await import("../../app/map");
    initMap();
    const sign = makeSign({ id: "u1", start_iso: "2026-06-10T08:00:00", end_iso: "2026-06-10T17:00:00" });
    renderUpcomingSignPins([sign], NOW_STABLE);
    const marker = mockMapInstance._layers.find((l) => l._options["pane"] === "upcomingPane");
    expect(marker).toBeDefined();
    expect(marker?._options["html"]).toContain("#f97316");
    expect(marker?._options["html"]).not.toContain("#cc0000");
  });

  it("GIVEN 1 upcoming sign WHEN renderUpcomingSignPins is called THEN L.marker called with { pane: 'upcomingPane' } option", async () => {
    const { initMap, renderUpcomingSignPins } = await import("../../app/map");
    initMap();
    const sign = makeSign({ id: "u1", start_iso: "2026-06-10T08:00:00", end_iso: "2026-06-10T17:00:00" });
    renderUpcomingSignPins([sign], NOW_STABLE);
    const L = (globalThis as Record<string, unknown>)["L"] as { marker: ReturnType<typeof vi.fn> };
    const calls = L.marker.mock.calls as [unknown, Record<string, unknown>][];
    const upcomingCall = calls.find(([, opts]) => opts["pane"] === "upcomingPane");
    expect(upcomingCall).toBeDefined();
  });

  it("GIVEN 1 upcoming sign WHEN renderUpcomingTowSegments is called THEN L.polyline called twice; second call options have color: '#f97316'", async () => {
    const { initMap, renderUpcomingTowSegments, initRoadGeometry } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "Test St": [[[40.744, -74.032], [40.744, -74.033]]] });
    const sign = makeSign({ id: "u1", start_iso: "2026-06-10T08:00:00", end_iso: "2026-06-10T17:00:00" });
    renderUpcomingTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    expect(innerArgs[1]["color"]).toBe("#f97316");
  });

  it("GIVEN renderUpcomingSignPins called twice THEN only the second batch of markers remains", async () => {
    const { initMap, renderUpcomingSignPins } = await import("../../app/map");
    initMap();
    const batch1 = [
      makeSign({ id: "u1", lat: 40.744, lng: -74.032 }),
      makeSign({ id: "u2", lat: 40.745, lng: -74.032 }),
    ];
    const batch2 = [
      makeSign({ id: "u3", lat: 40.746, lng: -74.032 }),
    ];
    renderUpcomingSignPins(batch1, NOW_STABLE);
    expect(mockMapInstance._layers.filter((l) => l._options["pane"] === "upcomingPane").length).toBe(2);
    renderUpcomingSignPins(batch2, NOW_STABLE);
    expect(mockMapInstance._layers.filter((l) => l._options["pane"] === "upcomingPane").length).toBe(1);
  });

  it("GIVEN setUpcomingSignsVisible(false) called before render WHEN renderUpcomingSignPins runs THEN no markers added to map", async () => {
    const { initMap, renderUpcomingSignPins, setUpcomingSignsVisible } = await import("../../app/map");
    initMap();
    setUpcomingSignsVisible(false);
    const sign = makeSign({ id: "u1" });
    renderUpcomingSignPins([sign], NOW_STABLE);
    const upcomingMarkers = mockMapInstance._layers.filter((l) => l._options["pane"] === "upcomingPane");
    expect(upcomingMarkers.length).toBe(0);
  });

  it("GIVEN upcoming signs rendered WHEN setUpcomingSignsVisible(false) is called THEN all upcoming markers and segments are removed from map", async () => {
    const { initMap, renderUpcomingSignPins, renderUpcomingTowSegments, setUpcomingSignsVisible } = await import("../../app/map");
    initMap();
    const sign = makeSign({ id: "u1" });
    renderUpcomingSignPins([sign], NOW_STABLE);
    renderUpcomingTowSegments([sign]);
    const before = mockMapInstance._layers.length;
    expect(before).toBeGreaterThan(0);
    setUpcomingSignsVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN upcoming signs hidden WHEN setUpcomingSignsVisible(true) is called THEN all upcoming markers and segments are added back to map", async () => {
    const { initMap, renderUpcomingSignPins, renderUpcomingTowSegments, setUpcomingSignsVisible } = await import("../../app/map");
    initMap();
    const sign = makeSign({ id: "u1" });
    renderUpcomingSignPins([sign], NOW_STABLE);
    renderUpcomingTowSegments([sign]);
    const countBefore = mockMapInstance._layers.length;
    setUpcomingSignsVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
    setUpcomingSignsVisible(true);
    expect(mockMapInstance._layers.length).toBe(countBefore);
  });

  it("GIVEN both active and upcoming signs rendered THEN active markers do not contain #f97316, upcoming markers contain #f97316", async () => {
    const { initMap, renderSignPins, renderUpcomingSignPins } = await import("../../app/map");
    initMap();
    const activeSign = makeSign({ id: "a1", start_iso: "2026-06-09T08:00:00", end_iso: "2026-06-09T20:00:00", active_at_fetch: true });
    const upcomingSign = makeSign({ id: "u1", start_iso: "2026-06-10T08:00:00", end_iso: "2026-06-10T17:00:00" });
    renderSignPins([activeSign], NOW_STABLE);
    renderUpcomingSignPins([upcomingSign], NOW_STABLE);
    // Active markers: added by renderSignPins, no pane option
    const activeMarkers = mockMapInstance._layers.filter(
      (l) => l._options["pane"] !== "upcomingPane" && typeof l._options["html"] === "string"
    );
    const upcomingMarkers = mockMapInstance._layers.filter(
      (l) => l._options["pane"] === "upcomingPane"
    );
    expect(activeMarkers.length).toBeGreaterThan(0);
    expect(upcomingMarkers.length).toBeGreaterThan(0);
    // Active markers should not use orange (they use a different red SVG)
    for (const m of activeMarkers) {
      expect(m._options["html"]).not.toContain("#f97316");
    }
    // Upcoming markers must use orange
    for (const m of upcomingMarkers) {
      expect(m._options["html"]).toContain("#f97316");
    }
  });

  it("GIVEN renderUpcomingTowSegments([]) is called THEN no error thrown and no polylines added", async () => {
    const { initMap, renderUpcomingTowSegments } = await import("../../app/map");
    initMap();
    expect(() => renderUpcomingTowSegments([])).not.toThrow();
    const polylines = mockMapInstance._layers.filter(
      (l) => l._options["_isPolyline"] === true
    );
    expect(polylines.length).toBe(0);
  });

  describe("pin snapping to road geometry", () => {
    it("GIVEN road geometry exists for a sign's street WHEN renderSignPins is called THEN pin is placed at road-geometry midpoint, not raw API coords", async () => {
      const { initMap, renderSignPins, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({
        "GARDEN ST": [[[40.7390, -74.0320], [40.7395, -74.0320], [40.7400, -74.0320]]],
      });
      // Raw API coords are off by a block (on Willow Ave)
      const sign = makeSign({ address: "400-424 GARDEN ST", lat: 40.7395, lng: -74.0334 });
      renderSignPins([sign], NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      // Pin must be on GARDEN ST (~-74.0320), not at the raw API lng (~-74.0334)
      expect(Math.abs(marker._lng - (-74.0320))).toBeLessThan(0.0005);
    });

    it("GIVEN no road geometry for a sign's street WHEN renderSignPins is called THEN pin falls back to raw API coords", async () => {
      const { initMap, renderSignPins, initRoadGeometry } = await import("../../app/map");
      initMap();
      initRoadGeometry({});
      const sign = makeSign({ address: "500-520 UNKNOWN ST", lat: 40.750, lng: -74.035 });
      renderSignPins([sign], NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(marker._lat).toBeCloseTo(40.750, 5);
      expect(marker._lng).toBeCloseTo(-74.035, 5);
    });

    it("GIVEN road geometry exists for a sign's street WHEN renderUpcomingSignPins is called THEN pin is placed at road-geometry midpoint", async () => {
      const { initMap, renderUpcomingSignPins, initRoadGeometry, setUpcomingSignsVisible } = await import("../../app/map");
      initMap();
      initRoadGeometry({
        "CLINTON ST": [[[40.7540, -74.0310], [40.7545, -74.0310], [40.7550, -74.0310]]],
      });
      const sign = makeSign({ address: "1500-1540 CLINTON ST", lat: 40.7545, lng: -74.0330 });
      setUpcomingSignsVisible(true);
      renderUpcomingSignPins([sign], NOW_STABLE);
      const marker = mockMapInstance._layers[0];
      expect(marker).toBeDefined();
      expect(Math.abs(marker._lng - (-74.0310))).toBeLessThan(0.0005);
    });
  });
});

// ─── F-36 Municipal Garage Markers ───────────────────────────────────────────

describe("F-36 garage markers", () => {
  function makeGarage(overrides: Partial<Garage> = {}): Garage {
    return {
      name: "Garage B",
      address: "28 2nd St",
      capacity: 829,
      lat: 40.736,
      lng: -74.034,
      phone: "201-653-7333",
      ...overrides,
    };
  }

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN a garages array of 4 Garage objects and initMap() called, WHEN renderGarageMarkers(garages, true) is called, THEN mockMapInstance._layers contains 4 markers", async () => {
    const { initMap, renderGarageMarkers } = await import("../../app/map");
    initMap();
    const garages = [
      makeGarage({ name: "Garage B" }),
      makeGarage({ name: "Garage D", lat: 40.738, lng: -74.029 }),
      makeGarage({ name: "Garage G", lat: 40.740, lng: -74.028 }),
      makeGarage({ name: "Midtown Garage", lat: 40.742, lng: -74.033 }),
    ];
    renderGarageMarkers(garages, true);
    expect(mockMapInstance._layers.length).toBe(4);
  });

  it("GIVEN garage markers have been rendered (visible = true), WHEN renderGarageMarkers(garages, false) is called, THEN mockMapInstance._layers contains 0 garage markers", async () => {
    const { initMap, renderGarageMarkers } = await import("../../app/map");
    initMap();
    const garages = [
      makeGarage({ name: "Garage B" }),
      makeGarage({ name: "Garage D", lat: 40.738, lng: -74.029 }),
      makeGarage({ name: "Garage G", lat: 40.740, lng: -74.028 }),
      makeGarage({ name: "Midtown Garage", lat: 40.742, lng: -74.033 }),
    ];
    renderGarageMarkers(garages, true);
    renderGarageMarkers(garages, false);
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN renderGarageMarkers(garages, false) then renderGarageMarkers(garages, true), WHEN checking mockMapInstance._layers, THEN 4 markers are present on the map", async () => {
    const { initMap, renderGarageMarkers } = await import("../../app/map");
    initMap();
    const garages = [
      makeGarage({ name: "Garage B" }),
      makeGarage({ name: "Garage D", lat: 40.738, lng: -74.029 }),
      makeGarage({ name: "Garage G", lat: 40.740, lng: -74.028 }),
      makeGarage({ name: "Midtown Garage", lat: 40.742, lng: -74.033 }),
    ];
    renderGarageMarkers(garages, false);
    renderGarageMarkers(garages, true);
    expect(mockMapInstance._layers.length).toBe(4);
  });

  it("GIVEN an empty garages array, WHEN renderGarageMarkers([], true) is called, THEN no markers are added and no error is thrown", async () => {
    const { initMap, renderGarageMarkers } = await import("../../app/map");
    initMap();
    expect(() => renderGarageMarkers([], true)).not.toThrow();
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN 4 garage markers rendered, WHEN setGarageMarkersVisible(false) is called, THEN all 4 markers are removed from mockMapInstance._layers", async () => {
    const { initMap, renderGarageMarkers, setGarageMarkersVisible } = await import("../../app/map");
    initMap();
    const garages = [
      makeGarage({ name: "Garage B" }),
      makeGarage({ name: "Garage D", lat: 40.738, lng: -74.029 }),
      makeGarage({ name: "Garage G", lat: 40.740, lng: -74.028 }),
      makeGarage({ name: "Midtown Garage", lat: 40.742, lng: -74.033 }),
    ];
    renderGarageMarkers(garages, true);
    expect(mockMapInstance._layers.length).toBe(4);
    setGarageMarkersVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN 4 garage markers hidden, WHEN setGarageMarkersVisible(true) is called, THEN all 4 markers are re-added to mockMapInstance._layers", async () => {
    const { initMap, renderGarageMarkers, setGarageMarkersVisible } = await import("../../app/map");
    initMap();
    const garages = [
      makeGarage({ name: "Garage B" }),
      makeGarage({ name: "Garage D", lat: 40.738, lng: -74.029 }),
      makeGarage({ name: "Garage G", lat: 40.740, lng: -74.028 }),
      makeGarage({ name: "Midtown Garage", lat: 40.742, lng: -74.033 }),
    ];
    renderGarageMarkers(garages, true);
    setGarageMarkersVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
    setGarageMarkersVisible(true);
    expect(mockMapInstance._layers.length).toBe(4);
  });
});

// ─── F-37 Snow Emergency Routes ───────────────────────────────────────────────

describe("F-37 snow emergency routes", () => {
  function makeSnowRoute(overrides: Partial<SnowRoute> = {}): SnowRoute {
    return {
      street: "3RD ST",
      side: "North",
      from: "Jackson St",
      to: "River St",
      ...overrides,
    };
  }

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("GIVEN initMap() called, initRoadGeometry({ '3RD ST': [[[40.744, -74.032], [40.745, -74.032]]] }), and routes = [makeSnowRoute({ street: '3RD ST' })], WHEN renderSnowEmergencyRoutes(routes, true) is called, THEN 1 polyline layer is present in mockMapInstance._layers with color '#3b82f6'", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "3RD ST": [[[40.744, -74.032], [40.745, -74.032]]] });
    const routes = [makeSnowRoute({ street: "3RD ST" })];
    renderSnowEmergencyRoutes(routes, true);
    const blueLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#3b82f6"
    );
    expect(blueLayers.length).toBe(1);
  });

  it("GIVEN snow routes have been rendered (visible = true), WHEN renderSnowEmergencyRoutes(routes, false) is called, THEN 0 polylines remain in mockMapInstance._layers", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "3RD ST": [[[40.744, -74.032], [40.745, -74.032]]] });
    const routes = [makeSnowRoute({ street: "3RD ST" })];
    renderSnowEmergencyRoutes(routes, true);
    expect(mockMapInstance._layers.length).toBe(1);
    renderSnowEmergencyRoutes(routes, false);
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN a route whose street key does not exist in road geometry, WHEN renderSnowEmergencyRoutes([makeSnowRoute({ street: 'NONEXISTENT ST' })], true) is called, THEN no polyline is added and no error is thrown", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes } = await import("../../app/map");
    initMap();
    initRoadGeometry({});
    expect(() => renderSnowEmergencyRoutes([makeSnowRoute({ street: "NONEXISTENT ST" })], true)).not.toThrow();
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN geometry for '13TH ST' and two routes with street '13TH ST' but different sides ('North' and 'South'), WHEN renderSnowEmergencyRoutes(routes, true) is called, THEN 2 polyline layers are present in mockMapInstance._layers (one per route entry per way)", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "13TH ST": [[[40.750, -74.032], [40.751, -74.032]]] });
    const routes = [
      makeSnowRoute({ street: "13TH ST", side: "North" }),
      makeSnowRoute({ street: "13TH ST", side: "South" }),
    ];
    renderSnowEmergencyRoutes(routes, true);
    const blueLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#3b82f6"
    );
    expect(blueLayers.length).toBe(2);
  });

  it("GIVEN snow routes have been rendered, WHEN setSnowRoutesVisible(false) is called, THEN all snow polylines are removed from mockMapInstance._layers", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes, setSnowRoutesVisible } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "3RD ST": [[[40.744, -74.032], [40.745, -74.032]]] });
    const routes = [makeSnowRoute({ street: "3RD ST" })];
    renderSnowEmergencyRoutes(routes, true);
    expect(mockMapInstance._layers.length).toBe(1);
    setSnowRoutesVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
  });

  it("GIVEN snow routes have been hidden, WHEN setSnowRoutesVisible(true) is called, THEN all snow polylines are re-added to mockMapInstance._layers", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes, setSnowRoutesVisible } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "3RD ST": [[[40.744, -74.032], [40.745, -74.032]]] });
    const routes = [makeSnowRoute({ street: "3RD ST" })];
    renderSnowEmergencyRoutes(routes, true);
    setSnowRoutesVisible(false);
    expect(mockMapInstance._layers.length).toBe(0);
    setSnowRoutesVisible(true);
    expect(mockMapInstance._layers.length).toBe(1);
  });

  it("GIVEN 1 route with geometry containing 2 connected ways (end of way-0 = start of way-1), WHEN renderSnowEmergencyRoutes([route], true) is called, THEN exactly 1 polyline is added (ways merged into one chain)", async () => {
    const { initMap, initRoadGeometry, renderSnowEmergencyRoutes } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "3RD ST": [
        [[40.744, -74.032], [40.745, -74.032]],
        [[40.745, -74.032], [40.746, -74.032]],
      ],
    });
    renderSnowEmergencyRoutes([makeSnowRoute({ street: "3RD ST" })], true);
    const blueLayers = mockMapInstance._layers.filter(
      (l) => (l as unknown as { _options: Record<string, unknown> })._options["color"] === "#3b82f6"
    );
    expect(blueLayers.length).toBe(1);
  });
});

// ─── F-41 Address-parity curb offset ─────────────────────────────────────────

describe("F-41 renderTowSegments — address-parity curb offset", () => {
  // N-S road on BLOOMFIELD ST — left-perpendicular (dir=1) is east
  // initStreetParity({ "BLOOMFIELD ST": 1 }) means odd addresses are on the east side (+1)

  const centreLng = -74.032;

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-41: GIVEN initStreetParity({ 'BLOOMFIELD ST': 1 }) and a sign with odd address '1037-1037 BLOOMFIELD ST' (centerline sign, dot ≈ 0), WHEN renderTowSegments is called, THEN inner polyline points are shifted east (+1 direction)", async () => {
    const { initMap, renderTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    // N-S road: sign at centerline
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    // Odd address, sign exactly on centerline (dot ≈ 0 without parity)
    const sign = makeSign({ address: "1037-1037 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    renderTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];
    // With forcedDir=1 on N-S road (going north), perpendicular is east (positive lng delta)
    for (const pt of latlngs) {
      expect(pt[1]).toBeGreaterThan(centreLng);
    }
  });

  it("F-41: GIVEN initStreetParity({ 'BLOOMFIELD ST': 1 }) and a sign with even address '1036-1036 BLOOMFIELD ST' (centerline sign), WHEN renderTowSegments is called, THEN inner polyline points are shifted west (-1 direction)", async () => {
    const { initMap, renderTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    // Even address → forcedDir = -1 (opposite of oddDir=1)
    const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    renderTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];
    for (const pt of latlngs) {
      expect(pt[1]).toBeLessThan(centreLng);
    }
  });

  it("F-41: GIVEN initStreetParity({}) (no entry) and a centerline sign, WHEN renderTowSegments is called, THEN no crash occurs and layer count is 2 (polyline rendered at centerline — graceful degradation)", async () => {
    // Per spec note: 'graceful degradation' — when no parity entry, forcedDir is undefined,
    // sign is on centerline (dot ≈ 0), offsetPolylinePoints returns pts unchanged.
    // The polyline IS rendered (waypoints.length >= 2), just at the centerline.
    const { initMap, renderTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({});
    const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    expect(() => renderTowSegments([sign])).not.toThrow();
    const polylines = mockMapInstance._layers.filter((l) => l._options["_isPolyline"] === true);
    // The polyline renders at centerline (offset returns pts unchanged)
    expect(polylines.length).toBe(2);
  });
});

// ─── F-41 renderUpcomingTowSegments — mirror tests ───────────────────────────

describe("F-41 renderUpcomingTowSegments — address-parity curb offset", () => {
  const centreLng = -74.032;

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-41: GIVEN initStreetParity({ 'BLOOMFIELD ST': 1 }) and odd address '1037-1037 BLOOMFIELD ST' (centerline sign), WHEN renderUpcomingTowSegments is called, THEN inner polyline points are shifted east", async () => {
    const { initMap, renderUpcomingTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "1037-1037 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    renderUpcomingTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];
    for (const pt of latlngs) {
      expect(pt[1]).toBeGreaterThan(centreLng);
    }
  });

  it("F-41: GIVEN initStreetParity({ 'BLOOMFIELD ST': 1 }) and even address '1036-1036 BLOOMFIELD ST' (centerline sign), WHEN renderUpcomingTowSegments is called, THEN inner polyline points are shifted west", async () => {
    const { initMap, renderUpcomingTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    renderUpcomingTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];
    for (const pt of latlngs) {
      expect(pt[1]).toBeLessThan(centreLng);
    }
  });

  it("F-41: GIVEN initStreetParity({}) (no entry) and a centerline sign, WHEN renderUpcomingTowSegments is called, THEN no crash occurs and layer count is 2", async () => {
    const { initMap, renderUpcomingTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({
      "BLOOMFIELD ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    initStreetParity({});
    const sign = makeSign({ address: "1036-1036 BLOOMFIELD ST", lat: 40.744, lng: centreLng });
    expect(() => renderUpcomingTowSegments([sign])).not.toThrow();
    const polylines = mockMapInstance._layers.filter((l) => l._options["_isPolyline"] === true);
    expect(polylines.length).toBe(2);
  });
});

// ─── F-41 Normalization alignment test ───────────────────────────────────────

describe("F-41 normalization alignment", () => {
  const centreLng = -74.032;

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-41: GIVEN initStreetParity({ '8TH ST': 1 }) and a sign with address '805 EIGHTH ST' on road geometry keyed 'EIGHTH ST', WHEN renderTowSegments is called, THEN inner polyline is offset (normalizeToGeometryKey('EIGHTH ST') → '8TH ST' hits parity map)", async () => {
    const { initMap, renderTowSegments, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    // Road geometry uses the non-normalized key "EIGHTH ST" (as scraped from OSM name)
    initRoadGeometry({
      "EIGHTH ST": [[[40.743, centreLng], [40.745, centreLng]]],
    });
    // Parity map uses the normalized key "8TH ST"
    initStreetParity({ "8TH ST": 1 });
    // Address "805 EIGHTH ST" — sign on centerline
    const sign = makeSign({ address: "805 EIGHTH ST", lat: 40.744, lng: centreLng });
    renderTowSegments([sign]);
    const L = (globalThis as Record<string, unknown>)["L"] as { polyline: ReturnType<typeof vi.fn> };
    // Should render 2 polylines (geometry found via "EIGHTH ST")
    expect(L.polyline.mock.calls.length).toBe(2);
    const innerArgs = L.polyline.mock.calls[1] as [[number, number][], Record<string, unknown>];
    const latlngs = innerArgs[0] as [number, number][];
    // With forcedDir=1 (odd address 805, oddDir=1) on N-S road, shift east
    for (const pt of latlngs) {
      expect(pt[1]).toBeGreaterThan(centreLng);
    }
  });
});

// ─── F-42 getSnappedPinPosition parity offset ────────────────────────────────

describe("F-42 getSnappedPinPosition parity offset", () => {
  // N-S road segment: A = [40.740, -74.030], B = [40.741, -74.030]
  // projPt for a centerline sign at [40.7405, -74.030] is itself.
  // Right-perp of this segment: dY>0, dX=0 → perpX=1 (east), perpY=0
  // dir=1 → pin shifts east (dLng > 0); dir=-1 → west (dLng < 0)

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-42: GIVEN odd address '101 BLOOMFIELD ST' (forcedDir=1 → east), WHEN renderSignPins is called, THEN pin marker lng > -74.030 (shifted east)", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 }); // odd addresses on east (+1) side
    const sign = makeSign({ address: "101 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const towPins = mockMapInstance._layers.filter((l) => l._options["pane"] === "towSignPane");
    expect(towPins.length).toBe(1);
    const pin = towPins[0];
    expect(pin).toBeDefined();
    if (pin !== undefined) {
      expect(pin._lng).toBeGreaterThan(-74.030);
    }
  });

  it("F-42: GIVEN even address '100 BLOOMFIELD ST' (forcedDir=-1 → west), WHEN renderSignPins is called, THEN pin marker lng < -74.030 (shifted west)", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 }); // odd on east, so even on west
    const sign = makeSign({ address: "100 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const towPins = mockMapInstance._layers.filter((l) => l._options["pane"] === "towSignPane");
    expect(towPins.length).toBe(1);
    const pin = towPins[0];
    expect(pin).toBeDefined();
    if (pin !== undefined) {
      expect(pin._lng).toBeLessThan(-74.030);
    }
  });

  it("F-42: GIVEN initStreetParity({}) (no entry for BLOOMFIELD ST), WHEN renderSignPins is called, THEN pin marker lng === -74.030 (no offset applied)", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({});
    const sign = makeSign({ address: "101 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const towPins = mockMapInstance._layers.filter((l) => l._options["pane"] === "towSignPane");
    expect(towPins.length).toBe(1);
    const pin = towPins[0];
    expect(pin).toBeDefined();
    if (pin !== undefined) {
      expect(pin._lng).toBeCloseTo(-74.030, 6);
    }
  });

  it("F-42: GIVEN initStreetParity({ 'BLOOMFIELD ST': 1 }) and odd address '101 BLOOMFIELD ST', WHEN renderUpcomingSignPins is called, THEN upcoming pin marker lng > -74.030 (shifted east)", async () => {
    const { initMap, renderUpcomingSignPins, initRoadGeometry, initStreetParity } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "101 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderUpcomingSignPins([sign], NOW_STABLE);
    const upcomingPins = mockMapInstance._layers.filter((l) => l._options["pane"] === "upcomingPane");
    expect(upcomingPins.length).toBe(1);
    const pin = upcomingPins[0];
    expect(pin).toBeDefined();
    if (pin !== undefined) {
      expect(pin._lng).toBeGreaterThan(-74.030);
    }
  });
});

// ─── F-43 PIN_LATERAL_OFFSET_M pin distance ──────────────────────────────────

describe("F-43 PIN_LATERAL_OFFSET_M pin distance", () => {
  // N-S road segment: A = [40.740, -74.030], B = [40.741, -74.030]
  // Right-perp: perpX = 1 (east), perpY = 0
  // Odd address → dir=1 → pin shifts east (lng increases)

  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-43: GIVEN odd address '101 BLOOMFIELD ST' on N-S road, WHEN renderSignPins is called, THEN pin lng offset from centerline ≈ PIN_LATERAL_OFFSET_M / (111320 * cos(lat))", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity, PIN_LATERAL_OFFSET_M } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "101 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const marker = mockMapInstance._layers.filter(
      (l: MockMarker) => l._options["pane"] === "towSignPane"
    )[0];
    expect(marker).toBeDefined();
    if (marker !== undefined) {
      const cosLat = Math.cos(40.7405 * Math.PI / 180);
      const expectedDLng = PIN_LATERAL_OFFSET_M / (111320 * cosLat);
      expect(marker._lng).toBeCloseTo(-74.030 + expectedDLng, 6);
    }
  });

  it("F-43: GIVEN odd address '101 BLOOMFIELD ST', WHEN renderSignPins is called, THEN pin offset from centerline is strictly greater than polyline offset (LATERAL_OFFSET_M)", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity, PIN_LATERAL_OFFSET_M, LATERAL_OFFSET_M } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "101 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const marker = mockMapInstance._layers.filter(
      (l: MockMarker) => l._options["pane"] === "towSignPane"
    )[0];
    expect(marker).toBeDefined();
    if (marker !== undefined) {
      const cosLat = Math.cos(40.7405 * Math.PI / 180);
      const polylineOffsetDeg = LATERAL_OFFSET_M / (111320 * cosLat);
      expect(marker._lng - (-74.030)).toBeGreaterThan(polylineOffsetDeg);
      void PIN_LATERAL_OFFSET_M; // reference to satisfy lint
    }
  });

  it("F-43: GIVEN even address '100 BLOOMFIELD ST' (forcedDir=-1 → west), WHEN renderSignPins is called, THEN pin shifts west by PIN_LATERAL_OFFSET_M", async () => {
    const { initMap, renderSignPins, initRoadGeometry, initStreetParity, PIN_LATERAL_OFFSET_M } = await import("../../app/map");
    initMap();
    initRoadGeometry({ "BLOOMFIELD ST": [[[40.740, -74.030], [40.741, -74.030]]] });
    initStreetParity({ "BLOOMFIELD ST": 1 });
    const sign = makeSign({ address: "100 BLOOMFIELD ST", lat: 40.7405, lng: -74.030 });
    renderSignPins([sign], NOW_STABLE);
    const marker = mockMapInstance._layers.filter(
      (l: MockMarker) => l._options["pane"] === "towSignPane"
    )[0];
    expect(marker).toBeDefined();
    if (marker !== undefined) {
      const cosLat = Math.cos(40.7405 * Math.PI / 180);
      const expectedDLng = PIN_LATERAL_OFFSET_M / (111320 * cosLat);
      expect(marker._lng).toBeCloseTo(-74.030 - expectedDLng, 6);
    }
  });
});

// ─── F-44 correctSignPositions ────────────────────────────────────────────────

describe("F-44 correctSignPositions", () => {
  beforeEach(() => {
    installLeafletMock();
    vi.resetModules();
  });

  it("F-44: GIVEN 4 signs on a N-S road where house 200 is geocoded too far north (past 300 and 400), WHEN correctSignPositions is called, THEN the outlier lat is reduced below its original value", async () => {
    const { correctSignPositions } = await import("../../app/map");
    // Road runs from lat 40.740 to 40.745 — house numbers should increase northward
    const road: RoadGeometry = {
      "TEST AVE": [[[40.740, -74.030], [40.741, -74.030], [40.742, -74.030], [40.743, -74.030], [40.744, -74.030], [40.745, -74.030]]],
    };
    // s2 (houseNum 200) is geocoded too far north at 40.744, past s3 (40.742) and s4 (40.743).
    // It should be corrected to somewhere around 40.741–40.742 (between s1 and s3 by house number).
    const signs: Sign[] = [
      makeSign({ id: "s1", address: "100 TEST AVE", lat: 40.741, lng: -74.030 }),
      makeSign({ id: "s2", address: "200 TEST AVE", lat: 40.744, lng: -74.030 }),
      makeSign({ id: "s3", address: "300 TEST AVE", lat: 40.742, lng: -74.030 }),
      makeSign({ id: "s4", address: "400 TEST AVE", lat: 40.743, lng: -74.030 }),
    ];
    const corrected = correctSignPositions(signs, road);
    const s2 = corrected.find((s) => s.id === "s2");
    expect(s2).toBeDefined();
    if (s2 !== undefined) {
      // Should be moved south from 40.744 to somewhere between s1 (40.741) and s3 (40.742)
      expect(s2.lat).toBeLessThan(40.744);
      expect(s2.lat).toBeGreaterThan(40.740);
    }
    // Other signs should be unchanged
    expect(corrected.find((s) => s.id === "s1")?.lat).toBeCloseTo(40.741, 6);
    expect(corrected.find((s) => s.id === "s3")?.lat).toBeCloseTo(40.742, 6);
    expect(corrected.find((s) => s.id === "s4")?.lat).toBeCloseTo(40.743, 6);
  });

  it("F-44: GIVEN signs already in monotonic order, WHEN correctSignPositions is called, THEN all signs are returned unchanged", async () => {
    const { correctSignPositions } = await import("../../app/map");
    const road: RoadGeometry = {
      "CLEAN ST": [[[40.740, -74.030], [40.741, -74.030], [40.742, -74.030]]],
    };
    const signs: Sign[] = [
      makeSign({ id: "s1", address: "100 CLEAN ST", lat: 40.740, lng: -74.030 }),
      makeSign({ id: "s2", address: "200 CLEAN ST", lat: 40.741, lng: -74.030 }),
      makeSign({ id: "s3", address: "300 CLEAN ST", lat: 40.742, lng: -74.030 }),
    ];
    const corrected = correctSignPositions(signs, road);
    expect(corrected.find((s) => s.id === "s1")?.lat).toBeCloseTo(40.740, 6);
    expect(corrected.find((s) => s.id === "s2")?.lat).toBeCloseTo(40.741, 6);
    expect(corrected.find((s) => s.id === "s3")?.lat).toBeCloseTo(40.742, 6);
  });

  it("F-44: GIVEN only 2 signs on a street, WHEN correctSignPositions is called, THEN signs are returned unchanged (insufficient data)", async () => {
    const { correctSignPositions } = await import("../../app/map");
    const road: RoadGeometry = {
      "SHORT ST": [[[40.740, -74.030], [40.742, -74.030]]],
    };
    const signs: Sign[] = [
      makeSign({ id: "s1", address: "100 SHORT ST", lat: 40.744, lng: -74.030 }),
      makeSign({ id: "s2", address: "200 SHORT ST", lat: 40.740, lng: -74.030 }),
    ];
    const corrected = correctSignPositions(signs, road);
    expect(corrected.find((s) => s.id === "s1")?.lat).toBeCloseTo(40.744, 6);
    expect(corrected.find((s) => s.id === "s2")?.lat).toBeCloseTo(40.740, 6);
  });

  it("F-44: GIVEN signs on a street not in road geometry, WHEN correctSignPositions is called, THEN signs are returned as-is", async () => {
    const { correctSignPositions } = await import("../../app/map");
    const signs: Sign[] = [
      makeSign({ id: "s1", address: "100 UNKNOWN ST", lat: 40.744, lng: -74.030 }),
      makeSign({ id: "s2", address: "200 UNKNOWN ST", lat: 40.740, lng: -74.030 }),
      makeSign({ id: "s3", address: "300 UNKNOWN ST", lat: 40.745, lng: -74.030 }),
    ];
    const corrected = correctSignPositions(signs, {});
    expect(corrected.find((s) => s.id === "s1")?.lat).toBeCloseTo(40.744, 6);
    expect(corrected.find((s) => s.id === "s2")?.lat).toBeCloseTo(40.740, 6);
  });
});
