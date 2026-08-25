import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_COUNT,
  MAX_SINGLE_IMAGE_BYTES,
  buildMultimodalUserContent,
  stripInlineImagesForPersistence,
  toPersistedImageAttachment,
  validateImageAttachments,
} from "./multimodal";

const dataUrl = "data:image/png;base64,aGVsbG8=";

describe("DeepSeek multimodal messages", () => {
  it("limits one request to ten images and each image to five MiB", () => {
    expect(MAX_IMAGE_COUNT).toBe(10);
    expect(MAX_SINGLE_IMAGE_BYTES).toBe(5 * 1024 * 1024);

    const result = validateImageAttachments(Array.from(
      { length: MAX_IMAGE_COUNT + 1 },
      (_, index) => ({
        id: `image-${index}`,
        name: `image-${index}.png`,
        mediaType: "image/png",
        size: 5,
        dataUrl,
      }),
    ));
    expect(result.error).toBe("每次最多上传 10 张图片");

    const oversizedBase64Length = Math.ceil((MAX_SINGLE_IMAGE_BYTES + 1) / 3) * 4;
    const oversized = validateImageAttachments([{
      id: "image-large",
      name: "large.png",
      mediaType: "image/png",
      size: MAX_SINGLE_IMAGE_BYTES + 1,
      dataUrl: `data:image/png;base64,${"A".repeat(oversizedBase64Length)}`,
    }]);
    expect(oversized.error).toBe("图片 large.png 超过 5 MiB");
  });

  it("validates inline image attachments and builds image blocks", () => {
    const result = validateImageAttachments([{
      id: "image-1",
      name: "chart.png",
      mediaType: "image/png",
      size: 999,
      dataUrl,
    }]);

    expect(result.error).toBeUndefined();
    expect(result.attachments[0].size).toBe(5);
    expect(buildMultimodalUserContent("分析图表", result.attachments)).toEqual([
      { type: "text", text: "分析图表" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        name: "chart.png",
      },
    ]);
  });

  it("rejects a media type that DeepSeek Vision does not support", () => {
    const result = validateImageAttachments([{
      id: "image-1",
      name: "vector.svg",
      mediaType: "image/svg+xml",
      size: 10,
      dataUrl: "data:image/svg+xml;base64,aGVsbG8=",
    }]);

    expect(result.error).toContain("缺少有效");
  });

  it("removes base64 image data before context persistence", () => {
    const messages = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "分析图片" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          name: "chart.png",
        },
      ],
    }] as never;

    const persistent = stripInlineImagesForPersistence(messages);
    expect(JSON.stringify(persistent)).not.toContain("aGVsbG8=");
    expect(JSON.stringify(persistent)).toContain("图片附件已处理：chart.png");
  });

  it("persists storage identity without temporary image URLs", () => {
    expect(toPersistedImageAttachment({
      id: "image-1",
      name: "chart.png",
      mediaType: "image/png",
      size: 5,
      storagePath: "user-1/session-1/image-1.png",
      dataUrl,
      previewUrl: "https://signed.example/image-1.png",
    })).toEqual({
      id: "image-1",
      name: "chart.png",
      mediaType: "image/png",
      size: 5,
      storagePath: "user-1/session-1/image-1.png",
    });
  });
});
