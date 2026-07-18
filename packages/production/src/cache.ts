import type { ImageGenerationInput, ImageResult } from "@image-sdk/core";

export interface CacheEntry {
  result: ImageResult;
  expiresAt: string;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MemoryCacheOptions {
  now?: () => number;
}

export function memoryCache(options: MemoryCacheOptions = {}): CacheStore {
  const entries = new Map<string, CacheEntry>();
  const now = options.now ?? Date.now;

  return {
    async get(key): Promise<CacheEntry | undefined> {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }

      if (Date.parse(entry.expiresAt) <= now()) {
        entries.delete(key);
        return undefined;
      }

      return entry;
    },
    async set(key, entry): Promise<void> {
      entries.set(key, entry);
    },
    async delete(key): Promise<void> {
      entries.delete(key);
    }
  };
}

export interface CacheKeyInput {
  namespace: string;
  request: ImageGenerationInput;
}

export async function createCacheKey(input: CacheKeyInput): Promise<string> {
  const canonical = JSON.stringify({
    namespace: input.namespace,
    prompt: input.request.prompt.trim(),
    mode: input.request.mode ?? "text-to-image",
    aspectRatio: input.request.aspectRatio ?? null,
    quality: input.request.quality ?? null,
    seed: input.request.seed ?? null
  });

  return sha256(canonical);
}

export function cacheExpiry(result: ImageResult, ttlMs: number, now = Date.now()): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("Cache TTL must be a positive number of milliseconds.");
  }

  const ttlExpiry = now + ttlMs;
  const providerExpiry = result.expiresAt ? Date.parse(result.expiresAt) : Number.NaN;
  return new Date(Number.isFinite(providerExpiry) ? Math.min(ttlExpiry, providerExpiry) : ttlExpiry).toISOString();
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to create production cache keys.");
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
