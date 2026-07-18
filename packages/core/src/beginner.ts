import { createImageClient, type ParseWebhookOptions } from "./client";
import type { ImageEditOptions, ImageGenerationInput, ImageResult, SimpleImageOptions } from "./types";

export async function generateImage(prompt: string, options: SimpleImageOptions = {}): Promise<ImageResult> {
  const client = createImageClient();
  const job = await client.generate({ prompt, ...options });
  return job.result();
}

export async function editImage(prompt: string, options: ImageEditOptions): Promise<ImageResult> {
  const client = createImageClient();
  const job = await client.generate({
    prompt,
    ...options,
    mode: options.mask === undefined ? "image-to-image" : "inpainting"
  });
  return job.result();
}

export async function parseWebhook(request: Request | unknown, options: ParseWebhookOptions = {}): Promise<ImageResult> {
  return createImageClient().parseWebhook(request, options);
}

export const images = {
  generate(request: ImageGenerationInput) {
    return createImageClient().generate(request);
  },
  edit(prompt: string, options: ImageEditOptions) {
    return editImage(prompt, options);
  },
  job(id: string, options = {}) {
    return createImageClient().job(id, options);
  },
  parseWebhook(request: Request | unknown, options: ParseWebhookOptions = {}) {
    return createImageClient().parseWebhook(request, options);
  }
};
