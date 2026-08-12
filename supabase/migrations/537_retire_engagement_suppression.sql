-- 537 — NOENGSUP.1: retire engagement-based email suppression entirely.
--
-- THE DECISION (Richard, 2026-08-12)
-- ──────────────────────────────────
-- "I don't want any suppression of users from marketing, just because they
-- don't engage today doesn't mean they won't engage in 6 months when they want
-- to train."
--
-- That is a correct read of this business. EMAIL-HYGIENE.1 imported a rule from
-- general email marketing — suppress anyone who has not opened in 90 days — into
-- a gym, where a lapsed member going quiet for two seasons and coming back in
-- January is the normal shape of the customer, not a dead address. The "win-back
-- the dormant" campaign is precisely the mail the rule was suppressing, and it
-- was suppressing it from precisely the people it was written for: of the 1,107
-- contacts the 12 Aug run stamped, 913 were `dormant`.
--
-- WHAT IS REMOVED
-- ───────────────
-- The ENGAGEMENT rule only. The nightly email-engagement-sweep cron is deleted
-- in the same PR, its heartbeat row is dropped below, and every stamp it ever
-- set is cleared.
--
-- WHAT IS DELIBERATELY KEPT
-- ─────────────────────────
-- Suppression for HARD BOUNCES and SPAM COMPLAINTS stays, and so does the
-- repeat-bounce sweep. Those are not judgements about interest — they are dead
-- or hostile mailboxes, and continuing to send to them is what gets a sending
-- domain throttled or blocked, which would cost delivery to the people who DO
-- open. Not opening is a preference; not existing is a fact. Only the first is
-- being un-learned here.
--
-- So contacts.email_suppressed_at SURVIVES and every send path keeps reading
-- it. After this migration the column means exactly one thing — "suppressed for
-- repeat bounces" (mig 515) — where it used to mean two, which is why the
-- column comment is rewritten and the audience-count label in the UI changes
-- from "inactive 90+ days" to naming bounces.
--
-- SCOPE AT WRITING: 933 contacts carry the stamp. 21 have an OPEN repeat-bounce
-- escalation and keep it. The other 912 are released.
--
-- Idempotent. Forward-only. Safe to apply before the code deploys: the release
-- also sets email_hygiene_released_at (mig 535), which the sweep already honours
-- as permanent, so even if a 05:15 run happens between this migration and the
-- deploy it cannot re-stamp anybody.

-- ── 1. release every engagement-origin suppression ───────────────────────
-- Predicate, not an id list. "Has no OPEN suppress escalation" is the whole
-- definition of engagement-origin: the bounce sweep always writes an
-- email_bounce_escalations row, the engagement sweep never did. A RELEASED
-- escalation (released_at is not null) does not count — that contact was
-- already let back in by an operator, so any stamp they carry now came from
-- the engagement rule.
with released as (
  update contacts c
     set email_suppressed_at       = null,
         email_hygiene_released_at = coalesce(c.email_hygiene_released_at, now())
   where c.email_suppressed_at is not null
     and not exists (
       select 1 from email_bounce_escalations e
        where e.contact_id = c.id
          and e.decision   = 'suppress'
          and e.released_at is null
     )
  returning c.id, c.location_id
)
insert into email_hygiene_releases (contact_id, location_id, released_by, note)
select r.id, r.location_id, null,
       'Bulk release 2026-08-12 (NOENGSUP.1, mig 537): engagement-based '
       || 'suppression retired entirely by operator decision. A member who has '
       || 'not opened in 90 days is a member who may train again in six months, '
       || 'not a dead address. Bounce and complaint suppression is unaffected.'
  from released r;

-- ── 2. drop the cron's heartbeat row ─────────────────────────────────────
-- CLAUDE.md invariant: a cron with a cron_heartbeats row that never runs goes
-- "stale" and alerts forever. The route is deleted in this PR, so the row has
-- to go with it or it becomes a permanent false alarm — exactly the kind of
-- noise that trains people to ignore the monitor.
delete from cron_heartbeats where name = 'email-engagement-sweep';

-- ── 3. say what the column means now ─────────────────────────────────────
comment on column contacts.email_suppressed_at is
  'Marketing suppression stamp. NOENGSUP.1 (mig 537): the ENGAGEMENT rule that also wrote this (90-day non-openers, EMAIL-HYGIENE.1 mig 395) is RETIRED — non-engagement is never a reason to suppress, because a lapsed gym member who goes quiet for a season is exactly who a win-back email is for. This column now carries ONE meaning: suppressed for repeat bounces by the repeat-bounce-sweep, which always writes an email_bounce_escalations row (mig 515) and is reversible from the list-health page. NOT consent (that is contact_location_preferences) and NOT reputation (that is email_status). Marketing sends exclude a non-null value; administrative/transactional mail ignores it.';

comment on column contacts.email_hygiene_released_at is
  'HYGREL.1 (mig 535), now vestigial. It marked a contact the retired engagement sweep must never re-suppress; with that sweep deleted in mig 537 nothing reads it any more. Kept on disk per the deprecate-in-place convention — it is the record of which contacts were released by hand on 12 Aug and which by the bulk retirement.';

-- ── post-flight ──────────────────────────────────────────────────────────
do $$
declare
  released_count   int;
  still_suppressed int;
  orphan_stamps    int;
  heartbeat_left   int;
begin
  select count(*) into released_count
    from email_hygiene_releases where note like 'Bulk release 2026-08-12 (NOENGSUP.1%';

  select count(*) into still_suppressed from contacts where email_suppressed_at is not null;

  -- Nobody may still be suppressed without an OPEN bounce escalation to
  -- justify it. That is now the only legitimate reason for this stamp.
  select count(*) into orphan_stamps
    from contacts c
   where c.email_suppressed_at is not null
     and not exists (
       select 1 from email_bounce_escalations e
        where e.contact_id = c.id and e.decision = 'suppress' and e.released_at is null
     );
  if orphan_stamps > 0 then
    raise exception 'mig 537 FAILED: % contacts are still suppressed with no open bounce escalation', orphan_stamps;
  end if;

  select count(*) into heartbeat_left from cron_heartbeats where name = 'email-engagement-sweep';
  if heartbeat_left > 0 then
    raise exception 'mig 537 FAILED: the email-engagement-sweep heartbeat row survives and will alert as stale';
  end if;

  raise notice 'mig 537 — released %; % contacts remain suppressed, all of them open repeat-bounce escalations.',
    released_count, still_suppressed;
end $$;
