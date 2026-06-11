/**
 * tests/unit/feedback.test.ts — F-28
 * Unit tests for initFeedback()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initFeedback } from "../../app/feedback";

// ─── Minimal fake DOM element ─────────────────────────────────────────────────

interface FakeElement {
  id: string;
  classList: {
    _set: Set<string>;
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
  };
  _listeners: Record<string, ((e: { target: FakeElement }) => void)[]>;
  addEventListener(event: string, handler: (e: { target: FakeElement }) => void): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  value: string;
  textContent: string;
  className: string;
  disabled: boolean;
  focus(): void;
  _attrs: Record<string, string>;
}

function makeEl(id: string): FakeElement {
  const el: FakeElement = {
    id,
    classList: {
      _set: new Set<string>(),
      add(c: string) { this._set.add(c); },
      remove(c: string) { this._set.delete(c); },
      contains(c: string) { return this._set.has(c); },
    },
    _listeners: {},
    addEventListener(event: string, handler: (e: { target: FakeElement }) => void) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(handler);
    },
    _attrs: {},
    getAttribute(name: string) { return this._attrs[name] ?? null; },
    setAttribute(name: string, value: string) { this._attrs[name] = value; },
    value: "",
    textContent: "",
    className: "",
    disabled: false,
    focus() {},
  };
  return el;
}

function fire(el: FakeElement, event: string, extraProps: Partial<{ target: FakeElement }> = {}): void {
  const handlers = el._listeners[event] ?? [];
  const evt = { target: el, ...extraProps };
  handlers.forEach((h) => h(evt as { target: FakeElement }));
}

// ─── Test setup ────────────────────────────────────────────────────────────────

let elements: Record<string, FakeElement>;
let modalEl: FakeElement;

beforeEach(() => {
  vi.useFakeTimers();

  const btn = makeEl("feedback-btn");
  const overlay = makeEl("feedback-overlay");
  const cancel = makeEl("feedback-cancel");
  const submit = makeEl("feedback-submit");
  const text = makeEl("feedback-text");
  const confirm = makeEl("feedback-confirm");
  modalEl = makeEl("feedback-modal");

  elements = { btn, overlay, cancel, submit, text, confirm, modal: modalEl };

  const elMap: Record<string, FakeElement> = {
    "feedback-btn": btn,
    "feedback-overlay": overlay,
    "feedback-cancel": cancel,
    "feedback-submit": submit,
    "feedback-text": text,
    "feedback-confirm": confirm,
  };

  (globalThis as Record<string, unknown>).document = {
    getElementById(id: string): FakeElement | null {
      return elMap[id] ?? null;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).fetch;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("F-28 initFeedback", () => {
  it("GIVEN initFeedback is called, WHEN #feedback-btn click fires, THEN #feedback-overlay classList contains 'open'", () => {
    initFeedback();
    fire(elements.btn, "click");
    expect(elements.overlay.classList.contains("open")).toBe(true);
  });

  it("GIVEN modal is open, WHEN #feedback-cancel click fires, THEN overlay classList does NOT contain 'open' AND textarea value is ''", () => {
    initFeedback();
    fire(elements.btn, "click");
    expect(elements.overlay.classList.contains("open")).toBe(true);
    elements.text.value = "some text";
    fire(elements.cancel, "click");
    expect(elements.overlay.classList.contains("open")).toBe(false);
    expect(elements.text.value).toBe("");
  });

  it("GIVEN modal is open, WHEN #feedback-overlay click fires with event.target === overlay, THEN overlay classList does NOT contain 'open'", () => {
    initFeedback();
    fire(elements.btn, "click");
    fire(elements.overlay, "click", { target: elements.overlay });
    expect(elements.overlay.classList.contains("open")).toBe(false);
  });

  it("GIVEN modal is open, WHEN #feedback-overlay click fires with event.target === inner modal element, THEN overlay classList still contains 'open'", () => {
    initFeedback();
    fire(elements.btn, "click");
    fire(elements.overlay, "click", { target: modalEl });
    expect(elements.overlay.classList.contains("open")).toBe(true);
  });

  it("GIVEN #feedback-text value is '', WHEN #feedback-submit click fires, THEN fetch is NOT called", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "";
    fire(elements.submit, "click");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("GIVEN #feedback-text value is '  ' (whitespace only), WHEN #feedback-submit click fires, THEN fetch is NOT called", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "  ";
    fire(elements.submit, "click");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("GIVEN #feedback-text value is 'great app', WHEN #feedback-submit click fires, THEN fetch is called once with '/api/feedback' AND parsed body equals { message: 'great app' } AND submit disabled is true", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "great app";
    fire(elements.submit, "click");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/feedback");
    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callArgs.body as string) as { message: string };
    expect(body).toEqual({ message: "great app" });
    expect(elements.submit.disabled).toBe(true);
  });

  it("GIVEN submit fires and fetch resolves with { ok: true }, THEN #feedback-confirm textContent is 'Thanks — feedback received!' AND className is 'success'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "great app";
    fire(elements.submit, "click");
    // Flush microtasks only so the fetch .then() runs but the 2200 ms
    // setTimeout that calls closeModal() has NOT fired yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(elements.confirm.textContent).toBe("Thanks — feedback received!");
    expect(elements.confirm.className).toBe("success");
  });

  it("GIVEN submit fires and fetch resolves with { ok: false }, THEN #feedback-confirm textContent contains 'Something went wrong' AND submit disabled is false", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "great app";
    fire(elements.submit, "click");
    await vi.runAllTimersAsync();
    expect(elements.confirm.textContent).toContain("Something went wrong");
    expect(elements.submit.disabled).toBe(false);
  });

  it("GIVEN submit fires and fetch rejects, THEN #feedback-confirm textContent contains 'Could not send' AND submit disabled is false", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", mockFetch);
    initFeedback();
    elements.text.value = "great app";
    fire(elements.submit, "click");
    await vi.runAllTimersAsync();
    expect(elements.confirm.textContent).toContain("Could not send");
    expect(elements.submit.disabled).toBe(false);
  });
});
