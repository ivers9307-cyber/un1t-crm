-- BLACKFRIDAY.1 (mig 827): per-studio Black Friday offer pages.
--
--   (1) sale_offers.slug is unique per studio, not globally (two studios can
--       both sell "3-month-membership"). The mig 503 default-named
--       sale_offers_slug_key is replaced by UNIQUE (location_id, slug).
--   (2) sale_offers gains un1t_product_id (the un1t.online product a Hatch
--       offer sells) and fine_print (customer-facing terms, editable).
--   (3) offer_purchases can be paid on un1t.online instead of Revolut:
--       payment_provider, un1t_* ids, last_error, terms acceptance record.
--       revolut_order_id loses NOT NULL (its UNIQUE stays) and a CHECK keeps
--       a 'revolut' row from lacking one.
--   (4) origin separates a purchase made on the offer page from one keyed in
--       off-page by staff.
--   (5) un1t_write_events_origin_check admits 'web_offer' (every origin mig
--       787 allowed is kept).
--
--   (6) Both tables become service-role only. Live, `authenticated` held
--       INSERT/SELECT/UPDATE/DELETE on both and offer_purchases_select was
--       USING (true), so any signed-in session could read every buyer's name,
--       email and phone. No client code reads either table: every reader is
--       a service-role route or page. Same pattern as mig 674 / 730: REVOKE
--       ALL from anon and authenticated, drop the policy, leave RLS on with
--       no policy.

REVOKE ALL ON public.offer_purchases FROM anon, authenticated;
REVOKE ALL ON public.sale_offers FROM anon, authenticated;
DROP POLICY IF EXISTS offer_purchases_select ON public.offer_purchases;
DROP POLICY IF EXISTS sale_offers_select ON public.sale_offers;

ALTER TABLE public.sale_offers
  DROP CONSTRAINT IF EXISTS sale_offers_slug_key;
ALTER TABLE public.sale_offers
  DROP CONSTRAINT IF EXISTS sale_offers_location_slug_key;
ALTER TABLE public.sale_offers
  ADD CONSTRAINT sale_offers_location_slug_key UNIQUE (location_id, slug);

ALTER TABLE public.sale_offers
  ADD COLUMN IF NOT EXISTS un1t_product_id text,
  ADD COLUMN IF NOT EXISTS fine_print text NOT NULL DEFAULT '';

ALTER TABLE public.offer_purchases
  ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'revolut',
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'page',
  ADD COLUMN IF NOT EXISTS un1t_user_id text,
  ADD COLUMN IF NOT EXISTS un1t_product_id text,
  ADD COLUMN IF NOT EXISTS un1t_transaction_id text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_source text,
  ADD COLUMN IF NOT EXISTS terms_version text;

ALTER TABLE public.offer_purchases
  DROP CONSTRAINT IF EXISTS offer_purchases_payment_provider_check;
ALTER TABLE public.offer_purchases
  ADD CONSTRAINT offer_purchases_payment_provider_check
  CHECK (payment_provider IN ('revolut', 'un1t_online'));

ALTER TABLE public.offer_purchases
  DROP CONSTRAINT IF EXISTS offer_purchases_origin_check;
ALTER TABLE public.offer_purchases
  ADD CONSTRAINT offer_purchases_origin_check
  CHECK (origin IN ('page', 'off_page'));

ALTER TABLE public.offer_purchases
  ALTER COLUMN revolut_order_id DROP NOT NULL;

ALTER TABLE public.offer_purchases
  DROP CONSTRAINT IF EXISTS offer_purchases_revolut_has_order_check;
ALTER TABLE public.offer_purchases
  ADD CONSTRAINT offer_purchases_revolut_has_order_check
  CHECK (payment_provider <> 'revolut' OR revolut_order_id IS NOT NULL);

ALTER TABLE public.offer_purchases
  DROP CONSTRAINT IF EXISTS offer_purchases_location_un1t_txn_key;
ALTER TABLE public.offer_purchases
  ADD CONSTRAINT offer_purchases_location_un1t_txn_key UNIQUE (location_id, un1t_transaction_id);

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_origin_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_origin_check
  CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo', 'web_offer'));

COMMENT ON COLUMN public.sale_offers.un1t_product_id IS
  'BLACKFRIDAY.1 (mig 827): the un1t.online product a studio on un1t.online sells for this offer; NULL at a Revolut studio.';
COMMENT ON COLUMN public.sale_offers.fine_print IS
  'BLACKFRIDAY.1 (mig 827): customer-facing terms shown on the offer page and recorded on acceptance. Operator-editable.';
COMMENT ON COLUMN public.offer_purchases.payment_provider IS
  'BLACKFRIDAY.1 (mig 827): revolut (hosted order) or un1t_online (charged through un1t.online).';
COMMENT ON COLUMN public.offer_purchases.origin IS
  'BLACKFRIDAY.1 (mig 827): page (bought on the public offer page) or off_page (keyed in or matched by staff).';
COMMENT ON COLUMN public.offer_purchases.un1t_user_id IS
  'BLACKFRIDAY.1 (mig 827): the buyer''s un1t.online user id (un1t_online purchases).';
COMMENT ON COLUMN public.offer_purchases.un1t_product_id IS
  'BLACKFRIDAY.1 (mig 827): the un1t.online product id charged for this purchase.';
COMMENT ON COLUMN public.offer_purchases.un1t_transaction_id IS
  'BLACKFRIDAY.1 (mig 827): the un1t.online transaction id; unique per studio so a sync or retry cannot settle twice.';
COMMENT ON COLUMN public.offer_purchases.last_error IS
  'BLACKFRIDAY.1 (mig 827): the latest charge or fulfilment failure, for staff.';
COMMENT ON COLUMN public.offer_purchases.terms_accepted_at IS
  'BLACKFRIDAY.1 (mig 827): when the buyer accepted the fine print.';
COMMENT ON COLUMN public.offer_purchases.terms_source IS
  'BLACKFRIDAY.1 (mig 827): where the terms were accepted (e.g. offer page, staff on the buyer''s behalf).';
COMMENT ON COLUMN public.offer_purchases.terms_version IS
  'BLACKFRIDAY.1 (mig 827): identifier of the fine print text accepted.';

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  k text;
BEGIN
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_origin_check'));
  FOREACH k IN ARRAY ARRAY['staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo', 'web_offer'] LOOP
    IF d IS NULL OR d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 827: un1t_write_events_origin_check does not admit %: %', k, d;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.sale_offers'::regclass AND conname = 'sale_offers_slug_key') THEN
    RAISE EXCEPTION 'mig 827: the global sale_offers slug unique is still there';
  END IF;
  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.sale_offers'::regclass AND conname = 'sale_offers_location_slug_key'));
  IF d IS NULL OR d NOT LIKE 'UNIQUE (location_id, slug)%' THEN
    RAISE EXCEPTION 'mig 827: sale_offers (location_id, slug) unique missing: %', d;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'offer_purchases'
               AND column_name = 'revolut_order_id' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'mig 827: offer_purchases.revolut_order_id is still NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
             WHERE table_schema = 'public' AND table_name IN ('offer_purchases', 'sale_offers')
               AND grantee IN ('anon', 'authenticated')) THEN
    RAISE EXCEPTION 'mig 827: anon or authenticated still holds a privilege on offer_purchases or sale_offers';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('offer_purchases', 'sale_offers')) THEN
    RAISE EXCEPTION 'mig 827: offer_purchases and sale_offers must carry no policy';
  END IF;
END $$;
