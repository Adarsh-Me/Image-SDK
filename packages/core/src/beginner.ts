import { createImageClient } from "./client";
import type { ImageResult, SimpleImageOptions } from "./types";

export async function generateImage(prompt: string, options: SimpleImageOptions = {}): Promise<ImageResult> {
  const client = createImageClient();
  const job = await client.generate({ prompt, ...options });
  return job.result();
}
