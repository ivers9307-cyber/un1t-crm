-- STUDIO-AC-DEVICES.1 — unified AC device table covering both
-- vendors (Sensibo + LG ThinQ), with per-staff per-device allowlist.
--
-- Design rationale lives in docs/STUDIO_AC_THINQ_DESIGN.md.
-- TL;DR:
--   - Today: one AC per location, gated by the studio_management
--     permission. Credentials live as columns on `locations`.
--   - Bathroom case forces multi-device-per-location (LG M + F).
--   - Per-device permissions force a stable device id we can
--     reference from a profile_locations.ac_device_ids array.
--   - Going to Option A now (vs the parallel-table Option C from
--     the first draft) gives Sensibo + ThinQ a consistent
--     permission model and avoids a later refactor.
--
-- This migration is dead code from the user's POV — no routes or
-- UI reference these new tables yet. The existing AC turn-on path
-- still reads the legacy `locations.sensibo_*` columns. Phase 2
-- (STUDIO-AC-DEVICES.2) migrates the routes onto the new shape.

set check_function_bodies = off;

-- ============================================================
-- 1. ac_devices: one row per controllable AC unit
-- ============================================================
--
-- provider_device_id is the vendor's identifier — Sensibo pod id
-- or LG ThinQ device id. Vendor credentials live on the location
-- row (one Sensibo API key controls all Sensibo pods on the
-- account; one ThinQ PAT controls all ThinQ devices on the LG
-- account), so we don't duplicate them per device.
--
-- session_minutes is per-device because gym-floor units want a
-- long default (90 min, matching the existing Sensibo behaviour)
-- and bathroom units want a short one (30 min — in/out usage,
-- otherwise the AC runs all day for two minutes of human
-- presence).

create table if not exists public.ac_devices (
  id                   uuid primary key default gen_random_uuid(),
  location_id          uuid not null references public.locations(id) on delete cascade,
  label                text not null,
  provider             text not null
    check (provider in ('sensibo', 'thinq')),
  provider_device_id   text not null,

  default_mode         text default 'cool'
    check (default_mode is null or default_mode in ('cool', 'heat', 'auto', 'fan', 'dry')),
  default_temp_c       int  default 22
    check (default_temp_c is null or (default_temp_c >= 16 and default_temp_c <= 30)),
  default_fan          text default 'auto'
    check (default_fan is null or default_fan in ('auto', 'low', 'medium', 'high', 'quiet', 'strong')),
  session_minutes      int  default 30
    check (session_minutes is null or (session_minutes >= 5 and session_minutes <= 720)),
  enabled              bool not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- A device id pair is unique within a location. Re-adding the
  -- same vendor device under a new label requires deleting the
  -- existing row first (or just renaming it). This blocks
  -- accidental duplicates from the operator's discovery picker.
  unique (location_id, provider, provider_device_id)
);

create index if not exists ac_devices_location_enabled_idx
  on public.ac_devices (location_id)
  where enabled;

drop trigger if exists ac_devices_touch on public.ac_devices;
create trigger ac_devices_touch
  before update on public.ac_devices
  for each row execute function public.update_updated_at();

comment on table public.ac_devices is
  'STUDIO-AC-DEVICES.1 — one row per controllable AC unit at a '
  'location. Replaces the per-location sensibo_* columns on '
  '`locations` (which stay in place during the migration window '
  'and get dropped in a later cleanup PR).';

comment on column public.ac_devices.provider_device_id is
  'Vendor identifier. For sensibo this is the pod id returned by '
  'GET /users/me/pods. For thinq it is the deviceId returned by '
  'GET /devices on the LG ThinQ Connect API.';

-- ============================================================
-- 2. LG ThinQ credentials on `locations`
-- ============================================================
--
-- Mirrors the per-location pattern already used for sensibo_api_key
-- + Xero + UniFi. Plaintext is acceptable for the same reason as
-- the Sensibo key: control of AC units only, no PII / financial
-- consequences if leaked, table is masters-only-read at the route
-- level.

alter table public.locations
  add column if not exists thinq_pat          text,
  add column if not exists thinq_client_id    text,
  add column if not exists thinq_country_code text default 'IE';

comment on column public.locations.thinq_pat is
  'LG ThinQ Connect Personal Access Token. Issued at '
  'connect-pat.lgthinq.com by the LG account owner. Scoped to '
  'Air Conditioner status + control. Long-lived; revocable from '
  'the same portal.';

comment on column public.locations.thinq_client_id is
  'uuid4 the CRM generates when ThinQ is enabled for this '
  'location. Sent as the X-Client-ID header on every LG API call. '
  'LG asks each consumer to present a stable unique id; we pin '
  'one per location rather than generating per-request to avoid '
  'their rate-limit / spam protections.';

-- ============================================================
-- 3. Backfill ac_devices from existing Sensibo locations
-- ============================================================
--
-- For every location that has Sensibo configured today (both key
-- AND pod id set), create one ac_devices row labelled after the
-- location. Preserve the existing defaults — including the 90 min
-- session_minutes — so end users see no behavioural change for
-- the studio-floor AC after this migration runs.
--
-- The "(Sensibo)" suffix in the label lets masters tell the
-- existing device apart from any future LG additions in the
-- per-device picker. The label is editable in the UI.

insert into public.ac_devices
  (location_id, label, provider, provider_device_id,
   default_mode, default_temp_c, default_fan, session_minutes)
select id,
       coalesce(name, 'Studio AC') || ' (Sensibo)',
       'sensibo',
       sensibo_pod_id,
       coalesce(ac_default_mode, 'cool'),
       coalesce(ac_default_temp, 18),
       coalesce(ac_default_fan, 'high'),
       coalesce(ac_session_minutes, 90)
from public.locations
where sensibo_api_key is not null
  and sensibo_pod_id  is not null
on conflict (location_id, provider, provider_device_id) do nothing;

-- ============================================================
-- 4. ac_sessions.device_id — per-device attribution
-- ============================================================
--
-- Existing rows get NULL initially; we backfill below by joining
-- on (location_id) — at migration time there's at most one
-- ac_devices row per location (the freshly-inserted Sensibo
-- migration row), so the join is unambiguous.
--
-- sensibo_pod_id loses its NOT NULL because future ThinQ-sourced
-- session rows won't have one. We keep the column for historical
-- continuity with the legacy data; new code shouldn't read it.

alter table public.ac_sessions
  alter column sensibo_pod_id drop not null;

alter table public.ac_sessions
  add column if not exists device_id uuid references public.ac_devices(id) on delete set null;

update public.ac_sessions s
   set device_id = d.id
  from public.ac_devices d
 where d.location_id = s.location_id
   and d.provider = 'sensibo'
   and s.device_id is null;

create index if not exists ac_sessions_device_active_idx
  on public.ac_sessions (device_id, started_at desc)
  where status in ('on', 'extended') and device_id is not null;

comment on column public.ac_sessions.device_id is
  'STUDIO-AC-DEVICES.1 — links the session to its ac_devices row. '
  'NULL on legacy rows that pre-date the table (very early '
  'sessions before the backfill ran). New code should always '
  'populate this and prefer device-scoped queries over the '
  'legacy location_id+sensibo_pod_id pair.';

-- ============================================================
-- 5. profile_locations.ac_device_ids — per-staff per-device allowlist
-- ============================================================
--
-- Mirrors the two-tier semantics already in use for
-- unifi_door_ids (mig 182):
--
--   - staff / head_coach / contractor → '{}'
--       Strict opt-in. Master must tick each device they should
--       control in the staff edit screen. This is the case Richard
--       asked for — granular per-account control over which AC
--       units a user can operate.
--
--   - manager / owner / master → NULL
--       Legacy fallback: when the column is NULL, the dispatcher
--       treats it as "all devices at this location" so seasoned
--       roles keep their existing AC access on deploy day. Masters
--       can tighten the manager/owner case later by populating
--       the array explicitly.
--
-- The dispatcher (src/lib/ac-devices.js, phase 1) reads this
-- column. Phase 3's StaffForm UI gains a multi-select that
-- writes it.

alter table public.profile_locations
  add column if not exists ac_device_ids uuid[];

comment on column public.profile_locations.ac_device_ids is
  'STUDIO-AC-DEVICES.1 — allowlist of ac_devices.id values this '
  'user can control at this location. NULL = legacy fallback '
  '(dispatcher allows every device at the location). '
  'Empty array = no devices. Populated = exactly those devices. '
  'Mirrors unifi_door_ids semantics; the dispatcher checks this '
  'before every turn-on / turn-off call.';

-- ----------------------------------------------------------------
-- Two-tier backfill of ac_device_ids
-- ----------------------------------------------------------------
-- Strict-empty for restricted roles. Setting '{}' (not NULL)
-- triggers the strict-filter path in the dispatcher. Masters
-- must then tick devices in the staff edit screen for these
-- users to see anything.

update public.profile_locations pl
   set ac_device_ids = '{}'
  from public.profiles p
 where pl.profile_id = p.id
   and pl.ac_device_ids is null
   and coalesce(pl.role, p.role) in ('staff', 'head_coach', 'contractor');

-- manager / owner / master rows keep ac_device_ids = NULL on
-- purpose. The dispatcher (phase 1) treats NULL as unrestricted.
-- Explicit no-op for clarity.

-- ----------------------------------------------------------------
-- GIN index for the dispatcher's containment query
-- ----------------------------------------------------------------
-- Dispatcher does `pl.ac_device_ids @> ARRAY[device_id]` — a
-- containment test, which GIN serves directly.

create index if not exists profile_locations_ac_device_ids_idx
  on public.profile_locations using gin (ac_device_ids);
