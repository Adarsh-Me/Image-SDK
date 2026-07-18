import {
  ConfigurationError,
  InvalidRequestError,
  ModerationError,
  ProviderError,
  normalizeModeration,
  normalizeImageBytes,
  type Adapter,
  type AdapterCapabilities,
  type AdapterJobHandle,
  type ImageResult,
  type ByteImageInput,
  type NormalizedImageInput,
  type NormalizedRequest
} from "@image-sdk/core";

export const STABILITY_DEFAULT_BASE_URL = "https://api.stability.ai";
export const STABILITY_CORE_MODEL = "stable-image-core";

export const STABILITY_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"],
  maxImagesPerCall: 1,
  referenceImages: { supported: true, max: 1 },
  inpainting: true,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["png", "jpeg", "webp"],
  async: false,
  webhooks: false,
  livePreview: false,
  resolutionBuckets: []
};

export interface StabilityAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function stability(options: StabilityAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? STABILITY_DEFAULT_BASE_URL).replace(/\/$/, "");
  const requestFetch = options.fetch ?? globalThis.fetch;

  return {
    provider: "stability",
    capabilities: STABILITY_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) {
        throw new ConfigurationError("Stability requires STABILITY_API_KEY. Set it before generating an image.");
      }

      if (!requestFetch) {
        throw new ConfigurationError("A fetch implementation is required to use the Stability adapter.");
      }

      if (request.webhookUrl) {
        throw new ProviderError(
          "stability",
          "Stability Stable Image Core returns images synchronously and does not support generation webhooks."
        );
      }

      const body = new FormData();
      body.set("prompt", request.prompt);
      const endpoint = await populateStabilityBody(body, request, requestFetch);

      if (request.mode === "text-to-image" && request.aspectRatio) {
        body.set("aspect_ratio", request.aspectRatio);
      }

      if (request.seed !== undefined) {
        body.set("seed", String(request.seed));
      }

      const response = await requestFetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          accept: "image/*",
          authorization: `Bearer ${apiKey}`
        },
        body
      });

      if (!response.ok) {
        throw await createHttpError(response);
      }

      const buffer = new Uint8Array(await response.arrayBuffer());

      if (buffer.length === 0) {
        throw new ProviderError("stability", "Stability completed without returning image bytes.");
      }

      const mimeType = getImageMimeType(response.headers.get("content-type"));
      const dimensions = getImageDimensions(buffer, request.aspectRatio);
      const result: ImageResult = {
        url: `data:${mimeType};base64,${toBase64(buffer)}`,
        buffer,
        mimeType,
        width: dimensions.width,
        height: dimensions.height,
        provider: "stability",
        model: STABILITY_CORE_MODEL,
        cost: { amount: 0, currency: "USD", estimated: true },
        ...(request.seed === undefined ? {} : { seed: request.seed }),
        moderation: normalizeModeration("stability")
      };

      return {
        id: `stability-${stableHash(`${request.prompt}:${request.seed ?? ""}`)}`,
        provider: "stability",
        status: "complete",
        metadata: { width: dimensions.width, height: dimensions.height, model: STABILITY_CORE_MODEL },
        async result(): Promise<ImageResult> {
          return result;
        }
      };
    }
  };
}

async function populateStabilityBody(body: FormData, request: NormalizedRequest, requestFetch: typeof fetch): Promise<string> {
  if (request.mode === "text-to-image") {
    return "/v2beta/stable-image/generate/core";
  }

  const image = await materializeImage(request.image, "image", requestFetch);
  addImagePart(body, "image", image);

  if (request.mode === "image-to-image") {
    if (request.strength === undefined) {
      throw new InvalidRequestError("Stability image-to-image requests require a strength between 0 and 1.");
    }

    body.set("mode", "image-to-image");
    body.set("strength", String(request.strength));
    return "/v2beta/stable-image/generate/core";
  }

  if (request.mask) {
    const mask = await materializeImage(request.mask, "mask", requestFetch);
    if (image.bytes.length + mask.bytes.length > 10 * 1024 * 1024) {
      throw new InvalidRequestError("Stability image and mask inputs must not exceed 10 MiB combined.");
    }
    addImagePart(body, "mask", mask);
  }

  return "/v2beta/stable-image/edit/inpaint";
}

async function materializeImage(
  input: NormalizedImageInput | undefined,
  name: "image" | "mask",
  requestFetch: typeof fetch
): Promise<ByteImageInput> {
  if (!input) {
    throw new InvalidRequestError(`Stability ${name} input is required.`);
  }

  if (input.kind === "bytes") {
    return input;
  }

  const response = await requestFetch(input.url, { method: "GET", headers: { accept: "image/*" } });

  if (!response.ok) {
    throw new ProviderError("stability", `Stability could not download the ${name} HTTPS URL (HTTP ${response.status}).`, response.status);
  }

  return normalizeImageBytes(new Uint8Array(await response.arrayBuffer()), name, response.headers.get("content-type") ?? undefined);
}

function addImagePart(body: FormData, name: "image" | "mask", input: ByteImageInput): void {
  const extension = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType === "image/png" ? "png" : "webp";
  body.set(name, new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), `${name}.${extension}`);
}

function getImageMimeType(contentType: string | null): string {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();

  if (!mimeType || !mimeType.startsWith("image/")) {
    return "image/png";
  }

  return mimeType;
}

function getImageDimensions(bytes: Uint8Array, aspectRatio: string | undefined): { width: number; height: number } {
  return readPngDimensions(bytes) ?? readJpegDimensions(bytes) ?? readWebpDimensions(bytes) ?? fallbackDimensions(aspectRatio);
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return undefined;
  }

  return {
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20)
  };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    const length = readUint16(bytes, offset + 2);

    if (length < 2 || offset + 2 + length > bytes.length) {
      return undefined;
    }

    if (isJpegStartOfFrame(marker)) {
      return {
        height: readUint16(bytes, offset + 5),
        width: readUint16(bytes, offset + 7)
      };
    }

    offset += length + 2;
  }

  return undefined;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
  ) {
    return undefined;
  }

  const type = String.fromCharCode(...bytes.slice(12, 16));

  if (type === "VP8X") {
    return {
      width: 1 + readUint24LittleEndian(bytes, 24),
      height: 1 + readUint24LittleEndian(bytes, 27)
    };
  }

  if (type === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: readUint16LittleEndian(bytes, 26) & 0x3fff,
      height: readUint16LittleEndian(bytes, 28) & 0x3fff
    };
  }

  if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  return undefined;
}

function fallbackDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9":
      return { width: 1344, height: 768 };
    case "9:16":
      return { width: 768, height: 1344 };
    case "4:3":
      return { width: 1152, height: 864 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1_00_00_00) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
}

function toBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;

  if (nodeBuffer) {
    return nodeBuffer.from(bytes).toString("base64");
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa !== "function") {
    throw new ConfigurationError("A base64 encoder is required to use the Stability adapter.");
  }

  return btoa(binary);
}

async function createHttpError(response: Response): Promise<ProviderError> {
  let details: string | undefined;

  try {
    details = (await response.text()).trim() || undefined;
  } catch {
    details = undefined;
  }

  const moderation = normalizeModeration("stability", {
    flagged: isModerationMessage(details),
    ...(details ? { reason: details } : {})
  });

  if (moderation.flagged) {
    return new ModerationError(
      "stability",
      "Stability rejected the request during moderation.",
      moderation,
      response.status,
      details
    );
  }

  return new ProviderError("stability", `Stability returned HTTP ${response.status}.`, response.status, details);
}

function isModerationMessage(value: unknown): boolean {
  return typeof value === "string" && /moderation|content policy|content filter|safety|nsfw|blocked/i.test(value);
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
