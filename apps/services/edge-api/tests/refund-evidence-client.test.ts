import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jwtVerify } from 'jose';
import { createEvidenceAccessVerifier } from '../../human-operations/src/refund-evidence-access.js';

import {
  createEvidenceAssertionSigner, createRefundEvidenceClient, EVIDENCE_ASSERTION_HEADER,
  MAX_EVIDENCE_BYTES, RefundEvidenceError, refundEvidenceSummarySchema,
} from '../src/refund-evidence-client.js';

const identity = { principalId: 'customer-1', customerId: 'customer-1', tenantId: 'tenant-1', environmentId: 'local' };
const context = { workflowId: 'refund-1', identity, requestId: 'request-1', traceId: 'trace-1' };
const initial = { version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: 0, assessment: 'UNREVIEWED', can_upload: true, attachments: [] };
const photo = { evidence_id: '00000000-0000-4000-8000-000000000001', display_label: 'Photo 1', content_type: 'image/png', byte_size: 80, width: 1, height: 1, uploaded_at: '2026-09-05T12:00:00Z', technical_status: 'READY' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const errorIs = (code: string) => (error: unknown) => error instanceof RefundEvidenceError && error.code === code;

test('evidence assertion binds customer, tenant, workflow, purpose and dedicated audience for 60 seconds', async () => {
  const secret = 'evidence-test-context-secret-at-least-32-bytes';
  const now = new Date('2026-09-05T12:00:00Z');
  const sign = createEvidenceAssertionSigner({ secret, now: () => now });
  const token = await sign({ ...context, purpose: 'refund_evidence_upload' });
  const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'], typ: 'cso-evidence+jwt', audience: 'human-operations-evidence', issuer: 'customer-service-os-edge', currentDate: now,
  });
  assert.equal(protectedHeader.alg, 'HS256');
  assert.equal(payload.exp! - payload.iat!, 60);
  assert.deepEqual(payload.workflow, { workflowId: context.workflowId });
  assert.deepEqual(payload.tenant, { tenantId: identity.tenantId, environmentId: identity.environmentId });
  assert.deepEqual(payload.subject, { customerId: identity.customerId });
  assert.equal(payload.purpose, 'refund_evidence_upload');
  await assert.rejects(sign({ ...context, identity: { ...identity, principalId: 'other' }, purpose: 'refund_evidence_read' }));
  await assert.rejects(jwtVerify(token, new TextEncoder().encode(secret), { audience: 'integration-gateway', currentDate: now }));
});

test('real Human Operations verifier accepts Edge assertions and rejects wrong purpose, tenant, environment and expiry', async () => {
  const secret = 'evidence-test-context-secret-at-least-32-bytes';
  const now = new Date('2026-09-05T12:00:00Z');
  const sign = createEvidenceAssertionSigner({ secret, now: () => now });
  const options = { secret, issuer: 'customer-service-os-edge', tenantId: identity.tenantId, environmentId: identity.environmentId, now: () => now };
  const verify = createEvidenceAccessVerifier(options);
  for (const purpose of ['refund_evidence_read', 'refund_evidence_upload', 'refund_evidence_content'] as const) {
    const token = await sign({ ...context, purpose });
    assert.deepEqual(await verify(token, purpose), { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, workflowId: context.workflowId });
  }
  const token = await sign({ ...context, purpose: 'refund_evidence_upload' });
  await assert.rejects(verify(token, 'refund_evidence_content'), /EVIDENCE_UNAUTHORIZED/);
  await assert.rejects(createEvidenceAccessVerifier({ ...options, tenantId: 'other' })(token, 'refund_evidence_upload'), /EVIDENCE_UNAUTHORIZED/);
  await assert.rejects(createEvidenceAccessVerifier({ ...options, environmentId: 'other' })(token, 'refund_evidence_upload'), /EVIDENCE_UNAUTHORIZED/);
  await assert.rejects(createEvidenceAccessVerifier({ ...options, now: () => new Date(now.getTime() + 60_000) })(token, 'refund_evidence_upload'), /EVIDENCE_UNAUTHORIZED/);
});

test('uploads exactly once with stable idempotency/version and dedicated signed context, never customer bearer', async () => {
  const calls: RequestInit[] = [];
  const purposes: string[] = [];
  const client = createRefundEvidenceClient({ baseUrl: 'http://127.0.0.1:3003',
    signAssertion: async input => { purposes.push(input.purpose); assert.deepEqual(input.identity, identity); return 'test-signed-evidence'; },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:3003/internal/v1/customer-refund-evidence/refund-1');
      calls.push(init!); return Response.json({ evidence: initial }, { status: 202 });
    },
  });
  await client.upload({ ...context, body: png, contentType: 'image/png', idempotencyKey: 'attempt-1', expectedVersion: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.redirect, 'error');
  const headers = new Headers(calls[0]!.headers);
  assert.equal(headers.get(EVIDENCE_ASSERTION_HEADER), 'test-signed-evidence');
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('idempotency-key'), 'attempt-1');
  assert.equal(headers.get('x-cso-expected-evidence-version'), '0');
  assert.deepEqual(purposes, ['refund_evidence_upload']);
  assert.deepEqual(Buffer.from(calls[0]!.body as Uint8Array), png);
});

test('only bounded canonical metadata passes; staff notes, URLs, duplicate IDs and invalid revisions fail closed', () => {
  assert.ok(refundEvidenceSummarySchema.safeParse(initial).success);
  const uploaded = { ...initial, evidence_version: 1, attachments: [photo] };
  assert.ok(refundEvidenceSummarySchema.safeParse(uploaded).success);
  for (const value of [
    { ...initial, staff_notes: 'private' }, { ...initial, url: 'https://private.example/photo' },
    { ...initial, attachments: [photo] },
    { ...uploaded, attachments: [photo, photo] },
    { ...uploaded, assessment: 'ACCEPTED', can_upload: true },
    { ...uploaded, assessment: 'MORE_REQUIRED' },
    { ...uploaded, attachments: [{ ...photo, storage_key: 'private' }] },
    { ...uploaded, attachments: [{ ...photo, technical_status: 'PROCESSING' }] },
  ]) assert.equal(refundEvidenceSummarySchema.safeParse(value).success, false);
});

test('client bounds upload and response bytes, rejects malformed/private metadata and unsafe content', async () => {
  let calls = 0;
  let response = () => Response.json({ evidence: { ...initial, staff_notes: 'DO NOT EXPOSE' } });
  const client = createRefundEvidenceClient({ baseUrl: 'http://127.0.0.1:3003', signAssertion: async () => 'assertion', fetchImpl: async () => { calls += 1; return response(); } });
  await assert.rejects(client.upload({ ...context, body: Buffer.alloc(MAX_EVIDENCE_BYTES + 1), contentType: 'image/png', idempotencyKey: 'attempt-1', expectedVersion: 0 }), errorIs('evidence_too_large'));
  assert.equal(calls, 0);
  await assert.rejects(client.getSummary(context), errorIs('evidence_unavailable'));
  response = () => new Response(Buffer.alloc(MAX_EVIDENCE_BYTES + 1), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(client.getContent({ ...context, evidenceId: photo.evidence_id }), errorIs('evidence_unavailable'));
  response = () => new Response('<script>bad</script>', { headers: { 'content-type': 'image/png' } });
  await assert.rejects(client.getContent({ ...context, evidenceId: photo.evidence_id }), errorIs('evidence_unavailable'));
  response = () => new Response(png, { headers: { 'content-type': 'image/png' } });
  assert.deepEqual((await client.getContent({ ...context, evidenceId: photo.evidence_id })).body, png);
});

test('upstream failures are sanitized and upload transport failure is not automatically retried', async () => {
  let calls = 0;
  let response = () => Response.json({ error: { code: 'evidence_not_found', message: 'private path' } }, { status: 404 });
  const client = createRefundEvidenceClient({ baseUrl: 'http://127.0.0.1:3003', signAssertion: async () => 'assertion', fetchImpl: async () => { calls += 1; return response(); } });
  assert.equal(await client.getSummary(context), undefined);
  response = () => Response.json({ error: { code: 'idempotency_conflict', message: 'private note' } }, { status: 409 });
  await assert.rejects(client.upload({ ...context, body: png, contentType: 'image/png', idempotencyKey: 'attempt-1', expectedVersion: 0 }), errorIs('idempotency_conflict'));
  response = () => { throw new Error('private transport details'); };
  const before = calls;
  await assert.rejects(client.upload({ ...context, body: png, contentType: 'image/png', idempotencyKey: 'attempt-1', expectedVersion: 0 }), errorIs('evidence_unavailable'));
  assert.equal(calls, before + 1);
});
