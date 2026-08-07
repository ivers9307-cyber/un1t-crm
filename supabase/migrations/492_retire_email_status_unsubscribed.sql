-- 492 — retire contacts.email_status = 'unsubscribed' (LOCCOMMS.5).
--
-- email_status now carries REPUTATION ONLY: active | bounced | complained.
--
-- "Unsubscribed" is a consent state, and consent became per-location across
-- PR 1-4. A single global flag can no longer answer "unsubscribed from WHICH
-- business?" — it blocked manual staff sends from EVERY location on the
-- strength of someone leaving one list.
--
-- DEFERRED TWICE ON PURPOSE, from PR 3 and again from PR 4. This value is a
-- hard suppressor in five readers, and the sharpest of them —
-- /api/contacts/[id]/email — never fetched email_marketing at all, so
-- email_status was its ONLY consent gate. Flipping these rows before that
-- route changed would have silently un-blocked manual sends to all 2,680
-- people who unsubscribed. It ships in the same deploy as the code that stops
-- consuming it, and that route now gates on contact_location_preferences
-- instead: the check MOVED, it was not removed.
--
-- bounced / complained are untouched — address-level reputation, true
-- everywhere, and clearing them would damage the sending domain every location
-- shares.
--
-- No consent is lost here. It already lives in contact_location_preferences:
-- mig 488's backfill folded this exact signal in
-- (`... and c.email_status is distinct from 'unsubscribed'`), which is why the
-- opt-out count assertion below is the one that matters.

update contacts set email_status = 'active' where email_status = 'unsubscribed';

do $$
declare remaining int; reputation int; optouts int;
begin
  select count(*) into remaining  from contacts where email_status = 'unsubscribed';
  select count(*) into reputation from contacts where email_status in ('bounced','complained');
  select count(*) into optouts    from contact_location_preferences where email_marketing = false;

  if remaining > 0 then
    raise exception 'LOCCOMMS.5 FAILED: % rows still carry email_status=unsubscribed', remaining;
  end if;

  -- Not a gate, but the number to eyeball: the per-location opt-outs must still
  -- be there. If this had collapsed, the flag would have been the only record
  -- of those decisions and this migration would have destroyed them.
  raise notice 'LOCCOMMS.5 — email_status retired to reputation-only. % bounced/complained preserved, % per-location email opt-outs intact',
    reputation, optouts;
end $$;

comment on column contacts.email_status is
  'REPUTATION ONLY (LOCCOMMS.5, mig 492): active | bounced | complained. NOT consent — marketing opt-out lives per-location in contact_location_preferences. Do not reintroduce ''unsubscribed''.';

comment on table contact_preferences is
  'SUPERSEDED for marketing by contact_location_preferences (LOCCOMMS.1-5). Still written as the global record and still read for the administrative channels; the mig 489 trigger propagates changes here to the per-location rows. Not dropped — a later migration does that once nothing reads it.';
