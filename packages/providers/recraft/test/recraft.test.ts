import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, ModerationError, UnsupportedCapabilityError, createImageClient } from "@image-sdk/core";
import { RECRAFT_CAPABILITIES, RECRAFT_DEFAULT_MODEL, RecraftProviderError, recraft } from "../src";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Recraft adapter", () => {
  it("uses the images/generations contract and normalizes b64_json output", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ b64_json: Buffer.from(imageBytes).toString("base64"), image_type: "webp" }] })
    );
    const client = createImageClient({ adapters: [recraft({ apiKey: "recraft-key", fetch: fetchMock as unknown as typeof fetch })] });

    const result = await (await client.generate({ prompt: "a colorful poster", aspectRatio: "16:9", seed: 42 })).result();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://external.api.recraft.ai/v1/images/generations");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer recraft-key");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "a colorful poster",
      model: RECRAFT_DEFAULT_MODEL,
      size: "16:9",
      n: 1,
      response_format: "b64_json",
      random_seed: 42
    });
    expect(result).toMatchObject({
      provider: "recraft",
      model: RECRAFT_DEFAULT_MODEL,
      width: 1344,
      height: 768,
      mimeType: "image/webp",
      buffer: imageBytes,
      seed: 42,
      moderation: { flagged: false, provider: "recraft" }
    });
    expect(result.url).toMatch(/^data:image\/webp;base64,/);
  });

  it("exposes current Recraft capabilities and supports configured models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: "AA==" }] }));
    const client = createImageClient({
      adapters: [recraft({ apiKey: "recraft-key", model: "recraftv4_1_pro", fetch: fetchMock as unknown as typeof fetch })]
    });

    await (await client.generate({ prompt: "image", aspectRatio: "4:3" })).result();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: "recraftv4_1_pro", size: "4:3" });
    await expect(client.capabilities("recraft")).resolves.toBe(RECRAFT_CAPABILITIES);
  });

  it("fails before a request when credentials are absent or an unsupported ratio is requested", async () => {
    const fetchMock = vi.fn();
    const withoutKey = createImageClient({ adapters: [recraft({ fetch: fetchMock as unknown as typeof fetch })] });
    const withKey = createImageClient({ adapters: [recraft({ apiKey: "recraft-key", fetch: fetchMock as unknown as typeof fetch })] });

    await expect(withoutKey.generate({ prompt: "image" })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(withKey.generate({ prompt: "image", aspectRatio: "3:2" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps provider and moderation failures to typed errors", async () => {
    const providerFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid size" } }, 400));
    const moderatedFetch = vi.fn().mockResolvedValue(jsonResponse({ message: "Prompt blocked by safety policy" }, 400));
    const providerClient = createImageClient({ adapters: [recraft({ apiKey: "recraft-key", fetch: providerFetch as unknown as typeof fetch })] });
    const moderatedClient = createImageClient({ adapters: [recraft({ apiKey: "recraft-key", fetch: moderatedFetch as unknown as typeof fetch })] });

    await expect(providerClient.generate({ prompt: "image" })).rejects.toBeInstanceOf(RecraftProviderError);
    await expect(moderatedClient.generate({ prompt: "image" })).rejects.toBeInstanceOf(ModerationError);
  });
});
