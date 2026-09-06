import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HUMAN_ASSERTION_HEADER, type HumanAccess } from './human-access.js';
import { refundReviewPacketSchema, type HumanCase } from './human-case.js';
import { HumanCaseRepositoryError, type HumanCaseRepository } from './human-case-repository.js';
import { WORKFLOW_ASSERTION_HEADER, type VerifyWorkflowCaseAccess, type WorkflowCaseAccess } from './workflow-access.js';
import { EVIDENCE_ASSERTION_HEADER, type CustomerEvidenceAccess, type EvidencePurpose, type VerifyEvidenceAccess } from './refund-evidence-access.js';
import { PrivateEvidenceStore, validatePhoto } from './private-evidence-store.js';
import { EvidenceError, MAX_PHOTO_BYTES, canReviewEvidence, digest, evidenceReviewSchema, evidenceSnapshot, evidenceWorkflowId, expectedVersion, opaqueId, type EvidenceRecord, type RefundEvidenceRepository } from './refund-evidence.js';

export type EvidenceRoutesOptions = {
  repository: RefundEvidenceRepository;
  store: PrivateEvidenceStore;
  verifyCustomer: VerifyEvidenceAccess;
};
const paramsSchema = z.object({ workflowId: evidenceWorkflowId });
const contentParamsSchema = paramsSchema.extend({ evidenceId: z.uuid() });
const caseParamsSchema = z.object({ caseId: opaqueId, evidenceId: z.uuid().optional() });
const keySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ensureSchema = z.object({
  workflow_id: evidenceWorkflowId, order_id: opaqueId, proposal_id: opaqueId,
  // Empty selection is the canonical FULL_ORDER proposal; order/proposal binding remains mandatory.
  selected_item_ids: z.array(opaqueId).max(100).refine(ids => new Set(ids).size === ids.length),
  review_packet: refundReviewPacketSchema, policy_version: opaqueId,
}).strict().refine(value => value.policy_version === value.review_packet.policy_version
  && JSON.stringify([...value.selected_item_ids].sort()) === JSON.stringify([...(value.review_packet.selected_item_ids ?? [])].sort()));
const transitionSchema = z.object({
  case_type: z.enum(['REFUND_APPROVAL', 'REFUND_TAKEOVER']), review_packet: refundReviewPacketSchema,
  policy_version: opaqueId, expected_evidence_version: expectedVersion.min(1),
}).strict();
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]; return typeof value === 'string' ? value : undefined;
}
function idempotencyKey(request: FastifyRequest): string {
  const parsed = keySchema.safeParse(header(request, 'idempotency-key'));
  if (!parsed.success) throw new EvidenceError('invalid_evidence', 400);
  return parsed.data;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EvidenceError('invalid_evidence', 400);
  return parsed.data;
}
function fail(reply: FastifyReply, error: unknown) {
  const known = error instanceof EvidenceError ? error
    : error instanceof HumanCaseRepositoryError && error.code === 'CASE_NOT_FOUND'
      ? new EvidenceError('evidence_not_found', 404) : new EvidenceError('evidence_unavailable', 503);
  return reply.code(known.status).send({ error: { code: known.code, message: 'Photo evidence request could not be completed' } });
}
export async function evidenceCaseFields(options: EvidenceRoutesOptions, humanCase: HumanCase, access?: HumanAccess) {
  try {
    const record = await options.repository.get({ tenantId: humanCase.tenantId, environmentId: humanCase.environmentId }, humanCase.workflowId);
    return { evidence: evidenceSnapshot(record).evidence,
      allowed_evidence_actions: access && canReviewEvidence(access, record) ? ['ACCEPT_EVIDENCE', 'REQUEST_MORE_EVIDENCE'] : [] };
  } catch (error) {
    if (error instanceof EvidenceError && error.status === 404 && humanCase.caseType !== 'REFUND_EVIDENCE_REVIEW') return {};
    throw error;
  }
}

export function registerEvidenceRoutes(app: FastifyInstance, options: EvidenceRoutesOptions, dependencies: {
  cases: HumanCaseRepository;
  verifyHuman: (assertion: string | undefined) => Promise<HumanAccess>;
  verifyWorkflow: VerifyWorkflowCaseAccess | undefined;
  caseResponse: (humanCase: HumanCase, access?: HumanAccess) => Promise<unknown>;
}) {
  async function customer(request: FastifyRequest, purpose: EvidencePurpose): Promise<CustomerEvidenceAccess> {
    try { return await options.verifyCustomer(header(request, EVIDENCE_ASSERTION_HEADER), purpose); }
    catch { throw new EvidenceError('evidence_unauthorized', 401); }
  }
  async function worker(request: FastifyRequest, purpose: WorkflowCaseAccess['purpose']): Promise<WorkflowCaseAccess> {
    if (!dependencies.verifyWorkflow) throw new EvidenceError('evidence_unavailable', 503);
    try { return await dependencies.verifyWorkflow(header(request, WORKFLOW_ASSERTION_HEADER), purpose); }
    catch { throw new EvidenceError('evidence_unauthorized', 401); }
  }
  function sameWorkflow(access: { workflowId: string }, workflowId: string) {
    if (access.workflowId !== workflowId) throw new EvidenceError('evidence_not_found', 404);
  }
  async function staff(request: FastifyRequest, caseId: string) {
    let access: HumanAccess;
    try { access = await dependencies.verifyHuman(header(request, HUMAN_ASSERTION_HEADER)); }
    catch { throw new EvidenceError('evidence_unauthorized', 401); }
    const humanCase = await dependencies.cases.get({ ...access, caseId });
    const eligible = ['REFUND_APPROVER','REFUND_SUPERVISOR'].includes(access.role) && (humanCase.caseType === 'REFUND_EVIDENCE_REVIEW'
      || (humanCase.caseType === 'REFUND_APPROVAL' ? access.role === 'REFUND_APPROVER' : access.role === 'REFUND_SUPERVISOR'));
    if (!eligible || humanCase.assignedStaffId !== access.staffId || !['CLAIMED','DECISION_PENDING','CLOSED'].includes(humanCase.status))
      throw new EvidenceError('evidence_not_found', 404);
    return { access, humanCase };
  }
  async function content(reply: FastifyReply, record: EvidenceRecord, evidenceId: string) {
    const photo = record.document.attachments.find(photo => photo.evidence_id === evidenceId && !photo.purged && !photo.superseded && photo.technical_status === 'READY');
    if (!photo?.sha256 || record.document.retired) throw new EvidenceError('evidence_not_found', 404);
    const bytes = await options.store.read(photo.storageKey, photo.sha256);
    return reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").type(photo.content_type!).send(bytes);
  }
  async function authoritativeSnapshot(record: EvidenceRecord) {
    const snapshot = evidenceSnapshot(record);
    // Acceptance is not sufficient if its retained normalized objects are unavailable.
    // Only accepted reads incur this bounded (maximum25MiB) integrity check.
    if (snapshot.evidence.assessment === 'ACCEPTED') {
      for (const photo of record.document.attachments.filter(photo => photo.technical_status === 'READY' && !photo.purged && !photo.superseded)) {
        if (!photo.sha256) throw new EvidenceError('evidence_unavailable',503);
        await options.store.read(photo.storageKey,photo.sha256);
      }
    }
    return snapshot;
  }
  app.post('/internal/v1/refund-evidence/collections', async (request, reply) => {
    try {
      const access = await worker(request, 'refund_evidence_open');
      const body = parse(ensureSchema, request.body); sameWorkflow(access, body.workflow_id);
      const snapshot = await options.repository.ensure({ scope: access, workflowId: body.workflow_id, order_id: body.order_id,
        proposal_id: body.proposal_id, selected_item_ids: body.selected_item_ids, policy_version: body.policy_version,
        reviewPacket: body.review_packet, idempotencyKey: idempotencyKey(request) });
      return reply.code(201).send(snapshot.evidence.assessment === 'ACCEPTED' ? await authoritativeSnapshot(await options.repository.get(access,body.workflow_id)) : snapshot);
    } catch (error) { return fail(reply, error); }
  });
  app.get('/internal/v1/refund-evidence/:workflowId', async (request, reply) => {
    try {
      const access = await worker(request, 'refund_evidence_read');
      const params = parse(paramsSchema, request.params); sameWorkflow(access, params.workflowId);
      return reply.header('Cache-Control', 'private, no-store').send(await authoritativeSnapshot(await options.repository.get(access, params.workflowId)));
    } catch (error) { return fail(reply, error); }
  });
  app.post('/internal/v1/refund-evidence/:workflowId/transition', async (request, reply) => {
    try {
      const access = await worker(request, 'human_case_transition');
      const params = parse(paramsSchema, request.params); sameWorkflow(access, params.workflowId);
      const body = parse(transitionSchema, request.body);
      await authoritativeSnapshot(await options.repository.get(access,params.workflowId));
      const snapshot = await options.repository.transition({ scope: access, workflowId: params.workflowId, caseType: body.case_type,
        reviewPacket: body.review_packet, policyVersion: body.policy_version, expectedEvidenceVersion: body.expected_evidence_version, idempotencyKey: idempotencyKey(request) });
      return reply.send({ refund_case: await dependencies.caseResponse(await dependencies.cases.get({ ...access,caseId:snapshot.case_id })) });
    } catch (error) { return fail(reply, error); }
  });
  app.get('/internal/v1/customer-refund-evidence/:workflowId', async (request, reply) => {
    try {
      const access = await customer(request, 'refund_evidence_read');
      const params = parse(paramsSchema, request.params); sameWorkflow(access, params.workflowId);
      return reply.header('Cache-Control', 'private, no-store').send({ evidence: evidenceSnapshot(await options.repository.get(access, params.workflowId)).evidence });
    } catch (error) { return fail(reply, error); }
  });
  // Authenticate and cap concurrent requests BEFORE Fastify buffers any upload bytes.
  type UploadLease = { access: CustomerEvidenceAccess; processing: boolean; dispose: () => void };
  const uploads = new WeakMap<FastifyRequest, UploadLease>();
  let activeUploads = 0;
  function releaseUpload(request: FastifyRequest) {
    const lease = uploads.get(request);
    // A disconnected client does not cancel an in-flight decode/storage transaction.
    // The handler's finally releases that lease after the work actually settles.
    if (!lease || lease.processing) return;
    uploads.delete(request);activeUploads--;lease.dispose();
  }
  app.addContentTypeParser(['image/jpeg','image/png'], { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES }, (_request, body, done) => done(null, body));
  app.post('/internal/v1/customer-refund-evidence/:workflowId', {
    bodyLimit: MAX_PHOTO_BYTES,
    onRequest: async (request, reply) => {
      try {
        const access = await customer(request, 'refund_evidence_upload');
        const params = parse(paramsSchema, request.params); sameWorkflow(access, params.workflowId);
        await options.repository.get(access, params.workflowId);
        // The client may disconnect while authorization/ownership checks are awaited.
        if (request.raw.aborted || reply.raw.destroyed) return reply;
        if (activeUploads >= 4) throw new EvidenceError('evidence_unavailable',503);
        const onDisconnect = () => releaseUpload(request);
        const onRequestClose = () => { if (request.raw.aborted || !request.raw.complete) onDisconnect(); };
        const lease: UploadLease = { access,processing:false,dispose:()=>{
          request.raw.removeListener('aborted',onDisconnect);
          request.raw.removeListener('close',onRequestClose);
          reply.raw.removeListener('close',onDisconnect);
        } };
        uploads.set(request,lease);activeUploads++;
        request.raw.once('aborted',onDisconnect);
        request.raw.once('close',onRequestClose);
        reply.raw.once('close',onDisconnect);
      } catch (error) { return fail(reply,error); }
    },
    onResponse: async request => { releaseUpload(request); },
    onRequestAbort: async request => { releaseUpload(request); },
    onTimeout: async request => { releaseUpload(request); },
    errorHandler: (error, _request, reply) => fail(reply,
      error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? new EvidenceError('evidence_too_large',413)
      : error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? new EvidenceError('unsupported_evidence_type',415)
      : new EvidenceError('invalid_evidence',400)),
  }, async (request, reply) => {
    const lease = uploads.get(request);
    if (lease) lease.processing = true;
    try {
      const access = lease?.access;
      if (!access) throw new EvidenceError('evidence_unauthorized',401);
      const contentType = header(request,'content-type')?.split(';')[0];
      if (contentType !== 'image/jpeg' && contentType !== 'image/png') throw new EvidenceError('unsupported_evidence_type',415);
      const revisionHeader = header(request,'x-cso-expected-evidence-version');
      if (!revisionHeader || !/^(0|[1-9]\d*)$/.test(revisionHeader)) throw new EvidenceError('invalid_evidence',400);
      const revision = parse(expectedVersion, Number(revisionHeader));
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new EvidenceError('invalid_evidence',400);
      const bytes = request.body;
      if (bytes.length > MAX_PHOTO_BYTES) throw new EvidenceError('evidence_too_large',413);
      const fingerprint = digest(JSON.stringify({ revision, contentType, sha256: digest(bytes) }));
      const reservation = await options.repository.beginUpload({ scope: access, workflowId: access.workflowId, expectedRevision: revision,
        idempotencyKey: idempotencyKey(request), fingerprint, byteSize: bytes.length, contentType });
      if (!reservation.created) return reply.code(202).send({ evidence: evidenceSnapshot(reservation.record).evidence });
      let result: Parameters<RefundEvidenceRepository['finishUpload']>[3];
      try {
        const normalized = await validatePhoto(bytes,contentType);
        await options.store.put(reservation.photo.storageKey,normalized.bytes);
        result = { contentType: normalized.contentType, byteSize: normalized.bytes.length, width: normalized.width, height: normalized.height, sha256: normalized.sha256 };
      } catch (error) {
        const rejectionCode = error instanceof EvidenceError && ['FILE_TOO_LARGE','INVALID_IMAGE','IMAGE_LIMIT_EXCEEDED'].includes(error.code)
          ? error.code as 'FILE_TOO_LARGE' | 'INVALID_IMAGE' | 'IMAGE_LIMIT_EXCEEDED' : 'VALIDATION_UNAVAILABLE';
        result = { rejectionCode };
      }
      const snapshot = await options.repository.finishUpload(access,access.workflowId,reservation.photo.evidence_id,result);
      return reply.code(202).header('Cache-Control','private, no-store').send({ evidence: snapshot.evidence });
    } catch (error) { return fail(reply,error); }
    finally { if (lease) { lease.processing=false;releaseUpload(request); } }
  });
  app.get('/internal/v1/customer-refund-evidence/:workflowId/:evidenceId/content', async (request,reply) => {
    try {
      const access = await customer(request,'refund_evidence_content');
      const params = parse(contentParamsSchema,request.params); sameWorkflow(access,params.workflowId);
      return await content(reply,await options.repository.get(access,params.workflowId),params.evidenceId);
    } catch (error) { return fail(reply,error); }
  });
  app.get('/v1/refund-cases/:caseId/evidence/:evidenceId/content', async (request,reply) => {
    try {
      const params = parse(caseParamsSchema,request.params);
      const {access,humanCase} = await staff(request,params.caseId);
      return await content(reply,await options.repository.get(access,humanCase.workflowId),params.evidenceId!);
    } catch (error) { return fail(reply,error); }
  });
  app.post('/v1/refund-cases/:caseId/evidence-review', async (request,reply) => {
    try {
      const params = parse(caseParamsSchema,request.params);
      const {access,humanCase} = await staff(request,params.caseId);
      const command = parse(evidenceReviewSchema,request.body);
      await options.repository.review({ scope: access, workflowId: humanCase.workflowId, access, command, idempotencyKey: idempotencyKey(request) });
      return reply.send({ refund_case: await dependencies.caseResponse(await dependencies.cases.get({...access,caseId:params.caseId}),access) });
    } catch (error) { return fail(reply,error); }
  });
}
