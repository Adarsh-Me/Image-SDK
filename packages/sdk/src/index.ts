import { configureDefaultAdapterResolver, type Adapter } from "@image-sdk/core";
import { flux } from "@image-sdk/flux";
import { mock } from "@image-sdk/mock";
import { stability } from "@image-sdk/stability";
import { openai } from "@image-sdk/openai";
import { recraft } from "@image-sdk/recraft";
import { ideogram } from "@image-sdk/ideogram";
import { replicate } from "@image-sdk/replicate";
import { fal } from "@image-sdk/fal";
import { google } from "@image-sdk/google";

configureDefaultAdapterResolver(() => {
  const environment = typeof process === "undefined" ? {} : process.env;

  if (environment.IMAGE_SDK_USE_MOCK === "1") {
    return [mock()];
  }

  const adapters: Adapter[] = [];
  if (environment.BFL_API_KEY) adapters.push(flux({ apiKey: environment.BFL_API_KEY }));
  if (environment.STABILITY_API_KEY) adapters.push(stability({ apiKey: environment.STABILITY_API_KEY }));
  if (environment.OPENAI_API_KEY) adapters.push(openai({ apiKey: environment.OPENAI_API_KEY }));
  if (environment.RECRAFT_API_KEY) adapters.push(recraft({ apiKey: environment.RECRAFT_API_KEY }));
  if (environment.IDEOGRAM_API_KEY) adapters.push(ideogram({ apiKey: environment.IDEOGRAM_API_KEY }));
  if (environment.REPLICATE_API_TOKEN) adapters.push(replicate({ apiKey: environment.REPLICATE_API_TOKEN }));
  if (environment.FAL_KEY) adapters.push(fal({ apiKey: environment.FAL_KEY }));
  if (environment.GOOGLE_API_KEY || environment.GEMINI_API_KEY) adapters.push(google({ apiKey: environment.GOOGLE_API_KEY ?? environment.GEMINI_API_KEY }));
  return adapters;
});

export * from "@image-sdk/core";
