/**
 * app/map.ts — F-07 / F-07.6
 *
 * The ONLY file in this project that may touch the Leaflet `L.*` global.
 * All other modules must not import Leaflet.
 *
 * Leaflet is loaded via CDN in index.html and is available as `window.L`.
 * In Node tests the global `L` is mocked before this module is imported.
 */

import type { Sign, StreetCleaningEntry } from "../shared/types";
import type { SavedSpot } from "../shared/storage";
import { formatTime } from "../shared/parking-logic";

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
  on(event: string, handler: (e: { latlng: LeafletLatLng }) => void): LeafletMap;
  off(event: string): LeafletMap;
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
  ): LeafletLayer;
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
}

function getL(): LeafletStatic {
  return (globalThis as Record<string, unknown>)["L"] as LeafletStatic;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _map: LeafletMap | null = null;
let _signLayers: LeafletLayer[] = [];
let _positionMarker: LeafletLayer | null = null;
let _spotMarker: LeafletLayer | null = null;
let _streetPopup: LeafletPopup | null = null;

// ─── Tow sign dot icons ───────────────────────────────────────────────────────

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${body}</svg>`;

const TOW_RED = "#cc0000";

const REASON_EMOJI: Record<string, string> = {
  CONSTRUCTION: icon(`<circle cx="6" cy="6" r="5" fill="${TOW_RED}" stroke="white" stroke-width="1"/>`),
  MOVING:       icon(`<circle cx="6" cy="6" r="5" fill="${TOW_RED}" stroke="white" stroke-width="1"/>`),
  EVENT:        icon(`<polygon points="6,1 11,11 1,11" fill="${TOW_RED}" stroke="white" stroke-width="1" stroke-linejoin="round"/>`),
  DELIVERY:     icon(`<rect x="1" y="1" width="10" height="10" fill="${TOW_RED}" stroke="white" stroke-width="1" stroke-linejoin="round"/>`),
};

const SPOT_COLOR = "#1d6fe3"; // blue — visually distinct from sign markers

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
  _positionMarker = null;
  _spotMarker = null;
  _streetPopup = null;

  return map;
}

// ─── F-07.2 renderSignPins ────────────────────────────────────────────────────

/**
 * Place one circle marker per sign, colored by reason.
 * Clears previous sign pins before rendering the new set.
 * The `now` parameter is accepted per spec signature (reserved for future
 * time-conditional filtering) but sign visibility is determined by the caller.
 */
export function renderSignPins(signs: Sign[], _now: Date): void {
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

    const popupHtml = buildSignPopup(sign);
    marker.bindPopup(popupHtml);
    marker.on("click", () => {
      marker.openPopup();
    });

    marker.addTo(_map);
    _signLayers.push(marker);
  }
}

function buildSignPopup(sign: Sign): string {
  return [
    `<strong>${sign.address}</strong>`,
    `<div>Reason: ${sign.reason}</div>`,
    `<div>Start: ${sign.start_date} ${formatTime(sign.start_time)}</div>`,
    `<div>End: ${sign.stop_date} ${formatTime(sign.end_time)}</div>`,
    `<div>Permit: ${sign.permit_number}</div>`,
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
    radius: 7,
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
    radius: 10,
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
    callback(e.latlng.lat, e.latlng.lng);
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
  let triangle: string;
  let letter: string;
  let cls: string;
  if (s === "north") { triangle = "▴"; letter = "N"; cls = "dir-n"; }
  else if (s === "south") { triangle = "▾"; letter = "S"; cls = "dir-s"; }
  else if (s === "east") { triangle = "▸"; letter = "E"; cls = "dir-e"; }
  else if (s === "west") { triangle = "◂"; letter = "W"; cls = "dir-w"; }
  else { triangle = "●"; letter = side.charAt(0).toUpperCase(); cls = "dir-other"; }
  return `<span class="dir-badge ${cls}">${triangle} ${letter}</span>`;
}

function buildStreetPopupContent(
  streetName: string,
  entries: StreetCleaningEntry[]
): string {
  if (entries.length === 0) {
    return `<div class="sp-wrap"><div class="sp-header">🧹 Street Cleaning</div><div class="sp-street">${streetName}</div><div class="sp-loc-label"><em>No cleaning schedule found</em></div></div>`;
  }

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
  parts.push(`<div class="sp-header">🧹 Street Cleaning</div>`);
  parts.push(`<div class="sp-street">${streetName}</div>`);

  for (let i = 0; i < locationOrder.length; i++) {
    if (i > 0) parts.push(`<hr class="sp-sep"/>`);
    const location = locationOrder[i];
    const locationEntries = byLocation.get(location) as StreetCleaningEntry[];
    const blockContext = formatLocation(location);
    parts.push(`<div class="sp-block">`);
    parts.push(`<div class="sp-loc-label">${streetName} ${blockContext}</div>`);
    for (const entry of locationEntries) {
      parts.push(`<div class="sp-entry">${directionBadge(entry.side)}<span class="sp-sched">${entry.schedule}</span></div>`);
    }
    parts.push(`</div>`);
  }

  parts.push(`</div>`);
  return parts.join("");
}

/**
 * Open a Leaflet popup at the clicked coordinates showing the street cleaning
 * schedule for the given entries. At most one street popup is open at a time —
 * calling this function again closes the previous popup first.
 *
 * If `entries` is empty, renders a "no schedule found" message.
 * If `initMap` has not been called, returns without throwing.
 */
export function showStreetPopup(
  lat: number,
  lng: number,
  streetName: string,
  entries: StreetCleaningEntry[]
): void {
  if (_map === null) return;

  // Close any existing street popup
  if (_streetPopup !== null) {
    _streetPopup.remove();
    _streetPopup = null;
  }

  const L = getL();
  const content = buildStreetPopupContent(streetName, entries);

  const popup = L.popup();
  popup.setLatLng([lat, lng]);
  popup.setContent(content);
  popup.openOn(_map);

  _streetPopup = popup;
}
