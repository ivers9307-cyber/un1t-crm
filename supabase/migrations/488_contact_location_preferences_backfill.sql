-- 488 — backfill contact_location_preferences (LOCCOMMS.1).
--
-- Day one must be a ZERO-BEHAVIOUR-CHANGE event. Nothing reads this table until
-- PR 3, and a backfill that misses anyone means campaigns silently under-send —
-- the exact failure mode that motivated this work. Hence the assertions.
--
-- THIS MIGRATION IS PURELY ADDITIVE. It inserts into the new table and mutates
-- nothing else. In particular it does NOT retire contacts.email_status.
--
-- Retiring email_status='unsubscribed' was in an earlier draft and was moved to
-- PR 3 after review found that `email_status` is a hard suppressor in code the
-- send-path analysis had missed:
--   * src/app/api/contacts/[id]/email/route.js — BLOCKED_EMAIL_STATUSES gates
--     manual staff sends and does not fetch email_marketing AT ALL, so
--     email_status is its only consent check
--   * the "email blocked" badge on the contact page and in ContactDrawer
--   * booking-confirmations.js and event-attendee-reminders.js
-- Flipping 2,680 rows here would have silently un-blocked manual sends to
-- everyone who unsubscribed, for as long as PR 3 took to land. The flip belongs
-- in the same deploy as the readers that stop consuming it.
--
-- Keeping email_status intact also means this migration destroys no evidence:
-- it READS the unsubscribed signal to derive per-location consent, and leaves
-- the original in place. Ordering is therefore not load-bearing here.

-- 1. Every contact WITH a location gets a row at that location.
--    A contact with no contact_preferences row defaults to TRUE. Justification
--    is NOT the app's `pref ? !!pref[ch] : true` (that yields false for a row
--    whose column is NULL, which disagrees with the coalesce below). It is
--    mig 155: contacts.email_marketing was backfilled with the same
--    COALESCE(p.email_marketing, true) and made NOT NULL, so such contacts are
--    emailable today. Copying that preserves current behaviour exactly.
--    email_status='unsubscribed' is a CONSENT state, so it folds in here.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, unsubscribed_at, source)
select
  c.id,
  c.location_id,
  coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed',
  coalesce(p.sms_marketing, true),
  coalesce(p.whatsapp_marketing, true),
  coalesce(p.created_at, c.created_at, now()),
  case
    when (coalesce(p.email_marketing, true) and c.email_status is distinct from 'unsubscribed') = false
     and coalesce(p.sms_marketing, true)      = false
     and coalesce(p.whatsapp_marketing, true) = false
    then coalesce(p.updated_at, now())
    else null
  end,
  'migration'
from contacts c
left join contact_preferences p on p.contact_id = c.id
where c.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 2. Seed location lists from tag evidence (today: hatch-founding-member).
--
--    CONSENT ORDERING RULE (decided by Richard, 2026-08-07): a later opt-out
--    beats an earlier location-specific opt-in, EXCEPT where that opt-out was
--    an administrative correction rather than a decision the customer made.
--    Without this, the outcome would be decided by the incidental location of
--    the contact row: a tag-holder already AT the location keeps the opt-out
--    their step-1 row carries, while an identical person whose row sits at a
--    sibling location would be seeded opted-in. Same evidence, opposite result.
--
--    Two traps encoded below, both found against live data:
--      * `action` has BOTH spellings — 'opt_out' and 'opted_out'. The 69
--        whatsapp_keyword and 13 one_click_unsubscribe events use the latter.
--        Matching only 'opt_out' would silently ignore real unsubscribes.
--      * the denylist is a DENYLIST, not an allowlist, so any future/unknown
--        source counts as a genuine withdrawal. Unknown evidence must fail
--        safe (hold the person out), never fail open.
--
--    Per-channel, because the waitlist form's consent covers email, SMS and
--    WhatsApp ("...by email, SMS and WhatsApp") but a prior explicit opt-out on
--    one channel must not be overturned by a later opt-in on another.
with genuine_optout as (
  select cl.contact_id, cl.channel, max(cl.created_at) as last_optout
    from consent_log cl
   where cl.action in ('opt_out', 'opted_out')
     and cl.source not in ('leadcap1_scope_correction')
   group by cl.contact_id, cl.channel
)
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, source)
select
  ct.contact_id,
  ct.location_id,
  not exists (select 1 from genuine_optout g
               where g.contact_id = ct.contact_id
                 and g.channel = 'email_marketing'    and g.last_optout > ct.added_at),
  not exists (select 1 from genuine_optout g
               where g.contact_id = ct.contact_id
                 and g.channel = 'sms_marketing'      and g.last_optout > ct.added_at),
  not exists (select 1 from genuine_optout g
               where g.contact_id = ct.contact_id
                 and g.channel = 'whatsapp_marketing' and g.last_optout > ct.added_at),
  ct.added_at,
  'waitlist_form'
from contact_tags ct
where ct.tag = 'hatch-founding-member'
  and ct.removed_at is null
  and ct.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 3. Assertions. Each compares two GENUINELY independent sources — an earlier
--    draft of this file compared `A and B` against `not A or not B` over the
--    same join, which De Morgan makes unfalsifiable. An assertion that cannot
--    fail is worse than none: it manufactures confidence.
--
--    The independent source used here is contacts.email_marketing, which is
--    maintained by a DIFFERENT trigger (sync_contacts_email_marketing_trigger,
--    mig 155) and is the column the live send path actually reads. If the
--    denormalised column and contact_preferences have drifted, these catch it.
do $$
declare
  expected_contacts int;
  actual_contacts   int;
  null_loc          int;
  hatch_expected    int;
  hatch_actual      int;
  leaked            int;
  seed_grants       int;
begin
  -- 3a. Completeness: the backfill covered every contact that has a location.
  --     Guards against a truncated or failed insert, not against logic errors.
  select count(*) into expected_contacts from contacts where location_id is not null;
  select count(distinct contact_id) into actual_contacts
    from contact_location_preferences where source = 'migration';
  select count(*) into null_loc from contacts where location_id is null;

  if actual_contacts <> expected_contacts then
    raise exception
      'LOCCOMMS.1 completeness FAILED: % contacts have a location but only % have a migration row',
      expected_contacts, actual_contacts;
  end if;

  -- 3b. THE consent assertion, and unlike its predecessor this one can fail.
  --     Nobody who is opted out of email globally may end up opted in at their
  --     OWN location by the backfill. Compares the value this migration derived
  --     from contact_preferences + email_status against contacts.email_marketing,
  --     which a different trigger maintains.
  select count(*) into leaked
    from contacts c
    join contact_location_preferences clp
      on clp.contact_id = c.id
     and clp.location_id = c.location_id
     and clp.source = 'migration'
   where c.email_marketing = false
     and clp.email_marketing = true;

  if leaked > 0 then
    raise exception
      'LOCCOMMS.1 consent leak FAILED: % contacts are opted out of email globally but their backfilled location row says opted in',
      leaked;
  end if;

  -- 3c. Every qualifying tag has a row at the tag's own location.
  select count(*) into hatch_expected
    from contact_tags
   where tag='hatch-founding-member' and removed_at is null and location_id is not null;

  select count(*) into hatch_actual
    from contact_tags ct
   where ct.tag='hatch-founding-member' and ct.removed_at is null and ct.location_id is not null
     and exists (select 1 from contact_location_preferences clp
                  where clp.contact_id = ct.contact_id and clp.location_id = ct.location_id);

  if hatch_actual <> hatch_expected then
    raise exception
      'LOCCOMMS.1 seed FAILED: % qualifying tags but only % have a row at the tag location',
      hatch_expected, hatch_actual;
  end if;

  -- 3d. Visibility, not a gate. These people gain email reach at a location
  --     they explicitly joined despite a global opt-out — the intended
  --     behaviour of a per-location model, but it must be visible and counted
  --     rather than silent. Expected to be small; investigate if it is not.
  select count(*) into seed_grants
    from contact_location_preferences clp
    join contacts c on c.id = clp.contact_id
   where clp.source = 'waitlist_form'
     and clp.email_marketing = true
     and c.email_marketing = false;

  raise notice 'LOCCOMMS.1 backfill OK — % contacts, % null-location skipped (already unreachable), % tag rows, % people opted in at a joined location despite a global email opt-out',
    actual_contacts, null_loc, hatch_actual, seed_grants;
end $$;
