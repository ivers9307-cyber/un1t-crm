-- CONSENT.2 — blanket auto-unsubscribe rule for ClassPass contacts.
--
-- Why: ClassPass leads are flaky from a deliverability standpoint —
-- often disposable / outdated emails, and they engage with UN1T via
-- the ClassPass app rather than our channels. Marketing them risks
-- bounces; utility-messaging them is just confusing. Blanket off.
--
-- Behaviour:
--   1. AFTER INSERT OR UPDATE OF glofox_membership_status on
--      contacts → if NEW status is 'classpass_payg' AND it's a
--      transition (insert, or status changed TO classpass_payg from
--      something else), disable all 6 channel flags + flip
--      contacts.email_status to 'unsubscribed' + write 6
--      consent_log rows with source='auto_classpass'.
--
--   2. Transition-only check means an operator can still manually
--      re-enable a channel via /api/contacts/[id]/marketing-preferences
--      and the trigger won't undo it on the next contact update —
--      it only fires when status BECOMES classpass_payg.
--
--   3. We do NOT auto-re-enable when classpass_payg → some other
--      status. Once consent is withdrawn, it requires explicit
--      opt-in (operator flip OR customer preference centre).

CREATE OR REPLACE FUNCTION auto_unsubscribe_classpass()
RETURNS TRIGGER AS $$
DECLARE
  channels TEXT[] := ARRAY[
    'email_marketing', 'email_administrative',
    'sms_marketing',   'sms_administrative',
    'whatsapp_marketing', 'whatsapp_administrative'
  ];
BEGIN
  -- Only fire on transitions to classpass_payg.
  IF NEW.glofox_membership_status IS DISTINCT FROM 'classpass_payg' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.glofox_membership_status IS NOT DISTINCT FROM NEW.glofox_membership_status THEN
    RETURN NEW;
  END IF;

  -- 1. Ensure a contact_preferences row exists (mig 005 trigger
  --    should have created one on contact insert; defence-in-depth
  --    in case the contact predates that trigger).
  INSERT INTO contact_preferences (
    contact_id,
    email_marketing, email_administrative,
    sms_marketing,   sms_administrative,
    whatsapp_marketing, whatsapp_administrative
  )
  VALUES (
    NEW.id,
    false, false,
    false, false,
    false, false
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    email_marketing         = false,
    email_administrative    = false,
    sms_marketing           = false,
    sms_administrative      = false,
    whatsapp_marketing      = false,
    whatsapp_administrative = false,
    updated_at              = NOW();

  -- 2. Audit one row per channel so the consent_log carries a
  --    complete record. source='auto_classpass' lets queries
  --    distinguish from preference_centre + admin_panel rows.
  INSERT INTO consent_log (contact_id, channel, action, source)
  SELECT NEW.id, ch, 'opt_out', 'auto_classpass'
  FROM unnest(channels) AS ch;

  -- 3. Mirror to contacts.email_status so broadcast audience
  --    builders (which sometimes filter on email_status alone) also
  --    exclude the contact. UPDATE OF (...) on the trigger means
  --    this UPDATE on a different column doesn't re-fire the trigger.
  UPDATE contacts SET email_status = 'unsubscribed' WHERE id = NEW.id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auto_unsubscribe_classpass_trigger ON contacts;
CREATE TRIGGER auto_unsubscribe_classpass_trigger
AFTER INSERT OR UPDATE OF glofox_membership_status ON contacts
FOR EACH ROW EXECUTE FUNCTION auto_unsubscribe_classpass();

-- ── One-shot backfill for existing ClassPass contacts ────────
-- The trigger above only fires on future transitions; we need to
-- catch contacts that are ALREADY classpass_payg from the bulk
-- import. Same writes the trigger would do, just in a single pass.

-- 1. Disable all 6 channels for existing ClassPass contacts.
INSERT INTO contact_preferences (
  contact_id,
  email_marketing, email_administrative,
  sms_marketing,   sms_administrative,
  whatsapp_marketing, whatsapp_administrative
)
SELECT
  c.id,
  false, false,
  false, false,
  false, false
FROM contacts c
WHERE c.glofox_membership_status = 'classpass_payg'
ON CONFLICT (contact_id) DO UPDATE SET
  email_marketing         = false,
  email_administrative    = false,
  sms_marketing           = false,
  sms_administrative      = false,
  whatsapp_marketing      = false,
  whatsapp_administrative = false,
  updated_at              = NOW();

-- 2. Audit the backfill — one row per (contact, channel).
INSERT INTO consent_log (contact_id, channel, action, source)
SELECT c.id, ch, 'opt_out', 'auto_classpass_backfill'
FROM contacts c
CROSS JOIN unnest(ARRAY[
  'email_marketing', 'email_administrative',
  'sms_marketing',   'sms_administrative',
  'whatsapp_marketing', 'whatsapp_administrative'
]) AS ch
WHERE c.glofox_membership_status = 'classpass_payg';

-- 3. Mirror to contacts.email_status.
UPDATE contacts
SET email_status = 'unsubscribed'
WHERE glofox_membership_status = 'classpass_payg'
  AND (email_status IS DISTINCT FROM 'unsubscribed');

-- Sanity report — surface in NOTICE for the operator.
DO $$
DECLARE
  cp_count INT;
  pref_count INT;
BEGIN
  SELECT COUNT(*) INTO cp_count FROM contacts WHERE glofox_membership_status = 'classpass_payg';
  SELECT COUNT(*) INTO pref_count
  FROM contact_preferences cp
  JOIN contacts c ON c.id = cp.contact_id
  WHERE c.glofox_membership_status = 'classpass_payg'
    AND cp.email_marketing = false
    AND cp.email_administrative = false
    AND cp.sms_marketing = false
    AND cp.sms_administrative = false
    AND cp.whatsapp_marketing = false
    AND cp.whatsapp_administrative = false;
  RAISE NOTICE 'CONSENT.2 backfill: % classpass contacts, % fully opted out (should match)', cp_count, pref_count;
END $$;
