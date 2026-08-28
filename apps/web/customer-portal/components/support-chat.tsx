"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  MAX_CUSTOMER_MESSAGE_LENGTH,
  CustomerConversationApiError,
  createCustomerConversation,
  isValidCustomerMessage,
  loadCustomerConversation,
  sendCustomerMessage,
  type CustomerChatMessage,
  type RefundWorkflowLink,
} from "./conversation-api";
import styles from "./support-chat.module.css";

const CONVERSATION_STORAGE_KEY = "cso.current-conversation-id";
const ORDER_REFERENCE_LIMIT = 100;

type PendingTurn = Readonly<{
  clientMessageId: string;
  conversationIdempotencyKey: string;
  idempotencyKey: string;
  orderReference?: string;
  text: string;
}>;

function formatMessageTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function mergeMessages(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[],
): ChatMessage[] {
  const messages = new Map(previous.map((message) => [message.messageId, message]));
  for (const message of next) messages.set(message.messageId, message);
  return [...messages.values()];
}

type ChatMessage = CustomerChatMessage & Readonly<{
  refundWorkflow?: RefundWorkflowLink;
}>;

export function SupportChat() {
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [clarification, setClarification] = useState<string>();
  const [isLoadingConversation, setIsLoadingConversation] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const pendingTurn = useRef<PendingTurn | undefined>(undefined);

  const loadConversation = useCallback(async (id: string) => {
    setIsLoadingConversation(true);
    setErrorMessage(undefined);
    try {
      const conversation = await loadCustomerConversation(id);
      setConversationId(conversation.conversationId);
      setMessages(conversation.messages);
    } catch (error) {
      if (error instanceof CustomerConversationApiError && error.status === 404) {
        window.sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
        setConversationId(undefined);
        setMessages([]);
      }
      setErrorMessage(error instanceof Error ? error.message : "We could not load this conversation.");
    } finally {
      setIsLoadingConversation(false);
    }
  }, []);

  useEffect(() => {
    const storedConversationId = window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!storedConversationId) {
      setIsLoadingConversation(false);
      return;
    }

    setConversationId(storedConversationId);
    void loadConversation(storedConversationId);
  }, [loadConversation]);

  function updateDraft(value: string) {
    setDraft(value);
    setErrorMessage(undefined);
    setClarification(undefined);
    if (pendingTurn.current?.text !== value.trim()) pendingTurn.current = undefined;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    const normalizedOrderReference = orderReference.trim();

    if (!isValidCustomerMessage(text)) {
      setErrorMessage(
        text
          ? `Please keep your message within ${MAX_CUSTOMER_MESSAGE_LENGTH.toLocaleString()} characters.`
          : "Describe what happened before sending your message.",
      );
      return;
    }

    const existingPendingTurn = pendingTurn.current;
    const canRetryPendingTurn = existingPendingTurn
      && existingPendingTurn.text === text
      && existingPendingTurn.orderReference === (normalizedOrderReference || undefined);
    const nextPendingTurn: PendingTurn = canRetryPendingTurn
      ? existingPendingTurn
      : {
        clientMessageId: crypto.randomUUID(),
        conversationIdempotencyKey: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        ...(normalizedOrderReference ? { orderReference: normalizedOrderReference } : {}),
        text,
      };

    pendingTurn.current = nextPendingTurn;
    setErrorMessage(undefined);
    setClarification(undefined);
    setIsSending(true);

    try {
      let currentConversationId = conversationId;
      if (!currentConversationId) {
        const conversation = await createCustomerConversation(nextPendingTurn.conversationIdempotencyKey);
        currentConversationId = conversation.conversationId;
        window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, currentConversationId);
        setConversationId(currentConversationId);
      }

      const turn = await sendCustomerMessage({
        clientMessageId: nextPendingTurn.clientMessageId,
        conversationId: currentConversationId,
        idempotencyKey: nextPendingTurn.idempotencyKey,
        ...(nextPendingTurn.orderReference ? { orderReference: nextPendingTurn.orderReference } : {}),
        text: nextPendingTurn.text,
      });
      const customerMessage: CustomerChatMessage = {
        messageId: turn.customerMessageId,
        sender: "customer",
        text: nextPendingTurn.text,
      };
      const assistantMessage = turn.assistantMessage
        ? {
          ...turn.assistantMessage,
              ...(turn.refundWorkflow ? { refundWorkflow: turn.refundWorkflow } : {}),
        }
        : undefined;
      setMessages((previous) => mergeMessages(
        previous,
        [customerMessage, ...(assistantMessage ? [assistantMessage] : [])],
      ));
      setDraft("");
      setOrderReference("");
      pendingTurn.current = undefined;

      if (!turn.assistantMessage) {
        setClarification(turn.refundWorkflow
          ? "Your refund request is ready to review."
          : "We need a little more information before we can continue. Please add any details you can.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "We could not send your message. Please try again.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className={styles.chatPanel} aria-labelledby="support-heading">
      <header className={styles.chatHeader}>
        <span className="cso-eyebrow">Support conversation</span>
        <h1 id="support-heading">How can we help?</h1>
        <p>Tell us what happened. We will show the exact refund amount before anything is submitted.</p>
      </header>

      <div aria-busy={isLoadingConversation || isSending} aria-live="polite" className={styles.transcript} role="log">
        {isLoadingConversation ? <p className={styles.loading}>Loading your conversation…</p> : null}
        {!isLoadingConversation && messages.length === 0 ? (
          <div className={styles.emptyState}>
            <h2>Start a conversation</h2>
            <p>Ask about an order, delivery, or refund. A support specialist will guide you through the next step.</p>
          </div>
        ) : null}
        {messages.map((message) => {
          const messageTime = formatMessageTime(message.createdAt);
          const isCustomer = message.sender === "customer";
          const workflow = message.refundWorkflow;
          return (
            <article
              aria-label={isCustomer ? "Your message" : "Support assistant message"}
              className={`${styles.message} ${isCustomer ? styles.messageCustomer : styles.messageAssistant}`}
              key={message.messageId}
            >
              <span className={styles.messageLabel}>{isCustomer ? "You" : "Support assistant"}</span>
              <p className={styles.bubble}>{message.text}</p>
              {messageTime ? <time dateTime={message.createdAt}>{messageTime}</time> : null}
              {workflow ? (
                <aside className={styles.workflowCard}>
                  <strong>Your refund request is ready to review</strong>
                  <p>View the current status and any next action before a refund is submitted.</p>
                  <a href={`/refunds/${encodeURIComponent(workflow.workflowId)}`}>View refund request</a>
                </aside>
              ) : null}
            </article>
          );
        })}
      </div>

      <form className={styles.composer} noValidate onSubmit={submit}>
        <label className={styles.composerLabel} htmlFor="support-message">Your message</label>
        <textarea
          aria-describedby="support-message-count"
          disabled={isSending}
          id="support-message"
          maxLength={MAX_CUSTOMER_MESSAGE_LENGTH}
          onChange={(event) => updateDraft(event.target.value)}
          placeholder="For example, my order arrived damaged and I would like help with a refund."
          required
          rows={4}
          value={draft}
        />
        <details className={styles.orderReference}>
          <summary>Add an order reference if you have one</summary>
          <label htmlFor="support-order-reference">
            Order reference
            <input
              disabled={isSending}
              id="support-order-reference"
              maxLength={ORDER_REFERENCE_LIMIT}
              onChange={(event) => setOrderReference(event.target.value)}
              placeholder="For example, QXB4NEW2EPG6YJ7Q"
              type="text"
              value={orderReference}
            />
          </label>
        </details>
        {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
        {clarification ? <p className={styles.clarification} role="status">{clarification}</p> : null}
        <div className={styles.composerFooter}>
          <span className={styles.characterCount} id="support-message-count">{draft.length}/{MAX_CUSTOMER_MESSAGE_LENGTH.toLocaleString()}</span>
          <button className={`cso-primary-button ${styles.sendButton}`} disabled={isSending || isLoadingConversation} type="submit">
            {isSending ? "Sending…" : "Send message"}
          </button>
        </div>
      </form>
    </section>
  );
}
