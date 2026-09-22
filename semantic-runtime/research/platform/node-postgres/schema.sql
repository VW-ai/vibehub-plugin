-- A fresh disposable cluster only; never apply to an existing service/database.
CREATE ROLE spike_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE TABLE memberships (subject text, tenant_id text, project_id text, role text, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(subject, tenant_id, project_id));
CREATE TABLE project_state (tenant_id text, project_id text, revision integer NOT NULL DEFAULT 0, value integer NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id, project_id));
CREATE TABLE jobs (tenant_id text, project_id text, job_id text, idempotency_key text NOT NULL,
  revision integer NOT NULL, status text NOT NULL, state jsonb NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id, project_id, job_id), UNIQUE(tenant_id, project_id, idempotency_key));
CREATE TABLE outbox (sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id text NOT NULL, project_id text NOT NULL, kind text NOT NULL, entity_id text NOT NULL,
  revision integer NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(tenant_id,project_id,sequence),
  UNIQUE(tenant_id, project_id, kind, entity_id, revision));
CREATE INDEX jobs_queued ON jobs(tenant_id,project_id,status,enqueued_at);
CREATE INDEX outbox_scope_cursor ON outbox(tenant_id,project_id,sequence);
ALTER TABLE project_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_state FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_memberships ON memberships USING(tenant_id = current_setting('spike.tenant',true) AND project_id = current_setting('spike.project',true));
CREATE POLICY scope_state ON project_state USING(tenant_id = current_setting('spike.tenant',true) AND project_id = current_setting('spike.project',true));
CREATE POLICY scope_jobs ON jobs USING(tenant_id = current_setting('spike.tenant',true) AND project_id = current_setting('spike.project',true));
CREATE POLICY scope_outbox ON outbox USING(tenant_id = current_setting('spike.tenant',true) AND project_id = current_setting('spike.project',true));
GRANT SELECT,DELETE ON memberships TO spike_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON project_state,jobs,outbox TO spike_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO spike_app;
