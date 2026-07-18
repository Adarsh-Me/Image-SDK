import {
  ConfigurationError,
  ModerationError,
  ProviderError,
  normalizeModeration,
  type Adapter,
  type AdapterCapabilities,
  type AdapterJobHandle,
  type ImageResult,
  type NormalizedRequest
} from "@image-sdk/core";

export const IDEOGRAM_DEFAULT_BASE_URL = "https://api.ideogram.ai";
export const IDEOGRAM_DEFAULT_MODEL = "ideogram-v3";

export const IDEOGRAM_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: ["draft", "standard", "high"],
  outputFormats: ["png", "jpeg", "webp"],
  async: false,
  webhooks: false,
  livePreview: false
};

export interface IdeogramAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Model route segment, for example `ideogram-v3`. */
  model?: string;
  /** Overrides the fully-qualified generation endpoint. */
  endpoint?: string;
  fetch?: typeof fetch;
}

interface IdeogramImage {
  url?: unknown;
  resolution?: unknown;
  seed?: unknown;
  is_image_safe?: unknown;
}

interface IdeogramResponse {
  data?: unknown;
}

export function ideogram(options: IdeogramAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? IDEOGRAM_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? IDEOGRAM_DEFAULT_MODEL;
  const endpoint = options.endpoint ?? `${baseUrl}/v1/${model}/generate`;
  const requestFetch = options.fetch ?? globalThis.fetch;

  return {
    provider: "ideogram",
    capabilities: IDEOGRAM_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) {
        throw new ConfigurationError("Ideogram requires an API key. Pass apiKey when creating the adapter.");
      }

      if (!requestFetch) {
        throw new ConfigurationError("A fetch implementation is required to use the Ideogram adapter.");
      }

      const response = await requestFetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": apiKey
        },
        body: JSON.stringify({
          prompt: request.prompt,
          ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          ...(request.quality === undefined ? {} : { rendering_speed: qualityToRenderingSpeed(request.quality) })
        })
      });

      if (!response.ok) {
        throw await toHttpError(response);
      }

      const payload = await readJson<IdeogramResponse>(response);
      const image = getImage(payload);
      const result = toImageResult(image, model);

      return {
        id: `ideogram-${stableHash(result.url)}`,
        provider: "ideogram",
        status: "complete",
        metadata: { model, width: result.width, height: result.height },
        async result(): Promise<ImageResult> {
          return result;
        }
      };
    }
  };
}

function qualityToRenderingSpeed(quality: NonNullable<NormalizedRequest["quality"]>): string {
  switch (quality) {
    case "draft":
      return "FLASH";
    case "high":
      return "QUALITY";
    default:
      return "DEFAULT";
  }
}

function getImage(payload: IdeogramResponse): IdeogramImage {
  if (!Array.isArray(payload.data) || payload.data.length === 0 || !isRecord(payload.data[0])) {
    throw new ProviderError("ideogram", "Ideogram completed without returning an image.", undefined, payload);
  }

  return payload.data[0] as IdeogramImage;
}

function toImageResult(image: IdeogramImage, model: string): ImageResult {
  if (typeof image.url !== "string" || !image.url) {
    throw new ProviderError("ideogram", "Ideogram completed without an image URL.", undefined, image);
  }

  const dimensions = parseResolution(image.resolution);
  const moderation = normalizeModeration("ideogram", {
    flagged: image.is_image_safe === false,
    ...(image.is_image_safe === false ? { reason: "Ideogram marked the generated image as unsafe." } : {})
  });

  if (moderation.flagged) {
    throw new ModerationError("ideogram", "Ideogram rejected the request during moderation.", moderation, undefined, image);
  }

  return {
    url: image.url,
    mimeType: mimeTypeFromUrl(image.url),
    width: dimensions.width,
    height: dimensions.height,
    provider: "ideogram",
    model,
    cost: { amount: 0, currency: "USD", estimated: true },
    ...(typeof image.seed === "number" ? { seed: image.seed } : {}),
    moderation,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString()
  };
}

function parseResolution(value: unknown): { width: number; height: number } {
  const match = typeof value === "string" ? /^(\d+)x(\d+)$/.exec(value) : null;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1024, height: 1024 };
}

function mimeTypeFromUrl(url: string): string {
  const pathname = url.split("?", 1)[0].toLowerCase();
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderError("ideogram", "Ideogram returned invalid JSON.", response.status, error);
  }
}

async function toHttpError(response: Response): Promise<ProviderError> {
  const details = await response.text().catch(() => "");
  const moderation = normalizeModeration("ideogram", {
    flagged: /safety|moderation|policy|blocked|nsfw/i.test(details),
    ...(details ? { reason: details } : {})
  });
  return moderation.flagged
    ? new ModerationError("ideogram", "Ideogram rejected the request during moderation.", moderation, response.status, details)
    : new ProviderError("ideogram", `Ideogram returned HTTP ${response.status}.`, response.status, details);
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
