import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { ChatImageAttachment } from "@/lib/agent/multimodal";
import {
  applyChatImageSignedUrls,
  buildChatImageStoragePath,
  collectOwnedChatImagePaths,
  getChatImagePreviewUrl,
  isOwnedChatImagePath,
  uploadChatImage,
} from "./image-storage";

describe("chat image storage", () => {
  it("builds user and session scoped object paths", () => {
    const path = buildChatImageStoragePath({
      userId: "user-1",
      sessionId: "session-1",
      imageId: "image-1",
      mediaType: "image/jpeg",
    });

    expect(path).toBe("user-1/session-1/image-1.jpg");
    expect(isOwnedChatImagePath(path, "user-1", "session-1")).toBe(true);
    expect(isOwnedChatImagePath(path, "user-2", "session-1")).toBe(false);
    expect(isOwnedChatImagePath("user-1/session-1/nested/image.jpg", "user-1", "session-1")).toBe(false);
  });

  it("uses inline data before a signed history URL", () => {
    const attachment: ChatImageAttachment = {
      id: "image-1",
      name: "chart.png",
      mediaType: "image/png",
      size: 5,
      dataUrl: "data:image/png;base64,aGVsbG8=",
      storagePath: "user-1/session-1/image-1.png",
      previewUrl: "https://signed.example/image-1.png",
    };

    expect(getChatImagePreviewUrl(attachment)).toBe(attachment.dataUrl);
  });

  it("hydrates and collects only owned persisted image paths", () => {
    const ownedPath = "user-1/session-1/image-1.png";
    const attachments = applyChatImageSignedUrls([{
      id: "image-1",
      name: "chart.png",
      mediaType: "image/png",
      size: 5,
      storagePath: ownedPath,
    }], new Map([[ownedPath, "https://signed.example/image-1.png"]]));

    expect(attachments[0].previewUrl).toBe("https://signed.example/image-1.png");
    expect(collectOwnedChatImagePaths([{
      metadata: {
        attachments: [
          { storagePath: ownedPath },
          { storagePath: ownedPath },
          { storagePath: "user-2/session-1/image-2.png" },
        ],
      },
    }], "user-1", "session-1")).toEqual([ownedPath]);
  });

  it("uploads with upsert so a timed-out image can be retried", async () => {
    const upload = vi.fn().mockResolvedValue({ data: { path: "image-1.png" }, error: null });
    const supabase = {
      storage: { from: vi.fn(() => ({ upload })) },
    } as unknown as SupabaseClient;
    const file = Object.assign(new Blob(["image"], { type: "image/png" }), {
      name: "chart.png",
    }) as File;

    const path = await uploadChatImage(supabase, {
      userId: "user-1",
      sessionId: "session-1",
      imageId: "image-1",
      mediaType: "image/png",
      file,
    });

    expect(path).toBe("user-1/session-1/image-1.png");
    expect(upload).toHaveBeenCalledWith(path, file, expect.objectContaining({ upsert: true }));
  });

  it("stops waiting when an upload exceeds its timeout", async () => {
    const upload = vi.fn(() => new Promise(() => undefined));
    const supabase = {
      storage: { from: vi.fn(() => ({ upload })) },
    } as unknown as SupabaseClient;
    const file = Object.assign(new Blob(["image"], { type: "image/png" }), {
      name: "chart.png",
    }) as File;

    await expect(uploadChatImage(supabase, {
      userId: "user-1",
      sessionId: "session-1",
      imageId: "image-1",
      mediaType: "image/png",
      file,
      timeoutMs: 5,
    })).rejects.toThrow("上传图片 chart.png 超时");
  });
});
