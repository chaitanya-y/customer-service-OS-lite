import Fastify from 'fastify';
import { z } from 'zod';
import { HUMAN_ASSERTION_HEADER, type HumanAccess } from './human-access.js';

const paramsSchema = z.object({ workflowId: z.string().min(1).max(200) });
const bodySchema = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'RESOLVE_TAKEOVER']), reasonCode: z.string().min(1).max(100).optional() }).strict();
export type SendDecision = (input: { workflowId: string; access: HumanAccess; decision: 'APPROVE' | 'REJECT' | 'RESOLVE_TAKEOVER'; reasonCode?: string }) => Promise<void>;
export function buildApp(options: { verifyHuman: (value: string | undefined) => Promise<HumanAccess>; sendDecision: SendDecision }) {
  const app = Fastify();
  app.get('/health', async () => ({ service: 'human-operations', status: 'ok' }));
  app.post('/internal/v1/refund-workflows/:workflowId/decision', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params); const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'invalid_human_decision', message: 'Human decision is invalid' } });
    try {
      const access = await options.verifyHuman(typeof request.headers[HUMAN_ASSERTION_HEADER] === 'string' ? request.headers[HUMAN_ASSERTION_HEADER] : undefined);
      await options.sendDecision({
        workflowId: params.data.workflowId,
        access,
        decision: body.data.decision,
        ...(body.data.reasonCode === undefined ? {} : { reasonCode: body.data.reasonCode }),
      });
      return reply.code(202).send({ workflow_id: params.data.workflowId, status: 'decision_received' });
    } catch { return reply.code(401).send({ error: { code: 'human_unauthorized', message: 'Human authorization is required' } }); }
  });
  return app;
}
