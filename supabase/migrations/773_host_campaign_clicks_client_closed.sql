-- 773 — HOST-EMAILS.2: host_campaign_clicks is service role only.
--
-- The table was made by 593b (applied to prod as 594 on 7 Sep 2026), before
-- mig 677 closed the default privileges, so authenticated still holds
-- SELECT/INSERT/UPDATE/DELETE on it. RLS is on with no policy, so no client
-- row ever passed, but a grant nothing needs is still a grant. Its only
-- writers are the Postmark Click webhook and the host backfill, and its only
-- reader is GET /api/host/emails/[id]/recipients, all on the service role;
-- nothing in shared/, mobile/ or a browser file reads it.
--
-- It stores clicked links with the per-recipient unsubscribe token cut off
-- (clickUrlForStorage), and prod holds 0 rows today.

revoke all on public.host_campaign_clicks from anon, authenticated;

do $$
begin
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'host_campaign_clicks'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'mig 773: a client role still holds a privilege on host_campaign_clicks';
  end if;
end $$;
