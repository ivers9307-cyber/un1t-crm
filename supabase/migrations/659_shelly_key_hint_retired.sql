-- 659 — SECRETTAILS.1 (2 of 2): shelly_connections.key_hint is cleared and
-- can never be stored again.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file runs (read-only, 29 Sep 2026). Proven ahead of apply by
-- tests/migration-658-659-shelly-key-hint.test.js (PGlite).
--
-- key_hint held the last 4 characters of the Shelly Cloud auth key (mig 562).
-- SECRETTAILS.1b (deployed first) stopped every write and read of it: the
-- panel and the Integrations hub show presence only ("key ••••••"), and
-- has_auth_key is derived from the stored row (auth_key NOT NULL + a 64-hex
-- fingerprint CHECK mean a row cannot exist without a key). This file:
--   1. clears the stored value (irreversible, by design: nothing reads it);
--   2. replaces the 1-4 character CHECK with CHECK (key_hint IS NULL), so
--      nothing can store one again, the service role included (an old
--      deploy, a preview built from an older main, a script, a hand UPDATE);
--   3. marks the column DEPRECATED (a later migration drops it, no sooner
--      than 7 days after this one: plan C57 D5);
--   4. self-checks the catalog and the data, and aborts the whole file
--      otherwise.
-- No trigger exists on the table, so the UPDATE neither audits the old value
-- nor moves updated_at (which the hub reads as the cron's last attempt).
--
-- VERIFIED LIVE (29 Sep, before 658/659): 1 row, key_hint non-null on it;
-- no trigger, view, function, index or publication names the column.
--
-- REQUIRES 658 (key_hint nullable). Without it step 1 fails 23502 and the
-- whole file rolls back.
--
-- APPLY ≥1 h AFTER the SECRETTAILS.1b deploy is live. Old code writes the
-- hint this CHECK forbids; its save would fail 23514 → 400 "Shelly rejected
-- the server or key format" (loud, and never stores a hint).
--
-- ROLLBACK (only if something breaks), as a new forward migration. The
-- cleared values cannot come back, and must not:
--   BEGIN;
--   ALTER TABLE public.shelly_connections DROP CONSTRAINT IF EXISTS shelly_connections_key_hint_retired;
--   ALTER TABLE public.shelly_connections ADD CONSTRAINT shelly_connections_key_hint_check
--     CHECK (char_length(key_hint) BETWEEN 1 AND 4);
--   COMMIT;
-- (Drop the retire CHECK BEFORE reverting the code.)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Clear.
UPDATE public.shelly_connections SET key_hint = NULL WHERE key_hint IS NOT NULL;

-- 2. Nothing may store one again.
ALTER TABLE public.shelly_connections DROP CONSTRAINT IF EXISTS shelly_connections_key_hint_check;
ALTER TABLE public.shelly_connections DROP CONSTRAINT IF EXISTS shelly_connections_key_hint_retired;
ALTER TABLE public.shelly_connections ADD CONSTRAINT shelly_connections_key_hint_retired CHECK (key_hint IS NULL);

-- 3. Deprecated.
COMMENT ON COLUMN public.shelly_connections.key_hint IS
  'DEPRECATED (mig 659, SECRETTAILS.1): always NULL (CHECK shelly_connections_key_hint_retired). It held the last 4 chars of auth_key; the UI shows presence only. Dropped by a later migration.';

-- 4. Self-check: the catalog and the data, never this file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.shelly_connections WHERE key_hint IS NOT NULL) THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (659): a key_hint value survived';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.shelly_connections'::regclass
                    AND conname = 'shelly_connections_key_hint_retired'
                    AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (659): CHECK shelly_connections_key_hint_retired is missing or not validated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.shelly_connections'::regclass
                AND conname = 'shelly_connections_key_hint_check') THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (659): the old length CHECK survived';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.shelly_connections'::regclass
                AND attname = 'key_hint' AND attnotnull) THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (659): key_hint is NOT NULL; apply 658 first';
  END IF;
END $$;

COMMIT;
