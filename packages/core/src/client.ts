import { BudgetExceededError, CancellationError, ConfigurationError, GenerationExhaustedError, InvalidRequestError, UnsupportedCapabilityError } from "./errors";
import { Job } from "./job";
import { normalizeImageInput } from "./media";
import { snapResolution } from "./resolution";
import { classifyGenerationFailure, getRetryDelayMs, normalizeRetryPolicy, type RetryPolicy } from "./retry";
import { InMemoryUsageTracker } from "./usage";
import type {
  Adapter,
  AdapterJobHandle,
  AdapterCapabilities,
  ImageGenerationInput,
  ImageCost,
  ImageResult,
  JobMetadata,
  NormalizedRequest,
  WebhookInput
} from "./types";

export interface CreateImageClientOptions {
  adapters?: readonly Adapter[];
  retry?: RetryPolicy;
  fallback?: boolean | readonly string[];
  maxCostPerCall?: ImageCost;
  estimateCost?: (adapter: Adapter, request: NormalizedRequest) => ImageCost | undefined;
  usage?: InMemoryUsageTracker;
  now?: () => number;
}

export interface ResumeJobOptions {
  provider?: string;
  metadata?: JobMetadata;
}

export interface ParseWebhookOptions {
  provider?: string;
  metadata?: JobMetadata;
}

export interface ImageClient {
  generate(request: ImageGenerationInput): Promise<Job>;
  job(id: string, options?: ResumeJobOptions): Promise<Job>;
  parseWebhook(request: Request | unknown, options?: ParseWebhookOptions): Promise<ImageResult>;
  capabilities(): Promise<Record<string, AdapterCapabilities>>;
  capabilities(provider: string): Promise<AdapterCapabilities>;
  readonly usage?: InMemoryUsageTracker;
}

export type DefaultAdapterResolver = () => readonly Adapter[] | Promise<readonly Adapter[]>;

let defaultAdapterResolver: DefaultAdapterResolver | undefined;

export function configureDefaultAdapterResolver(resolver?: DefaultAdapterResolver): void {
  defaultAdapterResolver = resolver;
}

export function createImageClient(options: CreateImageClientOptions = {}): ImageClient {
  const explicitAdapters = options.adapters ? [...options.adapters] : undefined;
  const usage = options.usage ?? new InMemoryUsageTracker({ now: options.now });
  const now = options.now ?? Date.now;

  async function getAdapters(): Promise<readonly Adapter[]> {
    return explicitAdapters ?? (defaultAdapterResolver ? await defaultAdapterResolver() : []);
  }

  async function getAdapter(provider?: string): Promise<Adapter> {
    const adapters = await getAdapters();
    const adapter = provider ? adapters.find((candidate) => candidate.provider === provider) : adapters[0];

    if (!adapter) {
      if (provider) {
        throw new ConfigurationError(`No ${provider} adapter is configured for this image client.`);
      }

      throw new ConfigurationError(
        "No image provider configured. Set BFL_API_KEY, configure an adapter with createImageClient(), or use IMAGE_SDK_USE_MOCK=1 in tests."
      );
    }

    return adapter;
  }

  async function getCapabilities(): Promise<Record<string, AdapterCapabilities>>;
  async function getCapabilities(provider: string): Promise<AdapterCapabilities>;
  async function getCapabilities(provider?: string): Promise<AdapterCapabilities | Record<string, AdapterCapabilities>> {
    if (provider) {
      return (await getAdapter(provider)).capabilities;
    }

    const adapters = await getAdapters();
    return Object.fromEntries(adapters.map((adapter) => [adapter.provider, adapter.capabilities]));
  }

  return {
    async generate(request: ImageGenerationInput): Promise<Job> {
      const normalizedInput = normalizeRequest(request);
      const adapters = await selectAdapters(normalizedInput);
      const normalizedRequest = validateRequestCapabilities(adapters[0]!, normalizedInput);
      const retryPolicy = normalizeRetryPolicy(normalizedInput.retry ?? options.retry);
      const fallbackSetting = normalizedInput.fallback ?? options.fallback ?? false;
      const allowFallback = fallbackSetting !== false;
      const candidates = allowFallback ? adapters : adapters.slice(0, 1);
      const first = await acquireHandle(candidates, normalizedRequest, retryPolicy);
      if (!first.handle) {
        if (candidates.length === 1 && first.failures[0]) throw first.failures[0];
        throw new GenerationExhaustedError(first.failures);
      }

      const resilientHandle: AdapterJobHandle = {
        id: first.handle.id,
        provider: first.adapter.provider,
        status: first.handle.status,
        metadata: first.handle.metadata,
        onProgress: first.handle.onProgress,
        async result(): Promise<ImageResult> {
          const failures: unknown[] = first.failures;
          let current = first.handle;
          let adapterIndex = first.adapterIndex;

          for (;;) {
            const started = now();
            try {
              const result = await current.result();
              recordUsage(usage, candidates[adapterIndex]!, result, normalizedRequest.prompt, now() - started, true, current.id);
              return result;
            } catch (error) {
              recordUsage(usage, candidates[adapterIndex]!, current, normalizedRequest.prompt, now() - started, false, current.id, error);
              failures.push(error);
              const classification = classifyGenerationFailure(error);
              if (classification.disposition === "fail" || classification.disposition === "fallback" && adapterIndex >= candidates.length - 1) {
                break;
              }

              const retriesUsed = Number((current.metadata?.retryCount ?? 0));
              if (classification.disposition === "retry" && retriesUsed < retryPolicy.retries) {
                await delay(getRetryDelayMs(retriesUsed + 1, retryPolicy));
                const retry = await tryGenerate(candidates[adapterIndex]!, normalizedRequest, retriesUsed + 1, failures);
                if (retry) {
                  current = retry;
                  currentHandle = current;
                  continue;
                }
              }

              if (adapterIndex >= candidates.length - 1) break;
              adapterIndex += 1;
              current = await tryGenerate(candidates[adapterIndex]!, normalizedRequest, 0, failures) as AdapterJobHandle;
              currentHandle = current;
              if (!current) break;
            }
          }

          throw failures.length > 1 ? new GenerationExhaustedError(failures) : (failures[0] ?? new GenerationExhaustedError(failures));
        },
        async cancel(): Promise<void> {
          if (currentHandle && currentHandle.cancel) await currentHandle.cancel();
        }
      };
      let currentHandle: AdapterJobHandle | undefined = first.handle;
      return new Job(resilientHandle, normalizedInput.strategy);
    },

    async job(id: string, options: ResumeJobOptions = {}): Promise<Job> {
      const normalizedId = id.trim();

      if (!normalizedId) {
        throw new InvalidRequestError("A non-empty image job ID is required to resume a generation.");
      }

      const adapter = await getAdapter(options.provider);

      if (!adapter.resume) {
        throw new ConfigurationError(`${adapter.provider} does not support resuming image jobs.`);
      }

      const handle = await adapter.resume(normalizedId, options.metadata);
      return new Job(handle, "async");
    },

    async parseWebhook(request: Request | unknown, options: ParseWebhookOptions = {}): Promise<ImageResult> {
      const adapter = await getAdapter(options.provider);

      if (!adapter.parseWebhook) {
        throw new ConfigurationError(`${adapter.provider} does not support image webhooks.`);
      }

      return adapter.parseWebhook(await normalizeWebhookInput(request), options.metadata);
    },

    capabilities: getCapabilities
    ,usage
  };

  async function selectAdapters(request: NormalizedRequest): Promise<Adapter[]> {
    const adapters = await getAdapters();
    const requested = request.provider ? adapters.filter((adapter) => adapter.provider === request.provider) : [...adapters];
    if (requested.length === 0) {
      throw new ConfigurationError(request.provider ? `No ${request.provider} adapter is configured for this image client.` : "No image provider configured. Set a provider API key or configure an adapter with createImageClient().");
    }

    const configuredFallback = request.fallback ?? options.fallback;
    const names = Array.isArray(configuredFallback) ? configuredFallback : undefined;
    const ordered = names ? names.map((name) => requested.find((adapter) => adapter.provider === name)).filter((adapter): adapter is Adapter => Boolean(adapter)) : requested;
    const compatible: Adapter[] = [];
    for (const adapter of ordered) {
      try {
        validateRequestCapabilities(adapter, request);
        compatible.push(adapter);
      } catch (error) {
        if (!request.provider && configuredFallback !== true && !Array.isArray(configuredFallback)) throw error;
      }
    }
    if (compatible.length === 0) throw new UnsupportedCapabilityError(ordered[0]!.provider, "requested generation options");
    return compatible;
  }

  async function acquireHandle(adapters: readonly Adapter[], request: NormalizedRequest, policy: ReturnType<typeof normalizeRetryPolicy>) {
    const failures: unknown[] = [];
    for (let adapterIndex = 0; adapterIndex < adapters.length; adapterIndex += 1) {
      for (let retryCount = 0; retryCount <= policy.retries; retryCount += 1) {
        const handle = await tryGenerate(adapters[adapterIndex]!, request, retryCount, failures);
        if (handle) return { handle, adapter: adapters[adapterIndex]!, adapterIndex, failures };
        if (retryCount < policy.retries) await delay(getRetryDelayMs(retryCount + 1, policy));
      }
      if (adapterIndex < adapters.length - 1) continue;
    }
    return { failures };
  }

  async function tryGenerate(adapter: Adapter, request: NormalizedRequest, retryCount: number, failures: unknown[]): Promise<AdapterJobHandle | undefined> {
    try {
      assertWithinPerCallBudget(adapter, request);
      const { retry: _retry, fallback: _fallback, provider: _provider, maxCostPerCall: _maxCostPerCall, ...adapterRequest } = request;
      const handle = await adapter.generate(adapterRequest);
      if (retryCount > 0) handle.metadata = { ...(handle.metadata ?? {}), retryCount };
      return handle;
    } catch (error) {
      failures.push(error);
      recordUsage(usage, adapter, undefined, request.prompt, 0, false, undefined, error);
      const disposition = classifyGenerationFailure(error).disposition;
      if (disposition === "fail") throw error;
      return undefined;
    }
  }

  function assertWithinPerCallBudget(adapter: Adapter, request: NormalizedRequest): void {
    const limit = request.maxCostPerCall ?? options.maxCostPerCall;
    if (!limit) {
      return;
    }

    const normalizedLimit = normalizeCost(limit, "maxCostPerCall");
    const estimate = options.estimateCost?.(adapter, request) ?? adapter.estimateCost?.(request);
    if (!estimate) {
      throw new ConfigurationError(`${adapter.provider} cannot be used with maxCostPerCall because it does not expose a cost estimate.`);
    }

    const normalizedEstimate = normalizeCost(estimate, `${adapter.provider} estimated cost`);
    if (normalizedEstimate.currency !== normalizedLimit.currency) {
      throw new ConfigurationError(
        `${adapter.provider} estimated cost currency (${normalizedEstimate.currency}) does not match maxCostPerCall currency (${normalizedLimit.currency}).`
      );
    }

    if (normalizedEstimate.amount > normalizedLimit.amount) {
      throw new BudgetExceededError(adapter.provider, normalizedEstimate, normalizedLimit);
    }
  }
}

function validateRequestCapabilities(adapter: Adapter, request: NormalizedRequest): NormalizedRequest {
  const { capabilities } = adapter;

  if (request.aspectRatio && !capabilities.aspectRatios.includes(request.aspectRatio)) {
    throw new UnsupportedCapabilityError(adapter.provider, "aspectRatio", {
      requested: request.aspectRatio,
      supported: capabilities.aspectRatios
    });
  }

  if (request.seed !== undefined && !capabilities.seed) {
    throw new UnsupportedCapabilityError(adapter.provider, "seed", { requested: request.seed });
  }

  if (request.quality && !capabilities.qualities.includes(request.quality)) {
    throw new UnsupportedCapabilityError(adapter.provider, "quality", {
      requested: request.quality,
      supported: capabilities.qualities
    });
  }

  if (request.strategy === "async" && !capabilities.async) {
    throw new UnsupportedCapabilityError(adapter.provider, "async generation strategy");
  }

  if (request.webhookUrl && !capabilities.webhooks) {
    throw new UnsupportedCapabilityError(adapter.provider, "webhooks");
  }

  if (request.mode === "image-to-image" && !capabilities.referenceImages.supported) {
    throw new UnsupportedCapabilityError(adapter.provider, "reference images", {
      requested: 1,
      supported: capabilities.referenceImages.max ?? 0
    });
  }

  if (request.mode === "inpainting" && !capabilities.inpainting) {
    throw new UnsupportedCapabilityError(adapter.provider, "inpainting");
  }

  return request.resolution
    ? {
        ...request,
        resolution: snapResolution(request.resolution, capabilities.resolutionBuckets ?? [], adapter.provider, request.aspectRatio)
      }
    : request;
}

function recordUsage(
  tracker: InMemoryUsageTracker,
  adapter: Adapter,
  source: ImageResult | AdapterJobHandle | undefined,
  prompt: string,
  latencyMs: number,
  success: boolean,
  generationId?: string,
  error?: unknown
): void {
  const result = source && "url" in source ? source : undefined;
  const metadata = source && !result && "metadata" in source ? source.metadata : undefined;
  const cost = result?.cost ?? readCost(metadata) ?? { amount: 0, currency: "USD", estimated: true };
  const model = result?.model ?? readString(metadata, "model") ?? adapter.provider;
  try {
    tracker.record({
      provider: adapter.provider,
      model,
      cost,
      latencyMs: Math.max(0, latencyMs),
      success,
      promptLength: prompt.length,
      timestamp: new Date().toISOString(),
      ...(generationId === undefined ? {} : { generationId }),
      ...(error && typeof error === "object" && "code" in error && typeof error.code === "string" ? { errorCode: error.code } : {})
    });
  } catch {
    // Usage accounting must never make a provider result fail.
  }
}

function readString(value: JobMetadata | undefined, key: string): string | undefined {
  return typeof value?.[key] === "string" ? value[key] as string : undefined;
}

function readCost(value: JobMetadata | undefined): import("./types").ImageCost | undefined {
  const cost = value?.cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const record = cost as Record<string, unknown>;
  return typeof record.amount === "number" && typeof record.currency === "string" && typeof record.estimated === "boolean"
    ? { amount: record.amount, currency: record.currency, estimated: record.estimated }
    : undefined;
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRequest(request: ImageGenerationInput): NormalizedRequest {
  const prompt = request.prompt?.trim();

  if (!prompt) {
    throw new InvalidRequestError("An image prompt is required. Pass a non-empty prompt string.");
  }

  const image = request.image === undefined ? undefined : normalizeImageInput(request.image, "image");
  const mask = request.mask === undefined ? undefined : normalizeImageInput(request.mask, "mask");
  const mode = request.mode ?? (mask ? "inpainting" : image ? "image-to-image" : "text-to-image");

  if (mode === "text-to-image" && (image || mask)) {
    throw new InvalidRequestError("Text-to-image requests cannot include image or mask input. Use image-to-image or inpainting mode.");
  }

  if (mode === "image-to-image" && !image) {
    throw new InvalidRequestError("Image-to-image requests require an image input.");
  }

  if (mode === "image-to-image" && mask) {
    throw new InvalidRequestError("Image-to-image requests cannot include a mask. Use inpainting mode instead.");
  }

  if (mode === "inpainting" && !image) {
    throw new InvalidRequestError("Inpainting requests require an image input.");
  }

  if (request.strength !== undefined && (!Number.isFinite(request.strength) || request.strength < 0 || request.strength > 1)) {
    throw new InvalidRequestError("Image strength must be a number between 0 and 1.");
  }

  if (request.strength !== undefined && mode !== "image-to-image") {
    throw new InvalidRequestError("Image strength is supported only for image-to-image requests.");
  }

  return {
    prompt,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    seed: request.seed,
    mode,
    strategy: request.strategy ?? "managed",
    ...(request.provider === undefined ? {} : { provider: request.provider })
    ,...(request.retry === undefined ? {} : { retry: request.retry })
    ,...(request.fallback === undefined ? {} : { fallback: request.fallback })
    ,...(request.maxCostPerCall === undefined ? {} : { maxCostPerCall: normalizeCost(request.maxCostPerCall, "maxCostPerCall") })
    ,...(request.webhookUrl === undefined ? {} : { webhookUrl: request.webhookUrl })
    ,...(image === undefined ? {} : { image })
    ,...(mask === undefined ? {} : { mask })
    ,...(request.strength === undefined ? {} : { strength: request.strength })
    ,...(request.resolution === undefined ? {} : { resolution: request.resolution })
  };
}

function normalizeCost(cost: ImageCost, name: string): ImageCost {
  if (!Number.isFinite(cost.amount) || cost.amount < 0) {
    throw new InvalidRequestError(`${name}.amount must be a non-negative finite number.`);
  }

  const currency = cost.currency.trim().toUpperCase();
  if (!currency) {
    throw new InvalidRequestError(`${name}.currency must be a non-empty string.`);
  }

  if (typeof cost.estimated !== "boolean") {
    throw new InvalidRequestError(`${name}.estimated must be a boolean.`);
  }

  return { amount: cost.amount, currency, estimated: cost.estimated };
}

async function normalizeWebhookInput(request: Request | unknown): Promise<WebhookInput> {
  if (isRequestLike(request)) {
    try {
      return {
        payload: await request.json(),
        headers: request.headers
      };
    } catch (error) {
      throw new InvalidRequestError("The image webhook request must contain valid JSON.", error);
    }
  }

  return { payload: request };
}

function isRequestLike(value: unknown): value is Pick<Request, "json" | "headers"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "json" in value &&
    typeof value.json === "function" &&
    "headers" in value &&
    value.headers instanceof Headers
  );
}
