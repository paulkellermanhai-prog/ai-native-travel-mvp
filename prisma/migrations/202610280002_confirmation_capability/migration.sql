-- Only this bounded capability can consume one proposal and finalize its original cached response.
-- Runtime retains NO direct UPDATE/DELETE on proposals or idempotency, and NO DDL/history rewrite.
CREATE FUNCTION public.finalize_trip_confirmation(p_trip TEXT, p_proposal TEXT, p_response JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  proposal public."TripStateProposal"%ROWTYPE;
  document public."TripStateDocument"%ROWTYPE;
  journal public."TripStateHistory"%ROWTYPE;
  original public."TripStateIdempotency"%ROWTYPE;
  confirmation public."TripStateIdempotency"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT document FROM public."TripStateDocument" WHERE "tripId"=p_trip FOR UPDATE;
  SELECT * INTO STRICT proposal FROM public."TripStateProposal" WHERE "tripId"=p_trip AND "proposalId"=p_proposal FOR UPDATE;
  SELECT * INTO STRICT journal FROM public."TripStateHistory" WHERE "tripId"=p_trip ORDER BY "sequence" DESC LIMIT 1;
  SELECT * INTO STRICT original FROM public."TripStateIdempotency"
    WHERE "tripId"=p_trip AND "actorId"=proposal."payload"->'cache_key'->>0
      AND "operationDomain"=proposal."payload"->'cache_key'->>1 AND "key"=proposal."payload"->'cache_key'->>2 FOR UPDATE;
  SELECT * INTO STRICT confirmation FROM public."TripStateIdempotency"
    WHERE "tripId"=p_trip AND "actorId"=journal."change"->>'confirmation_actor'
      AND "operationDomain"='confirmation' AND "response"=p_response;
  IF NOT ((
    proposal."expiresAt" > (journal."change"->>'created_at')::timestamptz
    AND journal."intent"->>'created_at' = journal."change"->>'created_at'
    AND original."request" = proposal."payload"->'request'
    AND original."actorId" = proposal."payload"->'actor'->>'id'
    AND original."operationDomain" = proposal."payload"->'actor'->>'role'
    AND original."response"->>'outcome' = 'pending_confirmation'
    AND original."response"->>'proposal_id' = p_proposal
    AND original."response"->>'proposal_digest' = proposal."digest"
    AND p_response->>'outcome' IN ('applied','rejected')
    AND p_response->>'proposal_id' = p_proposal AND p_response->>'proposal_digest' = proposal."digest"
    AND p_response->'confirmation_required' = 'false'::jsonb
    AND (p_response->>'revision')::numeric = document."revision"::numeric
    AND journal."intent"->>'actor_id' = original."actorId"
    AND journal."intent"->>'actor_role' = original."operationDomain"
    AND journal."change"->>'proposal_id' = p_proposal
    AND journal."change"->>'request_digest' = proposal."digest"
    AND journal."change"->>'outcome' = p_response->>'outcome'
    AND journal."change"->'diff' = p_response->'diff'
    AND journal."change"->'affected_ids' = p_response->'affected_ids'
    AND (journal."change"->>'base_revision')::numeric = proposal."basisRevision"::numeric
    AND (journal."change"->>'result_revision')::numeric = document."revision"::numeric
    AND (confirmation."request"->>'expected_revision')::numeric = proposal."basisRevision"::numeric
    AND confirmation."request"->>'proposal_digest' = proposal."digest"
    AND confirmation."request"->'accept' = to_jsonb(p_response->>'outcome' = 'applied')
  ) IS TRUE) THEN
    RAISE EXCEPTION 'Invalid Trip State confirmation finalization' USING ERRCODE='42501';
  END IF;
  UPDATE public."TripStateIdempotency" SET "response"=p_response
    WHERE "tripId"=p_trip AND "actorId"=original."actorId" AND "operationDomain"=original."operationDomain" AND "key"=original."key";
  DELETE FROM public."TripStateProposal" WHERE "tripId"=p_trip AND "proposalId"=p_proposal;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_trip_confirmation(TEXT, TEXT, JSONB) FROM PUBLIC;
-- Provisioning grants EXECUTE on this exact signature to the deployment's known runtime identity.
-- No table UPDATE/DELETE grants or role/security-policy changes are introduced.
