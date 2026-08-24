import type Anthropic from "@anthropic-ai/sdk";

export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMediaType = typeof SUPPORTED_IMAGE_MEDIA_TYPES[number];

export type ChatImageAttachment = {
  id: string;
  name: string;
  mediaType: SupportedImageMediaType;
  size: number;
  dataUrl?: string;
};

export type InlineImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: SupportedImageMediaType;
    data: string;
  };
  name?: string;
};

export const MAX_IMAGE_COUNT = 10;
export const MAX_SINGLE_IMAGE_BYTES = 32 * 1024 * 1024;
// Base64 expands by about 4/3; 32 MiB stays below DeepSeek's 48 MiB body limit.
export const MAX_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;

const supportedMediaTypes = new Set<string>(SUPPORTED_IMAGE_MEDIA_TYPES);

function decodedBase64Bytes(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function parseDataUrl(value: string, mediaType: SupportedImageMediaType) {
  const prefix = `data:${mediaType};base64,`;
  if (!value.startsWith(prefix)) return null;
  const data = value.slice(prefix.length);
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return null;
  }
  return { data, size: decodedBase64Bytes(data) };
}

export function validateImageAttachments(value: unknown): {
  attachments: Required<ChatImageAttachment>[];
  error?: string;
} {
  if (value === undefined) return { attachments: [] };
  if (!Array.isArray(value)) return { attachments: [], error: "attachments 必须是数组" };
  if (value.length > MAX_IMAGE_COUNT) {
    return { attachments: [], error: `每次最多上传 ${MAX_IMAGE_COUNT} 张图片` };
  }

  const attachments: Required<ChatImageAttachment>[] = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { attachments: [], error: "图片附件格式错误" };
    }
    const attachment = item as Record<string, unknown>;
    const mediaType = attachment.mediaType;
    const dataUrl = attachment.dataUrl;
    if (
      typeof attachment.id !== "string"
      || typeof attachment.name !== "string"
      || typeof mediaType !== "string"
      || !supportedMediaTypes.has(mediaType)
      || typeof dataUrl !== "string"
    ) {
      return { attachments: [], error: "图片附件缺少有效的名称、类型或内容" };
    }
    const parsed = parseDataUrl(dataUrl, mediaType as SupportedImageMediaType);
    if (!parsed) return { attachments: [], error: `图片 ${attachment.name} 的编码无效` };
    if (parsed.size > MAX_SINGLE_IMAGE_BYTES) {
      return { attachments: [], error: `图片 ${attachment.name} 超过 32 MiB` };
    }
    totalBytes += parsed.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { attachments: [], error: "图片总大小不能超过 32 MiB" };
    }
    attachments.push({
      id: attachment.id,
      name: attachment.name.slice(0, 180),
      mediaType: mediaType as SupportedImageMediaType,
      size: parsed.size,
      dataUrl,
    });
  }
  return { attachments };
}

export function buildMultimodalUserContent(
  text: string,
  attachments: Required<ChatImageAttachment>[],
) {
  if (attachments.length === 0) return text;
  const content: Array<{ type: "text"; text: string } | InlineImageBlock> = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const attachment of attachments) {
    const parsed = parseDataUrl(attachment.dataUrl, attachment.mediaType);
    if (!parsed) continue;
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mediaType,
        data: parsed.data,
      },
      name: attachment.name,
    });
  }
  return content;
}

export function stripInlineImagesForPersistence(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = message.content.flatMap((block) => {
      const candidate = block as unknown as Partial<InlineImageBlock>;
      if (candidate.type !== "image") return [block];
      return [{
        type: "text" as const,
        text: `[图片附件已处理${candidate.name ? `：${candidate.name}` : ""}]`,
      }];
    });
    return { ...message, content } as Anthropic.MessageParam;
  });
}
