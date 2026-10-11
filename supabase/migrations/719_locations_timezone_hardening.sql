-- 719 — TZ.2: locations.timezone hardened (SaaS timezone wave; plan
-- docs/superpowers/plans/2026-10-11-saas-timezone-wave.md, Task TZ.2).
--
-- WHY. A location's timezone is chosen when the location is created and
-- managed in its settings (Richard, 10 Oct 2026), and every per-studio
-- wall-clock decision reads it (TZ.4-TZ.17). Until now the column was
-- nullable free text (mig 004) that any owner could rewrite with a direct
-- browser UPDATE (mig 648 column grant; LocationForm's edit payload), with no
-- validation: a typo was storable and every reader silently fell back.
--
-- AFTER.
--   * NOT NULL, DEFAULT 'Europe/Dublin' kept (the API default when a caller
--     omits the field; the CRM's forms always send it, D8).
--   * A real IANA zone (D1 = A): validated against pg_timezone_names by a
--     BEFORE INSERT / UPDATE OF timezone trigger (a CHECK cannot read a
--     catalog view). Fixed offsets ('+05:30', 'UTC+1', 'GMT-3', 'Etc/GMT-5')
--     are refused first: they have no DST, so a studio on one is silently an
--     hour wrong half the year. The shape test is the SAME regex as
--     canonicalZone() in shared/zoned-time.js, so the app and the DB refuse
--     the same strings. Both spellings of a renamed zone exist in
--     pg_timezone_names (Asia/Kolkata + Asia/Calcutta, Europe/Kyiv +
--     Europe/Kiev; checked live 11 Oct, and every one of Node 24's 418
--     canonical Intl zones is present), so whichever spelling the app's
--     canonicalZone() returns is accepted.
--   * authenticated loses UPDATE (timezone). Mig 648 granted column UPDATE
--     with NO table-level UPDATE (verified live 11 Oct: table_privileges is
--     empty for anon/authenticated on locations), so a column REVOKE bites
--     (the CLAUDE.md trap is a column REVOKE under a TABLE grant); the
--     self-check at the end proves it from column_privileges. The zone is
--     written only by the service role: POST /api/locations at creation, and
--     the TZ.3 route (PUT /api/locations/[id]/timezone, D2 preflight) after.
--   * private.location_tz(uuid): the SQL twin of zoneOfLocation(), for TZ.15's
--     functions and policies. SECURITY DEFINER (a deviation from the plan's
--     invoker draft): a policy evaluated for a member (challenges_read) runs
--     it as a caller who cannot see the locations row through locations_read,
--     and an invoker body would then answer the Dublin fallback for a
--     non-Dublin studio. It returns only the zone of the id it is given,
--     which is public identity (column-granted to authenticated since 648).
--
-- DATA. Changes no value. All six live rows are 'Europe/Dublin' (Q1, 11 Oct);
-- the pre-check aborts the whole file, with nothing applied, if any row is
-- NULL or not in pg_timezone_names, so a bad row is fixed by hand first.
--
-- Re-runnable: SET NOT NULL / SET DEFAULT / CREATE OR REPLACE / DROP TRIGGER
-- IF EXISTS / REVOKE / GRANT are idempotent. One transaction; 5s lock_timeout
-- (SET NOT NULL takes ACCESS EXCLUSIVE on a table every getCurrentUser
-- joins: never queue behind a long reader).
--
-- ROLLBACK (by hand, only if TZ.2's app change is reverted too):
--   DROP TRIGGER IF EXISTS locations_timezone_guard ON public.locations;
--   DROP FUNCTION IF EXISTS private.locations_timezone_guard();
--   DROP FUNCTION IF EXISTS private.location_tz(uuid);   -- only before TZ.15
--   ALTER TABLE public.locations ALTER COLUMN timezone DROP NOT NULL;
--   GRANT UPDATE (timezone) ON public.locations TO authenticated;
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Pre-check: no live row may be NULL or unknown before the constraint lands.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM public.locations l
   WHERE l.timezone IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = l.timezone);
  IF bad > 0 THEN
    RAISE EXCEPTION 'TZ.2 (mig 719): % location(s) have a NULL or unknown timezone; fix them by hand first', bad;
  END IF;
END $$;

ALTER TABLE public.locations ALTER COLUMN timezone SET DEFAULT 'Europe/Dublin';
ALTER TABLE public.locations ALTER COLUMN timezone SET NOT NULL;

-- 2. Validation trigger.
CREATE OR REPLACE FUNCTION private.locations_timezone_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Same shape as shared/zoned-time.js FIXED_OFFSET (case-insensitive).
  IF NEW.timezone ~* '^([+-][0-9]|(etc/)?gmt[+-][0-9]|utc[+-][0-9])' THEN
    RAISE EXCEPTION 'locations.timezone % is a fixed offset; use an IANA zone such as Europe/Dublin', NEW.timezone
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = NEW.timezone) THEN
    RAISE EXCEPTION 'locations.timezone % is not an IANA zone', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.locations_timezone_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS locations_timezone_guard ON public.locations;
CREATE TRIGGER locations_timezone_guard
  BEFORE INSERT OR UPDATE OF timezone ON public.locations
  FOR EACH ROW EXECUTE FUNCTION private.locations_timezone_guard();

-- 3. The browser stops writing the column.
REVOKE UPDATE (timezone) ON public.locations FROM authenticated;

-- 4. The SQL twin of zoneOfLocation (src/lib/location-time.js), for TZ.15.
CREATE OR REPLACE FUNCTION private.location_tz(p_location_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT l.timezone FROM public.locations l WHERE l.id = p_location_id), 'Europe/Dublin')
$$;
REVOKE ALL ON FUNCTION private.location_tz(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.location_tz(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.locations.timezone IS
  'TZ.2 (mig 719): the studio''s IANA zone. Every per-location wall-clock column (bookings, shift_blocks, '
  'race_events, quiet hours, schedules) is local time in this zone. Chosen at creation (POST /api/locations); '
  'changed only through the service role (TZ.3: PUT /api/locations/[id]/timezone, D2 preflight). NOT NULL, '
  'validated against pg_timezone_names (no fixed offsets) by private.locations_timezone_guard; no client UPDATE.';

-- 5. Self-check, from the catalog (never the migration text).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'timezone'
                AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('UPDATE', 'INSERT')) THEN
    RAISE EXCEPTION 'TZ.2 (mig 719): a client role still holds UPDATE/INSERT on locations.timezone; a table-level grant must exist';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'timezone') <> 'NO' THEN
    RAISE EXCEPTION 'TZ.2 (mig 719): locations.timezone is still nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.locations'::regclass
                  AND tgname = 'locations_timezone_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'TZ.2 (mig 719): locations_timezone_guard trigger missing';
  END IF;
END $$;
COMMIT;
