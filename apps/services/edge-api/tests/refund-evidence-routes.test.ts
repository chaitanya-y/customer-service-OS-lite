import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { MAX_EVIDENCE_BYTES, RefundEvidenceError, type RefundEvidenceClient, type RefundEvidenceSummary } from '../src/refund-evidence-client.js';
import { RefundWorkflowNotFoundError } from '../src/temporal-refund-client.js';

const identity = { principalId: 'customer-1', customerId: 'customer-1', tenantId: 'tenant-1', environmentId: 'local' };
const initial: RefundEvidenceSummary = { version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: 0, assessment: 'UNREVIEWED', can_upload: true, attachments: [] };
const evidenceId = '00000000-0000-4000-8000-000000000001';
const headers = { authorization: 'Bearer good', 'content-type': 'image/png', 'idempotency-key': 'attempt-1', 'x-cso-expected-evidence-version': '0' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fixture() {
  const state = { stage: 'AWAITING_CUSTOMER_EVIDENCE', owned: true, summary: initial, reads: 0, uploads: 0, contentReads: 0, workflowReads: 0, error: undefined as Error | undefined };
  const evidenceClient: RefundEvidenceClient = {
    async getSummary(input) { state.reads += 1; assert.deepEqual(input.identity, identity); return state.summary; },
    async upload(input) {
      state.uploads += 1;
      assert.deepEqual(input.body, png); assert.equal(input.idempotencyKey, 'attempt-1'); assert.equal(input.expectedVersion, 0);
      if (state.error) throw state.error;
      return state.summary;
    },
    async getContent(input) { state.contentReads += 1; assert.equal(input.evidenceId, evidenceId); return { body: png, contentType: 'image/png' }; },
  };
  const app = buildApp({
    verifyCustomerIdentity: async token => { if (token !== 'good') throw new Error('unauthorized'); return identity; },
    signContextAssertion: async () => 'unused', signAgentRuntimeContextAssertion: async () => 'unused', signKnowledgeRagContextAssertion: async () => 'unused', intakeRefund: async () => ({ statusCode: 500, body: {} }),
    getRefundWorkflow: async input => {
      state.workflowReads += 1;
      assert.deepEqual([input.access.tenantId, input.access.environmentId, input.access.subjectCustomerId], [identity.tenantId, identity.environmentId, identity.customerId]);
      if (!state.owned) throw new RefundWorkflowNotFoundError();
      return { stage: state.stage };
    },
    refundEvidenceClient: evidenceClient,
  });
  return { app, state };
}

test('customer authentication and verified workflow scope precede all evidence reads and uploads', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  let response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers: { ...headers, authorization: 'Bearer wrong' }, payload: png });
  assert.equal(response.statusCode, 401); assert.equal(state.workflowReads, 0); assert.equal(state.reads, 0);
  state.owned = false;
  response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-other/evidence', headers, payload: png });
  assert.equal(response.statusCode, 404); assert.equal(state.reads, 0); assert.equal(state.uploads, 0);
  response = await app.inject({ method: 'GET', url: `/v1/refunds/refund-other/evidence/${evidenceId}/content`, headers: { authorization: 'Bearer good' } });
  assert.equal(response.statusCode, 404); assert.equal(state.contentReads, 0);
});

test('both evidence wait states allow a bounded raw upload with exact idempotency/version and no public URLs', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  for (const stage of ['AWAITING_CUSTOMER_EVIDENCE', 'AWAITING_EVIDENCE_REVIEW']) {
    state.stage = stage;
    const response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: png });
    assert.equal(response.statusCode, 202); assert.deepEqual(response.json(), { evidence: initial });
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.body.includes('http'), false);
  }
  assert.equal(state.uploads, 2);
});

test('terminal/accepted evidence rejects upload before reading or forwarding image bytes', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  state.stage = 'EVIDENCE_COLLECTION_EXPIRED';
  let response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: png });
  assert.equal(response.statusCode, 409); assert.equal(state.reads, 0);
  state.stage = 'AWAITING_EVIDENCE_REVIEW'; state.summary = { ...initial, can_upload: false };
  response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: png });
  assert.equal(response.statusCode, 409); assert.equal(state.uploads, 0);
});

test('enforces media, encoding, idempotency/version and actual streaming byte limits', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  for (const [changes, status] of [
    [{ 'content-type': 'image/svg+xml' }, 415], [{ 'content-type': 'multipart/form-data' }, 415],
    [{ 'content-encoding': 'gzip' }, 415], [{ 'idempotency-key': '' }, 400],
    [{ 'x-cso-expected-evidence-version': '-1' }, 400], [{ 'x-cso-expected-evidence-version': '9007199254740992' }, 400],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers: { ...headers, ...changes }, payload: png });
    assert.equal(response.statusCode, status);
  }
  const response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: Readable.from([Buffer.alloc(MAX_EVIDENCE_BYTES), Buffer.from([1])]) });
  assert.equal(response.statusCode, 413); assert.equal(response.json().error.code, 'evidence_too_large'); assert.equal(state.uploads, 0);
});

test('private content is authorized and served inline with no-store/nosniff, not redirected', async t => {
  const { app } = fixture(); t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: `/v1/refunds/refund-1/evidence/${evidenceId}/content`, headers: { authorization: 'Bearer good' } });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, png);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['content-type'], 'image/png'); assert.equal(response.headers.location, undefined);
});

test('idempotency and stale-version failures remain safe conflicts; internal errors reveal no notes', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  for (const code of ['idempotency_conflict', 'stale_evidence_version']) {
    state.error = new RefundEvidenceError(409, code);
    const response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: png });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, code);
  }
  state.error = new Error('PRIVATE staff notes and storage key');
  const response = await app.inject({ method: 'POST', url: '/v1/refunds/refund-1/evidence', headers, payload: png });
  assert.equal(response.statusCode, 503); assert.equal(response.body.includes('PRIVATE'), false);
});

test('journey includes bounded evidence and enforces terminal can_upload=false', async t => {
  const { app, state } = fixture(); t.after(() => app.close());
  let response = await app.inject({ method: 'GET', url: '/v1/refunds/refund-1/journey', headers: { authorization: 'Bearer good' } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().next_action.type, 'PROVIDE_EVIDENCE'); assert.deepEqual(response.json().evidence, initial);
  state.stage = 'EVIDENCE_COLLECTION_EXPIRED';
  response = await app.inject({ method: 'GET', url: '/v1/refunds/refund-1/journey', headers: { authorization: 'Bearer good' } });
  assert.equal(response.json().next_action.type, 'NONE'); assert.equal(response.json().evidence.can_upload, false);
});
