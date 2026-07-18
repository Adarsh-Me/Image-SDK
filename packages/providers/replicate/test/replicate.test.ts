import { describe, expect, it, vi } from "vitest";
import { createImageClient } from "@image-sdk/core";
import { replicate } from "../src";

describe("Replicate adapter", () => {
  it("submits an async prediction, polls, and exposes resumable metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "p1", status: "starting", urls: { get: "https://replicate.test/p1", cancel: "https://replicate.test/p1/cancel" } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "p1", status: "succeeded", output: ["https://files.test/image.png"] }), { status: 200 }));
    const client = createImageClient({ adapters: [replicate({ apiKey: "token", model: "owner/model", baseUrl: "https://api.test/v1", fetch, sleep: async () => undefined })] });
    const job = await client.generate({ prompt: "cat", aspectRatio: "16:9", seed: 4, strategy: "async", webhookUrl: "https://app.test/hook" });
    const result = await job.result();
    expect(fetch.mock.calls[0][0]).toBe("https://api.test/v1/models/owner/model/predictions");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ input: { prompt: "cat", aspect_ratio: "16:9", seed: 4 }, webhook: "https://app.test/hook", webhook_events_filter: ["completed"] });
    expect(job.metadata).toMatchObject({ getUrl: "https://replicate.test/p1", cancelUrl: "https://replicate.test/p1/cancel" });
    expect(result).toMatchObject({ provider: "replicate", width: 1344, height: 768, url: "https://files.test/image.png" });
  });

  it("resumes and normalizes a completed webhook without submitting another prediction", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ id: "p2", status: "succeeded", output: "https://files.test/a.webp" }), { status: 200 }));
    const client = createImageClient({ adapters: [replicate({ apiKey: "token", baseUrl: "https://api.test/v1", fetch, sleep: async () => undefined })] });
    const result = await (await client.job("p2", { provider: "replicate", metadata: { width: 700, height: 500 } })).result();
    const webhook = await client.parseWebhook({ id: "p3", status: "succeeded", output: ["https://files.test/b.jpg"] }, { provider: "replicate", metadata: { width: 640, height: 480 } });
    expect(fetch.mock.calls[0][0]).toBe("https://api.test/v1/predictions/p2");
    expect(result).toMatchObject({ width: 700, height: 500 });
    expect(webhook).toMatchObject({ url: "https://files.test/b.jpg", mimeType: "image/jpeg", width: 640, height: 480 });
  });
});
