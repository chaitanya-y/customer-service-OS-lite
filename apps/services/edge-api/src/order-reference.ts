const ORDER_REFERENCE_CANDIDATE = /\b[A-Za-z0-9][A-Za-z0-9-]{7,99}\b/g;

/**
 * Resolves an optional customer-supplied order reference without relying on an
 * LLM. An explicit field always wins. Free text is accepted only when it has
 * exactly one code-like token containing both a letter and a digit.
 */
export function resolveOrderReference(input: Readonly<{
  customerMessage: string;
  explicitOrderReference: string | undefined;
}>): string | undefined {
  if (input.explicitOrderReference !== undefined) {
    return input.explicitOrderReference;
  }

  const candidates = new Set<string>();

  for (const match of input.customerMessage.matchAll(ORDER_REFERENCE_CANDIDATE)) {
    const candidate = match[0];
    if (/[A-Za-z]/.test(candidate) && /\d/.test(candidate)) {
      candidates.add(candidate.toUpperCase());
    }
  }

  return candidates.size === 1 ? [...candidates][0] : undefined;
}
