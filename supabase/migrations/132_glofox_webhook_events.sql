-- ============================================================
-- 132: glofox_webhook_events — inbound Glofox webhook audit +
-- idempotency table (GLOFOX1).
--
-- Glofox sends webhooks at-least-once with up to 3 retries on a
-- 5-second response timeout. The receiver MUST be idempotent:
-- the same logical event can land multiple times and we have to
-- no-op on duplicates. This table is the dedup boundary AND the
-- audit log — every received webhook gets a row, processed
-- exactly once.
--
-- Schema:
--   event_id      — Glofox's stable identifier for the event.
--                   Comes from the webhook payload. UNIQUE so
--                   the second delivery of the same event hits
--                   the dedupe path.
--   event_type    — e.g. 'booking.created', 'membership.cancelled'.
--                   Mirrors what Glofox sends; we map this →
--                   CRM tag(s) at apply time.
--   branch_id     — Glofox branch the event came from. Maps to
--                   our location via env / settings (single-
--                   location today, multi tomorrow).
--   entity_id     — The Glofox object the event refers to
--                   (booking_id, member_id, etc.). Useful for
--                   debugging + cross-referencing.
--   contact_email — Pulled from the payload at receive time so
--                   we can audit "which CRM contact did this
--                   event match" without re-parsing the payload.
--   payload       — Full request body. Kept for replay during
--                   dark-launch / debugging.
--   signature     — The signature header value (audit only —
--                   verification happens at receive, not at
--                   query time).
--   status        — received | applied | deduped | failed |
--                   unknown_event_type | contact_not_found
--   result        — JSONB blob: which contact_id matched, which
--                   tags applied, etc. Populated when status
--                   = 'applied'.
--   error_message — Populated when status = 'failed'.
--   received_at   — When we got the POST (server clock).
--   processed_at  — When we finished processing (success OR
--                   terminal failure).
--
-- No RLS — service-role only. Operators can browse via a future
-- /admin page if we surface this; today it's debug + replay.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.glofox_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Glofox event id from the payload. NULL only when the
  -- payload didn't contain one (we still record the event for
  -- debugging — dedupe just skips it).
  event_id        TEXT UNIQUE,
  event_type      TEXT,
  branch_id       TEXT,
  entity_id       TEXT,
  contact_email   TEXT,
  payload         JSONB NOT NULL,
  signature       TEXT,
  status          TEXT NOT NULL DEFAULT 'received',
  result          JSONB,
  error_message   TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

-- Time-range scans for the audit UI ("show me the last 24h of
-- Glofox webhooks") — sort + filter by received_at, status, type.
CREATE INDEX IF NOT EXISTS glofox_webhook_events_received_at_idx
  ON public.glofox_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS glofox_webhook_events_status_idx
  ON public.glofox_webhook_events(status);
CREATE INDEX IF NOT EXISTS glofox_webhook_events_event_type_idx
  ON public.glofox_webhook_events(event_type);

-- Service-role only. There's no operator-facing API for this
-- table yet. Adding RLS later (with a master-only read policy)
-- is the natural next step when we surface a "Glofox events"
-- audit page.
ALTER TABLE public.glofox_webhook_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.glofox_webhook_events IS
  'Audit log + idempotency boundary for inbound Glofox webhooks. event_id UNIQUE prevents double-processing of retries. status tracks the receiver lifecycle. Mig 132 (GLOFOX1).';

COMMIT;
