import type {
  ImageClient,
  ImageCost,
  ImageGenerationInput,
  ImageResult,
  Job,
  JobStatus
} from "@image-sdk/core";
import { type BatchOptions, runBatch } from "./batch";
import { type BudgetLimit, type BudgetReservation, type BudgetStore } from "./budget";
import { cacheExpiry, createCacheKey, type CacheStore } from "./cache";

export * from "./batch";
export * from "./budget";
export * from "./cache";

export interface ImageStorage {
  put(request: { key: string; body: ImageStorageBody; contentType: string; cacheControl?: string }): Promise<{ url: string; expiresAt?: string }>;
}

export type ImageStorageBody = Uint8Array | ReadableStream<Uint8Array> | Blob;

export interface ProductionFeatures {
  cache?: {
    store: CacheStore;
    ttlMs?: number;
    namespace?: string;
    cacheUnseeded?: boolean;
  };
  budget?: {
    store: BudgetStore;
    limit: BudgetLimit;
    estimate(input: ImageGenerationInput): ImageCost;
  };
  storage?: {
    storage: ImageStorage;
    prefix?: string;
    fetch?: typeof fetch;
  };
}

export interface ProductionJob {
  readonly id: string;
  readonly provider: string;
  readonly status: JobStatus;
  readonly nativeJob?: Job;
  result(): Promise<ImageResult>;
  cancel(): Promise<void>;
  toJSON(): ReturnType<Job["toJSON"]>;
}

export interface ProductionImageClient {
  generate(input: ImageGenerationInput): Promise<ProductionJob>;
  batch: {
    generate(
      inputs: readonly ImageGenerationInput[],
      options?: BatchOptions
    ): Promise<Array<{ index: number; input: ImageGenerationInput; status: "complete"; value: ImageResult } | { index: number; input: ImageGenerationInput; status: "failed"; error: Error }>>;
  };
}

export function withProductionFeatures(client: ImageClient, features: ProductionFeatures = {}): ProductionImageClient {
  async function generate(input: ImageGenerationInput): Promise<ProductionJob> {
    const cache = await prepareCache(client, input, features);
    if (cache?.entry) {
      return completedJob(cache.entry.result, cache.key);
    }

    const reservation = await reserveBudget(features, input);
    const settlement = budgetSettlement(features.budget, reservation);
    let nativeJob: Job;
    try {
      nativeJob = await client.generate(input);
    } catch (error) {
      await settlement.failure(error);
      throw error;
    }

    return wrappedJob(nativeJob, async (result) => {
      let durableResult = result;
      try {
        if (features.storage) {
          durableResult = await persistImage(result, cache?.key ?? nativeJob.id, features.storage);
        }
        if (cache) {
          await cache.store.set(cache.key, { result: durableResult, expiresAt: cacheExpiry(durableResult, cache.ttlMs) });
        }
        await settlement.commit(durableResult.cost);
        return durableResult;
      } catch (error) {
        // The provider has already returned a successful result, so a later
        // storage/cache/budget failure must not make its charge reusable.
        await settlement.retain();
        throw error;
      }
    }, settlement.failure, settlement.retain);
  }

  return {
    generate,
    batch: {
      generate: (inputs, options) => runBatch(inputs, async (input) => (await generate(input)).result(), options)
    }
  };
}

async function prepareCache(client: ImageClient, input: ImageGenerationInput, features: ProductionFeatures) {
  const config = features.cache;
  if (!config || input.webhookUrl || (input.seed === undefined && !config.cacheUnseeded)) {
    return undefined;
  }

  const capabilities = await client.capabilities();
  const namespace = config.namespace ?? Object.keys(capabilities)[0] ?? "default";
  const key = await createCacheKey({ namespace, request: input });
  return {
    key,
    store: config.store,
    ttlMs: config.ttlMs ?? 86_400_000,
    entry: await config.store.get(key)
  };
}

async function reserveBudget(features: ProductionFeatures, input: ImageGenerationInput): Promise<BudgetReservation | undefined> {
  if (!features.budget) {
    return undefined;
  }
  const estimate = features.budget.estimate(input);
  if (estimate.currency !== features.budget.limit.currency) {
    throw new TypeError("The image cost estimate currency must match the configured budget currency.");
  }
  return features.budget.store.reserve(features.budget.limit, estimate.amount);
}

function budgetSettlement(config: ProductionFeatures["budget"], reservation: BudgetReservation | undefined) {
  let settled = false;

  async function commit(cost?: ImageCost): Promise<void> {
    if (!config || !reservation || settled) {
      return;
    }
    await config.store.commit(reservation, cost);
    settled = true;
  }

  return {
    commit,
    async retain(): Promise<void> {
      await commit();
    },
    async failure(error: unknown): Promise<void> {
      if (!config || !reservation || settled) {
        return;
      }
      if (isPotentiallyCharged(error)) {
        await commit();
        return;
      }
      await config.store.release(reservation);
      settled = true;
    }
  };
}

function isPotentiallyCharged(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "GENERATION_CANCELLED" || (error as { code?: unknown }).code === "GENERATION_TIMEOUT")
  );
}

function wrappedJob(
  nativeJob: Job,
  onResult: (result: ImageResult) => Promise<ImageResult>,
  onError: (error: unknown) => Promise<void>,
  onCancel: () => Promise<void>
): ProductionJob {
  let resultPromise: Promise<ImageResult> | undefined;
  return {
    id: nativeJob.id,
    provider: nativeJob.provider,
    get status() {
      return nativeJob.status;
    },
    nativeJob,
    result() {
      resultPromise ??= nativeJob.result().then(onResult, async (error) => {
        await onError(error);
        throw error;
      });
      return resultPromise;
    },
    async cancel() {
      try {
        await nativeJob.cancel();
      } finally {
        await onCancel();
      }
    },
    toJSON: () => nativeJob.toJSON()
  };
}

function completedJob(result: ImageResult, key: string): ProductionJob {
  return {
    id: `cache:${key}`,
    provider: result.provider,
    status: "complete",
    result: async () => result,
    cancel: async () => undefined,
    toJSON: () => ({ id: `cache:${key}`, provider: result.provider, status: "complete", strategy: "managed" })
  };
}

async function persistImage(
  result: ImageResult,
  cacheKey: string,
  config: NonNullable<ProductionFeatures["storage"]>
): Promise<ImageResult> {
  const upload = await resolveStorageBody(result, config.fetch ?? fetch);
  const extension = extensionFor(result.mimeType);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const prefix = config.prefix?.replace(/^\/+|\/+$/g, "");
  const key = [prefix, date, `${cacheKey}.${extension}`].filter(Boolean).join("/");
  const stored = await config.storage.put({ key, body: upload.body, contentType: upload.contentType ?? result.mimeType });
  return { ...result, url: stored.url, ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : { expiresAt: undefined }) };
}

async function resolveStorageBody(result: ImageResult, request: typeof fetch): Promise<{ body: ImageStorageBody; contentType?: string }> {
  if (result.buffer) {
    return { body: result.buffer, contentType: result.mimeType };
  }

  return downloadImage(result.url, request);
}

async function downloadImage(url: string, request: typeof fetch): Promise<{ body: ImageStorageBody; contentType?: string }> {
  if (url.startsWith("data:")) {
    const match = /^data:[^;,]+;base64,([\s\S]+)$/.exec(url);
    if (!match) {
      throw new TypeError("Only base64 data URLs can be persisted.");
    }
    return { body: Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0)) };
  }
  const response = await request(url);
  if (!response.ok) {
    throw new Error(`Unable to download provider image for durable storage (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  if (response.body) {
    return { body: response.body as ReadableStream<Uint8Array>, contentType };
  }
  return { body: new Uint8Array(await response.arrayBuffer()), contentType };
}

function extensionFor(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}
