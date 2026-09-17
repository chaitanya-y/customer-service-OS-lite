// Real MCP Gateway, deterministic Vendure read response, no real provider access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeTelemetry } from '../../packages/observability-node/index.mjs';
import { buildApp } from '../../apps/services/integration-gateway/src/app.js';
import { createVendureCommerceProvider } from '../../apps/services/integration-gateway/src/vendure-client.js';
import { createHmacContextAssertionVerifier } from '../../apps/services/integration-gateway/src/trusted-context.js';
import { createHmacContextAssertionSigner } from '../../apps/services/edge-api/src/context-assertion.js';

const telemetry = initializeTelemetry({ serviceName: 'integration-gateway' });
const secret = process.env.CONTEXT_ASSERTION_HMAC_SECRET!;
const provider = createVendureCommerceProvider({
  adminApiUrl: 'http://synthetic.invalid/admin-api', apiKey: 'CANARY_CONTENT', telemetry,
  async fetcher(_url, init) {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('traceparent'), null);
    assert.equal(headers.get('baggage'), null);
    assert.equal(headers.get('vendure-api-key'), 'CANARY_CONTENT');
    assert.ok(JSON.parse(String(init?.body)).query.includes('query'));
    return new Response(JSON.stringify({data:{orders:{totalItems:1,items:[{
      id:'smoke-order',code:'CANARY_CONTENT',state:'Delivered',active:false,currencyCode:'USD',
      orderPlacedAt:'2026-09-16T00:00:00.000Z',totalWithTax:100,
      customer:{id:'smoke-customer',firstName:'CANARY_CONTENT',lastName:'',emailAddress:'synthetic@example.invalid'},
      lines:[],payments:[],fulfillments:[],
    }]}}}), {status:200,headers:{'content-type':'application/json'}});
  },
});
const app = buildApp({commerceProvider:provider,telemetry,verifyContextAssertion:createHmacContextAssertionVerifier({
  secret,expectedIssuer:'smoke-edge',expectedAudience:'integration-gateway',expectedTenantId:'smoke-tenant',expectedEnvironmentId:'local',
})});
try {
  const address = await app.listen({host:'127.0.0.1',port:0});
  const sign = (audience:string) => createHmacContextAssertionSigner({secret,issuer:'smoke-edge',audience,route:{homeRegion:'local',homeCell:'local',routingEpoch:1}})({
    identity:{principalId:'smoke-customer',customerId:'smoke-customer',tenantId:'smoke-tenant',environmentId:'local'},
    requestId:'smoke-request',traceId:'smoke-business-trace',channelId:'customer-chat',
  });
  const env = {...process.env,SMOKE_GATEWAY_URL:address,SMOKE_GATEWAY_ASSERTION:await sign('integration-gateway'),SMOKE_RAG_ASSERTION:await sign('knowledge-rag')};
  const result = await new Promise<string>((resolve,reject) => {
    const child=spawn(fileURLToPath(new URL('../../apps/services/agent-runtime/.venv/bin/python',import.meta.url)),[fileURLToPath(new URL('./smoke-dependency-client.py',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',data=>stdout+=data);
    child.stderr.on('data',data=>stderr+=data);
    const timer=setTimeout(()=>child.kill('SIGTERM'),20_000);
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(`Synthetic client failed: ${stderr.slice(-1500)}`));});
  });
  console.log(result.trim());
} finally {
  await app.close();
  await telemetry.shutdown();
}
