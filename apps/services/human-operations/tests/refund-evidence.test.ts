import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { SignJWT } from 'jose';
import { createEvidenceAccessVerifier } from '../src/refund-evidence-access.js';
import { PrivateEvidenceStore, validatePhoto } from '../src/private-evidence-store.js';
import { EvidenceError, MAX_PHOTO_BYTES, canReviewEvidence, digest, evidenceReviewSchema, evidenceSnapshot, type EvidenceRecord } from '../src/refund-evidence.js';
import { buildApp } from '../src/app.js';
import type { RefundEvidenceRepository } from '../src/refund-evidence.js';

const access = { tenantId:'test-tenant',environmentId:'test',staffId:'reviewer',role:'REFUND_APPROVER' as const,iss:'test',aud:'test' };
function record(): EvidenceRecord {
  return {case:{caseId:'case-test',workflowId:'refund-test',tenantId:access.tenantId,environmentId:access.environmentId,
    caseType:'REFUND_EVIDENCE_REVIEW',status:'CLAIMED',assignedStaffId:'reviewer',allowedActions:[],caseVersion:3,
    reviewPacket:{policy_reason_codes:[],evidence_ids:[],policy_version:'refund-policy-v2'},policyVersion:'refund-policy-v2',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},
    customerId:'customer-test',binding:{order_id:'order',proposal_id:'proposal',selected_item_ids:[],policy_version:'refund-policy-v2'},
    document:{revision:2,assessment:'UNREVIEWED',ensureFingerprint:'hash',reviewKeys:{},transitionKeys:{},attachments:[{
      evidence_id:randomUUID(),display_label:'Photo 1',byte_size:100,uploaded_at:new Date().toISOString(),technical_status:'READY',content_type:'image/png',width:2,height:2,
      storageKey:'private.png',sha256:'a'.repeat(64),uploadKey:'key-test',fingerprint:'private-fingerprint',
    }]}};
}
test('normalization fully decodes images, strips metadata and rejects disguised or invalid files',async()=>{
  const original=await sharp({create:{width:8,height:8,channels:3,background:'#2196f3'}}).withMetadata().jpeg().toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const normalized=await validatePhoto(original,'image/jpeg');
  assert.equal(normalized.width,8);assert.equal(normalized.height,8);
  assert.equal((await sharp(normalized.bytes).metadata()).exif,undefined);
  assert.equal(normalized.sha256,digest(normalized.bytes));
  await assert.rejects(validatePhoto(original,'image/png'),(error:unknown)=>error instanceof EvidenceError&&error.code==='INVALID_IMAGE');
  await assert.rejects(validatePhoto(Buffer.from('<svg/>'),'image/png'));
  await assert.rejects(validatePhoto(Buffer.from([137,80,78,71,13,10,26,10]),'image/png'));
  await assert.rejects(validatePhoto(Buffer.alloc(MAX_PHOTO_BYTES+1),'image/jpeg'));
  const tooWide=await sharp({create:{width:8193,height:1,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(validatePhoto(tooWide,'image/png'),(error:unknown)=>error instanceof EvidenceError&&error.code==='IMAGE_LIMIT_EXCEEDED');
});
test('private normalized store rejects traversal, symlinks, overwrite and hash mismatch',async context=>{
  const directory=await realpath(await mkdtemp('/private/tmp/cso-photo-store-test.'));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await PrivateEvidenceStore.create(directory);
  const photo=await validatePhoto(await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),'image/png');
  const key=`${randomUUID()}.png`;
  await store.put(key,photo.bytes);
  assert.equal((await stat(`${directory}/${key}`)).mode&0o777,0o600);
  assert.deepEqual(await store.read(key,photo.sha256),photo.bytes);
  await assert.rejects(store.put(key,photo.bytes));
  await assert.rejects(store.read(key,'b'.repeat(64)));
  await assert.rejects(store.read('../escape.png',photo.sha256));
  const link=`${randomUUID()}.png`;await symlink(`${directory}/${key}`,`${directory}/${link}`);
  await assert.rejects(store.read(link,photo.sha256));
  await store.remove(key);await store.remove(key);
  await assert.rejects(PrivateEvidenceStore.create('.'));
});
test('customer snapshot never exposes storage, fingerprints, staff notes or rejected files after acceptance',()=>{
  const value=record();
  value.document.attachments.push({...value.document.attachments[0]!,evidence_id:randomUUID(),technical_status:'REJECTED',rejection_code:'INVALID_IMAGE'});
  value.document.assessment='ACCEPTED';value.document.assessmentId=randomUUID();value.document.manifestHash='sha256:'+'a'.repeat(64);
  const snapshot=evidenceSnapshot(value);
  assert.equal(snapshot.evidence.can_upload,false);assert.equal(snapshot.evidence.attachments.length,1);
  assert.ok(!JSON.stringify(snapshot).includes('storageKey'));assert.ok(!JSON.stringify(snapshot).includes('fingerprint'));
  value.document.retired=true;
  const retired=evidenceSnapshot(value);
  assert.equal(retired.evidence.assessment,'UNREVIEWED');assert.deepEqual(retired.evidence.attachments,[]);
  assert.equal(retired.accepted_manifest_hash,snapshot.accepted_manifest_hash);
});
test('evidence review requires exact assignee, recognized role, scope and a ready nonprocessing set',()=>{
  const value=record();assert.equal(canReviewEvidence(access,value),true);
  assert.equal(canReviewEvidence({...access,staffId:'other'},value),false);
  assert.equal(canReviewEvidence({...access,tenantId:'other'},value),false);
  assert.equal(canReviewEvidence({...access,role:'VIEWER' as never},value),false);
  value.document.attachments[0]!.technical_status='PROCESSING';assert.equal(canReviewEvidence(access,value),false);
  value.document.attachments[0]!.technical_status='READY';value.document.assessment='ACCEPTED';assert.equal(canReviewEvidence(access,value),false);
});
test('review command rejects unknown fields, money actions, unsafe reasons and blank notes',()=>{
  const command={version:'v1',action:'ACCEPT_EVIDENCE',expected_case_version:3,expected_evidence_version:2,reason_code:'DAMAGE_VISIBLE'};
  assert.ok(evidenceReviewSchema.safeParse(command).success);
  for(const extra of [{customer_message:'private note'},{storage_url:'private'},{actor:'forged'},{note:'  '},{action:'APPROVE'},{reason_code:'PHOTO_UNCLEAR'}])
    assert.equal(evidenceReviewSchema.safeParse({...command,...extra}).success,false);
});
test('customer evidence assertion verifies purpose, identity, scope, audience, lifetime and strict claims',async()=>{
  const now=new Date('2026-09-05T12:00:00Z');const seconds=Math.floor(now.getTime()/1000);const secret='synthetic-test-secret-never-production-12345';
  const verifier=createEvidenceAccessVerifier({secret,issuer:'customer-service-os-edge',tenantId:'tenant-test',environmentId:'test',now:()=>now});
  const claims={accessVersion:'1',workflow:{workflowId:'refund-test'},tenant:{tenantId:'tenant-test',environmentId:'test'},subject:{customerId:'customer-test'},purpose:'refund_evidence_read',request:{requestId:'test-request',traceId:'test-trace'},iss:'customer-service-os-edge',aud:'human-operations-evidence',iat:seconds,exp:seconds+60};
  async function sign(changes:Record<string,unknown>={},type='cso-evidence+jwt') {return new SignJWT({...claims,...changes}).setProtectedHeader({alg:'HS256',typ:type}).sign(new TextEncoder().encode(secret));}
  assert.equal((await verifier(await sign(),'refund_evidence_read')).subjectCustomerId,'customer-test');
  for(const changes of [{purpose:'refund_evidence_upload'},{tenant:{tenantId:'other',environmentId:'test'}},{exp:seconds+61},{exp:seconds-1},{iat:seconds+31},{extra:'forged'},{aud:'other'},{subject:{customerId:'customer-test',staffId:'forged'}}])
    await assert.rejects(verifier(await sign(changes),'refund_evidence_read'));
  await assert.rejects(verifier(await sign({},'cso-context+jwt'),'refund_evidence_read'));
  await assert.rejects(verifier(undefined,'refund_evidence_read'));
});

async function uploadSocketFixture(context: {after: (fn: () => unknown) => void}) {
  const directory=await realpath(await mkdtemp('/private/tmp/cso-photo-abort-test.'));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const current=record();let entered=0;let checked=0;let gate:Promise<void>|undefined;let ownershipGate:Promise<void>|undefined;
  const unused=async()=>{throw new Error('Unexpected repository operation');};
  const repository:RefundEvidenceRepository={
    async get(){checked++;await ownershipGate;return current;},
    async beginUpload(){entered++;await gate;return {record:current,photo:current.document.attachments[0]!,created:false};},
    ensure:unused,finishUpload:unused,review:unused,transition:unused,recoverStaleUploads:unused,purge:unused,
  };
  const app=buildApp({async verifyHuman(){throw new Error('unused');},async sendDecision(){throw new Error('unused');},
    evidence:{repository,store:await PrivateEvidenceStore.create(directory),async verifyCustomer(){return {tenantId:'test-tenant',environmentId:'test',subjectCustomerId:'customer-test',workflowId:'refund-test'};}}});
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert.ok(address&&typeof address!=='string');
  context.after(()=>app.close());
  const sockets=new Set<Socket>();context.after(()=>{for(const socket of sockets)socket.destroy();});
  async function openSocket(complete=false) {
    const socket=connect({host:'127.0.0.1',port:address.port});sockets.add(socket);socket.on('error',()=>undefined);
    await once(socket,'connect');
    socket.write(`POST /internal/v1/customer-refund-evidence/refund-test HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/png\r\nContent-Length: ${complete?1:1000}\r\nX-Cso-Evidence-Assertion: synthetic\r\nX-Cso-Expected-Evidence-Version: 2\r\nIdempotency-Key: abort-test-key\r\nConnection: close\r\n\r\nx`);
    return socket;
  }
  async function probe(){return fetch(`http://127.0.0.1:${address.port}/internal/v1/customer-refund-evidence/refund-test`,{
    method:'POST',headers:{'content-type':'image/png','x-cso-evidence-assertion':'synthetic','x-cso-expected-evidence-version':'2','idempotency-key':'probe-test-key'},body:Buffer.from('x'),signal:AbortSignal.timeout(2000),
  });}
  return {app,openSocket,probe,entered:()=>entered,checked:()=>checked,setGate:(value:Promise<void>|undefined)=>{gate=value;},setOwnershipGate:(value:Promise<void>|undefined)=>{ownershipGate=value;}};
}
async function eventually(check:()=>boolean){
  for(let attempt=0;attempt<100;attempt++){if(check())return;await delay(5);}
  assert.fail('Expected server event did not arrive');
}
test('aborted upload streams do not permanently consume the four global upload slots',async context=>{
  const fixture=await uploadSocketFixture(context);
  const connections:Socket[]=[];
  for(let index=0;index<4;index++)connections.push(await fixture.openSocket());
  await delay(30);
  assert.equal((await fixture.probe()).status,503,'All four incomplete streams must hold their slots');
  for(const socket of connections){socket.destroy();await once(socket,'close');}
  await delay(30);
  assert.equal((await fixture.probe()).status,202,'Disconnected streams must return their slots');
  assert.equal(fixture.entered(),1,'Incomplete aborted streams must not run the upload handler');
});
test('disconnect during active upload work retains its slot until the work settles',async context=>{
  const fixture=await uploadSocketFixture(context);
  const deferred=Promise.withResolvers<void>();fixture.setGate(deferred.promise);
  context.after(()=>deferred.resolve());
  const connections:Socket[]=[];
  for(let index=0;index<4;index++)connections.push(await fixture.openSocket(true));
  await eventually(()=>fixture.entered()===4);
  for(const socket of connections){socket.destroy();await once(socket,'close');}
  await delay(30);
  assert.equal((await fixture.probe()).status,503,'Disconnect must not release a slot while repository/normalization work continues');
  deferred.resolve();fixture.setGate(undefined);await delay(30);
  assert.equal((await fixture.probe()).status,202,'Settled work releases each slot exactly once');
});
test('disconnect while ownership is checked cannot allocate an unreachable upload slot',async context=>{
  const fixture=await uploadSocketFixture(context);
  const deferred=Promise.withResolvers<void>();fixture.setOwnershipGate(deferred.promise);context.after(()=>deferred.resolve());
  const connections:Socket[]=[];
  for(let index=0;index<4;index++)connections.push(await fixture.openSocket());
  await eventually(()=>fixture.checked()===4);
  for(const socket of connections){socket.destroy();await once(socket,'close');}
  await delay(20);fixture.setOwnershipGate(undefined);deferred.resolve();await delay(20);
  assert.equal((await fixture.probe()).status,202);
  assert.equal(fixture.entered(),1);
});
test('socket timeouts release incomplete upload leases without duplicate cleanup',async context=>{
  const fixture=await uploadSocketFixture(context);fixture.app.server.setTimeout(80);
  const connections:Socket[]=[];
  for(let index=0;index<4;index++)connections.push(await fixture.openSocket());
  await Promise.all(connections.map(socket=>once(socket,'close')));
  assert.equal((await fixture.probe()).status,202);
  assert.equal((await fixture.probe()).status,202);
});
