import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = new URL('../../', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
ajv.addSchema(await read('contracts/customer-api/refund-evidence/v1/refund-evidence-summary.schema.json'));
const snapshot = ajv.compile(await read('contracts/internal-api/refund-evidence/v1/refund-evidence-snapshot.schema.json'));
const claims = ajv.compile(await read('contracts/internal-api/refund-evidence/v1/evidence-access-claims.schema.json'));
const publicSummary = await read('tests/contract/fixtures/refund-evidence-summary/valid.json');
const accepted = { case_id: 'case-001', case_status: 'CLAIMED', evidence: publicSummary,
  assessment_id: '6f9dba4b-e9c7-485c-a4ef-8823ae9c4e64', accepted_manifest_hash: `sha256:${'a'.repeat(64)}`,
  binding: { order_id: 'order-1', proposal_id: 'proposal-1', selected_item_ids: [], policy_version: 'refund-policy-v2' },
};
test('internal evidence snapshot compiles and binds full-order empty selection', () => {
  assert.equal(snapshot(accepted), true, ajv.errorsText(snapshot.errors));
});
test('accepted internal evidence must identify the exact staff assessment and manifest', () => {
  for (const key of ['assessment_id', 'accepted_manifest_hash']) {
    const value = { ...accepted }; delete value[key]; assert.equal(snapshot(value), false);
  }
});
test('internal evidence snapshots cannot leak paths, staff notes or unknown binding fields', () => {
  for (const value of [{ ...accepted, storage_key: 'private/file' },
    { ...accepted, evidence: { ...accepted.evidence, staff_note: 'private' } },
    { ...accepted, binding: { ...accepted.binding, customer_email: 'private@example.invalid' } }]) {
    assert.equal(snapshot(value), false);
  }
});
test('customer evidence claims require dedicated audience and purpose, never generic workflow write power', () => {
  const value = { accessVersion: '1', workflow: { workflowId: 'refund-1' },
    tenant: { tenantId: 'tenant-test', environmentId: 'test' }, subject: { customerId: 'customer-test' },
    purpose: 'refund_evidence_upload', request: { requestId: 'request-1', traceId: 'trace-1' },
    iss: 'customer-service-os-edge', aud: 'human-operations-evidence', iat: 100, exp: 160 };
  assert.equal(claims(value), true, ajv.errorsText(claims.errors));
  assert.equal(claims({ ...value, aud: 'human-operations' }), false);
  assert.equal(claims({ ...value, purpose: 'refund_execute' }), false);
  assert.equal(claims({ ...value, staffId: 'forged' }), false);
});
