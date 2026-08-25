import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChatImageAttachment,
  SupportedImageMediaType,
} from "@/lib/agent/multimodal";

export const CHAT_IMAGE_BUCKET = "chat-images";
export const CHAT_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60;
export const CHAT_IMAGE_OPERATION_TIMEOUT_MS = 30_000;

export type ComposerImageAttachment = ChatImageAttachment & {
  file: File;
  uploadStatus: "uploading" | "ready" | "error";
  uploadError?: string;
};

const extensionByMediaType: Record<SupportedImageMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function buildChatImageStoragePath(input: {
  userId: string;
  sessionId: string;
  imageId: string;
  mediaType: SupportedImageMediaType;
}) {
  const extension = extensionByMediaType[input.mediaType];
  return `${input.userId}/${input.sessionId}/${input.imageId}.${extension}`;
}

export function isOwnedChatImagePath(
  path: string,
  userId: string,
  sessionId: string,
) {
  const parts = path.split("/");
  return parts.length === 3
    && parts[0] === userId
    && parts[1] === sessionId
    && Boolean(parts[2]);
}

export function getChatImagePreviewUrl(attachment: ChatImageAttachment) {
  return attachment.dataUrl ?? attachment.previewUrl;
}

export async function uploadChatImage(
  supabase: SupabaseClient,
  input: {
    userId: string;
    sessionId: string;
    imageId: string;
    mediaType: SupportedImageMediaType;
    file: File;
    timeoutMs?: number;
  },
) {
  const storagePath = buildChatImageStoragePath(input);
  const { error } = await withTimeout(
    supabase.storage
      .from(CHAT_IMAGE_BUCKET)
      .upload(storagePath, input.file, {
        cacheControl: "3600",
        contentType: input.mediaType,
        upsert: true,
      }),
    input.timeoutMs ?? CHAT_IMAGE_OPERATION_TIMEOUT_MS,
    `上传图片 ${input.file.name} 超时，请检查网络后重试`,
  );

  if (error) throw new Error(`上传图片 ${input.file.name} 失败：${error.message}`);
  return storagePath;
}

export async function deleteChatImages(
  supabase: SupabaseClient,
  paths: string[],
) {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  if (uniquePaths.length === 0) return;

  for (let offset = 0; offset < uniquePaths.length; offset += 100) {
    const { error } = await withTimeout(
      supabase.storage
        .from(CHAT_IMAGE_BUCKET)
        .remove(uniquePaths.slice(offset, offset + 100)),
      CHAT_IMAGE_OPERATION_TIMEOUT_MS,
      "清理图片超时，请检查网络后重试",
    );
    if (error) throw new Error(`清理图片失败：${error.message}`);
  }
}

export async function createChatImageSignedUrlMap(
  supabase: SupabaseClient,
  input: {
    userId: string;
    sessionId: string;
    paths: string[];
  },
) {
  const ownedPaths = Array.from(new Set(input.paths.filter((path) =>
    isOwnedChatImagePath(path, input.userId, input.sessionId))));
  const signedUrls = new Map<string, string>();

  for (let offset = 0; offset < ownedPaths.length; offset += 100) {
    const batch = ownedPaths.slice(offset, offset + 100);
    const { data, error } = await withTimeout(
      supabase.storage
        .from(CHAT_IMAGE_BUCKET)
        .createSignedUrls(batch, CHAT_IMAGE_SIGNED_URL_TTL_SECONDS),
      CHAT_IMAGE_OPERATION_TIMEOUT_MS,
      "生成图片预览地址超时，请检查网络后重试",
    );
    if (error) throw new Error(`生成图片访问地址失败：${error.message}`);

    for (const item of data ?? []) {
      if (item.path && item.signedUrl && !item.error) {
        signedUrls.set(item.path, item.signedUrl);
      }
    }
  }

  return signedUrls;
}

export function applyChatImageSignedUrls(
  attachments: ChatImageAttachment[],
  signedUrls: Map<string, string>,
) {
  return attachments.map((attachment) => ({
    ...attachment,
    previewUrl: attachment.storagePath
      ? signedUrls.get(attachment.storagePath)
      : undefined,
  }));
}

export function collectOwnedChatImagePaths(
  messages: Array<{ metadata?: unknown }>,
  userId: string,
  sessionId: string,
) {
  const paths: string[] = [];
  for (const message of messages) {
    if (!message.metadata || typeof message.metadata !== "object") continue;
    const attachments = (message.metadata as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const storagePath = (attachment as { storagePath?: unknown }).storagePath;
      if (
        typeof storagePath === "string"
        && isOwnedChatImagePath(storagePath, userId, sessionId)
      ) {
        paths.push(storagePath);
      }
    }
  }
  return Array.from(new Set(paths));
}
