import { describe, expect, it, vi } from "vitest";
import { InMemoryUsageTracker } from "../src/usage";

const now = Date.parse("2026-07-18T12:00:00.000Z");

describe("Phase 5 in-memory usage tracker", () => {
  it("records immutable terminal provider-attempt events and isolates listener failures", () => {
    const tracker = new InMemoryUsageTracker({ now: () => now });
    const listener = vi.fn(() => {
      throw new Error("observer failure");
    });
    tracker.on(listener);

    const event = tracker.record({
      provider: "flux",
      model: "flux-2-pro-preview",
      cost: { amount: 0.04, currency: "usd", estimated: false },
      latencyMs: 1_250,
      success: true,
      promptLength: 14,
      timestamp: "2026-07-18T11:59:00.000Z",
      generationId: "job-1"
    });

    expect(event).toMatchObject({ provider: "flux", cost: { currency: "USD" } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(listener).toHaveBeenCalledWith(event);
    expect(tracker.snapshot()).toHaveLength(1);
  });

  it("summarizes every provider attempt without mixing currencies or estimated costs", () => {
    const tracker = new InMemoryUsageTracker({ now: () => now });
    tracker.record({
      provider: "flux",
      model: "flux-2-pro-preview",
      cost: { amount: 0.04, currency: "USD", estimated: false },
      latencyMs: 1_000,
      success: false,
      promptLength: 5,
      timestamp: "2026-07-18T11:30:00.000Z",
      errorCode: "PROVIDER_ERROR"
    });
    tracker.record({
      provider: "stability",
      model: "stable-image-core",
      cost: { amount: 0.03, currency: "USD", estimated: true },
      latencyMs: 2_000,
      success: true,
      promptLength: 5,
      timestamp: "2026-07-18T11:45:00.000Z"
    });
    tracker.record({
      provider: "mock",
      model: "mock-image-v1",
      cost: { amount: 2, currency: "credits", estimated: true },
      latencyMs: 0,
      success: true,
      promptLength: 5,
      timestamp: "2026-07-17T10:00:00.000Z"
    });

    expect(tracker.summary({ since: "1h" })).toEqual({
      generations: 2,
      successes: 1,
      failures: 1,
      successRate: 0.5,
      averageLatencyMs: 1_500,
      costs: [{ currency: "USD", amount: 0.07, actualAmount: 0.04, estimatedAmount: 0.03 }],
      providers: [
        {
          provider: "flux",
          generations: 1,
          successes: 0,
          failures: 1,
          successRate: 0,
          averageLatencyMs: 1_000,
          costs: [{ currency: "USD", amount: 0.04, actualAmount: 0.04, estimatedAmount: 0 }]
        },
        {
          provider: "stability",
          generations: 1,
          successes: 1,
          failures: 0,
          successRate: 1,
          averageLatencyMs: 2_000,
          costs: [{ currency: "USD", amount: 0.03, actualAmount: 0, estimatedAmount: 0.03 }]
        }
      ]
    });
  });

  it("rejects malformed data and invalid summary ranges", () => {
    const tracker = new InMemoryUsageTracker({ now: () => now });

    expect(() =>
      tracker.record({
        provider: "",
        model: "model",
        cost: { amount: 0, currency: "USD", estimated: true },
        latencyMs: 0,
        success: true,
        promptLength: 0,
        timestamp: "2026-07-18T12:00:00.000Z"
      })
    ).toThrow("event.provider");
    expect(() => tracker.summary({ since: now, until: now - 1 })).toThrow("since");
  });
});
