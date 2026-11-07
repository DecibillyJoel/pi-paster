import { describe, expect, test } from "vite-plus/test";
import { AttachmentStore, repairMissingImages } from "../src/index.ts";

function seededStore(): AttachmentStore {
  const store = new AttachmentStore();
  const attachment = store.add({ originalPath: "/tmp/a.png", mimeType: "image/png", data: "aaa" });
  attachment.optimized = true;
  return store;
}

describe("repairMissingImages", () => {
  test("appends the lost image to a queued user message", async () => {
    const messages = [{ role: "user", content: "queued [#image 1]" }];

    const repaired = await repairMissingImages(seededStore(), messages);

    expect(repaired?.[0]?.content).toEqual([
      { type: "text", text: "queued [#image 1]" },
      { type: "image", mimeType: "image/png", data: "aaa" },
    ]);
  });

  test("preserves the other fields of the repaired message", async () => {
    const messages = [{ role: "user", content: "queued [#image 1]", timestamp: 5 }];

    const repaired = await repairMissingImages(seededStore(), messages);

    expect(repaired?.[0]?.timestamp).toBe(5);
    expect(repaired?.[0]?.role).toBe("user");
  });

  test("keeps a message that already holds an image part", async () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "queued [#image 1]" },
          { type: "image", mimeType: "image/png", data: "aaa" },
        ],
      },
    ];

    expect(await repairMissingImages(seededStore(), messages)).toBeUndefined();
  });

  test("leaves a message without a placeholder alone", async () => {
    const messages = [{ role: "user", content: "hello" }];

    expect(await repairMissingImages(seededStore(), messages)).toBeUndefined();
  });

  test("leaves a non-user message alone", async () => {
    const messages = [{ role: "assistant", content: "see [#image 1]" }];

    expect(await repairMissingImages(seededStore(), messages)).toBeUndefined();
  });

  test("leaves a placeholder the store does not hold alone", async () => {
    const messages = [{ role: "user", content: "queued [#image 9]" }];

    expect(await repairMissingImages(seededStore(), messages)).toBeUndefined();
  });

  test("appends two images in placeholder order", async () => {
    const store = seededStore();
    const second = store.add({ originalPath: "/tmp/b.jpg", mimeType: "image/jpeg", data: "bbb" });
    second.optimized = true;
    const messages = [{ role: "user", content: "compare [#image 2] with [#image 1]" }];

    const repaired = await repairMissingImages(store, messages);

    expect(repaired?.[0]?.content).toEqual([
      { type: "text", text: "compare [#image 2] with [#image 1]" },
      { type: "image", mimeType: "image/jpeg", data: "bbb" },
      { type: "image", mimeType: "image/png", data: "aaa" },
    ]);
  });

  test("repairs only the affected message in a list", async () => {
    const untouched = { role: "user", content: "plain" };
    const messages = [{ role: "user", content: "queued [#image 1]" }, untouched];

    const repaired = await repairMissingImages(seededStore(), messages);

    expect(repaired?.length).toBe(2);
    expect(repaired?.[1]).toBe(untouched);
  });
});
