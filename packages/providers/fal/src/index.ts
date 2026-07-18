import {
  CancellationError,
  ConfigurationError,
  ImageGenerationTimeoutError,
  ModerationError,
  ProviderError,
  normalizeModeration,
  type Adapter,
  type AdapterCapabilities,
  type AdapterJobHandle,
  type ImageResult,
  type JobMetadata,
  type NormalizedRequest,
  type WebhookInput
} from "@image-sdk/core";

export const FAL_DEFAULT_QUEUE_BASE_URL = "https://queue.fal.run";
export const FAL_DEFAULT_MODEL = "fal-ai/flux/schnell";
export const FAL_DEFAULT_POLL_INTERVAL_MS = 1_500;
export const FAL_DEFAULT_POLL_TIMEOUT_MS = 60_000;

export const FAL_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["png", "jpeg"],
  async: true,
  webhooks: true,
  livePreview: false
};

export interface FalAdapterOptions {
  apiKey?: string;
  queueBaseUrl?: string;
  /** fal endpoint ID, for example `fal-ai/flux/schnell`. */
  model?: string;
  /** Adapts the normalized request for a configured fal model. */
  input?: (request: NormalizedRequest) => Record<string, unknown>;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface FalSubmitResponse { request_id?: unknown; response_url?: unknown; status_url?: unknown; cancel_url?: unknown; }
interface FalStatusResponse { status?: unknown; error?: unknown; response_url?: unknown; }
interface FalImage { url?: unknown; width?: unknown; height?: unknown; content_type?: unknown; }
interface FalResult { images?: unknown; seed?: unknown; has_nsfw_concepts?: unknown; }
interface FalWebhook { request_id?: unknown; status?: unknown; payload?: unknown; error?: unknown; }
interface FalJobState { id: string; model: string; statusUrl: string; responseUrl: string; cancelUrl: string; width: number; height: number; seed?: number; }

export function fal(options: FalAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const queueBaseUrl = (options.queueBaseUrl ?? FAL_DEFAULT_QUEUE_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? FAL_DEFAULT_MODEL;
  const requestFetch = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? FAL_DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? FAL_DEFAULT_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const input = options.input ?? defaultInput;

  function configuration(): { apiKey: string; fetch: typeof fetch } {
    if (!apiKey) throw new ConfigurationError("fal requires an API key. Pass apiKey when creating the adapter.");
    if (!requestFetch) throw new ConfigurationError("A fetch implementation is required to use the fal adapter.");
    return { apiKey, fetch: requestFetch };
  }

  function makeHandle(state: FalJobState): AdapterJobHandle {
    let cancelled = false;
    return {
      id: state.id,
      provider: "fal",
      status: "queued",
      metadata: toMetadata(state),
      async result(): Promise<ImageResult> {
        const { apiKey: configuredKey, fetch } = configuration();
        const startedAt = now();
        while (true) {
          if (cancelled) throw new CancellationError();
          if (now() - startedAt >= pollTimeoutMs) throw new ImageGenerationTimeoutError("fal", pollTimeoutMs);
          await sleep(pollIntervalMs);
          if (cancelled) throw new CancellationError();
          const statusResponse = await fetch(state.statusUrl, { headers: authorization(configuredKey) });
          if (!statusResponse.ok) throw await toHttpError(statusResponse);
          const status = await readJson<FalStatusResponse>(statusResponse);
          if (status.status !== "COMPLETED") continue;
          if (typeof status.error === "string" && status.error) throw providerFailure(status.error, status);
          const responseUrl = typeof status.response_url === "string" ? status.response_url : state.responseUrl;
          const resultResponse = await fetch(responseUrl, { headers: authorization(configuredKey) });
          if (!resultResponse.ok) throw await toHttpError(resultResponse);
          return toImageResult(await readJson<FalResult>(resultResponse), state);
        }
      },
      async cancel(): Promise<void> {
        cancelled = true;
        const { apiKey: configuredKey, fetch } = configuration();
        const response = await fetch(state.cancelUrl, { method: "POST", headers: authorization(configuredKey) });
        if (!response.ok && response.status !== 400) throw await toHttpError(response);
      }
    };
  }

  return {
    provider: "fal",
    capabilities: FAL_CAPABILITIES,
    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      const { apiKey: configuredKey, fetch } = configuration();
      const endpoint = `${queueBaseUrl}/${model}${request.webhookUrl ? `?fal_webhook=${encodeURIComponent(request.webhookUrl)}` : ""}`;
      const response = await fetch(endpoint, { method: "POST", headers: { ...authorization(configuredKey), "content-type": "application/json" }, body: JSON.stringify(input(request)) });
      if (!response.ok) throw await toHttpError(response);
      const submitted = await readJson<FalSubmitResponse>(response);
      return makeHandle(stateFromSubmit(submitted, request, model, queueBaseUrl));
    },
    async resume(id: string, metadata?: JobMetadata): Promise<AdapterJobHandle> {
      configuration();
      return makeHandle(stateFromMetadata(id, metadata, model, queueBaseUrl));
    },
    parseWebhook(input: WebhookInput, metadata?: JobMetadata): ImageResult {
      const event = asWebhook(input.payload);
      if (event.status !== "OK") throw providerFailure(typeof event.error === "string" ? event.error : "fal webhook reported a failed generation.", event);
      const id = typeof event.request_id === "string" ? event.request_id : "fal-webhook";
      return toImageResult(asResult(event.payload), stateFromMetadata(id, metadata, model, queueBaseUrl));
    }
  };
}

function defaultInput(request: NormalizedRequest): Record<string, unknown> {
  return { prompt: request.prompt, image_size: imageSize(request.aspectRatio), ...(request.seed === undefined ? {} : { seed: request.seed }) };
}
function imageSize(aspectRatio: string | undefined): string { switch (aspectRatio) { case "16:9": return "landscape_16_9"; case "9:16": return "portrait_16_9"; case "4:3": return "landscape_4_3"; default: return "square_hd"; } }
function authorization(apiKey: string): HeadersInit { return { accept: "application/json", authorization: `Key ${apiKey}` }; }

function stateFromSubmit(submit: FalSubmitResponse, request: NormalizedRequest, model: string, baseUrl: string): FalJobState {
  if (typeof submit.request_id !== "string" || !submit.request_id) throw new ProviderError("fal", "fal returned an invalid queue request ID.", undefined, submit);
  const root = `${baseUrl}/${model}/requests/${encodeURIComponent(submit.request_id)}`;
  const fallback = dimensions(request.aspectRatio);
  return { id: submit.request_id, model, statusUrl: typeof submit.status_url === "string" ? submit.status_url : `${root}/status`, responseUrl: typeof submit.response_url === "string" ? submit.response_url : `${root}/response`, cancelUrl: typeof submit.cancel_url === "string" ? submit.cancel_url : `${root}/cancel`, ...fallback, ...(request.seed === undefined ? {} : { seed: request.seed }) };
}
function stateFromMetadata(id: string, metadata: JobMetadata | undefined, model: string, baseUrl: string): FalJobState {
  const resolvedModel = typeof metadata?.model === "string" ? metadata.model : model;
  const root = `${baseUrl}/${resolvedModel}/requests/${encodeURIComponent(id)}`;
  const fallback = dimensions("1:1");
  return { id, model: resolvedModel, statusUrl: typeof metadata?.statusUrl === "string" ? metadata.statusUrl : `${root}/status`, responseUrl: typeof metadata?.responseUrl === "string" ? metadata.responseUrl : `${root}/response`, cancelUrl: typeof metadata?.cancelUrl === "string" ? metadata.cancelUrl : `${root}/cancel`, width: numberOr(metadata?.width, fallback.width), height: numberOr(metadata?.height, fallback.height), ...(typeof metadata?.seed === "number" ? { seed: metadata.seed } : {}) };
}
function toMetadata(state: FalJobState): JobMetadata { return { model: state.model, statusUrl: state.statusUrl, responseUrl: state.responseUrl, cancelUrl: state.cancelUrl, width: state.width, height: state.height, ...(state.seed === undefined ? {} : { seed: state.seed }) }; }

function toImageResult(payload: FalResult, state: FalJobState): ImageResult {
  const image = firstImage(payload.images);
  if (!image || typeof image.url !== "string" || !image.url) throw new ProviderError("fal", "fal completed without returning an image URL.", undefined, payload);
  const moderation = normalizeModeration("fal", { flagged: Array.isArray(payload.has_nsfw_concepts) && payload.has_nsfw_concepts.some((value) => value === true), ...(Array.isArray(payload.has_nsfw_concepts) && payload.has_nsfw_concepts.some((value) => value === true) ? { reason: "fal marked the image as NSFW." } : {}) });
  if (moderation.flagged) throw new ModerationError("fal", "fal rejected the request during moderation.", moderation, undefined, payload);
  return { url: image.url, mimeType: typeof image.content_type === "string" ? image.content_type : "image/jpeg", width: numberOr(image.width, state.width), height: numberOr(image.height, state.height), provider: "fal", model: state.model, cost: { amount: 0, currency: "USD", estimated: true }, ...(typeof payload.seed === "number" ? { seed: payload.seed } : state.seed === undefined ? {} : { seed: state.seed }), moderation };
}
function asResult(value: unknown): FalResult { if (!isRecord(value)) throw new ProviderError("fal", "fal webhook payload must include an image result.", undefined, value); return value as FalResult; }
function asWebhook(value: unknown): FalWebhook { if (!isRecord(value)) throw new ProviderError("fal", "fal webhook payload must be a JSON object.", undefined, value); return value as FalWebhook; }
function firstImage(value: unknown): FalImage | undefined { return Array.isArray(value) && value.length > 0 && isRecord(value[0]) ? value[0] as FalImage : undefined; }
function providerFailure(message: string, details: unknown): ProviderError { const moderation = normalizeModeration("fal", { flagged: /safety|moderation|policy|blocked|nsfw/i.test(message), reason: message }); return moderation.flagged ? new ModerationError("fal", "fal rejected the request during moderation.", moderation, undefined, details) : new ProviderError("fal", message, undefined, details); }
function dimensions(aspectRatio: string | undefined): { width: number; height: number } { switch (aspectRatio) { case "16:9": return { width: 1344, height: 768 }; case "9:16": return { width: 768, height: 1344 }; case "4:3": return { width: 1152, height: 864 }; default: return { width: 1024, height: 1024 }; } }
function numberOr(value: unknown, fallback: number): number { return typeof value === "number" && value > 0 ? value : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
async function readJson<T>(response: Response): Promise<T> { try { return (await response.json()) as T; } catch (error) { throw new ProviderError("fal", "fal returned invalid JSON.", response.status, error); } }
async function toHttpError(response: Response): Promise<ProviderError> { const details = await response.text().catch(() => ""); return providerFailure(details || `fal returned HTTP ${response.status}.`, details); }
