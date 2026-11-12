CREATE TABLE IF NOT EXISTS e04_runtime.tool_invocations (
  owner_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  query_digest CHAR(64) NOT NULL,
  arguments_digest CHAR(64) NOT NULL,
  arguments_json JSONB NOT NULL,
  plan_digest CHAR(64) NOT NULL,
  basis_state_revision BIGINT NOT NULL CHECK (basis_state_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stale')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 2),
  completion_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, trip_id, workspace_key, decision_id, action_id, step_id),
  UNIQUE (owner_id, trip_id, workspace_key, invocation_id),
  FOREIGN KEY (owner_id, trip_id, workspace_key, decision_id, action_id, step_id)
    REFERENCES e04_runtime.steps(owner_id, trip_id, workspace_key, decision_id, action_id, step_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS e04_runtime.tool_completions (
  owner_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  completion_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  completion_digest CHAR(64) NOT NULL,
  completion_json JSONB NOT NULL,
  raw_result_json JSONB NOT NULL,
  current_usable BOOLEAN NOT NULL,
  state_revision_after BIGINT NOT NULL CHECK (state_revision_after >= 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, trip_id, workspace_key, completion_id),
  UNIQUE (owner_id, trip_id, workspace_key, decision_id, action_id, step_id),
  FOREIGN KEY (owner_id, trip_id, workspace_key, decision_id, action_id, step_id)
    REFERENCES e04_runtime.tool_invocations(owner_id, trip_id, workspace_key, decision_id, action_id, step_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS e04_runtime_tool_completion_trigger
  ON e04_runtime.tool_completions(owner_id, trip_id, workspace_key, completion_id, current_usable);

REVOKE ALL ON e04_runtime.tool_invocations, e04_runtime.tool_completions FROM PUBLIC;
