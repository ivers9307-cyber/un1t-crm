-- 702 — TRIALDEFAULT.1 (C145): contacts.trial_credits_remaining has no
-- column DEFAULT. A new contact has NO credit count (NULL) until Glofox says
-- otherwise. The old default's 3s on contacts with NO Glofox link are cleared
-- to NULL (Richard, 2 Oct: "clear the credits on their accounts, not their
-- accounts" -- only this one column changes; no contact is deleted or
-- otherwise edited). Linked contacts are untouched.
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
-- contact created in that window). merge_contacts names the column (it
-- coalesces two rows); the view contact_location_audience passes it through;
-- handle_new_booking() inserts contacts without it (so it got the default 3
-- too). No trigger writes it. 0 stored filters (campaigns, segments,
-- sequences, automations, broadcasts) name it.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining
--   DROP DEFAULT. Catalog-only (no rewrite, no row touched); one short
--   ACCESS EXCLUSIVE lock, bounded by lock_timeout. The route now writes an
--   explicit NULL as well, so it is right before and after this applies.
--   Then the clear: every contact at exactly 3 with glofox_member_id IS NULL
--   goes to NULL, its id first recorded in
--   private.c145_trial_credits_cleared_20261002 (RLS on, service_role only)
--   so the rollback can put back exactly those 3s. The count must be in
--   360-420 (372 measured; a few unlinked contacts a day still got the
--   default until this applies) or the whole file aborts. A replay (the
--   backup already holds rows) clears nothing more.
--
-- APPLY: after this PR merges and deploys. Pre/post probes in the PR body.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here):
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   ALTER TABLE public.contacts ALTER COLUMN trial_credits_remaining SET DEFAULT 3;
--   UPDATE public.contacts c
--      SET trial_credits_remaining = 3
--     FROM private.c145_trial_credits_cleared_20261002 b
--    WHERE b.contact_id = c.id
--      AND c.trial_credits_remaining IS NULL
--      AND c.glofox_member_id IS NULL;
--   COMMIT;
--   (A cleared contact Glofox has linked or given a balance since is never
--   overwritten.)
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

-- The clear (Richard, 2 Oct): the credit number only, on unlinked contacts at 3.
CREATE TABLE IF NOT EXISTS private.c145_trial_credits_cleared_20261002 (
  contact_id uuid PRIMARY KEY
);
COMMENT ON TABLE private.c145_trial_credits_cleared_20261002 IS
  'TRIALDEFAULT.1 (mig 702): contacts whose default trial_credits_remaining = 3 (no Glofox link) was cleared to NULL on apply. Kept so a rollback restores exactly these.';
ALTER TABLE private.c145_trial_credits_cleared_20261002 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.c145_trial_credits_cleared_20261002 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE private.c145_trial_credits_cleared_20261002 TO service_role;

DO $$
DECLARE
  v_count integer;
  v_recorded integer;
  v_cleared integer;
BEGIN
  IF EXISTS (SELECT 1 FROM private.c145_trial_credits_cleared_20261002) THEN
    RAISE NOTICE 'mig 702: clear already ran (backup holds rows); nothing more cleared.';
    RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM public.contacts
   WHERE trial_credits_remaining = 3 AND glofox_member_id IS NULL;
  IF v_count NOT BETWEEN 360 AND 420 THEN
    RAISE EXCEPTION 'mig 702: % unlinked contacts at 3 credits, expected 360-420', v_count;
  END IF;
  INSERT INTO private.c145_trial_credits_cleared_20261002 (contact_id)
  SELECT id FROM public.contacts
   WHERE trial_credits_remaining = 3 AND glofox_member_id IS NULL;
  GET DIAGNOSTICS v_recorded = ROW_COUNT;
  UPDATE public.contacts c
     SET trial_credits_remaining = NULL
    FROM private.c145_trial_credits_cleared_20261002 b
   WHERE b.contact_id = c.id
     AND c.trial_credits_remaining = 3
     AND c.glofox_member_id IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  IF v_recorded <> v_count OR v_cleared <> v_count THEN
    RAISE EXCEPTION 'mig 702: counted %, recorded %, cleared % (must be equal)', v_count, v_recorded, v_cleared;
  END IF;
  RAISE NOTICE 'mig 702: cleared the default 3 credits on % unlinked contacts.', v_cleared;
END $$;

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
