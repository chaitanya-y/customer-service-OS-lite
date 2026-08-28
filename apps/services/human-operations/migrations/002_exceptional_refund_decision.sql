ALTER TABLE human_operations.decision_outbox
  DROP CONSTRAINT IF EXISTS decision_outbox_decision_check;

ALTER TABLE human_operations.decision_outbox
  ADD CONSTRAINT decision_outbox_decision_check
  CHECK (decision IN ('APPROVE', 'REJECT', 'RESOLVE_TAKEOVER', 'APPROVE_EXCEPTIONAL_REFUND'));
