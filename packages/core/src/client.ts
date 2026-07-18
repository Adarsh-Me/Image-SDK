import { ConfigurationError, InvalidRequestError } from "./errors";
import { Job } from "./job";
import type { Adapter, ImageGenerationInput, NormalizedRequest } from "./types";

export interface CreateImageClientOptions {
  adapters?: readonly Adapter[];
}

export interface ImageClient {
  generate(request: ImageGenerationInput): Promise<Job>;
}

export type DefaultAdapterResolver = () => readonly Adapter[] | Promise<readonly Adapter[]>;

let defaultAdapterResolver: DefaultAdapterResolver | undefined;

export function configureDefaultAdapterResolver(resolver?: DefaultAdapterResolver): void {
  defaultAdapterResolver = resolver;
}

export function createImageClient(options: CreateImageClientOptions = {}): ImageClient {
  const explicitAdapters = options.adapters ? [...options.adapters] : undefined;

  return {
    async generate(request: ImageGenerationInput): Promise<Job> {
      const normalizedRequest = normalizeRequest(request);
      const adapters = explicitAdapters ?? (defaultAdapterResolver ? await defaultAdapterResolver() : []);
      const adapter = adapters[0];

      if (!adapter) {
        throw new ConfigurationError(
          "No image provider configured. Set BFL_API_KEY, configure an adapter with createImageClient(), or use IMAGE_SDK_USE_MOCK=1 in tests."
        );
      }

      const handle = await adapter.generate(normalizedRequest);
      return new Job(handle);
    }
  };
}

function normalizeRequest(request: ImageGenerationInput): NormalizedRequest {
  const prompt = request.prompt?.trim();

  if (!prompt) {
    throw new InvalidRequestError("An image prompt is required. Pass a non-empty prompt string.");
  }

  return {
    prompt,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    seed: request.seed,
    mode: request.mode ?? "text-to-image"
  };
}
