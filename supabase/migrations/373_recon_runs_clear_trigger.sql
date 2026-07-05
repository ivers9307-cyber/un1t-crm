-- RCOV — allow 'clear' as a recon_runs trigger so the operator's
-- "Clear board" action (delete all open lines) is audited distinctly
-- in the Runs & health tab, separate from cron/manual pulls.
-- Widening a CHECK constraint is forward-safe (no existing row can
-- violate the larger allowed set).
alter table recon_runs drop constraint recon_runs_trigger_check;
alter table recon_runs add constraint recon_runs_trigger_check
  check (trigger = any (array['cron'::text, 'manual'::text, 'report'::text, 'clear'::text]));
