-- 853 — REFUNDLEDGER.1: one row per refund, claimed before the provider is called.
--
-- Two staff refunding different amounts on the same order at the same moment
-- could both be paid out while the order recorded only one: the refund route
-- read the order, worked out the new total, called the provider, then
-- overwrote the total, with nothing between the read and the write. And each
-- refund overwrote the last one's reason, actor and provider id, so there was
-- no refund history at all.
--
-- Now:
--   * public.order_refunds holds one row per refund.
--   * claim_order_refund() locks the order row and records a 'requested'
--     refund BEFORE the provider is called. While an order has a refund that
--     is 'requested' or 'unknown', no other amount can be claimed on it, so
--     two refunds can never be in flight together. Asking again for the same
--     amount resumes that refund with the same idempotency key, so a retry
--     after a lost answer cannot pay out twice. A refund held longer than 20
--     hours is never resent (a provider's key may have expired): it answers
--     refund_needs_check, for staff to check the provider by hand.
--   * finish_order_refund() records the outcome: 'completed' adds to the
--     order's refunded total (never lowers it, so the Stripe refund webhook's
--     own write of the total still agrees), 'failed' releases the order,
--     'unknown' keeps it held for a retry.
--
-- Service role only: the refund route is the one caller.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'completed', 'failed', 'unknown')),
  idempotency_key text NOT NULL UNIQUE,
  provider text,
  provider_refund_id text,
  is_full boolean NOT NULL DEFAULT false,
  actor_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX order_refunds_order_idx ON public.order_refunds (order_id, created_at);
-- At most one refund in flight per order: the database's own guard behind the lock.
CREATE UNIQUE INDEX order_refunds_one_open_per_order
  ON public.order_refunds (order_id) WHERE status IN ('requested', 'unknown');

ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_refunds FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.order_refunds IS
  'REFUNDLEDGER.1 (mig 853): one row per refund of an order. Written only by claim_order_refund() and finish_order_refund(). Service role only.';

-- Claim a refund. p_amount_cents NULL = the whole remaining balance.
-- Answers jsonb: { ok, code?, refund_id, amount_cents, idempotency_key, is_full, resumed, message? }.
CREATE FUNCTION public.claim_order_refund(
  p_order_id uuid, p_amount_cents integer, p_reason text, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  o public.orders%ROWTYPE;
  open_row public.order_refunds%ROWTYPE;
  done_cents bigint;
  remaining bigint;
  amt integer;
  new_id uuid := gen_random_uuid();
  key text;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  SELECT * INTO open_row FROM public.order_refunds
    WHERE order_id = p_order_id AND status IN ('requested', 'unknown')
    LIMIT 1;
  IF FOUND THEN
    -- A refund held longer than the providers keep an idempotency key (Stripe
    -- 24 hours) is never sent again: the key may have expired, so a resend
    -- could pay out a second time. Staff check the provider and settle it.
    IF open_row.created_at < now() - interval '20 hours' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'refund_needs_check',
        'amount_cents', open_row.amount_cents, 'refund_id', open_row.id);
    END IF;
    IF p_amount_cents IS NULL OR p_amount_cents = open_row.amount_cents THEN
      RETURN jsonb_build_object('ok', true, 'resumed', true, 'refund_id', open_row.id,
        'amount_cents', open_row.amount_cents, 'idempotency_key', open_row.idempotency_key,
        'is_full', open_row.is_full);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'refund_in_progress',
      'amount_cents', open_row.amount_cents, 'refund_id', open_row.id);
  END IF;

  IF o.status <> 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_status', 'status', o.status);
  END IF;

  -- What has gone back: completed refunds, or the order's own total if a
  -- refund was made outside this ledger (the Stripe dashboard) and synced.
  SELECT COALESCE(sum(amount_cents), 0) INTO done_cents FROM public.order_refunds
    WHERE order_id = p_order_id AND status = 'completed';
  done_cents := GREATEST(done_cents, COALESCE(o.refunded_amount_cents, 0));
  remaining := o.amount_cents - done_cents;
  IF remaining <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_refunded');
  END IF;
  amt := COALESCE(p_amount_cents, remaining::integer);
  IF amt <= 0 OR amt > remaining THEN
    RETURN jsonb_build_object('ok', false, 'code', 'refund_exceeds_order', 'remaining_cents', remaining);
  END IF;

  key := 'refund:' || p_order_id || ':' || new_id;
  INSERT INTO public.order_refunds (id, order_id, location_id, amount_cents, currency, reason,
    idempotency_key, provider, is_full, actor_id)
  VALUES (new_id, p_order_id, o.location_id, amt, COALESCE(o.currency, 'EUR'), p_reason,
    key, o.payment_provider, (done_cents + amt) >= o.amount_cents, p_actor_id);

  RETURN jsonb_build_object('ok', true, 'resumed', false, 'refund_id', new_id,
    'amount_cents', amt, 'idempotency_key', key, 'is_full', (done_cents + amt) >= o.amount_cents);
END;
$$;

-- Record the provider's answer. p_status: 'completed' | 'failed' | 'unknown'.
-- On 'completed' the order's refunded total and status follow, and the refund's
-- reason, actor and provider id are merged into the order's metadata (merged,
-- never rebuilt from an older copy). Answers jsonb: { ok, refunded_total_cents, is_full }.
CREATE FUNCTION public.finish_order_refund(
  p_refund_id uuid, p_status text, p_provider_refund_id text, p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  r public.order_refunds%ROWTYPE;
  o public.orders%ROWTYPE;
  total bigint;
BEGIN
  IF p_status NOT IN ('completed', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'finish_order_refund: bad status %', p_status;
  END IF;
  SELECT * INTO r FROM public.order_refunds WHERE id = p_refund_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = r.order_id FOR UPDATE;

  IF r.status = 'completed' THEN
    -- Already recorded (a retry after the provider said yes twice).
    RETURN jsonb_build_object('ok', true, 'refunded_total_cents', COALESCE(o.refunded_amount_cents, 0),
      'is_full', o.status = 'refunded');
  END IF;

  UPDATE public.order_refunds
    SET status = p_status,
        provider_refund_id = COALESCE(p_provider_refund_id, provider_refund_id),
        error = p_error,
        finished_at = CASE WHEN p_status = 'unknown' THEN NULL ELSE now() END
    WHERE id = p_refund_id;

  IF p_status <> 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'refunded_total_cents', COALESCE(o.refunded_amount_cents, 0),
      'is_full', false);
  END IF;

  SELECT COALESCE(sum(amount_cents), 0) INTO total FROM public.order_refunds
    WHERE order_id = r.order_id AND status = 'completed';
  total := GREATEST(total, COALESCE(o.refunded_amount_cents, 0));

  UPDATE public.orders
    SET refunded_amount_cents = total,
        refunded_at = now(),
        status = CASE WHEN total >= amount_cents THEN 'refunded' ELSE status END,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'refund_reason', r.reason,
          'refund_actor_id', r.actor_id,
          'refund_provider', r.provider,
          'refund_provider_id', p_provider_refund_id,
          'refund_revolut_id', CASE WHEN r.provider = 'revolut' THEN p_provider_refund_id END),
        updated_at = now()
    WHERE id = r.order_id;

  RETURN jsonb_build_object('ok', true, 'refunded_total_cents', total, 'is_full', total >= o.amount_cents);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_order_refund(uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finish_order_refund(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_refund(uuid, integer, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_order_refund(uuid, text, text, text) TO service_role;

COMMIT;
