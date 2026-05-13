-- ============================================================
-- 157: CAMPAIGN.12 — atomic campaign rollup RPCs
-- ============================================================
--
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────
-- Every campaign metric on /email/campaigns/[id] was showing 0
-- regardless of the underlying email_sends + campaign_recipients
-- engagement data. Two root causes in the Postmark webhook:
--
--   1. The Delivery handler does:
--        await db.rpc('increment_campaign_metric',
--                     { p_campaign_id, p_field: 'total_delivered' })
--          .catch(() => {
--            // Fallback if RPC doesn't exist
--            db.from('campaigns')
--              .update({ total_delivered: db.raw('total_delivered + 1') })
--              .eq('id', send.campaign_id)
--          })
--      …but `increment_campaign_metric` doesn't exist in the DB,
--      so the RPC errors and the catch fires. The fallback then
--      calls `db.raw('total_delivered + 1')` — but supabase-js has
--      no `db.raw`, that's a knex/postgres-js idiom — so the
--      whole expression throws inside the .catch and the metric
--      never increments. This mig creates the RPC the handler
--      already expects.
--
--   2. The Open / Click / Bounce / SpamComplaint handlers use
--      the pattern:
--        await db.from('campaigns')
--          .select('total_opened').eq('id', X).single()
--          .then(({ data }) => {
--            if (data) {
--              db.from('campaigns')              // <-- not awaited
--                .update({ total_opened: data.total_opened + 1 })
--                .eq('id', X)
--            }
--          })
--      The OUTER `.select().single()` is awaited (so we read the
--      current value), but the INNER `.update().eq()` is never
--      awaited and is fire-and-forget. supabase-js's filter
--      builder only sends a request when its thenable is consumed,
--      so the update never goes out. CAMPAIGN.12's code fix
--      replaces all four with a single `await db.rpc('increment_
--      campaign_metric', { p_campaign_id, p_field: <stat> })`
--      call that uses the function created here.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
--   1. increment_campaign_metric(p_campaign_id, p_field) — atomic
--      UPDATE col = COALESCE(col, 0) + 1 for the named stat. The
--      stat name is whitelisted to the seven counter columns;
--      anything else raises. The function is SECURITY DEFINER so
--      it works under the row's normal RLS too.
--
--   2. recalculate_campaign_stats(p_campaign_id) — recomputes
--      every counter from email_sends + campaign_recipients in
--      one atomic UPDATE. Source of truth for both the recovery
--      paths (sendCampaign final write, the resend-missing
--      endpoint) and for an operator-triggered "my stats look
--      wrong" repair. Idempotent — running it twice gives the
--      same result, and it doesn't fight the incremental webhook
--      updates because it just SETs absolute values.

CREATE OR REPLACE FUNCTION public.increment_campaign_metric(
  p_campaign_id UUID,
  p_field       TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Whitelist: only existing counter columns can be incremented.
  -- This guards against EXECUTE-time SQL injection via p_field
  -- (the format() below interpolates it directly).
  IF p_field NOT IN (
    'total_sent',
    'total_delivered',
    'total_opened',
    'total_clicked',
    'total_bounced',
    'total_complained',
    'total_unsubscribed'
  ) THEN
    RAISE EXCEPTION 'increment_campaign_metric: invalid p_field %', p_field;
  END IF;

  EXECUTE format(
    'UPDATE public.campaigns SET %1$I = COALESCE(%1$I, 0) + 1 WHERE id = $1',
    p_field
  ) USING p_campaign_id;
END
$$;

GRANT EXECUTE ON FUNCTION public.increment_campaign_metric(UUID, TEXT)
  TO authenticated, service_role;

-- ============================================================

CREATE OR REPLACE FUNCTION public.recalculate_campaign_stats(p_campaign_id UUID)
RETURNS public.campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result public.campaigns;
BEGIN
  -- Source of truth:
  --   * email_sends — one row per email actually handed to Postmark.
  --     Each row carries the latest status ('sent' / 'delivered' /
  --     'opened' / 'clicked' / 'bounced' / 'complained') AND the
  --     opened_at / clicked_at timestamps that webhooks populate
  --     on first event. This is the right source for the
  --     engagement counters.
  --   * campaign_recipients — one row per intended recipient.
  --     Used here only for total_recipients (it includes contacts
  --     that didn't get an email_sends row, e.g. queued but never
  --     dispatched).
  --
  -- We DON'T touch total_unsubscribed here — that one's set by
  -- explicit operator/recipient unsubscribe events through a
  -- separate path and isn't reconstructable from email_sends.

  UPDATE public.campaigns c
  SET
    total_recipients = (
      SELECT COUNT(*)
      FROM public.campaign_recipients
      WHERE campaign_id = p_campaign_id
    ),
    total_sent = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND status IN ('sent','delivered','opened','clicked')
    ),
    total_delivered = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND status IN ('delivered','opened','clicked')
    ),
    total_opened = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND opened_at IS NOT NULL
    ),
    total_clicked = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND clicked_at IS NOT NULL
    ),
    total_bounced = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND status = 'bounced'
    ),
    total_complained = (
      SELECT COUNT(*)
      FROM public.email_sends
      WHERE campaign_id = p_campaign_id
        AND status = 'complained'
    )
  WHERE c.id = p_campaign_id
  RETURNING c.* INTO result;

  RETURN result;
END
$$;

GRANT EXECUTE ON FUNCTION public.recalculate_campaign_stats(UUID)
  TO authenticated, service_role;
