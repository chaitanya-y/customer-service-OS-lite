import Fastify from 'fastify';
import { z } from 'zod';

import { humanCaseStatusSchema, humanCaseTypeSchema, humanDecisionSchema, refundReviewPacketSchema, type HumanCase, type HumanCaseAuditEvent, type HumanDecisionOutboxEvent } from './human-case.js';
import { HumanCaseRepositoryError, InMemoryHumanCaseRepository, type HumanCaseRepository } from './human-case-repository.js';
import { HUMAN_ASSERTION_HEADER, type HumanAccess } from './human-access.js';
import { WORKFLOW_ASSERTION_HEADER, type VerifyWorkflowCaseAccess } from './workflow-access.js';

const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const workflowParamsSchema = z.object({ workflowId: opaqueId });
const caseParamsSchema = z.object({ caseId: opaqueId });
const legacyBodySchema = z.object({ decision: humanDecisionSchema, reasonCode: z.string().min(1).max(100).optional() }).strict();
const idempotencyKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const expectedVersionSchema = z.number().int().positive();
const workerOpenCaseSchema = z.object({ workflow_id: opaqueId, case_type: humanCaseTypeSchema, review_packet: refundReviewPacketSchema, policy_version: z.string().min(1).max(200) }).strict();
const workerCloseCaseSchema = z.object({ workflow_id: opaqueId }).strict();
const claimBodySchema = z.object({ expected_case_version: expectedVersionSchema }).strict();
const reassignBodySchema = z.object({ assigned_staff_id: opaqueId, expected_case_version: expectedVersionSchema }).strict();
const decisionBodySchema = z.object({ decision: humanDecisionSchema, reason_code: z.string().min(1).max(100).optional(), note: z.string().min(1).max(2_000).optional(), expected_case_version: expectedVersionSchema }).strict().superRefine((value, context) => {
  if ((value.decision === 'REJECT' || value.decision === 'RESOLVE_TAKEOVER') && !value.note) context.addIssue({ code: 'custom', path: ['note'], message: 'A note is required for this decision' });
});
const listQuerySchema = z.object({ status: humanCaseStatusSchema.optional(), assignee: z.enum(['me', 'unassigned']).optional() }).strict();

export type SendDecision = (input: { workflowId: string; access: HumanAccess; decision: 'APPROVE' | 'REJECT' | 'RESOLVE_TAKEOVER'; reasonCode?: string }) => Promise<void>;

type AppOptions = Readonly<{
  verifyHuman: (value: string | undefined) => Promise<HumanAccess>;
  sendDecision: SendDecision;
  repository?: HumanCaseRepository;
  verifyWorkflowCaseAccess?: VerifyWorkflowCaseAccess;
}>;

export function buildApp(options: AppOptions) {
  const app = Fastify();
  const repository = options.repository ?? new InMemoryHumanCaseRepository();
  app.get('/health', async () => ({ service: 'human-operations', status: 'ok' }));

  app.post('/internal/v1/refund-cases', async (request, reply) => {
    const body = workerOpenCaseSchema.safeParse(request.body);
    const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!body.success || !idempotencyKey) return invalid(reply, 'invalid_human_case', 'Human case is invalid');
    const access = await verifyWorkflow(request, reply, 'human_case_open', options.verifyWorkflowCaseAccess);
    if (!access) return reply;
    if (access.workflowId !== body.data.workflow_id) return forbidden(reply, 'workflow_case_mismatch', 'Workflow identity does not match the requested case');
    try {
      const humanCase = await repository.open({ tenantId: access.tenantId, environmentId: access.environmentId, workflowId: access.workflowId, caseType: body.data.case_type, reviewPacket: body.data.review_packet, policyVersion: body.data.policy_version });
      return reply.code(201).send({ refund_case: toHumanCaseResponse(humanCase) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  app.post('/internal/v1/refund-cases/:caseId/close', async (request, reply) => {
    const params = caseParamsSchema.safeParse(request.params); const body = workerCloseCaseSchema.safeParse(request.body);
    const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotencyKey) return invalid(reply, 'invalid_human_case', 'Human case is invalid');
    const access = await verifyWorkflow(request, reply, 'human_case_close', options.verifyWorkflowCaseAccess);
    if (!access) return reply;
    if (access.workflowId !== body.data.workflow_id) return forbidden(reply, 'workflow_case_mismatch', 'Workflow identity does not match the requested case');
    try {
      const humanCase = await repository.close({ caseId: params.data.caseId, tenantId: access.tenantId, environmentId: access.environmentId, workflowId: access.workflowId });
      return reply.send({ refund_case: toHumanCaseResponse(humanCase) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  app.get('/v1/refund-cases', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(reply, 'invalid_refund_case_query', 'Refund case query is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    const humanCases = await repository.list({
      tenantId: access.tenantId,
      environmentId: access.environmentId,
      staffId: access.staffId,
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.assignee === undefined ? {} : { assignee: query.data.assignee }),
    });
    return reply.send({ refund_cases: humanCases.filter((humanCase) => canViewCase(access, humanCase)).map(toHumanCaseResponse) });
  });

  app.get('/v1/refund-cases/:caseId', async (request, reply) => {
    const params = caseParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, 'invalid_refund_case', 'Refund case is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    try {
      const humanCase = await repository.get({ caseId: params.data.caseId, tenantId: access.tenantId, environmentId: access.environmentId });
      if (!canViewCase(access, humanCase)) return notFound(reply);
      const auditEvents = await repository.auditEvents({ caseId: humanCase.caseId, tenantId: access.tenantId, environmentId: access.environmentId });
      return reply.send({ refund_case: toHumanCaseResponse(humanCase), audit_events: auditEvents.map(toAuditEventResponse) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  app.post('/v1/refund-cases/:caseId/claim', async (request, reply) => {
    const params = caseParamsSchema.safeParse(request.params); const body = claimBodySchema.safeParse(request.body); const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotencyKey) return invalid(reply, 'invalid_refund_case_claim', 'Case claim is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    try {
      const current = await repository.get({ caseId: params.data.caseId, tenantId: access.tenantId, environmentId: access.environmentId });
      if (!canViewCase(access, current)) return forbidden(reply, 'human_action_forbidden', 'This staff role cannot claim the refund case');
      const humanCase = await repository.claim({ caseId: current.caseId, tenantId: access.tenantId, environmentId: access.environmentId, staffId: access.staffId, expectedCaseVersion: body.data.expected_case_version, idempotencyKey });
      return reply.send({ refund_case: toHumanCaseResponse(humanCase) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  app.post('/v1/refund-cases/:caseId/reassign', async (request, reply) => {
    const params = caseParamsSchema.safeParse(request.params); const body = reassignBodySchema.safeParse(request.body); const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotencyKey) return invalid(reply, 'invalid_refund_case_reassignment', 'Case reassignment is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    if (access.role !== 'REFUND_SUPERVISOR') return forbidden(reply, 'human_action_forbidden', 'Only supervisors may reassign a refund case');
    try {
      const humanCase = await repository.reassign({ caseId: params.data.caseId, tenantId: access.tenantId, environmentId: access.environmentId, assignedStaffId: body.data.assigned_staff_id, expectedCaseVersion: body.data.expected_case_version, idempotencyKey });
      return reply.send({ refund_case: toHumanCaseResponse(humanCase) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  app.post('/v1/refund-cases/:caseId/decision', async (request, reply) => {
    const params = caseParamsSchema.safeParse(request.params); const body = decisionBodySchema.safeParse(request.body); const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!params.success || !body.success || !idempotencyKey) return invalid(reply, 'invalid_human_decision', 'Human decision is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    try {
      const current = await repository.get({ caseId: params.data.caseId, tenantId: access.tenantId, environmentId: access.environmentId });
      if (!canMakeDecision(access, current, body.data.decision)) return forbidden(reply, 'human_action_forbidden', 'This staff role cannot make the requested decision');
      const result = await repository.decide({ caseId: current.caseId, tenantId: access.tenantId, environmentId: access.environmentId, staffId: access.staffId, decision: body.data.decision, ...(body.data.reason_code === undefined ? {} : { reasonCode: body.data.reason_code }), ...(body.data.note === undefined ? {} : { note: body.data.note }), expectedCaseVersion: body.data.expected_case_version, idempotencyKey });
      if (await repository.isOutboxPending(result.outboxEvent.eventId)) {
        await deliverOutbox(options.sendDecision, repository, result.outboxEvent, access);
      }
      return reply.code(202).send({ refund_case: toHumanCaseResponse(result.case) });
    } catch (error) { return repositoryFailure(reply, error); }
  });

  // Deprecated compatibility route. New callers must use the governed case-decision endpoint.
  app.post('/internal/v1/refund-workflows/:workflowId/decision', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params); const body = legacyBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, 'invalid_human_decision', 'Human decision is invalid');
    const access = await verifyHuman(request, reply, options.verifyHuman);
    if (!access) return reply;
    try {
      await options.sendDecision({ workflowId: params.data.workflowId, access, decision: body.data.decision, ...(body.data.reasonCode === undefined ? {} : { reasonCode: body.data.reasonCode }) });
      return reply.code(202).send({ workflow_id: params.data.workflowId, status: 'decision_received' });
    } catch { return reply.code(502).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' } }); }
  });

  return app;
}

async function verifyHuman(request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, verifier: AppOptions['verifyHuman']): Promise<HumanAccess | undefined> {
  try { return await verifier(typeof request.headers[HUMAN_ASSERTION_HEADER] === 'string' ? request.headers[HUMAN_ASSERTION_HEADER] : undefined); }
  catch { reply.code(401).send({ error: { code: 'human_unauthorized', message: 'Human authorization is required' } }); return undefined; }
}

async function verifyWorkflow(request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, purpose: 'human_case_open' | 'human_case_close', verifier: VerifyWorkflowCaseAccess | undefined) {
  if (!verifier) { reply.code(503).send({ error: { code: 'workflow_auth_unavailable', message: 'Workflow authorization is unavailable' } }); return undefined; }
  try { return await verifier(typeof request.headers[WORKFLOW_ASSERTION_HEADER] === 'string' ? request.headers[WORKFLOW_ASSERTION_HEADER] : undefined, purpose); }
  catch { reply.code(401).send({ error: { code: 'workflow_unauthorized', message: 'Workflow authorization is required' } }); return undefined; }
}

function canViewCase(access: HumanAccess, humanCase: HumanCase): boolean {
  return access.role === 'REFUND_SUPERVISOR' || humanCase.caseType === 'REFUND_APPROVAL';
}

function canMakeDecision(access: HumanAccess, humanCase: HumanCase, decision: string): boolean {
  if (humanCase.caseType === 'REFUND_APPROVAL') return access.role === 'REFUND_APPROVER' && (decision === 'APPROVE' || decision === 'REJECT');
  return access.role === 'REFUND_SUPERVISOR' && (decision === 'RESOLVE_TAKEOVER' || decision === 'REJECT');
}

async function deliverOutbox(sendDecision: SendDecision, repository: HumanCaseRepository, event: HumanDecisionOutboxEvent, access: HumanAccess): Promise<void> {
  try {
    await sendDecision({ workflowId: event.workflowId, access, decision: event.decision, ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }) });
    await repository.markOutboxDelivered(event.eventId);
  } catch {
    // The event remains available for an outbox dispatcher when Kafka delivery is introduced.
  }
}

function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && idempotencyKeySchema.safeParse(value).success ? value : undefined;
}

function invalid(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, code: string, message: string) { return reply.code(400).send({ error: { code, message } }); }
function forbidden(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, code: string, message: string) { return reply.code(403).send({ error: { code, message } }); }
function notFound(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) { return reply.code(404).send({ error: { code: 'refund_case_not_found', message: 'Refund case was not found' } }); }
function repositoryFailure(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (!(error instanceof HumanCaseRepositoryError)) return reply.code(500).send({ error: { code: 'human_operations_failure', message: 'Human Operations is unavailable' } });
  if (error.code === 'CASE_NOT_FOUND') return notFound(reply);
  if (error.code === 'STALE_CASE_VERSION') return reply.code(409).send({ error: { code: 'stale_case_version', message: 'The refund case changed; refresh and try again' } });
  return reply.code(409).send({ error: { code: error.code.toLowerCase(), message: 'The refund case cannot be changed' } });
}

function toHumanCaseResponse(humanCase: HumanCase) {
  return {
    case_id: humanCase.caseId,
    workflow_id: humanCase.workflowId,
    case_type: humanCase.caseType,
    status: humanCase.status,
    allowed_actions: humanCase.allowedActions,
    ...(humanCase.assignedStaffId === undefined ? {} : { assigned_staff_id: humanCase.assignedStaffId }),
    case_version: humanCase.caseVersion,
    review_packet: humanCase.reviewPacket,
    policy_version: humanCase.policyVersion,
    created_at: humanCase.createdAt,
    updated_at: humanCase.updatedAt,
    ...(humanCase.decidedAt === undefined ? {} : { decided_at: humanCase.decidedAt }),
  };
}

function toAuditEventResponse(event: HumanCaseAuditEvent) {
  return { event_id: event.eventId, event_type: event.eventType, occurred_at: event.occurredAt, actor_type: event.actorType, actor_id: event.actorId, case_version: event.caseVersion, details: event.details };
}
