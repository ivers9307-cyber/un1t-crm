-- 487 — backfill contact_location_preferences (LOCCOMMS.1).
--
-- Day one must be a ZERO-BEHAVIOUR-CHANGE event. Nothing reads this table yet,
-- but PR 3 cuts the send paths over to it, and a backfill that misses anyone
-- means campaigns silently under-send — the exact failure mode that motivated
-- this work. Hence the assertions: they raise, which rolls the whole migration
-- back rather than leaving a half-populated table.
--
-- ORDERING IS LOAD-BEARING. Step 4 sets email_status='active' on ~2,680 rows,
-- which destroys one of the two signals that mean "opted out of email". So the
-- consent-preservation assertion runs in step 3, BEFORE that flip, while the
-- pre-migration truth is still readable straight off the live tables. An
-- earlier draft snapshotted those counts into a temporary table instead, which
-- made the migration depend on apply_migration running every statement in one
-- session — unspecified behaviour, and if it splits them the temp table is gone
-- before the assertions read it. Asserting in the right order needs no such
-- guarantee. Do not reorder these steps.

-- 1. Every contact WITH a location gets a row at that location.
--    A contact with no contact_preferences row defaults to TRUE, because
--    applyFormMarketingConsent already treats a missing row as opted in
--    (`const current = pref ? !!pref[ch] : true`). Copying that default
--    preserves today's behaviour exactly.
--    email_status='unsubscribed' is a CONSENT state, so it folds into
--    email_marketing here and the column is retired in step 4.
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

-- 2. Seed Hatch Street (and any future location list) from the tag evidence.
--    contact_tags.location_id already carries the correct location scope.
--    ON CONFLICT DO NOTHING is correct: a tag-holder whose contact row is
--    already AT that location got their row in step 1, and for them the global
--    preference WAS their location preference — every send they ever received
--    from that location was governed by it. Only tag-holders whose contact row
--    lives elsewhere need a fresh opted-in row, which is exactly the set that
--    is currently unreachable.
insert into contact_location_preferences
  (contact_id, location_id, email_marketing, sms_marketing, whatsapp_marketing,
   subscribed_at, source)
select ct.contact_id, ct.location_id, true, true, true, ct.added_at, 'waitlist_form'
from contact_tags ct
where ct.tag = 'hatch-founding-member'
  and ct.removed_at is null
  and ct.location_id is not null
on conflict (contact_id, location_id) do nothing;

-- 3. Assertions. A raise here aborts the transaction and rolls back 1-2.
do $$
declare
  expected_contacts int;
  actual_contacts   int;
  null_loc          int;
  hatch_people      int;
  hatch_expected    int;
  expected_optouts  int;
  actual_optouts    int;
begin
  -- Expected values are read straight off the live tables. This block runs
  -- BEFORE step 4 flips email_status, so the pre-migration truth is still
  -- there to be read — no snapshot, and no dependency on temp-table session
  -- semantics inside apply_migration.
  select count(*) into expected_contacts
    from contacts where location_id is not null;

  select count(*) into expected_optouts
    from contacts c
    left join contact_preferences p on p.contact_id = c.id
   where c.location_id is not null
     and (coalesce(p.email_marketing, true) = false or c.email_status = 'unsubscribed');

  select count(*) into hatch_expected
    from contact_tags
   where tag='hatch-founding-member' and removed_at is null and location_id is not null;

  select count(distinct contact_id) into actual_contacts from contact_location_preferences;
  select count(*) into null_loc from contacts where location_id is null;

  select count(*) into actual_optouts
    from contact_location_preferences
   where source = 'migration' and email_marketing = false;

  select count(distinct clp.contact_id) into hatch_people
    from contact_location_preferences clp
    join contact_tags ct
      on ct.contact_id = clp.contact_id
     and ct.location_id = clp.location_id
     and ct.tag = 'hatch-founding-member'
     and ct.removed_at is null;

  if actual_contacts <> expected_contacts then
    raise exception
      'LOCCOMMS.1 backfill parity FAILED: % contacts have a location but only % are in contact_location_preferences',
      expected_contacts, actual_contacts;
  end if;

  -- THE important one. Every person opted out of email before this migration
  -- must still be opted out after it. Under-counting here means people who
  -- unsubscribed start receiving mail again at the PR 3 cutover.
  if actual_optouts <> expected_optouts then
    raise exception
      'LOCCOMMS.1 consent preservation FAILED: % contacts were opted out of email, but only % migration rows have email_marketing=false',
      expected_optouts, actual_optouts;
  end if;

  if hatch_people <> hatch_expected then
    raise exception
      'LOCCOMMS.1 Hatch seed FAILED: % active Hatch tags but only % have a preference row',
      hatch_expected, hatch_people;
  end if;

  raise notice 'LOCCOMMS.1 backfill OK — % contacts, % email opt-outs preserved, % Hatch list members, % null-location contacts skipped (already unreachable by every campaign)',
    actual_contacts, actual_optouts, hatch_people, null_loc;
end $$;

-- 4. Retire the 'unsubscribed' value. email_status now carries reputation only
--    (active | bounced | complained). bounced/complained are untouched — they
--    are address-level facts and must stay global.
update contacts set email_status = 'active' where email_status = 'unsubscribed';

-- 5. The flip landed. Separate block because it can only run after step 4.
do $$
begin
  if exists (select 1 from contacts where email_status = 'unsubscribed') then
    raise exception 'LOCCOMMS.1 FAILED: contacts.email_status still contains ''unsubscribed''';
  end if;
end $$;
