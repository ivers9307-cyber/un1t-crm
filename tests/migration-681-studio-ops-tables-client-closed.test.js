// MEMBERWRITESWEEP.1b — behavioural test for migration 681.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds presentations, presentation_slides, orders,
// location_automations, location_holidays, person_groups,
// person_group_members and person_link_suggestions, reduced to the columns
// the policies and the service paths need, with the 8 live policies written
// so they deparse to prod's pg_policies text (30 Sep 2026; pinned by a test).
// It proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio reads every order, person
//     group and duplicate suggestion at that studio and flips an order to
//     refunded, inserts a holiday, toggles an automation, deletes a slide and
//     rewrites a suggestion; staff at another studio reach nothing; a member
//     (no profile) reads and writes nothing; a child's policy reads its
//     parent AS THE CALLER, so closing person_groups alone would turn every
//     person_group_members read into a 42501 (why the child closes with it);
//   * AFTER: no client privilege on any of the eight (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; plain staff, owner,
//     master, member and anon are refused every read and write by the grant;
//     every service-role path still works, the presentation and person-group
//     cascades included;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know about, a policy elsewhere that reads a closed table as the
//     caller, and RLS off; a second run passes; the rollback record restores
//     the before-state.
//
// Every describe runs in BOTH prod states: before mig 677 (as planned) and
// after it (prod since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd),
// with 677 replayed from its real file. 677 on top of 681 is replayed too.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, MIG_677, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/681_studio_ops_tables_client_closed.sql'), 'utf8')
const TABLES = ['presentations', 'presentation_slides', 'orders', 'location_automations', 'location_holidays',
  'person_groups', 'person_group_members', 'person_link_suggestions']
// Tables with their own location_id (person_group_members reaches it through its group).
const LOCATED = TABLES.filter((t) => t !== 'person_group_members')

const TABLE_SQL = `
  CREATE TABLE public.presentations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, title text);
  CREATE TABLE public.presentation_slides (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    presentation_id uuid NOT NULL REFERENCES public.presentations (id) ON DELETE CASCADE, body text);
  CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'paid', amount numeric NOT NULL DEFAULT 0);
  CREATE TABLE public.location_automations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    key text NOT NULL DEFAULT 'k', enabled boolean NOT NULL DEFAULT false);
  CREATE TABLE public.location_holidays (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    day date NOT NULL DEFAULT '2026-12-25');
  CREATE TABLE public.person_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL);
  CREATE TABLE public.person_group_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL REFERENCES public.person_groups (id) ON DELETE CASCADE, contact_id uuid);
  CREATE TABLE public.person_link_suggestions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending');
` + TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 8 live policies (plan §1), written so they deparse to prod's text.
const MEMBERSHIP_ALL = (name, t) => `CREATE POLICY ${name} ON public.${t} FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));`
const PGM_EXISTS = 'EXISTS (SELECT 1 FROM person_groups g WHERE g.id = person_group_members.group_id AND private.auth_is_in_location(g.location_id))'
const POLICY_TEXT = [
  MEMBERSHIP_ALL('presentations_location_scoped', 'presentations'),
  MEMBERSHIP_ALL('presentation_slides_location_scoped', 'presentation_slides'),
  `CREATE POLICY orders_location_scoped ON public.orders FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));`,
  MEMBERSHIP_ALL('location_automations_loc', 'location_automations'),
  MEMBERSHIP_ALL('location_holidays_location_scoped', 'location_holidays'),
  MEMBERSHIP_ALL('person_groups_loc', 'person_groups'),
  `CREATE POLICY pgm_loc ON public.person_group_members FOR ALL TO authenticated
  USING (${PGM_EXISTS})
  WITH CHECK (${PGM_EXISTS});`,
  MEMBERSHIP_ALL('pls_loc', 'person_link_suggestions'),
]
const POLICY_SQL = POLICY_TEXT.join('\n')

// Prod text (pg_policies.qual / with_check, re-read 30 Sep 2026 for this PR).
const PROD_MEMBERSHIP = 'private.auth_is_in_location(location_id)'
const PROD_ORDERS = '(private.auth_is_master() OR private.auth_is_in_location(location_id))'
const PROD_PGM = '(EXISTS ( SELECT 1\n   FROM person_groups g\n  WHERE ((g.id = person_group_members.group_id) AND private.auth_is_in_location(g.location_id))))'
const PROD_POLICIES = {
  presentations: ['presentations_location_scoped', PROD_MEMBERSHIP],
  presentation_slides: ['presentation_slides_location_scoped', PROD_MEMBERSHIP],
  orders: ['orders_location_scoped', PROD_ORDERS],
  location_automations: ['location_automations_loc', PROD_MEMBERSHIP],
  location_holidays: ['location_holidays_location_scoped', PROD_MEMBERSHIP],
  person_groups: ['person_groups_loc', PROD_MEMBERSHIP],
  person_group_members: ['pgm_loc', PROD_PGM],
  person_link_suggestions: ['pls_loc', PROD_MEMBERSHIP],
}

// Row ids are fixed: <table index><k>, k = 1, 2 at A and b at B.
const rowId = (ti, k) => `5${ti}000000-0000-0000-0000-00000000000${k}`
const rowOf = (t, k) => rowId(TABLES.indexOf(t), k)
const SEED = LOCATED.filter((t) => t !== 'presentation_slides').map((t) => `
  INSERT INTO public.${t} (id, location_id) VALUES
    ('${rowOf(t, 1)}', '${IDS.LOC_A}'), ('${rowOf(t, 2)}', '${IDS.LOC_A}'), ('${rowOf(t, 'b')}', '${IDS.LOC_B}');`).join('\n') + `
  INSERT INTO public.presentation_slides (id, location_id, presentation_id) VALUES
    ('${rowOf('presentation_slides', 1)}', '${IDS.LOC_A}', '${rowOf('presentations', 1)}'),
    ('${rowOf('presentation_slides', 2)}', '${IDS.LOC_A}', '${rowOf('presentations', 1)}'),
    ('${rowOf('presentation_slides', 'b')}', '${IDS.LOC_B}', '${rowOf('presentations', 'b')}');
  INSERT INTO public.person_group_members (id, group_id, contact_id) VALUES
    ('${rowOf('person_group_members', 1)}', '${rowOf('person_groups', 1)}', '${IDS.C_MEMBER}'),
    ('${rowOf('person_group_members', 2)}', '${rowOf('person_groups', 1)}', '${IDS.C_MEMBER2}'),
    ('${rowOf('person_group_members', 'b')}', '${rowOf('person_groups', 'b')}', '${IDS.C_B}');`

// The rollback record (plan Task 1b-5). Prod is in 677's end state (pre-probe
// 30 Sep: authenticated=arwd/postgres, no anon, on all eight), so the
// POST_677 form is the one to use; the PRE_677 form would hand anon all eight
// privileges back and authenticated the four 677 removed.
const EIGHT = `public.presentations, public.presentation_slides, public.orders, public.location_automations,
     public.location_holidays, public.person_groups, public.person_group_members, public.person_link_suggestions`
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ${EIGHT}
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON ${EIGHT}
  TO authenticated;`
const rollback681 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
CREATE POLICY presentations_location_scoped ON public.presentations FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY presentation_slides_location_scoped ON public.presentation_slides FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY orders_location_scoped ON public.orders FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY location_automations_loc ON public.location_automations FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY location_holidays_location_scoped ON public.location_holidays FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY person_groups_loc ON public.person_groups FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY pgm_loc ON public.person_group_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM person_groups g WHERE g.id = person_group_members.group_id AND private.auth_is_in_location(g.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM person_groups g WHERE g.id = person_group_members.group_id AND private.auth_is_in_location(g.location_id)));
CREATE POLICY pls_loc ON public.person_link_suggestions FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
COMMIT;
`
const ROLLBACK_681 = { false: rollback681(ROLLBACK_GRANT_PRE_677), true: rollback681(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
const countAt = (t, loc) => t === 'person_group_members'
  ? `SELECT count(*)::int AS n FROM public.person_group_members m JOIN public.person_groups g ON g.id = m.group_id WHERE g.location_id = '${loc}'`
  : `SELECT count(*)::int AS n FROM public.${t} WHERE location_id = '${loc}'`
// One INSERT per table that satisfies its NOT NULLs (the parents exist).
const INSERT = {
  presentations: `INSERT INTO public.presentations (location_id) VALUES ('${IDS.LOC_A}')`,
  presentation_slides: `INSERT INTO public.presentation_slides (location_id, presentation_id) VALUES ('${IDS.LOC_A}', '${rowOf('presentations', 2)}')`,
  orders: `INSERT INTO public.orders (location_id, amount) VALUES ('${IDS.LOC_A}', 10)`,
  location_automations: `INSERT INTO public.location_automations (location_id, key) VALUES ('${IDS.LOC_A}', 'new')`,
  location_holidays: `INSERT INTO public.location_holidays (location_id, day) VALUES ('${IDS.LOC_A}', '2026-12-26')`,
  person_groups: `INSERT INTO public.person_groups (location_id) VALUES ('${IDS.LOC_A}')`,
  person_group_members: `INSERT INTO public.person_group_members (group_id, contact_id) VALUES ('${rowOf('person_groups', 2)}', '${IDS.C_MEMBER}')`,
  person_link_suggestions: `INSERT INTO public.person_link_suggestions (location_id) VALUES ('${IDS.LOC_A}')`,
}
const UPDATE = (t) => `UPDATE public.${t} SET id = id WHERE id = '${rowOf(t, 1)}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE id = '${rowOf(t, 2)}'`

// What authenticated holds on each table before 681 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

describe.each(PROD_STATES)('before 681: the holes (prod on 30 Sep 2026), $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot(spec) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the client grants on %s are the state\'s (default privileges, or 677\'s arwd for authenticated and nothing for anon)', async (t) => {
    const held = (await clientPrivileges(db, t)).filter((h) => !h.includes(':col-'))
    const expected = [
      ...(after677 ? [] : ALL_PRIVS.map((p) => `anon:${p}`)),
      ...AUTH_BEFORE[after677].map((p) => `authenticated:${p}`),
    ]
    expect(held.sort()).toEqual(expected.sort())
  })

  it("the replay's 8 policies read exactly as prod's pg_policies", async () => {
    const pols = await policiesOf(db, TABLES)
    expect(pols).toHaveLength(8)
    for (const t of TABLES) {
      const [name, text] = PROD_POLICIES[t]
      expect(pols.filter((p) => p.tablename === t), t).toEqual([{
        tablename: t, policyname: name, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{authenticated}', qual: text, with_check: text,
      }])
    }
  })

  it('plain staff at A: reads every A row of all eight (two each), flips an order to refunded, inserts a holiday, toggles an automation, deletes a slide, rewrites a suggestion', async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 2 }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.orders SET status = 'refunded' WHERE id = '${rowOf('orders', 1)}' RETURNING status`)).toEqual([{ status: 'refunded' }])
    expect(await asUser(db, IDS.STAFF_A, `${INSERT.location_holidays} RETURNING day::text`)).toEqual([{ day: '2026-12-26' }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.location_automations SET enabled = true WHERE id = '${rowOf('location_automations', 1)}' RETURNING enabled`)).toEqual([{ enabled: true }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.presentation_slides WHERE id = '${rowOf('presentation_slides', 1)}' RETURNING id::text`)).toEqual([{ id: rowOf('presentation_slides', 1) }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.person_link_suggestions SET status = 'dismissed' WHERE id = '${rowOf('person_link_suggestions', 1)}' RETURNING status`)).toEqual([{ status: 'dismissed' }])
    expect(await asUser(db, IDS.STAFF_A, `${INSERT.person_group_members} RETURNING contact_id::text`)).toEqual([{ contact_id: IDS.C_MEMBER }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, countAt(t, IDS.LOC_A)), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B, `UPDATE public.orders SET status = 'refunded' WHERE location_id = '${IDS.LOC_A}' RETURNING id`)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT.location_holidays)).rejects.toThrow(rlsRefused('location_holidays'))
  })

  it('a member (no profile) reads nothing and every insert is refused by RLS', async () => {
    for (const t of TABLES) {
      expect(await asUser(db, IDS.MEMBER_UID, count(t)), t).toEqual([{ n: 0 }])
      await expect(asUser(db, IDS.MEMBER_UID, INSERT[t]), t).rejects.toThrow(rlsRefused(t))
    }
  })

  it('anon: every policy is TO authenticated, so a read returns 0 rows before 677 and is refused by the grant after it', async () => {
    for (const t of TABLES) {
      if (after677) await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      else expect(await asRole(db, 'anon', count(t)), t).toEqual([{ n: 0 }])
    }
  })

  it("the child reads its parent AS THE CALLER: closing person_groups alone turns every person_group_members read into a 42501 (why they close together)", async () => {
    await expect(asUser(db, IDS.STAFF_A, count('person_group_members'))).resolves.toEqual([{ n: 2 }])
    await expect((async () => {
      await db.query('BEGIN')
      try {
        await db.query('REVOKE SELECT ON public.person_groups FROM authenticated')
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: IDS.STAFF_A, role: 'authenticated' })])
        await db.query('SET LOCAL ROLE authenticated')
        return await db.query(count('person_group_members'))
      } finally {
        await db.query('ROLLBACK')
      }
    })()).rejects.toThrow(denied('person_groups'))
  })
})

describe.each(PROD_STATES)('after 681: the catalog, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)('%s: no client privilege, RLS on, service_role DML, no policy', async (t) => {
    expect(await clientPrivileges(db, t)).toEqual([])
    expect(await rlsOn(db, t)).toBe(true)
    expect(await serviceRoleDml(db, t)).toBe(true)
    expect(await policiesOf(db, [t])).toEqual([])
  })
})

describe.each(PROD_STATES)('after 681: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on all eight is refused by the grant', async () => {
    for (const uid of [IDS.STAFF_A, IDS.OWNER_A, IDS.MASTER, IDS.MEMBER_UID]) {
      for (const t of TABLES) {
        await expect(asUser(db, uid, count(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, INSERT[t]), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, UPDATE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, DELETE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `TRUNCATE public.${t}`), `${uid} ${t}`).rejects.toThrow(/permission denied/)
        await expect(asUser(db, uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`), `${uid} ${t}`).rejects.toThrow(denied(t))
      }
    }
    // The finding's own write, as the plain staff member: refused.
    await expect(asUser(db, IDS.STAFF_A, `UPDATE public.orders SET status = 'refunded' WHERE id = '${rowOf('orders', 1)}'`))
      .rejects.toThrow(denied('orders'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it('service_role: the order refund, the automation toggle, the holiday insert and a suggestion rewrite succeed', async () => {
    expect(await asRole(db, 'service_role',
      `UPDATE public.orders SET status = 'refunded' WHERE id = '${rowOf('orders', 1)}' RETURNING status`)).toEqual([{ status: 'refunded' }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.location_automations SET enabled = true WHERE id = '${rowOf('location_automations', 1)}' RETURNING enabled`)).toEqual([{ enabled: true }])
    expect(await asRole(db, 'service_role', `${INSERT.location_holidays} RETURNING day::text`)).toEqual([{ day: '2026-12-26' }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.person_link_suggestions SET status = 'accepted' WHERE id = '${rowOf('person_link_suggestions', 1)}' RETURNING status`)).toEqual([{ status: 'accepted' }])
    for (const t of TABLES) {
      expect(await asRole(db, 'service_role', INSERT[t], UPDATE(t), count(t)), t).toEqual([{ n: 4 }])
    }
  })

  it('service_role: deleting a presentation takes its slides; deleting a person group takes its members (the FK cascades run as the owner)', async () => {
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.presentations WHERE id = '${rowOf('presentations', 1)}'`,
      `DELETE FROM public.person_groups WHERE id = '${rowOf('person_groups', 1)}'`,
      `SELECT (SELECT count(*)::int FROM public.presentation_slides WHERE presentation_id = '${rowOf('presentations', 1)}') AS slides,
              (SELECT count(*)::int FROM public.person_group_members WHERE group_id = '${rowOf('person_groups', 1)}') AS members,
              (SELECT count(*)::int FROM public.presentation_slides) AS slides_left,
              (SELECT count(*)::int FROM public.person_group_members) AS members_left`))
      .toEqual([{ slides: 0, members: 0, slides_left: 1, members_left: 1 }])
  })
})

describe.each(PROD_STATES)('the self-check aborts the whole file, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    db = await boot({ ...spec, before })
    const msg = await abortMessage(db, MIG)
    expect(msg).toMatch(message)
    // Nothing applied: the old policies and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['orders_location_scoped', 'pgm_loc', 'pls_loc']))
    expect(await clientPrivileges(db, 'orders')).toContain('authenticated:UPDATE')
  }

  it("when another grantor's UPDATE on orders to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.orders TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.orders TO authenticated; RESET ROLE;`,
    /mig 681: (client roles still hold privileges on public\.orders: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.orders)/,
  ), 120_000)

  it('when INSERT on location_holidays is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.location_holidays TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 681: authenticated still holds INSERT on public\.location_holidays/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (status) on person_link_suggestions survives", () => expectAbort(
    `GRANT UPDATE (status) ON public.person_link_suggestions TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (status) ON public.person_link_suggestions TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.person_link_suggestions|client roles still hold privileges on public\.person_link_suggestions/,
  ), 120_000)

  it('when a policy the file does not know about is left on person_link_suggestions', () => expectAbort(
    `CREATE POLICY pls_stray ON public.person_link_suggestions FOR SELECT TO authenticated USING (true);`,
    /mig 681: public\.person_link_suggestions should have no policy left: pls_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads person_groups as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.person_groups));`,
    /mig 681: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on orders (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;`,
    /mig 681: row level security is off on public\.orders/,
  ), 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes its own self-check', async () => {
    db = await boot({ ...spec, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual([])
  }, 120_000)

  it('the rollback record restores the 8 policies and the before privileges (and so the holes)', async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_681[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('orders'))).toEqual([{ n: 2 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_681[false])).toBeNull()
      const held = await clientPrivileges(db, 'orders')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  } else {
    it('677 applied on top of 681 still passes its own self-check and leaves 681\'s end state', async () => {
      db = await boot({ ...spec, migrate: [MIG] })
      const privsAfter681 = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
      expect(await abortMessage(db, `CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;`)).toBeNull()
      expect(await abortMessage(db, MIG_677)).toBeNull()
      expect(await policiesOf(db, TABLES)).toEqual([])
      expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsAfter681)
    }, 120_000)
  }
})
