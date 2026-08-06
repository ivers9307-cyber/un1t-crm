-- 491 — contact_location_audience (LOCCOMMS.3). The read surface for sends.
--
-- A VIEW, not a join. buildAudienceQuery's CLASSIFY.1 note records that this
-- codebase already tried inner-joining contact_preferences and retreated to a
-- denormalised column because of "a long line of PostgREST embedded-resource
-- bugs in the count path" — head:true counts silently returning wrong numbers.
-- A wrong count in the send path is a campaign that under- or over-sends with
-- no error. Resolving ids and using .in('id', …) is closed too: that pattern is
-- bounded by MAX_EXCLUSION_IDS over URL-length limits, and Stillorgan alone has
-- ~8,500 members.
--
-- The view keeps sends on SINGLE-TABLE filtering, which is what CLASSIFY.1 was
-- protecting, while making per-location consent the authority.
--
-- COLUMN NAMING: contacts has 94 columns and both tables have email_marketing;
-- Postgres rejects duplicate names in a view. The location's flags therefore get
-- DISTINCT names so `c.*` can be used verbatim and stays future-proof — a column
-- added to contacts later appears here automatically instead of silently
-- vanishing from every audience.
--
--   location_id           = the contact's HOME location (from contacts, unchanged)
--   audience_location_id  = the LIST they are on   <- what sends filter
--   loc_*_marketing       = per-location consent   <- what sends gate on
--
-- email_administrative is deliberately NOT given a loc_ column: transactional
-- mail follows the transaction, not a marketing list, so it keeps its global
-- meaning via c.*.
--
-- INNER join: row absent = that location may never send, enforced structurally
-- rather than by remembering to write a filter.

create view contact_location_audience
with (security_invoker = on) as
select
  c.*,
  clp.location_id        as audience_location_id,
  clp.email_marketing    as loc_email_marketing,
  clp.sms_marketing      as loc_sms_marketing,
  clp.whatsapp_marketing as loc_whatsapp_marketing
from contacts c
join contact_location_preferences clp on clp.contact_id = c.id;

comment on view contact_location_audience is
  'LOCCOMMS.3 — send-path read surface. Filter audience_location_id + loc_*_marketing. A view rather than a PostgREST embed because embedded-resource filters silently break head:true counts (CLASSIFY.1).';

-- Pre-cutover assertion. PR 2's triggers keep this table in step, so a repair
-- pass is no longer needed — but prove it rather than assume it, because from
-- the moment the code ships this table decides who gets email.
do $$
declare missing int; drifted int;
begin
  select count(*) into missing from contacts c
   where c.location_id is not null
     and not exists (select 1 from contact_location_preferences clp
                      where clp.contact_id = c.id and clp.location_id = c.location_id);

  select count(*) into drifted from contacts c
    join contact_location_preferences clp
      on clp.contact_id = c.id and clp.location_id = c.location_id
   where c.email_marketing = false and clp.email_marketing = true;

  if missing > 0 then
    raise exception 'LOCCOMMS.3 FAILED: % contacts have no row at their own location — cutting over now would make them unreachable', missing;
  end if;
  if drifted > 0 then
    raise exception 'LOCCOMMS.3 FAILED: % contacts opted out globally still show opted in at their own location — cutting over now would mail people who unsubscribed', drifted;
  end if;
  raise notice 'LOCCOMMS.3 pre-cutover clean — 0 missing, 0 drifted';
end $$;
