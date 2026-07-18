import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/@image-sdk\//],
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".js" };
  }
});
