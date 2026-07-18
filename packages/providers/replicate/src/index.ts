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

export const REPLICATE_DEFAULT_BASE_URL = "https://api.replicate.com/v1";
export const REPLICATE_DEFAULT_MODEL = "black-forest-labs/flux-schnell";
export const REPLICATE_DEFAULT_POLL_INTERVAL_MS = 1_500;
export const REPLICATE_DEFAULT_POLL_TIMEOUT_MS = 60_000;

export const REPLICATE_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["png", "jpeg", "webp"],
  async: true,
  webhooks: true,
  livePreview: false
};

export interface ReplicateAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Official or community model slug in `owner/name` form. */
  model?: string;
  /** Model version for the generic `/predictions` endpoint. */
  version?: string;
  /** Adapts the normalized request for models with non-standard input schemas. */
  input?: (request: NormalizedRequest) => Record<string, unknown>;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface ReplicateUrls {
  get?: unknown;
  cancel?: unknown;
}

interface ReplicatePrediction {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  error?: unknown;
  model?: unknown;
  version?: unknown;
  metrics?: { predict_time?: unknown };
  urls?: ReplicateUrls;
}

interface ReplicateJobState {
  id: string;
  getUrl: string;
  cancelUrl?: string;
  model: string;
  width: number;
  height: number;
  seed?: number;
}

export function replicate(options: ReplicateAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? REPLICATE_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? REPLICATE_DEFAULT_MODEL;
  const version = options.version;
  const requestFetch = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? REPLICATE_DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? REPLICATE_DEFAULT_POLL_TIMEOUT_MS;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const input = options.input ?? defaultInput;

  function configuration(): { apiKey: string; fetch: typeof fetch } {
    if (!apiKey) throw new ConfigurationError("Replicate requires an API key. Pass apiKey when creating the adapter.");
    if (!requestFetch) throw new ConfigurationError("A fetch implementation is required to use the Replicate adapter.");
    return { apiKey, fetch: requestFetch };
  }

  function makeHandle(state: ReplicateJobState, initial?: ReplicatePrediction): AdapterJobHandle {
    let cancelled = false;

    return {
      id: state.id,
      provider: "replicate",
      status: "queued",
      metadata: toMetadata(state),
      async result(): Promise<ImageResult> {
        const { apiKey: configuredKey, fetch } = configuration();
        let prediction = initial;
        const startedAt = now();

        while (true) {
          if (cancelled) throw new CancellationError();
          if (prediction) {
            const terminal = terminalResult(prediction, state);
            if (terminal) return terminal;
            assertNotFailed(prediction);
            prediction = undefined;
          }
          if (now() - startedAt >= pollTimeoutMs) throw new ImageGenerationTimeoutError("replicate", pollTimeoutMs);

          await sleep(pollIntervalMs);
          if (cancelled) throw new CancellationError();
          const response = await fetch(state.getUrl, { headers: authorization(configuredKey) });
          if (!response.ok) throw await toHttpError(response);
          prediction = await readJson<ReplicatePrediction>(response);
        }
      },
      async cancel(): Promise<void> {
        cancelled = true;
        if (!state.cancelUrl) return;
        const { apiKey: configuredKey, fetch } = configuration();
        const response = await fetch(state.cancelUrl, { method: "POST", headers: authorization(configuredKey) });
        if (!response.ok && response.status !== 400) throw await toHttpError(response);
      }
    };
  }

  return {
    provider: "replicate",
    capabilities: REPLICATE_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      const { apiKey: configuredKey, fetch } = configuration();
      const endpoint = version ? `${baseUrl}/predictions` : `${baseUrl}/models/${validateModel(model)}/predictions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...authorization(configuredKey), "content-type": "application/json" },
        body: JSON.stringify({
          ...(version ? { version } : {}),
          input: input(request),
          ...(request.webhookUrl ? { webhook: request.webhookUrl, webhook_events_filter: ["completed"] } : {})
        })
      });
      if (!response.ok) throw await toHttpError(response);
      const prediction = await readJson<ReplicatePrediction>(response);
      const state = stateFromPrediction(prediction, request, model, baseUrl);
      return makeHandle(state, prediction);
    },

    async resume(id: string, metadata?: JobMetadata): Promise<AdapterJobHandle> {
      configuration();
      return makeHandle(stateFromMetadata(id, metadata, model, baseUrl));
    },

    parseWebhook(input: WebhookInput, metadata?: JobMetadata): ImageResult {
      const prediction = asPrediction(input.payload);
      const id = typeof prediction.id === "string" ? prediction.id : "replicate-webhook";
      const state = stateFromMetadata(id, metadata, model, baseUrl, false);
      assertNotFailed(prediction);
      const result = terminalResult(prediction, state);
      if (!result) throw new ProviderError("replicate", "Replicate webhook did not contain a completed prediction.", undefined, input.payload);
      return result;
    }
  };
}

function defaultInput(request: NormalizedRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}

function authorization(apiKey: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${apiKey}` };
}

function validateModel(model: string): string {
  const segments = model.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    throw new ConfigurationError("Replicate model must use the `owner/name` format when no version is supplied.");
  }
  return segments.map(encodeURIComponent).join("/");
}

function stateFromPrediction(prediction: ReplicatePrediction, request: NormalizedRequest, model: string, baseUrl: string): ReplicateJobState {
  if (typeof prediction.id !== "string" || !prediction.id) {
    throw new ProviderError("replicate", "Replicate returned an invalid prediction ID.", undefined, prediction);
  }
  const urls = isRecord(prediction.urls) ? prediction.urls : {};
  return {
    id: prediction.id,
    getUrl: typeof urls.get === "string" ? urls.get : `${baseUrl}/predictions/${encodeURIComponent(prediction.id)}`,
    ...(typeof urls.cancel === "string" ? { cancelUrl: urls.cancel } : { cancelUrl: `${baseUrl}/predictions/${encodeURIComponent(prediction.id)}/cancel` }),
    model: typeof prediction.model === "string" ? prediction.model : model,
    ...dimensions(request.aspectRatio),
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}

function stateFromMetadata(id: string, metadata: JobMetadata | undefined, model: string, baseUrl: string, requireGetUrl = true): ReplicateJobState {
  const getUrl = metadata?.getUrl;
  if (requireGetUrl && typeof getUrl !== "string" && !id) throw new ProviderError("replicate", "A Replicate job ID is required.");
  const fallback = dimensions("1:1");
  return {
    id,
    getUrl: typeof getUrl === "string" ? getUrl : `${baseUrl}/predictions/${encodeURIComponent(id)}`,
    ...(typeof metadata?.cancelUrl === "string" ? { cancelUrl: metadata.cancelUrl } : { cancelUrl: `${baseUrl}/predictions/${encodeURIComponent(id)}/cancel` }),
    model: typeof metadata?.model === "string" ? metadata.model : model,
    width: numberOr(metadata?.width, fallback.width),
    height: numberOr(metadata?.height, fallback.height),
    ...(typeof metadata?.seed === "number" ? { seed: metadata.seed } : {})
  };
}

function toMetadata(state: ReplicateJobState): JobMetadata {
  return { getUrl: state.getUrl, ...(state.cancelUrl ? { cancelUrl: state.cancelUrl } : {}), model: state.model, width: state.width, height: state.height, ...(state.seed === undefined ? {} : { seed: state.seed }) };
}

function terminalResult(prediction: ReplicatePrediction, state: ReplicateJobState): ImageResult | undefined {
  if (prediction.status !== "succeeded") return undefined;
  const url = imageUrl(prediction.output);
  if (!url) throw new ProviderError("replicate", "Replicate completed without returning an image URL.", undefined, prediction);
  const moderation = normalizeModeration("replicate");
  return { url, mimeType: mimeType(url), width: state.width, height: state.height, provider: "replicate", model: state.model, cost: { amount: 0, currency: "USD", estimated: true }, ...(state.seed === undefined ? {} : { seed: state.seed }), moderation };
}

function assertNotFailed(prediction: ReplicatePrediction): void {
  if (prediction.status !== "failed" && prediction.status !== "canceled") return;
  const message = typeof prediction.error === "string" ? prediction.error : `Replicate prediction ${prediction.status}.`;
  const moderation = normalizeModeration("replicate", { flagged: /safety|moderation|policy|blocked|nsfw/i.test(message), reason: message });
  if (moderation.flagged) throw new ModerationError("replicate", "Replicate rejected the request during moderation.", moderation, undefined, prediction);
  throw new ProviderError("replicate", message, undefined, prediction);
}

function imageUrl(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output) || output.length === 0) return undefined;
  const first = output[0];
  return typeof first === "string" ? first : isRecord(first) && typeof first.url === "string" ? first.url : undefined;
}

function dimensions(aspectRatio: string | undefined): { width: number; height: number } {
  switch (aspectRatio) { case "16:9": return { width: 1344, height: 768 }; case "9:16": return { width: 768, height: 1344 }; case "4:3": return { width: 1152, height: 864 }; default: return { width: 1024, height: 1024 }; }
}
function mimeType(url: string): string { const path = url.split("?", 1)[0].toLowerCase(); return path.endsWith(".webp") ? "image/webp" : path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : "image/png"; }
function numberOr(value: unknown, fallback: number): number { return typeof value === "number" && value > 0 ? value : fallback; }
function asPrediction(value: unknown): ReplicatePrediction { if (!isRecord(value)) throw new ProviderError("replicate", "Replicate webhook payload must be a JSON object.", undefined, value); return value as ReplicatePrediction; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
async function readJson<T>(response: Response): Promise<T> { try { return (await response.json()) as T; } catch (error) { throw new ProviderError("replicate", "Replicate returned invalid JSON.", response.status, error); } }
async function toHttpError(response: Response): Promise<ProviderError> { const details = await response.text().catch(() => ""); const moderation = normalizeModeration("replicate", { flagged: /safety|moderation|policy|blocked|nsfw/i.test(details), ...(details ? { reason: details } : {}) }); return moderation.flagged ? new ModerationError("replicate", "Replicate rejected the request during moderation.", moderation, response.status, details) : new ProviderError("replicate", `Replicate returned HTTP ${response.status}.`, response.status, details); }
