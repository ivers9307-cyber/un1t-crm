-- 645 — DETAILBACKFILL.1: a real cursor for the Glofox detail backfill.
--
--   APPLY BEFORE THE DETAILBACKFILL.1 CODE DEPLOYS. The new code selects and
--   orders by this column; main's code never names it, so applying early is
--   inert. Applying late would fail every tick's candidate read (and, with
--   this PR, stop the heartbeat, which pages after 20 minutes).
--
-- WHY
-- ───
-- /api/cron/glofox-detail-backfill (*/10) picked "glofox_membership_plan IS
-- NULL OR glofox_synced_at older than 14 days", plan-NULL first, through one
-- select PostgREST caps at 1,000 rows. 2,926 contacts legitimately have no
-- plan (PAYG, ClassPass, trials), so they filled every page and were re-read
-- every ~30 minutes, forever: ~288k Glofox calls and ~143k contact UPDATEs a
-- day. Meanwhile 2,917 contacts WITH a plan had not been refreshed since
-- 3 Jul (measured 27 Sep 2026).
--
-- WHAT
-- ────
-- glofox_detail_due_at = when the backfill next wants this contact. The cron
-- writes it after EVERY attempt, whatever the answer
-- (src/lib/glofox-detail-backfill.js):
--   answered (synced, refused by Glofox, ambiguous, invalid) → +10.5..17.5 days
--   failed (non-2xx, network, write error)                    → +6 hours
-- NULL = never attempted = due now, so a new contact goes first.
--
-- It is deliberately NOT glofox_synced_at: five writers stamp that one (the
-- webhook, the nightly LIST sync which carries no detail, the attendance
-- refresh, glofox-push, this backfill), a refused or failed read never stamps
-- it, and the attendance refresh uses it as its own cursor.
--
-- Additive, nullable, no default: catalog-only, no table rewrite, no trigger
-- fires, updated_at untouched. No data is written. No index: the tick reads
-- one studio's ~6.5k-row cohort (contacts is ~8.8k rows, 13 MB).
-- Grants: contacts already grants table-level privileges; RLS scopes rows.
-- The column holds a timestamp only.

alter table public.contacts
  add column if not exists glofox_detail_due_at timestamptz;

comment on column public.contacts.glofox_detail_due_at is
  'DETAILBACKFILL.1 (mig 645): when /api/cron/glofox-detail-backfill next re-reads this contact''s single-member detail. Written by that cron after every attempt (answered: +10.5..17.5 days; failed: +6 hours). NULL = never attempted = due now. Not a freshness stamp; see glofox_synced_at.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contacts'
      and column_name = 'glofox_detail_due_at'
      and data_type = 'timestamp with time zone' and is_nullable = 'YES'
  ) then
    raise exception 'mig 645: contacts.glofox_detail_due_at missing or wrong type after ALTER';
  end if;
end $$;

-- HEARTBEAT (review of DETAILBACKFILL.1): the route now withholds its stamp
-- when a location run fails (the candidate read, or missing credentials). The
-- live row was 600 + 600, so ONE failed tick (gap ~1,200 s + run time) already
-- sat on the boundary and could page. 600 + 900: one missed tick never pages,
-- two in a row do (25 min), the CLASSSYNCHB.1 (mig 644) rule. Interval, grace
-- and notes only; last_ok_at is never re-armed. Rollback (a NEW migration):
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 600, grace_seconds = 600, notes = 'Glofox per-member membership-detail backfill. Vercel cron */10 * * * *' WHERE name = 'glofox-detail-backfill';
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values (
  'glofox-detail-backfill',
  600,
  900,
  'Glofox per-member membership-detail backfill, re-sized by DETAILBACKFILL.1 (mig 645). Vercel cron */10 * * * *. Stamped at the end of every run except one whose location run failed (candidate read or missing credentials); per-contact Glofox failures are counts, so an erroring Glofox does not page. 600 + 900: one missed tick never pages, two in a row do (25 min). last_outcome carries the run summary.'
)
on conflict (name) do update
  set expected_interval_seconds = excluded.expected_interval_seconds,
      grace_seconds = excluded.grace_seconds,
      notes = excluded.notes;

do $$
declare e record;
begin
  for e in select * from (values
    ('glofox-detail-backfill', 600, 900)
  ) as v(name, interval_s, grace_s) loop
    perform 1 from public.cron_heartbeats h
     where h.name = e.name and h.expected_interval_seconds = e.interval_s and h.grace_seconds = e.grace_s;
    if not found then
      raise exception 'mig 645: cron_heartbeats row % did not end up on % + %', e.name, e.interval_s, e.grace_s;
    end if;
  end loop;
end $$;
