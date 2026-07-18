import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ImageClient, ImageGenerationInput, ImageResult } from "@image-sdk/core";

export type McpRequestId = string | number | null;

export interface McpRequest {
  id: McpRequestId;
  method: "generate" | "getCapabilities" | "checkBudget";
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

  return {
    prompt: value.prompt,
    ...(typeof value.aspectRatio === "string" ? { aspectRatio: value.aspectRatio } : {}),
    ...(value.quality === "draft" || value.quality === "standard" || value.quality === "high" ? { quality: value.quality } : {}),
    ...(typeof value.seed === "number" ? { seed: value.seed } : {}),
    ...(value.strategy === "managed" || value.strategy === "async" ? { strategy: value.strategy } : {}),
    ...(typeof value.webhookUrl === "string" ? { webhookUrl: value.webhookUrl } : {})
  };
}

function parseProvider(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || (value.provider !== undefined && typeof value.provider !== "string")) {
    throw new McpInvalidRequestError("getCapabilities accepts an optional string params.provider.");
  }
  return value.provider;
}

function parseBudgetCheckInput(value: unknown): BudgetCheckInput {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new McpInvalidRequestError("checkBudget params must be an object.");
  }
  if (value.amount !== undefined && (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0)) {
    throw new McpInvalidRequestError("checkBudget params.amount must be a non-negative finite number.");
  }
  if (value.currency !== undefined && typeof value.currency !== "string") {
    throw new McpInvalidRequestError("checkBudget params.currency must be a string.");
  }
  if (value.scope !== undefined && typeof value.scope !== "string") {
    throw new McpInvalidRequestError("checkBudget params.scope must be a string.");
  }
  return value as BudgetCheckInput;
}

function isRequest(value: unknown): value is McpRequest {
  return isRecord(value) && "id" in value && typeof value.method === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
