-- 861 — OWNERDAILY.1: the owner briefing is daily, so its heartbeat row is too.
--
-- Richard's decision (19 Nov 2026): one daily owner email (revenue, new leads,
-- members, churn and arrears) replaces the two Monday emails. morning-briefing
-- now acts every day at 06:00 studio time and stamps once a day; its row was
-- sized for a weekly job (604800 s), so a daily briefing that stopped would
-- have gone unnoticed for a week. churn-radar-digest still claims its Monday
-- slot and stamps, but sends nothing; its notes say so.
--
-- Apply AFTER the code deploys: a row tightened before the daily code runs
-- would go stale on the first Tuesday.

BEGIN;

UPDATE public.cron_heartbeats
SET expected_interval_seconds = 86400,
    grace_seconds = 7200,
    notes = 'OWNERDAILY.1 (mig 861): the owner''s daily briefing, 06:00 studio time every day (hourly schedule, one slot per local day). Revenue MTD, yesterday''s leads and trials, the members and churn/arrears strip, the triage list. 86400 + 7200: one missed day pages.'
WHERE name = 'morning-briefing';

UPDATE public.cron_heartbeats
SET notes = 'RADAR-DIGEST.1, silenced by OWNERDAILY.1 (mig 861): claims its Monday slot and stamps, sends no email; the daily briefing carries its figures. Retire with the job.'
WHERE name = 'churn-radar-digest';

COMMIT;
