export type JobStatus = "queued" | "running" | "complete" | "failed";

export type ImageQuality = "draft" | "standard" | "high";

export type ImageMode = "text-to-image";

export interface NormalizedRequest {
  prompt: string;
  aspectRatio?: string;
  quality?: ImageQuality;
  seed?: number;
  mode: ImageMode;
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
  result(): Promise<ImageResult>;
  cancel?(): Promise<void>;
  onProgress?(listener: (progress: number) => void): void | (() => void);
}

export interface Adapter<TOptions = unknown> {
  readonly provider: string;
  generate(request: NormalizedRequest, options?: TOptions): Promise<AdapterJobHandle>;
}

export interface SimpleImageOptions {
  aspectRatio?: string;
  quality?: ImageQuality;
  seed?: number;
}

export interface ImageGenerationInput extends SimpleImageOptions {
  prompt: string;
  mode?: ImageMode;
}

export type JobEvent = "progress" | "complete" | "error";

export interface JobEventData {
  progress: number;
  complete: ImageResult;
  error: Error;
}
