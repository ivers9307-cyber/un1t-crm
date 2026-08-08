-- 501 — re-clear re-minted email_status='unsubscribed' rows and add the CHECK
-- mig 492 should have shipped with.
--
-- mig 492 (LOCCOMMS.5) retired the value: email_status is REPUTATION ONLY
-- (active | bounced | complained), consent lives per-location in
-- contact_location_preferences. But two writers were missed in the sweep —
-- applyFormMarketingConsent and applyMarketingPreferencesBulk in
-- src/lib/marketing-consent.js — and re-minted 'unsubscribed' within hours of
-- the migration (7 live rows found in the 2026-08-08 audit, finding 5). With
-- event-reminders and sequence steps hard-suppressing on the value, that
-- recreated the cross-location over-blocking mig 492 removed.
--
-- This migration (a) flips the re-minted rows back to 'active' and (b) adds a
-- CHECK so the value cannot return no matter what code ships.
--
-- ⚠️ APPLY AFTER the code in this PR deploys — the ordering is the REVERSE of
-- the usual rule. The CHECK depends on the code change (writers no longer
-- stamp 'unsubscribed'), not the other way round. Applied against the old
-- code, the two un-fixed writers would violate the constraint on every form
-- opt-out; their updates don't check errors, so the mirror write would fail
-- SILENTLY (the consent rows themselves would still land).
--
-- The constraint EXCLUDES one value rather than allowlisting the known set.
-- Deliberate: an allowlist needs the live DISTINCT value set confirmed first
-- (this change was authored without DB access — eyeball
--   select email_status, count(*) from contacts group by 1;
-- at apply time), and an exclusion can never reject a legitimate value we
-- didn't know about. NULL passes IS DISTINCT FROM, which is correct — legacy
-- NULL rows mean 'active' (mig 005 default handling).
--
-- No consent is lost by the UPDATE: the same writers that stamped these rows
-- recorded the opt-out itself in contact_location_preferences and
-- contact_preferences first — the flag was a redundant (and harmful) mirror,
-- exactly as in mig 492.
--
-- After applying, run get_advisors for BOTH types (security + performance).

update contacts set email_status = 'active' where email_status = 'unsubscribed';

alter table contacts
  add constraint contacts_email_status_not_unsubscribed
  check (email_status is distinct from 'unsubscribed');

do $$
declare remaining int; reputation int; optouts int;
begin
  select count(*) into remaining  from contacts where email_status = 'unsubscribed';
  select count(*) into reputation from contacts where email_status in ('bounced','complained');
  select count(*) into optouts    from contact_location_preferences where email_marketing = false;

  if remaining > 0 then
    raise exception 'mig 501 FAILED: % rows still carry email_status=unsubscribed', remaining;
  end if;

  -- Same eyeball number as mig 492: the per-location opt-outs must still be
  -- there, or the flag was the only record and this migration destroyed it.
  raise notice 'mig 501 — re-minted unsubscribed rows cleared, CHECK added. % bounced/complained preserved, % per-location email opt-outs intact',
    reputation, optouts;
end $$;

comment on column contacts.email_status is
  'REPUTATION ONLY (LOCCOMMS.5, mig 492; CHECK-enforced by mig 501): active | bounced | complained. NOT consent — marketing opt-out lives per-location in contact_location_preferences. ''unsubscribed'' is constraint-rejected.';
