import { describe, expect, it, vi } from "vitest";
import { ProviderError, UnsupportedCapabilityError, createImageClient } from "@image-sdk/core";
import { STABILITY_CAPABILITIES, STABILITY_CORE_MODEL, stability } from "../src";

function pngResponse(width: number, height: number): Response {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);

  return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
}

describe("stability adapter", () => {
  it("posts a multipart Stable Image Core request and normalizes returned image bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pngResponse(640, 480));
    const client = createImageClient({
      adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    const job = await client.generate({ prompt: "a small lighthouse", aspectRatio: "4:5", seed: 7 });
    const result = await job.result();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as FormData;

    expect(url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer stability-key");
    expect(new Headers(init.headers).get("accept")).toBe("image/*");
    expect(body.get("prompt")).toBe("a small lighthouse");
    expect(body.get("aspect_ratio")).toBe("4:5");
    expect(body.get("seed")).toBe("7");
    expect(result).toMatchObject({
      provider: "stability",
      model: STABILITY_CORE_MODEL,
      mimeType: "image/png",
      width: 640,
      height: 480,
      seed: 7,
      moderation: { flagged: false, provider: "stability" }
    });
    expect(result.url).toMatch(/^data:image\/png;base64,/);
    expect(result.buffer).toBeInstanceOf(Uint8Array);
  });

  it("returns a typed provider error for non-successful responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("invalid prompt", { status: 400 }));
    const client = createImageClient({
      adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    await expect(client.generate({ prompt: "blocked image" })).rejects.toBeInstanceOf(ProviderError);
  });

  it("advertises its synchronous constraints and fails before an unsupported webhook request", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({
      adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    await expect(client.capabilities("stability")).resolves.toBe(STABILITY_CAPABILITIES);
    await expect(client.generate({ prompt: "a test image", webhookUrl: "https://app.example/webhook" })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes provider content-policy responses as moderation errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Prompt blocked by safety policy", { status: 403 }));
    const client = createImageClient({
      adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })]
    });

    await expect(client.generate({ prompt: "restricted prompt" })).rejects.toMatchObject({
      name: "ModerationError",
      moderation: { flagged: true, provider: "stability", reason: "Prompt blocked by safety policy" }
    });
  });

  it("uploads byte image input for Stable Image Core image-to-image requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pngResponse(640, 480));
    const client = createImageClient({ adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })] });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

    await (await client.generate({ prompt: "make it warmer", image, strength: 0.7 })).result();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as FormData;
    expect(url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    expect(body.get("mode")).toBe("image-to-image");
    expect(body.get("strength")).toBe("0.7");
    expect(body.get("image")).toBeInstanceOf(Blob);
  });

  it("downloads HTTPS image and mask inputs before calling the Stability inpaint endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pngResponse(640, 480))
      .mockResolvedValueOnce(pngResponse(640, 480))
      .mockResolvedValueOnce(pngResponse(640, 480));
    const client = createImageClient({ adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })] });

    await (await client.generate({
      prompt: "replace the background",
      image: "https://images.example/source.png",
      mask: "https://images.example/mask.png"
    })).result();

    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    const body = init.body as FormData;
    expect(url).toBe("https://api.stability.ai/v2beta/stable-image/edit/inpaint");
    expect(body.get("image")).toBeInstanceOf(Blob);
    expect(body.get("mask")).toBeInstanceOf(Blob);
  });

  it("requires strength for Stability image-to-image before any provider submission", async () => {
    const fetchMock = vi.fn();
    const client = createImageClient({ adapters: [stability({ apiKey: "stability-key", fetch: fetchMock as unknown as typeof fetch })] });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

    await expect(client.generate({ prompt: "edit", image })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
