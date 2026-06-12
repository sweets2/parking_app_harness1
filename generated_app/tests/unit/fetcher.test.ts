import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  toIsoDatetime,
  computeActiveAtFetch,
  validateResponseShape,
  validateSign,
  checkCountDrop,
  runFetcher,
  runFetcherWithFs,
  runFutureFetcherWithFs,
} from "../../fetcher/fetch";

// ---------------------------------------------------------------------------
// F-01.7 — Date parsing
// ---------------------------------------------------------------------------

describe("toIsoDatetime", () => {
  it("converts 5/8/2026 + 08:00:00 to 2026-05-08T08:00:00", () => {
    expect(toIsoDatetime("5/8/2026", "08:00:00")).toBe("2026-05-08T08:00:00");
  });

  it("converts 12/31/2030 + 07:00:00 to 2030-12-31T07:00:00", () => {
    expect(toIsoDatetime("12/31/2030", "07:00:00")).toBe("2030-12-31T07:00:00");
  });

  it("zero-pads single-digit month and day (1/1/2026)", () => {
    expect(toIsoDatetime("1/1/2026", "00:00:00")).toMatch(/^2026-01-01T/);
  });
});

describe("computeActiveAtFetch", () => {
  it("returns true when fetchTime is within the window", () => {
    const fetchTime = new Date("2026-05-28T06:00:00Z");
    expect(
      computeActiveAtFetch("2026-05-26T08:00:00", "2026-05-29T16:00:00", fetchTime)
    ).toBe(true);
  });

  it("returns false when fetchTime is after the window", () => {
    const fetchTime = new Date("2026-05-30T06:00:00Z");
    expect(
      computeActiveAtFetch("2026-05-26T08:00:00", "2026-05-29T16:00:00", fetchTime)
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-01.2 — Response shape validation
// ---------------------------------------------------------------------------

describe("validateResponseShape", () => {
  it("returns the body when status is success and data is an array", () => {
    const body = { status: "success", data: [] };
    const result = validateResponseShape(body);
    expect(result).toEqual({ status: "success", data: [] });
  });

  it("calls process.exit(1) when status is not success", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });
    expect(() => validateResponseShape({ status: "error", data: [] })).toThrow();
    exitSpy.mockRestore();
  });

  it("calls process.exit(1) when there is no data key", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });
    expect(() => validateResponseShape({ status: "success" })).toThrow();
    exitSpy.mockRestore();
  });

  it("calls process.exit(1) when data is not an array", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });
    expect(() => validateResponseShape({ status: "success", data: "nope" })).toThrow();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F-01.3 — Individual sign field validation
// ---------------------------------------------------------------------------

const validRawSign = {
  id: "200471",
  address: "257-257 11TH ST",
  reason: "CONSTRUCTION",
  permit_number: "510881",
  latitude: 40.7503072,
  longitude: -74.0303045,
  start_date: "5/11/2023",
  start_time: "07:00:00",
  stop_date: "12/31/2030",
  end_time: "07:00:00",
};

describe("validateSign — field validation", () => {
  it("returns a warning with 'id' when id field is absent", () => {
    const sign = { ...validRawSign } as Record<string, unknown>;
    delete sign["id"];
    const warnings = validateSign(sign, 0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/id/i);
    expect(warnings[0]).toMatch(/0/);
  });

  it("returns a warning when latitude is a string instead of a number", () => {
    const sign = { ...validRawSign, latitude: "40.75" };
    const warnings = validateSign(sign, 3);
    expect(warnings.some((w) => /latitude/i.test(w))).toBe(true);
  });

  it("returns no warnings for a fully valid sign", () => {
    const warnings = validateSign(validRawSign, 0);
    expect(warnings).toHaveLength(0);
  });

  it("returns exactly one warning when one sign among ten is invalid", () => {
    const signs: unknown[] = Array(9).fill(validRawSign);
    const badSign = { ...validRawSign, latitude: "bad" };
    const allSigns = [...signs, badSign];
    const allWarnings = allSigns.flatMap((s, i) => validateSign(s, i));
    expect(allWarnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F-01.4 — Sign reason validation
// ---------------------------------------------------------------------------

describe("validateSign — reason validation", () => {
  it("returns a warning containing 'FILM' for an unknown reason", () => {
    const sign = { ...validRawSign, reason: "FILM" };
    const warnings = validateSign(sign, 0);
    expect(warnings.some((w) => w.includes("FILM"))).toBe(true);
  });

  it("returns no warning for a known reason CONSTRUCTION", () => {
    const sign = { ...validRawSign, reason: "CONSTRUCTION" };
    const warnings = validateSign(sign, 0);
    expect(warnings.every((w) => !/reason/i.test(w))).toBe(true);
  });

  it("returns a warning for an empty string reason", () => {
    const sign = { ...validRawSign, reason: "" };
    const warnings = validateSign(sign, 0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F-01.6 — Count-change warning
// ---------------------------------------------------------------------------

describe("checkCountDrop", () => {
  it("returns a warning when new count is less than 50% of previous count", () => {
    const warning = checkCountDrop(10, 30);
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/10/);
    expect(warning).toMatch(/30/);
  });

  it("returns null when new count is more than 50% of previous count", () => {
    const warning = checkCountDrop(20, 30);
    expect(warning).toBeNull();
  });

  it("returns null when there is no previous count (first run)", () => {
    const warning = checkCountDrop(100, null);
    expect(warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F-01.1 & F-01.5 — HTTP request and guard-before-write tests
// ---------------------------------------------------------------------------

describe("runFetcher — HTTP and guard tests", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls process.exit non-zero when API returns HTTP 403", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(runFetcher(new Date("2026-06-09T13:00:00Z"))).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });

  it("calls process.exit non-zero when API returns HTTP 500", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(runFetcher(new Date("2026-06-09T13:00:00Z"))).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });

  it("calls process.exit non-zero when network is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(runFetcher(new Date("2026-06-09T13:00:00Z"))).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });

  it("calls process.exit non-zero when raw.data is empty (guard before write)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [] }),
    } as unknown as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    await expect(runFetcher(new Date("2026-06-09T13:00:00Z"))).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });

  it("validateResponseShape runs without error for valid 200 response (empty data still triggers exit)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [] }),
    } as unknown as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    // Empty data guard causes exit after validateResponseShape succeeds
    await expect(runFetcher(new Date("2026-06-09T13:00:00Z"))).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F-01.8 — Output file format (injectable fs backend)
// ---------------------------------------------------------------------------

describe("runFetcher — output file format", () => {
  const rawSign = {
    id: "1",
    address: "123 Main St",
    reason: "CONSTRUCTION",
    permit_number: "999",
    latitude: 40.75,
    longitude: -74.03,
    start_date: "1/1/2020",
    start_time: "08:00:00",
    stop_date: "12/31/2030",
    end_time: "17:00:00",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [rawSign] }),
    } as unknown as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeMockFs() {
    const writes: Array<[string, string]> = [];
    const mockFs = {
      readFile: async (_p: string): Promise<string> => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      writeFile: async (p: string, data: string): Promise<void> => {
        writes.push([p, data]);
      },
      writes,
    };
    return mockFs;
  }

  it("writes latest.json with correct count and signs length", async () => {
    const mockFs = makeMockFs();
    await runFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const latestCall = mockFs.writes.find(([p]) => p.endsWith("latest.json"));
    expect(latestCall).toBeDefined();
    if (latestCall) {
      const written = JSON.parse(latestCall[1]) as { count: number; signs: unknown[] };
      expect(written.count).toBe(1);
      expect(written.signs).toHaveLength(1);
    }
  });

  it("names the archive file parking_YYYY-MM-DD.json based on run date", async () => {
    const mockFs = makeMockFs();
    await runFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const archiveCall = mockFs.writes.find(([p]) => p.includes("parking_2026-06-09"));
    expect(archiveCall).toBeDefined();
  });

  it("fetched_at matches UTC ISO 8601 pattern", async () => {
    const mockFs = makeMockFs();
    await runFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const latestCall = mockFs.writes.find(([p]) => p.endsWith("latest.json"));
    expect(latestCall).toBeDefined();
    if (latestCall) {
      const written = JSON.parse(latestCall[1]) as { fetched_at: string };
      expect(written.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    }
  });

  it("signs in output have expected transformed fields", async () => {
    const mockFs = makeMockFs();
    await runFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const latestCall = mockFs.writes.find(([p]) => p.endsWith("latest.json"));
    expect(latestCall).toBeDefined();
    if (latestCall) {
      const written = JSON.parse(latestCall[1]) as { signs: Record<string, unknown>[] };
      const sign = written.signs[0];
      expect(sign).toHaveProperty("start_iso");
      expect(sign).toHaveProperty("end_iso");
      expect(sign).toHaveProperty("active_at_fetch");
      expect(sign).toHaveProperty("lat");
      expect(sign).toHaveProperty("lng");
      expect(sign).toHaveProperty("start_date");
      expect(sign).toHaveProperty("start_time");
      expect(sign).toHaveProperty("stop_date");
      expect(sign).toHaveProperty("end_time");
    }
  });
});

// ---------------------------------------------------------------------------
// F-35 — runFutureFetcherWithFs
// ---------------------------------------------------------------------------

describe("runFutureFetcherWithFs", () => {
  function makeRawSign(overrides: Record<string, unknown> = {}) {
    return {
      id: "1",
      address: "123 Main St",
      reason: "CONSTRUCTION",
      permit_number: "999",
      latitude: 40.75,
      longitude: -74.03,
      start_date: "1/1/2020",
      start_time: "08:00:00",
      stop_date: "12/31/2030",
      end_time: "17:00:00",
      ...overrides,
    };
  }

  function makeMockFs() {
    const writes: Array<[string, string]> = [];
    return {
      readFile: async (_p: string): Promise<string> => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      writeFile: async (p: string, data: string): Promise<void> => {
        writes.push([p, data]);
      },
      writes,
    };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GIVEN future API returns 3 signs (1 with start_iso <= fetchTime, 2 upcoming) WHEN runFutureFetcherWithFs runs THEN future.json contains 2 signs", async () => {
    // fetchTime is 2026-06-09T13:00:00Z → fetchLocalIso = "2026-06-09T13:00:00"
    const fetchTime = new Date("2026-06-09T13:00:00Z");
    // Sign 1: starts before fetchTime (not upcoming)
    const pastSign = makeRawSign({ id: "1", start_date: "6/9/2026", start_time: "08:00:00", stop_date: "6/9/2026", end_time: "23:59:00" });
    // Sign 2: starts after fetchTime (upcoming)
    const upcoming1 = makeRawSign({ id: "2", start_date: "6/9/2026", start_time: "14:00:00", stop_date: "6/9/2026", end_time: "23:59:00" });
    // Sign 3: starts after fetchTime (upcoming)
    const upcoming2 = makeRawSign({ id: "3", start_date: "6/10/2026", start_time: "08:00:00", stop_date: "6/10/2026", end_time: "17:00:00" });

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [pastSign, upcoming1, upcoming2] }),
    } as unknown as Response);

    const mockFs = makeMockFs();
    await runFutureFetcherWithFs(fetchTime, mockFs);

    const futureCall = mockFs.writes.find(([p]) => p.endsWith("future.json"));
    expect(futureCall).toBeDefined();
    if (futureCall) {
      const written = JSON.parse(futureCall[1]) as { count: number; signs: unknown[] };
      expect(written.count).toBe(2);
      expect(written.signs).toHaveLength(2);
    }
  });

  it("GIVEN future API returns 0 upcoming signs WHEN runFutureFetcherWithFs runs THEN future.json written with empty array and process.exit NOT called", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    // All signs are in the past (start_iso <= fetchLocalIso)
    const pastSign = makeRawSign({ id: "1", start_date: "6/9/2026", start_time: "08:00:00", stop_date: "6/9/2026", end_time: "12:00:00" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [pastSign] }),
    } as unknown as Response);

    const mockFs = makeMockFs();
    await runFutureFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    exitSpy.mockRestore();

    const futureCall = mockFs.writes.find(([p]) => p.endsWith("future.json"));
    expect(futureCall).toBeDefined();
    if (futureCall) {
      const written = JSON.parse(futureCall[1]) as { count: number; signs: unknown[] };
      expect(written.signs).toHaveLength(0);
    }
  });

  it("GIVEN a full runFetcherWithFs run THEN both latest.json and future.json are written", async () => {
    const rawSign = makeRawSign({ id: "1", start_date: "1/1/2020", start_time: "08:00:00", stop_date: "12/31/2030", end_time: "17:00:00" });
    // Mock both calls: main API and future API
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ status: "success", data: [rawSign] }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ status: "success", data: [rawSign] }),
      } as unknown as Response);

    const mockFs = makeMockFs();
    await runFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const latestCall = mockFs.writes.find(([p]) => p.endsWith("latest.json"));
    const futureCall = mockFs.writes.find(([p]) => p.endsWith("future.json"));
    expect(latestCall).toBeDefined();
    expect(futureCall).toBeDefined();
  });

  it("GIVEN future API returns HTTP 500 THEN process.exit(1) called", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as unknown as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code) => {
      throw new Error("process.exit called");
    });

    const mockFs = makeMockFs();
    await expect(runFutureFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs)).rejects.toThrow(
      "process.exit called"
    );
    exitSpy.mockRestore();
  });

  it("GIVEN a successful future fetch THEN future.json has fetched_at, count, and signs[] each with start_iso, end_iso, lat, lng", async () => {
    const upcoming = makeRawSign({ id: "2", start_date: "6/10/2026", start_time: "08:00:00", stop_date: "6/10/2026", end_time: "17:00:00" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: [upcoming] }),
    } as unknown as Response);

    const mockFs = makeMockFs();
    await runFutureFetcherWithFs(new Date("2026-06-09T13:00:00Z"), mockFs);

    const futureCall = mockFs.writes.find(([p]) => p.endsWith("future.json"));
    expect(futureCall).toBeDefined();
    if (futureCall) {
      const written = JSON.parse(futureCall[1]) as { fetched_at: string; count: number; signs: Record<string, unknown>[] };
      expect(written).toHaveProperty("fetched_at");
      expect(written).toHaveProperty("count");
      expect(written).toHaveProperty("signs");
      expect(Array.isArray(written.signs)).toBe(true);
      if (written.signs.length > 0) {
        const sign = written.signs[0];
        expect(sign).toHaveProperty("start_iso");
        expect(sign).toHaveProperty("end_iso");
        expect(sign).toHaveProperty("lat");
        expect(sign).toHaveProperty("lng");
      }
    }
  });
});
