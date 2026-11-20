-- 863 — RETIRE.1: the weekly churn-radar-digest job is retired, and with it
-- its heartbeat row.
--
-- OWNERDAILY.1 (19 Nov 2026) folded the Monday radar digest into the daily
-- owner briefing, and since then the digest route acted for nobody. Its route,
-- its library and its vercel.json schedule are deleted in the same PR, so a
-- row left behind would go stale and page.
--
-- Apply AFTER the code deploys: until then the old job still runs hourly and
-- stamps this row.
--
-- locations.churn_digest_recipients stays: the daily owner briefing reads it,
-- and /api/churn-radar/digest-settings still edits it.

BEGIN;

DELETE FROM public.cron_heartbeats WHERE name = 'churn-radar-digest';

COMMIT;
