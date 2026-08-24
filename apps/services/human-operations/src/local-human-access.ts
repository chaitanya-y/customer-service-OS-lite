import { SignJWT } from 'jose';

export type LocalHumanIdentity = Readonly<{
  staffId: string;
  tenantId: string;
  environmentId: string;
  role: 'REFUND_APPROVER' | 'REFUND_SUPERVISOR';
}>;

/** Creates a short-lived local-only assertion for exercising Human Operations. */
export async function signLocalHumanAccessAssertion(input: Readonly<{
  secret: string;
  issuer: string;
  audience: string;
  identity: LocalHumanIdentity;
  expiresInSeconds?: number;
}>): Promise<string> {
  const expiresInSeconds = input.expiresInSeconds ?? 300;
  if (input.secret.length < 32 || expiresInSeconds < 1 || !Number.isInteger(expiresInSeconds)) {
    throw new Error('INVALID_LOCAL_HUMAN_ASSERTION_CONFIG');
  }

  return new SignJWT({
    staffId: input.identity.staffId,
    tenantId: input.identity.tenantId,
    environmentId: input.identity.environmentId,
    role: input.identity.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'cso-human+jwt' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(new TextEncoder().encode(input.secret));
}
