export const MAX_CUSTOMER_CONVERSATION_MESSAGES = 8;
export const MAX_CUSTOMER_CONVERSATION_MESSAGE_CHARACTERS = 2_000;
export const MAX_CUSTOMER_CONVERSATION_CONTEXT_CHARACTERS = 8_000;

export type CustomerConversationMessage = Readonly<{
  sequence_number: number;
  text: string;
}>;

type ConversationTranscriptMessage = Readonly<{
  messageId: string;
  sequenceNumber: number;
  senderKind: string;
  text: string;
}>;

type BuildCustomerConversationContextInput = Readonly<{
  messages: readonly ConversationTranscriptMessage[];
  acceptedCustomerMessage: Readonly<{
    messageId: string;
    text: string;
  }>;
}>;

/**
 * Produces the small, ordered, customer-only history the Agent Runtime may use
 * as untrusted conversational context. Assistant text is deliberately excluded:
 * it is not a source of customer facts and could otherwise become prompt input.
 */
export function buildCustomerConversationContext(
  input: BuildCustomerConversationContextInput,
): CustomerConversationMessage[] {
  const customerMessages = input.messages
    .filter((message) => message.senderKind === 'END_CUSTOMER')
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);

  const acceptedMessage = customerMessages.find(
    (message) =>
      message.messageId === input.acceptedCustomerMessage.messageId &&
      message.text === input.acceptedCustomerMessage.text,
  );
  if (!acceptedMessage) {
    throw new Error('The persisted conversation is missing the accepted customer message');
  }

  const selected: CustomerConversationMessage[] = [];
  let totalCharacters = 0;

  for (const message of customerMessages.toReversed()) {
    if (message.text.length > MAX_CUSTOMER_CONVERSATION_MESSAGE_CHARACTERS) {
      continue;
    }
    if (
      selected.length === MAX_CUSTOMER_CONVERSATION_MESSAGES ||
      totalCharacters + message.text.length >
        MAX_CUSTOMER_CONVERSATION_CONTEXT_CHARACTERS
    ) {
      continue;
    }

    selected.push({
      sequence_number: message.sequenceNumber,
      text: message.text,
    });
    totalCharacters += message.text.length;
  }

  const context = selected.toReversed();
  if (
    !context.some(
      (message) => message.sequence_number === acceptedMessage.sequenceNumber,
    )
  ) {
    throw new Error('The accepted customer message exceeds the conversation context limits');
  }

  return context;
}
