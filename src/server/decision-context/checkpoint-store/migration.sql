-- Isolated candidate only. Main integrator owns official migration order and grants.
-- Functions are internal storage primitives, not an authenticated service.
CREATE SCHEMA IF NOT EXISTS e03_checkpoint;
REVOKE ALL ON SCHEMA e03_checkpoint FROM PUBLIC;
CREATE TABLE IF NOT EXISTS e03_checkpoint.heads (
  owner_id text NOT NULL, trip_id text NOT NULL, workspace text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  payload jsonb, payload_digest text, saved_at text NOT NULL, expires_at text,
  deleted boolean NOT NULL,
  PRIMARY KEY(owner_id, trip_id, workspace),
  CHECK ((deleted AND payload IS NULL AND payload_digest IS NULL) OR
         (NOT deleted AND payload IS NOT NULL AND payload_digest IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS e03_checkpoint.receipts (
  owner_id text NOT NULL, trip_id text NOT NULL, workspace text NOT NULL,
  operation_key text NOT NULL, request_digest text NOT NULL, ack jsonb NOT NULL,
  PRIMARY KEY(owner_id, trip_id, workspace, operation_key),
  FOREIGN KEY(owner_id, trip_id, workspace) REFERENCES e03_checkpoint.heads(owner_id, trip_id, workspace)
);
REVOKE ALL ON ALL TABLES IN SCHEMA e03_checkpoint FROM PUBLIC;

CREATE OR REPLACE FUNCTION e03_checkpoint.write_scene(
  p_owner text, p_trip text, p_workspace text, p_expected bigint, p_key text,
  p_request_digest text, p_payload jsonb, p_payload_digest text,
  p_saved_at text, p_expires_at text, p_delete boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE h e03_checkpoint.heads%ROWTYPE; r e03_checkpoint.receipts%ROWTYPE;
  rev bigint; result jsonb;
BEGIN
  -- Advisory lock covers even a not-yet-existing head; identity tuple encoding is unambiguous.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_owner,p_trip,p_workspace)::text, 0));
  SELECT * INTO h FROM e03_checkpoint.heads WHERE owner_id=p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  rev := COALESCE(h.revision, 0);
  SELECT * INTO r FROM e03_checkpoint.receipts WHERE owner_id=p_owner AND trip_id=p_trip AND workspace=p_workspace AND operation_key=p_key;
  IF FOUND THEN
    IF r.request_digest <> p_request_digest THEN RETURN jsonb_build_object('fault','CHECKPOINT_IDEMPOTENCY'); END IF;
    IF rev <> (r.ack->>'checkpoint_revision')::bigint THEN RETURN jsonb_build_object('fault','CHECKPOINT_SUPERSEDED'); END IF;
    RETURN jsonb_build_object('ack',r.ack);
  END IF;
  IF rev <> p_expected THEN RETURN jsonb_build_object('fault','CHECKPOINT_CONFLICT'); END IF;
  IF rev >= 9007199254740991 THEN RETURN jsonb_build_object('fault','CHECKPOINT_STORAGE'); END IF;
  IF p_delete AND (h.revision IS NULL OR h.deleted) THEN RETURN jsonb_build_object('fault','CHECKPOINT_NOT_FOUND'); END IF;
  IF NOT p_delete AND h.revision IS NOT NULL AND NOT h.deleted AND h.expires_at IS NOT NULL AND h.expires_at::timestamptz <= p_saved_at::timestamptz THEN
    RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED');
  END IF;
  result := jsonb_build_object('workspace_key',p_workspace,'checkpoint_revision',rev+1,'saved_at',p_saved_at,
    'expires_at',p_expires_at,'payload_digest',p_payload_digest,'durable',true,'deleted',p_delete);
  INSERT INTO e03_checkpoint.heads(owner_id,trip_id,workspace,revision,payload,payload_digest,saved_at,expires_at,deleted)
    VALUES(p_owner,p_trip,p_workspace,rev+1,p_payload,p_payload_digest,p_saved_at,p_expires_at,p_delete)
    ON CONFLICT(owner_id,trip_id,workspace) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,
    payload_digest=EXCLUDED.payload_digest,saved_at=EXCLUDED.saved_at,expires_at=EXCLUDED.expires_at,deleted=EXCLUDED.deleted;
  IF p_delete THEN DELETE FROM e03_checkpoint.receipts WHERE owner_id=p_owner AND trip_id=p_trip AND workspace=p_workspace; END IF;
  INSERT INTO e03_checkpoint.receipts VALUES(p_owner,p_trip,p_workspace,p_key,p_request_digest,result);
  RETURN jsonb_build_object('ack',result);
END $$;

CREATE OR REPLACE FUNCTION e03_checkpoint.read_scene(p_owner text,p_trip text,p_workspace text,p_now text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE h e03_checkpoint.heads%ROWTYPE;
BEGIN
  SELECT * INTO h FROM e03_checkpoint.heads WHERE owner_id=p_owner AND trip_id=p_trip AND workspace=p_workspace;
  IF NOT FOUND OR h.deleted THEN RETURN jsonb_build_object('fault','CHECKPOINT_NOT_FOUND'); END IF;
  IF h.expires_at IS NOT NULL AND h.expires_at::timestamptz <= p_now::timestamptz THEN RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED'); END IF;
  RETURN jsonb_build_object('revision',h.revision,'saved_at',h.saved_at,'expires_at',h.expires_at,'payload_digest',h.payload_digest,'payload',h.payload);
END $$;

CREATE OR REPLACE FUNCTION e03_checkpoint.list_scenes(p_owner text,p_trip text,p_now text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('workspace_key',workspace,'checkpoint_revision',revision,
    'saved_at',saved_at,'expires_at',expires_at,'available',NOT deleted AND (expires_at IS NULL OR expires_at::timestamptz > p_now::timestamptz)) ORDER BY workspace),'[]'::jsonb)
  FROM e03_checkpoint.heads WHERE owner_id=p_owner AND trip_id=p_trip
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA e03_checkpoint FROM PUBLIC;
