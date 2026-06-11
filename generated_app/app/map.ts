/**
 * app/map.ts — F-07 / F-07.6
 *
 * The ONLY file in this project that may touch the Leaflet `L.*` global.
 * All other modules must not import Leaflet.
 *
 * Leaflet is loaded via CDN in index.html and is available as `window.L`.
 * In Node tests the global `L` is mocked before this module is imported.
 */

import type { Sign, StreetCleaningEntry, RoadGeometry } from "../shared/types";
import type { SavedSpot } from "../shared/storage";
import { formatTime, getStreetOrientation, isScheduleActiveNow, isScheduleUpcomingSoon, isSignActive } from "../shared/parking-logic";

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
}

interface LeafletCircleMarker extends LeafletLayer {
  setRadius(radius: number): void;
}

interface LeafletIcon {
  _html: string;
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
    options: { icon: LeafletIcon }
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

const DEFAULT_ZOOM = 15;

function dotScale(): number {
  if (_map === null) return 1;
  return Math.max(0.6, Math.min(3, Math.pow(1.25, _map.getZoom() - DEFAULT_ZOOM)));
}

// ─── Tow sign dot icons ───────────────────────────────────────────────────────

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${body}</svg>`;

const TOW_RED = "#cc0000";
export const LATERAL_OFFSET_M = 4.0;

const REASON_EMOJI: Record<string, string> = {
  CONSTRUCTION: icon(`<circle cx="6" cy="6" r="5" fill="${TOW_RED}" stroke="white" stroke-width="1"/>`),
  MOVING:       icon(`<circle cx="6" cy="6" r="5" fill="${TOW_RED}" stroke="white" stroke-width="1"/>`),
  EVENT:        icon(`<polygon points="6,1 11,11 1,11" fill="${TOW_RED}" stroke="white" stroke-width="1" stroke-linejoin="round"/>`),
  DELIVERY:     icon(`<rect x="1" y="1" width="10" height="10" fill="${TOW_RED}" stroke="white" stroke-width="1" stroke-linejoin="round"/>`),
};

const SPOT_COLOR = "#1d6fe3"; // blue — visually distinct from sign markers
const POSITION_BASE_RADIUS = 7;
const SPOT_BASE_RADIUS = 10;

// ─── F-10.3 signEmoji ─────────────────────────────────────────────────────────

/**
 * Maps a sign reason string to an emoji character.
 * Returns "⚠️" for unknown reasons.
 */
export function signEmoji(reason: string): string {
  return REASON_EMOJI[reason] ?? icon(`<circle cx="6" cy="6" r="5" fill="none" stroke="#dc2626" stroke-width="2"/>`);
}

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
  map.on("zoomend", updateIconScale);

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

    const marker = L.marker([sign.lat, sign.lng], {
      icon: L.divIcon({
        html: icon,
        className: "sign-emoji-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    });

    const popupHtml = buildSignPopup(sign, now);
    marker.bindPopup(popupHtml);
    marker.on("click", () => {
      marker.openPopup();
    });

    marker.addTo(_map);
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
  const MAX_SNAP_M = 50;
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
 *   - sign is on the centreline (|dot| < 1e-9)
 */
export function offsetPolylinePoints(
  pts: [number, number][],
  signLat: number,
  signLng: number,
  offsetM: number
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

  // Left-perpendicular unit vector (90° CCW from road direction in east/north space)
  const perpX_m = -dY / len;   // east component
  const perpY_m = dX / len;    // north component

  // Sign displacement from segment midpoint
  const midLat = (first[0] + last[0]) / 2;
  const midLng = (first[1] + last[1]) / 2;
  const signDY = (signLat - midLat) * 111320;
  const signDX = (signLng - midLng) * 111320 * cosLat;

  // Dot product determines side
  const dot = signDX * perpX_m + signDY * perpY_m;

  if (Math.abs(dot) < 1e-9) return pts;

  const dir = dot > 0 ? 1 : -1;

  // Apply uniform offset to every point
  const dLat = dir * offsetM * perpY_m / 111320;
  const dLng = dir * offsetM * perpX_m / (111320 * cosLat);

  return pts.map(([lat, lng]): [number, number] => [lat + dLat, lng + dLng]);
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

    // Use orientation heuristic when no OSM geometry exists or getSubsegment
    // returned [] because the sign was too far from any known road segment.
    if (waypoints.length < 2) {
      const orientation = getStreetOrientation(sign.address);
      const cosLat = Math.cos(sign.lat * Math.PI / 180);
      const halfLat = halfLengthM / 111320;
      const halfLng = halfLengthM / (111320 * cosLat);
      waypoints =
        orientation === "EW"
          ? [[sign.lat, sign.lng - halfLng], [sign.lat, sign.lng + halfLng]]
          : [[sign.lat - halfLat, sign.lng], [sign.lat + halfLat, sign.lng]];
    }

    waypoints = offsetPolylinePoints(waypoints, sign.lat, sign.lng, LATERAL_OFFSET_M);

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
 * Show or hide all tow sign markers by toggling a CSS class on #map.
 * Uses `.leaflet-marker-pane` which only contains tow markers (position and
 * spot dots live in `.leaflet-overlay-pane` via circleMarker and are unaffected).
 *
 * Also shows/hides segment polylines stored in _segmentLayers.
 * _towSignsVisible is set unconditionally first so the flag is accurate even
 * when mapEl is absent (e.g. in Node test environment).
 */
export function setTowSignsVisible(visible: boolean): void {
  _towSignsVisible = visible;
  if (typeof document !== "undefined") {
    const mapEl = document.getElementById("map");
    if (mapEl !== null) {
      if (visible) {
        mapEl.classList.remove("tow-signs-hidden");
      } else {
        mapEl.classList.add("tow-signs-hidden");
      }
    }
  }
  if (_map === null) return;
  for (const layer of _segmentLayers) {
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
  detectSegment?: (locations: string[]) => Promise<string[] | null>
): void {
  if (_map === null) return;

  // Close any existing street popup
  if (_streetPopup !== null) {
    _streetPopup.remove();
    _streetPopup = null;
  }

  const now = new Date();
  const L = getL();
  const content = buildStreetPopupContent(streetName, entries, undefined, now);

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
