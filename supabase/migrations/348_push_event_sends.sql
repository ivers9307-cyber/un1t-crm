-- 348: PUSH.2 — per-recipient dedup ledger for EVENT-triggered staff pushes.
--
-- Cron-driven reminders already dedup via push_reminder_sends (mig 169),
-- but event-triggered sends (swap lifecycle, time-off, expenses, invoices,
-- contracts, issues, new leads, inbound WhatsApp/Instagram) had no ledger:
-- a replayed Meta webhook or a double-invoked route sent the same push
-- twice. sendPushOnce() (src/lib/push-dedup.js) claims a row per
-- (event_key, recipient) BEFORE sending — the unique constraint makes the
-- second attempt a no-op — and releases the claim if the send pipeline
-- fails outright so a retry can still deliver (mirrors the nudge-claim
-- release in send-class-booking-reminders, PR #755).
--
-- event_key is a stable, replay-safe identifier per notification-worthy
-- event, e.g. 'contract_issued:<contract_id>', 'whatsapp_inbound:<wamid>'.
-- Rows older than 30 days are pruned by the sweep-stale-push-tokens daily
-- cron (event keys never repeat legitimately inside that horizon).

CREATE TABLE IF NOT EXISTS public.push_event_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_key, recipient_id)
);

-- Pruning cron scans by age.
CREATE INDEX IF NOT EXISTS idx_push_event_sends_sent_at
  ON public.push_event_sends (sent_at);

ALTER TABLE public.push_event_sends ENABLE ROW LEVEL SECURITY;

-- Service-role-only ledger (same posture as champ_push_tokens, mig 295):
-- no permissive policies at all, plus RESTRICTIVE belt-and-braces denies
-- for both client-facing roles. Routes and webhooks write via the
-- service-role client, which bypasses RLS.
CREATE POLICY "push_event_sends deny anon" ON public.push_event_sends
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "push_event_sends deny authenticated" ON public.push_event_sends
  AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);

COMMENT ON TABLE public.push_event_sends IS
  'PUSH.2 — claim-before-send dedup ledger for event-triggered staff pushes (sendPushOnce, src/lib/push-dedup.js). One row per (event_key, recipient_id); inserted with ON CONFLICT DO NOTHING semantics, released on total send failure. Service-role only. Pruned after 30 days by the sweep-stale-push-tokens cron.';
