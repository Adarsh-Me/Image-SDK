import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@image-sdk/core": fileURLToPath(new URL("../../core/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/providers/openai/test/**/*.test.ts"],
    environment: "node"
  }
});
