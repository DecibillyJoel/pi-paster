import { describe, expect, test } from "vite-plus/test";
import { baseMimeType, selectPreferredImageType } from "../src/clipboard.ts";

describe("baseMimeType", () => {
  test("lowercases the type and drops its parameters", () => {
    expect(baseMimeType("IMAGE/PNG")).toBe("image/png");
    expect(baseMimeType("image/png;charset=binary")).toBe("image/png");
    expect(baseMimeType(" image/jpeg ")).toBe("image/jpeg");
  });
});

describe("selectPreferredImageType", () => {
  test("prefers PNG, then JPEG, then WebP, then GIF", () => {
    expect(selectPreferredImageType(["image/jpeg", "image/png"])).toBe("image/png");
    expect(selectPreferredImageType(["image/gif", "image/webp"])).toBe("image/webp");
    expect(selectPreferredImageType(["image/gif"])).toBe("image/gif");
  });

  test("returns the advertised string, not the normalized one", () => {
    expect(selectPreferredImageType(["IMAGE/PNG"])).toBe("IMAGE/PNG");
    expect(selectPreferredImageType(["image/png;charset=binary"])).toBe("image/png;charset=binary");
  });

  test("returns an image type the decoder may reject, so the caller reports it", () => {
    expect(selectPreferredImageType(["image/bmp", "text/plain"])).toBe("image/bmp");
    expect(selectPreferredImageType(["image/pjpeg"])).toBe("image/pjpeg");
  });

  test("returns null when the clipboard advertises no image type", () => {
    expect(selectPreferredImageType(["text/plain", "TARGETS", "UTF8_STRING"])).toBeNull();
    expect(selectPreferredImageType([])).toBeNull();
  });
});
