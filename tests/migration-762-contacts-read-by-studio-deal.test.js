// ORGCONTACTS.0 — behavioural test for migration 762.
//
// Builds prod's state the way the 758 test does (the shared fixture in
// tests/helpers/contacts-resolvers-699-fixture.js: post-677 privileges, the
// REAL 690 and 691 files; then the REAL 699, 731, 732 and 758 files with
// contact_memberships, un1t_clients and glofox_crossover_members as their
// migrations left them), and applies the REAL 762 file. Then:
//   * a contact who lives elsewhere and holds a DEAL at B is readable by staff
//     holding Contacts at B (the phone directory's deal-only crossovers, which
//     crossover_contact_ids returned since mig 251 but RLS never admitted);
//     not by staff without Contacts at B; a deal at a studio where the caller
//     lacks Contacts grants nothing;
//   * 731's, 732's and 758's branches still hold;
//   * the policy text is 731's, untouched; the helper is an InitPlan; the file
//     is idempotent; abort cases; the rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_D, ORG1, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'

const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')
const MIG_732 = mig('732_contacts_read_by_studio_client.sql')
const MIG_758 = mig('758_glofox_crossover_members.sql')
const MIG_762 = mig('762_contacts_read_by_studio_deal.sql')

const QUAL_731 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))'
const HELPER = 'private.auth_contact_membership_contact_ids()'
const CROSS = 'public.crossover_contact_ids(uuid)'
const MD5_758_HELPER = '7cd4abc90399d971eb0c7f347dd63da4'
const MD5_758_CROSS = 'b9489caf0954b06c3102d802133013e8'
const MD5_762_HELPER = '65daa4835035bf30cad782fdd7bc6e4e'
const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

const section = (sql, from, to) => {
  const i = sql.indexOf(from)
  const j = sql.indexOf(to, i)
  if (i < 0 || j < 0) throw new Error(`section not found: ${from}`)
  return sql.slice(i, j + to.length)
}
// The rollback record in 762's header: section 2 of mig 758, verbatim.
const ROLLBACK_762 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${section(MIG_758, 'CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()',
    'GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;')}
COMMIT;
`

const C_A = IDS.C_MEMBER        // lives at A: a deal at B (deal-only crossover)
const C_A2 = IDS.C_MEMBER2      // lives at A: a Glofox crossover member at B
const C_B = IDS.C_B             // lives at B
const C_C1 = '30000000-0000-0000-0000-0000000000c1'   // lives at C (ORG1, inactive): active member at B
const C_D1 = '30000000-0000-0000-0000-0000000000d1'   // lives at D (ORG2): un1t client at B
const C_C2 = '30000000-0000-0000-0000-0000000000c2'   // lives at C: a deal at D only

// 731 + 732 + 758's fixture, as the 758 test builds it, plus one contact
// (C_C2) with a deal at D, where nobody here holds Contacts.
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
  INSERT INTO public.contacts (id, location_id, user_id) VALUES ('${C_C2}', 'c0000000-0000-0000-0000-00000000000c', NULL)
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.contact_memberships (organization_id, location_id, contact_id, source, status) VALUES
    ('${ORG1}', '${LOC_B}', '${C_C1}', 'un1t_online_api', 'active'),
    ('${ORG1}', '${LOC_A}', '${C_D1}', 'un1t_online_export', 'active');
  INSERT INTO public.deals (location_id, contact_id) VALUES ('${LOC_B}', '${C_A}'), ('${LOC_D}', '${C_C2}');
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
const GLOFOX_ROWS = `
  INSERT INTO public.glofox_crossover_members (location_id, glofox_member_id, contact_id) VALUES
    ('${LOC_B}', 'gf-b-1', '${C_A2}'),
    ('${LOC_B}', 'gf-b-2', '${C_B}');
`

const boot = async (migrate) => {
  const db = await bootProd({ before2: BEFORE2, migrate })
  await db['exec'](GLOFOX_ROWS)
  return db
}
const boot762 = () => boot([MIG_699, MIG_731, MIG_732, MIG_758, MIG_762])
const count = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const sees = async (db, uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1

describe('before 762: prod with 690 + 691 + 699 + 731 + 732 + 758 applied', () => {
  let db
  beforeAll(async () => { db = await boot([MIG_699, MIG_731, MIG_732, MIG_758]) }, 60_000)
  afterAll(() => db?.close())

  it("prod's helper is 758's (the md5 762's pre-check accepts); a deal-only crossover is invisible", async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_758_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_758_CROSS)
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
    expect(await count(db, IDS.STAFF_B)).toBe(4)   // C_B, C_C1 (member), C_D1 (un1t client), C_A2 (Glofox)
  })
})

describe('after 762', () => {
  let db
  beforeAll(async () => { db = await boot762() }, 60_000)
  afterAll(() => db?.close())

  it('Contacts at B + a deal at B on a contact living elsewhere: readable; count is 5', async () => {
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(true)
    expect(await count(db, IDS.STAFF_B)).toBe(5)
  })

  it('a deal at a studio where the caller lacks Contacts grants nothing', async () => {
    // C_C2 holds a deal at D only; nobody here holds Contacts at D
    expect(await sees(db, IDS.STAFF_B, C_C2)).toBe(false)
    expect(await sees(db, IDS.STAFF_A, C_C2)).toBe(false)
  })

  it('no Contacts at B: not readable (override, deactivated profile)', async () => {
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}'
      WHERE profile_id = $1 AND location_id = $2`, [IDS.STAFF_B, LOC_B])
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.STAFF_B])
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
    await db.query(`UPDATE public.profiles SET active = true WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(true)
  })

  it("731's, 732's and 758's branches still hold", async () => {
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)   // active member at B
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)   // un1t client at B
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)   // Glofox crossover at B
    expect(await sees(db, IDS.STAFF_A, C_D1)).toBe(true)   // active member at A
  })

  it('members and masters unchanged', async () => {
    expect(await count(db, IDS.MEMBER_UID)).toBe(1)
  })

  it('the helper: 762 body, DEFINER, STABLE, search_path pinned; authenticated + service_role only', async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_762_HELPER)
    const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c,
        has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
        has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [HELPER])
    expect(r).toEqual({ d: true, v: 's', c: ['search_path=""'], a: true, n: false })
  })

  it('crossover_contact_ids is untouched (758 body; it already returned deal holders)', async () => {
    expect(await md5Of(db, CROSS)).toBe(MD5_758_CROSS)
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
    await expect(db['exec'](MIG_762)).resolves.toBeDefined()
    expect(await md5Of(db, HELPER)).toBe(MD5_762_HELPER)
    expect(await count(db, IDS.STAFF_B)).toBe(5)
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })
  const prepAfter = async (edit) => {
    db = await boot([MIG_699, MIG_731, MIG_732, MIG_758])
    await db['exec'](edit)
    await signedOut(db)
  }

  it('when the read helper was edited by hand', async () => {
    await prepAfter(`CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids() RETURNS uuid[]
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$ SELECT '{}'::uuid[] $f$;`)
    expect(await abortMessage(db, MIG_762)).toMatch(/mig 762: private\.auth_contact_membership_contact_ids\(\) is not the mig 758 body/)
  }, 60_000)

  it('when contacts_select was changed by hand', async () => {
    await prepAfter(`ALTER POLICY contacts_select ON public.contacts USING (true);`)
    expect(await abortMessage(db, MIG_762)).toMatch(/mig 762: public\.contacts does not have exactly the mig 731 contacts_select policy/)
    expect(await md5Of(db, HELPER)).toBe(MD5_758_HELPER)
  }, 60_000)

  it('when 758 was never applied', async () => {
    db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731, MIG_732] })
    await signedOut(db)
    expect(await abortMessage(db, MIG_762)).toMatch(/mig 762: private\.auth_contact_membership_contact_ids\(\) is not the mig 758 body/)
  }, 60_000)
})

describe('the file carries no placeholder', () => {
  it('ends with the self-check and COMMIT, never touches the policy or the RPC, and carries no unfilled md5', () => {
    expect(MIG_762).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    expect(MIG_762).not.toMatch(/^\s*ALTER\s+POLICY/im)
    expect(MIG_762).not.toMatch(/CREATE OR REPLACE FUNCTION public\.crossover_contact_ids/)
    expect(MIG_762).not.toMatch(/@@/)
    expect(MD5_762_HELPER).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("the header's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it("restores 758's helper; the policy is unchanged; 762 applies again", async () => {
    db = await boot762()
    await db['exec'](ROLLBACK_762)
    expect(await md5Of(db, HELPER)).toBe(MD5_758_HELPER)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, C_A2)).toBe(true)   // 758's Glofox crossover
    await signedOut(db)
    await db['exec'](MIG_762)
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(true)
  }, 60_000)
})
