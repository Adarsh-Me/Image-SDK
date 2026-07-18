import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsupCli = resolve(root, "node_modules", "tsup", "dist", "cli-default.js");
const packageDirectories = [
  "packages/core",
  "packages/providers/flux",
  "packages/providers/mock",
  "packages/providers/stability",
  "packages/providers/openai",
  "packages/providers/recraft",
  "packages/providers/ideogram",
  "packages/providers/replicate",
  "packages/providers/fal",
  "packages/providers/google",
  "packages/storage-s3",
  "packages/production",
  "packages/react",
  "packages/mcp",
  "packages/sdk",
  "packages/cli"
];

for (const packageDirectory of packageDirectories) {
  const result = spawnSync(process.execPath, [tsupCli, "--config", "tsup.config.ts"], {
    cwd: resolve(root, packageDirectory),
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
