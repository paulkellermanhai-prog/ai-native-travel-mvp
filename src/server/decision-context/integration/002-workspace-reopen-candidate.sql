-- E03-06 internal candidate only. A current authenticated owner may use a
-- workspace key as a locator, never as proof, to rotate the persisted Session
-- binding and server capability before restoring a verified Checkpoint.
CREATE FUNCTION public.host_checkpoint_reopen_workspace_candidate(
  p_session TEXT,p_owner TEXT,p_trip TEXT,p_workspace TEXT,p_capability TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE
  old_capability TEXT; retention BIGINT; scene public."HostEvidenceScene"%ROWTYPE;
  saved JSONB; item JSONB; task_key TEXT; changed BIGINT;
BEGIN
  IF p_workspace !~ '^[A-Za-z][A-Za-z0-9_-]{0,95}$' OR p_capability !~ '^[0-9a-f]{64}$' OR
     public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
  SELECT capability_token,retention_revision INTO old_capability,retention
    FROM public."HostEvidenceWorkspace" WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace FOR UPDATE;
  IF NOT FOUND OR retention<>0 OR old_capability=p_capability THEN RETURN FALSE; END IF;
  SELECT * INTO scene FROM public."HostEvidenceScene"
    WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  saved:=e03_checkpoint.read_scene('user-'||p_owner,p_trip,p_workspace,clock_timestamp()::text);
  IF saved ? 'fault' OR scene.checkpoint_revision IS DISTINCT FROM (saved->>'revision')::BIGINT OR
     scene.scene_ref IS DISTINCT FROM saved->'payload'->>'e11_scene_ref' OR
     scene.payload_digest IS DISTINCT FROM saved->>'payload_digest' THEN RETURN FALSE; END IF;

  -- Rotate only the capability-derived indexes required by the saved scene.
  -- Historical association rows remain immutable and old operation tokens do
  -- not become current authorization.
  UPDATE public."HostEvidenceWorkspace" SET session_ref=p_session,capability_token=p_capability
    WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace;
  FOR item IN SELECT value FROM jsonb_array_elements(scene.payload->'tasks') LOOP
    task_key:=item->'task'->>'task_key';
    UPDATE public."HostEvidenceTaskSource" SET task_digest=encode(sha256(convert_to(p_capability||(item->'task')::text,'UTF8')),'hex')
      WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
        AND task_digest=encode(sha256(convert_to(old_capability||(item->'task')::text,'UTF8')),'hex');
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<1 THEN RAISE EXCEPTION 'saved task source is unavailable' USING ERRCODE='42501'; END IF;
    UPDATE public."HostEvidenceAssociationHead" SET task_key_digest=encode(sha256(convert_to(p_capability||task_key,'UTF8')),'hex')
      WHERE owner_id=p_owner AND trip_id=p_trip AND workspace_key=p_workspace
        AND task_key_digest=encode(sha256(convert_to(old_capability||task_key,'UTF8')),'hex');
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'saved task identity is unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  saved:=public.host_checkpoint_read_candidate(p_session,p_owner,p_trip,p_workspace,p_capability);
  IF saved ? 'fault' OR public.authorize_trip_session(p_session,p_owner,p_trip) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'workspace recovery is unavailable' USING ERRCODE='42501';
  END IF;
  RETURN TRUE;
EXCEPTION WHEN SQLSTATE '42501' OR data_exception OR integrity_constraint_violation THEN
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.host_checkpoint_reopen_workspace_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
