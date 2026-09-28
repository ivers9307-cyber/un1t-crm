-- 649 — WEBHOOKAUDIT.1: glofox_webhook_attempts, one PII-free row per
-- processed Glofox webhook delivery.
--
-- WHY
-- ───
-- glofox_webhook_events.event_id (mig 132) is Glofox's ENTITY id — the
-- booking / invoice / member / event id from Payload.id — not an id for the
-- emission (that is Metadata.trace_id). Every later event about the same
-- booking (BOOKING_CREATED, then BOOKING_UPDATED after the class, then
-- BOOKING_DELETED …) therefore lands on the SAME row, and the ingest upsert
-- plus markEvent overwrite its event_type, payload, status and result. Prod,
-- 30 days to 28 Sep 2026: 70% of rows (2,459 / 3,495) hold a later emission
-- than the one that created them (93% of BOOKING_UPDATED); only 2 were a late
-- re-process of the same emission; Glofox is never replayed by us. The row
-- shows the LAST event per entity only, which is why C13 could not attribute
-- a credit_member flip to a delivery.
--
-- WHAT
-- ────
-- An append-only side table. /api/webhooks/glofox inserts one row per
-- processed delivery (in parallel with the markEvent UPDATE it already does;
-- a failed insert is logged and changes nothing about the delivery):
--   trace_id / emitted_at   which emission (Metadata.trace_id, Timestamp)
--   delivered_at            when this delivery reached us
--   status / error_message  what markEvent wrote for it
--   digest                  an ALLOWLIST projection of the result — changed
--                           column NAMES and the from/to of five label/number
--                           columns; never the name/email/phone/dob/emergency
--                           contact that glofox_webhook_events.result carries
--                           (src/lib/glofox-webhook-attempts.js).
-- Retention: 90 days by processed_at, in /api/cron/purge-webhook-payloads
-- (mig 587's policy; every attempt row is finished when written).
--
-- The event row's meaning and the route's dedup behaviour are UNCHANGED here.
--
-- Service-role only (the route and the cron run as service_role): RLS on, the
-- mig 168 restrictive backstop, and every client privilege revoked. A
-- self-check at the end aborts the whole file if the result is not as
-- intended.
--
-- Forward-only and idempotent (IF NOT EXISTS, DROP POLICY IF EXISTS, a
-- guarded note append). Applied by the orchestrator via Supabase MCP BEFORE
-- the code merges. Rollback record: the WEBHOOKAUDIT.1 PR body.

BEGIN;

CREATE TABLE IF NOT EXISTS public.glofox_webhook_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_row_id   uuid NOT NULL REFERENCES public.glofox_webhook_events(id) ON DELETE CASCADE,
  location_id    uuid,
  trace_id       text,
  event_type     text,
  emitted_at     timestamptz,
  delivered_at   timestamptz NOT NULL,
  processed_at   timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL,
  error_message  text,
  digest         jsonb,
  CONSTRAINT glofox_webhook_attempts_digest_size
    CHECK (digest IS NULL OR octet_length(digest::text) <= 4000),
  CONSTRAINT glofox_webhook_attempts_error_size
    CHECK (error_message IS NULL OR char_length(error_message) <= 500)
);

-- Per-entity history ("every delivery for this booking, in order").
CREATE INDEX IF NOT EXISTS glofox_webhook_attempts_event_row_idx
  ON public.glofox_webhook_attempts (event_row_id, delivered_at);
-- The purge's ORDER BY processed_at LIMIT n, and time-window scans.
CREATE INDEX IF NOT EXISTS glofox_webhook_attempts_processed_at_idx
  ON public.glofox_webhook_attempts (processed_at);

ALTER TABLE public.glofox_webhook_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no_anon_or_authenticated_access" ON public.glofox_webhook_attempts;
CREATE POLICY "no_anon_or_authenticated_access" ON public.glofox_webhook_attempts
  AS RESTRICTIVE
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.glofox_webhook_attempts FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.glofox_webhook_attempts TO service_role;

COMMENT ON TABLE public.glofox_webhook_attempts IS
  'One PII-free row per processed Glofox webhook delivery (WEBHOOKAUDIT.1, mig 649). glofox_webhook_events keeps only the LATEST event per Glofox entity; this is the history. Written by /api/webhooks/glofox (src/lib/glofox-webhook-attempts.js); purged 90 days after processed_at by /api/cron/purge-webhook-payloads. Service-role only.';

COMMENT ON COLUMN public.glofox_webhook_events.event_id IS
  'Glofox ENTITY id (Payload.id: the booking/invoice/member/event), NOT an emission id — every later event about the same entity upserts this same row, so the row holds only the latest event. The per-emission id is payload->Metadata->>trace_id; per-delivery history is glofox_webhook_attempts (mig 649).';

-- The purge cron's heartbeat notes gain one sentence, once (the live notes
-- are not mig 587's text verbatim, so append rather than overwrite).
UPDATE public.cron_heartbeats
   SET notes = coalesce(notes, '') || ' WEBHOOKAUDIT.1 (mig 649): also glofox_webhook_attempts, every row whose processed_at is older than 90 days (an attempt row is finished when written).'
 WHERE name = 'purge-webhook-payloads'
   AND position('glofox_webhook_attempts' IN coalesce(notes, '')) = 0;

-- ── Self-check: read the catalog, abort the whole file if it is wrong ──
DO $$
DECLARE
  v_rls   boolean;
  v_fk    int;
  v_role  text;
  v_priv  text;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'glofox_webhook_attempts';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION '649 self-check: glofox_webhook_attempts is missing or has RLS off';
  END IF;

  SELECT count(*) INTO v_fk
    FROM pg_constraint
   WHERE conrelid = 'public.glofox_webhook_attempts'::regclass
     AND contype = 'f'
     AND confrelid = 'public.glofox_webhook_events'::regclass
     AND confdeltype = 'c';
  IF v_fk <> 1 THEN
    RAISE EXCEPTION '649 self-check: glofox_webhook_attempts needs exactly one ON DELETE CASCADE foreign key to glofox_webhook_events (found %)', v_fk;
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.glofox_webhook_attempts', v_priv) THEN
        RAISE EXCEPTION '649 self-check: % still holds % on glofox_webhook_attempts', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.glofox_webhook_attempts', 'INSERT') THEN
    RAISE EXCEPTION '649 self-check: service_role cannot INSERT into glofox_webhook_attempts';
  END IF;
END $$;

COMMIT;
