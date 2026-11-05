-- 811 — NEWSTART.1: the one-live-claim index covers Glofox promos only.
--
-- Mig 810 made corp_promo_claims_one_live_per_contact unique on
-- (promo_key, contact_id) for every promo. That also covered 'hatch-3-free',
-- whose eligibility (corpPromoEligibility) never reads corp_promo_claims: a
-- Hatch person whose earlier claim was left processing or help_requested and
-- who submitted again would now fail the insert with 23505 (a 503), where
-- before the insert succeeded and fulfilment retried. Hatch behaviour must not
-- change, so the index is rebuilt for the Glofox promo only. 'handled' is
-- included because a handled claim now counts as claimed (NEWSTART.1b).
--
-- A new Glofox promo key must be added to this index in its own migration.
-- Prod held one claim row and no duplicates when this was written.
--
-- grant: none (no new relation)

DROP INDEX IF EXISTS public.corp_promo_claims_one_live_per_contact;

CREATE UNIQUE INDEX corp_promo_claims_one_live_per_contact
  ON public.corp_promo_claims (promo_key, contact_id)
  WHERE status IN ('processing', 'granted', 'help_requested', 'handled')
    AND promo_key = 'stillorgan-newstart';

-- Self-check (POST-state): the index exists and is limited to the Glofox promo.
DO $$
DECLARE def text;
BEGIN
  SELECT indexdef INTO def FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'corp_promo_claims' AND indexname = 'corp_promo_claims_one_live_per_contact';
  IF def IS NULL THEN
    RAISE EXCEPTION 'mig 811: index corp_promo_claims_one_live_per_contact missing; nothing was applied';
  END IF;
  IF position('stillorgan-newstart' IN def) = 0 THEN
    RAISE EXCEPTION 'mig 811: index is not limited to stillorgan-newstart; nothing was applied';
  END IF;
END $$;
