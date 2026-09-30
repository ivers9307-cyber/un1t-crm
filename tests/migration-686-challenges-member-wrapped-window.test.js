// CHALLENGEWRAPPED.1 — behavioural test for migration 686.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with public.challenges in
// PROD column order (30 Sep 2026), its one policy challenges_read verbatim,
// its post-672/677 privileges (authenticated SELECT only, anon nothing),
// contacts + contacts_select verbatim (the member branch reads contacts as
// the caller), profiles/profile_locations reduced to what the helpers read,
// and private.auth_is_master, private.auth_is_in_location and
// private.auth_contact_id verbatim with their prod EXECUTE. (Same model as
// tests/migration-672-challenges-segments-car-notes-client-writes-off
// .test.js; copied, not imported: importing a test file would re-register its
// tests.) Challenge dates are seeded relative to the Europe/Dublin date of
// now(), so the window edges are exact (a run that straddles Dublin midnight
// between seed and read could be off by one day; it takes milliseconds).
// It proves:
//   * BEFORE: a member reads only their studio's running and upcoming
//     challenges (nothing ended, so Challenge Wrapped reads nothing);
//   * AFTER: the member also reads a challenge that ended yesterday and one
//     that ended 14 Dublin days ago, never one that ended 15 days ago, never
//     another studio's; staff (studio membership) and the master read exactly
//     what they read before; a signed-in login with no contact reads nothing;
//     anon is refused by the grant; no client can write;
//   * the policy's window equals the phone's rule (shared/challenge-wrapped.js
//     endedRecentlyFlagship, 14 days) at noon on every day around both DST
//     changes;
//   * the self-check aborts the WHOLE file if the policy did not start as the
//     30 Sep text, if a second policy exists, if a client role holds more
//     than SELECT, or if RLS is off; a second run passes; the plan's rollback
//     record restores the 30 Sep policy exactly.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { endedRecentlyFlagship, challengeWindowMs } from '../shared/challenge-wrapped.js'

const MIG_686 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/686_challenges_member_wrapped_window.sql'), 'utf8')

// The rollback record from the C96 plan (Task 4 Step 6), verbatim.
const ROLLBACK_686 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public;
ALTER POLICY challenges_read ON public.challenges USING (
  (SELECT private.auth_is_master())
  OR private.auth_is_in_location(location_id)
  OR ((ends_on >= ((now() AT TIME ZONE 'utc'::text))::date)
      AND EXISTS (SELECT 1 FROM public.contacts c
                   WHERE c.id = (SELECT private.auth_contact_id())
                     AND c.location_id = challenges.location_id))
);
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'    // plain staff at A
const MASTER = '10000000-0000-0000-0000-000000000004'
const MEMBER_UID = '20000000-0000-0000-0000-000000000001' // a customer's login at A (no profile)
const LOOSE_UID = '20000000-0000-0000-0000-000000000002'  // a login with no contact and no profile
const CONTACT_M = '30000000-0000-0000-0000-000000000001'
const CH = {
  RUN: '40000000-0000-0000-0000-000000000001',     // A, running
  UP: '40000000-0000-0000-0000-000000000002',      // A, starts in 3 days
  END1: '40000000-0000-0000-0000-000000000003',    // A, flagship, ended yesterday
  END14: '40000000-0000-0000-0000-000000000004',   // A, flagship, ended 14 days ago (last day shown)
  END15: '40000000-0000-0000-0000-000000000005',   // A, flagship, ended 15 days ago (hidden)
  B_END1: '40000000-0000-0000-0000-000000000006',  // B, ended yesterday (member is not at B)
}
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- live: anon has none

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  -- contacts: only what challenges_read touches.
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, user_id uuid, location_id uuid REFERENCES public.locations(id));

  -- PROD column order, defaults, keys and CHECKs (30 Sep 2026).
  CREATE TABLE public.challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL,
    mode text NOT NULL CONSTRAINT challenges_mode_check CHECK (mode = ANY (ARRAY['individual'::text, 'collective'::text])),
    metric text NOT NULL CONSTRAINT challenges_metric_check CHECK (metric = ANY (ARRAY['points'::text, 'classes'::text, 'z4plus_minutes'::text])),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    target integer,
    created_by uuid REFERENCES public.profiles(id),
    announced_start_at timestamptz,
    announced_end_at timestamptz,
    announced_target_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    is_flagship boolean NOT NULL DEFAULT false
  );

  -- Live privileges (30 Sep 2026; migs 153b, 653, 657, 672, 677).
  REVOKE ALL ON public.profiles, public.profile_locations, public.locations FROM anon, authenticated;
  REVOKE ALL ON public.contacts, public.challenges FROM anon, authenticated, PUBLIC;
  GRANT SELECT ON public.contacts, public.challenges TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

  -- Helpers, verbatim (pg_proc, 30 Sep 2026).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND role = 'master'
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    )
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.active IS NOT FALSE
          AND p.deleted_at IS NULL
          AND (
            p.role = 'master'
            OR EXISTS (
              SELECT 1 FROM public.profile_locations
              WHERE profile_id = (SELECT auth.uid())
                AND location_id = loc_id
            )
          )
      )
  $$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public', 'pg_temp' AS $$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $$;
  REVOKE EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() TO authenticated, service_role;
`

// The live policies (pg_policies, 30 Sep 2026).
const PROD_POLICIES = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));

  ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
  CREATE POLICY challenges_read ON public.challenges FOR SELECT TO public USING (
    (SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id)
    OR ((ends_on >= ((now() AT TIME ZONE 'utc'::text))::date)
        AND EXISTS (SELECT 1 FROM public.contacts c
                     WHERE c.id = (SELECT private.auth_contact_id()) AND c.location_id = challenges.location_id)));
`

const D = (n) => `((now() AT TIME ZONE 'Europe/Dublin')::date + ${n})`
const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF_A}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts VALUES ('${CONTACT_M}', '${MEMBER_UID}', '${LOC_A}');
  INSERT INTO public.challenges (id, location_id, name, mode, metric, starts_on, ends_on, is_flagship) VALUES
    ('${CH.RUN}',    '${LOC_A}', 'Running',        'individual', 'points', ${D(-3)},  ${D(5)},   false),
    ('${CH.UP}',     '${LOC_A}', 'Upcoming',       'collective', 'classes', ${D(3)},  ${D(10)},  false),
    ('${CH.END1}',   '${LOC_A}', 'Ended 1 day',    'individual', 'points', ${D(-30)}, ${D(-1)},  true),
    ('${CH.END14}',  '${LOC_A}', 'Ended 14 days',  'individual', 'points', ${D(-45)}, ${D(-14)}, true),
    ('${CH.END15}',  '${LOC_A}', 'Ended 15 days',  'individual', 'points', ${D(-45)}, ${D(-15)}, true),
    ('${CH.B_END1}', '${LOC_B}', 'B ended 1 day',  'individual', 'points', ${D(-30)}, ${D(-1)},  true);
`

let db
const runSql = (text) => db['exec'](text)

/** Run `sql` with a JWT's claims and role in a rolled-back tx. */
async function as(claims, sql) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await runSql(`SET LOCAL ROLE ${claims.role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
const member = { sub: MEMBER_UID, role: 'authenticated' }
const loose = { sub: LOOSE_UID, role: 'authenticated' }
const staff = { sub: STAFF_A, role: 'authenticated' }
const master = { sub: MASTER, role: 'authenticated' }
const anonymous = { role: 'anon' }
const ids = async (claims) => (await as(claims, 'SELECT id FROM public.challenges ORDER BY id')).map((r) => r.id)
const byId = async (claims, id) => as(claims,
  `SELECT id, name, mode, metric, starts_on, ends_on, target, is_flagship FROM public.challenges WHERE id = '${id}'`)

async function policies() {
  return (await db.query(
    `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'challenges' ORDER BY policyname`)).rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_686)
}

const MEMBER_BEFORE = [CH.RUN, CH.UP].sort()
const MEMBER_AFTER = [CH.RUN, CH.UP, CH.END1, CH.END14].sort()
const STAFF_ALL = [CH.RUN, CH.UP, CH.END1, CH.END14, CH.END15].sort()
const EVERYTHING = Object.values(CH).sort()

describe('PGlite knows Europe/Dublin (the window depends on it)', () => {
  beforeAll(async () => { db = new PGlite() }, 60_000)
  afterAll(() => db?.close())
  it('23:30 UTC on 1 Jul is 2 Jul in Dublin; 23:30 UTC on 1 Dec is still 1 Dec', async () => {
    const { rows } = await db.query(`SELECT
      (('2026-07-01 23:30Z'::timestamptz) AT TIME ZONE 'Europe/Dublin')::date::text AS summer,
      (('2026-12-01 23:30Z'::timestamptz) AT TIME ZONE 'Europe/Dublin')::date::text AS winter`)
    expect(rows[0]).toEqual({ summer: '2026-07-02', winter: '2026-12-01' })
  })
})

describe('before 686 — the gap (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('a member reads only running and upcoming challenges: nothing ended, so Wrapped reads nothing', async () => {
    expect(await ids(member)).toEqual(MEMBER_BEFORE)
    expect(await byId(member, CH.END1)).toEqual([])
  })

  it('staff read every challenge at their studio; the master reads all', async () => {
    expect(await ids(staff)).toEqual(STAFF_ALL)
    expect(await ids(master)).toEqual(EVERYTHING)
  })
})

describe('after 686', () => {
  let policyBefore
  beforeAll(async () => {
    await boot()
    policyBefore = await policies()
    await runSql(MIG_686)
  }, 60_000)
  afterAll(() => db?.close())

  it('a member also reads challenges that ended up to 14 Dublin days ago, at their studio only', async () => {
    expect(await ids(member)).toEqual(MEMBER_AFTER)
  })

  it("the phone's Wrapped read (one row by id) returns the challenge that ended 14 days ago, not 15", async () => {
    expect((await byId(member, CH.END14)).map((r) => r.id)).toEqual([CH.END14])
    expect(await byId(member, CH.END15)).toEqual([])
    expect(await byId(member, CH.B_END1)).toEqual([])
  })

  it("the phone's entry query (flagship, ends_on within 30 days) returns the two recent flagships", async () => {
    const rows = await as(member, `SELECT id FROM public.challenges
      WHERE is_flagship AND ends_on >= ((now() AT TIME ZONE 'utc')::date - 30) ORDER BY id`)
    expect(rows.map((r) => r.id)).toEqual([CH.END1, CH.END14].sort())
  })

  it('staff and the master read exactly what they read before', async () => {
    expect(await ids(staff)).toEqual(STAFF_ALL)
    expect(await ids(master)).toEqual(EVERYTHING)
  })

  it('a login with no contact reads nothing; anon is refused by the grant', async () => {
    expect(await ids(loose)).toEqual([])
    await expect(ids(anonymous)).rejects.toThrow(/permission denied for table challenges/)
  })

  it('no client writes (672 unchanged)', async () => {
    await expect(as(member, `UPDATE public.challenges SET name = 'x' WHERE id = '${CH.END1}'`))
      .rejects.toThrow(/permission denied for table challenges/)
    await expect(as(staff, `DELETE FROM public.challenges WHERE id = '${CH.RUN}'`))
      .rejects.toThrow(/permission denied for table challenges/)
  })

  it('only USING changed: same name, command, roles, no WITH CHECK; the new branch is the Dublin 14-day window', async () => {
    const after = await policies()
    expect(after.map(({ qual, ...rest }) => rest)).toEqual(policyBefore.map(({ qual, ...rest }) => rest))
    expect(after[0].qual).toContain("(ends_on >= (((now() AT TIME ZONE 'Europe/Dublin'::text))::date - 14))")
    expect(after[0].qual).not.toContain("'utc'")
  })

  it('privileges unchanged: authenticated SELECT only, anon nothing', async () => {
    for (const p of ALL_PRIVS) {
      const { rows } = await db.query(`SELECT has_table_privilege('authenticated', 'public.challenges', $1) AS a,
                                              has_table_privilege('anon', 'public.challenges', $1) AS n`, [p])
      expect(rows[0], p).toEqual({ a: p === 'SELECT', n: false })
    }
  })
})

describe("the policy's window is the phone's rule (shared/challenge-wrapped.js, 14 days)", () => {
  beforeAll(async () => { db = new PGlite() }, 60_000)
  afterAll(() => db?.close())

  // Noon Dublin on days around both 2026 clock changes (29 Mar, 25 Oct) and today's season.
  const NOONS = ['2026-03-27T12:00:00Z', '2026-03-30T11:00:00Z', '2026-04-10T11:00:00Z',
    '2026-09-30T11:00:00Z', '2026-10-24T11:00:00Z', '2026-10-26T12:00:00Z', '2026-11-06T12:00:00Z']

  // The migration's own member-window expression, with now() pinned to $1, so
  // this parity is proven for the text the file writes, not a copy of it.
  const WINDOW = MIG_686.match(/\(ends_on >= (\(\(now\(\) AT TIME ZONE 'Europe\/Dublin'\)::date - 14\))\)/)?.[1]

  it("reads the window from the migration's ALTER POLICY", () => {
    expect(WINDOW).toBe("((now() AT TIME ZONE 'Europe/Dublin')::date - 14)")
  })

  it('a member reads a challenge exactly while it is running/upcoming or the phone offers its Wrapped', async () => {
    const atNoon = WINDOW.replace('now()', '$1::timestamptz')
    for (const noon of NOONS) {
      const nowMs = Date.parse(noon)
      for (let k = -17; k <= 2; k++) {
        const { rows } = await db.query(
          `SELECT ((($1::timestamptz AT TIME ZONE 'Europe/Dublin')::date + $2::int))::text AS ends_on,
                  (($1::timestamptz AT TIME ZONE 'Europe/Dublin')::date + $2::int) >= ${atNoon} AS policy`,
          [noon, k])
        const ch = { is_flagship: true, starts_on: '2026-01-01', ends_on: rows[0].ends_on }
        const notEnded = challengeWindowMs(ch).toMs > nowMs
        expect(rows[0].policy, `${noon} ends_on ${rows[0].ends_on}`).toBe(notEnded || endedRecentlyFlagship(ch, nowMs, 14))
      }
    }
  }, 60_000)
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_686) {
    await boot({ before })
    const policyBefore = await policies()
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    expect(await policies()).toEqual(policyBefore)
  }

  it('when the policy did not start as the 30 Sep text', () => expectAbort(
    `ALTER POLICY challenges_read ON public.challenges USING (true);`,
    /mig 686: public\.challenges did not start with exactly the 30 Sep challenges_read policy/,
  ), 60_000)

  it('when a second policy exists', () => expectAbort(
    `CREATE POLICY challenges_extra ON public.challenges FOR SELECT TO authenticated USING (true);`,
    /mig 686: public\.challenges did not start with exactly the 30 Sep challenges_read policy/,
  ), 60_000)

  it('when the file would write a different window', () => {
    const NEEDLE = "'Europe/Dublin')::date - 14))"
    expect(MIG_686.split(NEEDLE).length).toBe(2)   // the ALTER only (the self-check's text reads "'Europe/Dublin'::text))")
    return expectAbort('', /mig 686: public\.challenges should keep exactly challenges_read/,
      MIG_686.replace(NEEDLE, "'Europe/Dublin')::date - 30))"))
  }, 60_000)

  it('when a client role holds more than SELECT', () => expectAbort(
    `GRANT UPDATE ON public.challenges TO authenticated;`,
    /mig 686: client roles hold more than SELECT on public\.challenges: authenticated:UPDATE/,
  ), 60_000)

  it('when anon holds SELECT', () => expectAbort(
    `GRANT SELECT ON public.challenges TO anon;`,
    /mig 686: client roles hold more than SELECT on public\.challenges: anon:SELECT/,
  ), 60_000)

  it('when RLS is off', () => expectAbort(
    `ALTER TABLE public.challenges DISABLE ROW LEVEL SECURITY;`,
    /mig 686: row level security is off on public\.challenges/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_686)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep policy exactly (and so the gap)', async () => {
    await boot()
    const before = await policies()
    await runSql(MIG_686)
    await runSql(ROLLBACK_686)
    expect(await policies()).toEqual(before)
    expect(await ids(member)).toEqual(MEMBER_BEFORE)
  }, 60_000)
})
