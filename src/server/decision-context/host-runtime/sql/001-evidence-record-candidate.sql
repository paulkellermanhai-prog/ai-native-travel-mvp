-- Isolated candidate only: do not add to the shared migration chain or grant
-- EXECUTE until this slice has real PostgreSQL and least-privilege review.
-- It has no reader, association, deletion or cleanup capability.
CREATE TABLE public."HostEvidenceEvent" (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (sequence <= 9007199254740991),
  owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
  trip_id TEXT NOT NULL CHECK (trip_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,95}$'),
  workspace_key TEXT NOT NULL CHECK (workspace_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,95}$'),
  event_id TEXT NOT NULL UNIQUE CHECK (event_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,95}$'),
  session_ref TEXT NOT NULL CHECK (char_length(session_ref) BETWEEN 1 AND 256),
  entry TEXT NOT NULL CHECK (entry IN ('dialogue','map','timeline','comparison')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 16000),
  received_at TIMESTAMPTZ(6) NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  policy TEXT NOT NULL CHECK (policy = 'DC-AC8-PRIVACY-01'),
  deleted_at TIMESTAMPTZ(6),
  UNIQUE (owner_id, trip_id, workspace_key, idempotency_key)
);
REVOKE ALL ON public."HostEvidenceEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE public."HostEvidenceEvent_sequence_seq" FROM PUBLIC;

-- Authenticated host supplies the session and server-bound workspace; an input
-- string alone never proves workspace ownership. Denied paths return no row data.
CREATE FUNCTION public.host_evidence_record_candidate(
  p_session TEXT, p_owner TEXT, p_trip TEXT, p_workspace TEXT, p_event TEXT,
  p_entry TEXT, p_body TEXT, p_received TIMESTAMPTZ, p_key TEXT, p_digest TEXT
) RETURNS TABLE(disposition TEXT, out_event_id TEXT, out_sequence BIGINT, out_recorded_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE e public."HostEvidenceEvent"%ROWTYPE;
BEGIN
  IF public.authorize_trip_session(p_session, p_owner, p_trip) IS DISTINCT FROM TRUE THEN
    RETURN QUERY SELECT 'denied'::TEXT, NULL::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  INSERT INTO public."HostEvidenceEvent" (owner_id,trip_id,workspace_key,event_id,session_ref,entry,body,received_at,idempotency_key,input_digest,policy)
    VALUES (p_owner,p_trip,p_workspace,p_event,p_session,p_entry,p_body,p_received,p_key,p_digest,'DC-AC8-PRIVACY-01')
    ON CONFLICT (owner_id,trip_id,workspace_key,idempotency_key) DO NOTHING
    RETURNING * INTO e;
  IF FOUND THEN
    RETURN QUERY SELECT 'inserted'::TEXT, e.event_id, e.sequence, e.recorded_at;
    RETURN;
  END IF;
  SELECT * INTO e FROM public."HostEvidenceEvent" WHERE owner_id=p_owner AND trip_id=p_trip
    AND workspace_key=p_workspace AND idempotency_key=p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'event receipt unavailable'; END IF;
  IF e.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT 'deleted'::TEXT, NULL::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
  ELSIF e.input_digest <> p_digest OR e.entry <> p_entry OR e.body <> p_body THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::TEXT, NULL::BIGINT, NULL::TIMESTAMPTZ;
  ELSE
    RETURN QUERY SELECT 'replayed'::TEXT, e.event_id, e.sequence, e.recorded_at;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.host_evidence_record_candidate(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT) FROM PUBLIC;
