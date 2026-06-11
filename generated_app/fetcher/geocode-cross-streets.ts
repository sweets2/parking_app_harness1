import * as fs from "fs/promises";
import * as path from "path";
import { extractCrossStreets } from "../shared/parking-logic";
import type { StreetCleaningData } from "../shared/types";

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../data"
);

// Mirrors normalizeStreet in app/main.ts — keep in sync if abbreviations change.
function normalizeStreet(s: string): string {
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

// Boundary terms and streets that Nominatim cannot resolve — hardcoded Hoboken approximations.
const STATIC_COORDS: Record<string, { lat: number; lng: number }> = {
  "north boundary":        { lat: 40.7650, lng: -74.0330 },
  "the northern boundary": { lat: 40.7650, lng: -74.0330 },
  "south boundary":        { lat: 40.7300, lng: -74.0280 },
  "the south boundary":    { lat: 40.7300, lng: -74.0280 },
  "east boundary":         { lat: 40.7450, lng: -74.0190 },
  "west boundary":         { lat: 40.7450, lng: -74.0510 },
  "henderson street":      { lat: 40.7360, lng: -74.0365 },
};

// In Hoboken, numbered streets (1st–19th) run east-west, as do Observer Hwy,
// Newark St, and Sinatra Dr. All named avenues and other named streets run north-south.
function isEastWestRoad(name: string): boolean {
  return /^\d+(st|nd|rd|th) street$/.test(name)
      || name === "observer highway"
      || name === "newark street"
      || name === "sinatra drive";
}

let _lastCallMs = 0;

async function rateLimit(): Promise<void> {
  const elapsed = Date.now() - _lastCallMs;
  if (elapsed < 1000) {
    await new Promise<void>((r) => setTimeout(r, 1000 - elapsed));
  }
}

async function geocode(
  streetName: string
): Promise<{ lat: number; lng: number } | null> {
  await rateLimit();
  _lastCallMs = Date.now();
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(streetName + ", Hoboken, NJ")}&limit=1`;
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "en",
        "User-Agent": "hoboken-parking-app/1.0 (build-time geocoder)",
      },
    });
    const data = (await response.json()) as Array<{ lat: string; lon: string }>;
    if (data.length > 0 && data[0] !== undefined) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runGeocode(): Promise<void> {
  const inPath = path.join(DATA_DIR, "street-cleaning.json");
  const raw = await fs.readFile(inPath, "utf-8");
  const data = JSON.parse(raw) as StreetCleaningData;

  // Collect standalone names (both main streets and cross-streets) and intersection pairs.
  const names = new Set<string>();
  const intersections = new Map<string, { main: string; cross: string }>();
  for (const entry of data.entries) {
    const main = normalizeStreet(entry.street);
    names.add(main); // ← include main street so synthesis always has both coords
    const pair = extractCrossStreets(entry.location);
    if (pair === null) continue;
    const from = normalizeStreet(pair[0]);
    const to = normalizeStreet(pair[1]);
    names.add(from);
    names.add(to);
    intersections.set(`${main}|${from}`, { main, cross: from });
    intersections.set(`${main}|${to}`,   { main, cross: to });
  }

  const table: Record<string, { lat: number; lng: number } | null> = {};
  const nameList = Array.from(names);

  // Phase 1: standalone cross-street geocodes (existing behavior).
  for (let i = 0; i < nameList.length; i++) {
    const name = nameList[i];
    if (name === undefined) continue;
    if (name in STATIC_COORDS) {
      const coord = STATIC_COORDS[name];
      table[name] = coord ?? null;
      console.log(`[standalone ${i + 1}/${nameList.length}] Static override for "${name}": ${coord?.lat.toFixed(4)}, ${coord?.lng.toFixed(4)}`);
      continue;
    }
    process.stdout.write(`[standalone ${i + 1}/${nameList.length}] Geocoding "${name}"... `);
    const result = await geocode(name);
    table[name] = result;
    console.log(
      result === null
        ? "not found"
        : `${result.lat.toFixed(4)}, ${result.lng.toFixed(4)}`
    );
  }

  // Phase 2: intersection coordinates — keyed "mainStreet|crossStreet".
  // Nominatim doesn't reliably resolve Hoboken intersections (returns standalone centroids
  // or nothing). Instead, synthesize from Phase 1 standalone coords using road orientation:
  //   east-west main road → { lat: mainCoord.lat, lng: crossCoord.lng }
  //   north-south main road → { lat: crossCoord.lat, lng: mainCoord.lng }
  // This forces deltaLat ≈ 0 for E-W mains (selects longitude axis) and
  // deltaLng ≈ 0 for N-S mains (selects latitude axis) in detectMatchingSegment.
  const intersectionList = Array.from(intersections.values());
  for (let i = 0; i < intersectionList.length; i++) {
    const entry = intersectionList[i];
    if (entry === undefined) continue;
    const { main, cross } = entry;
    const key = `${main}|${cross}`;
    if (cross in STATIC_COORDS) {
      // Boundary terms: reuse the static approximation.
      const coord = STATIC_COORDS[cross];
      table[key] = coord ?? null;
      console.log(`[intersection ${i + 1}/${intersectionList.length}] Static override for "${key}"`);
      continue;
    }
    const mainCoord = table[main];
    const crossCoord = table[cross];
    if (mainCoord === null || mainCoord === undefined || crossCoord === null || crossCoord === undefined) {
      table[key] = null;
      console.log(`[intersection ${i + 1}/${intersectionList.length}] Missing standalone coord for "${key}" — skipped`);
      continue;
    }
    const synthesized = isEastWestRoad(main)
      ? { lat: mainCoord.lat, lng: crossCoord.lng }
      : { lat: crossCoord.lat, lng: mainCoord.lng };
    table[key] = synthesized;
    console.log(`[intersection ${i + 1}/${intersectionList.length}] Synthesized "${key}": ${synthesized.lat.toFixed(4)}, ${synthesized.lng.toFixed(4)}`);
  }

  const outPath = path.join(DATA_DIR, "cross-streets.json");
  const totalEntries = nameList.length + intersectionList.length;
  await fs.writeFile(outPath, JSON.stringify(table, null, 2), "utf-8");
  console.log(`\nWrote ${totalEntries} entries to ${outPath}`);
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("geocode-cross-streets.ts") ||
    process.argv[1].endsWith("geocode-cross-streets.js"));

if (isMain) {
  runGeocode().catch((err: unknown) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
