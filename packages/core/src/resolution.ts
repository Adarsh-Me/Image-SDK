import { InvalidRequestError, UnsupportedCapabilityError } from "./errors";
import type { ImageResolution } from "./types";

export function snapResolution(
  requested: ImageResolution,
  buckets: readonly ImageResolution[],
  provider: string,
  aspectRatio?: string
): ImageResolution {
  validateResolution(requested);

  if (buckets.length === 0) {
    throw new UnsupportedCapabilityError(provider, "resolution", { requested });
  }

  const candidates = aspectRatio ? buckets.filter((bucket) => matchesAspectRatio(bucket, aspectRatio)) : buckets;

  if (candidates.length === 0) {
    throw new UnsupportedCapabilityError(provider, "resolution for the requested aspectRatio", {
      requested,
      aspectRatio,
      supported: buckets
    });
  }

  return candidates.reduce((best, candidate) =>
    resolutionDistance(candidate, requested) < resolutionDistance(best, requested) ? candidate : best
  );
}

export function validateResolution(resolution: ImageResolution): void {
  if (
    !Number.isSafeInteger(resolution.width) ||
    !Number.isSafeInteger(resolution.height) ||
    resolution.width <= 0 ||
    resolution.height <= 0
  ) {
    throw new InvalidRequestError("Resolution width and height must be positive integers.");
  }
}

function resolutionDistance(candidate: ImageResolution, requested: ImageResolution): number {
  return Math.abs(Math.log(candidate.width / requested.width)) + Math.abs(Math.log(candidate.height / requested.height));
}

function matchesAspectRatio(resolution: ImageResolution, aspectRatio: string): boolean {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio);

  if (!match) {
    return false;
  }

  return Math.abs(resolution.width / resolution.height - Number(match[1]) / Number(match[2])) < 0.000_001;
}
