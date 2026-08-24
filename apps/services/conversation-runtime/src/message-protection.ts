import { createCipheriv, createHash, randomBytes } from 'node:crypto';

export type ProtectedMessage = {
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  plaintextSha256: string;
  plaintextByteLength: number;
  encryptionKeyVersion: string;
};

export type ProtectMessage = (plaintext: string) => ProtectedMessage;

type MessageProtectorOptions = {
  key: Buffer;
  keyVersion: string;
  createInitializationVector?: () => Buffer;
};

export function createAesGcmMessageProtector({
  key,
  keyVersion,
  createInitializationVector = () => randomBytes(12),
}: MessageProtectorOptions): ProtectMessage {
  if (key.byteLength !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte encryption key');
  }

  if (!keyVersion.trim()) {
    throw new Error('Message encryption key version is required');
  }

  return (plaintext) => {
    const plaintextBytes = Buffer.from(plaintext, 'utf8');
    const initializationVector = createInitializationVector();

    if (initializationVector.byteLength !== 12) {
      throw new Error('AES-GCM initialization vector must contain 12 bytes');
    }

    const cipher = createCipheriv(
      'aes-256-gcm',
      key,
      initializationVector,
    );
    const ciphertext = Buffer.concat([
      cipher.update(plaintextBytes),
      cipher.final(),
    ]);

    return {
      ciphertext,
      initializationVector,
      authenticationTag: cipher.getAuthTag(),
      plaintextSha256: createHash('sha256')
        .update(plaintextBytes)
        .digest('hex'),
      plaintextByteLength: plaintextBytes.byteLength,
      encryptionKeyVersion: keyVersion,
    };
  };
}
