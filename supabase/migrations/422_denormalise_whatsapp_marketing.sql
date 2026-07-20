-- 422 — denormalise contact_preferences.whatsapp_marketing onto contacts, +
-- whatsapp_broadcasts.delivery_summary.
--
-- WHY: WhatsApp broadcast reachability gates on whatsapp_marketing (consent),
-- wa_phone (a normalized WA number) and wa_status. consent lived only on
-- contact_preferences, so the gate needed an inner-join embed — which a
-- head:true count silently returns 0 for (CLAUDE.md PostgREST lesson). The
-- pre-send count therefore ignored consent/reachability and overstated the
-- audience; a 0-recipient send looked like "Sent · 0" with no reason.
--
-- Mirrors mig 155 (email_marketing) / 064 (sms_marketing). Source of truth
-- stays contact_preferences.whatsapp_marketing; this column is a trigger-
-- maintained read-copy so reachability is single-table.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_marketing boolean NOT NULL DEFAULT true;

-- Backfill from the source of truth.
UPDATE contacts c
  SET whatsapp_marketing = cp.whatsapp_marketing
  FROM contact_preferences cp
  WHERE cp.contact_id = c.id
    AND c.whatsapp_marketing IS DISTINCT FROM cp.whatsapp_marketing;

-- Keep it in sync. Exact mirror of sync_contacts_email_marketing (mig 155).
CREATE OR REPLACE FUNCTION sync_contacts_whatsapp_marketing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contacts
    SET whatsapp_marketing = NEW.whatsapp_marketing
    WHERE id = NEW.contact_id
      AND whatsapp_marketing IS DISTINCT FROM NEW.whatsapp_marketing;
  RETURN NEW;
END;
$$;

-- Trigger functions need no RPC surface — mirror sync_contacts_email_marketing
-- (EXECUTE only to postgres + service_role). Without this the security advisor
-- flags anon/authenticated being able to call it via /rest/v1/rpc/.
REVOKE EXECUTE ON FUNCTION public.sync_contacts_whatsapp_marketing() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_contacts_whatsapp_marketing_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_whatsapp_marketing_trigger
  AFTER INSERT OR UPDATE OF whatsapp_marketing ON contact_preferences
  FOR EACH ROW
  EXECUTE FUNCTION sync_contacts_whatsapp_marketing();

COMMENT ON COLUMN contacts.whatsapp_marketing IS
  'Denormalized read-copy of contact_preferences.whatsapp_marketing (mig 422). Trigger-maintained; operators never write it. Lets WhatsApp broadcast audiences gate reachability single-table. Source of truth = contact_preferences.';

-- Per-send reachability snapshot so the record/list explain exclusions.
ALTER TABLE whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS delivery_summary jsonb;

COMMENT ON COLUMN whatsapp_broadcasts.delivery_summary IS
  'Reachability snapshot stamped at send: { matched, reachable, excluded: { no_number, no_consent, opted_out } }. matched = raw audience_filter count; reachable = contacts actually attempted. Reason counts may overlap. Nullable for rows sent before mig 422.';
