-- 704 — AC-RETRY.1: per-row attempt counter + alert stamp for the ac-auto-off cron.
--
-- WHY. The gym-floor Sensibo pod intermittently fails to acknowledge an OFF
-- command (Sensibo's own history records them as status Failed /
-- failureReason Timeout; ONs never fail; the pod recovers within ~2 min).
-- The cron retried a failed row only after a one-hour backoff — a window
-- sized for "vendor down", not for a 2-minute blip — so the unit ran up to
-- an hour past its auto-off and every single miss raised an ops alert.
--
-- WHAT. Two additive, nullable-or-defaulted columns so the cron can
--   * retry a transient (timeout-class) failure at the NEXT 5-minute tick,
--     for up to FAST_RETRY_MAX_ATTEMPTS, then fall back to hourly, and
--   * alert only once a row has missed ALERT_AFTER_ATTEMPTS times, then at
--     most hourly — the counter and the stamp live on the row because
--     failure_reason is overwritten on every attempt and was the only record.
-- Both are written by the service-role cron only; no client grant is added.
-- Safe to apply before the code deploys (default 0 / NULL; old code ignores).

alter table public.ac_sessions
  add column if not exists auto_off_attempts smallint not null default 0,
  add column if not exists auto_off_alerted_at timestamptz;

comment on column public.ac_sessions.auto_off_attempts is
  'AC-RETRY.1: number of failed vendor turn-off attempts the ac-auto-off cron has made on this row. Not reset on success (history).';
comment on column public.ac_sessions.auto_off_alerted_at is
  'AC-RETRY.1: when the ac-auto-off cron last raised an ops alert for this row; gates the alert to at most one per ALERT_REPEAT_MS.';
