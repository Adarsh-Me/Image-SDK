import { configureDefaultAdapterResolver } from "@image-sdk/core";
import { flux } from "@image-sdk/flux";
import { mock } from "@image-sdk/mock";

configureDefaultAdapterResolver(() => {
  const environment = typeof process === "undefined" ? {} : process.env;

  if (environment.IMAGE_SDK_USE_MOCK === "1") {
    return [mock()];
  }

  if (environment.BFL_API_KEY) {
    return [flux({ apiKey: environment.BFL_API_KEY })];
  }

  return [];
});

export * from "@image-sdk/core";
