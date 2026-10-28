-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "TripStateDocument" (
    "tripId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "TripStateDocument_pkey" PRIMARY KEY ("tripId")
);

-- CreateTable
CREATE TABLE "TripStateHistory" (
    "tripId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "intentId" TEXT NOT NULL,
    "changeRecordId" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "change" JSONB NOT NULL,

    CONSTRAINT "TripStateHistory_pkey" PRIMARY KEY ("tripId","sequence")
);

-- CreateTable
CREATE TABLE "TripStateProposal" (
    "tripId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "basisRevision" BIGINT NOT NULL,
    "digest" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TripStateProposal_pkey" PRIMARY KEY ("tripId","proposalId")
);

-- CreateTable
CREATE TABLE "TripStateIdempotency" (
    "tripId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operationDomain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB NOT NULL,

    CONSTRAINT "TripStateIdempotency_pkey" PRIMARY KEY ("tripId","actorId","operationDomain","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "TripStateHistory_tripId_intentId_key" ON "TripStateHistory"("tripId", "intentId");

-- CreateIndex
CREATE UNIQUE INDEX "TripStateHistory_tripId_changeRecordId_key" ON "TripStateHistory"("tripId", "changeRecordId");

-- AddForeignKey
ALTER TABLE "TripStateHistory" ADD CONSTRAINT "TripStateHistory_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TripStateDocument"("tripId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStateProposal" ADD CONSTRAINT "TripStateProposal_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TripStateDocument"("tripId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStateIdempotency" ADD CONSTRAINT "TripStateIdempotency_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TripStateDocument"("tripId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- JSONB is the authoritative business document. Columns are matching storage indexes only.
ALTER TABLE "TripStateDocument" ADD CONSTRAINT "snapshot_identity_revision" CHECK ((
  "revision" >= 0 AND jsonb_typeof("snapshot") = 'object'
  AND "snapshot" ?& ARRAY['trip_id','revision','schema_version','objects','effective_skeleton_id']
  AND jsonb_typeof("snapshot"->'revision') = 'number'
  AND "snapshot"->>'trip_id' = "tripId"
  AND "snapshot"->>'schema_version' = '0.1.0'
  AND ("snapshot"->>'revision')::numeric = "revision"::numeric
) IS TRUE);
ALTER TABLE "TripStateHistory" ADD CONSTRAINT "history_metadata_matches" CHECK ((
  "sequence" > 0
  AND "intent" ?& ARRAY['id','type','trip_id','base_revision']
  AND "change" ?& ARRAY['id','type','trip_id','intent_id','base_revision','result_revision']
  AND "intent"->>'id' = "intentId" AND "intent"->>'type' = 'OperationIntent'
  AND "change"->>'id' = "changeRecordId" AND "change"->>'type' = 'ChangeRecord'
  AND "intent"->>'trip_id' = "tripId" AND "change"->>'trip_id' = "tripId"
  AND "change"->>'intent_id' = "intentId"
  AND ("intent"->>'base_revision')::numeric = ("change"->>'base_revision')::numeric
  AND ("change"->>'result_revision')::numeric BETWEEN
      ("change"->>'base_revision')::numeric AND ("change"->>'base_revision')::numeric + 1
) IS TRUE);
ALTER TABLE "TripStateProposal" ADD CONSTRAINT "proposal_storage_bounds" CHECK ((
  "basisRevision" >= 0 AND length("proposalId") > 0 AND length("digest") > 0
  AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes'
  AND "payload" ?& ARRAY['request','actor','digest','expires','cache_key']
  AND "payload"->>'digest' = "digest"
  AND ("payload"->'request'->>'expected_revision')::numeric = "basisRevision"::numeric
  AND ("payload"->>'expires')::timestamptz = "expiresAt"
) IS TRUE);
ALTER TABLE "TripStateIdempotency" ADD CONSTRAINT "idempotency_storage_bounds" CHECK ((
  length("actorId") > 0 AND length("key") > 0 AND length("requestDigest") > 0
  AND "operationDomain" IN ('user','model','tool','system','confirmation')
  AND jsonb_typeof("request") = 'object' AND jsonb_typeof("response") = 'object'
  AND "request" ? 'idempotency_key' AND "request"->>'idempotency_key' = "key"
) IS TRUE);

CREATE FUNCTION "deny_trip_history_rewrite"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Trip State history is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER "trip_history_no_update_delete"
  BEFORE UPDATE OR DELETE ON "TripStateHistory"
  FOR EACH ROW EXECUTE FUNCTION "deny_trip_history_rewrite"();
CREATE TRIGGER "trip_history_no_truncate"
  BEFORE TRUNCATE ON "TripStateHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION "deny_trip_history_rewrite"();

-- Runtime grants are provisioned separately; the runtime must never own these objects.
REVOKE ALL ON "TripStateDocument", "TripStateHistory", "TripStateProposal", "TripStateIdempotency" FROM PUBLIC;
REVOKE ALL ON FUNCTION "deny_trip_history_rewrite"() FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
