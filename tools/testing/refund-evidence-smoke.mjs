#!/usr/bin/env node
/**
 * Explicit, local-only photo-evidence smoke test. No model/Gateway/Vendure calls.
 * Uses real refundWorkflow, activity factory, v2 policy, Edge and Human Operations.
 * Only commerce facts are synthetic; execute/reconcile throw if ever attempted.
 * Creates a unique workflow/queue, real synthetic evidence case and two tiny PNGs.
 * A second, immediately denied synthetic workflow checks customer ownership.
 * Retains synthetic case/audit/photo records for the normal retention process.
 *
 * No network: node tools/testing/refund-evidence-smoke.mjs --check
 * Explicit execution: node tools/testing/refund-evidence-smoke.mjs --run --hold-seconds=60
 * READY hold is BEFORE automatic upload. Browser inspection must be read-only.
 * Never approve/confirm a refund: final cleanup reclaims and REJECTS the takeover.
 * Prefer Node 22.21.0 if local Temporal Worker startup stalls on Node 24.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repository = new URL('../../', import.meta.url);
const workerDirectory = new URL('apps/services/workflow-workers/', repository);
const humanDirectory = new URL('apps/services/human-operations/', repository);
const requireWorker = createRequire(new URL('package.json', workerDirectory));
const requireHuman = createRequire(new URL('package.json', humanDirectory));
const fixtureId = randomUUID();
const workflowId = `refund-evidence-smoke-${fixtureId}`;
const foreignWorkflowId = `refund-evidence-owner-check-${fixtureId}`;
const taskQueue = `refund-evidence-smoke-queue-${fixtureId}`;
const orderId = `evidence-smoke-NO-PROVIDER-${fixtureId}`;
const otherOrderId = `evidence-smoke-DENIED-${fixtureId}`;
let currentCheck = 'arguments';
let executeAttempts = 0;
let reconcileAttempts = 0;
let factRefreshes = 0;
let forbiddenNetworkAttempts = 0;
let lastHttpStatus;
let caseId;
let clientConnection;
let nativeConnection;
let originalFetch;

function checked(condition, message) { assert.ok(condition, message); }
function configAt(path) { return parseEnv(readFileSync(new URL(path, repository), 'utf8')); }
function localUrl(value, port) {
  const url = new URL(value);
  checked(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === String(port) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'Only the configured local development service is permitted.');
  return url;
}

function assertPublicEvidence(evidence) {
  const summaryKeys = ['version', 'requirement', 'evidence_version', 'assessment', 'can_upload', 'attachments', 'customer_message_code'];
  const photoKeys = ['evidence_id', 'display_label', 'byte_size', 'uploaded_at', 'technical_status', 'content_type', 'width', 'height', 'rejection_code'];
  checked(evidence && Object.keys(evidence).every(key => summaryKeys.includes(key)), 'Unexpected customer evidence field.');
  assert.equal(evidence.version, 'v1'); assert.equal(evidence.requirement, 'DAMAGE_PHOTO');
  checked(Number.isSafeInteger(evidence.evidence_version) && evidence.evidence_version >= 0, 'Invalid evidence revision.');
  checked(['UNREVIEWED', 'ACCEPTED', 'MORE_REQUIRED'].includes(evidence.assessment), 'Invalid assessment.');
  checked(typeof evidence.can_upload === 'boolean' && Array.isArray(evidence.attachments) && evidence.attachments.length <= 5, 'Invalid photo collection.');
  for (const photo of evidence.attachments) {
    checked(Object.keys(photo).every(key => photoKeys.includes(key)), 'Private photo fields leaked.');
    checked(/^Photo [1-5]$/.test(photo.display_label), 'Unsafe photo label.');
    if (photo.technical_status === 'READY') {
      checked(['image/png', 'image/jpeg'].includes(photo.content_type) && photo.width > 0 && photo.height > 0, 'Invalid normalized photo.');
    }
  }
  checked(!JSON.stringify(evidence).includes('SYNTHETIC_STAFF_NOTE'), 'Internal staff note reached the customer.');
  return evidence;
}

async function waitUntil(check, predicate, timeoutMilliseconds = 65_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  do {
    const value = await check();
    if (predicate(value)) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('SMOKE_WAIT_TIMEOUT');
}

async function main() {
  const args = process.argv.slice(2);
  const holdArgs = args.filter(value => value.startsWith('--hold-seconds='));
  const holdSeconds = Number(holdArgs[0]?.split('=')[1] ?? 0);
  checked(holdArgs.length <= 1 && Number.isInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 180
    && args.every(value => ['--run', '--check', '--help'].includes(value) || holdArgs.includes(value))
    && !(args.includes('--run') && args.includes('--check')), 'Use --check or --run with optional --hold-seconds=0..180.');
  const mode = args.includes('--run') ? 'run' : args.includes('--check') ? 'check' : 'help';
  if (mode === 'help') {
    console.log('Usage: node tools/testing/refund-evidence-smoke.mjs --check | --run [--hold-seconds=0..180]');
    return;
  }

  currentCheck = 'local_configuration';
  // Secrets remain local variables. Never assign them to process.env or print config/errors.
  const edgeConfig = configAt('apps/services/edge-api/.env');
  const workerConfig = configAt('apps/services/workflow-workers/.env');
  const humanConfig = configAt('apps/services/human-operations/.env');
  const customerToken = configAt('apps/web/customer-portal/.env.local').CSO_LOCAL_CUSTOMER_TOKEN;
  const address = workerConfig.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  checked(['127.0.0.1:7233', 'localhost:7233'].includes(address), 'Temporal must be local.');
  checked([edgeConfig, humanConfig].every(config => (config.TEMPORAL_ADDRESS ?? '127.0.0.1:7233') === address), 'Temporal configurations do not match.');
  for (const field of ['TENANT_ID', 'ENVIRONMENT_ID']) {
    checked(Boolean(workerConfig[field]) && edgeConfig[field] === workerConfig[field] && humanConfig[field] === workerConfig[field], 'Service ownership configurations do not match.');
  }
  checked(Boolean(customerToken) && Boolean(edgeConfig.LOCAL_CUSTOMER_ID), 'Existing customer authentication is required.');
  checked((humanConfig.LOCAL_HUMAN_ROLE ?? 'REFUND_SUPERVISOR') === 'REFUND_SUPERVISOR', 'This test requires the configured supervisor identity for safe takeover rejection.');
  checked(Boolean(humanConfig.REFUND_EVIDENCE_STORAGE_DIR) && Boolean(humanConfig.CONTEXT_ASSERTION_HMAC_SECRET), 'Human Operations evidence configuration must be installed first.');
  checked(workerConfig.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET?.length >= 32
    && workerConfig.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET === humanConfig.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET, 'Worker/Human Operations signing configuration does not match.');
  checked(edgeConfig.CONTEXT_ASSERTION_HMAC_SECRET === humanConfig.CONTEXT_ASSERTION_HMAC_SECRET, 'Edge/Human Operations evidence signing configuration does not match.');
  checked((workerConfig.HUMAN_OPERATIONS_WORKFLOW_ISSUER ?? 'customer-service-os-workflow-workers') === (humanConfig.HUMAN_OPERATIONS_WORKFLOW_ISSUER ?? 'customer-service-os-workflow-workers'), 'Worker issuer configuration does not match.');
  checked((edgeConfig.CONTEXT_ASSERTION_ISSUER ?? 'customer-service-os-edge') === (humanConfig.CONTEXT_ASSERTION_ISSUER ?? 'customer-service-os-edge'), 'Edge issuer configuration does not match.');
  const edgeBase = localUrl(`http://127.0.0.1:${edgeConfig.PORT ?? 3000}`, 3000);
  const humanBase = localUrl(workerConfig.HUMAN_OPERATIONS_BASE_URL, 3003);
  localUrl(edgeConfig.HUMAN_OPERATIONS_BASE_URL ?? 'http://127.0.0.1:3003', 3003);
  checked(Number(humanConfig.PORT ?? 3003) === 3003, 'Human Operations must use its local development port.');

  currentCheck = 'real_source_imports';
  const { tsImport } = requireWorker('tsx/esm/api');
  const source = path => tsImport(new URL(path, repository).href, import.meta.url);
  const [factory, policy, caseClientModule, evidenceModule, assertionModule, humanAuth, customerAuth] = await Promise.all([
    source('apps/services/workflow-workers/src/refund-workflow-activities.ts'),
    source('apps/services/workflow-workers/src/refund-policy-release.ts'),
    source('apps/services/workflow-workers/src/human-operations-case-client.ts'),
    source('apps/services/workflow-workers/src/refund-evidence-client.ts'),
    source('apps/services/workflow-workers/src/workflow-access-assertion.ts'),
    source('apps/services/human-operations/src/local-human-access.ts'),
    source('apps/services/edge-api/src/local-customer-auth.ts'),
  ]);
  const identity = await customerAuth.createLocalCustomerIdentityVerifier({
    secret: edgeConfig.LOCAL_AUTH_HMAC_SECRET,
    expectedIssuer: edgeConfig.LOCAL_AUTH_ISSUER ?? 'customer-service-os-local-auth',
    expectedAudience: edgeConfig.LOCAL_AUTH_AUDIENCE ?? 'customer-service-os-edge',
    expectedTenantId: edgeConfig.TENANT_ID, expectedEnvironmentId: edgeConfig.ENVIRONMENT_ID,
  })(customerToken);
  checked(identity.customerId === edgeConfig.LOCAL_CUSTOMER_ID, 'Customer token must match configured ownership.');
  const staffId = humanConfig.LOCAL_HUMAN_STAFF_ID ?? 'local-refund-supervisor';
  const staffAssertion = await humanAuth.signLocalHumanAccessAssertion({
    secret: humanConfig.HUMAN_ACCESS_HMAC_SECRET,
    issuer: humanConfig.HUMAN_ACCESS_ISSUER ?? 'customer-service-os-human-operations', audience: 'human-operations',
    identity: { staffId, tenantId: humanConfig.TENANT_ID, environmentId: humanConfig.ENVIRONMENT_ID, role: humanConfig.LOCAL_HUMAN_ROLE ?? 'REFUND_SUPERVISOR' },
    expiresInSeconds: 600,
  });
  const sharp = requireHuman('sharp');
  const pngs = await Promise.all(['#246a73', '#9a542a'].map(background => sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()));
  checked(pngs.every(bytes => bytes.length > 0 && bytes.length < 4096), 'Synthetic PNG generation failed.');

  // Defense in depth: every HTTP client is pinned to Edge or Human Operations.
  originalFetch = globalThis.fetch;
  const guardedFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const allowed = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && ['3000', '3003'].includes(url.port) && !url.username && !url.password;
    if (!allowed || mode !== 'run') { forbiddenNetworkAttempts++; throw new Error('SMOKE_FORBIDDEN_NETWORK'); }
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  globalThis.fetch = guardedFetch;
  const signer = assertionModule.createHmacWorkflowAccessAssertionSigner({
    secret: workerConfig.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET,
    issuer: workerConfig.HUMAN_OPERATIONS_WORKFLOW_ISSUER ?? 'customer-service-os-workflow-workers', audience: 'human-operations',
  });
  const clientOptions = { baseUrl: humanBase.href, signWorkflowAccessAssertion: signer,
    expectedTenantId: workerConfig.TENANT_ID, expectedEnvironmentId: workerConfig.ENVIRONMENT_ID, fetchImpl: guardedFetch };
  const cases = caseClientModule.createHumanOperationsCaseClient(clientOptions);
  const evidenceClient = evidenceModule.createRefundEvidenceClient(clientOptions);
  const access = { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, requestId: randomUUID(), traceId: randomUUID() };
  const proposal = { proposalId: `evidence-smoke-proposal-${fixtureId}`, journeyType: 'REFUND',
    intent: { orderId, reasonCode: 'DAMAGED', scope: 'FULL_ORDER', itemIds: [], requestedAmount: { amountMinor: 5309, currency: 'USD' } } };
  const evidenceAccess = { proposal, workflowId, access, policyVersion: 'refund-policy-v2' };
  const { ApplicationFailure } = requireWorker('@temporalio/workflow');
  const activities = factory.createRefundWorkflowActivities({
    async fetchRefundContext(input) {
      checked([orderId, otherOrderId].includes(input.proposal.intent.orderId), 'Only synthetic commerce facts may be read.');
      factRefreshes++;
      return { observationId: `evidence-smoke-facts-${randomUUID()}`, observedAt: new Date().toISOString(),
        source: { provider: 'isolated-smoke-NO-PROVIDER', orderId: input.proposal.intent.orderId, factsVersion: `sha256:${'0'.repeat(64)}` },
        selection: { scope: 'FULL_ORDER', itemIds: [] },
        facts: { customerVerified: true, transactionRefundable: true, itemSelectionValid: true, priorRefundCount: 2,
          refundableAmount: { amountMinor: 5309, currency: 'USD' }, refundDestination: 'ORIGINAL_PAYMENT_METHOD' } };
    },
    async executeRefund() { executeAttempts++; throw ApplicationFailure.nonRetryable('SMOKE_FORBIDS_REFUND_EXECUTION', 'SMOKE_FORBIDDEN_ACTIVITY'); },
    async reconcileRefund() { reconcileAttempts++; throw ApplicationFailure.nonRetryable('SMOKE_FORBIDS_REFUND_RECONCILIATION', 'SMOKE_FORBIDDEN_ACTIVITY'); },
    openHumanCase: cases.openHumanCase, closeHumanCase: cases.closeHumanCase,
    refundPolicyRelease: policy.REFUND_POLICY_V2, getPolicyRelease: policy.getRefundPolicyRelease, evidence: evidenceClient,
    createDecisionContext: () => ({ decisionId: randomUUID(), decidedAt: new Date().toISOString() }),
    createPreviewContext: () => ({ previewId: randomUUID(), createdAt: new Date().toISOString() }),
  });

  currentCheck = 'offline_policy_check';
  const context = await activities.refreshRefundContext(evidenceAccess);
  const before = await activities.evaluateRefundPolicy({ ...evidenceAccess, refundContext: context });
  assert.equal(before.effect, 'NEEDS_FACTS'); assert.deepEqual(before.missingFacts, ['DAMAGE_PHOTO']);
  const after = await activities.evaluateRefundPolicy({ ...evidenceAccess, refundContext: context,
    damageEvidence: { evidenceVersion: 2, assessmentId: randomUUID(), manifestHash: `sha256:${'1'.repeat(64)}`, observedAt: new Date().toISOString() } });
  assert.equal(after.effect, 'TAKEOVER_REQUIRED');
  factRefreshes = 0;
  if (mode === 'check') {
    console.log(JSON.stringify({ status: 'CHECKED', realWorkflowSource: true, realActivitiesAndPolicy: true,
      localTemporalOnly: true, realEvidenceClientsConfigured: true, existingCustomerVerified: true,
      configuredSupervisorVerified: true, syntheticPngCount: pngs.length, missingPhotoEffect: before.effect,
      acceptedPhotoEffect: after.effect, holdSeconds, networkCalls: 0, executeAttempts, reconcileAttempts }));
    return;
  }

  async function request(base, path, init = {}, staff = false, json = true) {
    const headers = new Headers(init.headers);
    headers.set(staff ? 'x-cso-human-assertion' : 'authorization', staff ? staffAssertion : `Bearer ${customerToken}`);
    const response = await guardedFetch(new URL(path, base), { ...init, headers, signal: AbortSignal.timeout(15_000) });
    lastHttpStatus = response.status;
    return { status: response.status, headers: response.headers,
      body: json ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  const edge = (path, init, json) => request(edgeBase, path, init, false, json);
  const staff = (path, init, json) => request(humanBase, path, init, true, json);
  const journeyPath = `/v1/refunds/${workflowId}/journey`;
  const uploadPath = `/v1/refunds/${workflowId}/evidence`;
  const post = (body, key = randomUUID()) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  const upload = (bytes, version, key = randomUUID()) => ({ method: 'POST', headers: { 'content-type': 'image/png', 'idempotency-key': key, 'x-cso-expected-evidence-version': String(version) }, body: bytes });
  const privatePhoto = async response => {
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    checked(response.headers.get('cache-control')?.includes('no-store'), 'Private photo must not be cached.');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const metadata = await sharp(response.body).metadata();
    assert.equal(metadata.width, 16); assert.equal(metadata.height, 16);
  };
  async function getCase() {
    const result = await staff(`/v1/refund-cases/${caseId}`);
    assert.equal(result.status, 200); assert.equal(result.body.refund_case.case_id, caseId);
    return result.body.refund_case;
  }

  currentCheck = 'worker_setup';
  const { Connection, WorkflowClient } = requireWorker('@temporalio/client');
  const { Worker, NativeConnection, Runtime, DefaultLogger } = requireWorker('@temporalio/worker');
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  clientConnection = await Connection.connect({ address });
  nativeConnection = await NativeConnection.connect({ address });
  const client = new WorkflowClient({ connection: clientConnection, namespace: 'default' });
  const worker = await Worker.create({ connection: nativeConnection, namespace: 'default', taskQueue,
    workflowsPath: fileURLToPath(new URL('src/refund-workflow.ts', workerDirectory)), activities });
  await worker.runUntil(async () => {
    currentCheck = 'workflow_start';
    const handle = await client.start('refundWorkflow', { workflowId, taskQueue, workflowExecutionTimeout: `${holdSeconds + 300} seconds`,
      args: [{ orderReference: `EVIDENCE-SMOKE-${fixtureId.slice(0, 8)}`, proposal, policyVersion: 'refund-policy-v2', access }] });
    await waitUntil(() => handle.query('refund.state'), state => state.stage === 'AWAITING_CUSTOMER_EVIDENCE', 30_000);
    const bound = await handle.query('refund.access');
    checked(bound.tenantId === access.tenantId && bound.environmentId === access.environmentId && bound.subjectCustomerId === access.subjectCustomerId, 'Workflow ownership is not bound to the verified customer.');
    caseId = (await evidenceClient.readRefundEvidence(evidenceAccess)).caseId;
    const initial = await edge(journeyPath);
    assert.equal(initial.status, 200); assert.equal(initial.body.next_action.type, 'PROVIDE_EVIDENCE');
    const initialEvidence = assertPublicEvidence(initial.body.evidence);
    assert.equal(initialEvidence.evidence_version, 0); assert.equal(initialEvidence.attachments.length, 0);
    assert.equal(initialEvidence.can_upload, true);
    const initialCase = await getCase();
    assert.equal(initialCase.case_type, 'REFUND_EVIDENCE_REVIEW'); assert.deepEqual(initialCase.allowed_actions, []);
    console.log(JSON.stringify({ status: 'READY', workflowId, caseId, taskQueue, holdSeconds,
      customerUrl: `http://127.0.0.1:3100/refunds/${workflowId}`, staffUrl: `http://127.0.0.1:3101/refund-cases/${caseId}`,
      instruction: 'Read-only browser inspection only. Do not upload, claim, assess, or confirm; API smoke resumes after this hold.' }));
    currentCheck = 'read_only_browser_hold';
    if (holdSeconds) await delay(holdSeconds * 1000);

    currentCheck = 'ownership_negative';
    const foreign = await client.start('refundWorkflow', { workflowId: foreignWorkflowId, taskQueue, workflowExecutionTimeout: '60 seconds',
      args: [{ proposal: { ...proposal, proposalId: `owner-check-${fixtureId}`, intent: { ...proposal.intent, orderId: otherOrderId, reasonCode: 'OTHER', requestedAmount: { amountMinor: 0, currency: 'USD' } } },
        policyVersion: 'refund-policy-v1', access: { ...access, subjectCustomerId: `other-smoke-customer-${fixtureId}` } }] });
    assert.equal((await foreign.result()).stage, 'DENIED');
    assert.equal((await edge(`/v1/refunds/${foreignWorkflowId}/journey`)).status, 404);
    assert.equal((await edge(`/v1/refunds/${foreignWorkflowId}/evidence`, upload(pngs[0], 0))).status, 404);

    currentCheck = 'first_upload_and_idempotency';
    const firstKey = randomUUID();
    const first = await edge(uploadPath, upload(pngs[0], initialEvidence.evidence_version, firstKey));
    assert.equal(first.status, 202);
    const firstEvidence = assertPublicEvidence(first.body.evidence);
    assert.equal(firstEvidence.assessment, 'UNREVIEWED'); assert.equal(firstEvidence.attachments.length, 1);
    const firstPhoto = firstEvidence.attachments[0]; assert.equal(firstPhoto.technical_status, 'READY');
    const replay = await edge(uploadPath, upload(pngs[0], initialEvidence.evidence_version, firstKey));
    assert.equal(replay.status, 202); assert.deepEqual(replay.body.evidence, firstEvidence);
    await privatePhoto(await edge(`${uploadPath}/${firstPhoto.evidence_id}/content`, undefined, false));
    assert.equal((await edge(`/v1/refunds/${foreignWorkflowId}/evidence/${firstPhoto.evidence_id}/content`, undefined, false)).status, 404);
    const underReview = await waitUntil(() => edge(journeyPath), result => result.status === 200 && result.body.stage === 'AWAITING_EVIDENCE_REVIEW');
    assert.equal(underReview.body.next_action.type, 'WAIT_FOR_SPECIALIST');
    checked(!underReview.body.preview, 'A technically validated upload must not create a refund preview.');

    currentCheck = 'staff_claim_and_request_more';
    const beforeClaim = await getCase();
    assert.equal((await staff(`/v1/refund-cases/${caseId}/evidence/${firstPhoto.evidence_id}/content`, undefined, false)).status, 404);
    const claim = await staff(`/v1/refund-cases/${caseId}/claim`, post({ expected_case_version: beforeClaim.case_version }));
    assert.equal(claim.status, 200);
    let claimed = await getCase();
    checked(claimed.assigned_staff_id === staffId, 'Claim must bind the configured staff identity.');
    checked(claimed.allowed_evidence_actions.includes('REQUEST_MORE_EVIDENCE'), 'Request-more action is missing.');
    await privatePhoto(await staff(`/v1/refund-cases/${caseId}/evidence/${firstPhoto.evidence_id}/content`, undefined, false));
    const more = await staff(`/v1/refund-cases/${caseId}/evidence-review`, post({ version: 'v1', action: 'REQUEST_MORE_EVIDENCE',
      expected_case_version: claimed.case_version, expected_evidence_version: claimed.evidence.evidence_version,
      reason_code: 'PHOTO_UNCLEAR', note: 'SYNTHETIC_STAFF_NOTE: plumbing check only; not an assessment of a real item.' }));
    assert.equal(more.status, 200); assert.equal(more.body.refund_case.case_id, caseId);
    assert.equal(more.body.refund_case.evidence.assessment, 'MORE_REQUIRED');
    const moreJourney = await waitUntil(() => edge(journeyPath), result => result.status === 200 && result.body.stage === 'AWAITING_CUSTOMER_EVIDENCE');
    const moreEvidence = assertPublicEvidence(moreJourney.body.evidence);
    assert.equal(moreEvidence.customer_message_code, 'PHOTO_UNCLEAR'); assert.equal(moreEvidence.can_upload, true);

    currentCheck = 'replacement_upload_and_acceptance';
    const second = await edge(uploadPath, upload(pngs[1], moreEvidence.evidence_version));
    assert.equal(second.status, 202);
    const secondEvidence = assertPublicEvidence(second.body.evidence);
    const secondPhoto = secondEvidence.attachments.find(photo => photo.evidence_id !== firstPhoto.evidence_id && photo.technical_status === 'READY');
    checked(secondPhoto, 'The replacement photo is not ready.');
    await privatePhoto(await edge(`${uploadPath}/${secondPhoto.evidence_id}/content`, undefined, false));
    claimed = await getCase();
    checked(claimed.allowed_evidence_actions.includes('ACCEPT_EVIDENCE'), 'Acceptance must require a claimed, ready evidence set.');
    const accepted = await staff(`/v1/refund-cases/${caseId}/evidence-review`, post({ version: 'v1', action: 'ACCEPT_EVIDENCE',
      expected_case_version: claimed.case_version, expected_evidence_version: claimed.evidence.evidence_version,
      reason_code: 'DAMAGE_VISIBLE', note: 'SYNTHETIC_STAFF_NOTE: generated test pixels only; no real damage decision.' }));
    assert.equal(accepted.status, 200);
    const acceptedEvidence = assertPublicEvidence(accepted.body.refund_case.evidence);
    assert.equal(acceptedEvidence.assessment, 'ACCEPTED'); assert.equal(acceptedEvidence.can_upload, false);
    checked(acceptedEvidence.attachments.some(photo => photo.evidence_id === secondPhoto.evidence_id), 'Accepted set lost the replacement photo.');
    checked(!acceptedEvidence.attachments.some(photo => photo.evidence_id === firstPhoto.evidence_id), 'Superseded photo remained in the accepted set.');
    assert.equal((await edge(uploadPath, upload(pngs[0], acceptedEvidence.evidence_version))).status, 409);

    currentCheck = 'same_case_takeover_transition';
    const takeover = await waitUntil(getCase, value => value.case_type === 'REFUND_TAKEOVER');
    assert.equal(takeover.case_id, caseId); assert.equal(takeover.status, 'OPEN');
    checked(takeover.assigned_staff_id === undefined || takeover.assigned_staff_id === null, 'Evidence claim must not carry into monetary takeover.');
    assert.deepEqual(takeover.allowed_actions, []); assert.deepEqual(takeover.allowed_evidence_actions, []);
    const takeoverState = await waitUntil(() => handle.query('refund.state'), value => value.stage === 'HUMAN_TAKEOVER_REQUIRED');
    checked(takeoverState.decision.factRefs.some(ref => ref.factType === 'ACCEPTED_DAMAGE_EVIDENCE'), 'Policy must reference trusted accepted evidence.');
    checked(!takeoverState.preview, 'Evidence acceptance must not create a takeover refund preview.');

    currentCheck = 'safe_rejection_cleanup';
    const reClaim = await staff(`/v1/refund-cases/${caseId}/claim`, post({ expected_case_version: takeover.case_version }));
    assert.equal(reClaim.status, 200);
    const monetaryCase = reClaim.body.refund_case;
    checked(monetaryCase.allowed_actions.includes('REJECT'), 'Configured supervisor must be able to safely reject the synthetic takeover.');
    const rejected = await staff(`/v1/refund-cases/${caseId}/decision`, post({ decision: 'REJECT', reason_code: 'SYNTHETIC_SMOKE_NO_REFUND',
      note: 'Synthetic smoke test cleanup. No real order, damage claim, or refund is authorized.', expected_case_version: monetaryCase.case_version }));
    assert.equal(rejected.status, 202);
    const terminal = await waitUntil(() => handle.query('refund.state'), value => value.stage === 'REJECTED', 30_000);
    assert.equal((await handle.result()).stage, 'REJECTED');
    const closed = await getCase(); assert.equal(closed.status, 'CLOSED');
    const finalJourney = await edge(journeyPath); assert.equal(finalJourney.status, 200);
    assert.equal(finalJourney.body.next_action.type, 'NONE'); assertPublicEvidence(finalJourney.body.evidence);

    currentCheck = 'history_safety_checks';
    const history = await handle.fetchHistory();
    const events = history.events ?? [];
    const activityNames = events.flatMap(event => event.activityTaskScheduledEventAttributes?.activityType?.name ?? []);
    const executeScheduled = activityNames.filter(name => name === 'executeRefund' || name === 'reconcileRefund').length;
    const confirmationSignals = events.filter(event => event.workflowExecutionSignaledEventAttributes?.signalName === 'refund.confirmation').length;
    checked(activityNames.includes('openRefundEvidence') && activityNames.includes('readRefundEvidence') && activityNames.includes('transitionRefundEvidence'), 'Expected real evidence activity lifecycle.');
    assert.equal(activityNames.filter(name => name === 'openHumanCase').length, 0, 'Evidence recovery must reuse the same case.');
    checked(factRefreshes >= 3, 'Policy must refresh commerce facts after accepted evidence.');
    assert.equal(executeAttempts, 0); assert.equal(reconcileAttempts, 0); assert.equal(executeScheduled, 0);
    assert.equal(confirmationSignals, 0); assert.equal(forbiddenNetworkAttempts, 0);
    console.log(JSON.stringify({ status: 'PASSED', workflowId, foreignWorkflowId, caseId, taskQueue, terminalStage: terminal.stage,
      sameCaseTakeover: true, assignmentClearedBeforeReclaim: true, requestMoreThenAccept: true, supersededPhotoExcluded: true,
      ownershipDenied: true, privateContentVerified: true, idempotentUploadVerified: true, realActivityFactory: true,
      realPolicyVersion: 'refund-policy-v2', factRefreshes, executeAttempts, reconcileAttempts, executeScheduled, confirmationSignals,
      retainedArtifacts: 'Synthetic closed case, evidence files and audit/history remain subject to normal retention.' }));
  });
}

try { await main(); }
catch (error) {
  // Error payloads can contain identity or assertion context; emit only bounded diagnostics.
  console.error(JSON.stringify({ status: 'FAILED', workflowId, ...(caseId ? { caseId } : {}), check: currentCheck,
    errorName: error instanceof Error ? error.name : 'Error', lastHttpStatus, executeAttempts, reconcileAttempts, forbiddenNetworkAttempts,
    instruction: 'Inspect this synthetic workflow/case only. Do not approve a refund. No automatic destructive cleanup is performed on failure.' }));
  process.exitCode = 1;
} finally {
  await nativeConnection?.close();
  await clientConnection?.close();
  if (originalFetch) globalThis.fetch = originalFetch;
}
