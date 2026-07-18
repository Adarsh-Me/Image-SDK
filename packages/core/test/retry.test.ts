import { describe, expect, it } from "vitest";
import { classifyGenerationFailure, getRetryDelayMs, normalizeRetryPolicy } from "../src/retry";

describe("Phase 5 retry policy", () => {
  it("normalizes a deterministic exponential policy", () => {
    expect(normalizeRetryPolicy({ retries: 2, initialDelayMs: 100, maxDelayMs: 250 })).toEqual({
      retries: 2,
      backoff: "exponential",
      initialDelayMs: 100,
      maxDelayMs: 250
    });
    expect(getRetryDelayMs(1, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(100);
    expect(getRetryDelayMs(2, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(200);
    expect(getRetryDelayMs(3, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });

  it("retries only transient provider, timeout, and network failures", () => {
    expect(classifyGenerationFailure({ code: "GENERATION_TIMEOUT" })).toMatchObject({ disposition: "retry" });
    expect(classifyGenerationFailure({ code: "PROVIDER_ERROR", status: 429 })).toMatchObject({ disposition: "retry" });
    expect(classifyGenerationFailure({ code: "ETIMEDOUT" })).toMatchObject({ disposition: "retry" });
    expect(classifyGenerationFailure(new TypeError("fetch failed due to network failure"))).toMatchObject({ disposition: "retry" });
  });

  it("never retries or falls back for cancellation, moderation, invalid input, configuration, or auth", () => {
    for (const error of [
      { code: "GENERATION_CANCELLED" },
      { code: "MODERATION_REJECTED" },
      { code: "UNSUPPORTED_CAPABILITY" },
      { code: "INVALID_REQUEST" },
      { code: "CONFIGURATION_ERROR" },
      { code: "PROVIDER_ERROR", status: 401 }
    ]) {
      expect(classifyGenerationFailure(error)).toMatchObject({ disposition: "fail" });
    }
  });

  it("allows a terminal provider response to move directly to the next adapter", () => {
    expect(classifyGenerationFailure({ code: "PROVIDER_ERROR", status: 422 })).toEqual({
      disposition: "fallback",
      reason: "provider-terminal"
    });
    expect(classifyGenerationFailure({ code: "PROVIDER_ERROR" })).toEqual({
      disposition: "fallback",
      reason: "provider-terminal"
    });
  });
});
