import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  ConfigurationError,
  InvalidRequestError,
  ProviderError,
  UnsupportedCapabilityError,
  configureDefaultAdapterResolver,
  createImageClient,
  editImage,
  generateImage,
  type Adapter,
  type AdapterCapabilities,
  type ImageResult
} from "../src";

const fixture: ImageResult = {
  url: "https://example.test/image.jpg",
  mimeType: "image/jpeg",
  width: 1024,
  height: 1024,
  provider: "test",
  model: "test-model",
  cost: { amount: 0, currency: "USD", estimated: true },
  moderation: { flagged: false, provider: "test" }
};

const testCapabilities: AdapterCapabilities = {
  aspectRatios: ["1:1"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: ["standard"],
  outputFormats: ["png"],
  async: true,
  webhooks: true,
  livePreview: false
};

afterEach(() => {
  configureDefaultAdapterResolver();
});

describe("createImageClient", () => {
  it("delegates generation to the configured adapter and emits completion", async () => {
    const generate = vi.fn().mockResolvedValue({
      id: "job-1",
      provider: "test",
      status: "queued",
      result: vi.fn().mockResolvedValue(fixture)
    });
    const adapter: Adapter = { provider: "test", capabilities: testCapabilities, generate };
    const client = createImageClient({ adapters: [adapter] });

    const job = await client.generate({ prompt: "  a test image  ", seed: 42 });
    const completed = vi.fn();
    job.on("complete", completed);

    await expect(job.result()).resolves.toEqual(fixture);
    expect(generate).toHaveBeenCalledWith({
      prompt: "a test image",
      mode: "text-to-image",
      seed: 42,
      aspectRatio: undefined,
      quality: undefined,
      strategy: "managed"
    });
    expect(job.status).toBe("complete");
    expect(completed).toHaveBeenCalledWith(fixture);
  });

  it("rejects empty prompts before calling an adapter", async () => {
    const client = createImageClient({ adapters: [] });

    await expect(client.generate({ prompt: "   " })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("retries transient failures, falls back to the next provider, and records usage", async () => {
    const firstGenerate = vi.fn()
      .mockResolvedValueOnce({ id: "first-1", provider: "first", result: vi.fn().mockRejectedValue(new ProviderError("first", "busy", 503)) })
      .mockResolvedValueOnce({ id: "first-2", provider: "first", result: vi.fn().mockResolvedValue({ ...fixture, provider: "first" }) });
    const secondResult = { ...fixture, provider: "second", model: "second-model" };
    const secondGenerate = vi.fn().mockResolvedValue({ id: "second-1", provider: "second", result: vi.fn().mockResolvedValue(secondResult) });
    const client = createImageClient({
      adapters: [
        { provider: "first", capabilities: testCapabilities, generate: firstGenerate },
        { provider: "second", capabilities: testCapabilities, generate: secondGenerate }
      ],
      retry: { retries: 1, initialDelayMs: 0 },
      fallback: true
    });

    const result = await (await client.generate({ prompt: "resilient image" })).result();

    expect(result.provider).toBe("first");
    expect(firstGenerate).toHaveBeenCalledTimes(2);
    expect(secondGenerate).not.toHaveBeenCalled();
    expect(client.usage?.summary()).toMatchObject({ generations: 2, successes: 1, failures: 1 });
  });

  it("falls back after a terminal provider error", async () => {
    const firstGenerate = vi.fn().mockResolvedValue({ id: "first", provider: "first", result: vi.fn().mockRejectedValue(new ProviderError("first", "bad request", 400)) });
    const secondGenerate = vi.fn().mockResolvedValue({ id: "second", provider: "second", result: vi.fn().mockResolvedValue({ ...fixture, provider: "second" }) });
    const client = createImageClient({
      adapters: [
        { provider: "first", capabilities: testCapabilities, generate: firstGenerate },
        { provider: "second", capabilities: testCapabilities, generate: secondGenerate }
      ],
      fallback: true
    });

    await expect((await client.generate({ prompt: "fallback image" })).result()).resolves.toMatchObject({ provider: "second" });
    expect(secondGenerate).toHaveBeenCalledOnce();
  });

  it("revalidates maxCostPerCall before a fallback provider is called", async () => {
    const firstGenerate = vi.fn().mockResolvedValue({
      id: "first",
      provider: "first",
      result: vi.fn().mockRejectedValue(new ProviderError("first", "bad request", 400))
    });
    const secondGenerate = vi.fn().mockResolvedValue({ id: "second", provider: "second", result: vi.fn().mockResolvedValue({ ...fixture, provider: "second" }) });
    const client = createImageClient({
      adapters: [
        {
          provider: "first",
          capabilities: testCapabilities,
          estimateCost: () => ({ amount: 0.01, currency: "USD", estimated: true }),
          generate: firstGenerate
        },
        {
          provider: "second",
          capabilities: testCapabilities,
          estimateCost: () => ({ amount: 0.2, currency: "USD", estimated: true }),
          generate: secondGenerate
        }
      ],
      fallback: true
    });

    await expect(
      (await client.generate({ prompt: "fallback budget", maxCostPerCall: { amount: 0.05, currency: "USD", estimated: true } })).result()
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(firstGenerate).toHaveBeenCalledOnce();
    expect(secondGenerate).not.toHaveBeenCalled();
  });

  it("explains missing provider configuration", async () => {
    const client = createImageClient({ adapters: [] });

    await expect(client.generate({ prompt: "a test image" })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("exposes provider capability manifests for UI and routing decisions", async () => {
    const client = createImageClient({
      adapters: [{ provider: "test", capabilities: testCapabilities, generate: vi.fn() }]
    });

    await expect(client.capabilities("test")).resolves.toBe(testCapabilities);
    await expect(client.capabilities()).resolves.toEqual({ test: testCapabilities });
  });

  it("rejects unsupported request fields before calling the adapter", async () => {
    const generate = vi.fn();
    const client = createImageClient({
      adapters: [
        {
          provider: "limited",
          capabilities: {
            ...testCapabilities,
            seed: false,
            qualities: [],
            async: false,
            webhooks: false
          },
          generate
        }
      ]
    });

    await expect(client.generate({ prompt: "bad ratio", aspectRatio: "16:9" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      provider: "limited",
      capability: "aspectRatio"
    });
    await expect(client.generate({ prompt: "seed", seed: 3 })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(client.generate({ prompt: "quality", quality: "high" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(client.generate({ prompt: "async", strategy: "async" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(client.generate({ prompt: "webhook", webhookUrl: "https://app.example/webhook" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("normalizes edit input and snaps an explicit resolution before delegating", async () => {
    const generate = vi.fn().mockResolvedValue({ id: "edit-1", provider: "test", result: vi.fn().mockResolvedValue(fixture) });
    const client = createImageClient({
      adapters: [
        {
          provider: "test",
          capabilities: {
            ...testCapabilities,
            referenceImages: { supported: true, max: 1 },
            inpainting: true,
            resolutionBuckets: [
              { width: 1024, height: 1024 },
              { width: 1344, height: 768 }
            ]
          },
          generate
        }
      ]
    });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    await client.generate({ prompt: "edit this", image, strength: 0.6, resolution: { width: 2000, height: 1000 } });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "image-to-image",
        strength: 0.6,
        resolution: { width: 1344, height: 768 },
        image: { kind: "bytes", mimeType: "image/png", bytes: image }
      })
    );
  });

  it("fails invalid edit modes and unsupported capabilities before the adapter is called", async () => {
    const generate = vi.fn();
    const client = createImageClient({ adapters: [{ provider: "limited", capabilities: testCapabilities, generate }] });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    await expect(client.generate({ prompt: "bad", mode: "inpainting" })).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(client.generate({ prompt: "edit", image, strength: 0.5 })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      capability: "reference images"
    });
    await expect(client.generate({ prompt: "size", resolution: { width: 1024, height: 1024 } })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      capability: "resolution"
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("cancels an in-flight job through its adapter handle", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const adapter: Adapter = {
      provider: "test",
      capabilities: testCapabilities,
      generate: vi.fn().mockResolvedValue({
        id: "job-cancel",
        provider: "test",
        result: vi.fn(),
        cancel
      })
    };
    const job = await createImageClient({ adapters: [adapter] }).generate({ prompt: "cancel me" });

    await job.cancel();

    expect(cancel).toHaveBeenCalledOnce();
    expect(job.status).toBe("failed");
    await expect(job.result()).rejects.toMatchObject({ code: "GENERATION_CANCELLED" });
  });

  it("returns an async job without polling until its result is explicitly requested", async () => {
    const result = vi.fn().mockResolvedValue(fixture);
    const client = createImageClient({
      adapters: [
        {
          provider: "test",
          capabilities: testCapabilities,
          generate: vi.fn().mockResolvedValue({ id: "job-async", provider: "test", result, metadata: { token: "saved" } })
        }
      ]
    });

    const job = await client.generate({ prompt: "defer me", strategy: "async" });

    expect(job.strategy).toBe("async");
    expect(job.metadata).toEqual({ token: "saved" });
    expect(job.toJSON()).toMatchObject({ id: "job-async", strategy: "async", metadata: { token: "saved" } });
    expect(result).not.toHaveBeenCalled();
  });

  it("resumes a provider job with persisted metadata", async () => {
    const resume = vi.fn().mockResolvedValue({
      id: "job-resumed",
      provider: "test",
      result: vi.fn().mockResolvedValue(fixture),
      metadata: { pollingUrl: "https://poll.example/job-resumed" }
    });
    const client = createImageClient({
      adapters: [{ provider: "test", capabilities: testCapabilities, generate: vi.fn(), resume }]
    });

    const job = await client.job(" job-resumed ", {
      provider: "test",
      metadata: { pollingUrl: "https://poll.example/job-resumed" }
    });

    expect(resume).toHaveBeenCalledWith("job-resumed", { pollingUrl: "https://poll.example/job-resumed" });
    await expect(job.result()).resolves.toEqual(fixture);
  });

  it("parses JSON webhook requests through the selected provider", async () => {
    const parseWebhook = vi.fn().mockResolvedValue(fixture);
    const client = createImageClient({
      adapters: [{ provider: "test", capabilities: testCapabilities, generate: vi.fn(), parseWebhook }]
    });
    const request = new Request("https://app.example/webhooks/flux", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Ready" })
    });

    await expect(client.parseWebhook(request, { provider: "test", metadata: { width: 1024 } })).resolves.toEqual(fixture);
    expect(parseWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { status: "Ready" }, headers: expect.any(Headers) }),
      { width: 1024 }
    );
  });
});

describe("generateImage", () => {
  it("is a thin wrapper over the default client resolver", async () => {
    const generate = vi.fn().mockResolvedValue({
      id: "job-wrapper",
      provider: "test",
      status: "complete",
      result: vi.fn().mockResolvedValue(fixture)
    });

    configureDefaultAdapterResolver(() => [{ provider: "test", capabilities: testCapabilities, generate }]);

    await expect(generateImage("a test image")).resolves.toEqual(fixture);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("uses image-to-image or inpainting mode through the beginner edit wrapper", async () => {
    const generate = vi.fn().mockResolvedValue({ id: "edit-wrapper", provider: "test", result: vi.fn().mockResolvedValue(fixture) });
    configureDefaultAdapterResolver(() => [
      {
        provider: "test",
        capabilities: { ...testCapabilities, referenceImages: { supported: true, max: 1 }, inpainting: true },
        generate
      }
    ]);
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    await editImage("replace the sky", { image, mask: image });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ mode: "inpainting", image: expect.any(Object), mask: expect.any(Object) }));
  });
});
