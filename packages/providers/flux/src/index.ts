import {
  CancellationError,
  ConfigurationError,
  ImageGenerationTimeoutError,
  ProviderError,
  type Adapter,
  type AdapterJobHandle,
  type ImageResult,
  type NormalizedRequest
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

export interface FluxAdapterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
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

  return {
    provider: "flux",

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) {
        throw new ConfigurationError("Flux requires BFL_API_KEY. Set it before generating an image.");
      }

      if (!requestFetch) {
        throw new ConfigurationError("A fetch implementation is required to use the Flux adapter.");
      }

      const dimensions = getFluxDimensions(request.aspectRatio);
      const submitResponse = await requestFetch(`${baseUrl}/v1/${model}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-key": apiKey
        },
        body: JSON.stringify({
          prompt: request.prompt,
          width: dimensions.width,
          height: dimensions.height,
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          output_format: "jpeg"
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

      let cancelled = false;

      return {
        id,
        provider: "flux",
        status: "queued",
        async result(): Promise<ImageResult> {
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

            const pollResponse = await requestFetch(pollingUrl, {
              method: "GET",
              headers: {
                accept: "application/json",
                "x-key": apiKey
              }
            });

            if (!pollResponse.ok) {
              throw await createHttpError("flux", pollResponse);
            }

            const polled = await readJson<FluxPollResponse>(pollResponse, "flux");
            const status = typeof polled.status === "string" ? polled.status : "";

            if (status === "Ready") {
              const url = polled.result?.sample;

              if (typeof url !== "string") {
                throw new ProviderError("flux", "Flux completed without returning an image URL.", undefined, polled);
              }

              return {
                url,
                mimeType: "image/jpeg",
                width: dimensions.width,
                height: dimensions.height,
                provider: "flux",
                model,
                cost:
                  typeof submitted.cost === "number"
                    ? { amount: submitted.cost, currency: "credits", estimated: false }
                    : { amount: 0, currency: "USD", estimated: true },
                ...(request.seed === undefined ? {} : { seed: request.seed }),
                moderation: {
                  flagged: false,
                  provider: "flux"
                },
                expiresAt: new Date(now() + 10 * 60 * 1_000).toISOString()
              };
            }

            if (status === "Error" || status === "Failed") {
              const message = getFluxFailureMessage(polled);
              throw new ProviderError("flux", message, undefined, polled);
            }
          }
        },
        async cancel(): Promise<void> {
          cancelled = true;
        }
      };
    }
  };
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

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
