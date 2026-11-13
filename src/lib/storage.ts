import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { AppError, ErrorCodes } from './errors';

/**
 * Private file storage abstraction. The local-disk driver keeps files outside
 * the web root; an S3/GCS driver can implement the same interface in production.
 * Keys are always server-generated, never derived from user input.
 */
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  stream(key: string): Promise<NodeJS.ReadableStream>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements StorageProvider {
  private readonly root = path.resolve(env.STORAGE_DIR);

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw AppError.badRequest('Invalid storage key.');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    try {
      await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await fsp.writeFile(full, data, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      throw new AppError(503, ErrorCodes.DOCUMENT_STORAGE_UNAVAILABLE, 'File storage is temporarily unavailable. Please retry.', undefined, {
        cause: (err as Error).message,
      });
    }
  }

  async stream(key: string): Promise<NodeJS.ReadableStream> {
    const full = this.resolve(key);
    await fsp.access(full).catch(() => {
      throw AppError.notFound('File');
    });
    return fs.createReadStream(full);
  }

  async remove(key: string): Promise<void> {
    await fsp.rm(this.resolve(key), { force: true });
  }
}

export const storage: StorageProvider = new LocalStorage();

export function newStorageKey(prefix: string, ext: string): string {
  const d = new Date();
  return `${prefix}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
}
