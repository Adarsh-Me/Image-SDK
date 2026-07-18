import { describe, expect, it, vi } from "vitest";
import { createImageClient } from "@image-sdk/core";
import { fal } from "../src";

describe("fal adapter", () => {
  it("submits to the queue, polls its URLs, and normalizes a model result", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "r1", status_url: "https://queue.test/status", response_url: "https://queue.test/result", cancel_url: "https://queue.test/cancel" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "COMPLETED", response_url: "https://queue.test/result" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: "https://media.test/image.png", width: 1200, height: 675, content_type: "image/png" }], seed: 9, has_nsfw_concepts: [false] }), { status: 200 }));
    const client = createImageClient({ adapters: [fal({ apiKey: "key", queueBaseUrl: "https://queue.test", model: "owner/model", fetch, sleep: async () => undefined })] });
    const job = await client.generate({ prompt: "hill", aspectRatio: "16:9", seed: 9, strategy: "async", webhookUrl: "https://app.test/fal" });
    const result = await job.result();
    expect(fetch.mock.calls[0][0]).toBe("https://queue.test/owner/model?fal_webhook=https%3A%2F%2Fapp.test%2Ffal");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ prompt: "hill", image_size: "landscape_16_9", seed: 9 });
    expect(result).toMatchObject({ provider: "fal", url: "https://media.test/image.png", width: 1200, height: 675, seed: 9 });
  });

  it("resumes through derived queue URLs and parses completion webhooks", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{ url: "https://media.test/resumed.jpg", width: 500, height: 700 }] }), { status: 200 }));
    const client = createImageClient({ adapters: [fal({ apiKey: "key", queueBaseUrl: "https://queue.test", model: "owner/model", fetch, sleep: async () => undefined })] });
    const result = await (await client.job("r2", { provider: "fal", metadata: { width: 500, height: 700 } })).result();
    const webhook = await client.parseWebhook({ request_id: "r3", status: "OK", payload: { images: [{ url: "https://media.test/webhook.webp", width: 640, height: 640, content_type: "image/webp" }], has_nsfw_concepts: [false] } }, { provider: "fal", metadata: { width: 640, height: 640 } });
    expect(fetch.mock.calls[0][0]).toBe("https://queue.test/owner/model/requests/r2/status");
    expect(result).toMatchObject({ url: "https://media.test/resumed.jpg", width: 500, height: 700 });
    expect(webhook).toMatchObject({ provider: "fal", mimeType: "image/webp", width: 640, height: 640 });
  });
});
