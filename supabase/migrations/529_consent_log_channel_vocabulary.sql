-- 529 — K4: constrain consent_log.channel to its closed vocabulary.
--
-- ⚠️ NOT APPLIED. Written and reviewed only — apply via Supabase MCP against
--    project iyvtbjjxdggiadzwwvdj, then run get_advisors (security).
--
-- THE GAP
-- Mig 516 gave `consent_log.action` a CHECK constraint. `channel` — the other
-- half of what a consent row means — got nothing, so it is unconstrained free
-- text on the GDPR evidence trail. A writer that spells a channel wrong
-- ('email-marketing', 'emailMarketing', 'email') inserts happily, and the row
-- then belongs to no channel any reader filters on. It is the same silent
-- under-count that mig 516 existed to remove: nothing errors, the report is
-- just quietly wrong in the direction of "we kept marketing to someone who
-- told us to stop".
--
-- WHY A CHECK IS RIGHT HERE AND WRONG FOR `source`
-- `source` names the SURFACE a consent decision came from, and surfaces get
-- added — a new public form, a new import path. It legitimately grows, which
-- is why BACKLOG-5 gave it a registry plus a source scan (src/lib/
-- consent-sources.js) instead of a constraint. `channel` is not like that. It
-- is the cross product of the three channels we can message on and the two
-- consent families, and both halves are fixed by the schema: the six values
-- are exactly the six boolean columns on contact_preferences /
-- contact_location_preferences. A seventh channel cannot appear without a
-- migration adding the column it would correspond to, at which point widening
-- this CHECK is part of that work.
--
--     email_marketing        sms_marketing        whatsapp_marketing
--     email_administrative   sms_administrative   whatsapp_administrative
--
-- LIVE STATE, MEASURED 2026-08-11 BEFORE WRITING THIS (read-only):
--     email_marketing            5,800
--     whatsapp_marketing         1,924
--     sms_marketing              1,845
--     email_administrative       1,616
--     whatsapp_administrative    1,616
--     sms_administrative         1,616
-- Six distinct values, all expected, nothing else. The column is already
-- NOT NULL, so there are no NULLs to decide about. No backfill is needed and
-- this migration writes no data — it is DDL only.
--
-- ORDERING: safe to apply at any time; no code change depends on it and no
-- current writer can violate it (both writers, src/lib/marketing-consent.js
-- and src/lib/whatsapp-consent.js, derive the channel from the
-- contact_preferences column names).
--
-- After applying, run get_advisors (type=security).

-- 1. Refuse to proceed if the live table holds a channel outside the six.
--    The CHECK below would reject an unknown seventh value anyway, but a
--    failed constraint tells you nothing about WHAT the value was or how much
--    of it there is. Abort here instead, by name and by count, so the decision
--    ("is this a typo to fix or a real channel to add?") is made with the
--    numbers in front of you — not by reflexively widening the CHECK.
do $$
declare unexpected text;
begin
  select string_agg(format('%s (%s rows)', channel, n), ', ' order by channel)
    into unexpected
    from (
      select channel, count(*) as n
        from consent_log
       where channel not in (
               'email_marketing',    'email_administrative',
               'sms_marketing',      'sms_administrative',
               'whatsapp_marketing', 'whatsapp_administrative'
             )
       group by channel
    ) s;

  if unexpected is not null then
    raise exception
      'mig 529 ABORTED: consent_log.channel holds unexpected value(s): %. Report before constraining — a typo needs correcting, a genuinely new channel needs its contact_preferences column first.',
      unexpected;
  end if;
end $$;

-- 2. Close the vocabulary.
alter table consent_log
  add constraint consent_log_channel_vocabulary
  check (channel in (
    'email_marketing',    'email_administrative',
    'sms_marketing',      'sms_administrative',
    'whatsapp_marketing', 'whatsapp_administrative'
  ));

-- 3. Prove it landed and that every row is still attributable to a channel.
do $$
declare
  marketing int;
  admin     int;
  total     int;
begin
  select count(*) into marketing from consent_log where channel like '%\_marketing';
  select count(*) into admin     from consent_log where channel like '%\_administrative';
  select count(*) into total     from consent_log;

  if marketing + admin <> total then
    raise exception 'mig 529 FAILED: % marketing + % administrative <> % total rows', marketing, admin, total;
  end if;

  -- Eyeball against the pre-migration measurement: 9,569 marketing and
  -- 4,848 administrative. Small drift from live traffic between the audit
  -- and the apply is expected; a large one is not.
  raise notice 'mig 529 — consent_log.channel constrained: % marketing, % administrative (expected ~9569 / ~4848).',
    marketing, admin;
end $$;

comment on column consent_log.channel is
  'CANONICAL VOCABULARY (K4, mig 529; CHECK-enforced): {email|sms|whatsapp}_{marketing|administrative}. Closed by construction — the six values are exactly the six boolean columns on contact_preferences, so a seventh channel needs that column added first, in the same migration that widens this CHECK. Contrast consent_log.source, which legitimately grows and is governed by the registry in src/lib/consent-sources.js rather than a constraint.';
