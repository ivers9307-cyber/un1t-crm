-- 641 — REPLACE.1b: "Offer to team". A manager posts an unfilled or short
-- PUBLISHED shift to every coach who is free for it; the first to claim it
-- gets it. This adds the offer table and the ONE function that decides a
-- claim. The heartbeat row for the offer arm is mig 642, applied AFTER the
-- deploy (the arm rule: a row seeded before the code that stamps it goes
-- stale after interval + grace).
--
-- WHY A TABLE OF ITS OWN (not shift_swap_requests)
-- ───────────────────────────────────────────────
-- A swap is about an ASSIGNMENT, and an unfilled shift has none. A swap row
-- with requester_shift_id NULL is how the cover sweep recognises a swap whose
-- shift was DELETED (it closes it on the next tick), requester_id is NOT NULL
-- (an offer has no giver), and a swap claim waits for a manager's approval
-- (inbox, badge, T-48/T-12 nudges). An offer is first-come, no approval.
--
-- WHAT
-- ────
-- 1. public.shift_offers — one row per offer.
--    status: open -> claimed | withdrawn | expired | filled. One OPEN offer per
--    shift (partial unique index). The notice columns carry a LEASE
--    (notice_lease_until + notice_attempts) so the sender can never lose a
--    notice: it leases, sends under a ledger key numbered by the attempt,
--    then stamps broadcast_at / taken_notified_at. A crash after the send
--    costs a duplicate on the next attempt, never the notice (CLAUDE.md
--    invariant (c): a claim taken before a send carries a lease).
-- 2. public.claim_shift_offer(p_offer_id, p_profile_id) RETURNS jsonb.
--    Locks the offer FOR UPDATE: two claimers serialise on that lock, and the
--    second reads 'claimed'. Then locks the shift (FOR UPDATE, which also
--    waits for a manager's assignment insert in flight: its FK check holds
--    KEY SHARE on the block) and re-checks, in the same transaction,
--    everything a claim depends on: the roster is published, the claimant is
--    an active, undeleted member of the offer's studio and not already on the
--    shift, and the shift still needs someone (live coaches below its target
--    and below max_coaches; target = min_coaches, at least 1, for a class
--    shift, and 1 for an admin shift, which has no minimum (SHIFTTYPE.1, mig
--    628) and is offered only while empty). If it no longer needs anyone the
--    offer closes as 'filled' and the function RETURNS { outcome: 'filled' }
--    rather than raising, so that close is kept.
--    Otherwise it clears the claimant's cancelled tombstone (the mig 067
--    (block_id, profile_id) key does not care about status), inserts the
--    assignment and closes the offer as claimed.
--    Lock order: offer, then shift. Nothing else locks a shift and then an
--    offer (REPLACE.1a's replace is one UPDATE of an assignment row), so
--    there is no cycle.
--    Errors: P0001 with a message prefix the route maps: offer_bad_request,
--    offer_not_found, offer_not_open, offer_not_published,
--    offer_not_eligible, offer_already_on.
--    The route checks, BEFORE calling it: the shift has not started (the one
--    predicate, swapShiftHasStarted, on the studio clock), and the claimant is
--    not on approved leave or on an overlapping shift (CANDIDATES.1's
--    loadBlockCandidates). shared/offer-to-team.js offerTargetCount is the JS
--    twin of the target rule: keep the two in step
--    (tests/migration-641-shift-offers.test.js pins this side).
--
-- SECURITY
-- ────────
-- RLS ON with NO policy, and the browser roles hold no grant at all: every
-- read and write is a service-role route or cron that scopes in code (the
-- mig 632 posture). The advisor reports rls_enabled_no_policy (INFO) for it,
-- by design. The function is SECURITY INVOKER (never a definer the browser
-- could reach), search_path pinned empty, every name schema-qualified,
-- EXECUTE for service_role only.
--
-- APPLY
-- ─────
-- BEFORE the REPLACE.1b code deploys (its routes and its arm read
-- shift_offers; a read of a missing table 500s the routes and fails the arm
-- every tick). Mig 642 (the 'shift-offer-sweep' heartbeat row) goes on
-- right AFTER the deploy. AFTER APPLYING: get_advisors (type=security).
--
-- REPLAYING THIS FILE IS SAFE (IF NOT EXISTS / CREATE OR REPLACE / REVOKE +
-- GRANT); it changes nothing on a replay.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   DROP FUNCTION IF EXISTS public.claim_shift_offer(uuid, uuid);
--   DROP TABLE IF EXISTS public.shift_offers;   -- no FK points INTO it

CREATE TABLE IF NOT EXISTS public.shift_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  block_id              uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
  offered_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  claimed_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  claimed_at            timestamptz,
  claimed_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
  broadcast_at          timestamptz,
  broadcast_count       integer,
  broadcast_outcome     text,
  taken_notified_at     timestamptz,
  notice_lease_until    timestamptz,
  notice_attempts       smallint NOT NULL DEFAULT 0,
  CONSTRAINT shift_offers_status CHECK (status IN ('open', 'claimed', 'withdrawn', 'expired', 'filled')),
  CONSTRAINT shift_offers_closed_pair CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT shift_offers_claim_pair CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CONSTRAINT shift_offers_broadcast_outcome CHECK (broadcast_outcome IS NULL OR broadcast_outcome IN ('sent', 'no_recipients', 'gave_up')),
  CONSTRAINT shift_offers_notice_attempts CHECK (notice_attempts BETWEEN 0 AND 20)
);

COMMENT ON TABLE public.shift_offers IS
  'REPLACE.1b (mig 641) — "Offer to team": a manager offers an unfilled/short published shift to every coach free for it; the first claim (claim_shift_offer) gets it. One OPEN offer per shift. notice_lease_until + notice_attempts lease the broadcast / taken notices (attempt-numbered ledger keys: a crash duplicates, never loses). Service-role only (RLS on, no policy, no browser grants).';

CREATE UNIQUE INDEX IF NOT EXISTS shift_offers_one_open_per_block
  ON public.shift_offers (block_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS shift_offers_block_idx ON public.shift_offers (block_id);
CREATE INDEX IF NOT EXISTS shift_offers_location_status_idx ON public.shift_offers (location_id, status);
-- The arm's second read: claimed offers whose managers are still owed the notice.
CREATE INDEX IF NOT EXISTS shift_offers_taken_owed_idx
  ON public.shift_offers (claimed_at) WHERE status = 'claimed' AND taken_notified_at IS NULL;
-- Cover the three nullable FKs (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS shift_offers_offered_by_idx ON public.shift_offers (offered_by) WHERE offered_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_offers_claimed_by_idx ON public.shift_offers (claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_offers_claimed_assignment_idx ON public.shift_offers (claimed_assignment_id) WHERE claimed_assignment_id IS NOT NULL;

ALTER TABLE public.shift_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_offers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_offers TO service_role;

CREATE OR REPLACE FUNCTION public.claim_shift_offer(p_offer_id uuid, p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_offer  public.shift_offers;
  v_block  record;
  v_live   integer;
  v_target integer;
  v_assignment_id uuid;
BEGIN
  IF p_offer_id IS NULL OR p_profile_id IS NULL THEN
    RAISE EXCEPTION 'offer_bad_request: an offer and a profile are required';
  END IF;

  -- 1. Lock the offer. This is where two claimers are serialised.
  SELECT * INTO v_offer FROM public.shift_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: offer % does not exist', p_offer_id;
  END IF;
  IF v_offer.status <> 'open' THEN
    RAISE EXCEPTION 'offer_not_open: offer is already %', v_offer.status;
  END IF;

  -- 2. Lock the shift and read what the claim depends on.
  SELECT b.id, b.location_id, b.block_date, b.min_coaches, b.max_coaches,
         r.status AS roster_status,
         COALESCE(t.kind, 'class') AS kind
    INTO v_block
    FROM public.shift_blocks b
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
   WHERE b.id = v_offer.block_id
   FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: the shift no longer exists';
  END IF;
  IF v_block.roster_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'offer_not_published: the shift is not on a published roster';
  END IF;

  -- 3. The claimant: an active, undeleted member of the offer's studio
  --    (mig 626's staff predicate: a NULL active still counts; mig 622: never
  --    a tombstone). Same rule as isRosterableProfile + membership.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profile_locations pl
      JOIN public.profiles p ON p.id = pl.profile_id
     WHERE pl.profile_id = p_profile_id
       AND pl.location_id = v_offer.location_id
       AND p.active IS NOT FALSE
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'offer_not_eligible: the claimant is not an active member of this studio';
  END IF;

  -- 4. Not already on it.
  IF EXISTS (
    SELECT 1 FROM public.shift_assignments a
     WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id
       AND COALESCE(a.status, 'scheduled') <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'offer_already_on: the claimant is already on this shift';
  END IF;

  -- 5. Still needed? Filled meanwhile closes the offer and RETURNS (a raise
  --    would roll the close back).
  SELECT count(*) INTO v_live
    FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND COALESCE(a.status, 'scheduled') <> 'cancelled';
  v_target := CASE WHEN v_block.kind = 'admin' THEN 1 ELSE GREATEST(COALESCE(v_block.min_coaches, 1), 1) END;
  IF v_live >= v_target OR v_live >= v_block.max_coaches THEN
    UPDATE public.shift_offers
       SET status = 'filled', closed_at = now(), notice_lease_until = NULL
     WHERE id = v_offer.id;
    RETURN jsonb_build_object('outcome', 'filled', 'offer_id', v_offer.id);
  END IF;

  -- 6. The claimant's cancelled tombstone would trip the (block, profile) key.
  DELETE FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id AND a.status = 'cancelled';

  -- 7. Put them on the shift. assigned_by = the claimant: they did it.
  INSERT INTO public.shift_assignments (block_id, profile_id, status, assigned_by)
  VALUES (v_block.id, p_profile_id, 'scheduled', p_profile_id)
  RETURNING id INTO v_assignment_id;

  -- 8. Close the offer. The lease resets: the managers' "taken" notice is a
  --    new phase with its own attempts.
  UPDATE public.shift_offers
     SET status = 'claimed', claimed_by = p_profile_id, claimed_at = now(), closed_at = now(),
         claimed_assignment_id = v_assignment_id, notice_lease_until = NULL, notice_attempts = 0
   WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'offer_id', v_offer.id,
    'assignment_id', v_assignment_id,
    'block_id', v_block.id,
    'block_date', to_char(v_block.block_date, 'YYYY-MM-DD'),
    'location_id', v_block.location_id
  );
END;
$$;

COMMENT ON FUNCTION public.claim_shift_offer(uuid, uuid) IS
  'REPLACE.1b (mig 641) — claims an open shift offer atomically: locks the offer (second claimer reads claimed), locks the shift, re-checks published / active member / not already on it / still needed (else closes the offer as filled and returns outcome filled), clears the claimant''s cancelled tombstone, inserts the assignment and closes the offer. P0001 with an offer_* message prefix. SECURITY INVOKER, service_role only.';

REVOKE ALL ON FUNCTION public.claim_shift_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shift_offer(uuid, uuid) TO service_role;

-- Self-check against the catalog, not this text (the mig 153b habit). A RAISE
-- aborts the whole file, so nothing half-applies.
DO $$
DECLARE
  n int;
  r text;
  p text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_offers'::regclass) THEN
    RAISE EXCEPTION 'mig 641: RLS is not enabled on shift_offers';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(r, 'public.shift_offers', p) THEN
        RAISE EXCEPTION 'mig 641: % holds % on shift_offers', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'mig 641: % can execute claim_shift_offer', r;
    END IF;
  END LOOP;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.claim_shift_offer(uuid, uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'mig 641: claim_shift_offer must be SECURITY INVOKER';
  END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'shift_offers_one_open_per_block';
  IF n <> 1 THEN
    RAISE EXCEPTION 'mig 641: expected the one-open-offer-per-shift index, found %', n;
  END IF;
END $$;
