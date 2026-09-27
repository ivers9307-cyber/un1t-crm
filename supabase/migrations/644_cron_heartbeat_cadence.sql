-- 644 — CLASSSYNCHB.1: four cron_heartbeats rows back on their real cron
-- cadence.
--
--   APPLY ANY TIME. No code depends on it: all four rows already exist and are
--   stamped by deployed routes. Run the pre-check first (plan C2 Task 5): no
--   row may already be older than its NEW window, or it pages the moment this
--   lands (which would be true, but check it first).
--
-- WHY
-- ───
-- Each row was sized for a vercel.json schedule that later changed with no
-- heartbeat migration, so the health-check judged it on the wrong clock:
--
--   sync-class-occurrences  vercel.json */15 * * * *, row 86400 + 7200.
--     Mig 284 seeded 900 + 900; migs 285/286 widened it for an hourly then a
--     daily schedule; HR-WAVE1 P0-8 (2 Jul, commit 1345e7a3) restored */15
--     (classes cancelled after the 04:00 run kept firing the studio AC) and
--     left the row daily. A dead class sync went unnoticed for 26 hours
--     while the spine holds only 48 hours ahead. Mig 406's header lists this
--     row as 900 + 900: it read migration text, not the live row.
--   ad-insights-sync        vercel.json 0 */4 * * *, row 86400 + 21600.
--     Mig 360 seeded it for the first daily schedule; commit 10770775 (4 Jul)
--     moved the cron to every 4 hours. A dead sync went unnoticed for 30 h.
--   process-class-bookings  vercel.json */2 * * * *, row 60 + 120.
--   process-contact-imports vercel.json */2 * * * *, row 60 + 120.
--     Seeded for every minute (migs 335; 097 + 119); #894 (11 Jul, cost
--     cut) moved both to */2. Stale after 180 s against a 120 s cadence, so
--     ONE missed tick paged.
--
-- CADENCE — one rule: a single missed invocation never pages, two in a row do
-- ───────────────────────────────────────────────────────────────────────────
-- The gap between two stamps is the interval plus Vercel's invocation jitter
-- plus the run time (each route stamps at the END of its run), so the grace
-- clears one missed tick with room to spare (mig 119's jitter lesson; mig
-- 633's "never sit exactly on the boundary"):
--   sync-class-occurrences  900 + 1200   stale at 35 min (one miss ~1800 s +
--                           <=60 s maxDuration; two misses 2700 s)
--   ad-insights-sync        14400 + 18000 stale at 9 h (one miss 28800 s +
--                           <=300 s maxDuration; two misses 43200 s)
--   process-class-bookings  120 + 240    stale at 6 min: the */2 drain
--   process-contact-imports 120 + 240    convention (process-invoice-analysis, mig 377)
--
-- What each row's STALE means is unchanged: all four routes stamp at the END
-- of every run that gets there, including runs whose external call answered
-- with an error (sync-class-occurrences stamps on a tick where Glofox returned
-- an error; ad-insights-sync when an account's sync failed). So a Glofox that
-- ANSWERS with an error does not page from here. One that HANGS or
-- RATE-LIMITS does: glofoxFetch has no timeout and retries 429/5xx up to 3
-- times honouring Retry-After (<=30 s per wait), so a slow or throttling
-- Glofox can outlast the class sync's 60 s maxDuration, which kills the tick
-- before its stamp; a ~35-min outage like that pages. A cron that stopped
-- running, or crashes, pages too.
--
-- ON CONFLICT DO UPDATE OF THE SCHEDULE ONLY — NEVER last_ok_at
-- ─────────────────────────────────────────────────────────────
-- Unlike 601/623/633-642 this does NOT re-arm last_ok_at: these rows are
-- stamped by live code, and re-arming would hide one that is genuinely late
-- at apply time. last_outcome is left alone too. A missing row (a fresh
-- database) is inserted and takes last_ok_at's DEFAULT now(). Replay is a
-- no-op. Tune a grace in a new migration, not by hand.
--
-- The self-check at the bottom reads the POST-state: every row must END UP on
-- exactly this schedule, or the whole file aborts (nothing is applied).
--
-- tests/cron-heartbeat-schedule-pins.test.js fails the next PR that changes
-- one of these four vercel.json schedules without a new heartbeat migration.
--
-- ROLLBACK (forward-only repo; a NEW migration, never an edit here) — the
-- live values read on 27 Sep 2026:
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 86400, grace_seconds = 7200,  notes = NULL WHERE name = 'sync-class-occurrences';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 86400, grace_seconds = 21600, notes = 'Daily Meta ads insight sync' WHERE name = 'ad-insights-sync';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 60,    grace_seconds = 120,   notes = NULL WHERE name = 'process-class-bookings';
--   UPDATE public.cron_heartbeats SET expected_interval_seconds = 60,    grace_seconds = 120,   notes = 'Vercel cron * * * * * UTC [grace bumped 30→120s in mig 119 to absorb Vercel cron tick jitter]' WHERE name = 'process-contact-imports';

INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES
  (
    'sync-class-occurrences',
    900,
    1200,
    'CLASS-CLIMATE.1 (mig 284), re-sized by CLASSSYNCHB.1 (mig 644). Refreshes the class_occurrences spine (next 48 h) from Glofox for every Glofox-connected location. Vercel cron */15 * * * * (restored by HR-WAVE1 P0-8, 2 Jul). Stamped at the end of every tick that finishes, even when Glofox answered with an error (stats.errors + logWarn), so an erroring Glofox does not page; a Glofox that hangs or rate-limits past the 60 s maxDuration kills the tick before its stamp, so it does. 900 + 1200: one missed tick never pages, two in a row do (35 min).'
  ),
  (
    'ad-insights-sync',
    14400,
    18000,
    'ADS-REPORT.1 (mig 360), re-sized by CLASSSYNCHB.1 (mig 644). Meta ad insights sync (yesterday + today, Dublin). Vercel cron 0 */4 * * * since 4 Jul (mig 360 seeded this row for the first, daily schedule). Stamped at the end of every run, whether or not an account''s sync failed (ad_accounts.last_sync_error holds that). 14400 + 18000: one missed run never pages, two in a row do (9 h).'
  ),
  (
    'process-class-bookings',
    120,
    240,
    'START booking drain (mig 335), re-sized by CLASSSYNCHB.1 (mig 644). Drains class_booking_requests (the /start class-booking queue) into Glofox. Vercel cron */2 * * * * since #894 (11 Jul; seeded for every minute). Stamped on every run that did not throw. 120 + 240, the */2 drain convention (process-invoice-analysis, mig 377): one missed tick never pages; stale after 6 min.'
  ),
  (
    'process-contact-imports',
    120,
    240,
    'Contact import drain (mig 097, grace mig 119), re-sized by CLASSSYNCHB.1 (mig 644). Processes the oldest pending contact_imports job (the QStash worker races it by design). Vercel cron */2 * * * * since #894 (11 Jul; seeded for every minute). Stamped on every run except a job missing its payload (a 500). 120 + 240, the */2 drain convention (process-invoice-analysis, mig 377): one missed tick never pages; stale after 6 min.'
  )
ON CONFLICT (name) DO UPDATE
  SET expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check (POST-state): every row exists on exactly the intended schedule.
-- Anything else aborts the whole file, so nothing above is applied.
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('sync-class-occurrences', 900, 1200),
    ('ad-insights-sync', 14400, 18000),
    ('process-class-bookings', 120, 240),
    ('process-contact-imports', 120, 240)
  ) AS v(name, interval_s, grace_s) LOOP
    PERFORM 1 FROM public.cron_heartbeats h
     WHERE h.name = e.name
       AND h.expected_interval_seconds = e.interval_s
       AND h.grace_seconds = e.grace_s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 644: cron_heartbeats row % did not end up on expected_interval_seconds % + grace_seconds % (the VALUES above and this check disagree, or something outside the INSERT rewrote the row); nothing was applied', e.name, e.interval_s, e.grace_s;
    END IF;
  END LOOP;
END $$;
