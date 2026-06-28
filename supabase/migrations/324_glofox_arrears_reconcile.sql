-- GLOFOX-RECONCILE.1 — reconcile stale PAST_DUE glofox_invoices against the
-- Glofox TransactionsList report (the source of truth). When a late-cancel /
-- no-show fee is forgiven / cancelled / written off in Glofox, no
-- INVOICE_UPDATED webhook flips our local copy, so the row stays PAST_DUE and
-- the churn radar shows a member owing money they don't. The reconcile cron
-- clears those rows; these columns record when + why so the heuristic clears
-- (especially "absent from the report + aged") are auditable and reversible.

ALTER TABLE public.glofox_invoices
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_reason text;

COMMENT ON COLUMN public.glofox_invoices.reconciled_at IS
  'GLOFOX-RECONCILE.1 — when the arrears-reconcile cron last cleared this row out of PAST_DUE (NULL = never reconciled).';
COMMENT ON COLUMN public.glofox_invoices.reconciled_reason IS
  'GLOFOX-RECONCILE.1 — why it was cleared: settled | forgiven | absent_aged. NULL for webhook-set statuses.';

-- Daily reconcile cron heartbeat. stampHeartbeat('glofox-arrears-reconcile').
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
SELECT 'glofox-arrears-reconcile', 86400, 7200, 'Vercel cron 0 4 * * * UTC'
WHERE NOT EXISTS (SELECT 1 FROM public.cron_heartbeats WHERE name = 'glofox-arrears-reconcile');
