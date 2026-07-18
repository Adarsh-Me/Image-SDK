import { normalizeModeration, type Adapter, type AdapterCapabilities, type AdapterJobHandle, type ImageResult, type NormalizedRequest } from "@image-sdk/core";

export interface MockAdapterOptions {
  model?: string;
}

export const MOCK_CAPABILITIES: AdapterCapabilities = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3"],
  maxImagesPerCall: 1,
  referenceImages: { supported: false },
  inpainting: false,
  negativePrompt: false,
  seed: true,
  qualities: [],
  outputFormats: ["svg"],
  async: false,
  webhooks: false,
  livePreview: false
};

const MOCK_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 864 }
};

export function mock(options: MockAdapterOptions = {}): Adapter {
  const model = options.model ?? "mock-image-v1";

  return {
    provider: "mock",
    capabilities: MOCK_CAPABILITIES,

    async generate(request: NormalizedRequest): Promise<AdapterJobHandle> {
      const result = createMockResult(request, model);

      return {
        id: `mock-${stableHash(request.prompt)}`,
        provider: "mock",
        status: "complete",
        async result(): Promise<ImageResult> {
          return result;
        },
        async cancel(): Promise<void> {
          // The mock completes immediately, so cancellation is intentionally a no-op.
        }
      };
    }
  };
}

function createMockResult(request: NormalizedRequest, model: string): ImageResult {
  const hash = stableHash(`${request.prompt}:${request.aspectRatio ?? "1:1"}`);
  const color = `#${hash.slice(0, 6)}`;
  const escapedPrompt = escapeXml(request.prompt);
  const dimensions = MOCK_DIMENSIONS[request.aspectRatio ?? "1:1"] ?? MOCK_DIMENSIONS["1:1"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}"><rect width="${dimensions.width}" height="${dimensions.height}" fill="${color}"/><text x="64" y="${Math.floor(dimensions.height / 2)}" fill="#ffffff" font-family="sans-serif" font-size="42">${escapedPrompt}</text></svg>`;
  const buffer = new TextEncoder().encode(svg);

  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    buffer,
    mimeType: "image/svg+xml",
    width: dimensions.width,
    height: dimensions.height,
    provider: "mock",
    model,
    cost: {
      amount: 0,
      currency: "USD",
      estimated: true
    },
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    moderation: normalizeModeration("mock")
  };
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return character;
    }
  });
}
