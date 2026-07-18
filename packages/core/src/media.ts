import { InvalidRequestError } from "./errors";
import type { ByteImageInput, ImageInput, NormalizedImageInput } from "./types";

export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function normalizeImageInput(input: ImageInput, name: "image" | "mask"): NormalizedImageInput {
  if (input instanceof Uint8Array) {
    return normalizeImageBytes(input, name);
  }

  if (typeof input !== "string" || !input.trim()) {
    throw new InvalidRequestError(`${capitalize(name)} must be a non-empty Uint8Array, data URL, base64 string, or HTTPS URL.`);
  }

  const value = input.trim();

  if (value.startsWith("https://")) {
    return { kind: "url", url: value };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("data:") && !value.startsWith("base64:")) {
    throw new InvalidRequestError(`${capitalize(name)} URLs must use HTTPS.`);
  }

  if (value.startsWith("data:")) {
    return parseDataUrl(value, name);
  }

  const base64 = value.startsWith("base64:") ? value.slice("base64:".length) : value;
  return normalizeImageBytes(decodeBase64(base64, name), name);
}

export function normalizeImageBytes(bytes: Uint8Array, name: "image" | "mask", declaredMimeType?: string): ByteImageInput {
  if (bytes.length === 0) {
    throw new InvalidRequestError(`${capitalize(name)} must not be empty.`);
  }

  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new InvalidRequestError(`${capitalize(name)} must not exceed 10 MiB.`);
  }

  const mimeType = detectImageMimeType(bytes);

  if (!mimeType) {
    throw new InvalidRequestError(`${capitalize(name)} must be a JPEG, PNG, or WebP image with a recognized binary signature.`);
  }

  if (declaredMimeType && normalizeMimeType(declaredMimeType) !== mimeType) {
    throw new InvalidRequestError(`${capitalize(name)} data does not match its declared ${declaredMimeType} media type.`);
  }

  return { kind: "bytes", bytes, mimeType };
}

export function detectImageMimeType(bytes: Uint8Array): ByteImageInput["mimeType"] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    text(bytes, 0, 4) === "RIFF" &&
    text(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}

function parseDataUrl(value: string, name: "image" | "mask"): ByteImageInput {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);

  if (!match) {
    throw new InvalidRequestError(`${capitalize(name)} data URLs must use base64 encoding.`);
  }

  const declaredMimeType = normalizeMimeType(match[1]);

  if (!SUPPORTED_IMAGE_MIME_TYPES.includes(declaredMimeType as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number])) {
    throw new InvalidRequestError(`${capitalize(name)} data URLs must declare JPEG, PNG, or WebP media.`);
  }

  return normalizeImageBytes(decodeBase64(match[2], name), name, declaredMimeType);
}

function decodeBase64(value: string, name: "image" | "mask"): Uint8Array {
  const compact = value.replace(/\s/g, "");

  if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new InvalidRequestError(`${capitalize(name)} contains malformed base64 data.`);
  }

  const nodeBuffer = (globalThis as unknown as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;

  if (nodeBuffer) {
    return new Uint8Array(nodeBuffer.from(compact, "base64"));
  }

  if (typeof atob !== "function") {
    throw new InvalidRequestError("A base64 decoder is required to read image input in this runtime.");
  }

  const binary = atob(compact);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
