import { describe, expect, it } from "vitest";
import { createImageClient } from "@image-sdk/core";
import { flux } from "../src";

const runLiveTest = process.env.IMAGE_SDK_LIVE_TEST === "1" && Boolean(process.env.BFL_API_KEY);
const liveDescribe = runLiveTest ? describe : describe.skip;

liveDescribe("Flux live smoke test", () => {
  it(
    "generates an image with BFL_API_KEY when explicitly enabled",
    async () => {
      const client = createImageClient({ adapters: [flux({ apiKey: process.env.BFL_API_KEY })] });
      const result = await (await client.generate({ prompt: "a small blue square on white" })).result();

      expect(result.provider).toBe("flux");
      expect(result.url).toMatch(/^https?:\/\//);
    },
    70_000
  );
});
