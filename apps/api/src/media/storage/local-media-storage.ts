import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertValidKey, type MediaStorage } from './media-storage';

export class LocalMediaStorage implements MediaStorage {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async put(key: string, body: Buffer): Promise<void> {
    assertValidKey(key);
    const targetPath = join(this.directory, key);
    const dir = dirname(targetPath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `.${basename(targetPath)}.${randomUUID()}.tmp`);
    await writeFile(tempPath, body);
    await rename(tempPath, targetPath);
  }

  async get(key: string): Promise<Buffer | null> {
    assertValidKey(key);
    const targetPath = join(this.directory, key);
    try {
      return await readFile(targetPath);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const targetPath = join(this.directory, key);
    try {
      await unlink(targetPath);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
}
