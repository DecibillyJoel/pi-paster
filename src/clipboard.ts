import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectImageMimeType, dimensionsForImage } from "./image-utils.ts";
import { MAX_IMAGE_BYTES, type LoadedImage, type SupportedImageMimeType } from "./types.ts";

export type ClipboardImageResult =
  | { ok: true; image: LoadedImage }
  | {
      ok: false;
      reason:
        | "empty"
        | "unsupported-platform"
        | "no-clipboard-tool"
        | "too-large"
        | "unsupported"
        | "read-error";
    };

export function readClipboardImage(maxBytes = MAX_IMAGE_BYTES): ClipboardImageResult {
  if (process.platform === "darwin") return readMacOSClipboardImage(maxBytes);
  if (process.platform === "win32") return readWindowsClipboardImage(maxBytes);
  if (process.platform === "linux") {
    if (isWSL()) return readWindowsClipboardImage(maxBytes);
    return readLinuxClipboardImage(maxBytes);
  }
  return { ok: false, reason: "unsupported-platform" };
}

function isWSL(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function resolvePowerShell(): string | null {
  if (process.platform === "win32") return "powershell.exe";
  const candidates = [
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "powershell.exe";
}

function readWindowsClipboardImage(maxBytes: number): ClipboardImageResult {
  const exe = resolvePowerShell();
  if (!exe) return { ok: false, reason: "unsupported-platform" };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "Add-Type -AssemblyName System.Drawing | Out-Null",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img -eq $null) { exit 2 }",
    "$ms = New-Object System.IO.MemoryStream",
    "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
  ].join("; ");

  try {
    const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
      timeout: 5000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 2) return { ok: false, reason: "empty" };
    if (result.status !== 0) return { ok: false, reason: "read-error" };

    const data = (result.stdout || "").trim();
    if (!data) return { ok: false, reason: "empty" };

    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };

    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) return { ok: false, reason: "unsupported" };

    return {
      ok: true,
      image: {
        originalPath: "clipboard.png",
        mimeType,
        data,
        dimensions: dimensionsForImage(data, mimeType),
      },
    };
  } catch {
    return { ok: false, reason: "read-error" };
  }
}

function readMacOSClipboardImage(maxBytes: number): ClipboardImageResult {
  const attempts = [
    { appleScriptClass: "PNGf", extension: "png" },
    { appleScriptClass: "JPEG", extension: "jpg" },
  ];

  for (const attempt of attempts) {
    const tmpFile = join(tmpdir(), `paster-clipboard-${randomUUID()}.${attempt.extension}`);
    try {
      const result = spawnSync(
        "osascript",
        [
          "-e",
          `set imageData to the clipboard as «class ${attempt.appleScriptClass}»`,
          "-e",
          `set outputFile to open for access POSIX file ${JSON.stringify(tmpFile)} with write permission`,
          "-e",
          "set eof of outputFile to 0",
          "-e",
          "write imageData to outputFile",
          "-e",
          "close access outputFile",
        ],
        { timeout: 3000, stdio: "ignore" },
      );
      if (result.status !== 0) continue;

      const bytes = readFileSync(tmpFile);
      if (bytes.length === 0) continue;
      if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };

      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) continue;

      const data = bytes.toString("base64");
      return {
        ok: true,
        image: {
          originalPath: `clipboard.${attempt.extension}`,
          mimeType,
          data,
          dimensions: dimensionsForImage(data, mimeType),
        },
      };
    } catch {
      return { ok: false, reason: "read-error" };
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  return { ok: false, reason: "empty" };
}

// Linux clipboard support. The backend order matches the one pi itself uses:
// Wayland first (wl-paste), then X11 (xclip). The first backend that answers
// owns the clipboard, so an empty or failed Wayland clipboard never falls
// through to stale X11 contents.

const LINUX_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const IMAGE_EXTENSION_BY_MIME: Record<SupportedImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const CLIPBOARD_LIST_TIMEOUT_MS = 3000;
const CLIPBOARD_READ_TIMEOUT_MS = 5000;

interface LinuxClipboardBackend {
  command: string;
  listArgs: string[];
  readArgs: (type: string) => string[];
}

const LINUX_CLIPBOARD_BACKENDS: LinuxClipboardBackend[] = [
  {
    command: "wl-paste",
    listArgs: ["--list-types"],
    readArgs: (type) => ["--type", type, "--no-newline"],
  },
  {
    command: "xclip",
    listArgs: ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    readArgs: (type) => ["-selection", "clipboard", "-t", type, "-o"],
  },
];

export function baseMimeType(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

/**
 * List the target types the clipboard advertises. Returns null when the tool
 * is missing or failed, which lets the caller try the next backend.
 */
function listClipboardTypes(command: string, args: string[]): string[] | null {
  try {
    const result = spawnSync(command, args, {
      timeout: CLIPBOARD_LIST_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    if (error?.code === "ENOENT") return null;
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function selectPreferredImageType(types: string[]): string | null {
  const normalized = types.map((type) => ({ raw: type, base: baseMimeType(type) }));
  for (const preferred of LINUX_IMAGE_MIME_TYPES) {
    const match = normalized.find((type) => type.base === preferred);
    if (match) return match.raw;
  }
  return normalized.find((type) => type.base.startsWith("image/"))?.raw ?? null;
}

type ClipboardReadOutcome =
  | { kind: "image"; image: LoadedImage }
  | { kind: "empty" }
  | { kind: "too-large" }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

function readClipboardType(
  command: string,
  args: string[],
  maxBytes: number,
): ClipboardReadOutcome {
  try {
    const result = spawnSync(command, args, {
      timeout: CLIPBOARD_READ_TIMEOUT_MS,
      maxBuffer: maxBytes + 1024 * 1024,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    if (error?.code === "ENOENT") return { kind: "unavailable" };
    if (error?.code === "ENOBUFS") return { kind: "too-large" };
    if (result.status !== 0) return { kind: "unavailable" };

    const bytes: Buffer = result.stdout ?? Buffer.alloc(0);
    if (bytes.length === 0) return { kind: "empty" };
    if (bytes.length > maxBytes) return { kind: "too-large" };

    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) return { kind: "unsupported" };

    const data = bytes.toString("base64");
    return {
      kind: "image",
      image: {
        originalPath: `clipboard.${IMAGE_EXTENSION_BY_MIME[mimeType]}`,
        mimeType,
        data,
        dimensions: dimensionsForImage(data, mimeType),
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function readLinuxClipboardImage(maxBytes: number): ClipboardImageResult {
  let sawBackend = false;

  for (const backend of LINUX_CLIPBOARD_BACKENDS) {
    const types = listClipboardTypes(backend.command, backend.listArgs);
    if (!types) continue;
    sawBackend = true;

    const type = selectPreferredImageType(types);
    // The backend answered, so it owns the clipboard. Stop here instead of
    // reading a stale image from the next backend.
    if (!type) break;

    const outcome = readClipboardType(backend.command, backend.readArgs(type), maxBytes);
    if (outcome.kind === "image") return { ok: true, image: outcome.image };
    // The backend answered the type list, so it owns the clipboard. A failed
    // read must not fall through to a stale image in the next backend.
    if (outcome.kind === "unavailable") return { ok: false, reason: "read-error" };
    return { ok: false, reason: outcome.kind };
  }

  return { ok: false, reason: sawBackend ? "empty" : "no-clipboard-tool" };
}
