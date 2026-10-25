// MEMBERWRITESWEEP.1a — behavioural test for migration 680.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds coach_kudos, coaching_goals, inbody_scans,
// consultation_photos and consultations, reduced to the columns the policies
// and the service paths need, with the 17 live policies written so they
// deparse to prod's pg_policies text (30 Sep 2026; pinned by a test). It
// proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio reads every member's rows on
//     all five, inserts a kudos, rewrites an InBody scan and deletes a
//     consultation; a member reads only their own rows; a staff login that is
//     also a member reads the whole studio's goals and scans from an
//     unfiltered select (the member-mode side finding); anon errors on a
//     helper for the four TO-public tables;
//   * AFTER: every client write refused by the grant (masters included); the
//     two consultation tables refuse every client read too; a member reads
//     EXACTLY the rows they read before, row for row, as a real member
//     session; staff read only their own contact's rows; anon holds nothing;
//     every service-role path still works;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, an extra policy, a
//     drifted read policy, a policy elsewhere that reads a closed table as
//     the caller, and RLS off; a second run passes; the plan's rollback
//     record restores the before-state.
//
// Every describe runs in BOTH prod states: before mig 677 (as planned) and
// after it (prod since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd),
// with 677 replayed from its real file. 677 on top of 680 is replayed too.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, MIG_677, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/680_coaching_tables_client_writes_off.sql'), 'utf8')
const OWN_READ = ['coach_kudos', 'coaching_goals', 'inbody_scans']
const CLOSED = ['consultation_photos', 'consultations']
const TABLES = [...OWN_READ, ...CLOSED]
const PER_CMD_TABLES = ['coach_kudos', 'coaching_goals', 'inbody_scans', 'consultation_photos']

const TABLE_SQL = TABLES.map((t) => `
  CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    contact_id uuid NOT NULL, body text${t === 'coach_kudos' ? ', seen_at timestamptz' : ''});
  ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')
// The 17 live policies (plan §1), written so they deparse to prod's text.
const PER_CMD = (t) => `
  CREATE POLICY ${t}_read ON public.${t} FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
  CREATE POLICY ${t}_ins ON public.${t} FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY ${t}_upd ON public.${t} FOR UPDATE TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY ${t}_del ON public.${t} FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));`
const POLICY_SQL = PER_CMD_TABLES.map(PER_CMD).join('\n') + `
  CREATE POLICY consultations_loc ON public.consultations FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));`
// Prod text (pg_policies.qual / with_check, 30 Sep).
const PROD_READ_QUAL = '(private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()))'
const PROD_MEMBERSHIP = 'private.auth_is_in_location(location_id)'
const OWN_QUAL = '(contact_id = private.auth_contact_id())'

// Row ids are fixed so a before-boot and an after-boot can be compared row
// for row: <table index><owner>. At A one row each for MEMBER, MEMBER2 and
// STAFF_MEMBER; at B one row. Each table: 4 rows.
const rowId = (ti, k) => `4${ti}000000-0000-0000-0000-00000000000${k}`
const SEED = TABLES.map((t, ti) => `
  INSERT INTO public.${t} (id, location_id, contact_id) VALUES
    ('${rowId(ti, 1)}', '${IDS.LOC_A}', '${IDS.C_MEMBER}'), ('${rowId(ti, 2)}', '${IDS.LOC_A}', '${IDS.C_MEMBER2}'),
    ('${rowId(ti, 5)}', '${IDS.LOC_A}', '${IDS.C_STAFF_MEMBER}'), ('${rowId(ti, 'b')}', '${IDS.LOC_B}', '${IDS.C_B}');`).join('\n')
const rowOf = (t, k) => rowId(TABLES.indexOf(t), k)

// The rollback record, plan Task 1a-6 Step 7, verbatim. Its first statement
// depends on the state 680 was applied to (the plan: "If (a) showed 677's
// end state ... replace the first statement"). Prod is in 677's end state, so
// the POST_677 form is the one to use; the pre-677 form would hand anon all
// eight privileges back and authenticated the four 677 removed.
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.coach_kudos, public.coaching_goals, public.inbody_scans, public.consultation_photos, public.consultations
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.coach_kudos, public.coaching_goals, public.inbody_scans, public.consultation_photos, public.consultations
  TO authenticated;`
const rollback680 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
DROP POLICY IF EXISTS coach_kudos_read_own ON public.coach_kudos;
DROP POLICY IF EXISTS coaching_goals_read_own ON public.coaching_goals;
DROP POLICY IF EXISTS inbody_scans_read_own ON public.inbody_scans;
CREATE POLICY coach_kudos_read ON public.coach_kudos FOR SELECT TO public
  USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY coach_kudos_ins ON public.coach_kudos FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY coach_kudos_upd ON public.coach_kudos FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY coach_kudos_del ON public.coach_kudos FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY coaching_goals_read ON public.coaching_goals FOR SELECT TO public
  USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY coaching_goals_ins ON public.coaching_goals FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY coaching_goals_upd ON public.coaching_goals FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY coaching_goals_del ON public.coaching_goals FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY inbody_scans_read ON public.inbody_scans FOR SELECT TO public
  USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY inbody_scans_ins ON public.inbody_scans FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY inbody_scans_upd ON public.inbody_scans FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY inbody_scans_del ON public.inbody_scans FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY consultation_photos_read ON public.consultation_photos FOR SELECT TO public
  USING (private.auth_is_in_location(location_id) OR (contact_id = private.auth_contact_id()));
CREATE POLICY consultation_photos_ins ON public.consultation_photos FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY consultation_photos_upd ON public.consultation_photos FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY consultation_photos_del ON public.consultation_photos FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY consultations_loc ON public.consultations FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
COMMIT;
`
const ROLLBACK_680 = { false: rollback680(ROLLBACK_GRANT_PRE_677), true: rollback680(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const ids = (t) => `SELECT id::text FROM public.${t} ORDER BY id`
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
const idList = (rows) => rows.map((r) => r.id)

// What authenticated holds on each table before 680 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

describe.each(PROD_STATES)('before 680: the holes (prod on 30 Sep 2026), $label', ({ after677 }) => {
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

  it("the replay's 17 policies read exactly as prod's pg_policies", async () => {
    const pols = await policiesOf(db, TABLES)
    expect(pols).toHaveLength(17)
    for (const t of PER_CMD_TABLES) {
      const by = Object.fromEntries(pols.filter((p) => p.tablename === t).map((p) => [p.policyname, p]))
      expect(by[`${t}_read`]).toMatchObject({ permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{public}', qual: PROD_READ_QUAL, with_check: null })
      expect(by[`${t}_ins`]).toMatchObject({ cmd: 'INSERT', roles: '{authenticated}', qual: null, with_check: PROD_MEMBERSHIP })
      expect(by[`${t}_upd`]).toMatchObject({ cmd: 'UPDATE', roles: '{authenticated}', qual: PROD_MEMBERSHIP, with_check: PROD_MEMBERSHIP })
      expect(by[`${t}_del`]).toMatchObject({ cmd: 'DELETE', roles: '{authenticated}', qual: PROD_MEMBERSHIP, with_check: null })
    }
    expect(pols.find((p) => p.policyname === 'consultations_loc')).toMatchObject({
      permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{authenticated}', qual: PROD_MEMBERSHIP, with_check: PROD_MEMBERSHIP })
  })

  it("plain staff at A: reads 3 rows of every table (other members' included), inserts a kudos, rewrites an InBody row, deletes a consultation", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 3 }])
    expect(await asUser(db, IDS.STAFF_A,
      `INSERT INTO public.coach_kudos (location_id, contact_id, body) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}', 'x') RETURNING contact_id::text`))
      .toEqual([{ contact_id: IDS.C_MEMBER }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.inbody_scans SET body = 'rewritten' WHERE id = '${rowOf('inbody_scans', 1)}' RETURNING body`))
      .toEqual([{ body: 'rewritten' }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.consultations WHERE id = '${rowOf('consultations', 2)}' RETURNING id::text`))
      .toEqual([{ id: rowOf('consultations', 2) }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, `SELECT count(*)::int AS n FROM public.${t} WHERE location_id = '${IDS.LOC_A}'`), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B, `UPDATE public.inbody_scans SET body = 'x' WHERE location_id = '${IDS.LOC_A}' RETURNING id`)).toEqual([])
  })

  it('a member reads only their own row of the four TO-public tables and nothing of consultations; an insert is refused by RLS', async () => {
    for (const t of PER_CMD_TABLES) expect(idList(await asUser(db, IDS.MEMBER_UID, ids(t))), t).toEqual([rowOf(t, 1)])
    expect(await asUser(db, IDS.MEMBER_UID, count('consultations'))).toEqual([{ n: 0 }])
    await expect(asUser(db, IDS.MEMBER_UID,
      `INSERT INTO public.coach_kudos (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`)).rejects.toThrow(rlsRefused('coach_kudos'))
  })

  it('staff-who-is-a-member: an unfiltered select of coaching_goals / inbody_scans returns all 3 A rows (the member-mode side finding)', async () => {
    for (const t of ['coaching_goals', 'inbody_scans']) expect(await asUser(db, IDS.STAFF_MEMBER, count(t)), t).toEqual([{ n: 3 }])
  })

  // Either helper can be the first one the executor checks (PGlite reaches
  // the argument-less auth_contact_id first); anon may execute neither.
  // After 677 the planner can still reach a helper's EXECUTE check (it
  // pre-evaluates the STABLE auth_contact_id() for estimates) before the
  // executor's table check, so either refusal is accepted there.
  it('anon: a read of the four TO-public tables is refused; consultations returns 0 rows before 677 and is refused by the grant after it', async () => {
    for (const t of PER_CMD_TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(after677
        ? new RegExp(`permission denied for (function auth_(is_in_location|contact_id)|(table|relation) ${t})\\b`)
        : /permission denied for function auth_(is_in_location|contact_id)\b/)
    }
    if (after677) await expect(asRole(db, 'anon', count('consultations'))).rejects.toThrow(denied('consultations'))
    else expect(await asRole(db, 'anon', count('consultations'))).toEqual([{ n: 0 }])
  })
})

describe.each(PROD_STATES)('after 680: the catalog, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it.each(OWN_READ)('%s: authenticated SELECT only, RLS on, service_role DML, one own-row read policy', async (t) => {
    expect(await clientPrivileges(db, t)).toEqual(['authenticated:SELECT', 'authenticated:col-SELECT'])
    expect(await rlsOn(db, t)).toBe(true)
    expect(await serviceRoleDml(db, t)).toBe(true)
    expect(await policiesOf(db, [t])).toEqual([{
      tablename: t, policyname: `${t}_read_own`, permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}',
      qual: OWN_QUAL, with_check: null,
    }])
  })

  it.each(CLOSED)('%s: no client privilege, RLS on, service_role DML, no policy', async (t) => {
    expect(await clientPrivileges(db, t)).toEqual([])
    expect(await rlsOn(db, t)).toBe(true)
    expect(await serviceRoleDml(db, t)).toBe(true)
    expect(await policiesOf(db, [t])).toEqual([])
  })
})

describe.each(PROD_STATES)('after 680: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let before
  let db
  beforeAll(async () => {
    before = await boot(spec)
    db = await boot({ ...spec, migrate: [MIG] })
  }, 120_000)
  afterAll(async () => { await before?.close(); await db?.close() })

  it('a member reads EXACTLY the rows they read before, table by table (a real member session: no profile, own contact)', async () => {
    for (const uid of [IDS.MEMBER_UID, IDS.MEMBER2_UID]) {
      for (const t of OWN_READ) {
        const was = idList(await asUser(before, uid, ids(t)))
        const now = idList(await asUser(db, uid, ids(t)))
        expect(was, `${t} before`).toHaveLength(1)
        expect(now, t).toEqual(was)
      }
    }
    // The phone's own reads, as written (mobile/app/(member)/...): the kudos
    // read filters by contact_id, the coaching hub's reads do not.
    expect(idList(await asUser(db, IDS.MEMBER_UID,
      `SELECT id::text FROM public.coach_kudos WHERE contact_id = '${IDS.C_MEMBER}' ORDER BY id`))).toEqual([rowOf('coach_kudos', 1)])
    expect(idList(await asUser(db, IDS.MEMBER_UID, ids('coaching_goals')))).toEqual([rowOf('coaching_goals', 1)])
    expect(idList(await asUser(db, IDS.MEMBER_UID, ids('inbody_scans')))).toEqual([rowOf('inbody_scans', 1)])
  })

  it('a member still cannot write, and reads nothing of the consultation tables', async () => {
    for (const t of TABLES) {
      await expect(asUser(db, IDS.MEMBER_UID, `INSERT INTO public.${t} (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`), t)
        .rejects.toThrow(denied(t))
    }
    for (const t of CLOSED) await expect(asUser(db, IDS.MEMBER_UID, count(t)), t).rejects.toThrow(denied(t))
  })

  it('staff-who-is-a-member now reads only their own row', async () => {
    for (const t of OWN_READ) expect(idList(await asUser(db, IDS.STAFF_MEMBER, ids(t))), t).toEqual([rowOf(t, 5)])
  })

  it('plain staff, owner, master: every write is refused by the grant; the closed tables refuse reads; own-read tables return only their own rows', async () => {
    for (const uid of [IDS.STAFF_A, IDS.OWNER_A, IDS.MASTER]) {
      for (const t of TABLES) {
        await expect(asUser(db, uid, `INSERT INTO public.${t} (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`), `${uid} ${t}`)
          .rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `UPDATE public.${t} SET body = 'x' WHERE id = '${rowOf(t, 1)}'`), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `DELETE FROM public.${t} WHERE id = '${rowOf(t, 1)}'`), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `TRUNCATE public.${t}`), `${uid} ${t}`).rejects.toThrow(/permission denied/)
        await expect(asUser(db, uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`), `${uid} ${t}`).rejects.toThrow(denied(t))
      }
      for (const t of CLOSED) await expect(asUser(db, uid, count(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
      for (const t of OWN_READ) expect(await asUser(db, uid, count(t)), `${uid} ${t}`).toEqual([{ n: 0 }])
    }
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `INSERT INTO public.${t} (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`), t)
        .rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it('service_role: kudos insert and seen_at stamp, goal CRUD, InBody ingest, consultation and photo insert/delete all succeed', async () => {
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.coach_kudos (location_id, contact_id, body) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}', 'k') RETURNING body`))
      .toEqual([{ body: 'k' }])
    // champ-app's /api/kudos/seen: an update pinned to the caller's own contact.
    expect(await asRole(db, 'service_role',
      `UPDATE public.coach_kudos SET seen_at = now() WHERE contact_id = '${IDS.C_MEMBER}' AND seen_at IS NULL RETURNING id::text`))
      .toEqual([{ id: rowOf('coach_kudos', 1) }])
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.coaching_goals (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`,
      `UPDATE public.coaching_goals SET body = 'done' WHERE id = '${rowOf('coaching_goals', 1)}'`,
      `DELETE FROM public.coaching_goals WHERE id = '${rowOf('coaching_goals', 2)}'`,
      count('coaching_goals'))).toEqual([{ n: 4 }])
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.inbody_scans (location_id, contact_id, body) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}', 'scan') RETURNING body`))
      .toEqual([{ body: 'scan' }])
    for (const t of CLOSED) {
      expect(await asRole(db, 'service_role',
        `INSERT INTO public.${t} (location_id, contact_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}')`,
        `DELETE FROM public.${t} WHERE id = '${rowOf(t, 1)}'`,
        count(t)), t).toEqual([{ n: 4 }])
    }
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
    // Nothing applied: the old write policy and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['coach_kudos_ins', 'consultations_loc', 'inbody_scans_read']))
    expect(await clientPrivileges(db, 'coach_kudos')).toContain('authenticated:INSERT')
  }

  it("when another grantor's UPDATE on inbody_scans to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.inbody_scans TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.inbody_scans TO authenticated; RESET ROLE;`,
    /mig 680: (client roles still hold privileges on public\.inbody_scans: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.inbody_scans)/,
  ), 120_000)

  it('when INSERT on coaching_goals is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.coaching_goals TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 680: authenticated still holds INSERT on public\.coaching_goals/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (body) on consultation_photos survives", () => expectAbort(
    `GRANT UPDATE (body) ON public.consultation_photos TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (body) ON public.consultation_photos TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.consultation_photos|client roles still hold privileges on public\.consultation_photos/,
  ), 120_000)

  it('when a policy the file does not know about is left on coach_kudos', () => expectAbort(
    `CREATE POLICY stray_write ON public.coach_kudos FOR INSERT TO authenticated WITH CHECK (true);`,
    /mig 680: public\.coach_kudos should keep exactly one policy/,
  ), 120_000)

  it('when the read policy it replaces has drifted from the one it was written against (the pre-check)', () => expectAbort(
    `ALTER POLICY coaching_goals_read ON public.coaching_goals USING (true);`,
    /mig 680: public\.coaching_goals\.coaching_goals_read is not the policy this file was written against/,
  ), 120_000)

  it('when a policy on another table still reads a closed table as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.consultations));`,
    /mig 680: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on consultations (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.consultations DISABLE ROW LEVEL SECURITY;`,
    /mig 680: row level security is off on public\.consultations/,
  ), 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes its own self-check', async () => {
    db = await boot({ ...spec, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect((await policiesOf(db, TABLES)).map((p) => p.policyname))
      .toEqual(['coach_kudos_read_own', 'coaching_goals_read_own', 'inbody_scans_read_own'])
  }, 120_000)

  it("the plan's rollback record restores the 17 policies and the before privileges (and so the holes)", async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_680[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('inbody_scans'))).toEqual([{ n: 3 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_680[false])).toBeNull()
      const held = await clientPrivileges(db, 'consultations')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  } else {
    it('677 applied on top of 680 still passes its own self-check and leaves 680\'s end state', async () => {
      db = await boot({ ...spec, migrate: [MIG] })
      const policiesAfter680 = await policiesOf(db, TABLES)
      const privsAfter680 = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
      expect(await abortMessage(db, `CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;`)).toBeNull()
      expect(await abortMessage(db, MIG_677)).toBeNull()
      expect(await policiesOf(db, TABLES)).toEqual(policiesAfter680)
      expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsAfter680)
    }, 120_000)
  }
})
