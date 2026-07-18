import { describe, expect, it, vi } from "vitest";
import { ImageGenerationTimeoutError, ProviderError, createImageClient } from "@image-sdk/core";
import {
  FLUX_DEFAULT_POLL_INTERVAL_MS,
  FLUX_DEFAULT_POLL_TIMEOUT_MS,
  flux,
  getFluxDimensions
} from "../src";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("flux adapter", () => {
  it("submits exact mapped dimensions and polls until a result is ready", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "flux-1", polling_url: "https://poll.example/flux-1", cost: 9 }))
      .mockResolvedValueOnce(jsonResponse({ status: "Pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "Ready", result: { sample: "https://cdn.example/image.jpg" } }));
    const client = createImageClient({
      adapters: [
        flux({
          apiKey: "test-key",
          fetch: fetchMock as unknown as typeof fetch,
          sleep: async () => undefined,
          now: () => 1_000
        })
      ]
    });

    const job = await client.generate({ prompt: "a landscape", aspectRatio: "16:9", seed: 42 });
    const result = await job.result();

    const [submitUrl, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe("https://api.bfl.ai/v1/flux-2-pro-preview");
    expect(new Headers(submitInit.headers).get("x-key")).toBe("test-key");
    expect(JSON.parse(String(submitInit.body))).toEqual({
      prompt: "a landscape",
      width: 1344,
      height: 768,
      seed: 42,
      output_format: "jpeg"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      url: "https://cdn.example/image.jpg",
      provider: "flux",
      model: "flux-2-pro-preview",
      width: 1344,
      height: 768,
      cost: { amount: 9, currency: "credits", estimated: false }
    });
    expect(result.expiresAt).toBe(new Date(601_000).toISOString());
  });

  it("maps provider terminal failures to ProviderError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "flux-2", polling_url: "https://poll.example/flux-2" }))
      .mockResolvedValueOnce(jsonResponse({ status: "Failed", message: "Prompt rejected" }));
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined })]
    });

    const job = await client.generate({ prompt: "a test image" });

    await expect(job.result()).rejects.toBeInstanceOf(ProviderError);
  });

  it("rejects once the 60-second-style polling deadline is reached", async () => {
    let elapsed = 0;
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "flux-3", polling_url: "https://poll.example/flux-3" }));
    const client = createImageClient({
      adapters: [
        flux({
          apiKey: "test-key",
          fetch: fetchMock as unknown as typeof fetch,
          pollIntervalMs: 1_500,
          pollTimeoutMs: 1_500,
          sleep: async (milliseconds) => {
            elapsed += milliseconds;
          },
          now: () => elapsed
        })
      ]
    });

    const job = await client.generate({ prompt: "a slow image" });

    await expect(job.result()).rejects.toBeInstanceOf(ImageGenerationTimeoutError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects unsupported aspect ratios before any paid request", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    await expect(client.generate({ prompt: "a test image", aspectRatio: "3:2" })).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the fixed Phase 1 aspect ratio matrix and polling defaults", () => {
    expect(getFluxDimensions("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(getFluxDimensions("9:16")).toEqual({ width: 768, height: 1344 });
    expect(FLUX_DEFAULT_POLL_INTERVAL_MS).toBe(1_500);
    expect(FLUX_DEFAULT_POLL_TIMEOUT_MS).toBe(60_000);
  });
});
