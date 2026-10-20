-- 759 — SECRETTAILS.2: drop shelly_connections.key_hint.
--
-- NOT APPLIED YET when this file was written. Proven ahead of apply by
-- tests/migration-658-659-shelly-key-hint.test.js (PGlite, real files).
--
-- key_hint held the last 4 characters of the Shelly Cloud auth key (mig 562).
-- Mig 658 made it nullable, SECRETTAILS.1b stopped every read and write of
-- it, and mig 659 (applied 29 Sep 2026) cleared it and pinned it NULL with
-- CHECK shelly_connections_key_hint_retired. The drop waited until 6 Oct 2026
-- (plan C57 D5), so no Vercel rollback target still selects or writes it.
--
-- No view, function, trigger, index, policy, grant or publication names the
-- column (verified for 659 on 29 Sep; nothing since adds one). This file:
--   1. drops the retire CHECK (DROP COLUMN would take it anyway; explicit so
--      the self-check below has nothing left to find);
--   2. drops the column;
--   3. self-checks the catalog and aborts the whole file otherwise.
--
-- Re-runnable: every step is IF EXISTS.
--
-- ROLLBACK: none needed and none possible for the values (659 cleared them).
-- If an old deploy that selects the column must run again, re-add it as a
-- new forward migration:
--   ALTER TABLE public.shelly_connections ADD COLUMN key_hint text
--     CONSTRAINT shelly_connections_key_hint_retired CHECK (key_hint IS NULL);

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.shelly_connections DROP CONSTRAINT IF EXISTS shelly_connections_key_hint_retired;
ALTER TABLE public.shelly_connections DROP COLUMN IF EXISTS key_hint;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.shelly_connections'::regclass
                AND attname = 'key_hint' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'SECRETTAILS.2 (759): shelly_connections.key_hint survived';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.shelly_connections'::regclass
                AND conname LIKE '%key_hint%') THEN
    RAISE EXCEPTION 'SECRETTAILS.2 (759): a key_hint constraint survived';
  END IF;
END $$;

COMMIT;
