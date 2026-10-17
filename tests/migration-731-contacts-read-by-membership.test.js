// UN1TDUAL.1 — behavioural test for migration 731.
//
// Builds prod's state the way the SEC-3 replay does (the shared fixture in
// tests/helpers/contacts-resolvers-699-fixture.js: post-677 privileges, the
// pre-690/691 policies verbatim, the REAL 690 and 691 files), then the REAL
// 699 file (prod's current Contacts resolver, org-admin tier included), adds
// what 731 reads (contact_memberships as mig 722 left it: RLS on, no policy,
// no client privilege; deals.contact_id; the REAL mig 251 crossover RPC), and
// applies the REAL 731 file. Then:
//   * a contact who lives at A with an ACTIVE membership at B is readable by
//     staff holding Contacts at B; an ended membership is not; nor is it for
//     staff without Contacts at B (per-user override, studio switch,
//     deactivated profile: the resolver's tiers apply through the delegation);
//   * the org-admin tier (699) and role templates apply too;
//   * members and masters unchanged; signed-in sessions still cannot read
//     contact_memberships; anon cannot execute the helper;
//   * crossover_contact_ids returns the membership crossover (distinct, the
//     contact's own studio and ended memberships excluded) and stays
//     service_role only;
//   * both helpers are InitPlans (EXPLAIN); the policy text; idempotent;
//     abort cases; the rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, ORG1, ORG_ADMIN, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'

const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')

// pg_policies.qual: 690's (699 left it) and PostgreSQL 17's deparse of 731's.
const QUAL_690 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)))'
const QUAL_731 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))'
const HELPER = 'private.auth_contact_membership_contact_ids()'
const CROSS = 'public.crossover_contact_ids(uuid)'
const MD5_251 = '7d7ec5a504dbfdf6a4ab64cc0362901c'
const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

// The rollback record in 731's header, with mig 251 verbatim.
const ROLLBACK_731 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER POLICY contacts_select ON public.contacts USING (
  location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])
  OR user_id = (SELECT auth.uid()));
${MIG_251}
DROP FUNCTION private.auth_contact_membership_contact_ids();
COMMIT;
`

const C_A = IDS.C_MEMBER                                // a contact living at A
const C_B = IDS.C_B                                     // a contact living at B
const C_C1 = '30000000-0000-0000-0000-0000000000c1'     // lives at C (ORG1, inactive): active member at B
const C_D1 = '30000000-0000-0000-0000-0000000000d1'     // lives at D (ORG2): ended at B, active at A
const M_B_C1 = '40000000-0000-0000-0000-000000000001'

// What 731 reads, as prod holds it (722 + 726; deals.contact_id; mig 251).
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
  INSERT INTO public.contact_memberships (id, organization_id, location_id, contact_id, source, status) VALUES
    ('${M_B_C1}', '${ORG1}', '${LOC_B}', '${C_C1}', 'un1t_online_api', 'active'),
    (gen_random_uuid(), '${ORG1}', '${LOC_B}', '${C_D1}', 'un1t_online_export', 'ended'),
    (gen_random_uuid(), '${ORG1}', '${LOC_A}', '${C_D1}', 'un1t_online_export', 'active'),
    (gen_random_uuid(), '${ORG1}', '${LOC_B}', '${C_B}', 'un1t_online_api', 'active');
  INSERT INTO public.deals (location_id, contact_id) VALUES ('${LOC_B}', '${C_A}'), ('${LOC_B}', '${C_C1}');
`

const boot731 = (opts = {}) => bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731], ...opts })
const count = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const sees = async (db, uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1
const crossover = async (db, loc) => (await asRole(db, 'service_role',
  `SELECT contact_id::text AS id FROM public.crossover_contact_ids('${loc}') ORDER BY 1`)).map((r) => r.id)

describe('before 731: prod with 690 + 691 + 699 applied', () => {
  let db
  beforeAll(async () => { db = await bootProd({ before2: BEFORE2, migrate: [MIG_699] }) }, 60_000)
  afterAll(() => db?.close())

  it('a member of B who lives elsewhere is invisible to B staff; the RPC knows deals only', async () => {
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(false)
    expect(await count(db, IDS.STAFF_B)).toBe(1)
    expect(await crossover(db, LOC_A)).toEqual([])
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_690)
    expect(await md5Of(db, CROSS)).toBe(MD5_251)
  })
})

describe('after 731', () => {
  let db
  beforeAll(async () => { db = await boot731() }, 60_000)
  afterAll(() => db?.close())

  it('Contacts at B + an active membership at B on a contact living elsewhere: readable', async () => {
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
    expect(await sees(db, IDS.STAFF_B, C_B)).toBe(true)
    expect(await count(db, IDS.STAFF_B)).toBe(2)
    // staff at A only: A's contacts plus A's active member who lives at D; not B's member
    expect(await sees(db, IDS.STAFF_A, C_D1)).toBe(true)
    expect(await sees(db, IDS.STAFF_A, C_C1)).toBe(false)
    expect(await count(db, IDS.STAFF_A)).toBe(4)
  })

  it('an ended membership: not readable (and ending an active one closes it)', async () => {
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(false)   // ended at B (active only at A)
    await db.query(`UPDATE public.contact_memberships SET status = 'ended' WHERE id = $1`, [M_B_C1])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(false)
    await db.query(`UPDATE public.contact_memberships SET status = 'active' WHERE id = $1`, [M_B_C1])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
  })

  it('no Contacts at B: not readable (override, studio switch, deactivated profile)', async () => {
    const off = async () => {
      expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(false)
      expect(await count(db, IDS.STAFF_B)).toBe(0)
    }
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}'
      WHERE profile_id = $1 AND location_id = $2`, [IDS.STAFF_B, LOC_B])
    await off()
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.STAFF_B])
    await db.query(`UPDATE public.locations SET features = '{"contacts": false}' WHERE id = $1`, [LOC_B])
    await off()
    await db.query(`UPDATE public.locations SET features = '{}' WHERE id = $1`, [LOC_B])
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [IDS.STAFF_B])
    await off()
    await db.query(`UPDATE public.profiles SET active = true WHERE id = $1`, [IDS.STAFF_B])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
  })

  it("the org-admin tier and role templates apply through the delegation (699)", async () => {
    // owner of A by the org tier: A's member living at D; B's owner template turns Contacts off
    expect(await sees(db, ORG_ADMIN, C_D1)).toBe(true)
    expect(await sees(db, ORG_ADMIN, C_C1)).toBe(false)
    expect(await count(db, ORG_ADMIN)).toBe(4)
  })

  it('members and masters unchanged; contact_memberships still closed to signed-in sessions', async () => {
    expect(await count(db, IDS.MEMBER_UID)).toBe(1)
    expect(await count(db, IDS.MASTER)).toBe(6)
    await expect(asUser(db, IDS.STAFF_B, 'SELECT id FROM public.contact_memberships')).rejects.toThrow(/permission denied for table contact_memberships/)
  })

  it('the helper: DEFINER, STABLE, search_path pinned, uuid[]; authenticated + service_role only, never anon', async () => {
    const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c, prorettype::regtype::text t,
        has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
        has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') s,
        has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n,
        has_function_privilege('public', to_regprocedure($1), 'EXECUTE') p
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [HELPER])
    expect(r).toEqual({ d: true, v: 's', c: ['search_path=""'], t: 'uuid[]', a: true, s: true, n: false, p: false })
    await expect(asRole(db, 'anon', `SELECT ${HELPER}`)).rejects.toThrow(/permission denied for function auth_contact_membership_contact_ids/)
    await expect(asRole(db, 'anon', 'SELECT id FROM public.contacts')).rejects.toThrow(/permission denied for table contacts/)
  })

  it('crossover_contact_ids returns the membership crossover, distinct; service_role only', async () => {
    expect(await crossover(db, LOC_A)).toEqual([C_D1])
    // C_A by deal; C_C1 by deal AND membership, once; C_D1 ended; C_B lives at B
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_C1].sort())
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(db, role, `SELECT * FROM public.crossover_contact_ids('${LOC_B}')`)).rejects.toThrow(/permission denied for function crossover_contact_ids/)
    }
    const { rows: [r] } = await db.query(`SELECT prosecdef d FROM pg_proc WHERE oid = to_regprocedure($1)`, [CROSS])
    expect(r.d).toBe(false)
  })

  it('both helpers are InitPlans, run once per statement, never a per-row SubPlan', async () => {
    const rows = await asUser(db, IDS.STAFF_B, 'EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT id FROM public.contacts')
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).not.toMatch(/SubPlan/)
    const loc = plan.match(/location_id = ANY \(\(InitPlan (\d+)\)\.col1\)/)?.[1]
    const ids = plan.match(/\bid = ANY \(\(InitPlan (\d+)\)\.col1\)/)?.[1]
    expect(loc, plan).toBeTruthy()
    expect(ids, plan).toBeTruthy()
    const lines = plan.split('\n')
    for (const n of [loc, ids]) {
      const i = lines.findIndex((l) => l.trim() === `InitPlan ${n}`)
      expect(lines[i + 1], plan).toMatch(/\bloops=1\b/)
    }
  })

  it('one policy, same name/command/roles, the new USING, no WITH CHECK', async () => {
    expect(await policiesOf(db, ['contacts'])).toEqual([{ tablename: 'contacts', policyname: 'contacts_select', permissive: 'PERMISSIVE',
      cmd: 'SELECT', roles: '{public}', qual: QUAL_731, with_check: null }])
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_731)).resolves.toBeDefined()
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect(await count(db, IDS.STAFF_B)).toBe(2)
    expect(await crossover(db, LOC_A)).toEqual([C_D1])
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })
  const prep = (extra) => bootProd({ before2: BEFORE2 + extra, migrate: [MIG_699] })
  const helperGone = async () => (await db.query(`SELECT to_regprocedure('${HELPER}') AS fn`)).rows[0].fn === null

  it('when contacts_select was changed by hand', async () => {
    db = await prep(`ALTER POLICY contacts_select ON public.contacts USING (true);`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_731)).toMatch(/mig 731: public\.contacts does not have exactly the mig 690 contacts_select policy/)
    expect(await helperGone()).toBe(true)
  }, 60_000)

  it('when crossover_contact_ids was edited by hand', async () => {
    db = await prep(`CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid) RETURNS TABLE (contact_id uuid)
      LANGUAGE sql STABLE SET search_path = '' AS $f$ SELECT NULL::uuid $f$;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_731)).toMatch(/mig 731: public\.crossover_contact_ids\(uuid\) is not the mig 251 body/)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_690)
  }, 60_000)

  it('when a client can read contact_memberships', async () => {
    db = await prep(`GRANT SELECT ON public.contact_memberships TO authenticated;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_731)).toMatch(/mig 731: contact_memberships is readable by a client/)
    expect(await helperGone()).toBe(true)
  }, 60_000)

  it('when a client holds a COLUMN-level SELECT on contact_memberships (has_table_privilege cannot see it)', async () => {
    db = await prep(`GRANT SELECT (contact_id) ON public.contact_memberships TO authenticated;`)
    expect((await db.query(`SELECT has_table_privilege('authenticated', 'public.contact_memberships', 'SELECT') AS t`)).rows[0].t).toBe(false)
    await signedOut(db)
    expect(await abortMessage(db, MIG_731)).toMatch(/mig 731: contact_memberships is readable by a client/)
    expect(await helperGone()).toBe(true)
  }, 60_000)

  it('when anon holds a COLUMN-level SELECT on contact_memberships', async () => {
    db = await prep(`GRANT SELECT (status) ON public.contact_memberships TO anon;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_731)).toMatch(/mig 731: contact_memberships is readable by a client/)
    expect(await helperGone()).toBe(true)
  }, 60_000)
})

describe('the file carries no placeholder', () => {
  it('no "later sections go here" marker left above COMMIT', () => {
    expect(MIG_731).not.toMatch(/Later UN1TDUAL sections/i)
    expect(MIG_731).toMatch(/END \$\$;\s*COMMIT;\s*$/)
  })
})

describe("the header's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it('restores the 690 policy and the 251 RPC, drops the helper; 731 applies again', async () => {
    db = await boot731()
    await db['exec'](ROLLBACK_731)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_690)
    expect(await md5Of(db, CROSS)).toBe(MD5_251)
    expect((await db.query(`SELECT to_regprocedure('${HELPER}') AS fn`)).rows[0].fn).toBeNull()
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(false)
    await signedOut(db)
    await db['exec'](MIG_731)
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
  }, 60_000)
})
