// GLOFOXSIBLING.1 — behavioural test for migration 758.
//
// Builds prod's state the way the 732 test does (the shared fixture in
// tests/helpers/contacts-resolvers-699-fixture.js: post-677 privileges, the
// REAL 690 and 691 files; then the REAL 699, 731 and 732 files, with
// contact_memberships and un1t_clients as 722/726 left them), and applies the
// REAL 758 file. Then:
//   * a contact who lives elsewhere and is linked by a glofox_crossover_members
//     row at B is readable by staff holding Contacts at B; not by staff
//     without Contacts at B; a row at a studio where the caller lacks Contacts
//     grants nothing; a relink moves the visibility (the live row is read);
//   * 732's un1t_clients and 731's membership cases still hold;
//   * glofox_crossover_members is closed to signed-in sessions (read and write)
//     and to anon;
//   * crossover_contact_ids returns the Glofox crossover (distinct; own studio
//     excluded) and stays service_role only;
//   * the policy text is 731's, untouched; the helper is an InitPlan; the file
//     is idempotent; abort cases; the rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_D, ORG1, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'

const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')
const MIG_732 = mig('732_contacts_read_by_studio_client.sql')
const MIG_758 = mig('758_glofox_crossover_members.sql')

const QUAL_731 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))'
const HELPER = 'private.auth_contact_membership_contact_ids()'
const CROSS = 'public.crossover_contact_ids(uuid)'
const MD5_732_HELPER = '1746a3d246350da442317c60b031f198'
const MD5_732_CROSS = '2405785fc7747bfd34dd08a9fe7f20af'
const MD5_758_HELPER = '7cd4abc90399d971eb0c7f347dd63da4'
const MD5_758_CROSS = 'b9489caf0954b06c3102d802133013e8'
const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

const section = (sql, from, to) => {
  const i = sql.indexOf(from)
  const j = sql.indexOf(to, i)
  if (i < 0 || j < 0) throw new Error(`section not found: ${from}`)
  return sql.slice(i, j + to.length)
}
// The rollback record in 758's header: sections 1 and 3 of mig 732, verbatim.
const ROLLBACK_758 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${section(MIG_732, 'CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()',
    'GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;')}
${section(MIG_732, 'CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)',
    'GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;')}
COMMIT;
`

const C_A = IDS.C_MEMBER        // lives at A
const C_A2 = IDS.C_MEMBER2      // lives at A: the Glofox crossover member at B
const C_B = IDS.C_B             // lives at B
const C_C1 = '30000000-0000-0000-0000-0000000000c1'
const C_D1 = '30000000-0000-0000-0000-0000000000d1'

// 731 + 732's fixture, as the 732 test builds it.
const BEFORE2 = `
  ALTER TABLE public.deals ADD COLUMN contact_id uuid;
  CREATE TABLE public.contact_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
    contact_id uuid NOT NULL, source text NOT NULL, plan_name text NOT NULL DEFAULT 'Plan',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')));
  ALTER TABLE public.contact_memberships ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.contact_memberships FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_memberships TO service_role;
  ${MIG_251}
  INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, status) VALUES
    ('${ORG1}', '${LOC_B}', '${C_C1}', 'un1t_online_api', 'active'),
    ('${ORG1}', '${LOC_A}', '${C_D1}', 'un1t_online_export', 'active');
  INSERT INTO public.deals (location_id, contact_id) VALUES ('${LOC_B}', '${C_A}');
  CREATE TABLE public.un1t_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL, status text,
    UNIQUE (location_id, un1t_user_id));
  ALTER TABLE public.un1t_clients ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.un1t_clients FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_clients TO service_role;
  INSERT INTO public.un1t_clients (location_id, un1t_user_id, contact_id, status) VALUES
    ('${LOC_B}', 'u-b-1', '${C_D1}', 'inactive');
`
// Rows the Glofox sync would write once 758 exists.
const GLOFOX_ROWS = `
  INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id) VALUES
    ('${LOC_B}', 'gf-b-1', '${C_A2}'),
    ('${LOC_B}', 'gf-b-2', '${C_B}'),
    ('${LOC_D}', 'gf-d-1', '${C_A}');
`

const boot758 = async () => {
  const db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731, MIG_732, MIG_758] })
  await db['exec'](GLOFOX_ROWS)
  return db
}
const count = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const sees = async (db, uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1
const crossover = async (db, loc) => (await asRole(db, 'service_role',
  `SELECT contact_id::text AS id FROM public.crossover_contact_ids('${loc}') ORDER BY 1`)).map((r) => r.id)

describe('before 758: prod with 690 + 691 + 699 + 731 + 732 applied', () => {
  let db
  beforeAll(async () => { db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731, MIG_732] }) }, 60_000)
  afterAll(() => db?.close())

  it("prod's bodies are 732's (the md5s 758's pre-check accepts); a Glofox member living elsewhere is invisible", async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_732_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_732_CROSS)
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(false)
    expect(await count(db, IDS.STAFF_B)).toBe(3)   // C_B, C_C1 (member), C_D1 (un1t client)
  })
})

describe('after 758', () => {
  let db
  beforeAll(async () => { db = await boot758() }, 60_000)
  afterAll(() => db?.close())

  it('Contacts at B + a glofox_crossover_members row at B on a contact living elsewhere: readable', async () => {
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)
    expect(await count(db, IDS.STAFF_B)).toBe(4)
  })

  it('a row at a studio where the caller lacks Contacts grants nothing', async () => {
    // C_A is a Glofox crossover member at D only; nobody here holds Contacts at D
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
  })

  it('a relink moves the visibility with it (the live row is read)', async () => {
    await db.query(`UPDATE public.glofox_crossover_members SET contact_id = $1 WHERE glofox_member_id = 'gf-b-1'`, [C_A])
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(true)
    await db.query(`UPDATE public.glofox_crossover_members SET contact_id = $1 WHERE glofox_member_id = 'gf-b-1'`, [C_A2])
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)
  })

  it('no Contacts at B: not readable (override, deactivated profile)', async () => {
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}'
      WHERE profile_id = $1 AND location_id = $2`, [IDS.STAFF_B, LOC_B])
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(false)
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.STAFF_B])
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(false)
    await db.query(`UPDATE public.profiles SET active = true WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)
  })

  it("731's membership and 732's un1t client branches still hold", async () => {
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)   // active member at B
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)   // un1t client at B
    expect(await sees(db, IDS.STAFF_A, C_D1)).toBe(true)   // active member at A
  })

  it('members and masters unchanged; the table is closed to every client session', async () => {
    expect(await count(db, IDS.MEMBER_UID)).toBe(1)
    for (const sql of [
      'SELECT id FROM public.glofox_crossover_members',
      `INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id) VALUES ('${LOC_B}', 'x', '${C_A}')`,
      `DELETE FROM public.glofox_crossover_members`,
    ]) {
      await expect(asUser(db, IDS.STAFF_B, sql)).rejects.toThrow(/permission denied for table glofox_crossover_members/)
      await expect(asRole(db, 'anon', sql)).rejects.toThrow(/permission denied for table glofox_crossover_members/)
    }
    const { rows: [r] } = await db.query(`SELECT relrowsecurity rls,
        (SELECT count(*)::int FROM pg_policies WHERE tablename = 'glofox_crossover_members') policies
      FROM pg_class WHERE oid = 'public.glofox_crossover_members'::regclass`)
    expect(r).toEqual({ rls: true, policies: 0 })
  })

  it('one row per (studio, Glofox member id)', async () => {
    await expect(db.query(`INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id)
      VALUES ($1, 'gf-b-1', $2)`, [LOC_B, C_A])).rejects.toThrow(/duplicate key/)
    await expect(db.query(`INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id)
      VALUES ($1, '  ', $2)`, [LOC_B, C_A])).rejects.toThrow(/check constraint/)
  })

  it('the helper: 758 body, DEFINER, STABLE, search_path pinned; authenticated + service_role only', async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_758_HELPER)
    const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c,
        has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
        has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [HELPER])
    expect(r).toEqual({ d: true, v: 's', c: ['search_path=""'], a: true, n: false })
  })

  it('crossover_contact_ids returns the Glofox crossover, distinct; own-studio rows excluded; service_role only', async () => {
    // B: C_A by deal; C_C1 by membership; C_D1 by un1t client; C_A2 by Glofox; C_B lives at B
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_A2, C_C1, C_D1].sort())
    expect(await crossover(db, LOC_D)).toEqual([C_A])
    expect(await md5Of(db, CROSS)).toBe(MD5_758_CROSS)
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(db, role, `SELECT * FROM public.crossover_contact_ids('${LOC_B}')`)).rejects.toThrow(/permission denied for function crossover_contact_ids/)
    }
  })

  it('the helper is an InitPlan, run once per statement, never a per-row SubPlan', async () => {
    const rows = await asUser(db, IDS.STAFF_B, 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT id FROM public.contacts')
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).not.toMatch(/SubPlan/)
    const ids = plan.match(/\bid = ANY \(\(InitPlan (\d+)\)\.col1\)/)?.[1]
    expect(ids, plan).toBeTruthy()
    const lines = plan.split('\n')
    const i = lines.findIndex((l) => l.trim() === `InitPlan ${ids}`)
    expect(lines[i + 1], plan).toMatch(/\bloops=1\b/)
  })

  it("the policy is 731's, untouched", async () => {
    expect(await policiesOf(db, ['contacts'])).toEqual([{ tablename: 'contacts', policyname: 'contacts_select', permissive: 'PERMISSIVE',
      cmd: 'SELECT', roles: '{public}', qual: QUAL_731, with_check: null }])
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_758)).resolves.toBeDefined()
    expect(await md5Of(db, HELPER)).toBe(MD5_758_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_758_CROSS)
    expect(await count(db, IDS.STAFF_B)).toBe(4)
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })
  const prepAfter = async (edit) => {
    db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731, MIG_732] })
    await db['exec'](edit)
    await signedOut(db)
  }
  const noTable = async () => {
    expect((await db.query(`SELECT to_regclass('public.glofox_crossover_members') AS t`)).rows[0].t).toBeNull()
  }

  it('when the read helper was edited by hand', async () => {
    await prepAfter(`CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids() RETURNS uuid[]
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$ SELECT '{}'::uuid[] $f$;`)
    expect(await abortMessage(db, MIG_758)).toMatch(/mig 758: private\.auth_contact_membership_contact_ids\(\) is not the mig 732 body/)
    await noTable()
  }, 60_000)

  it('when crossover_contact_ids was edited by hand', async () => {
    await prepAfter(`CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid) RETURNS TABLE (contact_id uuid)
      LANGUAGE sql STABLE SET search_path = '' AS $f$ SELECT NULL::uuid $f$;`)
    expect(await abortMessage(db, MIG_758)).toMatch(/mig 758: public\.crossover_contact_ids\(uuid\) is not the mig 732 body/)
    expect(await md5Of(db, HELPER)).toBe(MD5_732_HELPER)
    await noTable()
  }, 60_000)

  it('when contacts_select was changed by hand', async () => {
    await prepAfter(`ALTER POLICY contacts_select ON public.contacts USING (true);`)
    expect(await abortMessage(db, MIG_758)).toMatch(/mig 758: public\.contacts does not have exactly the mig 731 contacts_select policy/)
    await noTable()
  }, 60_000)

  it('when 732 was never applied', async () => {
    db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731] })
    await signedOut(db)
    expect(await abortMessage(db, MIG_758)).toMatch(/mig 758: private\.auth_contact_membership_contact_ids\(\) is not the mig 732 body/)
    await noTable()
  }, 60_000)
})

describe('the file carries no placeholder', () => {
  it('ends with the self-check and COMMIT, never touches the policy, and carries no unfilled md5', () => {
    expect(MIG_758).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    expect(MIG_758).not.toMatch(/^\s*ALTER\s+POLICY/im)
    expect(MIG_758).not.toMatch(/@@/)
  })
})

describe("the header's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it("restores 732's two bodies; the policy is unchanged; 758 applies again", async () => {
    db = await boot758()
    await db['exec'](ROLLBACK_758)
    expect(await md5Of(db, HELPER)).toBe(MD5_732_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_732_CROSS)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)   // 732's un1t client
    await signedOut(db)
    await db['exec'](MIG_758)
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)
  }, 60_000)
})
