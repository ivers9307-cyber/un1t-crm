-- 802 — MCP.1: the heartbeat row for the staff MCP call-log purge cron.
--
-- APPLY RIGHT AFTER the code that ships /api/cron/purge-mcp-tool-calls
-- DEPLOYS (rollout step 3), not before: a row seeded early goes stale after
-- interval + grace if the deploy is slower, and pages for a cron that does not
-- exist yet. Mig 801 created public.mcp_tool_calls and deliberately left this
-- row out for that reason.
--
-- THE HEARTBEAT
-- ─────────────
-- CLAUDE.md: route + vercel.json entry + stampHeartbeat() + THIS ROW, together.
-- Daily at 04:35 UTC (vercel.json). expected_interval 86400s, grace 43200s:
-- one missed day plus half a day before it pages. Born healthy (last_ok_at =
-- now()) so it cannot page before the first real tick — the mig 561/563
-- lesson, handled the way mig 587 handled purge-webhook-payloads.
--
-- Forward-only and idempotent: ON CONFLICT on the row. No DDL, so no advisor
-- run is needed. Applied by the orchestrator via Supabase MCP.

BEGIN;

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'purge-mcp-tool-calls',
  now(),
  86400,
  43200,
  'MCP.1 — daily 90-day retention purge of the staff MCP call log: public.mcp_tool_calls rows whose created_at is older than 90 days (mig 801). Pages with .range() (500 ids a page, at most 20 pages a run); stamps only on a clean run, idle runs included; a failed scan or delete answers 500 and does not stamp. last_outcome carries { cutoff, deleted }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

COMMIT;
