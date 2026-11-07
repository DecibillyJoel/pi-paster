import { describe, expect, test } from "vite-plus/test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { PasterEditor, segmentTextWithAtomicImages } from "../src/editor.ts";
import { AttachmentStore } from "../src/store.ts";

const IMAGE = {
  originalPath: "/tmp/a.png",
  mimeType: "image/png" as const,
  data: "",
};

const PASTE_KEY = "\u0016";

function createEditor(pasteClipboardImage: () => unknown) {
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { fallbackColor: (text: string) => text } as unknown as EditorTheme;
  const keybindings = {
    matches: (data: string, action: string) =>
      action === "app.clipboard.pasteImage" && data === PASTE_KEY,
  } as unknown as KeybindingsManager;
  const editor = new PasterEditor(tui, theme, keybindings, {
    cwd: "/tmp",
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
