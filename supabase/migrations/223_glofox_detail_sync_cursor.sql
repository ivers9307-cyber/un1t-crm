-- 223_glofox_detail_sync_cursor.sql
-- Glofox per-member DETAIL refresh cursor (GLOFOX4.1).
--
-- Problem: the nightly glofox-sync cron pulls only the lightweight
-- /members LIST shape, so the rich per-member detail (plan name,
-- membership type, membership_state = paused/locked, price, billing
-- interval, pack credits) only ever landed for the ~660 contacts that
-- happened to trigger a webhook. 92% of the base has no plan detail.
--
-- Fix: a new resumable drainer (/api/cron/glofox-detail-refresh)
-- pulls /members/:id detail for the whole ever-member/trial/pack/
-- classpass cohort, NULLS-first (backfill), then re-pulls rows whose
-- detail is older than STALE_DAYS as a safety net for any webhook
-- Glofox fails to deliver. This column is its progress cursor.

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS glofox_detail_synced_at timestamptz;

COMMENT ON COLUMN contacts.glofox_detail_synced_at IS
  'Last time /members/:id detail was pulled for this contact by the '
  'glofox-detail-refresh drainer. NULL = never (pull first). GLOFOX4.1.';

-- Drives the drainer "next batch" query: cohort rows ordered by
-- detail freshness (NULLS first). Partial index keeps it narrow to
-- contacts that actually have a Glofox id.
CREATE INDEX IF NOT EXISTS idx_contacts_glofox_detail_cursor
  ON contacts (glofox_detail_synced_at ASC NULLS FIRST)
  WHERE glofox_member_id IS NOT NULL;

COMMIT;
