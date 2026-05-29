-- INV-BULK.1 — background bulk-analysis queue for the supplier-invoice inbox.
-- Additive; existing single /extract + synchronous bulk-analyse unchanged.
-- Applied to production via Supabase MCP on 2026-05-29; recorded here.
ALTER TABLE public.invoices_queue
  ADD COLUMN IF NOT EXISTS analysis_queued_at  timestamptz,
  ADD COLUMN IF NOT EXISTS analysis_claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS invoices_queue_analysis_pending_idx
  ON public.invoices_queue (analysis_queued_at)
  WHERE analysis_queued_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_invoice_analysis_batch(p_limit int)
RETURNS SETOF public.invoices_queue
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.invoices_queue q
  SET analysis_claimed_at = now()
  WHERE q.id IN (
    SELECT id FROM public.invoices_queue
    WHERE status = 'quality_approved'
      AND analysis_queued_at IS NOT NULL
      AND (analysis_claimed_at IS NULL OR analysis_claimed_at < now() - interval '10 minutes')
    ORDER BY analysis_queued_at
    LIMIT LEAST(GREATEST(p_limit, 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING q.*;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_invoice_analysis_batch(int) FROM anon, authenticated;
