-- STUDIO-PIN.1 — schema foundation for studio-device PIN auth.
--
-- See docs/STUDIO_DEVICES_DESIGN.md for the full design. The short
-- version: studio Macs and iPads can't use the same email + password
-- flow that personal devices use (they're shared, always-on, used by
-- multiple staff a day). Staff log in with a 4-digit PIN, the device
-- auto-locks after 5 min of idle, and PIN login is only accepted when
-- the request comes from a trusted IP at the device's location.
--
-- This migration is the data-plane foundation. Auth flow + APIs +
-- admin UI + client-side idle-timer ship in subsequent PRs (0.2, 0.3).

-- ---------------------------------------------------------------
-- 1. PIN + landing-screen preference on each staff profile.
-- ---------------------------------------------------------------
-- pin_hash is scrypt-hashed by src/lib/studio-pin.js. NULL means the
-- staffer hasn't set a PIN yet -> they can't use studio devices until
-- they do. UNIQUE enforces global uniqueness: the PIN alone identifies
-- the staffer at login (no who-are-you picker before PIN entry).
--
-- pin_failed_count + pin_locked_until are reserved for future use; the
-- active lockout gate under the current design is per-device, not
-- per-profile (see studio_devices below and the threat-model section
-- of the design doc).
--
-- home_screen_path is the URL the Mac shell / iPad loads after PIN
-- unlock. Editable on /account. The check constraint keeps this to
-- relative paths so a staffer can't accidentally (or maliciously)
-- redirect the shell to an external site.
alter table public.profiles
  add column if not exists pin_hash text unique,
  add column if not exists pin_set_at timestamptz,
  add column if not exists pin_failed_count int not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists home_screen_path text not null default '/dashboard';

alter table public.profiles
  drop constraint if exists profiles_home_screen_path_is_relative_path;
alter table public.profiles
  add constraint profiles_home_screen_path_is_relative_path
  check (home_screen_path ~ '^/[A-Za-z0-9/_\-]*$');

-- ---------------------------------------------------------------
-- 2. Trusted IPs per location.
-- ---------------------------------------------------------------
-- Each row is a CIDR (a /32 single host or a /24 subnet, whatever the
-- studio actually has). PIN-login requests are accepted only when the
-- source IP falls inside one of the location's CIDRs.
--
-- Managed by master at /admin/studio-devices in a later PR. Recovery
-- path when the studio's ISP renumbers: master logs in from off-site
-- with normal email + password and edits the row.
create table if not exists public.location_trusted_ips (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  ip_cidr inet not null,
  label text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create index if not exists location_trusted_ips_location_idx
  on public.location_trusted_ips (location_id);
create index if not exists location_trusted_ips_cidr_idx
  on public.location_trusted_ips using gist (ip_cidr inet_ops);

-- ---------------------------------------------------------------
-- 3. Paired studio devices.
-- ---------------------------------------------------------------
-- Pairing is initiated by a master from /admin/studio-devices. The
-- server generates a 256-bit random token, returns the cleartext
-- token to the device once (stored in Keychain on Mac / SecureStore
-- on iPad), and persists only the sha256 hash here. Every PIN-login
-- request sends the token; the server hash-compares it.
--
-- device_kind is constrained to ('mac' | 'ipad'). location_id scopes
-- the device to one studio: PIN-login auth checks the request IP
-- against location_trusted_ips for THIS device's location, not the
-- staffer's locations.
--
-- failed_count + locked_until back the per-device lockout. The
-- pin_login_attempts table (#4) is the source of truth for the
-- counter — we count wrong_pin rows in the last 15 minutes rather
-- than maintaining state in two places. The columns here are
-- reserved for future use (e.g. if we add manual "lock this device"
-- admin action) and are not consulted by v1.
create table if not exists public.studio_devices (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  device_token_hash text not null unique,
  device_kind text not null check (device_kind in ('mac', 'ipad')),
  label text,
  paired_at timestamptz not null default now(),
  paired_by uuid references public.profiles(id),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  failed_count int not null default 0,
  locked_until timestamptz
);

create index if not exists studio_devices_location_idx
  on public.studio_devices (location_id);
create index if not exists studio_devices_active_idx
  on public.studio_devices (revoked_at)
  where revoked_at is null;

-- ---------------------------------------------------------------
-- 4. PIN-login audit log.
-- ---------------------------------------------------------------
-- One row per attempt (success or failure). Drives both the per-device
-- lockout counter and the admin "recent activity" view at
-- /admin/studio-devices.
--
-- outcome values:
--   'success'         — PIN matched + session issued
--   'wrong_pin'       — no profile matched the entered PIN
--   'device_locked'   — device is in lockout cooldown
--   'untrusted_ip'    — request came from outside the location's CIDRs
--   'unknown_device'  — device_token_hash not found / not paired
--   'revoked_device'  — token matched a paired device with revoked_at set
--   'no_pin_set'      — PIN matched a profile that hasn't set a PIN
--                       (defence-in-depth; should be unreachable in
--                       practice because pin_hash NULL == no match)
--
-- source_ip is captured for forensics. matched_profile is populated on
-- success and on 'no_pin_set'; null otherwise (we don't tell the
-- attacker which staffer their guess pointed at).
create table if not exists public.pin_login_attempts (
  id bigserial primary key,
  device_id uuid references public.studio_devices(id) on delete set null,
  attempted_at timestamptz not null default now(),
  source_ip inet not null,
  outcome text not null check (outcome in (
    'success', 'wrong_pin', 'device_locked', 'untrusted_ip',
    'unknown_device', 'revoked_device', 'no_pin_set'
  )),
  matched_profile uuid references public.profiles(id) on delete set null,
  user_agent text
);

create index if not exists pin_login_attempts_device_time_idx
  on public.pin_login_attempts (device_id, attempted_at desc);
create index if not exists pin_login_attempts_profile_time_idx
  on public.pin_login_attempts (matched_profile, attempted_at desc)
  where matched_profile is not null;

-- ---------------------------------------------------------------
-- RLS — PIN tables are admin-managed; server-side helpers all use
-- the service-role client. Block any direct read from authenticated
-- users so a leaked anon-key or low-privilege session can't enumerate
-- trusted IPs / paired devices / attempt history.
-- ---------------------------------------------------------------
alter table public.location_trusted_ips enable row level security;
alter table public.studio_devices       enable row level security;
alter table public.pin_login_attempts   enable row level security;

-- No policies = nothing is permitted via the anon/authenticated key.
-- The service-role client bypasses RLS, so server-side code is
-- unaffected. (Same pattern we use for audit_events.)
