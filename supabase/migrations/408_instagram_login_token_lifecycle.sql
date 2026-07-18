-- 408 — Instagram Login token lifecycle (IG-LOGIN).
-- Instagram Login API tokens are long-lived (~60 days) and refreshable,
-- never permanent — the never-expire system-user option does not exist
-- on this API flavor. The weekly instagram-token-refresh cron rolls
-- every active instagram connection's token; these columns record it.
alter table channel_connections
  add column if not exists token_expires_at timestamptz,
  add column if not exists token_refreshed_at timestamptz;

comment on column channel_connections.token_expires_at is
  'When the stored access token expires (refresh_access_token expires_in; IG-LOGIN, mig 408).';
comment on column channel_connections.token_refreshed_at is
  'Last successful roll by the instagram-token-refresh cron (IG-LOGIN, mig 408).';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
  ('instagram-token-refresh', 604800, 86400, 'IG-LOGIN — weekly Instagram Login token roll (60-day tokens). Vercel cron 0 5 * * 1')
ON CONFLICT (name) DO NOTHING;
