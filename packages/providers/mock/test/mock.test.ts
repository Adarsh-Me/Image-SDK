import { describe, expect, it } from "vitest";
import { createImageClient } from "@image-sdk/core";
import { mock } from "../src";

describe("mock adapter", () => {
  it("returns deterministic, network-free image results", async () => {
    const client = createImageClient({ adapters: [mock()] });

    const first = await (await client.generate({ prompt: "a purple test cat", seed: 7 })).result();
    const second = await (await client.generate({ prompt: "a purple test cat", seed: 7 })).result();

    expect(first).toMatchObject({
      provider: "mock",
      model: "mock-image-v1",
      mimeType: "image/svg+xml",
      width: 1024,
      height: 1024,
      cost: { amount: 0, currency: "USD", estimated: true },
      moderation: { flagged: false, provider: "mock" }
    });
    expect(first.url).toBe(second.url);
    expect(first.buffer).toBeInstanceOf(Uint8Array);
  });
});
