-- 608 — SELECTCOLS.2: put two hand-created columns on the record.
--
-- contacts.source and whatsapp_messages.source exist on the live project
-- (verified via information_schema.columns on 2026-09-13) but no migration
-- ever added them — they pre-date the migration history. The code that
-- selects them (src/app/api/public/leads/route.js, src/lib/agent/followups.js)
-- was right; the repo simply could not prove it, so check:select-columns
-- carried them on a dated allowlist. This is a NO-OP in prod (IF NOT EXISTS)
-- whose only job is to make the migrations match the database. Definitions
-- copied from the live columns, defaults included.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual';

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api';
