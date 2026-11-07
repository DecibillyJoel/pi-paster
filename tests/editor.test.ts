import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  PASTE_END,
  PASTE_START,
  PasterEditor,
  segmentTextWithAtomicImages,
} from "../src/editor.ts";
import { AttachmentStore } from "../src/store.ts";

const IMAGE = {
  originalPath: "/tmp/a.png",
  mimeType: "image/png" as const,
  data: "",
};

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const PASTE_KEY = "\u0016";

function createEditor(pasteClipboardImage: () => unknown, cwd = "/tmp") {
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { fallbackColor: (text: string) => text } as unknown as EditorTheme;
  const keybindings = {
    matches: (data: string, action: string) =>
      action === "app.clipboard.pasteImage" && data === PASTE_KEY,
  } as unknown as KeybindingsManager;
  const editor = new PasterEditor(tui, theme, keybindings, {
    cwd,
    store: new AttachmentStore(),
    notify() {},
    deletePlaceholderAsBlock: true,
    setCursorPreview() {},
    pasteClipboardImage: pasteClipboardImage as never,
  });
  editor.setText("");
  return editor;
}

/**
 * Mimics pi's editor wiring: the app installs its own paste handler, which
 * pastes file paths, then images, then plain text. It is installed only when
 * the extension left the slot empty.
 */
function wireAppPasteHandler(editor: PasterEditor, onPaste: () => void): void {
  if (!editor.onPasteImage) {
    editor.onPasteImage = onPaste;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("segmentTextWithAtomicImages", () => {
  test("treats adjacent image placeholders as separate atomic segments", () => {
    const store = new AttachmentStore();
    const first = store.add(IMAGE);
    const second = store.add({ ...IMAGE, originalPath: "/tmp/b.png" });

    const segments = segmentTextWithAtomicImages(
      `${first.placeholder}${second.placeholder}`,
      store,
    );

    expect(segments.map((segment) => segment.segment)).toEqual([
      first.placeholder,
      second.placeholder,
    ]);
    expect(segments.map((segment) => segment.index)).toEqual([0, first.placeholder.length]);
  });

  test("makes image-looking placeholders atomic even before preview lookup", () => {
    const store = new AttachmentStore();
    const attachment = store.add(IMAGE);

    const segments = segmentTextWithAtomicImages(
      `x${attachment.placeholder} [#image 99]`,
      store,
    ).map((segment) => segment.segment);

    expect(segments).toContain(attachment.placeholder);
    expect(segments).toContain("[#image 99]");
  });

  test("preserves existing paste marker atomicity when ids are valid", () => {
    const store = new AttachmentStore();
    const segments = segmentTextWithAtomicImages("a[paste #1 +61 lines]b", store, new Set([1]));

    expect(segments.map((segment) => segment.segment)).toEqual(["a", "[paste #1 +61 lines]", "b"]);
  });
});

describe("PasterEditor paste key", () => {
  test("hands a clipboard without an image to the app paste handler", async () => {
    const editor = createEditor(() => undefined);
    let appPasteCalls = 0;
    wireAppPasteHandler(editor, () => {
      appPasteCalls += 1;
      editor.insertTextAtCursor("plain text");
    });

    editor.handleInput(PASTE_KEY);
    await flush();

    expect(appPasteCalls).toBe(1);
    expect(editor.getText()).toBe("plain text");
  });

  test("attaches a clipboard image without the app paste handler", async () => {
    const editor = createEditor(() => ({ ...IMAGE, id: 1, placeholder: "[#image 1]" }));
    let appPasteCalls = 0;
    wireAppPasteHandler(editor, () => {
      appPasteCalls += 1;
    });

    editor.handleInput(PASTE_KEY);
    await flush();

    expect(appPasteCalls).toBe(0);
    expect(editor.getText()).toBe("[#image 1]");
  });
});

describe("PasterEditor terminal paste", () => {
  let dir: string;
  let imagePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paster-bracketed-"));
    imagePath = join(dir, "shot.png");
    writeFileSync(imagePath, PNG_BYTES);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("turns a pasted image path into an attachment", () => {
    const editor = createEditor(() => undefined, dir);

    editor.handleInput(`${PASTE_START}${imagePath}${PASTE_END}`);

    expect(editor.getText()).toBe("[#image 1]");
  });

  test("turns a pasted local file URI into an attachment", () => {
    const editor = createEditor(() => undefined, dir);

    editor.handleInput(`${PASTE_START}${pathToFileURL(imagePath).href}${PASTE_END}`);

    expect(editor.getText()).toBe("[#image 1]");
  });

  test("keeps pasted text that names no image", () => {
    const editor = createEditor(() => undefined, dir);

    editor.handleInput(`${PASTE_START}hello world${PASTE_END}`);

    expect(editor.getText()).toBe("hello world");
  });
});
