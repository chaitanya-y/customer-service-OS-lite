import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { EvidenceError, MAX_PHOTO_BYTES, digest } from './refund-evidence.js';

export type ValidatedPhoto = { bytes: Buffer; contentType: 'image/jpeg' | 'image/png'; width: number; height: number; sha256: string };
export async function validatePhoto(bytes: Buffer, declaredType: string): Promise<ValidatedPhoto> {
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new EvidenceError('FILE_TOO_LARGE');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if ((!jpeg && !png) || (jpeg ? 'image/jpeg' : 'image/png') !== declaredType) throw new EvidenceError('INVALID_IMAGE');
  try {
    // No withMetadata/keepMetadata: EXIF, GPS, comments and original names are not retained.
    const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning', animated: false }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1 || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192)
      throw new EvidenceError('IMAGE_LIMIT_EXCEEDED');
    const result = await (jpeg ? image.rotate().jpeg({ quality: 90 }) : image.rotate().png()).toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_PHOTO_BYTES) throw new EvidenceError('FILE_TOO_LARGE');
    return { bytes: result.data, contentType: jpeg ? 'image/jpeg' : 'image/png', width: result.info.width, height: result.info.height, sha256: digest(result.data) };
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('INVALID_IMAGE');
  }
}
export class PrivateEvidenceStore {
  private constructor(readonly directory: string) {}
  static async create(directory: string): Promise<PrivateEvidenceStore> {
    const resolved = path.resolve(directory);
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    if (!path.isAbsolute(directory) || resolved === path.parse(resolved).root || resolved === path.resolve(repositoryRoot) || resolved.startsWith(path.resolve(repositoryRoot) + path.sep))
      throw new Error('EVIDENCE_STORAGE_MUST_BE_PRIVATE_AND_OUTSIDE_REPOSITORY');
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || await realpath(resolved) !== resolved)
      throw new Error('EVIDENCE_STORAGE_PERMISSIONS_INVALID');
    return new PrivateEvidenceStore(resolved);
  }
  private filename(key: string): string {
    if (!/^[a-f0-9-]{36}\.(jpg|png)$/.test(key)) throw new EvidenceError('evidence_not_found', 404);
    return path.join(this.directory, key);
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const file = await open(this.filename(key), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  async read(key: string, expectedHash: string): Promise<Buffer> {
    const file = await open(this.filename(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_PHOTO_BYTES) throw new EvidenceError('evidence_unavailable', 503);
      const bytes = await file.readFile();
      if (digest(bytes) !== expectedHash) throw new EvidenceError('evidence_unavailable', 503);
      return bytes;
    } finally { await file.close(); }
  }
  async remove(key: string): Promise<void> {
    try { await unlink(this.filename(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
