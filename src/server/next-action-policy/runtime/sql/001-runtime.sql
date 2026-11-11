CREATE SCHEMA IF NOT EXISTS e04_runtime;
REVOKE ALL ON SCHEMA e04_runtime FROM PUBLIC;

CREATE TABLE IF NOT EXISTS e04_runtime.decisions (
  owner_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL,
  plan_digest CHAR(64) NOT NULL,
  eligibility_digest CHAR(64) NOT NULL,
  source_event_ref TEXT NOT NULL,
  state_revision BIGINT NOT NULL CHECK (state_revision >= 0),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  request_json JSONB NOT NULL,
  plan_json JSONB NOT NULL,
  content_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, trip_id, workspace_key, decision_id)
);

CREATE TABLE IF NOT EXISTS e04_runtime.actions (
  owner_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('proposed','eligible','blocked','waiting_user','running','partial','succeeded','failed','stale','cancelled')),
  receipt_lookup_required BOOLEAN NOT NULL DEFAULT FALSE,
  result_json JSONB,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, trip_id, workspace_key, decision_id, action_id),
  FOREIGN KEY (owner_id, trip_id, workspace_key, decision_id)
    REFERENCES e04_runtime.decisions(owner_id, trip_id, workspace_key, decision_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS e04_runtime.steps (
  owner_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('read','query','calculate','change','ask','deliver')),
  depends_on JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','stale')),
  claim_token TEXT,
  result_json JSONB,
  attempted_at TIMESTAMPTZ(6),
  completed_at TIMESTAMPTZ(6),
  PRIMARY KEY (owner_id, trip_id, workspace_key, decision_id, action_id, step_id),
  FOREIGN KEY (owner_id, trip_id, workspace_key, decision_id, action_id)
    REFERENCES e04_runtime.actions(owner_id, trip_id, workspace_key, decision_id, action_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS e04_runtime_steps_claimable
  ON e04_runtime.steps(owner_id, trip_id, workspace_key, decision_id, action_id, status, position);

REVOKE ALL ON ALL TABLES IN SCHEMA e04_runtime FROM PUBLIC;
