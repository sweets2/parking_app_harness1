import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("getStreetName", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset modules so _lastNominatimCallMs starts at 0 for each test
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns road name when Nominatim returns address with road field", async () => {
    const { getStreetName } = await import("../../app/geo");
    const mockResponse = {
      address: { road: "Washington Street" },
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await getStreetName(40.744, -74.032);
    expect(result).toBe("Washington Street");
  });

  it("returns null when Nominatim returns address without road field", async () => {
    const { getStreetName } = await import("../../app/geo");
    const mockResponse = {
      address: {},
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await getStreetName(40.744, -74.032);
    expect(result).toBeNull();
  });

  it("returns null on network error without throwing", async () => {
    const { getStreetName } = await import("../../app/geo");
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await getStreetName(40.744, -74.032);
    expect(result).toBeNull();
  });

  it("returns null when request exceeds 8 seconds without throwing", async () => {
    const { getStreetName } = await import("../../app/geo");
    global.fetch = vi.fn().mockImplementation((_url: string, options?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      });
    });

    const promise = getStreetName(40.744, -74.032);
    await vi.advanceTimersByTimeAsync(8001);
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ─── F-20 geocodeCrossStreet ──────────────────────────────────────────────────

describe("geocodeCrossStreet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset module between tests to clear cache and rate-limit state
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("GIVEN a mocked fetch returning [{lat:'40.744',lon:'-74.032'}], WHEN geocodeCrossStreet('9th St') is called, THEN returns {lat:40.744,lng:-74.032}", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "40.744", lon: "-74.032" }],
    } as Response);

    const result = await geocodeCrossStreet("9th St");
    expect(result).toEqual({ lat: 40.744, lng: -74.032 });
  });

  it("GIVEN a mocked fetch returning an empty array, WHEN geocodeCrossStreet('nonexistent') is called, THEN returns null", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await geocodeCrossStreet("nonexistent");
    expect(result).toBeNull();
  });

  it("GIVEN a mocked fetch that throws a network error, WHEN geocodeCrossStreet('9th St') is called, THEN returns null without throwing", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await geocodeCrossStreet("9th St");
    expect(result).toBeNull();
  });

  it("GIVEN geocodeCrossStreet('9th St') has been called once successfully, WHEN it is called a second time, THEN fetch is NOT called again", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "40.744", lon: "-74.032" }],
    } as Response);
    global.fetch = mockFetch;

    await geocodeCrossStreet("9th St");
    // Advance timers so rate-limit delay is bypassed for second call
    await vi.advanceTimersByTimeAsync(1001);
    const secondResult = await geocodeCrossStreet("9th St");

    // Fetch should only have been called once (cached)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual({ lat: 40.744, lng: -74.032 });
  });

  it("GIVEN geocodeCrossStreet('bad') returned null and was cached, WHEN it is called a second time, THEN fetch is NOT called again", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);
    global.fetch = mockFetch;

    await geocodeCrossStreet("bad");
    // Advance timers so rate-limit delay is bypassed for second call
    await vi.advanceTimersByTimeAsync(1001);
    const secondResult = await geocodeCrossStreet("bad");

    // Fetch should only have been called once (cached null)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(secondResult).toBeNull();
  });

  it("GIVEN mainStreet is provided, WHEN geocodeCrossStreet('hudson street', '7th street') is called, THEN the Nominatim URL contains the intersection query form", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "40.7462", lon: "-74.0380" }],
    } as Response);
    global.fetch = mockFetch;

    await geocodeCrossStreet("hudson street", "7th street");

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = (mockFetch.mock.calls[0] as [string])[0];
    // URL must encode "hudson street & 7th street, Hoboken, NJ" — not the standalone avenue
    expect(url).toContain("hudson%20street%20%26%207th%20street");
  });

  it("GIVEN mainStreet is provided, WHEN geocodeCrossStreet is called twice with the same pair, THEN fetch is called only once (intersection key cached)", async () => {
    const { geocodeCrossStreet } = await import("../../app/geo");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "40.7462", lon: "-74.0380" }],
    } as Response);
    global.fetch = mockFetch;

    await geocodeCrossStreet("hudson street", "7th street");
    await vi.advanceTimersByTimeAsync(1001);
    const second = await geocodeCrossStreet("hudson street", "7th street");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ lat: 40.7462, lng: -74.038 });
  });
});
