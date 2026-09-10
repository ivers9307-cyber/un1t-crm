-- 607 — WIDGET.1. Per-device credential for the iOS home-screen widgets.
--
-- A widget runs in a separate extension process and must NOT share the
-- Supabase session: both clients default to the same SecureStore key, so a
-- refresh from the extension rotates the refresh token out from under the
-- app and signs the staff member out. That failure already happened once
-- during the one-app merge. This table is the alternative — a credential
-- that is minted by the app, scoped to ONE location, revocable on its own,
-- and structurally incapable of touching the Supabase refresh lane.
--
-- Only the raw token's sha256 is stored. The plaintext is returned exactly
-- once, at mint time, and lives thereafter only in the device's App Group.

create table if not exists public.widget_tokens (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id)  on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  token_hash   text not null unique,
  device_label text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- The hot path is "hash to live row"; the unique index on token_hash serves
-- it. This one serves the revocation UI ("what does this person hold?").
create index if not exists widget_tokens_profile_live_idx
  on public.widget_tokens (profile_id)
  where revoked_at is null;

alter table public.widget_tokens enable row level security;

-- Deliberately NO policies: RLS with zero permissive policies denies
-- authenticated and anon outright, and service_role bypasses RLS, so every
-- legitimate read goes through an /api route. The REVOKE is the second half
-- of that fence — a table-level GRANT is what makes a column-level revoke a
-- no-op (mig 153/153b), so revoke the table, not columns.
revoke all on public.widget_tokens from anon, authenticated;

comment on table public.widget_tokens is
  'WIDGET.1 — per-device iOS widget credentials. Service-role access only.';
