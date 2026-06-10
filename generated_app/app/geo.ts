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
 * Geocode a cross-street name (e.g. "9th St") in Hoboken, NJ.
 * Results are cached in memory — null is cached too (failure is not retried).
 * Rate-limited to 1 req/sec shared with getStreetName.
 */
export async function geocodeCrossStreet(
  streetName: string
): Promise<{ lat: number; lng: number } | null> {
  // Return cached value immediately (no network call)
  if (_crossStreetCache.has(streetName)) {
    return _crossStreetCache.get(streetName) ?? null;
  }

  await _rateLimit();
  _lastNominatimCallMs = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(streetName + ", Hoboken, NJ")}&limit=1`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept-Language": "en",
      },
    });

    const data = (await response.json()) as Array<{ lat: string; lon: string }>;

    if (data.length > 0 && data[0] !== undefined) {
      const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      _crossStreetCache.set(streetName, result);
      return result;
    }

    _crossStreetCache.set(streetName, null);
    return null;
  } catch {
    _crossStreetCache.set(streetName, null);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
