/**
 * app/analytics.ts — F-39
 *
 * Thin Umami analytics wrapper. Guards with typeof window so it is a
 * silent no-op in Node/vitest environments — no mocking needed in tests.
 */

declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void };
  }
}

export function track(event: string, data?: Record<string, unknown>): void {
  if (typeof window !== "undefined") {
    window.umami?.track(event, data);
  }
}
