-- 697 — TRIALCLAIM.1 (C113): one live trial claim per (studio, Glofox member).
-- A new table, public.glofox_trial_claims, with a partial unique index, seeded
-- from the trials already bought. Nothing existing is changed or deleted.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026; counts only).
-- Behaviour is proven ahead of apply by tests/migration-697-glofox-trial-claims.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C113, found building TRIAL-1 / C85 d)
-- ===========================================================================
-- Approving a needs_credit_grant card buys a Glofox trial membership before
-- booking (src/lib/agent/trial-grant.js). "One trial per member" is a READ of
-- the other cards (details.trial_grant.glofox_member_id) and of the /start
-- mint's glofox_push_events, then a write-ahead marker on the card's OWN row,
-- then the purchase. Two cards for one member approved at the same instant
-- both read nothing and both buy. Grants made before member ids were
-- recorded (the fire-and-forget era before TRIALGRANT.1) are invisible to
-- that read altogether.
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration):
--   * glofox_trial_claims does not exist.
--   * class_booking cards with reason needs_credit_grant: 16 (actioned 11,
--     failed 4 with YOU_HAVE_NO_CREDITS_LEFT, expired 1). Cards carrying a
--     details.trial_grant: 0.
--   * The 11 actioned cards all resolve a Glofox member id (the elected id,
--     else the executing contact's link): 10 distinct (studio, member) pairs.
--   * glofox_push_events status 'created' with a member id: 27, 0 repeated
--     (studio, member) pairs, no overlap with the cards: 37 seeded claims.
--   * Column types: locations.id, agent_membership_requests.id/location_id,
--     glofox_push_events.id/location_id uuid; glofox_member_id text.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   glofox_trial_claims: one row per claim. glofox_trial_claims_one_live is
--   UNIQUE (location_id, glofox_member_id) WHERE released_at IS NULL, so a
--   second approval's INSERT fails 23505 and trial-grant.js stops it with
--   TRIAL_ALREADY_GRANTED instead of buying. The claim is taken after the
--   product is known and before the write-ahead marker; it is released (a
--   row kept, released_at set) only when nothing can have been bought.
--   Service role only: RLS on, no policy, nothing for anon/authenticated.
--
-- THE SEED (earliest first; ON CONFLICT DO NOTHING, so a rerun adds nothing):
--   * 'approval_backfill': actioned needs_credit_grant cards with no recorded
--     trial_grant (bought fire-and-forget, may have gone through), and any
--     card whose recorded grant may have bought (a 'purchasing' marker,
--     outcome_unknown, or ok and not a skip). Member: the grant's own id,
--     else the elected id, else the executing contact's current link.
--   * 'mint_backfill': glofox_push_events 'created' rows (the mint attached
--     a trial when it made the account).
--   NOT seeded: the 4 failed cards. TRIALGRANT.1's audit found no €0 trial
--   invoice on any of them (the purchase did not go through).
--
-- APPLY: after the PR merges, apply 696 then 697. Until 697 is applied the
-- code cannot write a claim and stops every trial approval with
-- TRIAL_GRANT_UNRECORDED (closed: nothing bought). Pre/post probes and the
-- rollback (DROP TABLE) are in the PR body.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-check: the tables this one refers to exist.
DO $$
BEGIN
  IF to_regclass('public.locations') IS NULL
     OR to_regclass('public.agent_membership_requests') IS NULL
     OR to_regclass('public.glofox_push_events') IS NULL
     OR to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION 'mig 697: locations, agent_membership_requests, glofox_push_events and contacts must exist';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.glofox_trial_claims (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  glofox_member_id text        NOT NULL CHECK (btrim(glofox_member_id) <> ''),
  -- The card that claimed (kept as provenance if the card is deleted).
  request_id       uuid        REFERENCES public.agent_membership_requests(id) ON DELETE SET NULL,
  -- The /start mint's push event a seeded claim came from (provenance only).
  push_event_id    uuid,
  source           text        NOT NULL CHECK (source IN ('approval', 'approval_backfill', 'mint_backfill')),
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  release_reason   text,
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

COMMENT ON TABLE public.glofox_trial_claims IS
  'TRIALCLAIM.1 (mig 697): one live row per (location, Glofox member) whose trial was bought or may have been. trial-grant.js claims before buying; released_at set only when nothing was bought.';

CREATE UNIQUE INDEX IF NOT EXISTS glofox_trial_claims_one_live
  ON public.glofox_trial_claims (location_id, glofox_member_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS glofox_trial_claims_request
  ON public.glofox_trial_claims (request_id)
  WHERE request_id IS NOT NULL;

ALTER TABLE public.glofox_trial_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.glofox_trial_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.glofox_trial_claims TO service_role;

-- The seed.
WITH card_rows AS (
  SELECT r.location_id,
         nullif(btrim(coalesce(
           r.details->'trial_grant'->>'glofox_member_id',
           r.details->>'elected_glofox_member_id',
           ct.glofox_member_id)), '') AS member_id,
         r.id AS request_id,
         NULL::uuid AS push_event_id,
         'approval_backfill'::text AS source,
         r.created_at AS claimed_at
    FROM public.agent_membership_requests r
    LEFT JOIN public.contacts ct
      ON ct.id = coalesce(
           CASE WHEN r.details->>'executing_contact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (r.details->>'executing_contact_id')::uuid END,
           r.contact_id)
   WHERE r.kind = 'class_booking'
     AND (
       (r.details->>'reason' = 'needs_credit_grant' AND r.status = 'actioned' AND NOT (r.details ? 'trial_grant'))
       OR r.details->'trial_grant'->>'stage' = 'purchasing'
       OR r.details->'trial_grant'->>'outcome_unknown' = 'true'
       OR (r.details->'trial_grant'->>'ok' = 'true' AND NOT (r.details->'trial_grant' ? 'skipped'))
     )
), mint_rows AS (
  SELECT e.location_id,
         nullif(btrim(e.glofox_member_id), '') AS member_id,
         NULL::uuid AS request_id,
         e.id AS push_event_id,
         'mint_backfill'::text AS source,
         coalesce(e.created_at, now()) AS claimed_at
    FROM public.glofox_push_events e
   WHERE e.status = 'created'
     AND e.location_id IS NOT NULL
), seed AS (
  SELECT DISTINCT ON (location_id, member_id) *
    FROM (SELECT * FROM card_rows UNION ALL SELECT * FROM mint_rows) u
   WHERE member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.locations l WHERE l.id = u.location_id)
   ORDER BY location_id, member_id, claimed_at, source
)
INSERT INTO public.glofox_trial_claims (location_id, glofox_member_id, request_id, push_event_id, source, claimed_at)
SELECT location_id, member_id, request_id, push_event_id, source, claimed_at FROM seed
ON CONFLICT (location_id, glofox_member_id) WHERE released_at IS NULL DO NOTHING;

-- Self-check: the catalog, never this file's text.
DO $$
DECLARE
  v_acl text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.glofox_trial_claims_one_live')
       AND i.indrelid = 'public.glofox_trial_claims'::regclass
       AND i.indisunique AND i.indisvalid AND i.indisready
       AND i.indnatts = 2
       AND i.indpred IS NOT NULL
       AND pg_get_expr(i.indpred, i.indrelid) = '(released_at IS NULL)'
       AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
           = ARRAY['location_id', 'glofox_member_id']
  ) THEN
    RAISE EXCEPTION 'mig 697: glofox_trial_claims_one_live is not a valid unique index on (location_id, glofox_member_id) WHERE released_at IS NULL';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.glofox_trial_claims'::regclass) THEN
    RAISE EXCEPTION 'mig 697: RLS is not enabled on public.glofox_trial_claims';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.glofox_trial_claims'::regclass) THEN
    RAISE EXCEPTION 'mig 697: public.glofox_trial_claims must have no policy (service role only)';
  END IF;
  IF has_table_privilege('anon', 'public.glofox_trial_claims', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.glofox_trial_claims', 'SELECT, INSERT, UPDATE, DELETE') THEN
    SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.glofox_trial_claims'::regclass;
    RAISE EXCEPTION 'mig 697: a client role holds a privilege on public.glofox_trial_claims (%)', v_acl;
  END IF;
  RAISE NOTICE 'mig 697: glofox_trial_claims ready, % live claim(s).',
    (SELECT count(*) FROM public.glofox_trial_claims WHERE released_at IS NULL);
END $$;

COMMIT;
