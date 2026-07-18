#!/usr/bin/env node

import { writeFile as writeFileToDisk } from "node:fs/promises";
import { resolve } from "node:path";
import { generateImage as generateImageWithSdk, type ImageResult, type SimpleImageOptions } from "image-sdk";

export const POLLINATIONS_IMAGE_ENDPOINT = "https://image.pollinations.ai/p/";

type ImageGenerator = (prompt: string, options?: SimpleImageOptions) => Promise<ImageResult>;

export interface CliDependencies {
  fetch?: typeof fetch;
  writeFile?: typeof writeFileToDisk;
  cwd?: () => string;
  log?: (message: string) => void;
  now?: () => number;
  generateImage?: ImageGenerator;
  environment?: NodeJS.ProcessEnv;
}

export async function run(args: string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<void> {
  const requestFetch = dependencies.fetch ?? globalThis.fetch;
  const writeFile = dependencies.writeFile ?? writeFileToDisk;
  const cwd = dependencies.cwd ?? process.cwd;
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? Date.now;
  const parsed = parseArguments(args);

  if (parsed.command === "try") {
    await runTry(parsed, requestFetch, writeFile, cwd, log, now);
    return;
  }

  if (parsed.command === "generate") {
    await runGenerate(parsed, dependencies.generateImage ?? generateImageWithSdk, requestFetch, writeFile, cwd, log, now);
    return;
  }

  runProviders(dependencies.environment ?? process.env, log);
}

interface TryCommand {
  command: "try";
  prompt: string;
  outputPath?: string;
}

interface GenerateCommand {
  command: "generate";
  prompt: string;
  outputPath?: string;
  options: SimpleImageOptions;
}

interface ProvidersCommand {
  command: "providers";
}

type ParsedCommand = TryCommand | GenerateCommand | ProvidersCommand;

async function runTry(
  parsed: TryCommand,
  requestFetch: typeof fetch | undefined,
  writeFile: typeof writeFileToDisk,
  cwd: () => string,
  log: (message: string) => void,
  now: () => number
): Promise<void> {
  const fetchImage = requireFetch(requestFetch, "try");
  const url = `${POLLINATIONS_IMAGE_ENDPOINT}${encodeURIComponent(parsed.prompt)}`;
  const response = await fetchImage(url);

  if (!response.ok) {
    throw await createHttpError("The demo image service", response);
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const outputPath = parsed.outputPath
    ? resolve(cwd(), parsed.outputPath)
    : resolve(cwd(), `image-sdk-${now()}.${fileExtensionFor(contentType)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  await writeFile(outputPath, bytes);
  log(`Saved image to ${outputPath}`);
}

async function runGenerate(
  parsed: GenerateCommand,
  generateImage: ImageGenerator,
  requestFetch: typeof fetch | undefined,
  writeFile: typeof writeFileToDisk,
  cwd: () => string,
  log: (message: string) => void,
  now: () => number
): Promise<void> {
  const result = await generateImage(parsed.prompt, parsed.options);
  const bytes = result.buffer ?? (await readGeneratedImage(result, requestFetch));
  const outputPath = parsed.outputPath
    ? resolve(cwd(), parsed.outputPath)
    : resolve(cwd(), `image-sdk-${now()}.${fileExtensionFor(result.mimeType)}`);

  await writeFile(outputPath, bytes);
  const estimated = result.cost.estimated ? " estimated" : "";
  log(
    `Saved ${result.provider}/${result.model} image (${result.width}x${result.height}, ${result.cost.amount} ${result.cost.currency}${estimated}) to ${outputPath}`
  );
}

function runProviders(environment: NodeJS.ProcessEnv, log: (message: string) => void): void {
  if (environment.IMAGE_SDK_USE_MOCK === "1") {
    log("mock: configured (IMAGE_SDK_USE_MOCK=1)");
    log("flux: disabled while mock mode is active");
    log("stability: disabled while mock mode is active");
    return;
  }

  log(`flux: ${environment.BFL_API_KEY ? "configured" : "not configured (set BFL_API_KEY)"}`);
  log(`stability: ${environment.STABILITY_API_KEY ? "configured" : "not configured (set STABILITY_API_KEY)"}`);
  log(`openai: ${environment.OPENAI_API_KEY ? "configured" : "not configured (set OPENAI_API_KEY)"}`);
  log(`recraft: ${environment.RECRAFT_API_KEY ? "configured" : "not configured (set RECRAFT_API_KEY)"}`);
  log(`ideogram: ${environment.IDEOGRAM_API_KEY ? "configured" : "not configured (set IDEOGRAM_API_KEY)"}`);
  log(`replicate: ${environment.REPLICATE_API_TOKEN ? "configured" : "not configured (set REPLICATE_API_TOKEN)"}`);
  log(`fal: ${environment.FAL_KEY ? "configured" : "not configured (set FAL_KEY)"}`);
  log(`google: ${environment.GOOGLE_API_KEY || environment.GEMINI_API_KEY ? "configured" : "not configured (set GOOGLE_API_KEY)"}`);
}

function parseArguments(args: string[]): ParsedCommand {
  const [command, ...values] = args;

  if (command === "try") {
    return { command, ...parsePromptAndOutput(values, "image-sdk try") };
  }

  if (command === "generate") {
    return { command, ...parseGenerateArguments(values) };
  }

  if (command === "providers") {
    if (values.length > 0) {
      throw new Error("Usage: image-sdk providers");
    }

    return { command };
  }

  throw new Error(
    "Usage: image-sdk try <prompt> [--out path] | generate <prompt> [--out path] [--provider name] [--aspect-ratio ratio] [--quality draft|standard|high] [--seed number] | providers"
  );
}

function parsePromptAndOutput(values: string[], usage: string): { prompt: string; outputPath?: string } {
  const promptParts: string[] = [];
  let outputPath: string | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--out") {
      outputPath = requireOptionValue(values[index + 1], "--out");
      index += 1;
      continue;
    }

    if (value.startsWith("--out=")) {
      outputPath = requireOptionValue(value.slice("--out=".length), "--out");
      continue;
    }

    promptParts.push(value);
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error(`${usage} requires a non-empty prompt.`);
  }

  return { prompt, outputPath };
}

function parseGenerateArguments(values: string[]): { prompt: string; outputPath?: string; options: SimpleImageOptions } {
  const promptParts: string[] = [];
  let outputPath: string | undefined;
  let aspectRatio: string | undefined;
  let provider: string | undefined;
  let quality: SimpleImageOptions["quality"];
  let seed: number | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === "--out" || value === "--provider" || value === "--aspect-ratio" || value === "--quality" || value === "--seed") {
      const optionValue = requireOptionValue(values[index + 1], value);
      index += 1;

      if (value === "--out") {
        outputPath = optionValue;
      } else if (value === "--provider") {
        provider = optionValue;
      } else if (value === "--aspect-ratio") {
        aspectRatio = optionValue;
      } else if (value === "--quality") {
        quality = parseQuality(optionValue);
      } else {
        seed = parseSeed(optionValue);
      }

      continue;
    }

    if (value.startsWith("--out=")) {
      outputPath = requireOptionValue(value.slice("--out=".length), "--out");
      continue;
    }

    if (value.startsWith("--provider=")) {
      provider = requireOptionValue(value.slice("--provider=".length), "--provider");
      continue;
    }

    if (value.startsWith("--aspect-ratio=")) {
      aspectRatio = requireOptionValue(value.slice("--aspect-ratio=".length), "--aspect-ratio");
      continue;
    }

    if (value.startsWith("--quality=")) {
      quality = parseQuality(requireOptionValue(value.slice("--quality=".length), "--quality"));
      continue;
    }

    if (value.startsWith("--seed=")) {
      seed = parseSeed(requireOptionValue(value.slice("--seed=".length), "--seed"));
      continue;
    }

    if (value.startsWith("--")) {
      throw new Error(`Unknown generate option: ${value}`);
    }

    promptParts.push(value);
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error("image-sdk generate requires a non-empty prompt.");
  }

  return {
    prompt,
    outputPath,
    options: {
      ...(provider === undefined ? {} : { provider }),
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      ...(quality === undefined ? {} : { quality }),
      ...(seed === undefined ? {} : { seed })
    }
  };
}

function requireOptionValue(value: string | undefined, option: string): string {
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function parseQuality(value: string): NonNullable<SimpleImageOptions["quality"]> {
  if (value === "draft" || value === "standard" || value === "high") {
    return value;
  }

  throw new Error("--quality must be draft, standard, or high.");
}

function parseSeed(value: string): number {
  const seed = Number(value);

  if (!Number.isInteger(seed)) {
    throw new Error("--seed must be an integer.");
  }

  return seed;
}

async function readGeneratedImage(result: ImageResult, requestFetch: typeof fetch | undefined): Promise<Uint8Array> {
  if (result.url.startsWith("data:")) {
    return decodeDataUrl(result.url);
  }

  const response = await requireFetch(requestFetch, "generate")(result.url);

  if (!response.ok) {
    throw await createHttpError(`The generated ${result.provider} image`, response);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function decodeDataUrl(url: string): Uint8Array {
  const delimiter = url.indexOf(",");

  if (delimiter < 0) {
    throw new Error("The SDK returned an invalid data URL.");
  }

  const metadata = url.slice(0, delimiter);
  const payload = url.slice(delimiter + 1);

  if (metadata.includes(";base64")) {
    return new Uint8Array(Buffer.from(payload, "base64"));
  }

  return new TextEncoder().encode(decodeURIComponent(payload));
}

function requireFetch(requestFetch: typeof fetch | undefined, command: "try" | "generate"): typeof fetch {
  if (!requestFetch) {
    throw new Error(`This runtime does not provide fetch, so image-sdk ${command} cannot request an image.`);
  }

  return requestFetch;
}

async function createHttpError(service: string, response: Response): Promise<Error> {
  let details = "";

  try {
    details = (await response.text()).trim();
  } catch {
    details = "";
  }

  return new Error(`${service} returned HTTP ${response.status}.${details ? ` ${details}` : ""}`);
}

function fileExtensionFor(contentType: string): string {
  if (contentType.includes("svg")) {
    return "svg";
  }

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
