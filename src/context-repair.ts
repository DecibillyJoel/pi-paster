import { imagesForTextOptimized } from "./image-utils.ts";
import type { AttachmentStore } from "./store.ts";

export interface RepairableMessage {
  role?: string;
  content?: unknown;
}

interface MessagePart {
  type?: string;
  text?: string;
}

function textOfContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content as MessagePart[];
  if (!parts.some((part) => part.type === "text")) return undefined;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function hasImagePart(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as MessagePart[]).some((part) => part.type === "image");
}

async function repairMessage<T extends RepairableMessage>(
  store: AttachmentStore,
  message: T,
): Promise<T | undefined> {
  if (message.role !== "user") return undefined;
  const text = textOfContent(message.content);
  if (text === undefined) return undefined;
  if (hasImagePart(message.content)) return undefined;
  if (store.matchingPlaceholders(text).length === 0) return undefined;
  const images = await imagesForTextOptimized(store, text, []);
  if (images.length === 0) return undefined;
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text }, ...images]
      : [...(message.content as MessagePart[]), ...images];
  return { ...message, content } as T;
}

/**
 * Put a lost image part back into a user message. A queued (mid-turn)
 * submission can reach the transcript without its image, and the transcript is
 * not rewritten, so the repair is repeated for every request that carries the
 * placeholder text.
 */
export async function repairMissingImages<T extends RepairableMessage>(
  store: AttachmentStore,
  messages: readonly T[],
): Promise<T[] | undefined> {
  const repaired: T[] = [];
  let changed = false;
  for (const message of messages) {
    const next = await repairMessage(store, message);
    if (next === undefined) {
      repaired.push(message);
      continue;
    }
    changed = true;
    repaired.push(next);
  }
  return changed ? repaired : undefined;
}
