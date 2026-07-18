import { describe, expect, it } from "vitest";
import { InvalidRequestError, normalizeImageInput } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PNG_BASE64 = "iVBORw0KGgoAAAAA";

describe("image media normalization", () => {
  it("accepts bytes, data URLs, raw base64, and HTTPS URLs", () => {
    expect(normalizeImageInput(PNG, "image")).toMatchObject({ kind: "bytes", mimeType: "image/png", bytes: PNG });
    expect(normalizeImageInput(`data:image/png;base64,${PNG_BASE64}`, "image")).toMatchObject({ kind: "bytes", mimeType: "image/png" });
    expect(normalizeImageInput(`base64:${PNG_BASE64}`, "image")).toMatchObject({ kind: "bytes", mimeType: "image/png" });
    expect(normalizeImageInput(PNG_BASE64, "image")).toMatchObject({ kind: "bytes", mimeType: "image/png" });
    expect(normalizeImageInput("https://images.example/source.png", "image")).toEqual({
      kind: "url",
      url: "https://images.example/source.png"
    });
  });

  it("rejects malformed, unsupported, and non-HTTPS inputs", () => {
    expect(() => normalizeImageInput("base64:not-base64!", "image")).toThrow(InvalidRequestError);
    expect(() => normalizeImageInput("data:image/svg+xml;base64,PHN2Zy8+", "image")).toThrow(InvalidRequestError);
    expect(() => normalizeImageInput("http://images.example/source.png", "image")).toThrow(InvalidRequestError);
    expect(() => normalizeImageInput(new Uint8Array([1, 2, 3]), "image")).toThrow(InvalidRequestError);
  });
});
