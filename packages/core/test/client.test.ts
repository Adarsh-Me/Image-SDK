import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  InvalidRequestError,
  configureDefaultAdapterResolver,
  createImageClient,
  generateImage,
  type Adapter,
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
    const adapter: Adapter = { provider: "test", generate };
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
      quality: undefined
    });
    expect(job.status).toBe("complete");
    expect(completed).toHaveBeenCalledWith(fixture);
  });

  it("rejects empty prompts before calling an adapter", async () => {
    const client = createImageClient({ adapters: [] });

    await expect(client.generate({ prompt: "   " })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("explains missing provider configuration", async () => {
    const client = createImageClient({ adapters: [] });

    await expect(client.generate({ prompt: "a test image" })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("cancels an in-flight job through its adapter handle", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const adapter: Adapter = {
      provider: "test",
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
});

describe("generateImage", () => {
  it("is a thin wrapper over the default client resolver", async () => {
    const generate = vi.fn().mockResolvedValue({
      id: "job-wrapper",
      provider: "test",
      status: "complete",
      result: vi.fn().mockResolvedValue(fixture)
    });

    configureDefaultAdapterResolver(() => [{ provider: "test", generate }]);

    await expect(generateImage("a test image")).resolves.toEqual(fixture);
    expect(generate).toHaveBeenCalledOnce();
  });
});
