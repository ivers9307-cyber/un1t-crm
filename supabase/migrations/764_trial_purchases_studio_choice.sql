-- 764 — TRIALSTUDIO.1: the /trial page's studio choice. trial_purchases learns
-- the Hatch Street (un1t.online) purchase and the help/handled/expired states.
--
-- WHY. The public /trial page now lets the visitor pick a studio. Stillorgan
-- still sells the Glofox-granted paid trial (mig 762). Hatch Street sells the
-- trial product through a un1t.online checkout, so a row can have no Glofox
-- membership or plan at all, and instead carries the un1t.online product, user
-- and write-ledger row, plus the terms the buyer accepted. A buyer who cannot
-- finish can ask for help, staff mark it handled, and a checkout nobody paid
-- expires.
--
-- WHAT.
--   (1) trial_purchases.membership_id and plan_code become nullable (a
--       un1t.online row has neither).
--   (2) New columns: un1t_product_id, un1t_user_id, un1t_ledger_id (the
--       un1t_write_events row of the purchase), terms_accepted_at,
--       terms_source, terms_version.
--   (3) trial_purchases_status_check: awaiting_payment | queued | processing |
--       granted | needs_review | failed | payment_failed | help_requested |
--       handled | expired. Mig 762 had no status CHECK; every status it wrote
--       is in the list.
--   (4) idx_trial_purchases_un1t_open: the open un1t.online checkouts, for the
--       sweeper that expires them.
--   (5) un1t_write_events_origin_check also admits 'web_trial' (the public
--       /trial page as the origin of a ledger write); every origin mig 744
--       allowed is kept.
--
-- GRANTS. No new table, view, sequence or function. trial_purchases stays
-- service role only: the new columns need no grant, and the revoke from mig
-- 762 is repeated at the end so a later default-ACL change cannot reopen it.
--
-- LOCKS. One transaction, 5s lock_timeout. Both tables are small (trial
-- purchases: tens of rows; the ledger: a few hundred); the CHECK scans and the
-- index build are instant. The new columns are nullable with no default.
--
-- IDEMPOTENT. IF NOT EXISTS on columns and the index, drop-if-exists then add
-- on each CHECK, DROP NOT NULL is a no-op the second time. The DO block checks
-- the POST-STATE in the catalog and aborts the whole file.
--
-- ORDER. Apply BEFORE the code that writes the new columns, statuses or the
-- 'web_trial' origin deploys: until then the CHECKs refuse those rows and the
-- new choice fails closed.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.trial_purchases
  ALTER COLUMN membership_id DROP NOT NULL,
  ALTER COLUMN plan_code DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS un1t_product_id text,
  ADD COLUMN IF NOT EXISTS un1t_user_id text,
  ADD COLUMN IF NOT EXISTS un1t_ledger_id uuid,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_source text,
  ADD COLUMN IF NOT EXISTS terms_version text;

ALTER TABLE public.trial_purchases
  DROP CONSTRAINT IF EXISTS trial_purchases_status_check;
ALTER TABLE public.trial_purchases
  ADD CONSTRAINT trial_purchases_status_check
  CHECK (status IN ('awaiting_payment', 'queued', 'processing', 'granted', 'needs_review', 'failed',
                    'payment_failed', 'help_requested', 'handled', 'expired'));

CREATE INDEX IF NOT EXISTS idx_trial_purchases_un1t_open
  ON public.trial_purchases (created_at)
  WHERE payment_provider = 'un1t_online' AND status = 'awaiting_payment';

ALTER TABLE public.un1t_write_events
  DROP CONSTRAINT IF EXISTS un1t_write_events_origin_check;
ALTER TABLE public.un1t_write_events
  ADD CONSTRAINT un1t_write_events_origin_check
  CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial'));

COMMENT ON COLUMN public.trial_purchases.membership_id IS 'Glofox membership id of the Stillorgan trial. NULL on a un1t.online (Hatch Street) row (TRIALSTUDIO.1, mig 764).';
COMMENT ON COLUMN public.trial_purchases.plan_code IS 'Glofox plan code of the Stillorgan trial. NULL on a un1t.online (Hatch Street) row (TRIALSTUDIO.1, mig 764).';
COMMENT ON COLUMN public.trial_purchases.un1t_product_id IS 'TRIALSTUDIO.1: the un1t.online trial product sold on this row (Hatch Street). NULL on a Glofox row.';
COMMENT ON COLUMN public.trial_purchases.un1t_user_id IS 'TRIALSTUDIO.1: the buyer''s un1t.online user id, once the CRM has created or found it.';
COMMENT ON COLUMN public.trial_purchases.un1t_ledger_id IS 'TRIALSTUDIO.1: the un1t_write_events row (origin web_trial) that records the un1t.online checkout for this purchase.';
COMMENT ON COLUMN public.trial_purchases.terms_accepted_at IS 'TRIALSTUDIO.1: when the buyer accepted the trial terms on the /trial page.';
COMMENT ON COLUMN public.trial_purchases.terms_source IS 'TRIALSTUDIO.1: where the terms were accepted (the surface, e.g. the /trial checkbox).';
COMMENT ON COLUMN public.trial_purchases.terms_version IS 'TRIALSTUDIO.1: the version of the terms text the buyer accepted.';
COMMENT ON CONSTRAINT trial_purchases_status_check ON public.trial_purchases IS 'TRIALSTUDIO.1 (mig 764): awaiting_payment | queued | processing | granted | needs_review | failed | payment_failed | help_requested | handled | expired.';
COMMENT ON INDEX public.idx_trial_purchases_un1t_open IS 'TRIALSTUDIO.1 (mig 764): open un1t.online trial checkouts (awaiting_payment), oldest first, for the expiry sweep.';

-- Repeated from mig 762 so a later default-ACL change cannot reopen the table.
ALTER TABLE public.trial_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_purchases FROM anon, authenticated, PUBLIC;

-- ---------------------------------------------------------------------------
-- Self-check: the post-state in the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  d text;
  k text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.trial_purchases'::regclass
                AND attname IN ('membership_id', 'plan_code') AND attnotnull) THEN
    RAISE EXCEPTION 'mig 764: trial_purchases.membership_id / plan_code still NOT NULL';
  END IF;
  FOREACH k IN ARRAY ARRAY['un1t_product_id', 'un1t_user_id', 'un1t_ledger_id', 'terms_accepted_at', 'terms_source', 'terms_version'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = 'public.trial_purchases'::regclass AND attname = k AND NOT attisdropped) THEN
      RAISE EXCEPTION 'mig 764: trial_purchases.% missing', k;
    END IF;
  END LOOP;

  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.trial_purchases'::regclass AND conname = 'trial_purchases_status_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 764: trial_purchases_status_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['awaiting_payment', 'queued', 'processing', 'granted', 'needs_review', 'failed',
                           'payment_failed', 'help_requested', 'handled', 'expired'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 764: trial_purchases_status_check does not admit %: %', k, d;
    END IF;
  END LOOP;

  d := (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_trial_purchases_un1t_open');
  IF d IS NULL OR d NOT LIKE '%(created_at) WHERE%' OR d NOT LIKE '%''un1t_online''%' OR d NOT LIKE '%''awaiting_payment''%' THEN
    RAISE EXCEPTION 'mig 764: idx_trial_purchases_un1t_open wrong or missing: %', d;
  END IF;

  d := pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.un1t_write_events'::regclass AND conname = 'un1t_write_events_origin_check'));
  IF d IS NULL THEN
    RAISE EXCEPTION 'mig 764: un1t_write_events_origin_check missing';
  END IF;
  FOREACH k IN ARRAY ARRAY['staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial'] LOOP
    IF d NOT LIKE '%''' || k || '''%' THEN
      RAISE EXCEPTION 'mig 764: un1t_write_events_origin_check does not admit %: %', k, d;
    END IF;
  END LOOP;

  -- Still closed to every client role.
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND table_name = 'trial_purchases'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'mig 764: trial_purchases is open to a client role';
  END IF;
END $$;

COMMIT;
