import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

export type ProtectedMessage = {
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  plaintextSha256: string;
  plaintextByteLength: number;
  encryptionKeyVersion: string;
};

export type ProtectMessage = (plaintext: string) => ProtectedMessage;
export type UnprotectMessage = (protectedMessage: ProtectedMessage) => string;

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

export function createAesGcmMessageUnprotector({
  key,
  keyVersion,
}: Pick<MessageProtectorOptions, 'key' | 'keyVersion'>): UnprotectMessage {
  if (key.byteLength !== 32) {
    throw new Error('AES-256-GCM requires a 32-byte encryption key');
  }

  if (!keyVersion.trim()) {
    throw new Error('Message encryption key version is required');
  }

  return (protectedMessage) => {
    if (protectedMessage.encryptionKeyVersion !== keyVersion) {
      throw new Error('Message encryption key version is unavailable');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      protectedMessage.initializationVector,
    );
    decipher.setAuthTag(protectedMessage.authenticationTag);

    return Buffer.concat([
      decipher.update(protectedMessage.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  };
}
