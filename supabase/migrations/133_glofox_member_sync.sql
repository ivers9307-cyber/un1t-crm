-- ============================================================
-- 133: contacts — glofox membership sync columns (GLOFOX2.1).
--
-- glofox_member_id already existed (mig 037-era contact import
-- runner uses it as a stable lookup key). Adds the two columns
-- the daily sync needs:
--
--   glofox_membership_status — friendly string captured from the
--     Glofox payload's membership state. Common values we expect:
--     'active', 'paused', 'cancelled', 'expired', 'lead' (no
--     active membership), but TEXT not enum so we don't have to
--     migrate every time Glofox introduces a new state. Used by
--     the lapsing-member sequence template + future dashboards
--     that need "members training every week".
--
--   glofox_synced_at — timestamp the sync last refreshed this
--     contact from Glofox. Lets the cron skip recently-synced
--     rows + lets the operator audit "this contact looks stale,
--     when did Glofox last update it".
--
-- Index on glofox_member_id is added (IF NOT EXISTS) to support
-- bulk sync lookups from contact-import-runner.js + the new
-- glofox-sync.js. May already exist as a partial unique from a
-- prior migration; the IF NOT EXISTS makes that safe.
-- ============================================================

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS glofox_membership_status TEXT,
  ADD COLUMN IF NOT EXISTS glofox_synced_at TIMESTAMPTZ;

-- Bulk lookups by glofox_member_id (sync, import) need this.
-- Partial: many contacts have NULL glofox_member_id (leads who
-- never linked to a Glofox member); skip them in the index to
-- keep it small.
CREATE INDEX IF NOT EXISTS contacts_glofox_member_id_idx
  ON public.contacts(glofox_member_id)
  WHERE glofox_member_id IS NOT NULL;

COMMENT ON COLUMN public.contacts.glofox_membership_status IS
  'Glofox membership state captured at last sync (active / paused / cancelled / expired / lead). Sourced from Glofox; never edited by the CRM operator. Mig 133.';

COMMENT ON COLUMN public.contacts.glofox_synced_at IS
  'When the daily Glofox sync last refreshed this contact. NULL = never synced. Mig 133.';

COMMIT;
