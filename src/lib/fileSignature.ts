/**
 * Detects the real file type from magic bytes (manual 4.5): the browser MIME
 * type and the file extension are never trusted on their own.
 */
export const ALLOWED_UPLOADS = {
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
} as const;
export type AllowedMime = keyof typeof ALLOWED_UPLOADS;

export function detectMime(buf: Buffer): AllowedMime | null {
  for (const [mime, def] of Object.entries(ALLOWED_UPLOADS) as [AllowedMime, (typeof ALLOWED_UPLOADS)[AllowedMime]][]) {
    if (buf.length >= def.magic.length && def.magic.every((b, i) => buf[i] === b)) return mime;
  }
  return null;
}

/** Strip directories, control characters and odd symbols from a user file name. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^\w.\- ()]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'file';
}
