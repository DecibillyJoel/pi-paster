import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import paster, { PASTE_END, PASTE_START } from "../src/index.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  handlers: Map<string, Handler>;
}

type ContextResult = { messages?: Array<{ role?: string; content?: unknown }> } | undefined;

function makePi(): FakePi & ExtensionAPI {
  const handlers = new Map<string, Handler>();
  const pi = {
    handlers,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => {};
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage() {},
  };
  return pi as unknown as FakePi & ExtensionAPI;
}

function contextHandler(pi: FakePi): Handler {
  const handler = pi.handlers.get("context");
  if (!handler) throw new Error("context handler is not registered");
  return handler;
}

describe("paster context hook", () => {
  let dir: string;
  let shotPath: string;
  let pi: FakePi & ExtensionAPI;
  let ctx: ExtensionContext;
  let captured: ((data: string) => unknown) | undefined;

  function makeCtx(cwd: string): ExtensionContext {
    return {
      hasUI: true,
      cwd,
      ui: {
        onTerminalInput: (handler: (data: string) => unknown) => {
          captured = handler;
          return () => {};
        },
        setWidget() {},
        notify() {},
      },
    } as unknown as ExtensionContext;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paster-context-"));
    shotPath = join(dir, "shot.png");
    writeFileSync(shotPath, PNG_BYTES);
    pi = makePi();
    ctx = makeCtx(dir);
    paster(pi, { customEditor: { enabled: false } });
    pi.handlers.get("session_start")?.({ type: "session_start" }, ctx);
    captured?.(`${PASTE_START}${shotPath}${PASTE_END}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("registers a context handler", () => {
    expect(typeof pi.handlers.get("context")).toBe("function");
  });

  test("restores the image for a queued message that dropped it", async () => {
    const event = { type: "context", messages: [{ role: "user", content: "[#image 1]" }] };

    const result = (await contextHandler(pi)(event, ctx)) as ContextResult;

    expect(result?.messages?.[0]?.content).toEqual([
      { type: "text", text: "[#image 1]" },
      { type: "image", mimeType: "image/png", data: expect.any(String) },
    ]);
  });

  test("returns nothing when the message already holds its image", async () => {
    const withImage = {
      role: "user",
      content: [
        { type: "text", text: "[#image 1]" },
        { type: "image", mimeType: "image/png", data: "aaa" },
      ],
    };
    const event = { type: "context", messages: [withImage] };

    expect(await contextHandler(pi)(event, ctx)).toBeUndefined();
  });
});
