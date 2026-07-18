export class ImageSdkError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ConfigurationError extends ImageSdkError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFIGURATION_ERROR", details);
  }
}

export class InvalidRequestError extends ImageSdkError {
  constructor(message: string, details?: unknown) {
    super(message, "INVALID_REQUEST", details);
  }
}

export class ProviderError extends ImageSdkError {
  readonly provider: string;
  readonly status?: number;

  constructor(provider: string, message: string, status?: number, details?: unknown) {
    super(message, "PROVIDER_ERROR", details);
    this.provider = provider;
    this.status = status;
  }
}

export class UnsupportedCapabilityError extends ImageSdkError {
  readonly provider: string;
  readonly capability: string;

  constructor(provider: string, capability: string, details?: unknown) {
    super(`${provider} does not support the requested ${capability}.`, "UNSUPPORTED_CAPABILITY", details);
    this.provider = provider;
    this.capability = capability;
  }
}

export class ModerationError extends ProviderError {
  readonly moderation: import("./types").ModerationResult;

  constructor(provider: string, message: string, moderation: import("./types").ModerationResult, status?: number, details?: unknown) {
    super(provider, message, status, details);
    this.name = "ModerationError";
    this.moderation = moderation;
  }
}

export class ImageGenerationTimeoutError extends ImageSdkError {
  readonly provider: string;

  constructor(provider: string, timeoutMs: number) {
    super(
      `Image generation with ${provider} timed out after ${timeoutMs}ms. Try again or increase the adapter timeout.`,
      "GENERATION_TIMEOUT",
      { timeoutMs }
    );
    this.provider = provider;
  }
}

export class CancellationError extends ImageSdkError {
  constructor(message = "Image generation was cancelled.") {
    super(message, "GENERATION_CANCELLED");
  }
}

export class GenerationExhaustedError extends ImageSdkError {
  readonly failures: readonly unknown[];

  constructor(failures: readonly unknown[]) {
    super("All configured image providers failed to generate the requested image.", "GENERATION_EXHAUSTED", { failures });
    this.failures = failures;
  }
}
