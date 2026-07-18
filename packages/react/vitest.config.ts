import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@image-sdk/core": resolve(__dirname, "../core/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/react/test/**/*.test.ts"]
  }
});
