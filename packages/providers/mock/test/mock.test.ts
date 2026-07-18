import { describe, expect, it } from "vitest";
import { UnsupportedCapabilityError, createImageClient } from "@image-sdk/core";
import { MOCK_CAPABILITIES, mock } from "../src";

describe("mock adapter", () => {
  it("returns deterministic, network-free image results", async () => {
    const client = createImageClient({ adapters: [mock()] });

    const first = await (await client.generate({ prompt: "a purple test cat", seed: 7, aspectRatio: "16:9" })).result();
    const second = await (await client.generate({ prompt: "a purple test cat", seed: 7, aspectRatio: "16:9" })).result();

    expect(first).toMatchObject({
      provider: "mock",
      model: "mock-image-v1",
      mimeType: "image/svg+xml",
      width: 1344,
      height: 768,
      cost: { amount: 0, currency: "USD", estimated: true },
      moderation: { flagged: false, provider: "mock" }
    });
    expect(first.url).toBe(second.url);
    expect(first.buffer).toBeInstanceOf(Uint8Array);
  });

  it("advertises deterministic limits and rejects asynchronous generation", async () => {
    const client = createImageClient({ adapters: [mock()] });

    await expect(client.capabilities("mock")).resolves.toBe(MOCK_CAPABILITIES);
    await expect(client.generate({ prompt: "defer me", strategy: "async" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});
