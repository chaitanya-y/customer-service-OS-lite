CREATE SCHEMA security;
CREATE SCHEMA conversation;
CREATE SCHEMA events;

CREATE FUNCTION security.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE FUNCTION security.current_environment_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.environment_id', true), '')
$$;

CREATE TABLE conversation.conversations (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  conversation_id uuid NOT NULL,
  subject_customer_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('web')),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  control_mode text NOT NULL CHECK (control_mode IN ('AI', 'QUEUED', 'HUMAN')),
  next_sequence_number bigint NOT NULL CHECK (next_sequence_number >= 1),
  record_version bigint NOT NULL CHECK (record_version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, conversation_id)
);

CREATE TABLE conversation.message_payloads (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  payload_id uuid NOT NULL,
  ciphertext bytea NOT NULL,
  initialization_vector bytea NOT NULL CHECK (octet_length(initialization_vector) = 12),
  authentication_tag bytea NOT NULL CHECK (octet_length(authentication_tag) = 16),
  encryption_key_version text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, payload_id)
);

CREATE TABLE conversation.messages (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  conversation_id uuid NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number >= 1),
  message_id uuid NOT NULL,
  client_message_id text NOT NULL,
  sender_kind text NOT NULL CHECK (sender_kind IN ('END_CUSTOMER', 'ASSISTANT', 'WORKFORCE')),
  payload_id uuid NOT NULL,
  content_type text NOT NULL,
  content_length integer NOT NULL CHECK (content_length >= 0 AND content_length <= 32768),
  content_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('COMMITTED', 'DISCARDED')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, conversation_id, sequence_number),
  UNIQUE (tenant_id, environment_id, message_id),
  UNIQUE (tenant_id, environment_id, conversation_id, client_message_id),
  FOREIGN KEY (tenant_id, environment_id, conversation_id)
    REFERENCES conversation.conversations (tenant_id, environment_id, conversation_id),
  FOREIGN KEY (tenant_id, environment_id, payload_id)
    REFERENCES conversation.message_payloads (tenant_id, environment_id, payload_id)
);

CREATE TABLE events.idempotency_keys (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  operation text NOT NULL,
  resource_scope text NOT NULL,
  idempotency_key text NOT NULL,
  canonical_request_hash char(64) NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_id,
    environment_id,
    operation,
    resource_scope,
    idempotency_key
  )
);

CREATE TABLE events.outbox (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence >= 1),
  routing_epoch bigint NOT NULL CHECK (routing_epoch >= 1),
  trace_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'PUBLISHED')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, event_id),
  UNIQUE (
    tenant_id,
    environment_id,
    event_type,
    aggregate_id,
    aggregate_sequence
  )
);

CREATE INDEX messages_by_conversation
ON conversation.messages (
  tenant_id,
  environment_id,
  conversation_id,
  sequence_number
);

CREATE INDEX pending_outbox_by_age
ON events.outbox (status, created_at)
WHERE status = 'PENDING';

ALTER TABLE conversation.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope
ON conversation.conversations
USING (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
)
WITH CHECK (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
);

ALTER TABLE conversation.message_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation.message_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope
ON conversation.message_payloads
USING (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
)
WITH CHECK (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
);

ALTER TABLE conversation.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope
ON conversation.messages
USING (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
)
WITH CHECK (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
);

ALTER TABLE events.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope
ON events.idempotency_keys
USING (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
)
WITH CHECK (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
);

ALTER TABLE events.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE events.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope
ON events.outbox
USING (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
)
WITH CHECK (
  tenant_id = security.current_tenant_id()
  AND environment_id = security.current_environment_id()
);
