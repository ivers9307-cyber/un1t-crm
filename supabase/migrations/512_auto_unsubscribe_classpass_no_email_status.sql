-- 512 — GAPS-P1 B: auto_unsubscribe_classpass() stops writing contacts.email_status.
--
-- THE DEFECT (armed, not yet fired)
-- ─────────────────────────────────
-- Verified live against un1t-crm on 2026-08-09:
--
--   • mig 501 added CHECK (email_status IS DISTINCT FROM 'unsubscribed') as
--     contacts_email_status_not_unsubscribed, and it is enforced;
--   • auto_unsubscribe_classpass_trigger is ENABLED (tgenabled = 'O'),
--     AFTER INSERT OR UPDATE OF glofox_membership_status ON public.contacts;
--   • the live function body is still mig 151's (mig 166 only pinned
--     search_path) and its last step sets email_status to that banned value.
--
-- So the next contact that transitions INTO classpass_payg raises a CHECK
-- violation. A trigger error aborts the whole statement, so this does not just
-- skip the opt-out — it FAILS THE WRITE, breaking the Glofox member sync for
-- that contact. 1,612 contacts already sit in classpass_payg; the only reason
-- prod has not seen it is that nobody has crossed the boundary since mig 501.
--
-- WHY THE STEP IS WRONG, NOT JUST UNLUCKY
-- ───────────────────────────────────────
-- Since mig 492 (LOCCOMMS) contacts.email_status is REPUTATION-ONLY — the
-- allowed vocabulary is active | bounced | complained, and it describes
-- deliverability, not consent. Marketing consent is per-location and lives in
-- contact_location_preferences; mig 501's CHECK is what pins that split. The
-- email_status write is a leftover from the retired single-flag consent model,
-- and its original justification ("broadcast audience builders sometimes filter
-- on email_status alone") no longer holds: applyAudienceFilter reads the
-- consent tables, and COMMSFIX.B.3 removed 'unsubscribed' from the builder's
-- own option list precisely because mig 501 made it unmatchable.
--
-- A ClassPass transition also says nothing about deliverability, so there is no
-- correct replacement value — the step goes entirely rather than moving to
-- 'active' or similar.
--
-- WHAT IS DELIBERATELY UNCHANGED
-- ──────────────────────────────
-- Everything else is preserved verbatim from the live definition: the two
-- transition guards, the six-channel contact_preferences upsert, the
-- per-channel consent_log audit tagged source='auto_classpass', and the
-- search_path pin from mig 166. The function keeps doing the consent work it
-- was written for; only the banned write is removed. CREATE OR REPLACE leaves
-- auto_unsubscribe_classpass_trigger attached and enabled — the trigger is NOT
-- dropped, disabled or recreated.

create or replace function public.auto_unsubscribe_classpass()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
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

  -- 3. (REMOVED — mig 512.) The mirror onto contacts.email_status is gone.
  --    mig 501 CHECK-bans the value it wrote and mig 492 made the column
  --    reputation-only, so the statement could only ever abort the whole
  --    transition. Consent now lives in the tables step 1 and 2 write.

  RETURN NEW;
END;
$function$;

comment on function public.auto_unsubscribe_classpass() is
  'Opts a contact out of all six channels when they transition into classpass_payg, and audits one consent_log row per channel (source=auto_classpass). mig 512 removed the trailing mirror onto contacts.email_status: mig 492 made that column reputation-only (active|bounced|complained) with consent moved to contact_location_preferences, and mig 501 added a CHECK banning the value this function wrote — so the step could only raise a constraint violation and abort the membership-status write that fired it.';
