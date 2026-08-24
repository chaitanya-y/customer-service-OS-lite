import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContextAssertionError } from '../src/trusted-context.js';
import {
  createTestContextAssertion,
  TEST_ACCESS_CONTEXT,
  TEST_NOW,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

test('verifies a short-lived self-service context assertion', async () => {
  const context = await verifyTestContextAssertion(
    createTestContextAssertion(),
  );

  assert.deepEqual(context, TEST_ACCESS_CONTEXT);
});

test('rejects a context assertion with a tampered signature', async () => {
  const assertion = createTestContextAssertion();
  const [header, claims, signature] = assertion.split('.');
  assert.ok(header && claims && signature);
  const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  const tamperedAssertion = `${header}.${claims}.${tamperedSignature}`;

  await assert.rejects(
    () => verifyTestContextAssertion(tamperedAssertion),
    ContextAssertionError,
  );
});

test('rejects malformed signature encoding', async () => {
  const malformedAssertion = `${createTestContextAssertion()}!`;

  await assert.rejects(
    () => verifyTestContextAssertion(malformedAssertion),
    ContextAssertionError,
  );
});

test('rejects an expired context assertion', async () => {
  const nowSeconds = Math.floor(TEST_NOW.getTime() / 1_000);
  const assertion = createTestContextAssertion({
    issuedAt: nowSeconds - 120,
    expiresAt: nowSeconds - 1,
  });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a context assertion for a different tenant', async () => {
  const assertion = createTestContextAssertion({
    tenantId: 'tenant-other',
  });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a context assertion for a different environment', async () => {
  const assertion = createTestContextAssertion({
    environmentId: 'staging',
  });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a context assertion from a different issuer', async () => {
  const assertion = createTestContextAssertion({ issuer: 'unknown-issuer' });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a context assertion for a different audience', async () => {
  const assertion = createTestContextAssertion({ audience: 'another-service' });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a generic JWT token type', async () => {
  const assertion = createTestContextAssertion({ tokenType: 'JWT' });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects an actor that does not match the subject customer', async () => {
  const assertion = createTestContextAssertion({
    actorPrincipalId: 'customer-other',
  });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});

test('rejects a context assertion whose lifetime exceeds five minutes', async () => {
  const nowSeconds = Math.floor(TEST_NOW.getTime() / 1_000);
  const assertion = createTestContextAssertion({
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 301,
  });

  await assert.rejects(
    () => verifyTestContextAssertion(assertion),
    ContextAssertionError,
  );
});
