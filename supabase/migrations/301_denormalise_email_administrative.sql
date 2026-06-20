-- ============================================================
-- 301: denormalise email_administrative onto contacts
--
-- Mirrors mig 155 (email_marketing). Lets the single-table audience
-- query gate a Utility (transactional) email on the administrative
-- opt-out without a PostgREST embed on contact_preferences (which
-- breaks count-under-head:true — see CLAUDE.md). contact_preferences
-- stays the source of truth; the contacts column is a trigger-synced
-- read-only mirror.
--
-- No index: unlike email_marketing (many opt-outs → selective partial
-- index), email_administrative=true is the near-universal default, so
-- a partial WHERE email_administrative=true index covers ~all rows.
-- ============================================================

BEGIN;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_administrative BOOLEAN NOT NULL DEFAULT TRUE;

-- BACKFILL from contact_preferences
UPDATE contacts c
SET email_administrative = COALESCE(p.email_administrative, true)
FROM contact_preferences p
WHERE p.contact_id = c.id
  AND c.email_administrative IS DISTINCT FROM COALESCE(p.email_administrative, true);

-- TRIGGER — keep contacts.email_administrative in sync
CREATE OR REPLACE FUNCTION sync_contacts_email_administrative()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contacts
  SET email_administrative = NEW.email_administrative
  WHERE id = NEW.contact_id
    AND email_administrative IS DISTINCT FROM NEW.email_administrative;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_contacts_email_administrative_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_email_administrative_trigger
AFTER INSERT OR UPDATE OF email_administrative ON contact_preferences
FOR EACH ROW
EXECUTE FUNCTION sync_contacts_email_administrative();

-- Trigger fns must not be RPC-callable. Mirrors mig 166's hardening of
-- sync_contacts_email_marketing (the trigger still fires — EXECUTE grants
-- don't gate trigger invocation). Clears advisor lint 0028/0029.
REVOKE EXECUTE ON FUNCTION public.sync_contacts_email_administrative()
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN contacts.email_administrative IS
  'Denormalised mirror of contact_preferences.email_administrative (mig 301). Trigger-synced, read-only to app code. Powers the Utility (transactional) email audience gate.';

COMMIT;
