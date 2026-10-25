-- 658 — SECRETTAILS.1 (1 of 2): shelly_connections.key_hint may be NULL.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" is prod BEFORE
-- this file runs (read-only, Supabase MCP, 29 Sep 2026). Behaviour is proven
-- ahead of apply by tests/migration-658-659-shelly-key-hint.test.js (PGlite).
--
-- THE FINDING (follow-ups C57, found reviewing C42 N8NECHO.1): key_hint holds
-- the last 4 characters of the Shelly Cloud auth key (mig 562). It was stored,
-- returned by GET/PUT /api/shelly/connection and the Integrations hub, and
-- rendered as "key ••••abcd". SECRETTAILS.1b stops every read and write of it
-- and shows presence only; mig 659 then clears it.
--
-- WHY THIS RUNS FIRST, ON ITS OWN: the 1b route upserts WITHOUT key_hint.
-- Postgres checks NOT NULL on the proposed row BEFORE ON CONFLICT arbitration,
-- so while the column is NOT NULL every connect AND every re-paste from the new
-- code would fail 23502 ("Could not save the Shelly connection"). Dropping NOT
-- NULL changes nothing the code in production does: it still writes a 1-4
-- character hint, which shelly_connections_key_hint_check (kept) still allows,
-- and a NULL passes a CHECK.
--
-- VERIFIED LIVE (29 Sep, before this file): 1 row, key_hint non-null on it,
-- is_nullable = NO, no triggers, not in supabase_realtime, no view, function
-- or index names the column. CHECKs: fingerprint, host, key_hint (1-4 chars),
-- status.
--
-- APPLY: any time BEFORE SECRETTAILS.1b merges.
--
-- PRE-CHECK (read-only; never select key_hint or auth_key themselves):
--   select
--     (select count(*) from public.shelly_connections) as rows,
--     (select count(*) from public.shelly_connections where key_hint is not null) as hint_nonnull,
--     (select is_nullable from information_schema.columns
--       where table_schema='public' and table_name='shelly_connections' and column_name='key_hint') as hint_nullable,
--     (select count(*) from pg_trigger where tgrelid='public.shelly_connections'::regclass and not tgisinternal) as triggers;
--   -- 29 Sep: 1 | 1 | NO | 0
--
-- POST-CHECK:
--   select
--     (select is_nullable from information_schema.columns
--       where table_schema='public' and table_name='shelly_connections' and column_name='key_hint') as hint_nullable,
--     (select count(*) from pg_constraint where conrelid='public.shelly_connections'::regclass
--       and conname='shelly_connections_key_hint_check') as old_check,
--     (select count(*) from public.shelly_connections where key_hint is not null) as hint_nonnull;
--   -- expect: YES | 1 | 1 (unchanged data)
--
-- ROLLBACK: none needed; a nullable column is compatible with every build. If
-- one is ever wanted, `ALTER TABLE public.shelly_connections ALTER COLUMN
-- key_hint SET NOT NULL;` succeeds only while no row is NULL (i.e. before 1b
-- has saved a connection and before 659).

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.shelly_connections ALTER COLUMN key_hint DROP NOT NULL;

COMMENT ON COLUMN public.shelly_connections.key_hint IS
  'SECRETTAILS.1 (mig 658): nullable. Held the last 4 chars of auth_key; the code stops writing and reading it (1b) and mig 659 clears it and forbids a value. Do not add a reader.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.shelly_connections'::regclass
                AND attname = 'key_hint' AND attnotnull) THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (658): key_hint is still NOT NULL';
  END IF;
  -- The old bound stays until 659: old code still writes a hint.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.shelly_connections'::regclass
                    AND conname = 'shelly_connections_key_hint_check') THEN
    RAISE EXCEPTION 'SECRETTAILS.1 (658): shelly_connections_key_hint_check is missing; was 659 applied out of order?';
  END IF;
END $$;

COMMIT;
