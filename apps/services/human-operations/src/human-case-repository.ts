import { randomUUID } from 'node:crypto';

import type { HumanCase, HumanCaseAuditEvent, HumanCaseType, HumanDecision, HumanDecisionOutboxEvent, RefundReviewPacket } from './human-case.js';
import { allowedActionsForCaseType } from './human-case.js';

export class HumanCaseRepositoryError extends Error {
  constructor(readonly code: 'CASE_NOT_FOUND' | 'CASE_CONFLICT' | 'STALE_CASE_VERSION' | 'IDEMPOTENCY_CONFLICT') {
    super(code);
  }
}

export type OpenHumanCaseInput = Readonly<{
  tenantId: string;
  environmentId: string;
  workflowId: string;
  caseType: HumanCaseType;
  reviewPacket: RefundReviewPacket;
  policyVersion: string;
}>;

export type CloseHumanCaseInput = Readonly<{ caseId: string; tenantId: string; environmentId: string; workflowId: string; outcome?: 'EVIDENCE_REVIEW_COMPLETED' | 'EVIDENCE_COLLECTION_EXPIRED' }>;

export type ClaimHumanCaseInput = Readonly<{
  caseId: string;
  tenantId: string;
  environmentId: string;
  staffId: string;
  expectedCaseVersion: number;
  idempotencyKey: string;
}>;

export type DecideHumanCaseInput = Readonly<{
  caseId: string;
  tenantId: string;
  environmentId: string;
  staffId: string;
  decision: HumanDecision;
  reasonCode?: string;
  note?: string;
  expectedCaseVersion: number;
  idempotencyKey: string;
}>;

export type ReassignHumanCaseInput = Readonly<{
  caseId: string;
  tenantId: string;
  environmentId: string;
  assignedStaffId: string;
  expectedCaseVersion: number;
  idempotencyKey: string;
}>;

export interface HumanCaseRepository {
  open(input: OpenHumanCaseInput): Promise<HumanCase>;
  close(input: CloseHumanCaseInput): Promise<HumanCase>;
  list(input: Readonly<{ tenantId: string; environmentId: string; status?: HumanCase['status']; assignee?: 'me' | 'unassigned'; staffId: string }>): Promise<readonly HumanCase[]>;
  get(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<HumanCase>;
  auditEvents(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<readonly HumanCaseAuditEvent[]>;
  claim(input: ClaimHumanCaseInput): Promise<HumanCase>;
  reassign(input: ReassignHumanCaseInput): Promise<HumanCase>;
  decide(input: DecideHumanCaseInput): Promise<Readonly<{ case: HumanCase; outboxEvent: HumanDecisionOutboxEvent }>>;
  listPendingOutbox(input: Readonly<{ tenantId: string; environmentId: string; limit: number }>): Promise<readonly HumanDecisionOutboxEvent[]>;
  isOutboxPending(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<boolean>;
  markOutboxDelivered(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<void>;
}

type StoredIdempotency = Readonly<{ fingerprint: string; caseId: string; outboxEvent?: HumanDecisionOutboxEvent }>;

/** A deterministic in-memory adapter for local development and tests. Replace with a transactional PostgreSQL adapter for deployment. */
export class InMemoryHumanCaseRepository implements HumanCaseRepository {
  readonly #cases = new Map<string, HumanCase>();
  readonly #workflowIndex = new Map<string, string>();
  readonly #auditEvents = new Map<string, HumanCaseAuditEvent[]>();
  readonly #idempotency = new Map<string, StoredIdempotency>();
  readonly #outbox = new Map<string, HumanDecisionOutboxEvent>();

  constructor(private readonly now: () => Date = () => new Date(), private readonly ids: () => string = randomUUID) {}

  async open(input: OpenHumanCaseInput): Promise<HumanCase> {
    const workflowKey = this.#workflowKey(input.tenantId, input.environmentId, input.workflowId);
    const existingCaseId = this.#workflowIndex.get(workflowKey);
    if (existingCaseId) {
      const existing = this.#cases.get(existingCaseId);
      if (!existing) throw new Error('HUMAN_CASE_INDEX_INVARIANT');
      if (existing.caseType !== input.caseType || existing.policyVersion !== input.policyVersion) {
        throw new HumanCaseRepositoryError('CASE_CONFLICT');
      }
      return existing;
    }

    const timestamp = this.#timestamp();
    const humanCase: HumanCase = {
      caseId: `case-${this.ids()}`,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      workflowId: input.workflowId,
      caseType: input.caseType,
      status: 'OPEN',
      allowedActions: allowedActionsForCaseType(input.caseType),
      caseVersion: 1,
      reviewPacket: input.reviewPacket,
      policyVersion: input.policyVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#cases.set(humanCase.caseId, humanCase);
    this.#workflowIndex.set(workflowKey, humanCase.caseId);
    this.#appendAudit(humanCase, 'CASE_OPENED', 'WORKFLOW', input.workflowId, { case_type: input.caseType });
    return humanCase;
  }

  async close(input: CloseHumanCaseInput): Promise<HumanCase> {
    const current = this.#requireCase(input.caseId, input.tenantId, input.environmentId);
    if (current.workflowId !== input.workflowId) throw new HumanCaseRepositoryError('CASE_NOT_FOUND');
    if (current.status === 'CLOSED') return current;
    const closed = this.#update(current, { status: 'CLOSED' });
    this.#appendAudit(closed, 'CASE_CLOSED', 'WORKFLOW', input.workflowId, input.outcome ? { outcome: input.outcome } : {});
    return closed;
  }

  async list(input: Readonly<{ tenantId: string; environmentId: string; status?: HumanCase['status']; assignee?: 'me' | 'unassigned'; staffId: string }>): Promise<readonly HumanCase[]> {
    return [...this.#cases.values()]
      .filter((humanCase) => humanCase.tenantId === input.tenantId && humanCase.environmentId === input.environmentId)
      .filter((humanCase) => input.status === undefined || humanCase.status === input.status)
      .filter((humanCase) => input.assignee === undefined || (input.assignee === 'me' ? humanCase.assignedStaffId === input.staffId : humanCase.assignedStaffId === undefined))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<HumanCase> {
    return this.#requireCase(input.caseId, input.tenantId, input.environmentId);
  }

  async auditEvents(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<readonly HumanCaseAuditEvent[]> {
    this.#requireCase(input.caseId, input.tenantId, input.environmentId);
    return this.#auditEvents.get(input.caseId) ?? [];
  }

  async claim(input: ClaimHumanCaseInput): Promise<HumanCase> {
    const fingerprint = `claim:${input.expectedCaseVersion}:${input.staffId}`;
    const replay = this.#replay(input.idempotencyKey, fingerprint);
    if (replay) return this.#requireCase(replay.caseId, input.tenantId, input.environmentId);
    const current = this.#requireCase(input.caseId, input.tenantId, input.environmentId);
    this.#assertVersion(current, input.expectedCaseVersion);
    if (current.status === 'CLOSED' || current.status === 'DECISION_PENDING') throw new HumanCaseRepositoryError('CASE_CONFLICT');
    if (current.assignedStaffId !== undefined && current.assignedStaffId !== input.staffId) throw new HumanCaseRepositoryError('CASE_CONFLICT');
    const claimed = current.assignedStaffId === input.staffId ? current : this.#update(current, { status: 'CLAIMED', assignedStaffId: input.staffId });
    if (claimed !== current) this.#appendAudit(claimed, 'CASE_CLAIMED', 'HUMAN', input.staffId, {});
    this.#remember(input.idempotencyKey, fingerprint, { caseId: claimed.caseId });
    return claimed;
  }

  async reassign(input: ReassignHumanCaseInput): Promise<HumanCase> {
    const fingerprint = `reassign:${input.expectedCaseVersion}:${input.assignedStaffId}`;
    const replay = this.#replay(input.idempotencyKey, fingerprint);
    if (replay) return this.#requireCase(replay.caseId, input.tenantId, input.environmentId);
    const current = this.#requireCase(input.caseId, input.tenantId, input.environmentId);
    this.#assertVersion(current, input.expectedCaseVersion);
    if (current.status === 'CLOSED' || current.status === 'DECISION_PENDING') throw new HumanCaseRepositoryError('CASE_CONFLICT');
    const reassigned = this.#update(current, { status: 'CLAIMED', assignedStaffId: input.assignedStaffId });
    this.#appendAudit(reassigned, 'CASE_CLAIMED', 'HUMAN', input.assignedStaffId, { reassigned: 'true' });
    this.#remember(input.idempotencyKey, fingerprint, { caseId: reassigned.caseId });
    return reassigned;
  }

  async decide(input: DecideHumanCaseInput): Promise<Readonly<{ case: HumanCase; outboxEvent: HumanDecisionOutboxEvent }>> {
    const fingerprint = `decision:${input.expectedCaseVersion}:${input.staffId}:${input.decision}:${input.reasonCode ?? ''}:${input.note ?? ''}`;
    const replay = this.#replay(input.idempotencyKey, fingerprint);
    if (replay?.outboxEvent) return { case: this.#requireCase(replay.caseId, input.tenantId, input.environmentId), outboxEvent: replay.outboxEvent };
    const current = this.#requireCase(input.caseId, input.tenantId, input.environmentId);
    this.#assertVersion(current, input.expectedCaseVersion);
    if (current.status !== 'CLAIMED' || current.assignedStaffId !== input.staffId || !current.allowedActions.includes(input.decision)) throw new HumanCaseRepositoryError('CASE_CONFLICT');
    const decidedAt = this.#timestamp();
    const next = this.#update(current, { status: 'DECISION_PENDING', decidedAt });
    const outboxEvent: HumanDecisionOutboxEvent = {
      eventId: `outbox-${this.ids()}`,
      caseId: next.caseId,
      workflowId: next.workflowId,
      tenantId: next.tenantId,
      environmentId: next.environmentId,
      decision: input.decision,
      decidedBy: input.staffId,
      decidedAt,
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: decidedAt,
    };
    this.#outbox.set(outboxEvent.eventId, outboxEvent);
    this.#appendAudit(next, 'DECISION_RECORDED', 'HUMAN', input.staffId, { decision: input.decision });
    this.#remember(input.idempotencyKey, fingerprint, { caseId: next.caseId, outboxEvent });
    return { case: next, outboxEvent };
  }

  async markOutboxDelivered(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<void> {
    const event = this.#outbox.get(input.eventId);
    if (event?.tenantId === input.tenantId && event.environmentId === input.environmentId) this.#outbox.delete(input.eventId);
  }

  async isOutboxPending(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<boolean> {
    const event = this.#outbox.get(input.eventId);
    return event?.tenantId === input.tenantId && event.environmentId === input.environmentId;
  }

  async listPendingOutbox(input: Readonly<{ tenantId: string; environmentId: string; limit: number }>): Promise<readonly HumanDecisionOutboxEvent[]> {
    return [...this.#outbox.values()]
      .filter((event) => event.tenantId === input.tenantId && event.environmentId === input.environmentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit);
  }

  #requireCase(caseId: string, tenantId: string, environmentId: string): HumanCase {
    const humanCase = this.#cases.get(caseId);
    if (!humanCase || humanCase.tenantId !== tenantId || humanCase.environmentId !== environmentId) throw new HumanCaseRepositoryError('CASE_NOT_FOUND');
    return humanCase;
  }

  #assertVersion(humanCase: HumanCase, expected: number): void {
    if (humanCase.caseVersion !== expected) throw new HumanCaseRepositoryError('STALE_CASE_VERSION');
  }

  #update(current: HumanCase, patch: Readonly<Partial<Pick<HumanCase, 'status' | 'assignedStaffId' | 'decidedAt'>>>): HumanCase {
    const next: HumanCase = {
      ...current,
      ...patch,
      caseVersion: current.caseVersion + 1,
      updatedAt: this.#timestamp(),
    };
    this.#cases.set(next.caseId, next);
    return next;
  }

  #appendAudit(humanCase: HumanCase, eventType: HumanCaseAuditEvent['eventType'], actorType: HumanCaseAuditEvent['actorType'], actorId: string, details: Readonly<Record<string, string>>): void {
    const events = this.#auditEvents.get(humanCase.caseId) ?? [];
    events.push({ eventId: `audit-${this.ids()}`, caseId: humanCase.caseId, eventType, occurredAt: this.#timestamp(), actorType, actorId, caseVersion: humanCase.caseVersion, details });
    this.#auditEvents.set(humanCase.caseId, events);
  }

  #replay(idempotencyKey: string, fingerprint: string): StoredIdempotency | undefined {
    const existing = this.#idempotency.get(idempotencyKey);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint) throw new HumanCaseRepositoryError('IDEMPOTENCY_CONFLICT');
    return existing;
  }

  #remember(idempotencyKey: string, fingerprint: string, value: Omit<StoredIdempotency, 'fingerprint'>): void {
    this.#idempotency.set(idempotencyKey, { ...value, fingerprint });
  }

  #workflowKey(tenantId: string, environmentId: string, workflowId: string): string {
    return `${tenantId}\u0000${environmentId}\u0000${workflowId}`;
  }

  #timestamp(): string {
    return this.now().toISOString();
  }
}
