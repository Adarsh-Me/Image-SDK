import {
  CancellationError,
  ConfigurationError,
  ImageGenerationTimeoutError,
  ModerationError,
  ProviderError,
  UnsupportedCapabilityError,
  normalizeModeration,
  type Adapter,
  type AdapterCapabilities,
  type AdapterJobHandle,
  type ImageResult,
  type JobMetadata,
  type NormalizedRequest,
  type WebhookInput
} from "@image-sdk/core";

export const FLUX_DEFAULT_BASE_URL = "https://api.bfl.ai";
export const FLUX_DEFAULT_MODEL = "flux-2-pro-preview";
export const FLUX_DEFAULT_POLL_INTERVAL_MS = 1_500;
export const FLUX_DEFAULT_POLL_TIMEOUT_MS = 60_000;

export const FLUX_DIMENSIONS = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 864 }
} as const;

export type FluxAspectRatio = keyof typeof FLUX_DIMENSIONS;

export const FLUX_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: true, max: 1 },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["jpeg"],
  async: true,
  webhooks: true,
  livePreview: false,
  resolutionBuckets: Object.values(FLUX_DIMENSIONS)
};

export interface FluxAdapterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  webhookSecret?: string;
}

interface FluxSubmitResponse {
  id?: unknown;
  polling_url?: unknown;
  cost?: unknown;
}

interface FluxPollResponse {
  status?: unknown;
  result?: {
    sample?: unknown;
  };
  message?: unknown;
  error?: unknown;
  moderation?: unknown;
}

interface FluxJobState {
  id: string;
  pollingUrl: string;
  width: number;
  height: number;
  model: string;
  cost?: number;
  seed?: number;
}

export function flux(options: FluxAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const model = options.model ?? FLUX_DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? FLUX_DEFAULT_BASE_URL).replace(/\/$/, "");
  const requestFetch = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? FLUX_DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? FLUX_DEFAULT_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const webhookSecret = options.webhookSecret;

  function getConfiguration(): { apiKey: string; fetch: typeof fetch } {
    if (!apiKey) {
      throw new ConfigurationError("Flux requires BFL_API_KEY. Set it before generating an image.");
    }

    if (!requestFetch) {
      throw new ConfigurationError("A fetch implementation is required to use the Flux adapter.");
    }

    return { apiKey, fetch: requestFetch };
  }

  function createHandle(state: FluxJobState): AdapterJobHandle {
    let cancelled = false;

    return {
      id: state.id,
      provider: "flux",
      status: "queued",
      metadata: toMetadata(state),
      async result(): Promise<ImageResult> {
        const configuration = getConfiguration();
        const startedAt = now();

        while (true) {
          if (cancelled) {
            throw new CancellationError();
          }

          if (now() - startedAt >= pollTimeoutMs) {
            throw new ImageGenerationTimeoutError("flux", pollTimeoutMs);
          }

          await sleep(pollIntervalMs);

          if (cancelled) {
            throw new CancellationError();
          }

          if (now() - startedAt >= pollTimeoutMs) {
            throw new ImageGenerationTimeoutError("flux", pollTimeoutMs);
          }

          const pollResponse = await configuration.fetch(state.pollingUrl, {
            method: "GET",
            headers: {
              accept: "application/json",
              "x-key": configuration.apiKey
            }
          });

          if (!pollResponse.ok) {
            throw await createHttpError("flux", pollResponse);
          }

          const polled = await readJson<FluxPollResponse>(pollResponse, "flux");
          const status = typeof polled.status === "string" ? polled.status : "";

          if (status === "Ready") {
            return toImageResult(polled, state, now);
          }

          if (status === "Error" || status === "Failed") {
            throw createFluxFailure(polled);
          }
        }
      },
      async cancel(): Promise<void> {
        cancelled = true;
      }
    };
  }

  return {
    provider: "flux",
    capabilities: FLUX_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      const configuration = getConfiguration();

      const dimensions = request.resolution ?? getFluxDimensions(request.aspectRatio);
      const inputImage = getFluxInputImage(request);
      const submitResponse = await configuration.fetch(`${baseUrl}/v1/${model}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-key": configuration.apiKey
        },
        body: JSON.stringify({
          prompt: request.prompt,
          width: dimensions.width,
          height: dimensions.height,
          ...(inputImage === undefined ? {} : { input_image: inputImage }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          output_format: "jpeg",
          ...(request.webhookUrl === undefined ? {} : { webhook_url: request.webhookUrl }),
          ...(request.webhookUrl === undefined || webhookSecret === undefined ? {} : { webhook_secret: webhookSecret })
        })
      });

      if (!submitResponse.ok) {
        throw await createHttpError("flux", submitResponse);
      }

      const submitted = await readJson<FluxSubmitResponse>(submitResponse, "flux");
      const id = typeof submitted.id === "string" ? submitted.id : undefined;
      const pollingUrl = typeof submitted.polling_url === "string" ? submitted.polling_url : undefined;

      if (!id || !pollingUrl) {
        throw new ProviderError("flux", "Flux returned an invalid generation response.", undefined, submitted);
      }

      return createHandle({
        id,
        pollingUrl,
        width: dimensions.width,
        height: dimensions.height,
        model,
        ...(typeof submitted.cost === "number" ? { cost: submitted.cost } : {}),
        ...(request.seed === undefined ? {} : { seed: request.seed })
      });
    },

    async resume(id: string, metadata?: JobMetadata): Promise<AdapterJobHandle> {
      getConfiguration();
      return createHandle(fromMetadata(id, metadata));
    },

    parseWebhook(input: WebhookInput, metadata?: JobMetadata): ImageResult {
      if (webhookSecret && input.headers?.get("x-webhook-secret") !== webhookSecret) {
        throw new ProviderError("flux", "Flux webhook authentication failed.");
      }

      const payload = asFluxPollResponse(input.payload);
      const status = typeof payload.status === "string" ? payload.status : "";

      if (status === "Error" || status === "Failed") {
        throw createFluxFailure(payload, input.payload);
      }

      if (status !== "Ready") {
        throw new ProviderError("flux", "Flux webhook did not contain a completed image result.", undefined, input.payload);
      }

      const id = getWebhookId(input.payload);
      return toImageResult(payload, fromMetadata(id, metadata, false), now);
    }
  };
}

function getFluxInputImage(request: NormalizedRequest): string | undefined {
  if (request.mode !== "image-to-image") {
    return undefined;
  }

  if (request.strength !== undefined) {
    throw new UnsupportedCapabilityError("flux", "image-edit strength", {
      supported: "Flux image editing does not expose a strength parameter."
    });
  }

  if (!request.image || request.image.kind !== "url") {
    throw new UnsupportedCapabilityError("flux", "byte-backed reference images", {
      supported: "HTTPS URLs only"
    });
  }

  return request.image.url;
}

export function getFluxDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  const ratio = aspectRatio ?? "1:1";
  const dimensions = FLUX_DIMENSIONS[ratio as FluxAspectRatio];

  if (!dimensions) {
    throw new ProviderError(
      "flux",
      `Flux supports only these aspect ratios in Phase 1: ${Object.keys(FLUX_DIMENSIONS).join(", ")}.`,
      undefined,
      { aspectRatio: ratio }
    );
  }

  return dimensions;
}

function toMetadata(state: FluxJobState): JobMetadata {
  return {
    pollingUrl: state.pollingUrl,
    width: state.width,
    height: state.height,
    model: state.model,
    ...(state.cost === undefined ? {} : { cost: state.cost }),
    ...(state.seed === undefined ? {} : { seed: state.seed })
  };
}

function fromMetadata(id: string, metadata: JobMetadata | undefined, requirePollingUrl = true): FluxJobState {
  const fallbackDimensions = getFluxDimensions("1:1");
  const pollingUrl = metadata?.pollingUrl;

  if (requirePollingUrl && (typeof pollingUrl !== "string" || !pollingUrl)) {
    throw new ProviderError(
      "flux",
      "Flux job metadata must include the pollingUrl returned when the job was submitted.",
      undefined,
      metadata
    );
  }

  const width = positiveInteger(metadata?.width) ?? fallbackDimensions.width;
  const height = positiveInteger(metadata?.height) ?? fallbackDimensions.height;
  const model = typeof metadata?.model === "string" && metadata.model ? metadata.model : FLUX_DEFAULT_MODEL;
  const cost = typeof metadata?.cost === "number" ? metadata.cost : undefined;
  const seed = typeof metadata?.seed === "number" ? metadata.seed : undefined;

  return {
    id,
    pollingUrl: typeof pollingUrl === "string" ? pollingUrl : "",
    width,
    height,
    model,
    ...(cost === undefined ? {} : { cost }),
    ...(seed === undefined ? {} : { seed })
  };
}

function toImageResult(response: FluxPollResponse, state: FluxJobState, now: () => number): ImageResult {
  const url = response.result?.sample;

  if (typeof url !== "string" || !url) {
    throw new ProviderError("flux", "Flux completed without returning an image URL.", undefined, response);
  }

  return {
    url,
    mimeType: "image/jpeg",
    width: state.width,
    height: state.height,
    provider: "flux",
    model: state.model,
    cost:
      state.cost === undefined
        ? { amount: 0, currency: "USD", estimated: true }
        : { amount: state.cost, currency: "credits", estimated: false },
    ...(state.seed === undefined ? {} : { seed: state.seed }),
    moderation: normalizeModeration("flux", getFluxModeration(response)),
    expiresAt: new Date(now() + 10 * 60 * 1_000).toISOString()
  };
}

function asFluxPollResponse(value: unknown): FluxPollResponse {
  if (!isRecord(value)) {
    throw new ProviderError("flux", "Flux webhook payload must be a JSON object.", undefined, value);
  }

  const result = isRecord(value.result)
    ? {
        sample: value.result.sample
      }
    : undefined;

  return {
    status: value.status,
    result,
    message: value.message,
    error: value.error,
    moderation: value.moderation
  };
}

function getWebhookId(value: unknown): string {
  return isRecord(value) && typeof value.id === "string" && value.id ? value.id : "flux-webhook";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function readJson<T>(response: Response, provider: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderError(provider, "The provider returned an invalid JSON response.", response.status, error);
  }
}

async function createHttpError(provider: string, response: Response): Promise<ProviderError> {
  let details: string | undefined;

  try {
    details = (await response.text()).trim() || undefined;
  } catch {
    details = undefined;
  }

  const moderation = normalizeModeration(provider, {
    flagged: isModerationMessage(details),
    ...(details ? { reason: details } : {})
  });

  if (moderation.flagged) {
    return new ModerationError(provider, `${provider} rejected the request during moderation.`, moderation, response.status, details);
  }

  return new ProviderError(provider, `${provider} returned HTTP ${response.status}.`, response.status, details);
}

function getFluxFailureMessage(response: FluxPollResponse): string {
  if (typeof response.message === "string" && response.message.trim()) {
    return response.message;
  }

  if (typeof response.error === "string" && response.error.trim()) {
    return response.error;
  }

  return "Flux could not complete the generation.";
}

function createFluxFailure(response: FluxPollResponse, details: unknown = response): ProviderError {
  const moderation = normalizeModeration("flux", getFluxModeration(response));

  if (moderation.flagged) {
    return new ModerationError("flux", "Flux rejected the request during moderation.", moderation, undefined, details);
  }

  return new ProviderError("flux", getFluxFailureMessage(response), undefined, details);
}

function getFluxModeration(response: FluxPollResponse): { flagged: boolean; reason?: string; categories?: string[] } {
  const native = isRecord(response.moderation) ? response.moderation : undefined;
  const reason = firstNonEmptyString(native?.reason, response.message, response.error);
  const categories = toStringArray(native?.categories ?? native?.category);

  return {
    flagged: native?.flagged === true || native?.blocked === true || isModerationMessage(reason),
    ...(reason ? { reason } : {}),
    ...(categories.length > 0 ? { categories } : {})
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isModerationMessage(value: unknown): boolean {
  return typeof value === "string" && /moderation|content policy|content filter|safety|nsfw|blocked/i.test(value);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
