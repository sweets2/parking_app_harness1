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
    .replace(/\bsixteenth\b/g, "16th");
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

  const names = new Set<string>();
  for (const entry of data.entries) {
    const pair = extractCrossStreets(entry.location);
    if (pair === null) continue;
    names.add(normalizeStreet(pair[0]));
    names.add(normalizeStreet(pair[1]));
  }

  const table: Record<string, { lat: number; lng: number } | null> = {};
  const nameList = Array.from(names);

  for (let i = 0; i < nameList.length; i++) {
    const name = nameList[i];
    if (name === undefined) continue;
    process.stdout.write(`[${i + 1}/${nameList.length}] Geocoding "${name}"... `);
    const result = await geocode(name);
    table[name] = result;
    console.log(
      result === null
        ? "not found"
        : `${result.lat.toFixed(4)}, ${result.lng.toFixed(4)}`
    );
  }

  const outPath = path.join(DATA_DIR, "cross-streets.json");
  await fs.writeFile(outPath, JSON.stringify(table, null, 2), "utf-8");
  console.log(`\nWrote ${nameList.length} entries to ${outPath}`);
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
