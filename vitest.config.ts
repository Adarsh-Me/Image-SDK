import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = resolve(__dirname);

const aliases = {
  "@image-sdk/core": resolve(root, "packages/core/src/index.ts"),
  "@image-sdk/flux": resolve(root, "packages/providers/flux/src/index.ts"),
  "@image-sdk/mock": resolve(root, "packages/providers/mock/src/index.ts"),
  "@image-sdk/stability": resolve(root, "packages/providers/stability/src/index.ts"),
  "@image-sdk/openai": resolve(root, "packages/providers/openai/src/index.ts"),
  "@image-sdk/recraft": resolve(root, "packages/providers/recraft/src/index.ts"),
  "@image-sdk/ideogram": resolve(root, "packages/providers/ideogram/src/index.ts"),
  "@image-sdk/replicate": resolve(root, "packages/providers/replicate/src/index.ts"),
  "@image-sdk/fal": resolve(root, "packages/providers/fal/src/index.ts"),
  "@image-sdk/google": resolve(root, "packages/providers/google/src/index.ts"),
  "@image-sdk/production": resolve(root, "packages/production/src/index.ts"),
  "@image-sdk/storage-s3": resolve(root, "packages/storage-s3/src/index.ts"),
  "@image-sdk/react": resolve(root, "packages/react/src/index.ts"),
  "@image-sdk/mcp": resolve(root, "packages/mcp/src/index.ts"),
  "image-sdk": resolve(root, "packages/sdk/src/index.ts")
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node"
  }
});
