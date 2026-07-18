import type { ModerationInput, ModerationResult } from "./types";

/**
 * Converts an adapter's provider-specific moderation signal into the public
 * result shape. Providers that return no signal are represented explicitly as
 * an unflagged result rather than leaving the field absent.
 */
export function normalizeModeration(provider: string, input: ModerationInput = {}): ModerationResult {
  const categories = input.categories?.filter((category) => category.trim().length > 0);

  return {
    flagged: input.flagged === true,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(categories && categories.length > 0 ? { categories: [...categories] } : {}),
    provider
  };
}
