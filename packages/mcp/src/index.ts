import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ImageClient, ImageGenerationInput, ImageResult } from "@image-sdk/core";

export type McpRequestId = string | number | null;
export type JsonSchema = Record<string, unknown>;

export interface McpRequest {
  id: McpRequestId;
  method: "generate" | "getCapabilities" | "checkBudget" | "listTools";
  params?: unknown;
}

export interface McpError {
  code: "INVALID_REQUEST" | "METHOD_NOT_FOUND" | "METHOD_UNAVAILABLE" | "INTERNAL_ERROR";
  message: string;
}

export interface McpResponse {
  id: McpRequestId;
  result?: unknown;
  error?: McpError;
}

export interface BudgetCheckInput {
  amount?: number;
  currency?: string;
  scope?: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  remaining?: number;
  currency?: string;
  reason?: string;
}

export interface BudgetAwareImageClient extends ImageClient {
  checkBudget?(input: BudgetCheckInput): Promise<BudgetCheckResult> | BudgetCheckResult;
}

export interface ImageMcpServerOptions {
  client: BudgetAwareImageClient;
}

export interface StdioServerOptions extends ImageMcpServerOptions {
  input: Readable;
  output: Writable;
}

export interface McpToolDefinition {
  name: "generate" | "getCapabilities" | "checkBudget";
  description: string;
  inputSchema: JsonSchema;
}

const imageCostSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "currency", "estimated"],
  properties: {
    amount: { type: "number", minimum: 0 },
    currency: { type: "string", minLength: 1 },
    estimated: { type: "boolean" }
  }
} satisfies JsonSchema;

const retrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    retries: { type: "integer", minimum: 0 },
    backoff: { type: "string", enum: ["exponential"] },
    initialDelayMs: { type: "number", minimum: 0 },
    maxDelayMs: { type: "number", minimum: 0 }
  }
} satisfies JsonSchema;

const resolutionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["width", "height"],
  properties: {
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 }
  }
} satisfies JsonSchema;

export const imageMcpToolDefinitions: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "generate",
    description: "Generate an image with Image SDK using the same request fields accepted by the core client.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        provider: { type: "string", minLength: 1 },
        fallback: {
          oneOf: [
            { type: "boolean" },
            { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
          ]
        },
        maxCostPerCall: imageCostSchema,
        aspectRatio: { type: "string", minLength: 1 },
        quality: { type: "string", enum: ["draft", "standard", "high"] },
        seed: { type: "integer" },
        mode: { type: "string", enum: ["text-to-image", "image-to-image", "inpainting"] },
        strategy: { type: "string", enum: ["managed", "async"] },
        webhookUrl: { type: "string", format: "uri" },
        image: { type: "string", minLength: 1 },
        mask: { type: "string", minLength: 1 },
        strength: { type: "number", minimum: 0, maximum: 1 },
        resolution: resolutionSchema,
        retry: retrySchema
      }
    }
  },
  {
    name: "getCapabilities",
    description: "Return configured Image SDK provider capabilities.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "checkBudget",
    description: "Ask the injected client whether a budgeted operation is allowed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        amount: { type: "number", minimum: 0 },
        currency: { type: "string", minLength: 1 },
        scope: { type: "string", minLength: 1 }
      }
    }
  }
]);

export function getImageMcpToolDefinitions(): readonly McpToolDefinition[] {
  return imageMcpToolDefinitions;
}

export class ImageMcpServer {
  private readonly client: BudgetAwareImageClient;

  constructor(options: ImageMcpServerOptions) {
    this.client = options.client;
  }

  async handle(request: unknown): Promise<McpResponse> {
    if (!isRequest(request)) {
      return failure(null, "INVALID_REQUEST", "Each JSON-line message must provide an id and a supported method.");
    }

    try {
      switch (request.method) {
        case "generate":
          return { id: request.id, result: await this.generate(request.params) };
        case "getCapabilities":
          return { id: request.id, result: await this.getCapabilities(request.params) };
        case "checkBudget":
          return { id: request.id, result: await this.checkBudget(request.params) };
        case "listTools":
          return { id: request.id, result: imageMcpToolDefinitions };
        default:
          return failure(request.id, "METHOD_NOT_FOUND", `Unsupported MCP method: ${String(request.method)}.`);
      }
    } catch (error) {
      return failure(request.id, "INTERNAL_ERROR", error instanceof Error ? error.message : "Image SDK operation failed.");
    }
  }

  private async generate(params: unknown): Promise<{ job: ReturnType<Awaited<ReturnType<ImageClient["generate"]>>["toJSON"]>; image: ImageResult }> {
    const input = parseGenerateInput(params);
    const job = await this.client.generate(input);
    const image = await job.result();
    return { job: job.toJSON(), image };
  }

  private async getCapabilities(params: unknown): Promise<unknown> {
    const provider = parseProvider(params);
    return provider ? this.client.capabilities(provider) : this.client.capabilities();
  }

  private async checkBudget(params: unknown): Promise<BudgetCheckResult> {
    if (!this.client.checkBudget) {
      throw new McpMethodUnavailableError("The injected ImageClient does not expose budget checks.");
    }

    return this.client.checkBudget(parseBudgetCheckInput(params));
  }
}

export async function runStdioServer(options: StdioServerOptions): Promise<void> {
  const server = new ImageMcpServer(options);
  const reader = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const line of reader) {
    const response = await server.handle(parseJsonLine(line));
    await writeLine(options.output, response);
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as McpRequest;
  } catch {
    return { id: null };
  }
}

function parseGenerateInput(value: unknown): ImageGenerationInput {
  if (!isRecord(value) || typeof value.prompt !== "string") {
    throw new McpInvalidRequestError("generate requires params.prompt as a string.");
  }

  rejectUnknownKeys(value, new Set([
    "prompt",
    "provider",
    "fallback",
    "maxCostPerCall",
    "aspectRatio",
    "quality",
    "seed",
    "mode",
    "strategy",
    "webhookUrl",
    "image",
    "mask",
    "strength",
    "resolution",
    "retry"
  ]), "generate");

  const input: ImageGenerationInput = { prompt: requiredString(value.prompt, "generate params.prompt") };
  if (value.provider !== undefined) input.provider = requiredString(value.provider, "generate params.provider");
  if (value.aspectRatio !== undefined) input.aspectRatio = requiredString(value.aspectRatio, "generate params.aspectRatio");
  if (value.quality !== undefined) input.quality = enumValue(value.quality, ["draft", "standard", "high"] as const, "generate params.quality");
  if (value.seed !== undefined) input.seed = integerValue(value.seed, "generate params.seed");
  if (value.mode !== undefined) input.mode = enumValue(value.mode, ["text-to-image", "image-to-image", "inpainting"] as const, "generate params.mode");
  if (value.strategy !== undefined) input.strategy = enumValue(value.strategy, ["managed", "async"] as const, "generate params.strategy");
  if (value.webhookUrl !== undefined) input.webhookUrl = urlString(value.webhookUrl, "generate params.webhookUrl");
  if (value.image !== undefined) input.image = requiredString(value.image, "generate params.image");
  if (value.mask !== undefined) input.mask = requiredString(value.mask, "generate params.mask");
  if (value.strength !== undefined) input.strength = numberInRange(value.strength, 0, 1, "generate params.strength");
  if (value.resolution !== undefined) input.resolution = parseResolution(value.resolution);
  if (value.retry !== undefined) input.retry = parseRetry(value.retry);
  if (value.fallback !== undefined) input.fallback = parseFallback(value.fallback);
  if (value.maxCostPerCall !== undefined) input.maxCostPerCall = parseImageCost(value.maxCostPerCall, "generate params.maxCostPerCall");
  return input;
}

function parseProvider(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || (value.provider !== undefined && typeof value.provider !== "string")) {
    throw new McpInvalidRequestError("getCapabilities accepts an optional string params.provider.");
  }
  rejectUnknownKeys(value, new Set(["provider"]), "getCapabilities");
  return value.provider === undefined ? undefined : requiredString(value.provider, "getCapabilities params.provider");
}

function parseBudgetCheckInput(value: unknown): BudgetCheckInput {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new McpInvalidRequestError("checkBudget params must be an object.");
  }
  rejectUnknownKeys(value, new Set(["amount", "currency", "scope"]), "checkBudget");
  if (value.amount !== undefined && (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0)) {
    throw new McpInvalidRequestError("checkBudget params.amount must be a non-negative finite number.");
  }
  if (value.currency !== undefined) {
    requiredString(value.currency, "checkBudget params.currency");
  }
  if (value.scope !== undefined) {
    requiredString(value.scope, "checkBudget params.scope");
  }
  return value as BudgetCheckInput;
}

function isRequest(value: unknown): value is McpRequest {
  return isRecord(value) && "id" in value && typeof value.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, method: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new McpInvalidRequestError(`${method} params.${key} is not a supported parameter.`);
    }
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpInvalidRequestError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new McpInvalidRequestError(`${name} must be one of: ${allowed.join(", ")}.`);
}

function integerValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new McpInvalidRequestError(`${name} must be an integer.`);
  }
  return value;
}

function numberInRange(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new McpInvalidRequestError(`${name} must be a finite number from ${min} through ${max}.`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new McpInvalidRequestError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function urlString(value: unknown, name: string): string {
  const url = requiredString(value, name);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new McpInvalidRequestError(`${name} must be an http or https URL.`);
  }
  return url;
}

function parseResolution(value: unknown): NonNullable<ImageGenerationInput["resolution"]> {
  if (!isRecord(value)) {
    throw new McpInvalidRequestError("generate params.resolution must be an object.");
  }
  rejectUnknownKeys(value, new Set(["width", "height"]), "generate params.resolution");
  const width = integerValue(value.width, "generate params.resolution.width");
  const height = integerValue(value.height, "generate params.resolution.height");
  if (width < 1 || height < 1) {
    throw new McpInvalidRequestError("generate params.resolution width and height must be positive integers.");
  }
  return { width, height };
}

function parseRetry(value: unknown): NonNullable<ImageGenerationInput["retry"]> {
  if (!isRecord(value)) {
    throw new McpInvalidRequestError("generate params.retry must be an object.");
  }
  rejectUnknownKeys(value, new Set(["retries", "backoff", "initialDelayMs", "maxDelayMs"]), "generate params.retry");
  const retry: NonNullable<ImageGenerationInput["retry"]> = {};
  if (value.retries !== undefined) retry.retries = integerValue(value.retries, "generate params.retry.retries");
  if (retry.retries !== undefined && retry.retries < 0) {
    throw new McpInvalidRequestError("generate params.retry.retries must be a non-negative integer.");
  }
  if (value.backoff !== undefined) retry.backoff = enumValue(value.backoff, ["exponential"] as const, "generate params.retry.backoff");
  if (value.initialDelayMs !== undefined) retry.initialDelayMs = nonNegativeNumber(value.initialDelayMs, "generate params.retry.initialDelayMs");
  if (value.maxDelayMs !== undefined) retry.maxDelayMs = nonNegativeNumber(value.maxDelayMs, "generate params.retry.maxDelayMs");
  if (retry.initialDelayMs !== undefined && retry.maxDelayMs !== undefined && retry.maxDelayMs < retry.initialDelayMs) {
    throw new McpInvalidRequestError("generate params.retry.maxDelayMs must be greater than or equal to initialDelayMs.");
  }
  return retry;
}

function parseFallback(value: unknown): NonNullable<ImageGenerationInput["fallback"]> {
  if (typeof value === "boolean") {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpInvalidRequestError("generate params.fallback must be a boolean or a non-empty provider array.");
  }
  return value.map((provider, index) => requiredString(provider, `generate params.fallback[${index}]`));
}

function parseImageCost(value: unknown, name: string): NonNullable<ImageGenerationInput["maxCostPerCall"]> {
  if (!isRecord(value)) {
    throw new McpInvalidRequestError(`${name} must be an object.`);
  }
  rejectUnknownKeys(value, new Set(["amount", "currency", "estimated"]), name);
  return {
    amount: nonNegativeNumber(value.amount, `${name}.amount`),
    currency: requiredString(value.currency, `${name}.currency`).toUpperCase(),
    estimated: booleanValue(value.estimated, `${name}.estimated`)
  };
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new McpInvalidRequestError(`${name} must be a boolean.`);
  }
  return value;
}

function failure(id: McpRequestId, code: McpError["code"], message: string): McpResponse {
  if (code === "INTERNAL_ERROR" && message.startsWith("MCP_METHOD_UNAVAILABLE:")) {
    return { id, error: { code: "METHOD_UNAVAILABLE", message: message.slice("MCP_METHOD_UNAVAILABLE:".length) } };
  }
  if (code === "INTERNAL_ERROR" && message.startsWith("MCP_INVALID_REQUEST:")) {
    return { id, error: { code: "INVALID_REQUEST", message: message.slice("MCP_INVALID_REQUEST:".length) } };
  }
  return { id, error: { code, message } };
}

class McpMethodUnavailableError extends Error {
  constructor(message: string) {
    super(`MCP_METHOD_UNAVAILABLE:${message}`);
  }
}

class McpInvalidRequestError extends Error {
  constructor(message: string) {
    super(`MCP_INVALID_REQUEST:${message}`);
  }
}

async function writeLine(output: Writable, response: McpResponse): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  if (output.write(line)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}
