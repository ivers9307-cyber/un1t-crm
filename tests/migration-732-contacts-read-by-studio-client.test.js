// UN1TDUAL.4 — behavioural test for migration 732.
//
// Builds prod's state the way the 731 test does (the shared fixture in
// tests/helpers/contacts-resolvers-699-fixture.js: post-677 privileges, the
// REAL 690 and 691 files; then the REAL 699 and 731 files), adds what 732
// reads (un1t_clients as mig 726 left it: RLS on, no policy, no client
// privilege), and applies the REAL 732 file. Then:
//   * a contact who lives elsewhere and is linked by a un1t_clients row at B
//     is readable by staff holding Contacts at B, whatever the un1t status;
//     not by staff without Contacts at B (per-user override, studio switch,
//     deactivated profile); an unlinked row (contact_id NULL) grants nothing;
//     a row at a studio where the caller lacks Contacts grants nothing;
//   * a relink moves the visibility with it (the live row is read);
//   * 731's membership cases still hold; the org-admin tier applies;
//   * members and masters unchanged; un1t_clients still closed to signed-in
//     sessions;
//   * crossover_contact_ids returns the client crossover (distinct; own
//     studio and unlinked rows excluded) and stays service_role only;
//   * the policy text is 731's, untouched; both helpers are InitPlans
//     (EXPLAIN); idempotent; abort cases; the rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { mig, LOC_A, LOC_B, LOC_D, ORG1, ORG_ADMIN, signedOut, bootProd } from './helpers/contacts-resolvers-699-fixture.js'

const MIG_251 = mig('251_crossover_contact_ids_rpc.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')
const MIG_731 = mig('731_contacts_read_by_studio_membership.sql')
const MIG_732 = mig('732_contacts_read_by_studio_client.sql')

// pg_policies.qual after 731 (PostgreSQL 17's deparse); 732 must not change it.
const QUAL_731 = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)) OR (id = ANY (( SELECT private.auth_contact_membership_contact_ids() AS auth_contact_membership_contact_ids)::uuid[])))'
const HELPER = 'private.auth_contact_membership_contact_ids()'
const CROSS = 'public.crossover_contact_ids(uuid)'
// normalised md5 (comments and whitespace stripped), as 731/732 compute it
const MD5_731_HELPER = 'e71c67259c144a3baf7788d041e722cb'
const MD5_731_CROSS = '5e05a258fd9a91b4be4c969034e4c232'
const MD5_732_HELPER = '1746a3d246350da442317c60b031f198'
const MD5_732_CROSS = '2405785fc7747bfd34dd08a9fe7f20af'
const md5Of = async (db, fn) => (await db.query(`SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h
  FROM pg_proc WHERE oid = to_regprocedure($1)`, [fn])).rows[0]?.h

// The rollback record in 732's header: sections 1 and 3 of mig 731, verbatim.
const section = (sql, from, to) => {
  const i = sql.indexOf(from)
  const j = sql.indexOf(to, i)
  if (i < 0 || j < 0) throw new Error(`section not found: ${from}`)
  return sql.slice(i, j + to.length)
}
const ROLLBACK_732 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${section(MIG_731, 'CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()',
    'GRANT EXECUTE ON FUNCTION private.auth_contact_membership_contact_ids() TO authenticated, service_role;')}
${section(MIG_731, 'CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid)',
    'GRANT EXECUTE ON FUNCTION public.crossover_contact_ids(uuid) TO service_role;')}
COMMIT;
`

const C_A = IDS.C_MEMBER                                // lives at A
const C_B = IDS.C_B                                     // lives at B
const C_C1 = '30000000-0000-0000-0000-0000000000c1'     // lives at C (ORG1, inactive): active member at B
const C_D1 = '30000000-0000-0000-0000-0000000000d1'     // lives at D (ORG2): ended at B, active at A
const M_B_C1 = '40000000-0000-0000-0000-000000000001'
const U_B_D1 = '50000000-0000-0000-0000-000000000001'   // un1t client at B, inactive, linked to C_D1
const U_B_NULL = '50000000-0000-0000-0000-000000000002' // un1t client at B, unmatched

// 731's fixture (contact_memberships as 722 left it; deals.contact_id; mig 251).
const BEFORE2_731 = `
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
// What 732 adds: un1t_clients as 726 left it (RLS on, no policy, service role only).
const UN1T_CLIENTS = `
  CREATE TABLE public.un1t_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, un1t_user_id text NOT NULL,
    contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL, status text,
    UNIQUE (location_id, un1t_user_id));
  CREATE INDEX un1t_clients_location_contact ON public.un1t_clients (location_id, contact_id);
  ALTER TABLE public.un1t_clients ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.un1t_clients FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.un1t_clients TO service_role;
  INSERT INTO public.un1t_clients (id, location_id, un1t_user_id, contact_id, status) VALUES
    ('${U_B_D1}', '${LOC_B}', 'u-b-1', '${C_D1}', 'inactive'),
    ('${U_B_NULL}', '${LOC_B}', 'u-b-2', NULL, 'active'),
    (gen_random_uuid(), '${LOC_B}', 'u-b-3', '${C_B}', 'active'),
    (gen_random_uuid(), '${LOC_B}', 'u-b-4', '${C_C1}', 'active'),
    (gen_random_uuid(), '${LOC_A}', 'u-a-1', '${C_C1}', 'blocked'),
    (gen_random_uuid(), '${LOC_D}', 'u-d-1', '${C_A}', 'active');
`
const BEFORE2 = BEFORE2_731 + UN1T_CLIENTS

const boot732 = (opts = {}) => bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731, MIG_732], ...opts })
const count = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const sees = async (db, uid, id) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.contacts WHERE id = '${id}'`))[0].n === 1
const crossover = async (db, loc) => (await asRole(db, 'service_role',
  `SELECT contact_id::text AS id FROM public.crossover_contact_ids('${loc}') ORDER BY 1`)).map((r) => r.id)

describe('before 732: prod with 690 + 691 + 699 + 731 applied', () => {
  let db
  beforeAll(async () => { db = await bootProd({ before2: BEFORE2, migrate: [MIG_699, MIG_731] }) }, 60_000)
  afterAll(() => db?.close())

  it('a un1t client of B who lives elsewhere (no active membership at B) is invisible to B staff', async () => {
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(false)
    expect(await count(db, IDS.STAFF_B)).toBe(2)
    expect(await sees(db, IDS.STAFF_A, C_C1)).toBe(false)
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_C1].sort())
    expect(await crossover(db, LOC_D)).toEqual([])
  })

  it("prod's bodies are 731's (the md5s 732's pre-check accepts)", async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_731_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_731_CROSS)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
  })
})

describe('after 732', () => {
  let db
  beforeAll(async () => { db = await boot732() }, 60_000)
  afterAll(() => db?.close())

  it('Contacts at B + a un1t_clients row at B on a contact living elsewhere: readable, whatever the un1t status', async () => {
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)    // 'inactive' client, ended membership
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)    // client AND active member: once
    expect(await sees(db, IDS.STAFF_B, C_B)).toBe(true)
    expect(await count(db, IDS.STAFF_B)).toBe(3)
    // staff at A: A's three, A's active member C_D1, and A's 'blocked' client C_C1
    expect(await sees(db, IDS.STAFF_A, C_C1)).toBe(true)
    expect(await count(db, IDS.STAFF_A)).toBe(5)
  })

  it('an unlinked un1t_clients row (contact_id NULL) grants nothing', async () => {
    const ids = await asUser(db, IDS.STAFF_B, `SELECT ${HELPER} AS ids`)
    expect(ids[0].ids.sort()).toEqual([C_B, C_C1, C_D1].sort())
    expect(ids[0].ids).not.toContain(null)
    // linking it to a contact opens that contact; unlinking closes it again
    await db.query(`UPDATE public.un1t_clients SET contact_id = $1 WHERE id = $2`, [IDS.C_MEMBER2, U_B_NULL])
    expect(await sees(db, IDS.STAFF_B, IDS.C_MEMBER2)).toBe(true)
    await db.query(`UPDATE public.un1t_clients SET contact_id = NULL WHERE id = $1`, [U_B_NULL])
    expect(await sees(db, IDS.STAFF_B, IDS.C_MEMBER2)).toBe(false)
  })

  it('a un1t_clients row at a studio where the caller lacks Contacts grants nothing', async () => {
    // C_A is a client at D only; nobody here holds Contacts at D
    expect(await sees(db, IDS.STAFF_B, C_A)).toBe(false)
  })

  it('a relink by the un1t sync moves the visibility with it (the live row is read)', async () => {
    await db.query(`UPDATE public.un1t_clients SET contact_id = $1 WHERE id = $2`, [IDS.C_MEMBER2, U_B_D1])
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, IDS.C_MEMBER2)).toBe(true)
    await db.query(`UPDATE public.un1t_clients SET contact_id = $1 WHERE id = $2`, [C_D1, U_B_D1])
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)
    expect(await sees(db, IDS.STAFF_B, IDS.C_MEMBER2)).toBe(false)
  })

  it('no Contacts at B: not readable (override, studio switch, deactivated profile)', async () => {
    const off = async () => {
      expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(false)
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
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)
  })

  it("731's membership cases still hold", async () => {
    // ending C_C1's membership at B leaves it readable only because it is also a client at B
    await db.query(`UPDATE public.contact_memberships SET status = 'ended' WHERE id = $1`, [M_B_C1])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
    await db.query(`DELETE FROM public.un1t_clients WHERE location_id = $1 AND contact_id = $2`, [LOC_B, C_C1])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(false)
    // an active membership alone still opens it
    await db.query(`UPDATE public.contact_memberships SET status = 'active' WHERE id = $1`, [M_B_C1])
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)
    // staff at A see A's active member who lives at D
    expect(await sees(db, IDS.STAFF_A, C_D1)).toBe(true)
    await db.query(`INSERT INTO public.un1t_clients (location_id, un1t_user_id, contact_id, status) VALUES ($1, 'u-b-4', $2, 'active')`, [LOC_B, C_C1])
  })

  it('the org-admin tier and role templates apply through the delegation (699)', async () => {
    // owner of A by the org tier: A's 'blocked' client C_C1; B's owner template turns Contacts off, so not C_D1 by B
    expect(await sees(db, ORG_ADMIN, C_C1)).toBe(true)
    expect(await sees(db, ORG_ADMIN, C_D1)).toBe(true)   // by the active membership at A
    expect(await count(db, ORG_ADMIN)).toBe(5)
    await db.query(`UPDATE public.contact_memberships SET status = 'ended' WHERE location_id = $1 AND contact_id = $2`, [LOC_A, C_D1])
    expect(await sees(db, ORG_ADMIN, C_D1)).toBe(false)  // the client row at B does not count: no Contacts at B
    await db.query(`UPDATE public.contact_memberships SET status = 'active' WHERE location_id = $1 AND contact_id = $2`, [LOC_A, C_D1])
  })

  it('members and masters unchanged; un1t_clients still closed to signed-in sessions', async () => {
    expect(await count(db, IDS.MEMBER_UID)).toBe(1)
    expect(await count(db, IDS.MASTER)).toBe(6)
    await expect(asUser(db, IDS.STAFF_B, 'SELECT id FROM public.un1t_clients')).rejects.toThrow(/permission denied for table un1t_clients/)
    await expect(asUser(db, IDS.STAFF_B, 'SELECT id FROM public.contact_memberships')).rejects.toThrow(/permission denied for table contact_memberships/)
  })

  it('the helper: 732 body, DEFINER, STABLE, search_path pinned, uuid[]; authenticated + service_role only, never anon', async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_732_HELPER)
    const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c, prorettype::regtype::text t,
        has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
        has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') s,
        has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n,
        has_function_privilege('public', to_regprocedure($1), 'EXECUTE') p
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [HELPER])
    expect(r).toEqual({ d: true, v: 's', c: ['search_path=""'], t: 'uuid[]', a: true, s: true, n: false, p: false })
    await expect(asRole(db, 'anon', `SELECT ${HELPER}`)).rejects.toThrow(/permission denied for function auth_contact_membership_contact_ids/)
  })

  it('crossover_contact_ids returns the client crossover, distinct; service_role only', async () => {
    // A: C_D1 by membership, C_C1 by client
    expect(await crossover(db, LOC_A)).toEqual([C_C1, C_D1].sort())
    // B: C_A by deal; C_C1 by deal, membership AND client, once; C_D1 by client; C_B lives at B; the NULL row joins nothing
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_C1, C_D1].sort())
    // D: C_A by client (the RPC lists crossovers; reading them is still gated)
    expect(await crossover(db, LOC_D)).toEqual([C_A])
    expect(await md5Of(db, CROSS)).toBe(MD5_732_CROSS)
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

  it("the policy is 731's, untouched: one policy, same name/command/roles/USING, no WITH CHECK", async () => {
    expect(await policiesOf(db, ['contacts'])).toEqual([{ tablename: 'contacts', policyname: 'contacts_select', permissive: 'PERMISSIVE',
      cmd: 'SELECT', roles: '{public}', qual: QUAL_731, with_check: null }])
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_732)).resolves.toBeDefined()
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect(await md5Of(db, HELPER)).toBe(MD5_732_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_732_CROSS)
    expect(await count(db, IDS.STAFF_B)).toBe(3)
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_C1, C_D1].sort())
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })
  const prep = (extra) => bootProd({ before2: BEFORE2 + extra, migrate: [MIG_699, MIG_731] })
  const still731 = async () => {
    expect(await md5Of(db, HELPER)).toBe(MD5_731_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_731_CROSS)
  }
  // `extra` runs before 731, so a hand edit is made after it, here
  const prepAfter = async (edit) => { db = await prep(''); await db['exec'](edit); await signedOut(db) }

  it('when contacts_select was changed by hand', async () => {
    await prepAfter(`ALTER POLICY contacts_select ON public.contacts USING (true);`)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: public\.contacts does not have exactly the mig 731 contacts_select policy/)
    await still731()
  }, 60_000)

  it('when the read helper was edited by hand', async () => {
    await prepAfter(`CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids() RETURNS uuid[]
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$ SELECT '{}'::uuid[] $f$;`)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: private\.auth_contact_membership_contact_ids\(\) is not the mig 731 body/)
    expect(await md5Of(db, CROSS)).toBe(MD5_731_CROSS)
  }, 60_000)

  it('when crossover_contact_ids was edited by hand', async () => {
    await prepAfter(`CREATE OR REPLACE FUNCTION public.crossover_contact_ids(loc uuid) RETURNS TABLE (contact_id uuid)
      LANGUAGE sql STABLE SET search_path = '' AS $f$ SELECT NULL::uuid $f$;`)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: public\.crossover_contact_ids\(uuid\) is not the mig 731 body/)
    expect(await md5Of(db, HELPER)).toBe(MD5_731_HELPER)
  }, 60_000)

  it('when 731 was never applied (the 251 RPC, no membership branch)', async () => {
    db = await bootProd({ before2: BEFORE2, migrate: [MIG_699] })
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: public\.contacts does not have exactly the mig 731 contacts_select policy/)
    expect((await db.query(`SELECT to_regprocedure('${HELPER}') AS fn`)).rows[0].fn).toBeNull()
  }, 60_000)

  it('when un1t_clients is missing', async () => {
    db = await bootProd({ before2: BEFORE2_731, migrate: [MIG_699, MIG_731] })
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: public\.un1t_clients is missing/)
    await still731()
  }, 60_000)

  it('when a client can read un1t_clients', async () => {
    db = await prep(`GRANT SELECT ON public.un1t_clients TO authenticated;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: un1t_clients is readable by a client/)
    await still731()
  }, 60_000)

  it('when a client holds a COLUMN-level SELECT on un1t_clients (has_table_privilege cannot see it)', async () => {
    db = await prep(`GRANT SELECT (contact_id) ON public.un1t_clients TO authenticated;`)
    expect((await db.query(`SELECT has_table_privilege('authenticated', 'public.un1t_clients', 'SELECT') AS t`)).rows[0].t).toBe(false)
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: un1t_clients is readable by a client/)
    await still731()
  }, 60_000)

  it('when anon holds a COLUMN-level SELECT on un1t_clients', async () => {
    db = await prep(`GRANT SELECT (status) ON public.un1t_clients TO anon;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: un1t_clients is readable by a client/)
    await still731()
  }, 60_000)

  it('when un1t_clients has RLS off', async () => {
    db = await prep(`ALTER TABLE public.un1t_clients DISABLE ROW LEVEL SECURITY;`)
    await signedOut(db)
    expect(await abortMessage(db, MIG_732)).toMatch(/mig 732: un1t_clients is readable by a client or has RLS off/)
    await still731()
  }, 60_000)
})

describe('the file carries no placeholder', () => {
  it('ends with the self-check and COMMIT', () => {
    expect(MIG_732).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    // never touches the policy
    expect(MIG_732).not.toMatch(/^\s*ALTER\s+POLICY/im)
  })
})

describe("the header's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it("restores 731's two bodies; the policy is unchanged; 732 applies again", async () => {
    db = await boot732()
    await db['exec'](ROLLBACK_732)
    expect(await md5Of(db, HELPER)).toBe(MD5_731_HELPER)
    expect(await md5Of(db, CROSS)).toBe(MD5_731_CROSS)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(QUAL_731)
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(false)
    expect(await sees(db, IDS.STAFF_B, C_C1)).toBe(true)   // 731's active membership
    expect(await crossover(db, LOC_B)).toEqual([C_A, C_C1].sort())
    const { rows: [r] } = await db.query(`SELECT has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') a,
      has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') n,
      has_function_privilege('authenticated', to_regprocedure($2), 'EXECUTE') x`, [HELPER, CROSS])
    expect(r).toEqual({ a: true, n: false, x: false })
    await signedOut(db)
    await db['exec'](MIG_732)
    expect(await sees(db, IDS.STAFF_B, C_D1)).toBe(true)
  }, 60_000)
})
