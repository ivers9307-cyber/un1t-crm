-- 748_wa_broadcast_signoff.sql
-- WAORGNUMBER.4 — blast sign-off at a studio new to a shared number
-- (docs/superpowers/specs/2026-10-17-wa-org-shared-numbers-design.md, R7).
--
--   * whatsapp_broadcasts.signed_off_by (uuid, NULL, -> profiles.id): the
--     organisation admin (or master) who signed the broadcast off, by sending,
--     scheduling or starting it, or by pressing "Sign off" on a draft
--     (POST /api/whatsapp/broadcasts/[id]/sign-off).
--   * whatsapp_broadcasts.signed_off_at (timestamptz, NULL): when.
--
-- While a studio's locations.settings.whatsapp_blast_signoff_until is in the
-- future, sendBroadcast / sendDripChunk send a broadcast there only when
-- signed_off_by is set (src/lib/whatsapp-blast-signoff.js). Outside that window
-- nothing reads the columns. Existing rows stay NULL (no backfill): Hatch has
-- no broadcasts today, and Stillorgan has no window.
--
-- profiles rows are never deleted (tombstone_staff_profile, mig 622), so the
-- FK's default NO ACTION never blocks anything real.
--
-- GRANT DECISION (CLAUDE.md, new column): whatsapp_broadcasts is read-only for
-- client sessions since mig 661, and authenticated holds TABLE-level SELECT on
-- it (no column grants; anon nothing since mig 673), so both columns are
-- readable by a signed-in session with no column grant, exactly like every
-- other column of the row (the web editor's realtime reads it). Neither is a
-- secret. authenticated keeps NO write privilege; this file touches no grant
-- and no policy. Every writer is service_role.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS signed_off_by uuid NULL REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS signed_off_at timestamptz NULL;

COMMENT ON COLUMN public.whatsapp_broadcasts.signed_off_by IS
  'Organisation admin (or master) who signed the broadcast off (WAORGNUMBER R7). Needed to send while the studio''s whatsapp_blast_signoff_until is in the future.';
COMMENT ON COLUMN public.whatsapp_broadcasts.signed_off_at IS
  'When signed_off_by signed the broadcast off (WAORGNUMBER R7).';

-- Self-check against the catalog, never the text above.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.whatsapp_broadcasts'::regclass AND NOT a.attisdropped
         AND ((a.attname = 'signed_off_by' AND a.atttypid = 'uuid'::regtype)
           OR (a.attname = 'signed_off_at' AND a.atttypid = 'timestamptz'::regtype))
         AND NOT a.attnotnull) <> 2 THEN
    RAISE EXCEPTION 'mig 748: whatsapp_broadcasts.signed_off_by / signed_off_at are not the nullable uuid / timestamptz columns';
  END IF;
  IF has_table_privilege('authenticated', 'public.whatsapp_broadcasts', 'SELECT')
     AND NOT has_column_privilege('authenticated', 'public.whatsapp_broadcasts', 'signed_off_by', 'SELECT') THEN
    RAISE EXCEPTION 'mig 748: authenticated holds table SELECT on whatsapp_broadcasts but not the new column';
  END IF;
  IF has_table_privilege('authenticated', 'public.whatsapp_broadcasts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.whatsapp_broadcasts', 'UPDATE') THEN
    RAISE EXCEPTION 'mig 748: authenticated holds a write privilege on whatsapp_broadcasts (closed since mig 661)';
  END IF;
END $$;

COMMIT;
