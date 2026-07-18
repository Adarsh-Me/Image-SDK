import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["@image-sdk/core"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  }
});
