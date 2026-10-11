-- 720 — TZ.6 (SaaS timezone wave, D6 = B): the daily-slot claim table.
--
-- WHY. Thirteen crons fired ONCE a day at a fixed UTC hour (receipt-coverage-
-- weekly at 07:00 + 08:00 UTC on Fridays, to hit 08:00 Dublin) and acted for
-- every studio at that instant. They now run HOURLY and act for each location
-- when its daily slot is due (src/lib/cron-daily-slot.js): a Europe/Dublin
-- location keeps the cron's legacy instant exactly (no catch-up: a failed slot
-- is skipped and its heartbeat pages, as before), every other zone acts at the
-- target LOCAL hour (up to two hourly ticks late if a tick failed).
--
-- WHAT. cron_daily_slot_claims: one row per (cron, location, LOCAL day). The
-- gate inserts it (ON CONFLICT DO NOTHING) before the cron acts for that
-- location, so an hourly schedule can never act twice for one location on one
-- local day (a DST fall-back day repeats a local hour; Vercel can
-- double-invoke). scope = the location id, or 'none' for rows with no location
-- (they run in DEFAULT_TZ, Europe/Dublin).
--
-- NOT HERE (deliberately). No cron_heartbeats change: a converted cron stamps
-- only on a tick that took a slot, and the 'none' scope is due at the legacy
-- instant, so every row keeps its current daily/weekly clock. No seed: with no
-- Dublin catch-up there is nothing already sent that a later tick could repeat.
--
-- APPLY ANY TIME AFTER THE TZ.6 DEPLOY. Until it lands, the deployed gate finds
-- no table (42P01 / PGRST205): a Europe/Dublin location acts at its exact
-- pre-TZ.6 instant with no claim (the old behaviour; receipt-coverage-weekly
-- keeps its old recon_runs "already ran today" guard in that case) and any
-- other zone waits. Replay is a no-op.
--
-- Service role only: RLS on with no policy, nothing for anon/authenticated
-- (mig 677 default, stated explicitly); service_role gets exactly what the gate
-- uses (SELECT for the upsert's RETURNING, INSERT for the claim).
--
-- ROLLBACK (forward-only repo: a NEW migration). Put the vercel.json schedules
-- back first; the table can then stay (nothing else reads it) or be dropped.

create table if not exists public.cron_daily_slot_claims (
  cron_name   text        not null,
  scope       text        not null,
  slot_day    date        not null,
  location_id uuid        references public.locations(id) on delete cascade,
  zone        text        not null,
  claimed_at  timestamptz not null default now(),
  primary key (cron_name, scope, slot_day),
  check ((scope = 'none' and location_id is null) or (location_id is not null and scope = location_id::text))
);

comment on table public.cron_daily_slot_claims is
  'TZ.6 (mig 720): one row per (cron, location, local day) a converted daily cron acted for. Inserted by src/lib/cron-daily-slot.js before the cron acts; the primary key is the at-most-once guard for the hourly schedule. scope = location id, or ''none'' for rows with no location.';
comment on column public.cron_daily_slot_claims.slot_day is
  'The location''s LOCAL calendar day the slot belongs to (for a Europe/Dublin location on a legacy UTC hour this is also the UTC day).';

alter table public.cron_daily_slot_claims enable row level security;
revoke all on public.cron_daily_slot_claims from anon, authenticated;
grant select, insert on public.cron_daily_slot_claims to service_role;

-- Self-check (POST-state). Anything else aborts the whole file.
do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'cron_daily_slot_claims' and c.relrowsecurity) then
    raise exception 'mig 720: cron_daily_slot_claims is missing or has RLS off';
  end if;
  if not has_table_privilege('service_role', 'public.cron_daily_slot_claims', 'INSERT')
     or not has_table_privilege('service_role', 'public.cron_daily_slot_claims', 'SELECT') then
    raise exception 'mig 720: service_role cannot SELECT + INSERT cron_daily_slot_claims (the gate could claim nothing)';
  end if;
  if exists (select 1 from information_schema.table_privileges
              where table_schema = 'public' and table_name = 'cron_daily_slot_claims' and grantee in ('anon', 'authenticated')) then
    raise exception 'mig 720: a client role holds a privilege on cron_daily_slot_claims';
  end if;
end $$;
