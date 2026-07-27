-- 449: REVIEW-LOGIN-HARDEN.1 — DB-backed per-IP rate limiter for the App
-- Store reviewer login route (champ-app PR #90).
--
-- /api/mobile/review-login is public and unauthenticated; the route now
-- calls review_login_rate_ok(ip) BEFORE the credential check and fails
-- closed (503 on RPC error, 429 on denial). Serverless instances don't
-- share memory, so the counter lives here. Attempts are stored raw (one
-- row per attempt) and pruned opportunistically after a day — the table
-- never grows beyond a day of attempts on one low-traffic route.
--
-- Service-role only end to end: the route calls the RPC with the service
-- client, nothing else reads or writes the table. RLS is enabled with NO
-- policies (deny-all for anon/authenticated; service role bypasses RLS) —
-- mirrors the service-role-only pattern of mig 446.

create table public.review_login_attempts (
  id            bigint generated always as identity primary key,
  ip            text not null,
  attempted_at  timestamptz not null default now()
);

create index review_login_attempts_ip_time_idx
  on public.review_login_attempts (ip, attempted_at);

comment on table public.review_login_attempts is
  'One row per POST /api/mobile/review-login attempt, keyed by first-hop x-forwarded-for IP. Written only by review_login_rate_ok(); pruned to a 1-day horizon on every call. Service-role only — RLS enabled with no policies. (REVIEW-LOGIN-HARDEN.1 mig 449)';

alter table public.review_login_attempts enable row level security;

-- Limiter: record the attempt, then allow while the IP has made <= 10
-- attempts in the trailing 15 minutes (the just-recorded attempt counts).
-- Generous for a human reviewer typing a code; useless for brute-forcing
-- an 8+ char code. SECURITY DEFINER + pinned search_path per Supabase
-- function lints; EXECUTE is revoked from anon/authenticated so only the
-- service role (route) can call it.
create or replace function public.review_login_rate_ok(p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  recent integer;
begin
  delete from public.review_login_attempts
    where attempted_at < now() - interval '1 day';

  insert into public.review_login_attempts (ip) values (p_ip);

  select count(*) into recent
    from public.review_login_attempts
    where ip = p_ip
      and attempted_at > now() - interval '15 minutes';

  return recent <= 10;
end;
$$;

comment on function public.review_login_rate_ok(text) is
  'Per-IP limiter for POST /api/mobile/review-login (champ-app): records the attempt and returns false once an IP exceeds 10 attempts in 15 minutes. Called with the service client only; EXECUTE revoked from anon/authenticated. (REVIEW-LOGIN-HARDEN.1 mig 449)';

revoke execute on function public.review_login_rate_ok(text) from public, anon, authenticated;
