import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cjsEntry = resolve(packageRoot, "dist/index.js");
const esmEntry = pathToFileURL(resolve(packageRoot, "dist/index.mjs")).href;

describe("package outputs", () => {
  it("loads the public facade through CommonJS and ESM exports", () => {
    expect(() => {
      execFileSync(process.execPath, ["-e", `const sdk = require(${JSON.stringify(cjsEntry)}); if (typeof sdk.generateImage !== 'function') process.exit(1);`]);
    }).not.toThrow();

    expect(() => {
      execFileSync(process.execPath, ["--input-type=module", "-e", `import * as sdk from ${JSON.stringify(esmEntry)}; if (typeof sdk.createImageClient !== 'function') process.exit(1);`]);
    }).not.toThrow();
  });
});
