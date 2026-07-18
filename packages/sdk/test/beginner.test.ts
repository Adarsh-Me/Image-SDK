import { afterEach, describe, expect, it } from "vitest";
import { generateImage } from "../src";

const originalMockFlag = process.env.IMAGE_SDK_USE_MOCK;
const originalBflKey = process.env.BFL_API_KEY;

afterEach(() => {
  if (originalMockFlag === undefined) {
    delete process.env.IMAGE_SDK_USE_MOCK;
  } else {
    process.env.IMAGE_SDK_USE_MOCK = originalMockFlag;
  }

  if (originalBflKey === undefined) {
    delete process.env.BFL_API_KEY;
  } else {
    process.env.BFL_API_KEY = originalBflKey;
  }
});

describe("image-sdk beginner API", () => {
  it("works without manually constructing a client in the mock test environment", async () => {
    process.env.IMAGE_SDK_USE_MOCK = "1";
    delete process.env.BFL_API_KEY;

    const result = await generateImage("a beginner test image");

    expect(result).toMatchObject({
      provider: "mock",
      moderation: { flagged: false, provider: "mock" }
    });
  });
});
