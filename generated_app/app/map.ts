/**
 * app/map.ts — F-07 / F-07.6
 *
 * The ONLY file in this project that may touch the Leaflet `L.*` global.
 * All other modules must not import Leaflet.
 *
 * Leaflet is loaded via CDN in index.html and is available as `window.L`.
 * In Node tests the global `L` is mocked before this module is imported.
 */

import type { Sign, StreetCleaningEntry, RoadGeometry, Garage, SnowRoute } from "../shared/types";
import type { SavedSpot } from "../shared/storage";
import { formatTime, isScheduleActiveNow, isScheduleUpcomingSoon, isSignActive } from "../shared/parking-logic";
import { track } from "./analytics";

// ─── Leaflet type shim ───────────────────────────────────────────────────────
// We access L as a global (not an import) because it is loaded via CDN.
// Provide a minimal structural type so TypeScript can check our calls.

interface LeafletLatLng {
  lat: number;
  lng: number;
}

interface LeafletLayer {
  remove(): void;
  bindPopup(html: string): LeafletLayer;
  openPopup(): LeafletLayer;
  on(event: string, handler: (e: unknown) => void): LeafletLayer;
  addTo(map: LeafletMap): LeafletLayer;
}

interface LeafletPopup {
  setLatLng(latlng: [number, number]): LeafletPopup;
  setContent(html: string): LeafletPopup;
  openOn(map: LeafletMap): LeafletPopup;
  remove(): void;
}

interface LeafletMap {
  setView(center: [number, number], zoom: number): LeafletMap;
  panTo(center: [number, number]): LeafletMap;
  getCenter(): LeafletLatLng;
  getZoom(): number;
  on(event: string, handler: (e: unknown) => void): LeafletMap;
  off(event: string): LeafletMap;
  closePopup(): LeafletMap;
  createPane(name: string): HTMLElement;
  getPane(name: string): HTMLElement | undefined;
}

interface LeafletCircleMarker extends LeafletLayer {
  setRadius(radius: number): void;
}

interface LeafletIcon {
  _html: string;
}

interface LeafletMarkerOptions {
  icon: LeafletIcon;
  pane?: string;
}

interface LeafletStatic {
  map(elementId: string): LeafletMap;
  tileLayer(
    urlTemplate: string,
    options: { attribution: string; maxZoom: number }
  ): LeafletLayer;
  circleMarker(
    latlng: [number, number],
    options: Record<string, unknown>
  ): LeafletCircleMarker;
  marker(
    latlng: [number, number],
    options: LeafletMarkerOptions
  ): LeafletLayer;
  divIcon(options: {
    html: string;
    className: string;
    iconSize: [number, number];
    iconAnchor: [number, number];
  }): LeafletIcon;
  popup(): LeafletPopup;
  polyline(
    latlngs: [number, number][],
    options: { color: string; weight: number; opacity: number }
  ): LeafletLayer;
  createPane?(name: string): HTMLElement;
  getPane?(name: string): HTMLElement | undefined;
}

function getL(): LeafletStatic {
  return (globalThis as Record<string, unknown>)["L"] as LeafletStatic;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _map: LeafletMap | null = null;
let _signLayers: LeafletLayer[] = [];
let _segmentLayers: LeafletLayer[] = [];
let _towSignsVisible: boolean = true;
let _positionMarker: LeafletCircleMarker | null = null;
let _spotMarker: LeafletCircleMarker | null = null;
let _streetPopup: LeafletPopup | null = null;
let _popupHighlightToken = 0;
let _roadGeometry: RoadGeometry = {};
let _violationLayers: LeafletLayer[] = [];
let _violationHighlightsVisible = true;
let _upcomingSignLayers: LeafletLayer[] = [];
let _upcomingSegmentLayers: LeafletLayer[] = [];
let _upcomingSignsVisible: boolean = false;
let _garageLayers: LeafletLayer[] = [];
let _garageMarkersVisible: boolean = true;
let _snowRouteLayers: LeafletLayer[] = [];
let _snowRoutesVisible: boolean = true;
let _streetParity: Record<string, 1 | -1> = {};
let _lastCleaningEntries: StreetCleaningEntry[] = [];
let _lastNowForHighlights: Date | null = null;
const DEFAULT_ZOOM = 15;

function dotScale(): number {
  if (_map === null) return 1;
  return Math.max(0.6, Math.min(3, Math.pow(1.25, _map.getZoom() - DEFAULT_ZOOM)));
}

// ─── Tow sign dot icons ───────────────────────────────────────────────────────

export const LATERAL_OFFSET_M = 4.0;
export const PIN_LATERAL_OFFSET_M = 18.0;
const CLEANING_LANE_WIDTH_M = 3.5;
const HOBOKEN_COS_LAT = Math.cos(40.744 * Math.PI / 180);

const SPOT_COLOR = "#1d6fe3"; // blue — visually distinct from sign markers
const POSITION_BASE_RADIUS = 7;
const SPOT_BASE_RADIUS = 10;

// ─── F-10.3 signEmoji ─────────────────────────────────────────────────────────

const KNOWN_REASONS: readonly string[] = ["CONSTRUCTION", "MOVING", "EVENT", "DELIVERY"];

/**
 * Returns the tow sign marker HTML.
 * Known reasons → filled red circle with "!"
 * Unknown reason → hollow red ring (fallback)
 * active=false → orange tint for upcoming signs
 */
export function signEmoji(reason: string, active = true): string {
  const c = active ? "#cc0000" : "#e05a00";
  if (!KNOWN_REASONS.includes(reason)) {
    // Hollow ring fallback for unrecognized reasons
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="13" height="13" class="tow-sign-emoji">` +
      `<circle cx="10" cy="10" r="8" fill="none" stroke="#dc2626" stroke-width="2"/>` +
      `<text x="10" y="15" text-anchor="middle" font-size="13" font-weight="900" fill="#dc2626" font-family="Arial Black,Impact,sans-serif">!</text>` +
      `</svg>`
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="13" height="13" class="tow-sign-emoji">` +
    `<circle cx="10" cy="10" r="10" fill="${c}"/>` +
    `<text x="10" y="15" text-anchor="middle" font-size="13" font-weight="900" fill="white" font-family="Arial Black,Impact,sans-serif">!</text>` +
    `</svg>`
  );
}

// ─── F-35 Upcoming sign icon ──────────────────────────────────────────────────

const UPCOMING_SIGN_ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="20" height="20">` +
  `<circle cx="50" cy="50" r="43" fill="none" stroke="#f97316" stroke-width="13"/>` +
  `<text x="50" y="70" text-anchor="middle" font-family="Arial Black,Impact,sans-serif" font-size="62" font-weight="900" fill="#1a1a1a">P</text>` +
  `<rect x="-8" y="44" width="116" height="11" rx="5" fill="#f97316" transform="rotate(-35 50 50)"/>` +
  `</svg>`;

// ─── F-07.1 initMap ───────────────────────────────────────────────────────────

/**
 * Initialize a Leaflet map on the `#map` element.
 * Centers on Hoboken (40.7440, -74.0324), zoom 15.
 */
export function initMap(): LeafletMap {
  const L = getL();
  const map = L.map("map");
  map.setView([40.744, -74.0324], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  // Reset module state for this map instance
  _map = map;
  _signLayers = [];
  _segmentLayers = [];
  _towSignsVisible = true;
  _positionMarker = null;
  _spotMarker = null;
  _streetPopup = null;
  _roadGeometry = {};
  _violationLayers = [];
  _violationHighlightsVisible = true;
  _upcomingSignLayers = [];
  _upcomingSegmentLayers = [];
  _upcomingSignsVisible = false;
  _garageLayers = [];
  _garageMarkersVisible = true;
  _snowRouteLayers = [];
  _snowRoutesVisible = true;
  _streetParity = {};
  _lastCleaningEntries = [];
  _lastNowForHighlights = null;
  map.createPane('towSignPane');
  const towSignPaneEl = map.getPane('towSignPane');
  if (towSignPaneEl !== undefined) towSignPaneEl.style.zIndex = '600';
  map.createPane('upcomingPane');
  const upcomingPaneEl = map.getPane('upcomingPane');
  if (upcomingPaneEl !== undefined) upcomingPaneEl.style.zIndex = '550';

  // Scale tow icons proportionally with zoom — each level doubles map detail
  const updateIconScale = () => {
    const zoom = map.getZoom();
    const towScale = Math.max(1, Math.min(4, Math.pow(1.4, zoom - DEFAULT_ZOOM)));
    if (typeof document !== "undefined") {
      const mapEl = document.getElementById("map");
      if (mapEl !== null) {
        mapEl.style.setProperty("--tow-icon-scale", String(towScale));
      }
    }
    const ds = dotScale();
    if (_positionMarker !== null) {
      _positionMarker.setRadius(Math.round(POSITION_BASE_RADIUS * ds));
    }
    if (_spotMarker !== null) {
      _spotMarker.setRadius(Math.round(SPOT_BASE_RADIUS * ds));
    }
    if (_streetPopup !== null) {
      _streetPopup.remove();
      _streetPopup.openOn(map);
    }
  };
  let _zoomDebounce: ReturnType<typeof setTimeout> | null = null;
  map.on("zoomend", () => {
    updateIconScale();
    if (_lastNowForHighlights !== null) {
      renderViolationHighlights(_lastCleaningEntries, _lastNowForHighlights);
    }
    if (_zoomDebounce !== null) clearTimeout(_zoomDebounce);
    _zoomDebounce = setTimeout(() => {
      track("map-zoomed", { zoom_level: map.getZoom() });
    }, 300);
  });

  return map;
}

// ─── F-07.2 renderSignPins ────────────────────────────────────────────────────

/**
 * Place one circle marker per sign, colored by reason.
 * Clears previous sign pins before rendering the new set.
 * The `now` parameter is accepted per spec signature (reserved for future
 * time-conditional filtering) but sign visibility is determined by the caller.
 */
export function renderSignPins(signs: Sign[], now: Date): void {
  if (_map === null) return;

  // Remove existing sign layers
  for (const layer of _signLayers) {
    layer.remove();
  }
  _signLayers = [];

  const L = getL();

  for (const sign of signs) {
    const icon = signEmoji(sign.reason);
    const pos = getSnappedPinPosition(sign);

    const marker = L.marker(pos, {
      icon: L.divIcon({
        html: icon,
        className: "sign-emoji-marker",
        iconSize: [13, 13],
        iconAnchor: [6, 6],
      }),
      pane: 'towSignPane',
    });

    const popupHtml = buildSignPopup(sign, now);
    marker.bindPopup(popupHtml);
    marker.on("click", () => {
      marker.openPopup();
    });

    if (_towSignsVisible) {
      marker.addTo(_map);
    }
    _signLayers.push(marker);
  }
}

const REASON_LABELS: Record<string, string> = {
  CONSTRUCTION: "🏗 Construction",
  MOVING:       "🚚 Moving",
  EVENT:        "🎉 Event",
  DELIVERY:     "📦 Delivery",
};

function formatSignDateTime(dateStr: string, timeStr: string): string {
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const dp = dateStr.split("/");
  const month = MONTHS[parseInt(dp[0] ?? "1", 10) - 1] ?? "";
  const day   = parseInt(dp[1] ?? "1", 10);
  const tp    = timeStr.split(":");
  const h     = parseInt(tp[0] ?? "0", 10);
  const min   = parseInt(tp[1] ?? "0", 10);
  const ampm  = h >= 12 ? "pm" : "am";
  const h12   = h % 12 === 0 ? 12 : h % 12;
  const time  = min === 0 ? `${h12}${ampm}` : `${h12}:${String(min).padStart(2, "0")}${ampm}`;
  return `${month} ${day}  ${time}`;
}

function buildSignPopup(sign: Sign, now: Date): string {
  const startMs = new Date(sign.start_iso).getTime();
  const endMs   = new Date(sign.end_iso).getTime();
  const nowMs   = now.getTime();

  const active   = isSignActive(sign, now);
  const upcoming = !active && startMs > nowMs
                 && (startMs - nowMs) <= 60 * 60 * 1000
                 && endMs > nowMs;

  const reasonLabel = REASON_LABELS[sign.reason] ?? sign.reason;
  const reasonClass = `tz-reason--${sign.reason.toLowerCase()}`;

  const startFmt = formatSignDateTime(sign.start_date, sign.start_time);
  const endFmt   = formatSignDateTime(sign.stop_date, sign.end_time);

  const activeHtml   = active
    ? `<div class="tz-status tz-status--active">Active Now!</div>`
    : "";
  const upcomingHtml = upcoming
    ? `<div class="tz-status tz-status--upcoming">Starts in ${Math.floor((startMs - nowMs) / 60_000)}m — ${startFmt}</div>`
    : "";

  return [
    `<div class="tz-wrap">`,
    `<div class="tz-header"><span class="tz-icon">🚨</span><span class="tz-title">TOW&nbsp;ZONE $$</span></div>`,
    activeHtml,
    `<hr class="tz-sep"/>`,
    `<div class="tz-address">${sign.address}</div>`,
    `<div class="tz-reason ${reasonClass}">${reasonLabel}</div>`,
    upcomingHtml,
    `<div class="tz-window">${startFmt} – ${endFmt}</div>`,
    `<div class="tz-permit">Permit ${sign.permit_number}</div>`,
    `</div>`,
  ].join("");
}

// ─── F-07.3 renderPositionMarker / clearPositionMarker ────────────────────────

/**
 * Render a small blue circle at the tapped coordinates.
 * Replaces any existing position marker.
 */
export function renderPositionMarker(lat: number, lng: number): void {
  if (_map === null) return;

  if (_positionMarker !== null) {
    _positionMarker.remove();
    _positionMarker = null;
  }

  const L = getL();
  const marker = L.circleMarker([lat, lng], {
    radius: Math.round(POSITION_BASE_RADIUS * dotScale()),
    fillColor: "#2b6cb0",
    color: "#ffffff",
    weight: 2,
    opacity: 1,
    fillOpacity: 0.9,
  });

  marker.addTo(_map);
  _positionMarker = marker;
}

/** Remove the position marker if present. */
export function clearPositionMarker(): void {
  if (_positionMarker !== null) {
    _positionMarker.remove();
    _positionMarker = null;
  }
}

// ─── F-07.4 renderSpotMarker / clearSpotMarker ────────────────────────────────

/**
 * Render a visually distinct marker at the saved spot's coordinates.
 */
export function renderSpotMarker(spot: SavedSpot): void {
  if (_map === null) return;

  if (_spotMarker !== null) {
    _spotMarker.remove();
    _spotMarker = null;
  }

  const L = getL();
  const marker = L.circleMarker([spot.lat, spot.lng], {
    radius: Math.round(SPOT_BASE_RADIUS * dotScale()),
    fillColor: SPOT_COLOR,
    color: "#ffffff",
    weight: 2,
    opacity: 1,
    fillOpacity: 0.95,
  });

  marker.addTo(_map);
  _spotMarker = marker;
}

/** Remove the saved spot marker if present. */
export function clearSpotMarker(): void {
  if (_spotMarker !== null) {
    _spotMarker.remove();
    _spotMarker = null;
  }
}

// ─── F-07.5 centerOnSpot / registerMapClickHandler ───────────────────────────

/**
 * Pan the map to the saved spot's coordinates without changing zoom.
 */
export function centerOnSpot(spot: SavedSpot): void {
  if (_map === null) return;
  _map.panTo([spot.lat, spot.lng]);
}

/**
 * Attach a click listener to the map.
 * Subsequent calls replace the previous listener (no double-firing).
 */
export function registerMapClickHandler(
  callback: (lat: number, lng: number) => void
): void {
  if (_map === null) return;
  _map.off("click");
  _map.on("click", (e) => {
    const ev = e as { latlng: LeafletLatLng };
    callback(ev.latlng.lat, ev.latlng.lng);
  });
}

// ─── F-07.6 showStreetPopup ───────────────────────────────────────────────────

/**
 * Format a location string like "9th St. to 10th St." into
 * "between 9th St and 10th St" for display in the popup header.
 *
 * Strips trailing periods from each part (e.g. "St." → "St").
 */
function formatLocation(location: string): string {
  const parts = location.split(" to ");
  if (parts.length !== 2) {
    return location;
  }
  const from = (parts[0] ?? "").trim().replace(/\.$/, "");
  const to = (parts[1] ?? "").trim().replace(/\.$/, "");
  return `between ${from} and ${to}`;
}

function directionBadge(side: string): string {
  const s = side.toLowerCase();
  if (s === "north") return `<span class="dir-badge dir-n">N</span>`;
  if (s === "south") return `<span class="dir-badge dir-s">S</span>`;
  if (s === "east")  return `<span class="dir-badge dir-e">E</span>`;
  if (s === "west")  return `<span class="dir-badge dir-w">W</span>`;
  return `<span class="dir-badge dir-other">${side.charAt(0).toUpperCase()}</span>`;
}

function buildStreetPopupContent(
  streetName: string,
  entries: StreetCleaningEntry[],
  highlightedLocations?: string[],
  now?: Date
): string {
  if (entries.length === 0) {
    return `<div class="sp-wrap"><div class="sp-header"><span class="sp-icon">🧹</span><span class="sp-label">Street Cleaning</span><span class="sp-icon sp-icon-ghost">🧹</span></div><div class="sp-street">${streetName}</div><div class="sp-loc-label"><em>No cleaning schedule found</em></div></div>`;
  }

  const activeSet = new Set(highlightedLocations ?? []);

  // Collect unique locations in insertion order
  const locationOrder: string[] = [];
  const byLocation = new Map<string, StreetCleaningEntry[]>();
  for (const entry of entries) {
    if (!byLocation.has(entry.location)) {
      locationOrder.push(entry.location);
      byLocation.set(entry.location, []);
    }
    (byLocation.get(entry.location) as StreetCleaningEntry[]).push(entry);
  }

  const parts: string[] = [];
  parts.push(`<div class="sp-wrap">`);
  parts.push(`<div class="sp-header"><span class="sp-icon">🧹</span><span class="sp-label">Street Cleaning</span><span class="sp-icon sp-icon-ghost">🧹</span></div>`);
  parts.push(`<div class="sp-street">${streetName}</div>`);

  for (let i = 0; i < locationOrder.length; i++) {
    if (i > 0) parts.push(`<hr class="sp-sep"/>`);
    const location = locationOrder[i];
    const locationEntries = byLocation.get(location) as StreetCleaningEntry[];
    const blockContext = formatLocation(location);
    const isActive = activeSet.size > 0 && activeSet.has(location);
    const blockClass = isActive ? `sp-block sp-block--active` : `sp-block`;
    parts.push(`<div class="${blockClass}">`);
    parts.push(`<div class="sp-loc-label">${streetName} ${blockContext}</div>`);
    for (const entry of locationEntries) {
      const schedActive   = now !== undefined && isScheduleActiveNow(entry.schedule, now);
      const schedUpcoming = !schedActive && now !== undefined && isScheduleUpcomingSoon(entry.schedule, now);
      const schedClass = schedActive   ? "sp-sched sp-sched--active"
                       : schedUpcoming ? "sp-sched sp-sched--upcoming"
                       : "sp-sched";
      parts.push(`<div class="sp-entry">${directionBadge(entry.side)}<span class="${schedClass}">${entry.schedule}</span></div>`);
    }
    parts.push(`</div>`);
  }

  parts.push(`</div>`);
  return parts.join("");
}

// ─── F-24 initRoadGeometry / getSubsegment ────────────────────────────────────

/**
 * Store the road geometry data fetched from data/road-geometry.json.
 * Called once during app initialization after the file is fetched.
 */
export function initRoadGeometry(data: RoadGeometry): void {
  _roadGeometry = data;
}

/**
 * Store the street-parity data fetched from data/street-parity.json.
 * Maps normalized street name keys to which perpendicular direction (1 | -1)
 * holds odd-numbered addresses.
 */
export function initStreetParity(data: Record<string, 1 | -1>): void {
  _streetParity = data;
}

/**
 * Given an array of ways (each way is an ordered array of [lat, lng] pairs),
 * project [signLat, signLng] perpendicularly onto the nearest road segment and
 * return a subsegment of halfLengthM on each side of that projected point.
 *
 * Using the nearest segment projection (rather than nearest waypoint) ensures
 * the result is centred under the sign even when OSM nodes are sparsely placed.
 * Uses flat-earth distance with cos(lat) correction for longitude.
 *
 * Falls back to a 2-point N-S segment centred on [signLat, signLng] if:
 * - ways is empty / all ways have fewer than 2 points
 * - the result is degenerate (< 2 points)
 */
export function getSubsegment(
  ways: [number, number][][],
  signLat: number,
  signLng: number,
  halfLengthM = 9
): [number, number][] {
  const cosLat = Math.cos(signLat * Math.PI / 180);
  const NS_FALLBACK: [number, number][] = [
    [signLat - halfLengthM / 111320, signLng],
    [signLat + halfLengthM / 111320, signLng],
  ];

  if (ways.length === 0) return NS_FALLBACK;

  // Step 1 — find nearest projected point on any road segment
  let bestWayIdx = -1;
  let bestSegIdx = -1;
  let bestT = 0;
  let bestDist = Infinity;
  let projPt: [number, number] = [signLat, signLng];

  for (let wi = 0; wi < ways.length; wi++) {
    const way = ways[wi];
    if (way === undefined) continue;
    for (let si = 0; si < way.length - 1; si++) {
      const A = way[si];
      const B = way[si + 1];
      if (A === undefined || B === undefined) continue;
      const ax = (A[0] - signLat) * 111320;
      const ay = (A[1] - signLng) * 111320 * cosLat;
      const bx = (B[0] - signLat) * 111320;
      const by = (B[1] - signLng) * 111320 * cosLat;
      const abx = bx - ax;
      const aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      if (ab2 === 0) continue;
      const t = Math.max(0, Math.min(1, -(ax * abx + ay * aby) / ab2));
      const px = ax + t * abx;
      const py = ay + t * aby;
      const d = Math.sqrt(px * px + py * py);
      if (d < bestDist) {
        bestDist = d;
        bestWayIdx = wi;
        bestSegIdx = si;
        bestT = t;
        projPt = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])];
      }
    }
  }

  if (bestWayIdx === -1) return NS_FALLBACK;

  // If the sign is more than 50 m from the nearest road segment (e.g. an
  // out-of-borough address that shares a street name with a Hoboken road),
  // return [] so renderTowSegments can use the orientation-correct heuristic
  // at the sign's actual GPS location instead of snapping to the wrong block.
  const MAX_SNAP_M = 75;
  if (bestDist > MAX_SNAP_M) return [];

  const bestWay = ways[bestWayIdx];
  if (bestWay === undefined || bestWay.length < 2) return NS_FALLBACK;

  const segA = bestWay[bestSegIdx];
  const segB = bestWay[bestSegIdx + 1];
  if (segA === undefined || segB === undefined) return NS_FALLBACK;

  const segLen = (() => {
    const dlat = (segB[0] - segA[0]) * 111320;
    const dlng = (segB[1] - segA[1]) * 111320 * cosLat;
    return Math.sqrt(dlat * dlat + dlng * dlng);
  })();
  if (segLen === 0) return NS_FALLBACK;

  // Step 2 — walk backward halfLengthM from projPt along the way
  const backward: [number, number][] = [];
  let accBackward = 0;
  let backwardDone = false;

  if (bestT > 0) {
    const backSegLen = bestT * segLen;
    if (backSegLen >= halfLengthM) {
      const endT = bestT - halfLengthM / segLen;
      backward.push([segA[0] + endT * (segB[0] - segA[0]), segA[1] + endT * (segB[1] - segA[1])]);
      backwardDone = true;
    } else {
      accBackward = backSegLen;
      backward.push(segA);
    }
  }

  if (!backwardDone) {
    for (let pi = bestSegIdx - 1; pi >= 0; pi--) {
      const cur = bestWay[pi];
      const nxt = bestWay[pi + 1];
      if (cur === undefined || nxt === undefined) break;
      const dlat = (cur[0] - nxt[0]) * 111320;
      const dlng = (cur[1] - nxt[1]) * 111320 * cosLat;
      const sLen = Math.sqrt(dlat * dlat + dlng * dlng);
      const remaining = halfLengthM - accBackward;
      if (sLen >= remaining) {
        const t = remaining / sLen;
        backward.push([nxt[0] + (cur[0] - nxt[0]) * t, nxt[1] + (cur[1] - nxt[1]) * t]);
        break;
      }
      accBackward += sLen;
      backward.push(cur);
    }
  }

  // Step 3 — walk forward halfLengthM from projPt along the way
  const forward: [number, number][] = [];
  let accForward = 0;
  let forwardDone = false;

  if (bestT < 1) {
    const fwdSegLen = (1 - bestT) * segLen;
    if (fwdSegLen >= halfLengthM) {
      const endT = bestT + halfLengthM / segLen;
      forward.push([segA[0] + endT * (segB[0] - segA[0]), segA[1] + endT * (segB[1] - segA[1])]);
      forwardDone = true;
    } else {
      accForward = fwdSegLen;
      forward.push(segB);
    }
  }

  if (!forwardDone) {
    for (let pi = bestSegIdx + 2; pi < bestWay.length; pi++) {
      const cur = bestWay[pi];
      const prev = bestWay[pi - 1];
      if (cur === undefined || prev === undefined) break;
      const dlat = (cur[0] - prev[0]) * 111320;
      const dlng = (cur[1] - prev[1]) * 111320 * cosLat;
      const sLen = Math.sqrt(dlat * dlat + dlng * dlng);
      const remaining = halfLengthM - accForward;
      if (sLen >= remaining) {
        const t = remaining / sLen;
        forward.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
        break;
      }
      accForward += sLen;
      forward.push(cur);
    }
  }

  const result: [number, number][] = [...backward.reverse(), projPt, ...forward];

  if (result.length < 2) {
    return NS_FALLBACK;
  }

  return result;
}

// ─── F-25 offsetPolylinePoints ────────────────────────────────────────────────

/**
 * Shifts all points in `pts` perpendicular to the road direction toward the
 * sign's curb side, by `offsetM` metres.
 *
 * Uses a flat-earth dot-product test to determine which side of the road the
 * sign is on (left-perpendicular vs right-perpendicular). Returns `pts`
 * unchanged when:
 *   - pts.length < 2
 *   - first and last points are identical (len === 0)
 *   - sign is on the centreline (|dot| < 1e-9) and no forcedDir is provided
 *
 * When `forcedDir` is provided, the dot-product block is skipped entirely and
 * `forcedDir` is used directly as the offset direction. This bypasses the
 * |dot| < 1e-9 early-return guard that fires when the sign GPS is on the
 * road centreline (the common case for permit-API geocoded addresses).
 */
export function offsetPolylinePoints(
  pts: [number, number][],
  signLat: number,
  signLng: number,
  offsetM: number,
  forcedDir?: 1 | -1
): [number, number][] {
  if (pts.length < 2) return pts;

  const first = pts[0];
  const last = pts[pts.length - 1];

  const cosLat = Math.cos(signLat * Math.PI / 180);

  // Road direction vector (first → last) in flat-earth metres
  const dY = (last[0] - first[0]) * 111320;
  const dX = (last[1] - first[1]) * 111320 * cosLat;
  const len = Math.sqrt(dY * dY + dX * dX);

  if (len === 0) return pts;

  // Right-perpendicular unit vector (90° CW from road direction in east/north space)
  // dir=1 shifts toward increasing longitude (east for a N-S road)
  const perpX_m = dY / len;    // east component
  const perpY_m = -dX / len;   // north component

  let dir: 1 | -1;
  if (forcedDir !== undefined) {
    dir = forcedDir;
  } else {
    // Sign displacement from segment midpoint
    const midLat = (first[0] + last[0]) / 2;
    const midLng = (first[1] + last[1]) / 2;
    const signDY = (signLat - midLat) * 111320;
    const signDX = (signLng - midLng) * 111320 * cosLat;

    // Dot product determines side
    const dot = signDX * perpX_m + signDY * perpY_m;

    if (Math.abs(dot) < 1e-9) return pts;

    dir = dot > 0 ? 1 : -1;
  }

  // Apply per-point local-tangent offset so curved roads stay within the road at all zoom levels
  return pts.map(([lat, lng], i): [number, number] => {
    let tY: number;
    let tX: number;
    if (i === 0) {
      tY = (pts[1][0] - pts[0][0]) * 111320;
      tX = (pts[1][1] - pts[0][1]) * 111320 * cosLat;
    } else if (i === pts.length - 1) {
      tY = (pts[i][0] - pts[i - 1][0]) * 111320;
      tX = (pts[i][1] - pts[i - 1][1]) * 111320 * cosLat;
    } else {
      const aY = (pts[i][0] - pts[i - 1][0]) * 111320;
      const aX = (pts[i][1] - pts[i - 1][1]) * 111320 * cosLat;
      const aLen = Math.sqrt(aY * aY + aX * aX);
      const bY = (pts[i + 1][0] - pts[i][0]) * 111320;
      const bX = (pts[i + 1][1] - pts[i][1]) * 111320 * cosLat;
      const bLen = Math.sqrt(bY * bY + bX * bX);
      tY = (aLen > 0 ? aY / aLen : 0) + (bLen > 0 ? bY / bLen : 0);
      tX = (aLen > 0 ? aX / aLen : 0) + (bLen > 0 ? bX / bLen : 0);
    }
    const tLen = Math.sqrt(tY * tY + tX * tX);
    if (tLen === 0) return [lat, lng];
    const lPerpX_m = tY / tLen;
    const lPerpY_m = -tX / tLen;
    const dLat = dir * offsetM * lPerpY_m / 111320;
    const dLng = dir * offsetM * lPerpX_m / (111320 * cosLat);
    return [lat + dLat, lng + dLng];
  });
}

// ─── F-23 / F-24 renderTowSegments ───────────────────────────────────────────

/**
 * Draw two overlapping polylines (white outer + red inner casing) for each
 * sign, marking the road segment where parking is restricted.
 *
 * Segment half-length scales with the sign's address range so that a sign
 * covering a narrow span (e.g. "819-821") draws a short segment (~2 buildings)
 * while a wide-span sign (e.g. "700-740") draws a proportionally longer one.
 * Formula: halfLengthM = max(5, (addrRange / 2 + 1) * 4).
 *
 * Uses OSM road-centerline geometry if available (via initRoadGeometry),
 * otherwise falls back to the E-W/N-S heuristic centred on the sign.
 *
 * Casing is always 2 polylines per sign: _segmentLayers.length === signs.length * 2.
 *
 * Clears previous segment layers before rendering the new set.
 * Note: stale references are dropped before the _map null guard so they are
 * cleared even when called before initMap().
 */

function getSnappedPinPosition(sign: Sign): [number, number] {
  const streetName = sign.address.replace(/^\d[\d-]*\s+/, "").trim();
  const ways = _roadGeometry[streetName];
  if (ways === undefined || ways.length === 0) return [sign.lat, sign.lng];

  const cosLat = Math.cos(sign.lat * Math.PI / 180);
  let bestDist = Infinity;
  let projPt: [number, number] = [sign.lat, sign.lng];
  let bestA: [number, number] = [sign.lat, sign.lng];
  let bestB: [number, number] = [sign.lat, sign.lng];

  for (const way of ways) {
    for (let si = 0; si < way.length - 1; si++) {
      const A = way[si];
      const B = way[si + 1];
      if (A === undefined || B === undefined) continue;
      const ax = (A[0] - sign.lat) * 111320;
      const ay = (A[1] - sign.lng) * 111320 * cosLat;
      const bx = (B[0] - sign.lat) * 111320;
      const by = (B[1] - sign.lng) * 111320 * cosLat;
      const abx = bx - ax;
      const aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      if (ab2 === 0) continue;
      const t = Math.max(0, Math.min(1, -(ax * abx + ay * aby) / ab2));
      const px = ax + t * abx;
      const py = ay + t * aby;
      const d = Math.sqrt(px * px + py * py);
      if (d < bestDist) {
        bestDist = d;
        projPt = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])];
        bestA = A;
        bestB = B;
      }
    }
  }

  // Move projPt to the arc midpoint of the tow segment so the pin sits at the
  // visual centre of the line rather than at the geocoded-address end.
  // tangentA/tangentB track the local road segment at the midpoint so the
  // perpendicular direction matches the actual road there, not the initial
  // nearest-segment endpoints which may be on a different part of the way.
  let tangentA: [number, number] = bestA;
  let tangentB: [number, number] = bestB;

  const addrMatchRange = sign.address.match(/^(\d+)-(\d+)\s+/);
  const addrRange = addrMatchRange
    ? Math.max(0, parseInt(addrMatchRange[2], 10) - parseInt(addrMatchRange[1], 10))
    : 0;
  const halfLengthM = Math.max(5, (addrRange / 2 + 1) * 4);
  const waypoints = getSubsegment(ways, sign.lat, sign.lng, halfLengthM);
  if (waypoints.length >= 2) {
    const cosLat0 = Math.cos(waypoints[0][0] * Math.PI / 180);
    let totalArc = 0;
    const segArcs: number[] = [0];
    for (let i = 1; i < waypoints.length; i++) {
      const dy = (waypoints[i][0] - waypoints[i - 1][0]) * 111320;
      const dx = (waypoints[i][1] - waypoints[i - 1][1]) * 111320 * cosLat0;
      totalArc += Math.sqrt(dy * dy + dx * dx);
      segArcs.push(totalArc);
    }
    const halfArc = totalArc / 2;
    for (let i = 1; i < waypoints.length; i++) {
      if (segArcs[i] >= halfArc) {
        const span = segArcs[i] - segArcs[i - 1];
        const frac = span > 0 ? (halfArc - segArcs[i - 1]) / span : 0;
        projPt = [
          waypoints[i - 1][0] + frac * (waypoints[i][0] - waypoints[i - 1][0]),
          waypoints[i - 1][1] + frac * (waypoints[i][1] - waypoints[i - 1][1]),
        ];
        tangentA = waypoints[i - 1];
        tangentB = waypoints[i];
        break;
      }
    }
  }

  // Apply lateral offset using the local road tangent at the arc midpoint.
  const cosLat2 = Math.cos(projPt[0] * Math.PI / 180);
  const dYseg = tangentB[0] - tangentA[0];
  const dXseg = (tangentB[1] - tangentA[1]) * cosLat2;
  const lenSeg = Math.sqrt(dYseg * dYseg + dXseg * dXseg);
  if (lenSeg > 0) {
    // Right-perpendicular unit vector (same convention as offsetPolylinePoints)
    const perpX = dYseg / lenSeg;   // east component
    const perpY = -dXseg / lenSeg;  // north component

    // Determine which side of the road the sign is on.
    // Primary: parity table lookup. Fallback: dot-product from geocoded coords.
    let dir: 1 | -1 | undefined;
    const numMatch = sign.address.match(/^(\d+)/);
    if (numMatch !== null) {
      const streetKey = normalizeToGeometryKey(
        sign.address.replace(/^\d[\d-]*\s+/, "").trim()
      );
      const oddDir = _streetParity[streetKey];
      if (oddDir !== undefined) {
        const isOdd = parseInt(numMatch[1], 10) % 2 === 1;
        dir = isOdd ? oddDir : (oddDir === 1 ? -1 : 1);
      }
    }
    // Fallback when street is absent from parity table: use sign's geocoded
    // position relative to the original road snap to determine curb side.
    if (dir === undefined) {
      const signDY = (sign.lat - projPt[0]) * 111320;
      const signDX = (sign.lng - projPt[1]) * 111320 * cosLat2;
      const dot = signDX * perpX + signDY * perpY;
      if (Math.abs(dot) >= 1e-9) {
        dir = dot > 0 ? 1 : -1;
      }
    }

    if (dir !== undefined) {
      projPt = [
        projPt[0] + dir * PIN_LATERAL_OFFSET_M * perpY / 111320,
        projPt[1] + dir * PIN_LATERAL_OFFSET_M * perpX / (111320 * cosLat2),
      ];
    }
  }

  return projPt;
}

export function renderTowSegments(signs: Sign[]): void {
  for (const layer of _segmentLayers) {
    layer.remove();
  }
  _segmentLayers = [];

  if (_map === null) return;
  const L = getL();

  for (const sign of signs) {
    // Scale segment half-length by address range (each unit ≈ 4 m of frontage)
    const addrMatch = sign.address.match(/^(\d+)-(\d+)\s+/);
    const addrRange = addrMatch
      ? Math.max(0, parseInt(addrMatch[2], 10) - parseInt(addrMatch[1], 10))
      : 0;
    const halfLengthM = Math.max(5, (addrRange / 2 + 1) * 4);

    // Extract street name from address (e.g. "1036-1036 BLOOMFIELD ST" → "BLOOMFIELD ST")
    const streetName = sign.address.replace(/^\d[\d-]*\s+/, "").trim();

    let waypoints: [number, number][] = [];

    const ways = _roadGeometry[streetName];
    if (ways !== undefined && ways.length > 0 && ways.some((w) => w.length > 0)) {
      waypoints = getSubsegment(ways, sign.lat, sign.lng, halfLengthM);
    }

    if (waypoints.length < 2) continue;

    const numMatch = sign.address.match(/^(\d+)/);
    let forcedDir: 1 | -1 | undefined;
    if (numMatch !== null) {
      const oddDir = _streetParity[normalizeToGeometryKey(streetName)];
      if (oddDir !== undefined) {
        const isOdd = parseInt(numMatch[1], 10) % 2 === 1;
        forcedDir = isOdd ? oddDir : (oddDir === 1 ? -1 : 1);
      }
    }
    waypoints = offsetPolylinePoints(waypoints, sign.lat, sign.lng, LATERAL_OFFSET_M, forcedDir);

    const outer = L.polyline(waypoints, { color: "#fff", weight: 7, opacity: 0.65 });
    const inner = L.polyline(waypoints, { color: "#cc0000", weight: 3, opacity: 0.85 });
    _segmentLayers.push(outer, inner);
    if (_towSignsVisible) {
      outer.addTo(_map);
      inner.addTo(_map);
    }
  }
}

// ─── F-legend setTowSignsVisible ─────────────────────────────────────────────

/**
 * Show or hide all tow sign markers and segment polylines.
 * Manages _signLayers and _segmentLayers explicitly (same pattern as garage/upcoming)
 * so non-tow markers (garage, position, spot) are unaffected.
 */
export function setTowSignsVisible(visible: boolean): void {
  _towSignsVisible = visible;
  if (_map === null) return;
  if (!visible) {
    _map.closePopup();
  }
  for (const layer of _signLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
  for (const layer of _segmentLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
}

// ─── F-34 Street Violation Highlights ────────────────────────────────────────

const ORDINAL_TO_NUMERIC: Record<string, string> = {
  FIRST: "1ST", SECOND: "2ND", THIRD: "3RD", FOURTH: "4TH",
  FIFTH: "5TH", SIXTH: "6TH", SEVENTH: "7TH", EIGHTH: "8TH",
  NINTH: "9TH", TENTH: "10TH", ELEVENTH: "11TH", TWELFTH: "12TH",
  THIRTEENTH: "13TH", FOURTEENTH: "14TH", FIFTEENTH: "15TH", SIXTEENTH: "16TH",
};

function normalizeToGeometryKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bHIGHWAY\b/g, "HWY")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bPLACE\b/g, "PL")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bTERRACE\b/g, "TER")
    .replace(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH|THIRTEENTH|FOURTEENTH|FIFTEENTH|SIXTEENTH)\b/g, m => ORDINAL_TO_NUMERIC[m] ?? m)
    .trim();
}

function mergeWays(ways: [number, number][][]): [number, number][][] {
  if (ways.length <= 1) return ways;
  const used = new Array<boolean>(ways.length).fill(false);
  const result: [number, number][][] = [];

  function ptEq(a: [number, number], b: [number, number]): boolean {
    return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  }

  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain: [number, number][] = [...ways[i]];

    let found = true;
    while (found) {
      found = false;
      for (let j = 0; j < ways.length; j++) {
        if (used[j]) continue;
        const w = ways[j];
        const end = chain[chain.length - 1];
        if (end !== undefined && w[0] !== undefined && ptEq(end, w[0])) {
          chain = chain.concat(w.slice(1));
          used[j] = true; found = true; break;
        }
        if (end !== undefined && w[w.length - 1] !== undefined && ptEq(end, w[w.length - 1])) {
          chain = chain.concat([...w].reverse().slice(1));
          used[j] = true; found = true; break;
        }
      }
    }

    found = true;
    while (found) {
      found = false;
      for (let j = 0; j < ways.length; j++) {
        if (used[j]) continue;
        const w = ways[j];
        const start = chain[0];
        if (start !== undefined && w[w.length - 1] !== undefined && ptEq(start, w[w.length - 1])) {
          chain = w.slice(0, -1).concat(chain);
          used[j] = true; found = true; break;
        }
        if (start !== undefined && w[0] !== undefined && ptEq(start, w[0])) {
          chain = [...w].reverse().slice(0, -1).concat(chain);
          used[j] = true; found = true; break;
        }
      }
    }

    result.push(chain);
  }
  return result;
}

function drawStreetHighlight(street: string, color: string, opacity: number, side: string | null): void {
  const ways = _roadGeometry[street];
  if (ways === undefined || ways.length === 0) return;
  const L = getL();
  const merged = mergeWays(ways);

  // Scale polyline weight and offset to fill the relevant lane at the current zoom.
  // tileBoost compensates for OSM tiles rendering roads at roughly constant pixel
  // width regardless of zoom: zoom 18 = geographic (1.0×), zoom 17 = 2.0×,
  // zoom ≤16 = 3.0×. Split curb is always used when side is specified — falling
  // back to centerline stacks both East+West layers and doubles opacity.
  const zoom = _map !== null ? _map.getZoom() : DEFAULT_ZOOM;
  const mPerPx = 40075000 * HOBOKEN_COS_LAT / (Math.pow(2, zoom) * 256);
  const tileBoost = zoom >= 18 ? 1.0 : zoom >= 17 ? 2.0 : 3.0;
  const effectiveLaneM = CLEANING_LANE_WIDTH_M * tileBoost;
  const laneWidthPx = Math.max(1, Math.round(effectiveLaneM / mPerPx));
  const useLaneSplit = side !== null;
  const weight = side === null ? Math.max(3, laneWidthPx * 2) : Math.max(2, laneWidthPx);
  const drawOpacity = opacity;
  const MIN_SPLIT_OFFSET_PX = 2;
  const offsetM = useLaneSplit
    ? Math.max(effectiveLaneM / 2, MIN_SPLIT_OFFSET_PX * mPerPx)
    : 0;

  for (const way of merged) {
    if (way.length === 0) continue;
    let pts: [number, number][] = way;

    if (side !== null && offsetM > 0) {
      const mid = way[Math.floor(way.length / 2)];
      if (mid !== undefined) {
        const DELTA = 0.0001;
        let refLat = mid[0];
        let refLng = mid[1];
        if (side === "East")       refLng += DELTA;
        else if (side === "West")  refLng -= DELTA;
        else if (side === "North") refLat += DELTA;
        else if (side === "South") refLat -= DELTA;
        pts = offsetPolylinePoints(way, refLat, refLng, offsetM);
      }
    }

    const layer = L.polyline(pts, { color, weight, opacity: drawOpacity });
    _violationLayers.push(layer);
    if (_violationHighlightsVisible && _map !== null) {
      layer.addTo(_map);
    }
  }
}

export function clearViolationHighlights(): void {
  for (const layer of _violationLayers) {
    layer.remove();
  }
  _violationLayers = [];
}

export function renderViolationHighlights(
  cleaningEntries: StreetCleaningEntry[],
  now: Date
): void {
  _lastCleaningEntries = cleaningEntries;
  _lastNowForHighlights = now;
  clearViolationHighlights();
  if (_map === null) return;

  const streetSides = new Map<string, Map<string, "active" | "upcoming">>();

  for (const entry of cleaningEntries) {
    const street = normalizeToGeometryKey(entry.street);
    let sides = streetSides.get(street);
    if (sides === undefined) {
      sides = new Map();
      streetSides.set(street, sides);
    }
    if (isScheduleActiveNow(entry.schedule, now)) {
      sides.set(entry.side, "active");
    } else if (isScheduleUpcomingSoon(entry.schedule, now)) {
      if (sides.get(entry.side) !== "active") {
        sides.set(entry.side, "upcoming");
      }
    }
  }

  for (const [street, sides] of streetSides) {
    const sideEntries = [...sides.entries()];
    const hasActive   = sideEntries.some(([, s]) => s === "active");
    const hasUpcoming = sideEntries.some(([, s]) => s === "upcoming");
    const allSpecific = sideEntries.every(([sd]) => sd !== "Both");

    if (!hasActive && !hasUpcoming) continue;

    if (allSpecific && sideEntries.length > 0) {
      for (const [sd, status] of sideEntries) {
        const color   = status === "active" ? "#ef4444" : "#f97316";
        const opacity = status === "active" ? 0.28 : 0.22;
        drawStreetHighlight(street, color, opacity, sd);
      }
    } else {
      const color   = hasActive ? "#ef4444" : "#f97316";
      const opacity = hasActive ? 0.28 : 0.22;
      drawStreetHighlight(street, color, opacity, null);
    }
  }
}

export function setViolationHighlightsVisible(visible: boolean): void {
  _violationHighlightsVisible = visible;
  if (_map === null) return;
  for (const layer of _violationLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
}

// ─── F-35 Upcoming sign rendering ────────────────────────────────────────────

/**
 * Render upcoming (not-yet-active) tow sign pins in orange using the custom
 * upcomingPane. Clears any previously rendered upcoming sign markers first.
 */
export function renderUpcomingSignPins(signs: Sign[], now: Date): void {
  for (const layer of _upcomingSignLayers) {
    layer.remove();
  }
  _upcomingSignLayers = [];

  if (_map === null) return;
  const L = getL();

  for (const sign of signs) {
    const icon = L.divIcon({
      html: signEmoji(sign.reason, false),
      className: "sign-emoji-marker",
      iconSize: [13, 13],
      iconAnchor: [6, 6],
    });
    const pos = getSnappedPinPosition(sign);

    const marker = L.marker(pos, {
      icon,
      pane: 'upcomingPane',
    });

    const popupHtml = buildSignPopup(sign, now);
    marker.bindPopup(popupHtml);
    marker.on("click", () => {
      marker.openPopup();
    });

    if (_upcomingSignsVisible) {
      marker.addTo(_map);
    }
    _upcomingSignLayers.push(marker);
  }
}

/**
 * Draw upcoming tow zone polylines in orange. Same geometry logic as
 * renderTowSegments but uses #f97316 (orange) for the inner casing.
 * Clears previous upcoming segment layers before rendering.
 */
export function renderUpcomingTowSegments(signs: Sign[]): void {
  for (const layer of _upcomingSegmentLayers) {
    layer.remove();
  }
  _upcomingSegmentLayers = [];

  if (_map === null) return;
  const L = getL();

  for (const sign of signs) {
    const addrMatch = sign.address.match(/^(\d+)-(\d+)\s+/);
    const addrRange = addrMatch
      ? Math.max(0, parseInt(addrMatch[2], 10) - parseInt(addrMatch[1], 10))
      : 0;
    const halfLengthM = Math.max(5, (addrRange / 2 + 1) * 4);

    const streetName = sign.address.replace(/^\d[\d-]*\s+/, "").trim();

    let waypoints: [number, number][] = [];

    const ways = _roadGeometry[streetName];
    if (ways !== undefined && ways.length > 0 && ways.some((w) => w.length > 0)) {
      waypoints = getSubsegment(ways, sign.lat, sign.lng, halfLengthM);
    }

    if (waypoints.length < 2) continue;

    const numMatch = sign.address.match(/^(\d+)/);
    let forcedDir: 1 | -1 | undefined;
    if (numMatch !== null) {
      const oddDir = _streetParity[normalizeToGeometryKey(streetName)];
      if (oddDir !== undefined) {
        const isOdd = parseInt(numMatch[1], 10) % 2 === 1;
        forcedDir = isOdd ? oddDir : (oddDir === 1 ? -1 : 1);
      }
    }
    waypoints = offsetPolylinePoints(waypoints, sign.lat, sign.lng, LATERAL_OFFSET_M, forcedDir);

    const outer = L.polyline(waypoints, { color: "#fff", weight: 7, opacity: 0.65 });
    const inner = L.polyline(waypoints, { color: "#f97316", weight: 3, opacity: 0.85 });
    _upcomingSegmentLayers.push(outer, inner);
    if (_upcomingSignsVisible) {
      outer.addTo(_map);
      inner.addTo(_map);
    }
  }
}

/**
 * Show or hide all upcoming sign markers and segment polylines.
 */
export function setUpcomingSignsVisible(visible: boolean): void {
  _upcomingSignsVisible = visible;
  if (_map === null) return;
  if (!visible) {
    _map.closePopup();
  }
  for (const layer of _upcomingSignLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
  for (const layer of _upcomingSegmentLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
}

// ─── F-36 Municipal Garage Markers ───────────────────────────────────────────

/**
 * Render a 🅿 marker for each municipal garage.
 * Clears existing garage markers before rendering the new set.
 */
export function renderGarageMarkers(garages: Garage[], visible: boolean): void {
  for (const layer of _garageLayers) {
    layer.remove();
  }
  _garageLayers = [];

  if (_map === null) return;

  const L = getL();

  for (const garage of garages) {
    const icon = L.divIcon({
      html: `<span class="garage-pin">🅿</span>`,
      className: "sign-emoji-marker",
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

    const marker = L.marker([garage.lat, garage.lng], { icon });

    const popupHtml = [
      `<div>`,
      `<strong>${garage.name}</strong><br/>`,
      `${garage.address}<br/>`,
      `${garage.capacity} spaces<br/>`,
      `${garage.phone}`,
      `</div>`,
    ].join("");
    marker.bindPopup(popupHtml);

    _garageMarkersVisible = visible;
    if (visible) {
      marker.addTo(_map);
    }
    _garageLayers.push(marker);
  }

  _garageMarkersVisible = visible;
}

/**
 * Show or hide all garage markers by adding/removing them from the map.
 */
export function setGarageMarkersVisible(visible: boolean): void {
  _garageMarkersVisible = visible;
  if (_map === null) return;
  for (const layer of _garageLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
}

// ─── F-37 Snow Emergency Routes ──────────────────────────────────────────────

// Hoboken's E-W numbered streets each run at a known latitude.
// The OSM bounding box used to build road-geometry.json is slightly larger than
// Hoboken, so streets like "3RD ST" pick up Jersey City Heights ways at
// lat ~40.753 — about 0.013° north of Hoboken's actual 3rd St (~40.740).
// A ±0.008° tolerance (~890 m) accepts all legitimate Hoboken ways while
// rejecting every JC bleed-through observed in the data.
const HOBOKEN_STREET_LAT: Record<string, number> = {
  "3RD ST": 40.740, "4TH ST": 40.741, "5TH ST": 40.742,
  "9TH ST": 40.750, "13TH ST": 40.756,
};
const HOBOKEN_STREET_LAT_TOLERANCE = 0.008;

/**
 * Render blue polylines for each snow emergency route entry.
 * Iterates all ways in _roadGeometry[route.street] — same convention as
 * drawStreetHighlight — but uses its own layer array (_snowRouteLayers).
 * Ways whose centroid latitude deviates more than HOBOKEN_STREET_LAT_TOLERANCE
 * from the expected Hoboken street latitude are skipped (JC bleed-through guard).
 */
export function renderSnowEmergencyRoutes(routes: SnowRoute[], visible: boolean): void {
  for (const layer of _snowRouteLayers) {
    layer.remove();
  }
  _snowRouteLayers = [];
  _snowRoutesVisible = visible;

  if (_map === null) return;

  const L = getL();

  for (const route of routes) {
    const ways = _roadGeometry[route.street];
    if (ways === undefined || ways.length === 0) continue;
    const expectedLat = HOBOKEN_STREET_LAT[route.street];
    for (const way of ways) {
      if (way.length === 0) continue;
      if (expectedLat !== undefined) {
        const centLat = way.reduce((sum, pt) => sum + pt[0], 0) / way.length;
        if (Math.abs(centLat - expectedLat) > HOBOKEN_STREET_LAT_TOLERANCE) continue;
      }
      const layer = L.polyline(way, { color: "#3b82f6", weight: 12, opacity: 0.45 });
      _snowRouteLayers.push(layer);
      if (_snowRoutesVisible && _map !== null) {
        layer.addTo(_map);
      }
    }
  }
}

/**
 * Show or hide all snow route polylines.
 */
export function setSnowRoutesVisible(visible: boolean): void {
  _snowRoutesVisible = visible;
  if (_map === null) return;
  for (const layer of _snowRouteLayers) {
    if (visible) {
      layer.addTo(_map);
    } else {
      layer.remove();
    }
  }
}

/**
 * Open a Leaflet popup at the clicked coordinates showing the street cleaning
 * schedule for the given entries. At most one street popup is open at a time —
 * calling this function again closes the previous popup first.
 *
 * If `entries` is empty, renders a "no schedule found" message.
 * If `initMap` has not been called, returns without throwing.
 *
 * The optional `detectSegment` callback is called after the popup opens.
 * When it resolves with a location string, the popup is updated to highlight
 * that block. A stale-token guard prevents out-of-order updates.
 */
export function showStreetPopup(
  lat: number,
  lng: number,
  streetName: string,
  entries: StreetCleaningEntry[],
  detectSegment?: (locations: string[]) => Promise<string[] | null>,
  now?: Date
): void {
  if (_map === null) return;

  // Close any existing street popup
  if (_streetPopup !== null) {
    _streetPopup.remove();
    _streetPopup = null;
  }

  const resolvedNow = now ?? new Date();
  const L = getL();
  const content = buildStreetPopupContent(streetName, entries, undefined, resolvedNow);

  const popup = L.popup();
  popup.setLatLng([lat, lng]);
  popup.setContent(content);
  popup.openOn(_map);

  _streetPopup = popup;

  const token = ++_popupHighlightToken;
  if (detectSegment !== undefined && entries.length > 0) {
    const uniqueLocations = [...new Set(entries.map((e) => e.location))];
    void detectSegment(uniqueLocations).then((matched) => {
      if (_popupHighlightToken !== token) return;
      if (_streetPopup === null) return;
      if (matched === null) return;
      _streetPopup.setContent(buildStreetPopupContent(streetName, entries, matched, now));
    });
  }
}
