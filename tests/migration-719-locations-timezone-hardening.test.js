// TZ.2 — behavioural test for migration 719 (locations.timezone hardened).
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite with `locations` reduced to the columns 719 touches,
// mig 648's column grants on them (column SELECT + UPDATE for authenticated,
// NO table-level privilege, as prod has had since 648; verified live 11 Oct),
// RLS on with a staff-only SELECT policy (members cannot see the row, as with
// prod's locations_read), applies the REAL 719 file and proves:
//
//   * the pre-check aborts the WHOLE file on a NULL or unknown zone, with
//     nothing applied;
//   * on six Dublin rows (prod's shape) no value changes; the column is NOT
//     NULL with the Dublin default kept;
//   * the trigger refuses an unknown name and every fixed-offset shape (22023)
//     on INSERT and UPDATE, and accepts both spellings of a renamed zone
//     (Asia/Kolkata + Asia/Calcutta, Europe/Kyiv + Europe/Kiev);
//   * the DB and canonicalZone() (shared/zoned-time.js) agree: the trigger's
//     fixed-offset regex classifies every probe exactly as canonicalZone's
//     FIXED_OFFSET does, and every zone canonicalZone returns for a runtime
//     zone is one pg_timezone_names knows (prod: all 418; PGlite ships a
//     smaller catalogue, so the test reports what it could check);
//   * authenticated can no longer UPDATE the column (42501) but still reads it
//     and still updates the edit form's other columns;
//   * private.location_tz answers the row's zone (Dublin for an unknown id),
//     even for a caller RLS hides the row from (SECURITY DEFINER), and anon
//     cannot execute it;
//   * the self-check aborts when a table-level UPDATE would make the column
//     REVOKE a no-op; a second run passes.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { canonicalZone } from '../shared/zoned-time.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/719_locations_timezone_hardening.sql'), 'utf8')

const LOC = (k) => `a0000000-0000-0000-0000-00000000000${k}`
const STAFF = '10000000-0000-0000-0000-000000000001'
const MEMBER = '20000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
  CREATE TABLE public.staff (profile_id uuid, location_id uuid);
  GRANT SELECT ON public.staff TO authenticated;

  -- mig 004 shape: nullable free text with a Dublin default; 018: country.
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, name text NOT NULL, timezone text DEFAULT 'Europe/Dublin',
    country character(2) NOT NULL DEFAULT 'IE', updated_at timestamptz DEFAULT now()
  );
  ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY locations_read ON public.locations FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.location_id = id AND s.profile_id = (SELECT auth.uid())));
  CREATE POLICY locations_upd ON public.locations FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.staff s WHERE s.location_id = id AND s.profile_id = (SELECT auth.uid())));
  -- mig 648: column grants only, no table-level privilege.
  REVOKE ALL ON public.locations FROM PUBLIC, anon, authenticated;
  GRANT SELECT (id, name, timezone, country, updated_at) ON public.locations TO authenticated;
  GRANT UPDATE (name, timezone, country, updated_at) ON public.locations TO authenticated;
`
const SIX_DUBLIN = `
  INSERT INTO public.locations (id, name, timezone, country) VALUES
    ('${LOC(1)}', 'Studio 1', 'Europe/Dublin', 'IE'), ('${LOC(2)}', 'Studio 2', 'Europe/Dublin', 'IE'),
    ('${LOC(3)}', 'Studio 3', 'Europe/Dublin', 'IE'), ('${LOC(4)}', 'Studio 4', 'Europe/Dublin', 'IE'),
    ('${LOC(5)}', 'Studio 5', 'Europe/Dublin', 'IE'), ('${LOC(6)}', 'Studio 6', 'Europe/Dublin', 'IE');
  INSERT INTO public.staff VALUES ('${STAFF}', '${LOC(1)}');
`

let db
const run = (text) => db['exec'](text)

async function boot(extra = '') {
  db = new PGlite()
  await run(SCHEMA)
  await run(SIX_DUBLIN)
  if (extra) await run(extra)
}

/** The error a statement raises (rolled back), or null. */
async function errorOf(sql, params = []) {
  await run('BEGIN')
  try {
    await db.query(sql, params)
    return null
  } catch (e) {
    return e
  } finally {
    await run('ROLLBACK')
  }
}

/** Rows from `sql` run as an authenticated session for `uid`, in a rolled-back tx. */
async function asUser(uid, sql, params = []) {
  await run('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid])
    await run('SET LOCAL ROLE authenticated')
    return (await db.query(sql, params)).rows
  } finally {
    await run('ROLLBACK')
  }
}

async function asAnon(sql) {
  await run('BEGIN')
  try {
    await run('SET LOCAL ROLE anon')
    return (await db.query(sql)).rows
  } finally {
    await run('ROLLBACK')
  }
}

async function abortMessage(sql) {
  try {
    await run(sql)
    return null
  } catch (e) {
    await run('ROLLBACK')
    return String(e.message || e)
  }
}

const isNullable = async () => (await db.query(
  `SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'timezone'`)).rows[0].is_nullable
const tzPrivileges = async (grantee) => (await db.query(
  `SELECT privilege_type FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'timezone' AND grantee = $1
    ORDER BY 1`, [grantee])).rows.map((r) => r.privilege_type)
const triggerExists = async () => (await db.query(
  `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'locations_timezone_guard'`)).rows[0].n === 1
const zones = async () => (await db.query('SELECT id, timezone FROM public.locations ORDER BY id')).rows

// Every fixed-offset shape canonicalZone refuses by regex, plus look-alikes it accepts.
const FIXED_OFFSET_PROBES = ['+05:30', '-03:00', '+1', 'Etc/GMT-5', 'etc/gmt+10', 'GMT+0', 'GMT-3', 'UTC+1', 'utc-05:00']
const NOT_OFFSET_PROBES = ['Europe/Dublin', 'America/New_York', 'Etc/UTC', 'GMT', 'UTC', 'Asia/Kolkata', 'Etc/GMT']

describe('719 pre-check: a NULL or unknown zone aborts the whole file', () => {
  afterAll(() => db?.close())

  it.each([
    ['NULL', `UPDATE public.locations SET timezone = NULL WHERE id = '${LOC(3)}'`],
    ['an unknown name', `UPDATE public.locations SET timezone = 'Mars/Olympus' WHERE id = '${LOC(3)}'`],
  ])('%s: aborts, and nothing is applied', async (_label, poison) => {
    await db?.close()
    await boot(poison)
    expect(await abortMessage(MIG)).toMatch(/TZ\.2 \(mig 719\): 1 location\(s\) have a NULL or unknown timezone/)
    expect(await isNullable()).toBe('YES')
    expect(await triggerExists()).toBe(false)
    expect(await tzPrivileges('authenticated')).toEqual(['SELECT', 'UPDATE'])
  })
})

describe('719 applied to prod\'s shape (six Europe/Dublin rows)', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = await zones()
    await run(MIG)
  }, 60_000)
  afterAll(() => db?.close())

  it('changes no value; NOT NULL, Dublin default kept', async () => {
    expect(await zones()).toEqual(before)
    expect(before.every((r) => r.timezone === 'Europe/Dublin')).toBe(true)
    expect(await isNullable()).toBe('NO')
    const { rows } = await db.query(`SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'timezone'`)
    expect(rows[0].column_default).toBe(`'Europe/Dublin'::text`)
    const ins = await db.query(`INSERT INTO public.locations (id, name) VALUES ('${LOC(7)}', 'Defaulted') RETURNING timezone`)
    expect(ins.rows).toEqual([{ timezone: 'Europe/Dublin' }])
    await run(`DELETE FROM public.locations WHERE id = '${LOC(7)}'`)
  })

  it.each(['Mars/Olympus', '', 'europe/dublin', ...FIXED_OFFSET_PROBES])('refuses %j with 22023 on UPDATE and INSERT', async (tz) => {
    const upd = await errorOf(`UPDATE public.locations SET timezone = $1 WHERE id = '${LOC(1)}'`, [tz])
    expect(upd?.code).toBe('22023')
    const ins = await errorOf(`INSERT INTO public.locations (id, name, timezone) VALUES ('${LOC(8)}', 'X', $1)`, [tz])
    expect(ins?.code).toBe('22023')
  })

  it('refuses NULL (the BEFORE trigger answers first, 22023; NOT NULL backs it)', async () => {
    expect((await errorOf(`UPDATE public.locations SET timezone = NULL WHERE id = '${LOC(1)}'`))?.code).toMatch(/^(22023|23502)$/)
  })

  it.each(['America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'Europe/Kiev', 'UTC'])(
    'accepts %s (both spellings of a renamed zone)', async (tz) => {
      expect(await errorOf(`UPDATE public.locations SET timezone = $1 WHERE id = '${LOC(1)}'`, [tz])).toBeNull()
    })

  it('agrees with canonicalZone: whichever spelling the app stores, the DB accepts', async () => {
    // V8 canonicalises Asia/Kolkata to the legacy link Asia/Calcutta.
    for (const tz of ['Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'Europe/Kiev']) {
      const canon = canonicalZone(tz)
      expect(canon).not.toBeNull()
      expect(await errorOf(`UPDATE public.locations SET timezone = $1 WHERE id = '${LOC(1)}'`, [canon])).toBeNull()
    }
    // Every runtime zone canonicalZone accepts, against this catalogue (set-based:
    // one catalogue scan, not one trigger fire per zone).
    const runtime = Intl.supportedValuesOf('timeZone').map(canonicalZone)
    expect(runtime.every(Boolean)).toBe(true)
    const { rows } = await db.query(
      `SELECT n FROM unnest($1::text[]) n WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names t WHERE t.name = n)`, [runtime])
    // PGlite's catalogue is a subset of prod's (prod held all 418 on 11 Oct); most must still be here.
    expect(rows.length).toBeGreaterThan(runtime.length * 0.8)
  })

  it("the trigger's fixed-offset regex is canonicalZone's: same verdict on every probe", async () => {
    const re = MIG.match(/NEW\.timezone ~\* '([^']+)'/)[1]
    const probes = [...FIXED_OFFSET_PROBES, ...NOT_OFFSET_PROBES]
    const { rows } = await db.query(`SELECT n, n ~* $2 AS fixed FROM unnest($1::text[]) WITH ORDINALITY u(n, i) ORDER BY i`, [probes, re])
    for (const { n, fixed } of rows) {
      expect({ n, fixed }).toEqual({ n, fixed: FIXED_OFFSET_PROBES.includes(n) })
      if (fixed) expect(canonicalZone(n)).toBeNull()
      else expect(canonicalZone(n)).not.toBeNull()
    }
  })

  it('authenticated: UPDATE (timezone) is gone (42501); SELECT stays; the edit form\'s other columns still update', async () => {
    expect(await tzPrivileges('authenticated')).toEqual(['SELECT'])
    expect(await tzPrivileges('anon')).toEqual([])
    await expect(asUser(STAFF, `UPDATE public.locations SET timezone = 'Europe/London' WHERE id = '${LOC(1)}'`))
      .rejects.toThrow(/permission denied for (table|relation) locations/)
    expect(await asUser(STAFF, `UPDATE public.locations SET name = 'Studio 1b', country = 'IE', updated_at = now()
      WHERE id = '${LOC(1)}' RETURNING id`)).toEqual([{ id: LOC(1) }])
    expect(await asUser(STAFF, `SELECT timezone FROM public.locations WHERE id = '${LOC(1)}'`)).toEqual([{ timezone: 'Europe/Dublin' }])
  })

  it('private.location_tz: the row\'s zone, Dublin for an unknown id, through RLS (DEFINER), never for anon', async () => {
    await run(`UPDATE public.locations SET timezone = 'America/New_York' WHERE id = '${LOC(2)}'`)
    try {
      const q = `SELECT private.location_tz('${LOC(2)}') AS ny, private.location_tz('${LOC(1)}') AS dub,
        private.location_tz('ffffffff-0000-0000-0000-000000000000') AS missing, private.location_tz(NULL) AS nul`
      const expected = [{ ny: 'America/New_York', dub: 'Europe/Dublin', missing: 'Europe/Dublin', nul: 'Europe/Dublin' }]
      expect((await db.query(q)).rows).toEqual(expected)
      // A member sees no locations row (RLS) yet gets the studio's real zone.
      expect(await asUser(MEMBER, `SELECT count(*)::int AS n FROM public.locations`)).toEqual([{ n: 0 }])
      expect(await asUser(MEMBER, q)).toEqual(expected)
      await expect(asAnon(`SELECT private.location_tz('${LOC(2)}')`)).rejects.toThrow(/permission denied/)
      const { rows } = await db.query(`SELECT has_function_privilege('anon', 'private.location_tz(uuid)', 'EXECUTE') AS anon,
        has_function_privilege('authenticated', 'private.location_tz(uuid)', 'EXECUTE') AS authd,
        has_function_privilege('service_role', 'private.location_tz(uuid)', 'EXECUTE') AS svc,
        has_function_privilege('authenticated', 'private.locations_timezone_guard()', 'EXECUTE') AS guard`)
      expect(rows).toEqual([{ anon: false, authd: true, svc: true, guard: false }])
    } finally {
      await run(`UPDATE public.locations SET timezone = 'Europe/Dublin' WHERE id = '${LOC(2)}'`)
    }
  })

  it('a second run passes and changes nothing', async () => {
    const now = await zones()
    await expect(run(MIG)).resolves.toBeDefined()
    expect(await zones()).toEqual(now)
    expect(await tzPrivileges('authenticated')).toEqual(['SELECT'])
  })
})

describe('719 self-check', () => {
  afterAll(() => db?.close())

  it('aborts when a table-level UPDATE makes the column REVOKE a no-op', async () => {
    await boot('GRANT UPDATE ON public.locations TO authenticated;')
    expect(await abortMessage(MIG)).toMatch(/a client role still holds UPDATE\/INSERT on locations\.timezone/)
    expect(await isNullable()).toBe('YES')
    expect(await triggerExists()).toBe(false)
  })

  it('starts with BEGIN + a 5s lock_timeout and ends with COMMIT', () => {
    expect(MIG).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';\n/m)
    expect(MIG).toMatch(/^COMMIT;\s*$/m)
  })
})
