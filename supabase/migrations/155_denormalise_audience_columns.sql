-- ============================================================
-- 155: CLASSIFY.1 — denormalise pipeline_stage_slug + email_marketing
--                   onto contacts
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Three overlapping classifications were fighting each other on the
-- contacts table: lead_status (legacy, 99.9% the default value at
-- Stillorgan), glofox_membership_status (Glofox-synced), and
-- pipeline_stage_slug (PIPELINE5 canonical, but only stored on
-- deals.stage_id — never queryable from contacts).
--
-- The audience builder exposed lead_status and glofox_membership_status
-- but not pipeline_stage_slug. Operators reached for "Lead Status =
-- member" intuitively and got 0 results because the local enum had
-- never been populated with that value. Every "fix" to the count
-- query revealed another seam — culminating in URL-length 400s when
-- the count path tried to .in('id', [3000+ uuids]) to compensate for
-- PostgREST's embedded-resource filter losing its binding under
-- count:exact + head:true.
--
-- This migration denormalises the two columns audiences actually need
-- onto contacts so the audience query becomes a single-table filter
-- with no joins, no embeds, no PostgREST gymnastics. Triggers keep
-- the denormalised columns honest.
--
-- A follow-up migration will drop the legacy lead_status column once
-- the remaining UI / sequence-trigger / contact-form references have
-- been migrated to read pipeline_stage_slug instead.

-- ============================================================
-- COLUMNS
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pipeline_stage_slug TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_marketing      BOOLEAN NOT NULL DEFAULT TRUE;

-- Indexes for filter performance. Partial index on email_marketing=true
-- because audiences always filter for opt-in.
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline_stage_slug
  ON contacts (location_id, pipeline_stage_slug);

CREATE INDEX IF NOT EXISTS idx_contacts_email_marketing
  ON contacts (location_id) WHERE email_marketing = true;

-- ============================================================
-- BACKFILL — pipeline_stage_slug from most-recent open deal
-- ============================================================

WITH latest_open_deals AS (
  SELECT DISTINCT ON (d.contact_id)
    d.contact_id,
    ps.slug
  FROM deals d
  JOIN pipeline_stages ps ON d.stage_id = ps.id
  WHERE d.status = 'open'
  ORDER BY d.contact_id, d.created_at DESC
)
UPDATE contacts c
SET pipeline_stage_slug = lod.slug
FROM latest_open_deals lod
WHERE c.id = lod.contact_id
  AND c.pipeline_stage_slug IS DISTINCT FROM lod.slug;

-- ============================================================
-- BACKFILL — email_marketing from contact_preferences
-- ============================================================

UPDATE contacts c
SET email_marketing = COALESCE(p.email_marketing, true)
FROM contact_preferences p
WHERE p.contact_id = c.id
  AND c.email_marketing IS DISTINCT FROM COALESCE(p.email_marketing, true);

-- ============================================================
-- TRIGGER — keep contacts.email_marketing in sync with
--           contact_preferences.email_marketing
-- ============================================================

CREATE OR REPLACE FUNCTION sync_contacts_email_marketing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contacts
  SET email_marketing = NEW.email_marketing
  WHERE id = NEW.contact_id
    AND email_marketing IS DISTINCT FROM NEW.email_marketing;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_contacts_email_marketing_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_email_marketing_trigger
AFTER INSERT OR UPDATE OF email_marketing ON contact_preferences
FOR EACH ROW
EXECUTE FUNCTION sync_contacts_email_marketing();

-- ============================================================
-- TRIGGER — keep contacts.pipeline_stage_slug in sync with deals
--
-- Fires on any deal INSERT/UPDATE/DELETE. Recomputes the contact's
-- canonical slug from scratch (most recent open deal's stage) so
-- multi-deal edge cases stay deterministic.
-- ============================================================

CREATE OR REPLACE FUNCTION sync_contacts_pipeline_stage_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id UUID;
  v_slug TEXT;
BEGIN
  v_contact_id := COALESCE(NEW.contact_id, OLD.contact_id);
  IF v_contact_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT ps.slug
  INTO v_slug
  FROM deals d
  JOIN pipeline_stages ps ON d.stage_id = ps.id
  WHERE d.contact_id = v_contact_id
    AND d.status = 'open'
  ORDER BY d.created_at DESC
  LIMIT 1;

  UPDATE contacts
  SET pipeline_stage_slug = v_slug
  WHERE id = v_contact_id
    AND pipeline_stage_slug IS DISTINCT FROM v_slug;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS sync_contacts_pipeline_stage_slug_trigger ON deals;
CREATE TRIGGER sync_contacts_pipeline_stage_slug_trigger
AFTER INSERT OR UPDATE OR DELETE ON deals
FOR EACH ROW
EXECUTE FUNCTION sync_contacts_pipeline_stage_slug();
