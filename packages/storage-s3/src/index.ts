export interface ObjectStoragePutRequest {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
}

/**
 * A deliberately small transport seam. Implement it with an AWS SDK client,
 * an R2 binding, or a signed HTTP request in the host application.
 */
export interface ObjectStorageClient {
  putObject(request: ObjectStoragePutRequest): Promise<void>;
}

export interface ImageStoragePutRequest {
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
}

export interface StoredImage {
  url: string;
  expiresAt?: string;
}

/** Structural contract accepted by @image-sdk/production. */
export interface ImageStorage {
  put(request: ImageStoragePutRequest): Promise<StoredImage>;
}

export interface S3CompatibleStorageOptions {
  client: ObjectStorageClient;
  bucket: string;
  /** Public origin for returned durable URLs, for example https://cdn.example.com. */
  publicUrl?: string;
  /** Endpoint used to construct a path-style URL when publicUrl is absent. */
  endpoint?: string;
  prefix?: string;
  cacheControl?: string;
}

export interface R2StorageOptions extends S3CompatibleStorageOptions {
  /** Kept for application-level clarity; R2 uses the same S3-compatible transport seam. */
  accountId?: string;
}

export function s3Storage(options: S3CompatibleStorageOptions): ImageStorage {
  return createStorage(options);
}

export function r2Storage(options: R2StorageOptions): ImageStorage {
  return createStorage(options);
}

function createStorage(options: S3CompatibleStorageOptions): ImageStorage {
  const bucket = nonEmpty(options.bucket, "bucket");
  const prefix = normalizePrefix(options.prefix);
  const publicUrl = options.publicUrl ? normalizeOrigin(options.publicUrl, "publicUrl") : undefined;
  const endpoint = options.endpoint ? normalizeOrigin(options.endpoint, "endpoint") : undefined;

  if (!publicUrl && !endpoint) {
    throw new TypeError("S3-compatible storage requires either publicUrl or endpoint.");
  }

  return {
    async put(request): Promise<StoredImage> {
      const key = joinKey(prefix, request.key);
      if (request.body.byteLength === 0) {
        throw new TypeError("Storage cannot upload an empty image body.");
      }

      await options.client.putObject({
        bucket,
        key,
        body: request.body,
        contentType: nonEmpty(request.contentType, "contentType"),
        ...(request.cacheControl ?? options.cacheControl ? { cacheControl: request.cacheControl ?? options.cacheControl } : {})
      });

      return { url: publicUrl ? `${publicUrl}/${key}` : `${endpoint}/${bucket}/${key}` };
    }
  };
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`S3-compatible storage requires a non-empty ${name}.`);
  }
  return normalized;
}

function normalizeOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${name} must use http or https.`);
  }
  return url.toString().replace(/\/$/, "");
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }

  return validateKey(prefix).replace(/\/$/, "");
}

function joinKey(prefix: string, key: string): string {
  const normalizedKey = validateKey(key);
  return prefix ? `${prefix}/${normalizedKey}` : normalizedKey;
}

function validateKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new TypeError("Storage keys must be non-empty relative paths without traversal segments.");
  }
  return normalized;
}
