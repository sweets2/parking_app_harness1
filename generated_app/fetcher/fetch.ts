import * as fs from "fs/promises";
import * as path from "path";
import { SIGN_REASONS } from "../shared/types";
import type { Sign, ParkingData } from "../shared/types";

const API_URL = "https://api-hpuvp.hobokennj.gov/api/v1/parking";
const FUTURE_API_URL = "https://api-hpuvp.hobokennj.gov/api/v1/parking/future";

// Resolve data directory relative to this file at runtime
const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../data"
);

/** Converts "M/D/YYYY" + "HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS" (local time, no tz suffix). */
export function toIsoDatetime(date: string, time: string): string {
  const parts = date.split("/");
  const monthStr = parts[0] ?? "";
  const dayStr = parts[1] ?? "";
  const yearStr = parts[2] ?? "";
  const month = String(Number(monthStr)).padStart(2, "0");
  const day = String(Number(dayStr)).padStart(2, "0");
  return `${yearStr}-${month}-${day}T${time}`;
}

/** Returns true if fetchTime falls within [startIso, endIso] (string comparison, no Date objects). */
export function computeActiveAtFetch(
  startIso: string,
  endIso: string,
  fetchTime: Date
): boolean {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Build a "YYYY-MM-DDTHH:MM:SS" string from the UTC components of fetchTime
  const fetchLocal =
    `${fetchTime.getUTCFullYear()}-` +
    `${pad(fetchTime.getUTCMonth() + 1)}-` +
    `${pad(fetchTime.getUTCDate())}T` +
    `${pad(fetchTime.getUTCHours())}:` +
    `${pad(fetchTime.getUTCMinutes())}:` +
    `${pad(fetchTime.getUTCSeconds())}`;
  return fetchLocal >= startIso && fetchLocal <= endIso;
}

/**
 * Validates the top-level API response body.
 * Returns the typed body on success.
 * Calls process.exit(1) if status !== "success" or data is not an array.
 */
export function validateResponseShape(body: unknown): { status: string; data: unknown[] } {
  if (typeof body !== "object" || body === null) {
    console.error("Fatal: API response is not an object");
    process.exit(1);
  }

  const typed = body as Record<string, unknown>;

  if (!("status" in typed) || !("data" in typed)) {
    console.error("Fatal: API response missing required fields (status, data)");
    process.exit(1);
  }

  if (typed["status"] !== "success") {
    console.error(
      `Fatal: API response status is "${String(typed["status"])}", expected "success"`
    );
    process.exit(1);
  }

  if (!Array.isArray(typed["data"])) {
    console.error("Fatal: API response data is not an array");
    process.exit(1);
  }

  return { status: typed["status"] as string, data: typed["data"] as unknown[] };
}

/**
 * Validates a single raw sign entry. Returns an array of human-readable
 * warning strings (one per problem field). An empty array means the sign is valid.
 */
export function validateSign(sign: unknown, index: number): string[] {
  const warnings: string[] = [];

  if (typeof sign !== "object" || sign === null) {
    warnings.push(`Sign at index ${index}: not an object`);
    return warnings;
  }

  const s = sign as Record<string, unknown>;

  // id must be present first — if missing, return early
  if (!("id" in s) || typeof s["id"] !== "string") {
    warnings.push(`Sign at index ${index}: missing or invalid field "id"`);
    return warnings;
  }

  const stringFields = [
    "address",
    "permit_number",
    "start_date",
    "start_time",
    "stop_date",
    "end_time",
  ] as const;

  for (const field of stringFields) {
    if (!(field in s) || typeof s[field] !== "string") {
      warnings.push(`Sign at index ${index}: missing or invalid field "${field}"`);
    }
  }

  if (!("latitude" in s) || typeof s["latitude"] !== "number") {
    warnings.push(`Sign at index ${index}: missing or invalid field "latitude"`);
  }

  if (!("longitude" in s) || typeof s["longitude"] !== "number") {
    warnings.push(`Sign at index ${index}: missing or invalid field "longitude"`);
  }

  if (!("reason" in s)) {
    warnings.push(`Sign at index ${index}: missing field "reason"`);
  } else if (typeof s["reason"] !== "string" || s["reason"] === "") {
    warnings.push(`Sign at index ${index}: invalid reason "${String(s["reason"])}"`);
  } else if (!(SIGN_REASONS as readonly string[]).includes(s["reason"])) {
    warnings.push(`Sign at index ${index}: unrecognized reason "${s["reason"]}"`);
  }

  return warnings;
}

/**
 * Compares new sign count to previous. Returns a warning string if newCount < 50% of prevCount,
 * or null if the drop is acceptable or there is no previous count to compare.
 */
export function checkCountDrop(newCount: number, prevCount: number | null): string | null {
  if (prevCount === null) return null;
  if (newCount < prevCount * 0.5) {
    const pct = Math.round((newCount / prevCount) * 100);
    return `Warning: sign count dropped from ${prevCount} to ${newCount} (${pct}% of previous count)`;
  }
  return null;
}

function transformSign(raw: Record<string, unknown>, fetchTime: Date): Sign {
  const startIso = toIsoDatetime(
    raw["start_date"] as string,
    raw["start_time"] as string
  );
  const endIso = toIsoDatetime(
    raw["stop_date"] as string,
    raw["end_time"] as string
  );
  const activeAtFetch = computeActiveAtFetch(startIso, endIso, fetchTime);

  return {
    id: raw["id"] as string,
    address: raw["address"] as string,
    reason: raw["reason"] as Sign["reason"],
    permit_number: raw["permit_number"] as string,
    lat: raw["latitude"] as number,
    lng: raw["longitude"] as number,
    start_date: raw["start_date"] as string,
    start_time: raw["start_time"] as string,
    stop_date: raw["stop_date"] as string,
    end_time: raw["end_time"] as string,
    start_iso: startIso,
    end_iso: endIso,
    active_at_fetch: activeAtFetch,
  };
}

/** Injectable file system interface for testability. */
export interface FsBackend {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
}

const realFs: FsBackend = {
  readFile: (p) => fs.readFile(p, "utf-8"),
  writeFile: (p, data) => fs.writeFile(p, data, "utf-8"),
};

/** Core pipeline with injectable file system — enables unit testing without real I/O. */
export async function runFetcherWithFs(
  fetchTime: Date,
  fsBackend: FsBackend
): Promise<void> {
  // F-01.1 — HTTP request
  let rawBody: unknown;
  try {
    const response = await fetch(API_URL);
    if (!response.ok) {
      console.error(`Fatal: API returned HTTP ${response.status}`);
      process.exit(1);
    }
    try {
      rawBody = await response.json();
    } catch (parseErr) {
      console.error(
        `Fatal: Failed to parse API response as JSON: ${String(parseErr)}`
      );
      process.exit(1);
    }
  } catch (networkErr) {
    console.error(`Fatal: Network error: ${String(networkErr)}`);
    process.exit(1);
  }

  // F-01.2 — Validate response shape
  const validated = validateResponseShape(rawBody);

  // F-01.5 — Guard before write
  if (validated.data.length === 0) {
    console.error(
      "Fatal: API returned zero signs — not overwriting latest.json"
    );
    process.exit(1);
  }

  // F-01.3 & F-01.4 — Validate individual signs (warn-and-continue)
  for (const [i, sign] of validated.data.entries()) {
    const warnings = validateSign(sign, i);
    for (const w of warnings) {
      console.warn(w);
    }
  }

  // F-01.6 — Count-change warning
  let prevCount: number | null = null;
  const latestPath = path.join(DATA_DIR, "latest.json");
  try {
    const existing = await fsBackend.readFile(latestPath);
    const parsed = JSON.parse(existing) as { count?: unknown };
    if (typeof parsed.count === "number") {
      prevCount = parsed.count;
    }
  } catch {
    // No existing file or parse error — first run, skip comparison
  }

  const countWarning = checkCountDrop(validated.data.length, prevCount);
  if (countWarning !== null) {
    console.warn(countWarning);
  }

  // Transform signs
  const signs: Sign[] = validated.data.map((raw) =>
    transformSign(raw as Record<string, unknown>, fetchTime)
  );

  // Build output
  const output: ParkingData = {
    fetched_at: fetchTime.toISOString(),
    count: signs.length,
    signs,
  };

  const json = JSON.stringify(output, null, 2);

  // F-01.8 — Write output files
  await fsBackend.writeFile(latestPath, json);

  // Archive file: parking_YYYY-MM-DD.json
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr =
    `${fetchTime.getUTCFullYear()}-` +
    `${pad(fetchTime.getUTCMonth() + 1)}-` +
    `${pad(fetchTime.getUTCDate())}`;
  const archiveName = `parking_${dateStr}.json`;
  const archivePath = path.join(DATA_DIR, archiveName);
  await fsBackend.writeFile(archivePath, json);

  console.log(
    `Wrote ${signs.length} signs to ${latestPath} and ${archivePath}`
  );

  await runFutureFetcherWithFs(fetchTime, fsBackend);
}

/**
 * Fetches upcoming (not-yet-active) parking signs from the future API endpoint.
 * Writes data/future.json with { fetched_at, count, signs[] } containing only signs
 * whose start_iso is after fetchTime. Zero upcoming signs is valid — writes empty array.
 */
export async function runFutureFetcherWithFs(
  fetchTime: Date,
  fsBackend: FsBackend
): Promise<void> {
  // Build fetchLocalIso the same way computeActiveAtFetch does
  const pad = (n: number) => String(n).padStart(2, "0");
  const fetchLocalIso =
    `${fetchTime.getUTCFullYear()}-` +
    `${pad(fetchTime.getUTCMonth() + 1)}-` +
    `${pad(fetchTime.getUTCDate())}T` +
    `${pad(fetchTime.getUTCHours())}:` +
    `${pad(fetchTime.getUTCMinutes())}:` +
    `${pad(fetchTime.getUTCSeconds())}`;

  let rawBody: unknown;
  try {
    const response = await fetch(FUTURE_API_URL);
    if (!response.ok) {
      console.error(`Fatal: Future API returned HTTP ${response.status}`);
      process.exit(1);
    }
    try {
      rawBody = await response.json();
    } catch (parseErr) {
      console.error(
        `Fatal: Failed to parse future API response as JSON: ${String(parseErr)}`
      );
      process.exit(1);
    }
  } catch (networkErr) {
    console.error(`Fatal: Network error fetching future: ${String(networkErr)}`);
    process.exit(1);
  }

  const validated = validateResponseShape(rawBody);

  // Validate individual signs (warn-and-continue)
  for (const [i, sign] of validated.data.entries()) {
    const warnings = validateSign(sign, i);
    for (const w of warnings) {
      console.warn(w);
    }
  }

  // Transform all signs, then keep only those with start_iso > fetchLocalIso (upcoming only)
  const allSigns: Sign[] = validated.data.map((raw) =>
    transformSign(raw as Record<string, unknown>, fetchTime)
  );
  const upcomingSigns = allSigns.filter((sign) => sign.start_iso > fetchLocalIso);

  const futurePath = path.join(DATA_DIR, "future.json");
  const output: { fetched_at: string; count: number; signs: Sign[] } = {
    fetched_at: fetchTime.toISOString(),
    count: upcomingSigns.length,
    signs: upcomingSigns,
  };

  await fsBackend.writeFile(futurePath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${upcomingSigns.length} upcoming signs to ${futurePath}`);
}

/** Main entry point — runs the full fetch pipeline. Calls process.exit on fatal errors. */
export async function runFetcher(fetchTime: Date): Promise<void> {
  return runFetcherWithFs(fetchTime, realFs);
}

// Run if this is the entry point (when executed directly via tsx)
const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("fetch.ts") || process.argv[1].endsWith("fetch.js"));

if (isMain) {
  runFetcher(new Date()).catch((err: unknown) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
