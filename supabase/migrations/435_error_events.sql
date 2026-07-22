-- 435 — error_events: capture unhandled server errors for correlation + alerting
--
-- OBSERVABILITY (audit OBS-2/3/4). src/instrumentation.js onRequestError writes
-- a row here for every UNHANDLED server error — the 500s that bubble past Next
-- (RSC / route-handler / server-action throws) and never reach an explicit
-- logError. Sentinel already polls DB tables (cron_heartbeats / tenant_heartbeats)
-- for signals, so this table — NOT a log drain or a new vendor — is how unhandled
-- errors become alertable. vercel_id ties a row to the x-vercel-id the browser
-- saw on the failing response (Vercel sets it automatically), so a user report
-- can be joined to the exact server error.
--
-- Service-only: writes are service-role (RLS-bypassing); RLS is enabled with NO
-- policy so browser/anon roles are deny-all (same pattern as the webhook queues —
-- the advisor lists this as an INFO deny-all, which is intended, not a gap).

create table if not exists public.error_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  vercel_id   text,        -- x-vercel-id, for browser <-> server correlation
  runtime     text,        -- 'nodejs' | 'edge' (process.env.NEXT_RUNTIME)
  route_path  text,        -- Next context.routePath
  route_type  text,        -- 'render' | 'route' | 'action' | 'middleware'
  method      text,
  name        text,        -- error.name
  message     text,        -- error.message, truncated in app code (keep PII-light)
  digest      text         -- Next error digest — matches the client-visible digest
);

create index if not exists error_events_created_at_idx
  on public.error_events (created_at desc);

alter table public.error_events enable row level security;

comment on table public.error_events is
  'OBSERVABILITY (mig 435) — unhandled server errors captured by src/instrumentation.js onRequestError. Service-role writes only; RLS deny-all to browser roles by design. Sentinel polls this for alerting; vercel_id correlates to the x-vercel-id the browser saw on the failing response.';
