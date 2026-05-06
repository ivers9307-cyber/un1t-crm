-- Fix infinite recursion on profiles RLS.
--
-- The "Admins can view all profiles" policy on public.profiles did:
--
--   EXISTS (SELECT 1 FROM profiles p
--           WHERE p.id = auth.uid()
--             AND p.role IN ('owner','manager','head_coach'))
--
-- That subquery is itself filtered by the policies on profiles, so
-- Postgres re-evaluated this same policy when reading p — infinite
-- recursion. Symptom: any query that JOINs to profiles (e.g. the
-- swap-requests join requester:profiles!requester_id(...)) blew up
-- with `42P17 infinite recursion detected in policy for relation
-- "profiles"`, which surfaced as the Today dashboard "Couldn't load"
-- error in the mobile app.
--
-- Fix: introduce a SECURITY DEFINER helper that does the role lookup
-- with RLS bypassed (same pattern as the existing
-- private.auth_is_master / auth_is_owner_or_manager helpers). The
-- policy then reduces to a single boolean, no recursion.
--
-- Applied via Supabase MCP on 2026-05-06.

create or replace function private.auth_can_view_all_profiles()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  -- master role wins regardless of location
  select coalesce(
    (
      select role in ('owner','manager','head_coach','master')
      from public.profiles
      where id = (select auth.uid())
    ),
    false
  )
$$;

-- Replace the recursive policy
drop policy if exists "Admins can view all profiles" on public.profiles;

create policy "Admins can view all profiles"
on public.profiles
for select
to authenticated
using (private.auth_can_view_all_profiles());
