-- Internal integration candidate only. Install after the E11 and checkpoint
-- candidates, in an isolated test DB. No production migration or grants.
-- This is deliberately restricted to unprocessed, source-bound tasks; it is
-- not a scene-restored implementation and never proves backup cleanup.
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
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_payload JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE item JSONB; src RECORD; task_hash TEXT; direct_ok BOOLEAN; count_sources INT;
  doc_revision BIGINT; doc_snapshot JSONB; actual_versions JSONB; supplied_versions JSONB; life public."HostEvidenceTripLifecycle"%ROWTYPE; checked_at TIMESTAMPTZ;
BEGIN
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
  -- Locks follow TS -> auth -> workspace -> lifecycle -> checkpoint -> source.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  PERFORM 1 FROM e03_checkpoint.heads WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  SELECT "revision", "snapshot" INTO doc_revision,doc_snapshot FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_payload->>'trip_id' IS DISTINCT FROM p_trip OR
     (p_payload->>'captured_state_revision')::BIGINT IS DISTINCT FROM doc_revision OR
     jsonb_typeof(p_payload->'tasks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'tasks')=0 OR
     jsonb_typeof(p_payload->'drafts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'drafts')<>0 OR
     jsonb_typeof(p_payload->'captured_object_versions') IS DISTINCT FROM 'array' OR
     jsonb_typeof(doc_snapshot->'objects') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v->'id','version',v->'version') ORDER BY v->>'id'),'[]'::JSONB)
    INTO actual_versions FROM jsonb_array_elements(doc_snapshot->'objects') AS x(v);
  SELECT COALESCE(jsonb_agg(v ORDER BY v->>'id'),'[]'::JSONB) INTO supplied_versions
    FROM jsonb_array_elements(p_payload->'captured_object_versions') AS x(v);
  IF supplied_versions IS DISTINCT FROM actual_versions THEN RETURN FALSE; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'tasks') LOOP
    IF jsonb_typeof(item->'task') IS DISTINCT FROM 'object' OR jsonb_typeof(item->'event') IS DISTINCT FROM 'object' OR
       jsonb_typeof(item->'errors') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'errors')<>0 OR
       item->>'processing_status' IS DISTINCT FROM 'unprocessed' OR
       (item->>'base_revision')::BIGINT IS DISTINCT FROM doc_revision OR (item->>'result_revision')::BIGINT IS DISTINCT FROM doc_revision THEN RETURN FALSE; END IF;
    task_hash := encode(sha256(convert_to(p_capability || (item->'task')::text,'UTF8')),'hex');
    direct_ok := FALSE; count_sources := 0;
    FOR src IN SELECT e.*, b.event_token FROM public."HostEvidenceTaskSource" b
      JOIN public."HostEvidenceEvent" e ON e.event_id=b.event_id
      WHERE b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace AND b.task_digest=task_hash
      ORDER BY e.event_id FOR SHARE OF e LOOP
      count_sources := count_sources+1;
      IF src.owner_id<>p_owner OR src.trip_id<>p_trip OR src.workspace_key<>p_workspace OR src.key_token<>src.event_token OR
         src.deleted_at IS NOT NULL OR src.body IS NULL THEN RETURN FALSE; END IF;
      IF src.event_id=item->'event'->>'event_id' AND src.entry=item->'event'->>'entry' AND src.body=item->'event'->>'text' AND
         item->'event'->>'reference' = 'host-interaction:'||src.event_id AND
         src.received_at=(item->'event'->>'received_at')::TIMESTAMPTZ THEN direct_ok := TRUE; END IF;
    END LOOP;
    IF count_sources=0 OR NOT direct_ok THEN RETURN FALSE; END IF;
  END LOOP;
  SELECT * INTO life FROM public."HostEvidenceTripLifecycle" WHERE trip_id=p_trip AND source_revision=doc_revision FOR SHARE;
  IF NOT FOUND OR public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
  checked_at := clock_timestamp();
  IF life.ended_at IS NOT NULL AND (life.ended_at>checked_at OR checked_at>=life.ended_at+interval '30 days') THEN RETURN FALSE; END IF;
  -- Recheck every dependency against one fresh DB clock after all waits.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'tasks') AS x(item)
    JOIN public."HostEvidenceTaskSource" b ON b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace
      AND b.task_digest=encode(sha256(convert_to(p_capability || (x.item->'task')::text,'UTF8')),'hex')
    JOIN public."HostEvidenceEvent" e ON e.event_id=b.event_id
    WHERE e.recorded_at>checked_at OR checked_at>=e.recorded_at+interval '180 days' OR checked_at>=e.recorded_at+interval '12 months') THEN RETURN FALSE; END IF;
  RETURN TRUE;
EXCEPTION WHEN data_exception THEN RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_sources_valid_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE FUNCTION public.host_checkpoint_save_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_expected BIGINT,p_key TEXT,
  p_request_digest TEXT,p_payload JSONB,p_payload_digest TEXT,p_saved_at TEXT,p_expires_at TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE result JSONB;
BEGIN
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_payload) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  result := e03_checkpoint.write_scene('user-'||p_owner,p_trip,p_workspace,p_expected,p_key,p_request_digest,p_payload,p_payload_digest,p_saved_at,p_expires_at,FALSE);
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_payload) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'checkpoint source expired during save' USING ERRCODE='42501';
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_save_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,JSONB,TEXT,TEXT,TEXT) FROM PUBLIC;

-- This bounded inspection returns metadata only. It intentionally does not
-- return payload or constitute a scene restoration / response delivery.
CREATE FUNCTION public.host_checkpoint_inspect_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE saved JSONB;
BEGIN
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  saved := e03_checkpoint.read_scene('user-'||p_owner,p_trip,p_workspace,clock_timestamp()::text);
  -- A natural expiry or revocation while waiting may not expose even a fault.
  IF public.host_checkpoint_scope_candidate(p_session,p_owner,p_trip,p_workspace,p_capability) IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF saved ? 'fault' THEN RETURN saved; END IF;
  IF public.host_checkpoint_sources_valid_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,saved->'payload') IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('fault','RECOVERY_UNAVAILABLE');
  END IF;
  IF saved->>'expires_at' IS NOT NULL AND (saved->>'expires_at')::TIMESTAMPTZ <= clock_timestamp() THEN RETURN jsonb_build_object('fault','CHECKPOINT_EXPIRED'); END IF;
  RETURN jsonb_build_object('revision',saved->'revision','saved_at',saved->'saved_at','expires_at',saved->'expires_at');
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_inspect_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

-- Candidate deletion serializes with checkpoint save/inspection. If the stored
-- snapshot depends on this event, scrub that snapshot and its idempotency
-- receipts in the same transaction; unrelated checkpoints remain available.
CREATE FUNCTION public.host_checkpoint_delete_event_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT,p_event TEXT
) RETURNS TABLE(disposition TEXT,deletion_revision BIGINT,accepted_at TIMESTAMPTZ,cleanup_pending BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result RECORD; affected BOOLEAN;
BEGIN
  PERFORM 1 FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR SHARE;
  IF NOT FOUND OR public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN; RETURN;
  END IF;
  PERFORM 1 FROM public."HostEvidenceWorkspace" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
    AND session_ref=p_session AND capability_token=p_capability FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('user-'||p_owner,p_trip,p_workspace)::text,0));
  PERFORM 1 FROM e03_checkpoint.heads WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace FOR UPDATE;
  IF public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'denied'::TEXT,NULL::BIGINT,NULL::TIMESTAMPTZ,NULL::BOOLEAN; RETURN;
  END IF;
  SELECT EXISTS (SELECT 1 FROM e03_checkpoint.heads h
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.payload->'tasks')='array' THEN h.payload->'tasks' ELSE '[]'::JSONB END) x(item)
    JOIN public."HostEvidenceTaskSource" b ON b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace
      AND b.task_digest=encode(sha256(convert_to(p_capability || (x.item->'task')::text,'UTF8')),'hex') AND b.event_id=p_event
    WHERE h.owner_id='user-'||p_owner AND h.trip_id=p_trip AND h.workspace=p_workspace AND NOT h.deleted) INTO affected;
  SELECT * INTO result FROM public.host_evidence_delete_candidate(p_session,p_owner,p_trip,p_workspace,p_capability,p_event);
  IF result.disposition='deleted' THEN
    IF affected THEN
      DELETE FROM e03_checkpoint.receipts WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace;
      UPDATE e03_checkpoint.heads SET payload=NULL,payload_digest=NULL,deleted=TRUE
        WHERE owner_id='user-'||p_owner AND trip_id=p_trip AND workspace=p_workspace;
    END IF;
    DELETE FROM public."HostEvidenceTaskSource" b WHERE b.owner_id=p_owner AND b.trip_id=p_trip AND b.workspace_key=p_workspace
      AND b.task_digest IN (SELECT task_digest FROM public."HostEvidenceTaskSource" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace AND event_id=p_event);
  END IF;
  IF public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'checkpoint deletion authorization expired' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT result.disposition,result.deletion_revision,result.accepted_at,result.cleanup_pending;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_delete_event_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
