ALTER TABLE conversation.messages
  ADD COLUMN refund_workflow_id text;

ALTER TABLE conversation.messages
  ADD CONSTRAINT messages_refund_workflow_id_format
  CHECK (
    refund_workflow_id IS NULL
    OR (
      char_length(refund_workflow_id) BETWEEN 1 AND 200
      AND refund_workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    )
  );

CREATE INDEX messages_by_refund_workflow
ON conversation.messages (
  tenant_id,
  environment_id,
  refund_workflow_id
)
WHERE refund_workflow_id IS NOT NULL;
