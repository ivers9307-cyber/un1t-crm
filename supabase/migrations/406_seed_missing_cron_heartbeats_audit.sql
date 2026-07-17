-- 406_seed_missing_cron_heartbeats_audit.sql
-- CRON-HB-AUDIT.1 — seed the four scheduled crons missing from cron_heartbeats.
--
-- Why: Vercel runtime logs (2026-07-17) showed stampHeartbeat()'s
-- "stamp matched 0 rows — cron not seeded in cron_heartbeats" warning on
-- every tick of ac-external-rule, checklist-sweep and glofox-detail-backfill.
-- A full audit of vercel.json (55 cron entries, 54 unique paths) against
-- every cron_heartbeats seed in supabase/migrations/* found FOUR unseeded
-- crons — the three from the logs plus glofox-attendance-refresh, whose
-- single daily 04:00 tick kept its warning out of the sampled logs.
--
-- Consequence of a missing row: the stampHeartbeat() UPDATE matches
-- nothing, the cron never appears in the cron_health view, and
-- un1t-sentinel's stale-cron monitoring is blind to it — it can die
-- silently, the exact failure mode mig 053 exists to prevent.
--
-- Interval/grace values mirror the closest existing siblings:
--   */5   → 300 + 180    (ac-auto-off, mig 119)
--   */10  → 600 + 600    (one-missed-tick allowance, per the */15 rows)
--   */15  → 900 + 900    (agent-followups mig 262, sync-class-occurrences mig 284)
--   daily Glofox → 86400 + 7200  (glofox-sync mig 172, glofox-arrears-reconcile mig 324;
--                                 2h grace covers full-member-walk run length)
--
-- last_ok_at defaults to NOW() so cron_health reports healthy until the
-- first real tick stamps it (same rationale as the mig 053 seeds).

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES
  ('ac-external-rule',          300,   180,  'STUDIO-AC-EXTERNAL-RULE.1 — Sensibo external-start reconcile + auto-off enforce. Vercel cron */5 * * * *'),
  ('checklist-sweep',           900,   900,  'CHECKLIST.3 — overdue checklist sweep + compliance pushes. Vercel cron */15 * * * *'),
  ('glofox-detail-backfill',    600,   600,  'Glofox per-member membership-detail backfill. Vercel cron */10 * * * *'),
  ('glofox-attendance-refresh', 86400, 7200, 'CHURN-PREP.1/.2 — daily full member attendance + plan refresh. Vercel cron 0 4 * * * UTC')
ON CONFLICT (name) DO NOTHING;
