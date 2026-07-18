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
