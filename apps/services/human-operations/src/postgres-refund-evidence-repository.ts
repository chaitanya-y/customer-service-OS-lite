import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { HumanCaseAuditEvent } from './human-case.js';
import { toHumanCase, type CaseRow } from './postgres-human-case-repository.js';
import {
  EvidenceError, MAX_PHOTOS, MAX_SET_BYTES, MAX_UPLOAD_ATTEMPTS, canReviewEvidence, digest, evidenceSnapshot,
  type EnsureEvidenceInput, type EvidenceDocument, type EvidenceRecord, type EvidenceScope,
  type EvidenceSnapshot, type RefundEvidenceRepository, type TransitionEvidenceInput,
} from './refund-evidence.js';

type EvidenceRow = CaseRow & {
  subject_customer_id: string; order_id: string; proposal_id: string;
  selected_item_ids: string[]; document: EvidenceDocument;
};
const SELECT = `SELECT c.*, e.subject_customer_id, e.order_id, e.proposal_id, e.selected_item_ids, e.document
 FROM human_operations.refund_evidence e JOIN human_operations.refund_cases c
 ON c.tenant_id=e.tenant_id AND c.environment_id=e.environment_id AND c.case_id=e.case_id
 WHERE e.tenant_id=security.current_tenant_id() AND e.environment_id=security.current_environment_id()`;

export class PostgresRefundEvidenceRepository implements RefundEvidenceRepository {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}
  private async transaction<T>(scope: EvidenceScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.environment_id',$2,true)", [scope.tenantId,scope.environmentId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async load(client: PoolClient, scope: EvidenceScope, workflowId: string): Promise<EvidenceRecord> {
    const result = await client.query<EvidenceRow>(SELECT + ' AND e.workflow_id=$1 FOR UPDATE OF c,e', [workflowId]);
    const row = result.rows[0];
    if (!row || (scope.subjectCustomerId !== undefined && row.subject_customer_id !== scope.subjectCustomerId))
      throw new EvidenceError('evidence_not_found',404);
    return { case: toHumanCase(row), customerId: row.subject_customer_id,
      binding: { order_id: row.order_id, proposal_id: row.proposal_id, selected_item_ids: row.selected_item_ids, policy_version: row.policy_version },
      document: row.document };
  }
  private async save(client: PoolClient, record: EvidenceRecord, event: HumanCaseAuditEvent['eventType'], actorType: HumanCaseAuditEvent['actorType'], actorId: string, details: Record<string,string>): Promise<void> {
    await client.query('UPDATE human_operations.refund_evidence SET document=$1::jsonb WHERE workflow_id=$2 AND tenant_id=security.current_tenant_id() AND environment_id=security.current_environment_id()', [JSON.stringify(record.document),record.case.workflowId]);
    const changed = await client.query<CaseRow>("UPDATE human_operations.refund_cases SET case_version=case_version+1, updated_at=CASE WHEN status='CLOSED' THEN updated_at ELSE $1 END WHERE case_id=$2 AND tenant_id=security.current_tenant_id() AND environment_id=security.current_environment_id() RETURNING *", [this.now(),record.case.caseId]);
    record.case = toHumanCase(changed.rows[0]!);
    await this.audit(client,record,event,actorType,actorId,details);
  }
  private async audit(client: PoolClient, record: EvidenceRecord, event: HumanCaseAuditEvent['eventType'], actorType: HumanCaseAuditEvent['actorType'], actorId: string, details: Record<string,string>): Promise<void> {
    await client.query(`INSERT INTO human_operations.case_audit_events
      (tenant_id,environment_id,event_id,case_id,event_type,occurred_at,actor_type,actor_id,case_version,details)
      VALUES (security.current_tenant_id(),security.current_environment_id(),$1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [`audit-${randomUUID()}`,record.case.caseId,event,this.now(),actorType,actorId,record.case.caseVersion,JSON.stringify(details)]);
  }
  async ensure(input: EnsureEvidenceInput): Promise<EvidenceSnapshot> {
    return this.transaction(input.scope, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([input.scope.tenantId,input.scope.environmentId,input.workflowId])]);
      const fingerprint = digest(JSON.stringify({ customer:input.scope.subjectCustomerId,order:input.order_id,proposal:input.proposal_id,items:[...input.selected_item_ids].sort(),policy:input.policy_version,packet:input.reviewPacket }));
      const present = await client.query(SELECT + ' AND e.workflow_id=$1', [input.workflowId]);
      if (present.rowCount) {
        const record = await this.load(client,input.scope,input.workflowId);
        if (record.document.ensureFingerprint !== fingerprint) throw new EvidenceError('idempotency_conflict');
        return evidenceSnapshot(record);
      }
      const caseId = `case-${randomUUID()}`;
      const inserted = await client.query(`INSERT INTO human_operations.refund_cases
        (tenant_id,environment_id,case_id,workflow_id,case_type,status,case_version,review_packet,policy_version,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'REFUND_EVIDENCE_REVIEW','OPEN',1,$5::jsonb,$6,$7,$7)
        ON CONFLICT (tenant_id,environment_id,workflow_id) DO NOTHING RETURNING case_id`,
        [input.scope.tenantId,input.scope.environmentId,caseId,input.workflowId,JSON.stringify(input.reviewPacket),input.policy_version,this.now()]);
      if (!inserted.rowCount) throw new EvidenceError('evidence_case_conflict');
      const document: EvidenceDocument = { revision:0,assessment:'UNREVIEWED',ensureFingerprint:fingerprint,attachments:[],reviewKeys:{},transitionKeys:{} };
      await client.query(`INSERT INTO human_operations.refund_evidence
        (tenant_id,environment_id,workflow_id,case_id,subject_customer_id,order_id,proposal_id,selected_item_ids,document)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [input.scope.tenantId,input.scope.environmentId,input.workflowId,caseId,input.scope.subjectCustomerId,input.order_id,input.proposal_id,JSON.stringify(input.selected_item_ids),JSON.stringify(document)]);
      const record = await this.load(client,input.scope,input.workflowId);
      await this.audit(client,record,'CASE_OPENED','WORKFLOW',input.workflowId,{case_type:'REFUND_EVIDENCE_REVIEW'});
      return evidenceSnapshot(record);
    });
  }
  async get(scope: EvidenceScope, workflowId: string): Promise<EvidenceRecord> {
    return this.transaction(scope, client => this.load(client,scope,workflowId));
  }
  async beginUpload(input: Parameters<RefundEvidenceRepository['beginUpload']>[0]) {
    return this.transaction(input.scope,async client => {
      const record = await this.load(client,input.scope,input.workflowId);
      const existing = record.document.attachments.find(photo=>photo.uploadKey===input.idempotencyKey);
      if(existing) {
        if(existing.fingerprint!==input.fingerprint)throw new EvidenceError('idempotency_conflict');
        return {record,photo:existing,created:false};
      }
      const doc=record.document;
      if(doc.assessment==='ACCEPTED'||doc.retired||record.case.caseType!=='REFUND_EVIDENCE_REVIEW'||!['OPEN','CLAIMED'].includes(record.case.status))throw new EvidenceError('evidence_frozen');
      if(doc.revision!==input.expectedRevision)throw new EvidenceError('stale_evidence_version');
      const active=doc.attachments.filter(p=>p.technical_status!=='REJECTED'&&!p.purged&&!p.superseded);
      if(active.length>=MAX_PHOTOS||doc.attachments.length>=MAX_UPLOAD_ATTEMPTS||active.reduce((sum,p)=>sum+p.byte_size,0)+input.byteSize>MAX_SET_BYTES)throw new EvidenceError('evidence_limit_exceeded');
      const evidenceId=randomUUID();
      const photo = { evidence_id:evidenceId,display_label:'Photo 1',technical_status:'PROCESSING' as const,byte_size:input.byteSize,uploaded_at:this.now().toISOString(),content_type:input.contentType,
        storageKey:`${evidenceId}.${input.contentType==='image/jpeg'?'jpg':'png'}`,uploadKey:input.idempotencyKey,fingerprint:input.fingerprint };
      doc.attachments.push(photo);doc.revision++;doc.assessment='UNREVIEWED';delete doc.reasonCode;delete doc.assessmentId;delete doc.manifestHash;
      await this.save(client,record,'EVIDENCE_UPLOAD_RESERVED','CUSTOMER',record.customerId,{evidence_id:evidenceId,evidence_version:String(doc.revision)});
      return {record,photo,created:true};
    });
  }
  async finishUpload(scope: EvidenceScope, workflowId: string, evidenceId: string, result: Parameters<RefundEvidenceRepository['finishUpload']>[3]): Promise<EvidenceSnapshot> {
    return this.transaction(scope,async client=>{
      const record=await this.load(client,scope,workflowId);
      const photo=record.document.attachments.find(p=>p.evidence_id===evidenceId);
      if(!photo)throw new EvidenceError('evidence_not_found',404);
      if(photo.technical_status!=='PROCESSING')return evidenceSnapshot(record);
      if(record.case.status==='CLOSED'||record.document.retired)result={rejectionCode:'VALIDATION_UNAVAILABLE'};
      if(!('rejectionCode' in result) && record.document.attachments.filter(p=>p.evidence_id!==evidenceId&&p.technical_status!=='REJECTED'&&!p.purged&&!p.superseded).reduce((sum,p)=>sum+p.byte_size,0)+result.byteSize>MAX_SET_BYTES)result={rejectionCode:'FILE_TOO_LARGE'};
      if('rejectionCode' in result){photo.technical_status='REJECTED';photo.rejection_code=result.rejectionCode;}
      else {photo.technical_status='READY';photo.content_type=result.contentType;photo.byte_size=result.byteSize;photo.width=result.width;photo.height=result.height;photo.sha256=result.sha256;}
      record.document.revision++;
      await this.save(client,record,'EVIDENCE_VALIDATED','WORKFLOW',workflowId,{evidence_id:evidenceId,technical_status:photo.technical_status,evidence_version:String(record.document.revision)});
      return evidenceSnapshot(record);
    });
  }
  async review(input: Parameters<RefundEvidenceRepository['review']>[0]): Promise<EvidenceSnapshot> {
    return this.transaction(input.scope,async client=>{
      const record=await this.load(client,input.scope,input.workflowId);
      const fingerprint=digest(JSON.stringify({staff:input.access.staffId,...input.command}));
      const existing=record.document.reviewKeys[input.idempotencyKey];
      if(existing){if(existing!==fingerprint)throw new EvidenceError('idempotency_conflict');return evidenceSnapshot(record);}
      if(!canReviewEvidence(input.access,record))throw new EvidenceError('evidence_review_forbidden',403);
      if(record.case.caseVersion!==input.command.expected_case_version)throw new EvidenceError('stale_case_version');
      if(record.document.revision!==input.command.expected_evidence_version)throw new EvidenceError('stale_evidence_version');
      if(Object.keys(record.document.reviewKeys).length>=100)throw new EvidenceError('evidence_limit_exceeded');
      const doc=record.document;
      const reviewedRevision=doc.revision;
      const reviewedPhotos=doc.attachments.filter(p=>!p.purged&&!p.superseded);
      doc.assessment=input.command.action==='ACCEPT_EVIDENCE'?'ACCEPTED':'MORE_REQUIRED';
      doc.reasonCode=input.command.reason_code;doc.assessmentId=randomUUID();
      if(doc.assessment==='ACCEPTED')doc.manifestHash='sha256:'+digest(JSON.stringify(reviewedPhotos.filter(p=>p.technical_status==='READY').map(p=>({id:p.evidence_id,sha256:p.sha256})).sort((a,b)=>a.id.localeCompare(b.id))));
      else {
        // Start a fresh current set while preserving the old photos and review audit.
        // The lifetime20-attempt cap still includes all superseded records.
        for(const photo of reviewedPhotos)photo.superseded=true;
        doc.revision++;delete doc.manifestHash;
      }
      doc.reviewKeys[input.idempotencyKey]=fingerprint;
      await this.save(client,record,'EVIDENCE_REVIEWED','HUMAN',input.access.staffId,{assessment:doc.assessment,
        assessment_id:doc.assessmentId,reviewed_evidence_version:String(reviewedRevision),evidence_version:String(doc.revision),
        reviewed_evidence_ids:JSON.stringify(reviewedPhotos.map(photo=>photo.evidence_id)),
        ...(doc.manifestHash?{accepted_manifest_hash:doc.manifestHash}:{}),reason_code:input.command.reason_code,...(input.command.note?{note:input.command.note}:{})});
      return evidenceSnapshot(record);
    });
  }
  async transition(input: TransitionEvidenceInput): Promise<EvidenceSnapshot> {
    return this.transaction(input.scope,async client=>{
      const record=await this.load(client,input.scope,input.workflowId);
      const fingerprint=digest(JSON.stringify({type:input.caseType,packet:input.reviewPacket,policy:input.policyVersion,revision:input.expectedEvidenceVersion}));
      const prior=record.document.transitionKeys[input.idempotencyKey];
      if(prior){if(prior!==fingerprint)throw new EvidenceError('idempotency_conflict');return evidenceSnapshot(record);}
      if(record.document.assessment!=='ACCEPTED'||record.document.retired||record.document.revision!==input.expectedEvidenceVersion)throw new EvidenceError('evidence_not_accepted');
      if(record.binding.policy_version!==input.policyVersion||input.reviewPacket.policy_version!==input.policyVersion)throw new EvidenceError('evidence_binding_conflict');
      if(record.case.caseType!=='REFUND_EVIDENCE_REVIEW'||record.case.status==='CLOSED')throw new EvidenceError('evidence_case_conflict');
      if(JSON.stringify([...(input.reviewPacket.selected_item_ids??[])].sort())!==JSON.stringify([...record.binding.selected_item_ids].sort()))throw new EvidenceError('evidence_binding_conflict');
      for(const key of ['order_reference','refund_reason'] as const)
        if(input.reviewPacket[key]!==record.case.reviewPacket[key])throw new EvidenceError('evidence_binding_conflict');
      if(input.reviewPacket.requested_amount?.amount_minor!==record.case.reviewPacket.requested_amount?.amount_minor
        || input.reviewPacket.requested_amount?.currency!==record.case.reviewPacket.requested_amount?.currency)throw new EvidenceError('evidence_binding_conflict');
      await client.query(`UPDATE human_operations.refund_cases SET case_type=$1,status='OPEN',assigned_staff_id=NULL,review_packet=$2::jsonb WHERE case_id=$3 AND tenant_id=security.current_tenant_id() AND environment_id=security.current_environment_id()`,[input.caseType,JSON.stringify(input.reviewPacket),record.case.caseId]);
      record.document.transitionKeys[input.idempotencyKey]=fingerprint;
      await this.save(client,record,'CASE_PHASE_CHANGED','WORKFLOW',input.workflowId,{case_type:input.caseType,evidence_version:String(record.document.revision)});
      return evidenceSnapshot(record);
    });
  }
  async recoverStaleUploads(scope: EvidenceScope): Promise<void> {
    const cutoff = new Date(this.now().getTime()-600000);
    await this.transaction(scope,async client=>{
      const rows=await client.query<EvidenceRow>(SELECT+` AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.document->'attachments') p
        WHERE p->>'technical_status'='PROCESSING' AND (p->>'uploaded_at')::timestamptz <= $1)
        ORDER BY c.updated_at LIMIT 100 FOR UPDATE OF c,e SKIP LOCKED`,[cutoff]);
      for(const row of rows.rows){
        const record=await this.load(client,scope,row.workflow_id);
        for(const photo of record.document.attachments){
          if(photo.technical_status==='PROCESSING'&&Date.parse(photo.uploaded_at)<=cutoff.getTime()){
            photo.technical_status='REJECTED';photo.rejection_code='VALIDATION_UNAVAILABLE';
          }
        }
        record.document.revision++;
        await this.save(client,record,'EVIDENCE_VALIDATED','WORKFLOW',record.case.workflowId,{technical_status:'REJECTED',reason:'STALE_PROCESSING_RECOVERED'});
      }
    });
  }
  // Deliberately not scheduled by the server: enable deletion only after retention authorization.
  async purge(scope: EvidenceScope, options: Parameters<RefundEvidenceRepository['purge']>[1]): Promise<void> {
    const now=options.now??this.now();
    await this.transaction(scope,async client=>{
      // Filter work before the bounded batch: unchanged active cases cannot starve retention.
      const rows=await client.query<EvidenceRow>(SELECT+` AND (
        (c.status='CLOSED' AND NOT COALESCE((e.document->>'retired')::boolean,false) AND c.updated_at <= $1)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.document->'attachments') p
          WHERE (p->>'technical_status'='PROCESSING' AND (p->>'uploaded_at')::timestamptz <= $2)
          OR (p->>'technical_status'='REJECTED' AND NOT COALESCE((p->>'purged')::boolean,false) AND (p->>'uploaded_at')::timestamptz <= $3)))
        ORDER BY c.updated_at LIMIT 100 FOR UPDATE OF c,e SKIP LOCKED`, [new Date(now.getTime()-options.retentionDays*86400000),new Date(now.getTime()-600000),new Date(now.getTime()-86400000)]);
      for(const row of rows.rows){
        const record:EvidenceRecord={case:toHumanCase(row),customerId:row.subject_customer_id,binding:{order_id:row.order_id,proposal_id:row.proposal_id,selected_item_ids:row.selected_item_ids,policy_version:row.policy_version},document:row.document};
        let changed=false;
        const closedExpired=row.status==='CLOSED'&&now.getTime()-row.updated_at.getTime()>=options.retentionDays*86400000;
        for(const photo of record.document.attachments){
          const age=now.getTime()-Date.parse(photo.uploaded_at);
          if(photo.technical_status==='PROCESSING'&&age>=10*60000){photo.technical_status='REJECTED';photo.rejection_code='VALIDATION_UNAVAILABLE';changed=true;}
          if(!photo.purged&&(closedExpired||(photo.technical_status==='REJECTED'&&age>=86400000))){
            await options.remove(photo.storageKey);photo.purged=true;changed=true;
          }
        }
        if(closedExpired&&!record.document.retired){record.document.retired=true;changed=true;}
        if(changed){if(record.document.assessment!=='ACCEPTED'||record.document.retired)record.document.revision++;await this.save(client,record,'EVIDENCE_PURGED','WORKFLOW',record.case.workflowId,{retired:String(Boolean(record.document.retired))});}
      }
    });
  }
}
