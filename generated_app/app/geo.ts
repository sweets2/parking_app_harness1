const NOMINATIM_TIMEOUT_MS = 8000;

// ─── Module-level rate-limit state (shared across all Nominatim callers) ────

const _crossStreetCache = new Map<string, { lat: number; lng: number } | null>();
let _lastNominatimCallMs = 0;

async function _rateLimit(): Promise<void> {
  const elapsed = Date.now() - _lastNominatimCallMs;
  if (elapsed < 1000) {
    await new Promise<void>((r) => setTimeout(r, 1000 - elapsed));
  }
}

export async function getStreetName(lat: number, lng: number): Promise<string | null> {
  await _rateLimit();
  _lastNominatimCallMs = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept-Language": "en",
      },
    });

    const data = (await response.json()) as { address?: { road?: string } };

    if (data.address && typeof data.address.road === "string") {
      return data.address.road;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Pre-seed the cross-street cache from a build-time lookup table.
 * Only inserts keys not already present — a live geocode result takes priority.
 */
export function seedGeocodeCache(
  table: Record<string, { lat: number; lng: number } | null>
): void {
  for (const [key, value] of Object.entries(table)) {
    if (!_crossStreetCache.has(key)) {
      _crossStreetCache.set(key, value);
    }
  }
}

/**
 * Geocode a cross-street in Hoboken, NJ.
 * When mainStreet is provided, geocodes the intersection ("crossStreet & mainStreet")
 * and caches under "mainStreet|crossStreet" — this avoids avenue-centroid errors where
 * a standalone geocode places the street far from the actual crossing point.
 * When mainStreet is omitted, behaves as before (standalone geocode, cached by streetName).
 * Results are cached in memory — null is cached too (failure is not retried).
 * Rate-limited to 1 req/sec shared with getStreetName.
 */
export async function geocodeCrossStreet(
  streetName: string,
  mainStreet?: string
): Promise<{ lat: number; lng: number } | null> {
  const cacheKey = mainStreet !== undefined ? `${mainStreet}|${streetName}` : streetName;
  const query = mainStreet !== undefined
    ? `${streetName} & ${mainStreet}, Hoboken, NJ`
    : `${streetName}, Hoboken, NJ`;

  // Return cached value immediately (no network call)
  if (_crossStreetCache.has(cacheKey)) {
    return _crossStreetCache.get(cacheKey) ?? null;
  }

  // For intersection keys not yet seeded, use the standalone centroid if available.
  // The standalone centroid is a reasonable fallback for streets where the centroid is
  // close to the actual intersection (e.g. short streets or streets near map center).
  if (mainStreet !== undefined && _crossStreetCache.has(streetName)) {
    return _crossStreetCache.get(streetName) ?? null;
  }

  await _rateLimit();
  _lastNominatimCallMs = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept-Language": "en",
      },
    });

    const data = (await response.json()) as Array<{ lat: string; lon: string }>;

    if (data.length > 0 && data[0] !== undefined) {
      const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      _crossStreetCache.set(cacheKey, result);
      return result;
    }

    _crossStreetCache.set(cacheKey, null);
    return null;
  } catch {
    _crossStreetCache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
