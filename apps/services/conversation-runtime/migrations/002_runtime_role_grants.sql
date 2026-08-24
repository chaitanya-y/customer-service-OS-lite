GRANT CONNECT ON DATABASE customer_service_os TO cso_conversation_app;
GRANT USAGE ON SCHEMA security TO cso_conversation_app;
GRANT USAGE ON SCHEMA conversation TO cso_conversation_app;
GRANT USAGE ON SCHEMA events TO cso_conversation_app;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO cso_conversation_app;
GRANT EXECUTE ON FUNCTION security.current_environment_id() TO cso_conversation_app;
GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA conversation
TO cso_conversation_app;
GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA events
TO cso_conversation_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA conversation
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cso_conversation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA events
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cso_conversation_app;
