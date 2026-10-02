-- 702 — TRIALDEFAULT.1 (C145): contacts.trial_credits_remaining has no
-- column DEFAULT. A new contact has NO credit count (NULL) until Glofox says
-- otherwise. Existing rows are untouched.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is prod
-- BEFORE this file runs (read-only, Supabase MCP, 2 Oct 2026). Behaviour is
-- proven ahead of apply by tests/migration-702-contacts-trial-credits-no-default.test.js.
--
-- ===========================================================================
-- THE FINDING (follow-ups C145, approved by Richard 2 Oct)
-- ===========================================================================
-- Mig 001 declared `trial_credits_remaining INT DEFAULT 3`, and
-- POST /api/contacts (web form + API) wrote `?? 3` on top. So every contact
-- created anywhere without an explicit value (the web form, the API, public
-- lead forms, webhooks) started on 3 trial credits, shown as "3 credits" on
-- the contact until a Glofox link replaced it, whether or not any trial
-- existed. NULL already means "no count" to every reader (mig 519 kept the
-- column nullable on purpose: "no trial").
--
-- VERIFIED LIVE (2 Oct, BEFORE this migration): column_default '3', nullable,
-- integer. 8,834 contacts: 6,647 NULL, 1,549 at 3, of which 372 have no
-- Glofox link (303 of them created in the last 90 days, i.e. every unlinked
-- contact created in that window). merge_contacts is the only function that
-- names the column (it coalesces two rows; it sets no default); no trigger
-- writes it. This migration does not touch any of those rows.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining
--   DROP DEFAULT. Catalog-only (no rewrite, no row touched); one short
--   ACCESS EXCLUSIVE lock, bounded by lock_timeout. The route now writes an
--   explicit NULL as well, so it is right before and after this applies.
--
-- APPLY: after this PR merges and deploys. Pre/post probes in the PR body.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET DEFAULT 3;
--   COMMIT;
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Pre-check: the column is the one this file was written against (an
-- integer, nullable) and its default is either the mig-001 `3` or already
-- gone (a replay). Anything else is a drift a human should look at first.
DO $$
DECLARE
  v_type text;
  v_notnull boolean;
  v_default text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_notnull, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.contacts'::regclass
     AND a.attname = 'trial_credits_remaining'
     AND NOT a.attisdropped;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'mig 702: public.contacts.trial_credits_remaining does not exist';
  END IF;
  IF v_type <> 'integer' OR v_notnull THEN
    RAISE EXCEPTION 'mig 702: public.contacts.trial_credits_remaining is % (not null: %), expected a nullable integer', v_type, v_notnull;
  END IF;
  IF v_default IS NOT NULL AND v_default <> '3' THEN
    RAISE EXCEPTION 'mig 702: public.contacts.trial_credits_remaining default is %, expected 3 or none', v_default;
  END IF;
END $$;

ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining DROP DEFAULT;

-- Self-check: the catalog, never this file's text.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'public.contacts'::regclass
       AND a.attname = 'trial_credits_remaining'
  ) THEN
    RAISE EXCEPTION 'mig 702: public.contacts.trial_credits_remaining still has a default';
  END IF;
  RAISE NOTICE 'mig 702: contacts.trial_credits_remaining has no default; a new contact starts with no credit count.';
END $$;

COMMIT;
