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

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";
export const OPENAI_GPT_IMAGE_MODEL = "gpt-image-1";

export const OPENAI_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: false,
  qualities: ["draft", "standard", "high"],
  outputFormats: ["png", "jpeg", "webp"],
  async: false,
  webhooks: false,
  livePreview: false
};

const OPENAI_SIZES = {
  "1:1": { size: "1024x1024", width: 1024, height: 1024 },
  "16:9": { size: "1536x1024", width: 1536, height: 1024 },
  "9:16": { size: "1024x1536", width: 1024, height: 1536 }
} as const;

export interface OpenAIAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: "gpt-image-1";
  fetch?: typeof fetch;
}

export class OpenAIProviderError extends ProviderError {
  constructor(message: string, status?: number, details?: unknown) {
    super("openai", message, status, details);
    this.name = "OpenAIProviderError";
  }
}

interface OpenAIImageResponse {
  created?: unknown;
  data?: Array<{ b64_json?: unknown }>;
  output_format?: unknown;
  size?: unknown;
}

export function openai(options: OpenAIAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? OPENAI_GPT_IMAGE_MODEL;
  const requestFetch = options.fetch ?? globalThis.fetch;

  return {
    provider: "openai",
    capabilities: OPENAI_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) {
        throw new ConfigurationError("OpenAI requires OPENAI_API_KEY. Set it before generating an image.");
      }

      if (!requestFetch) {
        throw new ConfigurationError("A fetch implementation is required to use the OpenAI adapter.");
      }

      const dimensions = getOpenAIDimensions(request.aspectRatio);
      const response = await requestFetch(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          size: dimensions.size,
          quality: toOpenAIQuality(request.quality),
          output_format: "png"
        })
      });

      if (!response.ok) {
        throw await createHttpError(response);
      }

      const payload = await readJson<OpenAIImageResponse>(response);
      const encoded = payload.data?.[0]?.b64_json;

      if (typeof encoded !== "string" || !encoded) {
        throw new OpenAIProviderError("OpenAI completed without returning base64 image data.", response.status, payload);
      }

      const outputFormat = asOutputFormat(payload.output_format);
      const result: ImageResult = {
        url: `data:${mimeTypeFor(outputFormat)};base64,${encoded}`,
        buffer: fromBase64(encoded),
        mimeType: mimeTypeFor(outputFormat),
        width: dimensions.width,
        height: dimensions.height,
        provider: "openai",
        model,
        cost: { amount: 0, currency: "USD", estimated: true },
        moderation: normalizeModeration("openai")
      };
      const id = `openai-${stableHash(`${request.prompt}:${payload.created ?? ""}:${dimensions.size}`)}`;

      return {
        id,
        provider: "openai",
        status: "complete",
        metadata: { model, size: dimensions.size, width: dimensions.width, height: dimensions.height },
        async result(): Promise<ImageResult> {
          return result;
        }
      };
    }
  };
}

export function getOpenAIDimensions(aspectRatio: string | undefined): { size: string; width: number; height: number } {
  return OPENAI_SIZES[(aspectRatio ?? "1:1") as keyof typeof OPENAI_SIZES] ?? OPENAI_SIZES["1:1"];
}

function toOpenAIQuality(quality: NormalizedRequest["quality"]): "low" | "medium" | "high" {
  switch (quality) {
    case "draft":
      return "low";
    case "high":
      return "high";
    default:
      return "medium";
  }
}

function asOutputFormat(value: unknown): "png" | "jpeg" | "webp" {
  return value === "jpeg" || value === "webp" || value === "png" ? value : "png";
}

function mimeTypeFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function fromBase64(value: string): Uint8Array {
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;

  if (nodeBuffer) {
    return new Uint8Array(nodeBuffer.from(value, "base64"));
  }

  if (typeof atob !== "function") {
    throw new ConfigurationError("A base64 decoder is required to use the OpenAI adapter.");
  }

  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new OpenAIProviderError("OpenAI returned an invalid JSON response.", response.status, error);
  }
}

async function createHttpError(response: Response): Promise<ProviderError> {
  let details: unknown;

  try {
    details = await response.json();
  } catch {
    try {
      details = (await response.text()).trim() || undefined;
    } catch {
      details = undefined;
    }
  }

  const message = getErrorMessage(details) ?? `OpenAI returned HTTP ${response.status}.`;
  const moderation = normalizeModeration("openai", {
    flagged: isModerationMessage(message),
    ...(isModerationMessage(message) ? { reason: message } : {})
  });

  if (moderation.flagged) {
    return new ModerationError("openai", "OpenAI rejected the request during moderation.", moderation, response.status, details);
  }

  return new OpenAIProviderError(message, response.status, details);
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const error = "error" in value && typeof value.error === "object" && value.error !== null ? value.error : value;
  return "message" in error && typeof error.message === "string" && error.message.trim() ? error.message.trim() : undefined;
}

function isModerationMessage(value: string): boolean {
  return /moderation|content policy|safety|policy violation|blocked/i.test(value);
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
