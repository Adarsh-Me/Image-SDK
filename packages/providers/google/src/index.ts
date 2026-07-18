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

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash-image";

export const GOOGLE_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: false,
  qualities: ["draft", "standard", "high"],
  outputFormats: ["png"],
  async: false,
  webhooks: false,
  livePreview: false
};

export interface GoogleAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

interface JsonRecord { [key: string]: unknown; }

export function google(options: GoogleAdapterOptions = {}): Adapter {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? GOOGLE_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? GOOGLE_DEFAULT_MODEL;
  const requestFetch = options.fetch ?? globalThis.fetch;

  return {
    provider: "google",
    capabilities: GOOGLE_CAPABILITIES,
    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      if (!apiKey) throw new ConfigurationError("Google image generation requires GOOGLE_API_KEY or GEMINI_API_KEY.");
      if (!requestFetch) throw new ConfigurationError("A fetch implementation is required to use the Google adapter.");

      const isImagen = model.startsWith("imagen-");
      const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:${isImagen ? "predict" : "generateContent"}`;
      const body = isImagen
        ? { instances: [{ prompt: request.prompt }], parameters: { sampleCount: 1, aspectRatio: request.aspectRatio ?? "1:1" } }
        : { contents: [{ role: "user", parts: [{ text: request.prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
      const response = await requestFetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body)
      });
      const payload = await readJson(response);
      if (!response.ok) throw toProviderError(response.status, payload);

      const encoded = findImageBytes(payload);
      if (!encoded) throw new ProviderError("google", "Google completed without returning image bytes.", response.status, payload);
      const dimensions = dimensionsFor(request.aspectRatio);
      const result: ImageResult = {
        url: `data:image/png;base64,${encoded}`,
        buffer: decodeBase64(encoded),
        mimeType: "image/png",
        width: dimensions.width,
        height: dimensions.height,
        provider: "google",
        model,
        cost: { amount: 0, currency: "USD", estimated: true },
        moderation: normalizeModeration("google")
      };
      return { id: `google-${hash(`${request.prompt}:${model}`)}`, provider: "google", status: "complete", metadata: { model }, result: async () => result };
    }
  };
}

function findImageBytes(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
  const prediction = predictions[0];
  if (isRecord(prediction) && typeof prediction.bytesBase64Encoded === "string") return prediction.bytesBase64Encoded;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const content = isRecord(candidates[0]) ? candidates[0].content : undefined;
  const parts = isRecord(content) && Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (isRecord(part) && isRecord(part.inlineData) && typeof part.inlineData.data === "string") return part.inlineData.data;
  }
  return undefined;
}

function dimensionsFor(aspectRatio: string | undefined): { width: number; height: number } {
  switch (aspectRatio) {
    case "16:9": return { width: 1344, height: 768 };
    case "9:16": return { width: 768, height: 1344 };
    case "4:3": return { width: 1152, height: 864 };
    case "3:4": return { width: 864, height: 1152 };
    default: return { width: 1024, height: 1024 };
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch (error) { throw new ProviderError("google", "Google returned invalid JSON.", response.status, error); }
}

function toProviderError(status: number, payload: unknown): ProviderError {
  const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : `Google returned HTTP ${status}.`;
  const moderation = normalizeModeration("google", { flagged: /safety|moderation|policy|blocked|nsfw/i.test(message), reason: message });
  return moderation.flagged ? new ModerationError("google", "Google rejected the request during moderation.", moderation, status, payload) : new ProviderError("google", message, status, payload);
}

function decodeBase64(value: string): Uint8Array {
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(value, "base64"));
  if (typeof atob !== "function") throw new ConfigurationError("A base64 decoder is required to use the Google adapter.");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16);
}

function isRecord(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
