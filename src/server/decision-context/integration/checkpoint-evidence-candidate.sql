-- Internal integration candidate only. Install after the E11 and checkpoint
-- candidates, in an isolated test DB. No production migration or grants.
-- This is deliberately restricted to unprocessed, source-bound tasks; it is
-- not a scene-restored implementation and never proves backup cleanup.
-- A witness records only an event actually embedded in a verified saved scene.
-- It does not attest that task, model, TS, draft or historic inputs are complete.
-- Its scene reference is changed/removed atomically with the scene companion.
CREATE TABLE public."HostEvidenceSceneEventWitness" (
  scene_ref TEXT NOT NULL REFERENCES public."HostEvidenceScene"(scene_ref) ON UPDATE CASCADE ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES public."HostEvidenceEvent"(event_id),
  PRIMARY KEY(scene_ref,event_id)
);
REVOKE ALL ON public."HostEvidenceSceneEventWitness" FROM PUBLIC;
-- Read the current deletion revision privately, then lock/recheck it through
-- the existing bound Session/workspace/lifecycle guard. No revision leaks.
CREATE FUNCTION public.host_checkpoint_scope_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE rev BIGINT;
BEGIN
  SELECT retention_revision INTO rev FROM public."HostEvidenceWorkspace" WHERE owner_id=p_owner AND trip_id=p_trip
    AND workspace_key=p_workspace AND session_ref=p_session AND capability_token=p_capability;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN public.host_evidence_checkpoint_probe_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,rev);
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_scope_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION public.host_checkpoint_sources_valid_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_payload JSONB,p_restore BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE item JSONB; src RECORD; scope_event RECORD; task_hash TEXT; direct_ok BOOLEAN; question_anchored BOOLEAN; count_sources INT;
  doc_revision BIGINT; retention_revision BIGINT; event_count BIGINT; doc_snapshot JSONB; actual_versions JSONB; supplied_versions JSONB; actual_deferred JSONB; supplied_deferred JSONB; life public."HostEvidenceTripLifecycle"%ROWTYPE; checked_at TIMESTAMPTZ;
BEGIN
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
  -- Existing Task question/free-text fields do not prove complete provenance.
  -- After any workspace deletion, do not recreate a scene from old inputs.
  SELECT w.retention_revision INTO retention_revision FROM public."HostEvidenceWorkspace" w
    WHERE w.owner_id=p_owner AND w.trip_id=p_trip AND w.workspace_key=p_workspace;
  IF retention_revision IS DISTINCT FROM 0 THEN RETURN FALSE; END IF;
  -- Locks follow TS -> auth -> workspace -> lifecycle -> checkpoint -> source.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  PERFORM 1 FROM e03_checkpoint.heads WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  SELECT "revision", "snapshot" INTO doc_revision,doc_snapshot FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_payload->>'trip_id' IS DISTINCT FROM p_trip OR
     (NOT p_restore AND (p_payload->>'captured_state_revision')::BIGINT IS DISTINCT FROM doc_revision) OR
     jsonb_typeof(p_payload->'tasks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'tasks')=0 OR
     jsonb_typeof(p_payload->'drafts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'drafts')<>0 OR
     jsonb_typeof(p_payload->'captured_object_versions') IS DISTINCT FROM 'array' OR
     jsonb_typeof(doc_snapshot->'objects') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  -- TS object identifiers are not yet proven opaque or source-complete. Keep
  -- the candidate closed for saved TS identifiers rather than assuming that
  -- their presence in the authoritative document proves their origin.
  IF jsonb_array_length(p_payload->'captured_object_versions')<>0 OR
     jsonb_typeof(p_payload->'view'->'comparison_refs') IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_payload->'view'->'comparison_refs')<>0 OR
     p_payload->'view'->>'selected_id' IS NOT NULL OR
     jsonb_typeof(p_payload->'deferred_issue_ids') IS DISTINCT FROM 'array' OR
     jsonb_array_length(p_payload->'deferred_issue_ids')<>0 THEN RETURN FALSE; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v->'id','version',v->'version') ORDER BY v->>'id'),'[]'::JSONB)
    INTO actual_versions FROM jsonb_array_elements(doc_snapshot->'objects') AS x(v);
  SELECT COALESCE(jsonb_agg(v ORDER BY v->>'id'),'[]'::JSONB) INTO supplied_versions
    FROM jsonb_array_elements(p_payload->'captured_object_versions') AS x(v);
  IF NOT p_restore AND supplied_versions IS DISTINCT FROM actual_versions THEN RETURN FALSE; END IF;
  IF NOT p_restore THEN
    IF jsonb_typeof(p_payload->'deferred_issue_ids') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
    SELECT COALESCE(jsonb_agg(v->'id' ORDER BY v->>'id'),'[]'::JSONB) INTO actual_deferred
      FROM jsonb_array_elements(doc_snapshot->'objects') AS x(v) WHERE v->>'type'='OpenIssue' AND v->>'status'='dismissed';
    SELECT COALESCE(jsonb_agg(v ORDER BY v#>>'{}'),'[]'::JSONB) INTO supplied_deferred
      FROM jsonb_array_elements(p_payload->'deferred_issue_ids') AS x(v);
    IF supplied_deferred IS DISTINCT FROM actual_deferred THEN RETURN FALSE; END IF;
  END IF;
  -- Full source attribution is unavailable. Treat every event in this workspace
  -- as a possible dependency; never silently sample beyond the internal bound.
  SELECT count(*) INTO event_count FROM (SELECT 1 FROM public."HostEvidenceEvent"
    WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace LIMIT 257) bounded;
  IF event_count>256 THEN RETURN FALSE; END IF;
  FOR scope_event IN SELECT sequence,recorded_at,deleted_at,body IS NULL AS missing FROM public."HostEvidenceEvent"
    WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace ORDER BY sequence FOR SHARE LOOP
    IF scope_event.deleted_at IS NOT NULL OR scope_event.missing THEN RETURN FALSE; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'tasks') LOOP
    IF jsonb_typeof(item->'task') IS DISTINCT FROM 'object' OR jsonb_typeof(item->'event') IS DISTINCT FROM 'object' OR
       jsonb_typeof(item->'task'->'target_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'task'->'target_ids')<>0 OR
       jsonb_typeof(item->'errors') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'errors')<>0 OR
       item->>'processing_status' IS DISTINCT FROM 'unprocessed' OR
       (item->>'base_revision')::BIGINT IS DISTINCT FROM (p_payload->>'captured_state_revision')::BIGINT OR (item->>'result_revision')::BIGINT IS DISTINCT FROM (p_payload->>'captured_state_revision')::BIGINT THEN RETURN FALSE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."HostEvidenceTaskKey" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
      AND task_key=item->'task'->>'task_key') THEN RETURN FALSE; END IF;
    task_hash := encode(sha256(convert_to(p_capability || (item->'task')::text,'UTF8')),'hex');
    direct_ok := FALSE; question_anchored := FALSE; count_sources := 0;
    FOR src IN SELECT e.*, b.event_token FROM public."HostEvidenceTaskSource" b
      JOIN public."HostEvidenceEvent" e ON e.event_id=b.event_id
      WHERE b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace AND b.task_digest=task_hash
      ORDER BY e.event_id FOR SHARE OF e LOOP
      count_sources := count_sources+1;
      IF src.owner_id<>p_owner OR src.trip_id<>p_trip OR src.workspace_key<>p_workspace OR src.key_token<>src.event_token OR
         src.deleted_at IS NOT NULL OR src.body IS NULL THEN RETURN FALSE; END IF;
      -- Without full free-text provenance, this candidate requires the entire
      -- question to be literal in a verified, retained source in this scope.
      IF (item->'task'->>'question') IS NOT NULL AND length(item->'task'->>'question')>0 AND
         position((item->'task'->>'question') IN src.body)>0 THEN question_anchored := TRUE; END IF;
      IF src.event_id=item->'event'->>'event_id' AND src.entry=item->'event'->>'entry' AND src.body=item->'event'->>'text' AND
         item->'event'->>'reference' = 'host-interaction:'||src.event_id AND
         src.received_at=(item->'event'->>'received_at')::TIMESTAMPTZ THEN direct_ok := TRUE; END IF;
    END LOOP;
    IF count_sources=0 OR NOT direct_ok OR NOT question_anchored THEN RETURN FALSE; END IF;
  END LOOP;
  SELECT * INTO life FROM public."HostEvidenceTripLifecycle" WHERE trip_id=p_trip AND source_revision=doc_revision FOR SHARE;
  IF NOT FOUND OR public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
  checked_at := clock_timestamp();
  IF life.ended_at IS NOT NULL AND (life.ended_at>checked_at OR checked_at>=life.ended_at+interval '30 days') THEN RETURN FALSE; END IF;
  -- Recheck every potentially relevant workspace event against one fresh
  -- database clock, even when it was not declared as a Task dependency.
  IF EXISTS (SELECT 1 FROM public."HostEvidenceEvent" e WHERE e.owner_id=p_owner AND e.trip_id=p_trip AND e.workspace_key=p_workspace
    AND (e.recorded_at>checked_at OR checked_at>=e.recorded_at+interval '180 days' OR checked_at>=e.recorded_at+interval '12 months')) THEN RETURN FALSE; END IF;
  -- Also recheck each verified Task dependency.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'tasks') AS x(item)
    JOIN public."HostEvidenceTaskSource" b ON b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace
      AND b.task_digest=encode(sha256(convert_to(p_capability || (x.item->'task')::text,'UTF8')),'hex')
    JOIN public."HostEvidenceEvent" e ON e.event_id=b.event_id
    WHERE e.recorded_at>checked_at OR checked_at>=e.recorded_at+interval '180 days' OR checked_at>=e.recorded_at+interval '12 months') THEN RETURN FALSE; END IF;
  RETURN TRUE;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_sources_valid_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC;

-- R6 allows a previously saved view to remain exactly as-is even if its
-- targets later become historical. A new view must resolve against the locked
-- TS snapshot and cannot claim a future object version.
CREATE FUNCTION public.host_checkpoint_view_valid_candidate(p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_view JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_view JSONB; snap JSONB; ref JSONB; selected TEXT;
BEGIN
  SELECT e.payload->'view' INTO old_view FROM e03_checkpoint.heads h JOIN public."HostEvidenceScene" e
    ON e.owner_id=p_owner AND e.trip_id=p_trip AND e.workspace_key=p_workspace AND e.scene_ref=h.payload->>'e11_scene_ref'
    WHERE h.owner_id='user-'||p_owner AND h.trip_id=p_trip AND h.workspace=p_workspace AND NOT h.deleted;
  IF old_view IS NOT NULL AND old_view=p_view THEN RETURN TRUE; END IF;
  SELECT "snapshot" INTO snap FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF jsonb_typeof(p_view) IS DISTINCT FROM 'object' OR jsonb_typeof(p_view->'comparison_refs') IS DISTINCT FROM 'array' OR
     jsonb_typeof(snap->'objects') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(p_view->'comparison_refs') LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap->'objects') AS x(obj)
      WHERE obj->>'id'=ref->>'id' AND (ref->>'version')::BIGINT <= (obj->>'version')::BIGINT) THEN RETURN FALSE; END IF;
  END LOOP;
  selected := p_view->>'selected_id';
  IF selected IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap->'objects') AS x(obj) WHERE obj->>'id'=selected) THEN RETURN FALSE; END IF;
  RETURN TRUE;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_view_valid_candidate(TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE FUNCTION public.host_checkpoint_save_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_expected BIGINT,p_key TEXT,
  p_request_digest TEXT,p_payload JSONB,p_payload_digest TEXT,p_saved_at TEXT,p_expires_at TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE result JSONB; v_ref TEXT; before_revision BIGINT; current_scene public."HostEvidenceScene"%ROWTYPE;
BEGIN
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_payload) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF public.host_checkpoint_view_valid_candidate(p_owner,p_trip,p_workspace,p_payload->'view') IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','SCENE_REFERENCES');
  END IF;
  SELECT revision INTO before_revision FROM e03_checkpoint.heads
    WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  before_revision := COALESCE(before_revision,0);
  v_ref := encode(sha256(convert_to(p_capability || p_key || p_payload_digest,'UTF8')),'hex');
  -- The Checkpoint stores only a capability-derived reference. Original text
  -- and task payload remain inside the restricted E11-owned scene companion.
  result := e03_checkpoint.write_scene('user-'||p_owner,p_trip,p_workspace,p_expected,p_key,p_request_digest,
    jsonb_build_object('e11_scene_ref',v_ref),p_payload_digest,p_saved_at,p_expires_at,FALSE);
  IF result ? 'ack' THEN
    IF before_revision=p_expected THEN
      INSERT INTO public."HostEvidenceScene"(owner_id,trip_id,workspace_key,scene_ref,checkpoint_revision,payload_digest,payload)
        VALUES(p_owner,p_trip,p_workspace,v_ref,p_expected+1,p_payload_digest,p_payload)
        ON CONFLICT(owner_id,trip_id,workspace_key) DO UPDATE SET scene_ref=EXCLUDED.scene_ref,
          checkpoint_revision=EXCLUDED.checkpoint_revision,payload_digest=EXCLUDED.payload_digest,payload=EXCLUDED.payload;
    ELSE
      SELECT * INTO current_scene FROM public."HostEvidenceScene"
        WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace FOR SHARE;
      IF NOT FOUND OR current_scene.scene_ref IS DISTINCT FROM v_ref OR current_scene.checkpoint_revision IS DISTINCT FROM (result->'ack'->>'checkpoint_revision')::BIGINT OR
         current_scene.payload_digest IS DISTINCT FROM p_payload_digest OR current_scene.payload IS DISTINCT FROM p_payload THEN
        RAISE EXCEPTION 'checkpoint companion mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
    -- sources_valid has locked and checked each exact embedded event against
    -- the bound Session, workspace, source token, content and retention.
    -- This is only a positive witness, never a complete-input assertion.
    DELETE FROM public."HostEvidenceSceneEventWitness" WHERE scene_ref=v_ref;
    INSERT INTO public."HostEvidenceSceneEventWitness"(scene_ref,event_id)
      SELECT DISTINCT v_ref,item->'event'->>'event_id' FROM jsonb_array_elements(p_payload->'tasks') AS x(item);
  END IF;
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_payload) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'checkpoint source expired during save' USING ERRCODE='42501';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_save_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Full snapshot is an internal trusted-host read only. It is never an HTTP
-- response; callers must not publish it without the original E11 barrier.
CREATE FUNCTION public.host_checkpoint_read_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE saved JSONB; scene public."HostEvidenceScene"%ROWTYPE; sources JSONB; current_revision BIGINT; event_highwater BIGINT;
BEGIN
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF EXISTS (SELECT 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=p_owner AND trip_id=p_trip
    AND workspace_key=p_workspace AND retention_revision<>0) THEN RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  saved := e03_checkpoint.read_scene('user-'||p_owner,p_trip,p_workspace,clock_timestamp()::text);
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF saved ? 'fault' THEN RETURN saved; END IF;
  SELECT * INTO scene FROM public."HostEvidenceScene" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
    AND scene_ref=saved->'payload'->>'e11_scene_ref' FOR SHARE;
  IF NOT FOUND OR scene.checkpoint_revision IS DISTINCT FROM (saved->>'revision')::BIGINT OR scene.payload_digest IS DISTINCT FROM saved->>'payload_digest' THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  SELECT "revision" INTO current_revision FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,scene.payload,TRUE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF (scene.payload->>'captured_state_revision')::BIGINT > current_revision THEN RETURN jsonb_build_object('fault','STATE_BEHIND_CHECKPOINT'); END IF;
  IF saved->>'expires_at' IS NOT NULL AND (saved->>'expires_at')::TIMESTAMPTZ <= clock_timestamp() THEN RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED'); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('task_token',b.task_token,'event_id',b.event_id,'event_token',b.event_token) ORDER BY b.task_token,b.event_id),'[]'::JSONB)
    INTO sources FROM public."HostEvidenceTaskSource" b
    WHERE b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(scene.payload->'tasks') AS x(item)
      WHERE b.task_digest=encode(sha256(convert_to(p_capability || (x.item->'task')::text,'UTF8')),'hex'));
  -- Hold all source locks through one final database-clock/auth recheck.
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,scene.payload,TRUE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF saved->>'expires_at' IS NOT NULL AND (saved->>'expires_at')::TIMESTAMPTZ <= clock_timestamp() THEN RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED'); END IF;
  -- Record takes the same workspace row FOR UPDATE; no in-flight earlier
  -- event can commit beyond this snapshot while the shared lock is held.
  SELECT COALESCE(MAX(sequence),0) INTO event_highwater FROM public."HostEvidenceEvent" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,scene.payload,TRUE) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF saved->>'expires_at' IS NOT NULL AND (saved->>'expires_at')::TIMESTAMPTZ <= clock_timestamp() THEN RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED'); END IF;
  RETURN (saved-'payload')||jsonb_build_object('payload',scene.payload,'sources',sources,'event_highwater',event_highwater);
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_read_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION public.host_checkpoint_inspect_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE saved JSONB;
BEGIN
  saved := public.host_checkpoint_read_candidate(p_session,p_owner,p_trip,p_workspace,p_capability);
  IF saved ? 'fault' THEN RETURN saved; END IF;
  RETURN saved-'payload'-'payload_digest'-'sources'-'event_highwater';
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_inspect_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Candidate deletion serializes with checkpoint save/inspection. Because
-- Task questions may contain undisclosed sources, ANY deletion invalidates the
-- workspace scene and previous Task source bindings. This is an intentionally
-- conservative internal gate, not the final unrelated-task product behavior.
CREATE FUNCTION public.host_checkpoint_delete_event_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_event TEXT
) RETURNS TABLE(disposition TEXT,deletion_revision BIGINT,accepted_at TIMESTAMPTZ,cleanup_pending BOOLEAN,event_highwater BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result RECORD; v_highwater BIGINT;
BEGIN
  PERFORM 1 FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF NOT FOUND OR public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN,NULL::BIGINT; RETURN;
  END IF;
  PERFORM 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
    AND session_ref=p_session AND capability_token=p_capability FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN,NULL::BIGINT; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  PERFORM 1 FROM e03_checkpoint.heads WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  IF public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN,NULL::BIGINT; RETURN;
  END IF;
  SELECT * INTO result FROM public.host_evidence_delete_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_event);
  IF result.disposition='deleted' THEN
    -- Persist the *first* deletion cutoff, so retries do not erase newer work.
    SELECT cutoff_sequence INTO v_highwater FROM public."HostEvidenceCleanup" WHERE event_id=p_event FOR UPDATE;
    IF v_highwater IS NULL THEN
      DELETE FROM public."HostEvidenceScene" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
      DELETE FROM e03_checkpoint.receipts WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace;
      UPDATE e03_checkpoint.heads SET payload=NULL,payload_digest=NULL,deleted=TRUE
        WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace;
      DELETE FROM public."HostEvidenceTaskSource" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
      DELETE FROM public."HostEvidenceTaskKey" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
      SELECT COALESCE(MAX(sequence),0) INTO v_highwater FROM public."HostEvidenceEvent"
        WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
      UPDATE public."HostEvidenceWorkspace" SET invalid_before_sequence=GREATEST(invalid_before_sequence,v_highwater)
        WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
      UPDATE public."HostEvidenceCleanup" SET cutoff_sequence=v_highwater WHERE event_id=p_event;
    END IF;
  END IF;
  IF public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'checkpoint deletion authorization expired' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT result.disposition,result.deletion_revision,result.accepted_at,result.cleanup_pending,v_highwater;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_delete_event_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Maintenance-only natural expiry. It uses the same workspace/Checkpoint lock
-- order as an active deletion, and persists a tombstone before a separate
-- physical cleanup transaction. No Session is needed for a retention job.
-- This candidate must be called by a privileged maintenance worker only.
CREATE FUNCTION public.host_checkpoint_expire_event_candidate(p_event TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE hint public."HostEvidenceEvent"%ROWTYPE; e public."HostEvidenceEvent"%ROWTYPE;
  l public."HostEvidenceTripLifecycle"%ROWTYPE; v_revision BIGINT; v_highwater BIGINT;
  related_at TIMESTAMPTZ; deadline TIMESTAMPTZ; checked_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO hint FROM public."HostEvidenceEvent" WHERE event_id=p_event;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  SELECT "revision" INTO v_revision FROM public."TripStateDocument" WHERE "tripId"=hint.trip_id FOR SHARE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  PERFORM 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=hint.owner_id AND trip_id=hint.trip_id
    AND workspace_key=hint.workspace_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||hint.owner_id,hint.trip_id,hint.workspace_key)::text,0));
  PERFORM 1 FROM e03_checkpoint.heads WHERE owner_id='user-'||hint.owner_id AND trip_id=hint.trip_id
    AND workspace=hint.workspace_key FOR UPDATE;
  SELECT * INTO e FROM public."HostEvidenceEvent" WHERE event_id=p_event AND owner_id=hint.owner_id
    AND trip_id=hint.trip_id AND workspace_key=hint.workspace_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  IF e.deleted_at IS NOT NULL THEN RETURN 'already_deleted'; END IF;
  SELECT * INTO l FROM public."HostEvidenceTripLifecycle" WHERE trip_id=e.trip_id AND source_revision=v_revision FOR SHARE;
  SELECT MAX(peer_event.recorded_at) INTO related_at
    FROM public."HostEvidenceTaskSource" anchor
    JOIN public."HostEvidenceTaskSource" peer ON peer.owner_id=anchor.owner_id AND peer.trip_id=anchor.trip_id
      AND peer.workspace_key=anchor.workspace_key AND peer.task_token=anchor.task_token
    JOIN public."HostEvidenceEvent" peer_event ON peer_event.event_id=peer.event_id
      AND peer_event.owner_id=peer.owner_id AND peer_event.trip_id=peer.trip_id AND peer_event.workspace_key=peer.workspace_key
    WHERE anchor.owner_id=e.owner_id AND anchor.trip_id=e.trip_id AND anchor.workspace_key=e.workspace_key
      AND anchor.event_id=e.event_id AND peer_event.deleted_at IS NULL AND peer_event.recorded_at<=clock_timestamp();
  related_at:=GREATEST(e.recorded_at,COALESCE(related_at,e.recorded_at));
  deadline:=LEAST(related_at+interval '180 days',e.recorded_at+interval '12 months',
    CASE WHEN l.trip_id IS NOT NULL AND l.ended_at IS NOT NULL AND l.ended_at<=clock_timestamp()
      THEN l.ended_at+interval '30 days' ELSE 'infinity'::timestamptz END);
  checked_at:=clock_timestamp();
  IF e.recorded_at>checked_at OR checked_at<deadline THEN RETURN 'retained'; END IF;
  UPDATE public."HostEvidenceWorkspace" SET retention_revision=retention_revision+1
    WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  UPDATE public."HostEvidenceEvent" SET deleted_at=checked_at WHERE event_id=e.event_id;
  INSERT INTO public."HostEvidenceCleanup"(event_id,deletion_revision,requested_at)
    SELECT e.event_id,retention_revision,checked_at FROM public."HostEvidenceWorkspace"
    WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  -- Unknown free-text provenance makes the workspace scene and prior Task
  -- associations unsafe after one source expires. Later independent events
  -- remain in the store, but earlier candidate context is invalidated.
  DELETE FROM public."HostEvidenceScene" WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  DELETE FROM e03_checkpoint.receipts WHERE owner_id='user-'||e.owner_id AND trip_id=e.trip_id AND workspace=e.workspace_key;
  UPDATE e03_checkpoint.heads SET payload=NULL,payload_digest=NULL,deleted=TRUE
    WHERE owner_id='user-'||e.owner_id AND trip_id=e.trip_id AND workspace=e.workspace_key;
  DELETE FROM public."HostEvidenceTaskSource" WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  DELETE FROM public."HostEvidenceTaskKey" WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  SELECT COALESCE(MAX(sequence),0) INTO v_highwater FROM public."HostEvidenceEvent"
    WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  UPDATE public."HostEvidenceWorkspace" SET invalid_before_sequence=GREATEST(invalid_before_sequence,v_highwater)
    WHERE owner_id=e.owner_id AND trip_id=e.trip_id AND workspace_key=e.workspace_key;
  UPDATE public."HostEvidenceCleanup" SET cutoff_sequence=v_highwater WHERE event_id=e.event_id;
  RETURN 'expired';
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_expire_event_candidate(TEXT) FROM PUBLIC;

-- Bounded cursor for one external maintenance sweep. Each later sweep must
-- restart at zero so previously retained events are reconsidered at expiry;
-- HostEvidenceCleanup jobs are retried in separate transactions. No timer or
-- production maintenance credential is installed by this candidate.
CREATE FUNCTION public.host_checkpoint_expire_batch_candidate(p_after BIGINT,p_limit INTEGER)
RETURNS TABLE(out_sequence BIGINT,out_event_id TEXT,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item RECORD;
BEGIN
  IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit<1 OR p_limit>256 THEN
    RAISE EXCEPTION 'invalid maintenance batch' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT sequence,event_id FROM public."HostEvidenceEvent"
    WHERE sequence>p_after AND deleted_at IS NULL ORDER BY sequence LIMIT p_limit LOOP
    out_sequence:=item.sequence;
    out_event_id:=item.event_id;
    disposition:=public.host_checkpoint_expire_event_candidate(item.event_id);
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_expire_batch_candidate(BIGINT,INTEGER) FROM PUBLIC;
