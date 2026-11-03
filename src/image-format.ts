import { open, rename } from 'node:fs/promises';
import { extname } from 'node:path';

// Adapted from tencent-connect/dsh-qqbot#86: QQ image MIME types and suffixes
// can disagree with the bytes, especially for GIF stickers and JPEG photos.
function imageExtension(header: Buffer): string | undefined {
  if (header.length >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('latin1', 0, 6))) return '.gif';
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return '.jpg';
  if (header.length >= 12 && header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (header.length >= 2 && header[0] === 0x42 && header[1] === 0x4d) return '.bmp';
}

export function isImageContentType(contentType?: string): boolean {
  return /^image(?:\/|$)/i.test(contentType || '');
}

export async function correctImageExtension(path: string): Promise<string> {
  const handle = await open(path, 'r');
  let extension: string | undefined;
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    extension = imageExtension(header.subarray(0, bytesRead));
  } finally { await handle.close(); }
  const declared = extname(path);
  if (!extension || declared.toLowerCase() === extension || extension === '.jpg' && declared.toLowerCase() === '.jpeg') return path;
  const corrected = path.slice(0, path.length - declared.length) + extension;
  await rename(path, corrected);
  return corrected;
}
