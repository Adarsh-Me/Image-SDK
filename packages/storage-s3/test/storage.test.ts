import { describe, expect, it } from "vitest";
import { r2Storage, s3Storage, type ObjectStoragePutRequest } from "../src/index";

describe("S3-compatible image storage", () => {
  it("uploads a prefixed object and returns a durable public URL", async () => {
    const calls: ObjectStoragePutRequest[] = [];
    const storage = s3Storage({
      bucket: "images",
      prefix: "generated",
      publicUrl: "https://cdn.example.com/",
      cacheControl: "public, max-age=86400",
      client: { putObject: async (request) => void calls.push(request) }
    });

    await expect(storage.put({ key: "2026/a.png", body: new Uint8Array([1]), contentType: "image/png" })).resolves.toEqual({
      url: "https://cdn.example.com/generated/2026/a.png"
    });
    expect(calls).toEqual([
      expect.objectContaining({
        bucket: "images",
        key: "generated/2026/a.png",
        contentType: "image/png",
        cacheControl: "public, max-age=86400"
      })
    ]);
  });

  it("uses the R2-compatible path-style endpoint when no public origin is configured", async () => {
    const storage = r2Storage({
      bucket: "bucket",
      endpoint: "https://account.r2.cloudflarestorage.com",
      client: { putObject: async () => undefined }
    });

    await expect(storage.put({ key: "image.webp", body: new Uint8Array([1]), contentType: "image/webp" })).resolves.toEqual({
      url: "https://account.r2.cloudflarestorage.com/bucket/image.webp"
    });
  });

  it("passes streaming bodies to the transport without buffering them", async () => {
    const calls: ObjectStoragePutRequest[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      }
    });
    const storage = s3Storage({
      bucket: "images",
      publicUrl: "https://cdn.example.com",
      client: { putObject: async (request) => void calls.push(request) }
    });

    await storage.put({ key: "stream.png", body, contentType: "image/png" });

    expect(calls[0]?.body).toBe(body);
  });

  it("rejects traversal keys before transport", async () => {
    const storage = s3Storage({
      bucket: "images",
      publicUrl: "https://cdn.example.com",
      client: { putObject: async () => undefined }
    });

    await expect(storage.put({ key: "../outside.png", body: new Uint8Array([1]), contentType: "image/png" })).rejects.toThrow(
      "without traversal"
    );
  });
});
