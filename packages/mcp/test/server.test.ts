import { PassThrough } from "node:stream";
import { Job, type AdapterCapabilities, type AdapterJobHandle, type ImageClient, type ImageGenerationInput, type ImageResult } from "@image-sdk/core";
import { describe, expect, it } from "vitest";
import { ImageMcpServer, runStdioServer, type BudgetAwareImageClient } from "../src/index";

const result: ImageResult = {
  url: "https://example.test/image.png",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  provider: "test",
  model: "test-model",
  cost: { amount: 0.01, currency: "USD", estimated: false },
  moderation: { flagged: false, provider: "test" }
};

function createClient(): BudgetAwareImageClient {
  const handle: AdapterJobHandle = { id: "job-1", provider: "test", result: async () => result };
  const capabilities: AdapterCapabilities = {
    aspectRatios: ["1:1"],
    maxImagesPerCall: 1,
    referenceImages: { supported: false },
    inpainting: false,
    negativePrompt: false,
    seed: true,
    qualities: ["standard"],
    outputFormats: ["png"],
    async: true,
    webhooks: false,
    livePreview: false
  };

  function getCapabilities(): Promise<Record<string, AdapterCapabilities>>;
  function getCapabilities(provider: string): Promise<AdapterCapabilities>;
  function getCapabilities(provider?: string): Promise<AdapterCapabilities | Record<string, AdapterCapabilities>> {
    return Promise.resolve(provider ? capabilities : { test: capabilities });
  }

  return {
    generate: async (_input: ImageGenerationInput) => new Job(handle),
    job: async () => new Job(handle),
    parseWebhook: async () => result,
    capabilities: getCapabilities,
    checkBudget: ({ amount = 0, currency = "USD" }) => ({ allowed: amount <= 2, remaining: 2 - amount, currency })
  };
}

describe("ImageMcpServer", () => {
  it("generates an image through the injected client", async () => {
    const server = new ImageMcpServer({ client: createClient() });
    const response = await server.handle({ id: 1, method: "generate", params: { prompt: "a mountain", seed: 7 } });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ job: { id: "job-1", provider: "test" }, image: result });
  });

  it("returns capabilities and delegates budget checks", async () => {
    const server = new ImageMcpServer({ client: createClient() });

    await expect(server.handle({ id: "cap", method: "getCapabilities", params: { provider: "test" } })).resolves.toMatchObject({
      id: "cap",
      result: { async: true }
    });
    await expect(server.handle({ id: "budget", method: "checkBudget", params: { amount: 3 } })).resolves.toEqual({
      id: "budget",
      result: { allowed: false, remaining: -1, currency: "USD" }
    });
  });

  it("returns structured errors for invalid input and unavailable budgets", async () => {
    const server = new ImageMcpServer({ client: createClient() });
    await expect(server.handle({ id: 2, method: "generate", params: {} })).resolves.toEqual({
      id: 2,
      error: { code: "INVALID_REQUEST", message: "generate requires params.prompt as a string." }
    });

    const withoutBudget = createClient();
    delete withoutBudget.checkBudget;
    await expect(new ImageMcpServer({ client: withoutBudget }).handle({ id: 3, method: "checkBudget" })).resolves.toEqual({
      id: 3,
      error: { code: "METHOD_UNAVAILABLE", message: "The injected ImageClient does not expose budget checks." }
    });
  });

  it("serves newline-delimited JSON over stdio streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let received = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      received += chunk;
    });

    const serving = runStdioServer({ client: createClient(), input, output });
    input.end('{"id":4,"method":"getCapabilities"}\nnot-json\n');
    await serving;

    const responses = received.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses[0]).toMatchObject({ id: 4, result: { test: { async: true } } });
    expect(responses[1]).toMatchObject({ id: null, error: { code: "INVALID_REQUEST" } });
  });
});
