#!/usr/bin/env node

import { writeFile as writeFileToDisk } from "node:fs/promises";
import { resolve } from "node:path";

export const POLLINATIONS_IMAGE_ENDPOINT = "https://image.pollinations.ai/p/";

export interface CliDependencies {
  fetch?: typeof fetch;
  writeFile?: typeof writeFileToDisk;
  cwd?: () => string;
  log?: (message: string) => void;
  now?: () => number;
}

export async function run(args: string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<void> {
  const requestFetch = dependencies.fetch ?? globalThis.fetch;
  const writeFile = dependencies.writeFile ?? writeFileToDisk;
  const cwd = dependencies.cwd ?? process.cwd;
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? Date.now;

  if (!requestFetch) {
    throw new Error("This runtime does not provide fetch, so image-sdk try cannot request an image.");
  }

  const parsed = parseArguments(args);
  const url = `${POLLINATIONS_IMAGE_ENDPOINT}${encodeURIComponent(parsed.prompt)}`;
  const response = await requestFetch(url);

  if (!response.ok) {
    let details = "";

    try {
      details = (await response.text()).trim();
    } catch {
      details = "";
    }

    throw new Error(
      `The demo image service returned HTTP ${response.status}.${details ? ` ${details}` : ""}`
    );
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const outputPath = parsed.outputPath
    ? resolve(cwd(), parsed.outputPath)
    : resolve(cwd(), `image-sdk-${now()}.${fileExtensionFor(contentType)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  await writeFile(outputPath, bytes);
  log(`Saved image to ${outputPath}`);
}

function parseArguments(args: string[]): { prompt: string; outputPath?: string } {
  const [command, ...values] = args;

  if (command !== "try") {
    throw new Error("Usage: image-sdk try <prompt> [--out path]");
  }

  const promptParts: string[] = [];
  let outputPath: string | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--out") {
      outputPath = values[index + 1];
      index += 1;

      if (!outputPath) {
        throw new Error("--out requires a destination path.");
      }

      continue;
    }

    if (value.startsWith("--out=")) {
      outputPath = value.slice("--out=".length);

      if (!outputPath) {
        throw new Error("--out requires a destination path.");
      }

      continue;
    }

    promptParts.push(value);
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error("image-sdk try requires a non-empty prompt.");
  }

  return { prompt, outputPath };
}

function fileExtensionFor(contentType: string): string {
  if (contentType.includes("png")) {
    return "png";
  }

  if (contentType.includes("webp")) {
    return "webp";
  }

  return "jpg";
}

if (typeof require !== "undefined" && require.main === module) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown CLI error";
    console.error(`image-sdk: ${message}`);
    process.exitCode = 1;
  });
}
