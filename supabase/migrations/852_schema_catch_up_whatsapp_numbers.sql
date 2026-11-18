-- 852_schema_catch_up_whatsapp_numbers.sql (SCHEMACATCHUP.1)
--
-- The whatsapp_numbers half of 851: seven columns, two checks and an index that
-- exist on the live database with no migration file creating them. Every
-- statement is a no-op there. A separate file because whatsapp_numbers is a
-- credential table, and its migrations are replayed on their own by
-- tests/migration-648-credential-column-grants.test.js.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── WhatsApp coexistence and embedded signup ────────────────────────────
-- column-grant: withheld whatsapp_numbers.is_on_biz_app
-- column-grant: withheld whatsapp_numbers.platform_type
-- column-grant: withheld whatsapp_numbers.history_sync_status
-- column-grant: withheld whatsapp_numbers.history_sync_started_at
-- column-grant: withheld whatsapp_numbers.history_sync_completed_at
-- column-grant: withheld whatsapp_numbers.history_sync_error
-- column-grant: withheld whatsapp_numbers.embedded_signup_session_id

ALTER TABLE public.whatsapp_numbers
  ADD COLUMN IF NOT EXISTS is_on_biz_app boolean,
  ADD COLUMN IF NOT EXISTS platform_type text
    CONSTRAINT whatsapp_numbers_platform_type_check
    CHECK (platform_type IS NULL OR platform_type = ANY (ARRAY['CLOUD_API'::text, 'ON_PREMISE'::text, 'NOT_APPLICABLE'::text])),
  ADD COLUMN IF NOT EXISTS history_sync_status text NOT NULL DEFAULT 'not_started'
    CONSTRAINT whatsapp_numbers_history_sync_status_check
    CHECK (history_sync_status = ANY (ARRAY['not_started'::text, 'pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text, 'skipped'::text])),
  ADD COLUMN IF NOT EXISTS history_sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS history_sync_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS history_sync_error text,
  ADD COLUMN IF NOT EXISTS embedded_signup_session_id text;

CREATE INDEX IF NOT EXISTS whatsapp_numbers_pending_history_idx
  ON public.whatsapp_numbers (history_sync_started_at DESC)
  WHERE history_sync_status = ANY (ARRAY['pending'::text, 'in_progress'::text]);

COMMIT;
