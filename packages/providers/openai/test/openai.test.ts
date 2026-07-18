import { describe, expect, it, vi } from "vitest";
import { ConfigurationError, ModerationError, UnsupportedCapabilityError, createImageClient } from "@image-sdk/core";
import { OPENAI_CAPABILITIES, OPENAI_GPT_IMAGE_MODEL, OpenAIProviderError, openai } from "../src";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("OpenAI adapter", () => {
  it("uses the GPT Image generations contract and normalizes base64 output", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ created: 123, output_format: "png", data: [{ b64_json: Buffer.from(imageBytes).toString("base64") }] })
    );
    const client = createImageClient({ adapters: [openai({ apiKey: "openai-key", fetch: fetchMock as unknown as typeof fetch })] });

    const result = await (await client.generate({ prompt: "a glass hummingbird", aspectRatio: "16:9", quality: "high" })).result();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer openai-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: OPENAI_GPT_IMAGE_MODEL,
      prompt: "a glass hummingbird",
      size: "1536x1024",
      quality: "high",
      output_format: "png"
    });
    expect(result).toMatchObject({
      provider: "openai",
      model: OPENAI_GPT_IMAGE_MODEL,
      width: 1536,
      height: 1024,
      mimeType: "image/png",
      buffer: imageBytes,
      moderation: { flagged: false, provider: "openai" }
    });
    expect(result.url).toMatch(/^data:image\/png;base64,/);
  });

  it("maps SDK quality levels and exposes OpenAI capabilities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: "AA==" }] }));
    const client = createImageClient({ adapters: [openai({ apiKey: "openai-key", fetch: fetchMock as unknown as typeof fetch })] });

    await (await client.generate({ prompt: "draft", quality: "draft" })).result();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ quality: "low" });
    await expect(client.capabilities("openai")).resolves.toBe(OPENAI_CAPABILITIES);
  });

  it("fails before a request when the adapter is missing credentials or receives an unsupported ratio", async () => {
    const fetchMock = vi.fn();
    const withoutKey = createImageClient({ adapters: [openai({ fetch: fetchMock as unknown as typeof fetch })] });
    const withKey = createImageClient({ adapters: [openai({ apiKey: "openai-key", fetch: fetchMock as unknown as typeof fetch })] });

    await expect(withoutKey.generate({ prompt: "image" })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(withKey.generate({ prompt: "image", aspectRatio: "4:3" })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps provider and moderation failures to typed errors", async () => {
    const providerFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid request" } }, 400));
    const moderatedFetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Blocked by content policy" } }, 400));
    const providerClient = createImageClient({ adapters: [openai({ apiKey: "openai-key", fetch: providerFetch as unknown as typeof fetch })] });
    const moderatedClient = createImageClient({ adapters: [openai({ apiKey: "openai-key", fetch: moderatedFetch as unknown as typeof fetch })] });

    await expect(providerClient.generate({ prompt: "image" })).rejects.toBeInstanceOf(OpenAIProviderError);
    await expect(moderatedClient.generate({ prompt: "image" })).rejects.toBeInstanceOf(ModerationError);
  });
});
