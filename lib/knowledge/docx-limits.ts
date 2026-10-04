export const KNOWLEDGE_DOCX_MAX_ENTRIES = 2000;
export const KNOWLEDGE_DOCX_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

/**
 * 在 Mammoth 解压前逐条验证 ZIP。不保存解压内容，且不只信任目录声明的大小。
 */
export async function validateDocxArchive(bytes: Uint8Array): Promise<void> {
  const { fromBufferPromise } = await import('yauzl');
  const zip = await fromBufferPromise(Buffer.from(bytes), {
    lazyEntries: true, validateEntrySizes: true, strictFileNames: true,
  });
  try {
    if (zip.entryCount > KNOWLEDGE_DOCX_MAX_ENTRIES) {
      throw new Error(`DOCX ZIP 条目超过 ${KNOWLEDGE_DOCX_MAX_ENTRIES} 个上限`);
    }
    let declaredTotal = 0;
    let actualTotal = 0;
    for await (const entry of zip.eachEntry()) {
      // 大图常超过单条目上限；media 只免除单条目限制，仍流式解压并计入总量，
      // 防止把主文档 XML 放进 word/media/ 再用 rels 指过去来绕过检查。
      const entryLimit = entry.fileName.startsWith('word/media/')
        ? KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES
        : KNOWLEDGE_DOCX_MAX_ENTRY_BYTES;
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        throw new Error('DOCX 包含加密或不支持的压缩条目');
      }
      declaredTotal += entry.uncompressedSize;
      if (entry.uncompressedSize > entryLimit) {
        throw new Error(`DOCX 单个条目解压后超过 ${entryLimit / 1024 / 1024}MB 上限`);
      }
      if (declaredTotal > KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES) {
        throw new Error('DOCX 解压后总大小超过 64MB 上限');
      }
      const stream = await zip.openReadStreamPromise(entry);
      let entryBytes = 0;
      // async iterator 在出错时销毁 stream，停止继续解压。
      for await (const chunk of stream) {
        entryBytes += chunk.length;
        actualTotal += chunk.length;
        if (entryBytes > entryLimit) {
          throw new Error(`DOCX 单个条目解压后超过 ${entryLimit / 1024 / 1024}MB 上限`);
        }
        if (actualTotal > KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES) {
          throw new Error('DOCX 解压后总大小超过 64MB 上限');
        }
      }
    }
  } finally {
    zip.close();
  }
}
