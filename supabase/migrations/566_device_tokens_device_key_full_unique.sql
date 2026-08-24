-- 566 — ANDROID-VIS.1b: make the device_key unique index INFERRABLE.
--
-- FIXES A SHIP-STOPPER IN MIG 565. That migration created
--
--   CREATE UNIQUE INDEX device_tokens_device_key_key
--     ON device_tokens (device_key) WHERE device_key IS NOT NULL;
--
-- and the route upserts with ON CONFLICT (device_key). Postgres cannot
-- infer a PARTIAL index from a bare column list: the index predicate has to
-- be implied by the statement, and an INSERT has no WHERE clause to imply
-- it. Verified against this database:
--
--   insert into device_tokens (…, device_key, …) values (…)
--   on conflict (device_key) do update set last_seen_at = excluded.last_seen_at;
--   ERROR:  42P10: there is no unique or exclusion constraint matching the
--           ON CONFLICT specification
--
-- So EVERY device_key upsert would have 500'd — permanently, for every
-- device on 2.3.x+. Worse than the bug being fixed: reporting would have
-- frozen outright, and the first sign-out DELETE (which is keyed on
-- device_key and would still have worked) would have ERASED rows rather
-- than refreshed them. Caught in review before merge; nothing shipped.
--
-- The fix is to drop the WHERE clause. Mig 565's own comment already says
-- why that is safe and it was right — it just did not follow through:
-- Postgres treats NULLs as DISTINCT in a btree unique index by default
-- (NULLS DISTINCT), so any number of NULL-device_key rows coexist under a
-- plain unique index. The 13 pre-565 iOS rows stay legal, and the arbiter
-- now resolves.
--
-- Not folded back into 565: migrations are forward-only, and 565 is already
-- applied to prod.

DROP INDEX IF EXISTS public.device_tokens_device_key_key;

-- Explicit NULLS DISTINCT (the default) so the property this whole design
-- leans on is stated rather than assumed by the next reader.
CREATE UNIQUE INDEX device_tokens_device_key_key
  ON public.device_tokens (device_key) NULLS DISTINCT;

COMMENT ON INDEX public.device_tokens_device_key_key IS
  'ANDROID-VIS.1b (mig 566) — must stay a FULL (non-partial) unique index: ON CONFLICT (device_key) cannot infer a partial one (42P10). NULLS DISTINCT keeps the pre-565 NULL-device_key rows legal.';
