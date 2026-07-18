import { describe, expect, it } from "vitest";
import type { AdapterCapabilities, ImageClient, ImageResult, Job } from "@image-sdk/core";
import { runBatch, memoryBudgetStore, memoryCache, withProductionFeatures } from "../src/index";

const result: ImageResult = {
  url: "https://provider.example/image.png",
  buffer: new Uint8Array([1, 2, 3]),
  mimeType: "image/png",
  width: 1,
  height: 1,
  provider: "mock",
  model: "mock-v1",
  cost: { amount: 0.1, currency: "USD", estimated: false },
  moderation: { flagged: false, provider: "mock" }
};

function clientStub(generations: { count: number }): ImageClient {
  const capabilities: AdapterCapabilities = {
    aspectRatios: ["1:1"],
    maxImagesPerCall: 1,
    referenceImages: { supported: false },
    inpainting: false,
    negativePrompt: false,
    seed: true,
    qualities: ["standard"],
    outputFormats: ["png"],
    async: false,
    webhooks: false,
    livePreview: false
  };
  return {
    generate: async () => {
      generations.count += 1;
      return {
        id: `job-${generations.count}`,
        provider: "mock",
        status: "queued",
        strategy: "managed",
        result: async () => result,
        cancel: async () => undefined,
        toJSON: () => ({ id: "job", provider: "mock", status: "complete", strategy: "managed" })
      } as Job;
    },
    job: async () => {
      throw new Error("not used");
    },
    parseWebhook: async () => result,
    capabilities: (async (provider?: string) => (provider ? capabilities : { mock: capabilities })) as ImageClient["capabilities"]
  };
}

describe("production wrapper", () => {
  it("uses a seeded cache hit without a second provider submission", async () => {
    const generations = { count: 0 };
    const images = withProductionFeatures(clientStub(generations), { cache: { store: memoryCache(), cacheUnseeded: false } });

    await (await images.generate({ prompt: "cat", seed: 7 })).result();
    const cached = await (await images.generate({ prompt: "cat", seed: 7 })).result();

    expect(generations.count).toBe(1);
    expect(cached.url).toBe(result.url);
  });

  it("persists the result before exposing it and commits the actual budget", async () => {
    const budget = memoryBudgetStore();
    const uploads: string[] = [];
    const images = withProductionFeatures(clientStub({ count: 0 }), {
      budget: { store: budget, limit: { scope: "team", amount: 1, currency: "USD" }, estimate: () => ({ amount: 0.2, currency: "USD", estimated: true }) },
      storage: { storage: { put: async ({ key }) => { uploads.push(key); return { url: "https://cdn.example/image.png" }; } }, prefix: "images" }
    });

    await expect((await images.generate({ prompt: "cat" })).result()).resolves.toMatchObject({ url: "https://cdn.example/image.png" });
    await expect(budget.summary("team")).resolves.toMatchObject({ spent: 0.1, reserved: 0 });
    expect(uploads[0]).toMatch(/^images\/\d{4}\/\d{2}\/\d{2}\//);
  });

  it("retains the reserved budget when durable storage fails after a provider result", async () => {
    const budget = memoryBudgetStore();
    const images = withProductionFeatures(clientStub({ count: 0 }), {
      budget: { store: budget, limit: { scope: "team", amount: 1, currency: "USD" }, estimate: () => ({ amount: 0.2, currency: "USD", estimated: true }) },
      storage: { storage: { put: async () => { throw new Error("storage offline"); } } }
    });

    await expect((await images.generate({ prompt: "cat" })).result()).rejects.toThrow("storage offline");
    await expect(budget.summary("team")).resolves.toMatchObject({ spent: 0.2, reserved: 0 });
  });

  it("enforces concurrent reservations against a configured budget", async () => {
    const budget = memoryBudgetStore();
    const limit = { scope: "team", amount: 1, currency: "USD" };
    const first = await budget.reserve(limit, 0.7);

    await expect(budget.reserve(limit, 0.4)).rejects.toThrow("exhausted");
    await budget.release(first);
    await expect(budget.reserve(limit, 0.4)).resolves.toMatchObject({ amount: 0.4 });
  });

  it("keeps order and records individual batch failures", async () => {
    const values = await runBatch([1, 2, 3], async (value) => {
      if (value === 2) throw new Error("nope");
      return value * 2;
    }, { concurrency: 2 });

    expect(values.map((value) => value.status)).toEqual(["complete", "failed", "complete"]);
    expect(values[2]).toMatchObject({ value: 6 });
  });
});
