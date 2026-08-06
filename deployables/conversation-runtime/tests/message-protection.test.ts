import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';

import { createAesGcmMessageProtector } from '../src/message-protection.js';

test('encrypts customer text with AES-256-GCM and records evidence metadata', () => {
  const key = Buffer.alloc(32, 7);
  const protect = createAesGcmMessageProtector({
    key,
    keyVersion: 'test-v1',
    createInitializationVector: () => Buffer.alloc(12, 3),
  });

  const protectedMessage = protect('Please refund me.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    protectedMessage.initializationVector,
  );
  decipher.setAuthTag(protectedMessage.authenticationTag);
  const decrypted = Buffer.concat([
    decipher.update(protectedMessage.ciphertext),
    decipher.final(),
  ]).toString('utf8');

  assert.equal(decrypted, 'Please refund me.');
  assert.equal(
    protectedMessage.ciphertext.includes(Buffer.from('Please refund me.')),
    false,
  );
  assert.match(protectedMessage.plaintextSha256, /^[a-f0-9]{64}$/);
  assert.equal(protectedMessage.plaintextByteLength, 17);
  assert.equal(protectedMessage.encryptionKeyVersion, 'test-v1');
});

test('rejects an invalid AES key length', () => {
  assert.throws(
    () =>
      createAesGcmMessageProtector({
        key: Buffer.alloc(31),
        keyVersion: 'test-v1',
      }),
    /32-byte encryption key/,
  );
});
