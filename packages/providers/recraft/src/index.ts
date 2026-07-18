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

export const RECRAFT_DEFAULT_BASE_URL = "https://external.api.recraft.ai/v1";
export const RECRAFT_DEFAULT_MODEL = "recraftv4_1";

export const RECRAFT_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["png", "jpeg", "webp", "svg"],
  async: false,
  webhooks: false,
  livePreview: false
};

const RECRAFT_DIMENSIONS = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1216, height: 896 }
} as const;

export interface RecraftAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

export class RecraftProviderError extends ProviderError {
  constructor(message: string, status?: number, details?: unknown) {
    super("recraft", message, status, details);
    this.name = "RecraftProviderError";
  }
}

interface RecraftImageResponse {
  data?: Array<{
    b64_json?: unknown;
    url?: unknown;
    image_type?: unknown;
  }>;
}

export function recraft(options: RecraftAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? RECRAFT_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? RECRAFT_DEFAULT_MODEL;
  const requestFetch = options.fetch ?? globalThis.fetch;

  return {
    provider: "recraft",
    capabilities: RECRAFT_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) {
        throw new ConfigurationError("Recraft requires RECRAFT_API_KEY. Set it before generating an image.");
      }

      if (!requestFetch) {
        throw new ConfigurationError("A fetch implementation is required to use the Recraft adapter.");
      }

      const dimensions = getRecraftDimensions(request.aspectRatio);
      const response = await requestFetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          prompt: request.prompt,
          model,
          size: request.aspectRatio ?? "1:1",
          n: 1,
          response_format: "b64_json",
          ...(request.seed === undefined ? {} : { random_seed: request.seed })
        })
      });

      if (!response.ok) {
        throw await createHttpError(response);
      }

      const payload = await readJson<RecraftImageResponse>(response);
      const image = payload.data?.[0];
      const encoded = image?.b64_json;

      if (typeof encoded !== "string" || !encoded) {
        throw new RecraftProviderError("Recraft completed without returning base64 image data.", response.status, payload);
      }

      const mimeType = getMimeType(image?.image_type);
      const result: ImageResult = {
        url: `data:${mimeType};base64,${encoded}`,
        buffer: fromBase64(encoded),
        mimeType,
        width: dimensions.width,
        height: dimensions.height,
        provider: "recraft",
        model,
        cost: { amount: 0, currency: "credits", estimated: true },
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        moderation: normalizeModeration("recraft")
      };
      const id = `recraft-${stableHash(`${request.prompt}:${model}:${request.seed ?? ""}:${request.aspectRatio ?? "1:1"}`)}`;

      return {
        id,
        provider: "recraft",
        status: "complete",
        metadata: { model, width: dimensions.width, height: dimensions.height },
        async result(): Promise<ImageResult> {
          return result;
        }
      };
    }
  };
}

export function getRecraftDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  return RECRAFT_DIMENSIONS[(aspectRatio ?? "1:1") as keyof typeof RECRAFT_DIMENSIONS] ?? RECRAFT_DIMENSIONS["1:1"];
}

function getMimeType(value: unknown): string {
  if (value === "jpeg" || value === "jpg" || value === "image/jpeg") {
    return "image/jpeg";
  }

  if (value === "webp" || value === "image/webp") {
    return "image/webp";
  }

  if (value === "svg" || value === "image/svg+xml") {
    return "image/svg+xml";
  }

  return "image/png";
}

function fromBase64(value: string): Uint8Array {
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;

  if (nodeBuffer) {
    return new Uint8Array(nodeBuffer.from(value, "base64"));
  }

  if (typeof atob !== "function") {
    throw new ConfigurationError("A base64 decoder is required to use the Recraft adapter.");
  }

  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new RecraftProviderError("Recraft returned an invalid JSON response.", response.status, error);
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

  const message = getErrorMessage(details) ?? `Recraft returned HTTP ${response.status}.`;
  const moderation = normalizeModeration("recraft", {
    flagged: isModerationMessage(message),
    ...(isModerationMessage(message) ? { reason: message } : {})
  });

  if (moderation.flagged) {
    return new ModerationError("recraft", "Recraft rejected the request during moderation.", moderation, response.status, details);
  }

  return new RecraftProviderError(message, response.status, details);
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
