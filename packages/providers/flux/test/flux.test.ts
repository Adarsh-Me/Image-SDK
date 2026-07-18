import { describe, expect, it, vi } from "vitest";
import { ImageGenerationTimeoutError, ModerationError, ProviderError, UnsupportedCapabilityError, createImageClient } from "@image-sdk/core";
import {
  FLUX_CAPABILITIES,
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
      cost: { amount: 9, currency: "credits", estimated: false },
      moderation: { flagged: false, provider: "flux" }
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

    await expect(client.generate({ prompt: "a test image", aspectRatio: "3:2" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("advertises its supported options and rejects unsupported quality before submission", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    await expect(client.capabilities("flux")).resolves.toBe(FLUX_CAPABILITIES);
    await expect(client.generate({ prompt: "a test image", quality: "high" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes provider content-policy failures as moderation errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "flux-moderated", polling_url: "https://poll.example/flux-moderated" }))
      .mockResolvedValueOnce(jsonResponse({ status: "Failed", message: "Prompt blocked by content policy" }));
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined })]
    });

    const job = await client.generate({ prompt: "a restricted prompt" });

    await expect(job.result()).rejects.toMatchObject({
      name: "ModerationError",
      moderation: { flagged: true, provider: "flux", reason: "Prompt blocked by content policy" }
    });
    await expect(job.result()).rejects.toBeInstanceOf(ModerationError);
  });

  it("exposes the fixed Phase 1 aspect ratio matrix and polling defaults", () => {
    expect(getFluxDimensions("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(getFluxDimensions("9:16")).toEqual({ width: 768, height: 1344 });
    expect(FLUX_DEFAULT_POLL_INTERVAL_MS).toBe(1_500);
    expect(FLUX_DEFAULT_POLL_TIMEOUT_MS).toBe(60_000);
  });

  it("submits an async job with a webhook URL and exposes resumable polling metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ id: "flux-async", polling_url: "https://poll.example/flux-async", cost: 2 })
    );
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    const job = await client.generate({
      prompt: "an async image",
      strategy: "async",
      webhookUrl: "https://app.example/webhooks/flux",
      aspectRatio: "4:3"
    });

    expect(job.strategy).toBe("async");
    expect(job.metadata).toEqual({
      pollingUrl: "https://poll.example/flux-async",
      width: 1152,
      height: 864,
      model: "flux-2-pro-preview",
      cost: 2
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      webhook_url: "https://app.example/webhooks/flux",
      width: 1152,
      height: 864
    });
  });

  it("submits HTTPS image references for Flux image-to-image editing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "flux-edit", polling_url: "https://poll.example/flux-edit" }));
    const client = createImageClient({ adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })] });

    await client.generate({
      prompt: "turn it into a watercolor",
      image: "https://images.example/original.jpg",
      aspectRatio: "16:9"
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      input_image: "https://images.example/original.jpg",
      width: 1344,
      height: 768
    });
  });

  it("rejects byte-backed Flux references without submitting a provider request", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({ adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })] });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    await expect(client.generate({ prompt: "edit", image })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported Flux image-edit strength without submitting a provider request", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({ adapters: [flux({ apiKey: "test-key", fetch: fetchMock as unknown as typeof fetch })] });

    await expect(
      client.generate({ prompt: "edit", image: "https://images.example/original.jpg", strength: 0.5 })
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes a Flux job from persisted polling metadata without submitting another request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ status: "Ready", result: { sample: "https://cdn.example/resumed.jpg" } })
    );
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

    const job = await client.job("flux-resumed", {
      provider: "flux",
      metadata: {
        pollingUrl: "https://poll.example/flux-resumed",
        width: 1344,
        height: 768,
        model: "flux-2-pro-preview",
        seed: 44
      }
    });

    await expect(job.result()).resolves.toMatchObject({
      url: "https://cdn.example/resumed.jpg",
      width: 1344,
      height: 768,
      seed: 44
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://poll.example/flux-resumed",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("validates and normalizes Ready webhook payloads", async () => {
    const client = createImageClient({
      adapters: [flux({ apiKey: "test-key", webhookSecret: "inbound-secret", now: () => 1_000 })]
    });
    const request = new Request("https://app.example/webhooks/flux", {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "inbound-secret" },
      body: JSON.stringify({
        id: "flux-webhook",
        status: "Ready",
        result: { sample: "https://cdn.example/webhook.jpg" }
      })
    });

    await expect(
      client.parseWebhook(request, {
        provider: "flux",
        metadata: { width: 768, height: 1344, model: "flux-2-pro-preview", cost: 4 }
      })
    ).resolves.toMatchObject({
      url: "https://cdn.example/webhook.jpg",
      width: 768,
      height: 1344,
      cost: { amount: 4, currency: "credits", estimated: false }
    });
  });
});
