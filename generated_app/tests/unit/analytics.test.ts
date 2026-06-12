/**
 * tests/unit/analytics.test.ts — F-39
 *
 * Tests for the analytics track() wrapper.
 * Runs in Node (environment: "node"). Tests simulate window presence/absence
 * via globalThis["window"] assignment.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { track } from "../../app/analytics";

describe("analytics track()", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["window"];
  });

  it("GIVEN the Node runtime has no window global, WHEN track() is called, THEN no exception is thrown", () => {
    // No window set — default Node environment
    expect(() => track("test-event")).not.toThrow();
  });

  it("GIVEN window is set to an empty object (no umami property), WHEN track() is called, THEN no exception is thrown", () => {
    (globalThis as Record<string, unknown>)["window"] = {};
    expect(() => track("test-event")).not.toThrow();
  });

  it("GIVEN window.umami.track is a spy, WHEN track('map-zoomed', { zoom_level: 15 }) is called, THEN the spy is called exactly once with the event name and data", () => {
    const spy = vi.fn();
    (globalThis as Record<string, unknown>)["window"] = { umami: { track: spy } };
    track("map-zoomed", { zoom_level: 15 });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("map-zoomed", { zoom_level: 15 });
  });

  it("GIVEN window.umami.track is a spy, WHEN track('app-loaded') is called without a data argument, THEN the spy is called exactly once with event name and undefined", () => {
    const spy = vi.fn();
    (globalThis as Record<string, unknown>)["window"] = { umami: { track: spy } };
    track("app-loaded");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("app-loaded", undefined);
  });
});
