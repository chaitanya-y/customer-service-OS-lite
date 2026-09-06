ALTER TABLE human_operations.refund_cases DROP CONSTRAINT refund_cases_case_type_check;
ALTER TABLE human_operations.refund_cases ADD CONSTRAINT refund_cases_case_type_check
  CHECK (case_type IN ('REFUND_APPROVAL', 'REFUND_TAKEOVER', 'REFUND_EVIDENCE_REVIEW'));
ALTER TABLE human_operations.case_audit_events DROP CONSTRAINT case_audit_events_event_type_check;
ALTER TABLE human_operations.case_audit_events ADD CONSTRAINT case_audit_events_event_type_check
  CHECK (event_type IN ('CASE_OPENED','CASE_CLAIMED','DECISION_RECORDED','CASE_CLOSED','EVIDENCE_UPLOAD_RESERVED','EVIDENCE_VALIDATED','EVIDENCE_REVIEWED','EVIDENCE_PURGED','CASE_PHASE_CHANGED'));
ALTER TABLE human_operations.case_audit_events DROP CONSTRAINT case_audit_events_actor_type_check;
ALTER TABLE human_operations.case_audit_events ADD CONSTRAINT case_audit_events_actor_type_check
  CHECK (actor_type IN ('WORKFLOW','HUMAN','CUSTOMER'));

CREATE TABLE human_operations.refund_evidence (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  workflow_id text NOT NULL,
  case_id text NOT NULL,
  subject_customer_id text NOT NULL,
  order_id text NOT NULL,
  proposal_id text NOT NULL,
  selected_item_ids jsonb NOT NULL CHECK (jsonb_typeof(selected_item_ids) = 'array'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  PRIMARY KEY (tenant_id, environment_id, workflow_id),
  UNIQUE (tenant_id, environment_id, case_id),
  FOREIGN KEY (tenant_id, environment_id, case_id)
    REFERENCES human_operations.refund_cases(tenant_id, environment_id, case_id)
);
ALTER TABLE human_operations.refund_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.refund_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_environment_scope ON human_operations.refund_evidence
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cso_human_operations_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON human_operations.refund_evidence TO cso_human_operations_app;
  END IF;
END
$$;
