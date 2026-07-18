import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [
  "packages/core",
  "packages/providers/flux",
  "packages/providers/mock",
  "packages/sdk",
  "packages/cli"
];

for (const packageDirectory of packageDirectories) {
  rmSync(resolve(root, packageDirectory, "dist"), { recursive: true, force: true });
}
