-- 810 — NEWSTART.1: the /corp promo claim flow gains a Glofox branch.
--
-- corp_promo_claims (mig 787) so far recorded un1t.online grants only. A
-- Glofox studio (Stillorgan, the /newstart promo) needs:
--   glofox_member_id  the Glofox member the free trial was bought onto
--   grant             write-ahead marker for the purchase, same shape as
--                     trial_purchases.grant ({ stage: 'purchasing' } before
--                     the call, the outcome after), so a death mid-claim is
--                     never bought twice
-- and a structural guarantee of one live claim per person per promo (a second
-- concurrent claim for the same contact hits the index instead of racing).
-- Prod held one claim row and no duplicates when this was written (5 Nov 2026).
--
-- grant: none (no new relation)

ALTER TABLE public.corp_promo_claims
  ADD COLUMN IF NOT EXISTS glofox_member_id text,
  ADD COLUMN IF NOT EXISTS "grant" jsonb;

COMMENT ON COLUMN public.corp_promo_claims.glofox_member_id IS
  'NEWSTART.1 — the Glofox member id the promo trial was bought onto (Glofox promos only; NULL for un1t.online claims).';
COMMENT ON COLUMN public.corp_promo_claims."grant" IS
  'NEWSTART.1 — write-ahead marker for the Glofox purchase, same shape as trial_purchases.grant: { stage: ''purchasing'' } before the call, the outcome after. No marker, no purchase.';

CREATE UNIQUE INDEX IF NOT EXISTS corp_promo_claims_one_live_per_contact
  ON public.corp_promo_claims (promo_key, contact_id)
  WHERE status IN ('processing', 'granted', 'help_requested');

-- Self-check (POST-state): both columns and the index exist.
DO $$
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'corp_promo_claims' AND column_name = 'glofox_member_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 810: corp_promo_claims.glofox_member_id missing; nothing was applied';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'corp_promo_claims' AND column_name = 'grant';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 810: corp_promo_claims.grant missing; nothing was applied';
  END IF;
  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'corp_promo_claims' AND indexname = 'corp_promo_claims_one_live_per_contact';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 810: index corp_promo_claims_one_live_per_contact missing; nothing was applied';
  END IF;
END $$;
