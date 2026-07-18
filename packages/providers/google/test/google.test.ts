import { describe, expect, it, vi } from "vitest";
import { createImageClient, type ImageResult } from "@image-sdk/core";
import { GOOGLE_DEFAULT_MODEL, google } from "../src";

describe("Google image adapter", () => {
  it("uses the current Gemini image endpoint and normalizes inline image bytes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }] } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createImageClient({ adapters: [google({ apiKey: "test-key", fetch })] });
    const image = await (await client.generate({ prompt: "a cat", aspectRatio: "16:9" })).result();
    expect(fetch).toHaveBeenCalledWith(`https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_DEFAULT_MODEL}:generateContent`, expect.objectContaining({ method: "POST" }));
    expect(image).toMatchObject({ provider: "google", width: 1344, height: 768, buffer: new Uint8Array([1, 2, 3]) });
  });

  it("maps provider safety failures to typed moderation errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "blocked by safety policy" } }), { status: 400 }));
    const client = createImageClient({ adapters: [google({ apiKey: "test-key", fetch })] });
    await expect(client.generate({ prompt: "unsafe" })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
