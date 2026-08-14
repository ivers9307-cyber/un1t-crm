-- 544 — auto_unsubscribe_classpass() writes the location row itself.
--
-- THE DEFECT (live, 11 contacts, 5 currently mailable)
-- ───────────────────────────────────────────────────
-- Three AFTER INSERT triggers sit on contacts. Postgres fires them in
-- ALPHABETICAL ORDER BY TRIGGER NAME:
--
--   1. auto_unsubscribe_classpass_trigger
--   2. contact_location_preferences_create_trigger
--   3. contact_preferences_trigger
--
-- For a contact INSERTED already at glofox_membership_status='classpass_payg':
--
--   (1) upserts contact_preferences all-false. Its own sync trigger
--       (mig 489/543) then runs `UPDATE contact_location_preferences … WHERE
--       contact_id = …` — which matches ZERO ROWS, because the location row
--       does not exist yet.
--   (2) creates the location row, with email_marketing DEFAULT TRUE.
--
-- Net result: consent_log says opted out of all six channels,
-- contact_preferences says false, and contact_location_preferences —
-- the ONLY column the sender reads (campaign-sender.js:190,
-- `.eq('loc_email_marketing', true)`) — says TRUE.
--
-- Verified live 2026-08-14: 11 contacts, all ClassPass relay addresses created
-- 7–14 Aug, contact_created == prefs_created == subscribed_at == opt_out to the
-- microsecond (one transaction, so now() is stable across all three). Five of
-- them pass the sender's full consent gate right now. The population grows with
-- every new ClassPass member.
--
-- Only INSERT is affected. An existing contact TRANSITIONING into classpass_payg
-- already has a location row, so the sync fan-out lands and the state is
-- correct — which is why the May backfill cohort looks fine and this stayed
-- invisible for months.
--
-- THE FIX
-- ───────
-- Stop depending on another trigger having already run. The function upserts
-- the location row itself, so it is correct whichever order the triggers fire
-- in. Renaming a trigger to force alphabetical order was rejected: it encodes
-- a load-bearing invariant in a name, where the next person to add a trigger
-- cannot see it.
--
-- SECURITY CONTEXT PRESERVED VERBATIM: this function is SECURITY INVOKER with
-- search_path='pg_catalog, public' (checked against pg_proc before writing —
-- prosecdef=false). CREATE OR REPLACE inherits neither, so both are restated.
-- Adding a contact_location_preferences write under INVOKER introduces no new
-- exposure: that table carries exactly the same RLS shape as the two this
-- function already writes (contact_preferences and consent_log) — RLS enabled,
-- one permissive FOR ALL policy, location-scoped — and the only real caller is
-- the Glofox sync running as service_role, which bypasses RLS entirely.
--
-- Everything else is preserved verbatim from mig 512.

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

  -- 1b. (mig 544) Own the location row rather than assuming it exists.
  --     On INSERT it does not yet — step 1's sync trigger updated nothing —
  --     so without this the row is created DEFAULT true a moment later and
  --     the person stays mailable. On UPDATE the row already exists and this
  --     is a harmless idempotent rewrite of values step 1 already fanned out.
  IF NEW.location_id IS NOT NULL THEN
    INSERT INTO contact_location_preferences (
      contact_id, location_id, source,
      email_marketing, sms_marketing, whatsapp_marketing,
      unsubscribed_at
    )
    VALUES (NEW.id, NEW.location_id, 'auto_classpass', false, false, false, NOW())
    ON CONFLICT (contact_id, location_id) DO UPDATE SET
      email_marketing    = false,
      sms_marketing      = false,
      whatsapp_marketing = false,
      unsubscribed_at    = COALESCE(contact_location_preferences.unsubscribed_at, NOW()),
      updated_at         = NOW();
  END IF;

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
  'Opts a contact out of all six channels on transition into classpass_payg, and audits one consent_log row per channel (source=auto_classpass). mig 512 removed the contacts.email_status mirror. mig 544 made the function write contact_location_preferences itself: on INSERT it fires before contact_location_preferences_create_trigger (alphabetical trigger order), so the mig 489 fan-out updated zero rows and the location row was then created DEFAULT true — leaving 11 opted-out contacts mailable, 5 of them passing the sender gate.';

-- ── Backfill the affected contacts ──────────────────────────────────────────
-- Scoped by the auto_classpass consent_log row, NOT by the raw
-- global-false/location-true shape. That shape is also produced legitimately by
-- LEADCAP.1: David Twomey (8146f6fc) and Emily Wilson Green (61236550) are
-- opted out at Stillorgan and opted IN at Hatch Street off a July waitlist
-- form. Those two must survive this migration untouched.
update contact_location_preferences clp
   set email_marketing    = false,
       sms_marketing      = false,
       whatsapp_marketing = false,
       unsubscribed_at    = coalesce(clp.unsubscribed_at, now()),
       updated_at         = now()
  from contact_preferences cp
 where cp.contact_id = clp.contact_id
   and cp.email_marketing = false
   and clp.email_marketing = true
   and exists (
     select 1 from consent_log l
      where l.contact_id = clp.contact_id
        and l.source = 'auto_classpass'
        and l.action = 'opt_out'
        and l.channel = 'email_marketing'
   );

-- ── Drift detector (CLASSPASS-CONSENT.2) ────────────────────────────────────
-- The consent tables disagreed silently for a week and nothing looked. The one
-- an operator reads said "opted out"; the one the sender reads said "mailable".
-- This is the cheap standing check for the next cause, whatever it turns out
-- to be.
--
-- SECURITY INVOKER (the default, restated for clarity): the only caller is the
-- cron route running as service_role, which bypasses RLS. Making it DEFINER
-- would hand any authenticated caller a full cross-location read of who is
-- opted out, for no benefit.
create or replace function public.consent_drift_rows()
returns table (contact_id uuid, location_id uuid, email text)
language sql
security invoker
set search_path to 'pg_catalog', 'public'
as $$
  select clp.contact_id, clp.location_id, c.email
    from contact_location_preferences clp
    join contact_preferences cp on cp.contact_id = clp.contact_id
    join contacts c on c.id = clp.contact_id
   where cp.email_marketing = false
     and clp.email_marketing = true
     -- LEADCAP.1: a location the person explicitly joined outranks the global
     -- flag. Excluded by source, so only accidental drift is reported.
     and clp.source is distinct from 'waitlist_form';
$$;

comment on function public.consent_drift_rows() is
  'Contacts opted out of email marketing globally but still mailable on a location list (the column campaign-sender reads). Excludes source=waitlist_form, which is the legitimate LEADCAP.1 shape. Read by /api/cron/consent-drift-check.';

-- expected_interval_seconds is NOT NULL with NO DEFAULT — a bare
-- `insert (name)` raises 23502 and takes the whole migration down with it.
-- 86400 + 21600 grace matches the other daily sweeps (connection-health,
-- ad-insights-sync), so a single missed 06:00 run does not page anyone.
insert into cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values (
  'consent-drift-check',
  86400,
  21600,
  'CLASSPASS-CONSENT.2 — daily 06:00 UTC check for contacts opted out globally but still mailable on a location list. Vercel cron 0 6 * * * UTC'
)
on conflict (name) do nothing;
