import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, createImageClient } from "@image-sdk/core";
import { IDEOGRAM_CAPABILITIES, ideogram } from "../src";

describe("Ideogram adapter", () => {
  it("uses the configurable synchronous endpoint and normalizes its result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.webp", resolution: "1536x864", seed: 8, is_image_safe: true }] }), { status: 200 })
    );
    const client = createImageClient({ adapters: [ideogram({ apiKey: "key", endpoint: "https://example.test/generate", fetch })] });

    const result = await (await client.generate({ prompt: " a neon sign ", aspectRatio: "16:9", quality: "high", seed: 8 })).result();

    expect(fetch).toHaveBeenCalledWith("https://example.test/generate", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "api-key": "key" }) }));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ prompt: "a neon sign", aspect_ratio: "16:9", rendering_speed: "QUALITY", seed: 8 });
    expect(result).toMatchObject({ provider: "ideogram", model: "ideogram-v3", mimeType: "image/webp", width: 1536, height: 864, seed: 8 });
    await expect(client.capabilities("ideogram")).resolves.toBe(IDEOGRAM_CAPABILITIES);
  });

  it("requires credentials without performing a network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createImageClient({ adapters: [ideogram({ fetch })] });
    await expect(client.generate({ prompt: "test" })).rejects.toBeInstanceOf(ConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
