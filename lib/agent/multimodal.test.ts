import { describe, expect, it } from "vitest";
import {
  buildMultimodalUserContent,
  stripInlineImagesForPersistence,
  validateImageAttachments,
} from "./multimodal";

const dataUrl = "data:image/png;base64,aGVsbG8=";

describe("DeepSeek multimodal messages", () => {
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
});
