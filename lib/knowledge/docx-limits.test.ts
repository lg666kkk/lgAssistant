import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_DOCX_MAX_ENTRIES, KNOWLEDGE_DOCX_MAX_ENTRY_BYTES, KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES,
  validateDocxArchive,
} from './docx-limits';
import { parseKnowledgeFile } from './file-parsers';

const mammoth = vi.hoisted(() => ({ convertToHtml: vi.fn(), images: { imgElement: vi.fn() } }));
vi.mock('mammoth', () => mammoth);

// 构造真实 deflate ZIP，允许伪造目录中的解压大小，验证不能仅信任声明。
function zip(entries: { name: string; compressed: Buffer; size: number }[]) {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, entry.compressed);
    directory.push(central, name);
    offset += local.length + name.length + entry.compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const small = { name: 'word/document.xml', compressed: deflateRawSync(Buffer.from('<document/>')), size: 11 };

describe('DOCX decompression limits', () => {
  it('accepts a small archive', async () => {
    await expect(validateDocxArchive(zip([small]))).resolves.toBeUndefined();
  });

  it('exempts word/media entries from the per-entry cap but not the total cap', async () => {
    const image = Buffer.alloc(KNOWLEDGE_DOCX_MAX_ENTRY_BYTES + 1);
    const media = { name: 'word/media/image1.png', compressed: deflateRawSync(image), size: image.length };
    await expect(validateDocxArchive(zip([small, media]))).resolves.toBeUndefined();

    const lying = { ...media, size: KNOWLEDGE_DOCX_MAX_EXPANDED_BYTES + 1 };
    await expect(validateDocxArchive(zip([small, lying]))).rejects.toThrow('上限');
  });

  it('rejects an entry that expands beyond the cap before invoking Mammoth', async () => {
    const bytes = zip([{ ...small, size: KNOWLEDGE_DOCX_MAX_ENTRY_BYTES + 1 }]);
    await expect(parseKnowledgeFile({ fileName: 'bomb.docx', kind: 'docx', bytes })).rejects.toThrow('16MB 上限');
    expect(mammoth.convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects too many entries', async () => {
    const bytes = zip(Array.from({ length: KNOWLEDGE_DOCX_MAX_ENTRIES + 1 }, (_, i) => ({ ...small, name: `entry-${i}` })));
    await expect(validateDocxArchive(bytes)).rejects.toThrow('2000 个上限');
  });

  it('rejects a highly compressed archive whose total expansion exceeds 64MB', async () => {
    const compressed = deflateRawSync(Buffer.alloc(KNOWLEDGE_DOCX_MAX_ENTRY_BYTES, 65));
    const bytes = zip(Array.from({ length: 5 }, (_, i) => ({ name: `entry-${i}`, compressed, size: KNOWLEDGE_DOCX_MAX_ENTRY_BYTES })));
    expect(bytes.length).toBeLessThan(1024 * 1024);
    await expect(validateDocxArchive(bytes)).rejects.toThrow('64MB 上限');
  });

  it('rejects understated entry sizes instead of trusting the ZIP directory', async () => {
    const compressed = deflateRawSync(Buffer.alloc(1024 * 1024, 65));
    await expect(validateDocxArchive(zip([{ name: 'word/document.xml', compressed, size: 1 }])))
      .rejects.toThrow(/too many bytes|size mismatch/i);
  });

  it('rejects malformed archives', async () => {
    await expect(validateDocxArchive(new Uint8Array([80, 75, 3, 4]))).rejects.toThrow();
  });
});
