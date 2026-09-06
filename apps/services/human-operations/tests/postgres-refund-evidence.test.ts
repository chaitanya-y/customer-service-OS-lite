import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { PostgresHumanCaseRepository } from '../src/postgres-human-case-repository.js';
import { PostgresRefundEvidenceRepository } from '../src/postgres-refund-evidence-repository.js';
import { PrivateEvidenceStore } from '../src/private-evidence-store.js';
import { EvidenceError, MAX_PHOTO_BYTES, evidenceSnapshot } from '../src/refund-evidence.js';

const databaseUrl=process.env.HUMAN_OPERATIONS_TEST_DATABASE_URL;
test('transactional photo lifecycle: ownership, raw validation, revisions, immutable acceptance, transition, audit and retention',
  {skip:databaseUrl?false:'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set'},async context=>{
  const pool=new Pool({connectionString:databaseUrl});context.after(()=>pool.end());
  const directory=await realpath(await mkdtemp('/private/tmp/cso-photo-lifecycle-test.'));context.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await PrivateEvidenceStore.create(directory);
  let now=new Date('2026-09-05T12:00:00Z');
  const cases=new PostgresHumanCaseRepository(pool);
  const repository=new PostgresRefundEvidenceRepository(pool,()=>now);
  const scope={tenantId:`photo-test-${randomUUID()}`,environmentId:'test',subjectCustomerId:'customer-test'};
  const workflowId=`refund-${randomUUID()}`;
  const human={tenantId:scope.tenantId,environmentId:scope.environmentId,staffId:'reviewer',role:'REFUND_APPROVER' as const,iss:'test',aud:'test'};
  const sent:unknown[]=[];
  const app=buildApp({repository:cases,async verifyHuman(value){
    if(value==='reviewer')return human;
    if(value==='other')return {...human,staffId:'other'};
    if(value==='wrong-role')return {...human,role:'VIEWER' as never};
    throw new Error('denied');
  },async verifyWorkflowCaseAccess(value,purpose){if(value!=='worker')throw new Error('denied');return {...scope,workflowId,purpose};},async sendDecision(value){sent.push(value);},
    evidence:{repository,store,async verifyCustomer(value){if(value==='customer')return {...scope,workflowId};if(value==='other')return {...scope,subjectCustomerId:'other',workflowId};throw new Error('denied');}}});
  context.after(()=>app.close());
  const packet={order_reference:'ORDER-SYNTHETIC',selected_item_ids:[],requested_amount:{amount_minor:100,currency:'USD'},refund_reason:'DAMAGED',policy_reason_codes:['DAMAGE_PHOTO_REQUIRED'],evidence_ids:['fact:order'],policy_version:'refund-policy-v2'};
  const openBody={workflow_id:workflowId,order_id:'order-test',proposal_id:'proposal-test',selected_item_ids:[],review_packet:packet,policy_version:'refund-policy-v2'};
  const workerHeaders={'x-cso-workflow-assertion':'worker','idempotency-key':'open-evidence-test'};
  const opened=await app.inject({method:'POST',url:'/internal/v1/refund-evidence/collections',headers:workerHeaders,payload:openBody});
  assert.equal(opened.statusCode,201,opened.body);
  const caseId=opened.json().case_id;
  assert.deepEqual(opened.json().binding.selected_item_ids,[]);
  assert.equal(opened.json().evidence.evidence_version,0);
  const replay=await app.inject({method:'POST',url:'/internal/v1/refund-evidence/collections',headers:workerHeaders,payload:openBody});assert.equal(replay.json().case_id,caseId);
  const changed=await app.inject({method:'POST',url:'/internal/v1/refund-evidence/collections',headers:workerHeaders,payload:{...openBody,proposal_id:'changed'}});assert.equal(changed.statusCode,409);
  const url=`/internal/v1/customer-refund-evidence/${workflowId}`;
  const uploadHeaders={'x-cso-evidence-assertion':'customer','content-type':'image/png','idempotency-key':'upload-photo-test','x-cso-expected-evidence-version':'0'};
  const photo=await sharp({create:{width:5,height:4,channels:3,background:'white'}}).png().toBuffer();
  const unauthorized=await app.inject({method:'POST',url,headers:{...uploadHeaders,'x-cso-evidence-assertion':'bad'},payload:Buffer.alloc(MAX_PHOTO_BYTES+1)});assert.equal(unauthorized.statusCode,401);
  const anotherCustomer=await app.inject({method:'GET',url,headers:{'x-cso-evidence-assertion':'other'}});assert.equal(anotherCustomer.statusCode,404);
  const oversized=await app.inject({method:'POST',url,headers:uploadHeaders,payload:Buffer.alloc(MAX_PHOTO_BYTES+1)});assert.equal(oversized.statusCode,413);
  const uploaded=await app.inject({method:'POST',url,headers:uploadHeaders,payload:photo});assert.equal(uploaded.statusCode,202,uploaded.body);
  assert.equal(uploaded.json().evidence.evidence_version,2);assert.equal(uploaded.json().evidence.attachments[0].technical_status,'READY');
  const evidenceId=uploaded.json().evidence.attachments[0].evidence_id;
  const replayUpload=await app.inject({method:'POST',url,headers:uploadHeaders,payload:photo});assert.equal(replayUpload.json().evidence.attachments.length,1);
  const conflict=await app.inject({method:'POST',url,headers:uploadHeaders,payload:Buffer.from('different')});assert.equal(conflict.statusCode,409);
  const stale=await app.inject({method:'POST',url,headers:{...uploadHeaders,'idempotency-key':'new-upload-test'},payload:photo});assert.equal(stale.statusCode,409);
  const invalid=await app.inject({method:'POST',url,headers:{...uploadHeaders,'idempotency-key':'invalid-photo-test','x-cso-expected-evidence-version':'2'},payload:Buffer.from('not a png')});assert.equal(invalid.statusCode,202);assert.equal(invalid.json().evidence.attachments[1].technical_status,'REJECTED');
  const privateContent=await app.inject({method:'GET',url:`${url}/${evidenceId}/content`,headers:{'x-cso-evidence-assertion':'customer'}});assert.equal(privateContent.statusCode,200);assert.match(privateContent.headers['cache-control'] as string,/no-store/);
  assert.equal((await app.inject({method:'GET',url:`${url}/${evidenceId}/content`,headers:{'x-cso-evidence-assertion':'other'}})).statusCode,404);
  const current=await cases.get({...scope,caseId});
  const claim=await app.inject({method:'POST',url:`/v1/refund-cases/${caseId}/claim`,headers:{'x-cso-human-assertion':'reviewer','idempotency-key':'claim-evidence-test'},payload:{expected_case_version:current.caseVersion}});assert.equal(claim.statusCode,200,claim.body);
  assert.deepEqual(claim.json().refund_case.allowed_actions,[]);assert.deepEqual(claim.json().refund_case.allowed_evidence_actions,['ACCEPT_EVIDENCE','REQUEST_MORE_EVIDENCE']);
  const reviewBody={version:'v1',action:'ACCEPT_EVIDENCE',reason_code:'DAMAGE_VISIBLE',expected_case_version:claim.json().refund_case.case_version,expected_evidence_version:4,note:'Synthetic internal review note'};
  const reviewUrl=`/v1/refund-cases/${caseId}/evidence-review`;const reviewHeaders={'x-cso-human-assertion':'reviewer','idempotency-key':'review-evidence-test'};
  assert.equal((await app.inject({method:'POST',url:reviewUrl,headers:{...reviewHeaders,'x-cso-human-assertion':'other'},payload:reviewBody})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:reviewUrl,headers:{...reviewHeaders,'x-cso-human-assertion':'wrong-role'},payload:reviewBody})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:reviewUrl,headers:reviewHeaders,payload:{...reviewBody,customer_message:'leak'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:reviewUrl,headers:reviewHeaders,payload:{...reviewBody,expected_evidence_version:2}})).statusCode,409);
  const money=await app.inject({method:'POST',url:`/v1/refund-cases/${caseId}/decision`,headers:reviewHeaders,payload:{decision:'APPROVE',expected_case_version:reviewBody.expected_case_version}});assert.equal(money.statusCode,403);
  const legacy=await app.inject({method:'POST',url:`/internal/v1/refund-workflows/${workflowId}/decision`,headers:reviewHeaders,payload:{decision:'APPROVE'}});assert.equal(legacy.statusCode,409);assert.equal(sent.length,0);
  const accepted=await app.inject({method:'POST',url:reviewUrl,headers:reviewHeaders,payload:reviewBody});assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().refund_case.evidence.assessment,'ACCEPTED');assert.equal(accepted.json().refund_case.evidence.attachments.length,1);
  assert.equal((await app.inject({method:'POST',url:reviewUrl,headers:reviewHeaders,payload:reviewBody})).statusCode,200);
  const frozen=await app.inject({method:'POST',url,headers:{...uploadHeaders,'idempotency-key':'after-acceptance-test','x-cso-expected-evidence-version':'4'},payload:photo});assert.equal(frozen.statusCode,409);
  const authoritative=await repository.get(scope,workflowId);const snapshot=evidenceSnapshot(authoritative);assert.match(snapshot.accepted_manifest_hash!,/^sha256:[a-f0-9]{64}$/);assert.ok(snapshot.assessment_id);
  const readyObject=authoritative.document.attachments.find(photo=>photo.technical_status==='READY')!;
  await store.remove(readyObject.storageKey);
  const missingAccepted=await app.inject({method:'GET',url:`/internal/v1/refund-evidence/${workflowId}`,headers:workerHeaders});assert.equal(missingAccepted.statusCode,503);
  await store.put(readyObject.storageKey,privateContent.rawPayload);
  assert.ok(!JSON.stringify(snapshot).includes('Synthetic internal'));assert.equal((await cases.listPendingOutbox({...scope,limit:10})).length,0);
  await assert.rejects(repository.get({...scope,tenantId:'other'},workflowId),(error:unknown)=>error instanceof EvidenceError&&error.status===404);
  const transitionUrl=`/internal/v1/refund-evidence/${workflowId}/transition`;
  const transitionBody={case_type:'REFUND_APPROVAL',review_packet:{...packet,policy_reason_codes:['HUMAN_APPROVAL_REQUIRED']},policy_version:'refund-policy-v2',expected_evidence_version:4};
  const mismatched=await app.inject({method:'POST',url:transitionUrl,headers:workerHeaders,payload:{...transitionBody,review_packet:{...transitionBody.review_packet,order_reference:'changed'}}});assert.equal(mismatched.statusCode,409);
  const transitioned=await app.inject({method:'POST',url:transitionUrl,headers:workerHeaders,payload:transitionBody});assert.equal(transitioned.statusCode,200,transitioned.body);assert.equal(transitioned.json().refund_case.case_id,caseId);assert.equal(transitioned.json().refund_case.status,'OPEN');assert.equal(transitioned.json().refund_case.assigned_staff_id,undefined);
  const audits=await cases.auditEvents({...scope,caseId});assert.ok(audits.some(event=>event.eventType==='EVIDENCE_REVIEWED'));assert.ok(audits.some(event=>event.eventType==='CASE_PHASE_CHANGED'));
  await cases.close({...scope,caseId,workflowId});
  const removed:string[]=[];now=new Date(now.getTime()+31*86400000);
  await repository.purge(scope,{retentionDays:30,now,remove:async key=>{removed.push(key);await store.remove(key);}});
  assert.equal(evidenceSnapshot(await repository.get(scope,workflowId)).evidence.assessment,'UNREVIEWED');
  assert.equal(evidenceSnapshot(await repository.get(scope,workflowId)).accepted_manifest_hash,snapshot.accepted_manifest_hash);
  await repository.purge(scope,{retentionDays:30,now,remove:async key=>{removed.push(key);await store.remove(key);}});assert.equal(removed.length,2);
  assert.equal((await app.inject({method:'GET',url:`${url}/${evidenceId}/content`,headers:{'x-cso-evidence-assertion':'customer'}})).statusCode,404);
});

test('evidence repository serializes concurrent reservations, retries and bounded sets without money outbox writes',
  {skip:databaseUrl?false:'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set'},async context=>{
  const pool=new Pool({connectionString:databaseUrl});context.after(()=>pool.end());
  let now=new Date('2026-09-05T12:00:00Z');
  const cases=new PostgresHumanCaseRepository(pool);const repository=new PostgresRefundEvidenceRepository(pool,()=>now);
  const scope={tenantId:`photo-concurrency-${randomUUID()}`,environmentId:'test',subjectCustomerId:'customer-test'};
  const human={...scope,staffId:'reviewer',role:'REFUND_SUPERVISOR' as const,iss:'test',aud:'test'};
  async function open() {
    const workflowId=`refund-${randomUUID()}`;
    const snapshot=await repository.ensure({scope,workflowId,order_id:'order',proposal_id:'proposal',selected_item_ids:[],policy_version:'refund-policy-v2',reviewPacket:{selected_item_ids:[],policy_reason_codes:[],evidence_ids:[],policy_version:'refund-policy-v2'},idempotencyKey:'open-synthetic-test'});
    return {workflowId,caseId:snapshot.case_id};
  }
  const first=await open();
  const input={scope,workflowId:first.workflowId,expectedRevision:0,idempotencyKey:'concurrent-upload-a',fingerprint:'a',byteSize:100,contentType:'image/png' as const};
  const race=await Promise.allSettled([repository.beginUpload(input),repository.beginUpload({...input,idempotencyKey:'concurrent-upload-b',fingerprint:'b'})]);
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);assert.equal(race.filter(result=>result.status==='rejected').length,1);
  let current=await repository.get(scope,first.workflowId);const pending=current.document.attachments[0]!;
  const claimed=await cases.claim({...scope,caseId:first.caseId,staffId:human.staffId,expectedCaseVersion:current.case.caseVersion,idempotencyKey:'claim-concurrent-test'});
  await assert.rejects(cases.decide({...scope,caseId:first.caseId,staffId:human.staffId,decision:'APPROVE',expectedCaseVersion:claimed.caseVersion,idempotencyKey:'forbidden-money-test'}));
  const command={version:'v1' as const,action:'ACCEPT_EVIDENCE' as const,expected_case_version:claimed.caseVersion,expected_evidence_version:1,reason_code:'DAMAGE_VISIBLE' as const};
  await assert.rejects(repository.review({scope,workflowId:first.workflowId,access:human,command,idempotencyKey:'review-pending-test'}));
  await repository.finishUpload(scope,first.workflowId,pending.evidence_id,{contentType:'image/png',byteSize:100,width:2,height:2,sha256:'a'.repeat(64)});
  current=await repository.get(scope,first.workflowId);
  const more=await repository.review({scope,workflowId:first.workflowId,access:human,command:{...command,action:'REQUEST_MORE_EVIDENCE',reason_code:'PHOTO_UNCLEAR',expected_case_version:current.case.caseVersion,expected_evidence_version:2,note:'Internal synthetic rationale'},idempotencyKey:'review-more-test'});
  assert.equal(more.evidence.assessment,'MORE_REQUIRED');assert.equal(more.evidence.customer_message_code,'PHOTO_UNCLEAR');assert.ok(!JSON.stringify(more).includes('Internal'));
  assert.equal(more.evidence.evidence_version,3);assert.deepEqual(more.evidence.attachments,[]);
  const next=await repository.beginUpload({...input,expectedRevision:3,idempotencyKey:'next-upload-test',fingerprint:'next'});
  assert.equal(next.record.document.assessment,'UNREVIEWED');assert.equal(next.record.document.assessmentId,undefined);
  now=new Date(now.getTime()+11*60000);
  await repository.recoverStaleUploads(scope);
  current=await repository.get(scope,first.workflowId);assert.equal(current.document.attachments[1]!.technical_status,'REJECTED');
  const second=await open();
  for(let index=0;index<5;index++){
    const reservation=await repository.beginUpload({...input,workflowId:second.workflowId,expectedRevision:index*2,idempotencyKey:`photo-limit-${index}`,fingerprint:String(index)});
    await repository.finishUpload(scope,second.workflowId,reservation.photo.evidence_id,{contentType:'image/png',byteSize:100,width:2,height:2,sha256:'b'.repeat(64)});
  }
  assert.equal(evidenceSnapshot(await repository.get(scope,second.workflowId)).evidence.can_upload,false);
  await assert.rejects(repository.beginUpload({...input,workflowId:second.workflowId,expectedRevision:10,idempotencyKey:'sixth-photo-test'}),(error:unknown)=>error instanceof EvidenceError&&error.code==='evidence_limit_exceeded');
  const saturated=await repository.get(scope,second.workflowId);
  const saturatedIds=saturated.document.attachments.map(photo=>photo.evidence_id);
  const claimedSaturated=await cases.claim({...scope,caseId:second.caseId,staffId:human.staffId,expectedCaseVersion:saturated.case.caseVersion,idempotencyKey:'claim-saturated-test'});
  const freshSet=await repository.review({scope,workflowId:second.workflowId,access:human,idempotencyKey:'request-fresh-set',command:{version:'v1',action:'REQUEST_MORE_EVIDENCE',reason_code:'PHOTO_UNCLEAR',expected_case_version:claimedSaturated.caseVersion,expected_evidence_version:10}});
  assert.equal(freshSet.evidence.evidence_version,11);assert.equal(freshSet.evidence.can_upload,true);assert.deepEqual(freshSet.evidence.attachments,[]);
  const retained=await repository.get(scope,second.workflowId);
  assert.equal(retained.document.attachments.filter(photo=>photo.superseded&&!photo.purged).length,5);
  const fresh=await repository.beginUpload({...input,workflowId:second.workflowId,expectedRevision:11,idempotencyKey:'fresh-photo-test',fingerprint:'fresh'});
  await repository.finishUpload(scope,second.workflowId,fresh.photo.evidence_id,{contentType:'image/png',byteSize:100,width:2,height:2,sha256:'d'.repeat(64)});
  const freshCurrent=await repository.get(scope,second.workflowId);
  const acceptFresh={version:'v1' as const,action:'ACCEPT_EVIDENCE' as const,reason_code:'DAMAGE_VISIBLE' as const,expected_case_version:freshCurrent.case.caseVersion,expected_evidence_version:13};
  await assert.rejects(repository.review({scope,workflowId:second.workflowId,access:human,idempotencyKey:'stale-old-set-test',command:{...acceptFresh,expected_evidence_version:10}}),(error:unknown)=>error instanceof EvidenceError&&error.code==='stale_evidence_version');
  const acceptedFresh=await repository.review({scope,workflowId:second.workflowId,access:human,idempotencyKey:'accept-fresh-set-test',command:acceptFresh});
  assert.deepEqual(acceptedFresh.evidence.attachments.map(photo=>photo.evidence_id),[fresh.photo.evidence_id]);
  const freshAudit=await cases.auditEvents({...scope,caseId:second.caseId});
  const priorReview=freshAudit.find(event=>event.details.assessment==='MORE_REQUIRED');
  assert.equal(priorReview?.details.reviewed_evidence_version,'10');assert.deepEqual(JSON.parse(priorReview!.details.reviewed_evidence_ids!),saturatedIds);
  const third=await open();
  for(let index=0;index<20;index++){
    const reservation=await repository.beginUpload({...input,workflowId:third.workflowId,expectedRevision:index*2,idempotencyKey:`attempt-limit-${index}`,fingerprint:String(index)});
    await repository.finishUpload(scope,third.workflowId,reservation.photo.evidence_id,{rejectionCode:'INVALID_IMAGE'});
  }
  await assert.rejects(repository.beginUpload({...input,workflowId:third.workflowId,expectedRevision:40,idempotencyKey:'attempt-21-test'}),(error:unknown)=>error instanceof EvidenceError&&error.code==='evidence_limit_exceeded');
  const fourth=await open();
  for(let index=0;index<2;index++){
    const reservation=await repository.beginUpload({...input,workflowId:fourth.workflowId,expectedRevision:index*2,idempotencyKey:`byte-limit-${index}`,fingerprint:String(index),byteSize:9*1024*1024});
    await repository.finishUpload(scope,fourth.workflowId,reservation.photo.evidence_id,{contentType:'image/png',byteSize:9*1024*1024,width:2,height:2,sha256:'c'.repeat(64)});
  }
  await assert.rejects(repository.beginUpload({...input,workflowId:fourth.workflowId,expectedRevision:4,idempotencyKey:'aggregate-limit-test',byteSize:8*1024*1024}),(error:unknown)=>error instanceof EvidenceError&&error.code==='evidence_limit_exceeded');
  await cases.close({...scope,...third,outcome:'EVIDENCE_COLLECTION_EXPIRED'});
  const closeAudit=await cases.auditEvents({...scope,caseId:third.caseId});assert.equal(closeAudit.at(-1)!.details.outcome,'EVIDENCE_COLLECTION_EXPIRED');
  assert.equal((await cases.listPendingOutbox({...scope,limit:50})).length,0);
});

test('evidence RLS blocks unscoped reads, cross-tenant reads and cross-scope writes under a non-bypass application role',
  {skip:databaseUrl?false:'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set'},async context=>{
  const pool=new Pool({connectionString:databaseUrl});context.after(()=>pool.end());
  const role=await pool.query<{rolsuper:boolean;rolbypassrls:boolean}>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rows[0]!.rolsuper,false,'Integration tests must use a non-superuser app role');
  assert.equal(role.rows[0]!.rolbypassrls,false,'Integration tests must not bypass RLS');
  const repository=new PostgresRefundEvidenceRepository(pool);
  const scope={tenantId:`photo-rls-${randomUUID()}`,environmentId:'test',subjectCustomerId:'customer-test'};const workflowId=`refund-${randomUUID()}`;
  const snapshot=await repository.ensure({scope,workflowId,order_id:'order',proposal_id:'proposal',selected_item_ids:[],policy_version:'refund-policy-v2',reviewPacket:{selected_item_ids:[],policy_reason_codes:[],evidence_ids:[],policy_version:'refund-policy-v2'},idempotencyKey:'open-rls-test'});
  const client=await pool.connect();
  try {
    assert.equal((await client.query('SELECT * FROM human_operations.refund_evidence')).rowCount,0);
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.environment_id',$2,true)",[scope.tenantId,scope.environmentId]);
    assert.equal((await client.query('SELECT * FROM human_operations.refund_evidence WHERE workflow_id=$1',[workflowId])).rowCount,1);
    await assert.rejects(client.query('UPDATE human_operations.refund_evidence SET tenant_id=$1 WHERE case_id=$2',['other-tenant',snapshot.case_id]),(error:unknown)=>(error as {code:string}).code==='42501');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.environment_id',$2,true)",['other-tenant',scope.environmentId]);
    assert.equal((await client.query('SELECT * FROM human_operations.refund_evidence WHERE workflow_id=$1',[workflowId])).rowCount,0);
    await client.query('ROLLBACK');
  } finally {client.release();}
});
