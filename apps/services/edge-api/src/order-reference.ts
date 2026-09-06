const ORDER_REFERENCE_CANDIDATE = /\b[A-Za-z0-9][A-Za-z0-9-]{7,99}\b/g;

type OrderReferenceResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'unique'; value: string }>;

function resolveOrderReferenceFromText(
  customerMessage: string,
): OrderReferenceResolution {
  const candidates = new Set<string>();

  for (const match of customerMessage.matchAll(ORDER_REFERENCE_CANDIDATE)) {
    const candidate = match[0];
    if (/[A-Za-z]/.test(candidate) && /\d/.test(candidate)) {
      candidates.add(candidate.toUpperCase());
    }
  }

  if (candidates.size === 0) return { kind: 'none' };
  if (candidates.size > 1) return { kind: 'ambiguous' };
  const value = [...candidates][0];
  if (value === undefined) return { kind: 'none' };
  return { kind: 'unique', value };
}

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

  const resolution = resolveOrderReferenceFromText(input.customerMessage);
  return resolution.kind === 'unique' ? resolution.value : undefined;
}

/**
 * Uses the most recent unambiguous customer reference. An explicit route field
 * remains authoritative. A later ambiguous reference intentionally prevents
 * falling back to an older order.
 */
export function resolveOrderReferenceFromCustomerMessages(input: Readonly<{
  customerMessages: readonly Readonly<{ text: string }>[];
  explicitOrderReference: string | undefined;
}>): string | undefined {
  if (input.explicitOrderReference !== undefined) {
    return input.explicitOrderReference;
  }

  for (const message of input.customerMessages.toReversed()) {
    const resolution = resolveOrderReferenceFromText(message.text);
    if (resolution.kind === 'ambiguous') return undefined;
    if (resolution.kind === 'unique') return resolution.value;
  }

  return undefined;
}
