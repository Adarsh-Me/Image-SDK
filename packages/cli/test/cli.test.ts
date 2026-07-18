import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POLLINATIONS_IMAGE_ENDPOINT, run } from "../src";

describe("image-sdk try", () => {
  it("requests an anonymous image and writes it to the selected path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" }
      })
    );
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await run(["try", "a cat wearing sunglasses", "--out", "result.png"], {
      fetch: fetchMock as unknown as typeof fetch,
      writeFile: writeFile as never,
      cwd: () => "C:/tmp/image-sdk",
      log
    });

    expect(fetchMock).toHaveBeenCalledWith(`${POLLINATIONS_IMAGE_ENDPOINT}a%20cat%20wearing%20sunglasses`);
    expect(writeFile).toHaveBeenCalledWith(resolve("C:/tmp/image-sdk", "result.png"), expect.any(Uint8Array));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Saved image to"));
  });

  it("surfaces upstream demo-service failures", async () => {
    await expect(
      run(["try", "a cat"], {
        fetch: vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })) as unknown as typeof fetch
      })
    ).rejects.toThrow("HTTP 429");
  });

  it("requires a prompt", async () => {
    await expect(run(["try"], { fetch: vi.fn() as unknown as typeof fetch })).rejects.toThrow("non-empty prompt");
  });
});

describe("image-sdk generate", () => {
  it("uses the public SDK, downloads URL results, and writes the selected output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "image/webp" } })
    );
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const generateImage = vi.fn().mockResolvedValue({
      url: "https://cdn.example/generated.webp",
      mimeType: "image/webp",
      width: 1344,
      height: 768,
      provider: "flux",
      model: "flux-2-pro-preview",
      cost: { amount: 2, currency: "credits", estimated: false },
      moderation: { flagged: false, provider: "flux" }
    });

    await run(
      ["generate", "a", "sunset", "--aspect-ratio", "16:9", "--quality=high", "--seed", "42", "--out", "sunset.webp"],
      {
        fetch: fetchMock as unknown as typeof fetch,
        generateImage,
        writeFile: writeFile as never,
        cwd: () => "C:/tmp/image-sdk",
        log
      }
    );

    expect(generateImage).toHaveBeenCalledWith("a sunset", {
      aspectRatio: "16:9",
      quality: "high",
      seed: 42
    });
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example/generated.webp");
    expect(writeFile).toHaveBeenCalledWith(resolve("C:/tmp/image-sdk", "sunset.webp"), expect.any(Uint8Array));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("flux/flux-2-pro-preview"));
  });

  it("uses an SDK buffer without fetching a second time", async () => {
    const fetchMock = vi.fn();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await run(["generate", "a", "mock"], {
      fetch: fetchMock as unknown as typeof fetch,
      generateImage: vi.fn().mockResolvedValue({
        url: "data:image/svg+xml;charset=utf-8,mock",
        buffer: new Uint8Array([7, 8, 9]),
        mimeType: "image/svg+xml",
        width: 1024,
        height: 1024,
        provider: "mock",
        model: "mock-image-v1",
        cost: { amount: 0, currency: "USD", estimated: true },
        moderation: { flagged: false, provider: "mock" }
      }),
      writeFile: writeFile as never,
      cwd: () => "C:/tmp/image-sdk",
      now: () => 123,
      log
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(resolve("C:/tmp/image-sdk", "image-sdk-123.svg"), new Uint8Array([7, 8, 9]));
  });

  it("writes data URL results without a second network request", async () => {
    const fetchMock = vi.fn();
    const writeFile = vi.fn().mockResolvedValue(undefined);

    await run(["generate", "a", "data", "image"], {
      fetch: fetchMock as unknown as typeof fetch,
      generateImage: vi.fn().mockResolvedValue({
        url: "data:image/png;base64,AQID",
        mimeType: "image/png",
        width: 1,
        height: 1,
        provider: "stability",
        model: "stable-image-core",
        cost: { amount: 0, currency: "USD", estimated: true },
        moderation: { flagged: false, provider: "stability" }
      }),
      writeFile: writeFile as never,
      cwd: () => "C:/tmp/image-sdk",
      now: () => 456,
      log: vi.fn()
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(resolve("C:/tmp/image-sdk", "image-sdk-456.png"), new Uint8Array([1, 2, 3]));
  });

  it("validates generate-only options", async () => {
    await expect(run(["generate", "a cat", "--quality", "ultra"])).rejects.toThrow("draft, standard, or high");
    await expect(run(["generate", "a cat", "--seed", "1.2"])).rejects.toThrow("must be an integer");
  });

  it("passes an explicit provider through to the public SDK", async () => {
    const generateImage = vi.fn().mockResolvedValue({
      url: "data:image/png;base64,AQID",
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      provider: "openai",
      model: "gpt-image-1",
      cost: { amount: 0, currency: "USD", estimated: true },
      moderation: { flagged: false, provider: "openai" }
    });

    await run(["generate", "a", "cat", "--provider=openai"], {
      generateImage,
      writeFile: vi.fn().mockResolvedValue(undefined) as never,
      log: vi.fn()
    });

    expect(generateImage).toHaveBeenCalledWith("a cat", { provider: "openai" });
  });
});

describe("image-sdk providers", () => {
  it("reports provider configuration without exposing credential values", async () => {
    const log = vi.fn();

    await run(["providers"], {
      environment: { BFL_API_KEY: "secret-value", STABILITY_API_KEY: "another-secret" },
      log
    });

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "flux: configured",
      "stability: configured",
      "openai: not configured (set OPENAI_API_KEY)",
      "recraft: not configured (set RECRAFT_API_KEY)",
      "ideogram: not configured (set IDEOGRAM_API_KEY)",
      "replicate: not configured (set REPLICATE_API_TOKEN)",
      "fal: not configured (set FAL_KEY)",
      "google: not configured (set GOOGLE_API_KEY)"
    ]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("secret-value"));
  });
});
