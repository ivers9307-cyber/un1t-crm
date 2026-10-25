-- 718 — W1.E3: record that a tenant server's streams + webhooks were registered.
--
-- WHY. createTenantServer (src/lib/postmark-account.js) posted { Name, Color }
-- only: a bare Postmark server has just the `outbound` + `inbound` streams and
-- no webhooks. Every campaign send puts MessageStream 'broadcast' on the wire
-- (src/lib/postmark.js sendBatch), so a tenant campaign would be refused
-- (Postmark ErrorCode 1235), and with no webhooks the tenant's bounces, opens,
-- spam complaints and subscription changes never reached
-- /api/webhooks/postmark — list health, bounce escalation and stats read 0.
-- Review Blocker 8 / SAAS_READINESS_REVIEW_2026-10-09 :140.
--
-- WHAT. One nullable timestamp. provisionEmailDomain (and verifyEmailDomain)
-- create the broadcast stream and the six-trigger webhooks on outbound +
-- broadcast with the SERVER token, then stamp this column. NULL means "not
-- yet / failed last time": the next provision or verify call runs the two
-- idempotent helpers again (list first, create only what is missing).
-- Forward-only; replay-safe (IF NOT EXISTS).
--
-- Grants: tenant_email_domains is not a column-granted table (mig 427 RLS is
-- master-only SELECT; every reader is a service-role route that redacts
-- through tenantEmailStatePayload), so the new column needs no grant decision
-- and is never selected into a client payload as itself — the GET route
-- exposes it only as the boolean `webhooks_registered`.

alter table public.tenant_email_domains
  add column if not exists webhooks_registered_at timestamptz;

comment on column public.tenant_email_domains.webhooks_registered_at is
  'W1.E3 (mig 718) — set when the broadcast stream and the six-trigger webhooks on outbound+broadcast exist on the org''s Postmark server. NULL = provision again (idempotent).';
