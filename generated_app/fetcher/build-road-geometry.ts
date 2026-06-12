import * as fs from "fs/promises";
import * as path from "path";
import type { RoadGeometry } from "../shared/types";

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../data"
);

// ─── Overpass response types ──────────────────────────────────────────────────

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: OverpassNode[];
}

interface OverpassResponse {
  elements: OverpassWay[];
}

// ─── Name normalization ───────────────────────────────────────────────────────

/**
 * Normalize an OSM street name to match the sign-address format used in
 * the parking data (e.g. "Washington Street" → "WASHINGTON ST").
 */
function normalizeName(name: string): string {
  let n = name.toUpperCase();

  // Suffix replacements (word-boundary)
  n = n.replace(/\bSTREET\b/g, "ST");
  n = n.replace(/\bAVENUE\b/g, "AVE");
  n = n.replace(/\bBOULEVARD\b/g, "BLVD");
  n = n.replace(/\bHIGHWAY\b/g, "HWY");
  n = n.replace(/\bPLACE\b/g, "PL");
  n = n.replace(/\bDRIVE\b/g, "DR");
  n = n.replace(/\bCOURT\b/g, "CT");
  n = n.replace(/\bROAD\b/g, "RD");
  n = n.replace(/\bTERRACE\b/g, "TER");

  // Directional replacements (word-boundary)
  n = n.replace(/\bNORTH\b/g, "N");
  n = n.replace(/\bSOUTH\b/g, "S");
  n = n.replace(/\bEAST\b/g, "E");
  n = n.replace(/\bWEST\b/g, "W");

  return n;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runBuildRoadGeometry(): Promise<void> {
  const overpassQuery = `[out:json][timeout:30];
way["highway"]["name"](40.728,-74.060,40.760,-74.022);
out geom;`;

  const url = "https://overpass-api.de/api/interpreter";

  console.log("Fetching road geometry from Overpass API...");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "hoboken-parking-app/1.0 (build-time road-geometry)",
    },
    body: `data=${encodeURIComponent(overpassQuery)}`,
  });

  if (!response.ok) {
    throw new Error(`Overpass API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as OverpassResponse;

  const table: RoadGeometry = {};

  for (const element of data.elements) {
    const rawName = element.tags?.name;
    if (rawName === undefined) continue;

    const geometry = element.geometry;
    if (geometry === undefined || geometry.length === 0) continue;

    const normalizedName = normalizeName(rawName);
    const wayPoints: [number, number][] = geometry.map((node) => [node.lat, node.lon]);

    if (table[normalizedName] === undefined) {
      table[normalizedName] = [];
    }
    table[normalizedName].push(wayPoints);
  }

  const outPath = path.join(DATA_DIR, "road-geometry.json");
  await fs.writeFile(outPath, JSON.stringify(table, null, 2), "utf-8");

  const wayCount = Object.values(table).reduce((sum, ways) => sum + ways.length, 0);
  console.log(`Wrote ${Object.keys(table).length} streets (${wayCount} ways) to ${outPath}`);
}

// ─── Run guard ────────────────────────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("build-road-geometry.ts") ||
    process.argv[1].endsWith("build-road-geometry.js"));

if (isMain) {
  runBuildRoadGeometry().catch((err: unknown) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
