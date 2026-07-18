export type JobStatus = "queued" | "running" | "complete" | "failed";

export type ImageQuality = "draft" | "standard" | "high";

export type ImageMode = "text-to-image" | "image-to-image" | "inpainting";

export type ImageGenerationStrategy = "managed" | "async";

export type JobMetadata = Record<string, unknown>;

export interface NormalizedRequest {
  prompt: string;
  provider?: string;
  retry?: import("./retry").RetryPolicy;
  fallback?: boolean | readonly string[];
  aspectRatio?: string;
  quality?: ImageQuality;
  seed?: number;
  mode: ImageMode;
  strategy: ImageGenerationStrategy;
  webhookUrl?: string;
  image?: NormalizedImageInput;
  mask?: NormalizedImageInput;
  strength?: number;
  resolution?: ImageResolution;
}

export interface ImageCost {
  amount: number;
  currency: string;
  estimated: boolean;
}

export interface ModerationResult {
  flagged: boolean;
  reason?: string;
  categories?: string[];
  provider: string;
}

export interface ModerationInput {
  flagged?: boolean;
  reason?: string;
  categories?: readonly string[];
}

export interface AdapterCapabilities {
  aspectRatios: readonly string[];
  maxImagesPerCall: number;
  referenceImages: {
    supported: boolean;
    max?: number;
  };
  inpainting: boolean;
  negativePrompt: boolean;
  seed: boolean;
  qualities: readonly ImageQuality[];
  outputFormats: readonly string[];
  async: boolean;
  webhooks: boolean;
  livePreview: boolean;
  /** Discrete output sizes accepted by the adapter. Omit when no explicit size control is available. */
  resolutionBuckets?: readonly ImageResolution[];
}

export interface ImageResolution {
  width: number;
  height: number;
}

export type ImageInput = Uint8Array | string;

export interface ByteImageInput {
  kind: "bytes";
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface UrlImageInput {
  kind: "url";
  url: string;
}

export type NormalizedImageInput = ByteImageInput | UrlImageInput;

export interface ImageResult {
  url: string;
  buffer?: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  cost: ImageCost;
  seed?: number;
  moderation: ModerationResult;
  expiresAt?: string;
}

export interface AdapterJobHandle {
  id: string;
  provider: string;
  status?: JobStatus;
  metadata?: JobMetadata;
  result(): Promise<ImageResult>;
  cancel?(): Promise<void>;
  onProgress?(listener: (progress: number) => void): void | (() => void);
}

export interface WebhookInput {
  payload: unknown;
  headers?: Headers;
}

export interface Adapter<TOptions = unknown> {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;
  generate(request: NormalizedRequest, options?: TOptions): Promise<AdapterJobHandle>;
  resume?(id: string, metadata?: JobMetadata): Promise<AdapterJobHandle>;
  parseWebhook?(input: WebhookInput, metadata?: JobMetadata): Promise<ImageResult> | ImageResult;
}

export interface SimpleImageOptions {
  provider?: string;
  aspectRatio?: string;
  quality?: ImageQuality;
  seed?: number;
  resolution?: ImageResolution;
}

export interface ImageGenerationInput extends SimpleImageOptions {
  prompt: string;
  provider?: string;
  mode?: ImageMode;
  strategy?: ImageGenerationStrategy;
  webhookUrl?: string;
  image?: ImageInput;
  mask?: ImageInput;
  strength?: number;
  retry?: import("./retry").RetryPolicy;
  fallback?: boolean | readonly string[];
}

export interface ImageEditOptions extends SimpleImageOptions {
  image: ImageInput;
  mask?: ImageInput;
  strength?: number;
  strategy?: ImageGenerationStrategy;
  webhookUrl?: string;
}

export type JobEvent = "progress" | "complete" | "error";

export interface JobEventData {
  progress: number;
  complete: ImageResult;
  error: Error;
}
