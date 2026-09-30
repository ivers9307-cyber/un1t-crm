// MEMBERWRITESWEEP.1c — behavioural test for migration 682.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds race_events, teams, race_registrations,
// race_payments, race_penalties, race_waves and team_members, reduced to the
// columns the policies, the foreign keys and the service paths need (prod's
// column names, prod's FK actions), with the 7 live policies written so they
// deparse to prod's pg_policies text (30 Sep 2026; pinned by a test). One
// touch trigger (race_payments, INVOKER, like prod's five) shows a trigger
// needs no client privilege. It proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio reads every event,
//     registration, payment, penalty, wave, team and team member at that
//     studio, marks a payment completed, rewrites a registration, adds a
//     penalty, moves a team member to another team and deletes a wave; staff
//     at another studio reach nothing; a member (no profile) reads and writes
//     nothing; each child's policy reads its parent AS THE CALLER, so closing
//     a parent alone turns every read of its children into a 42501 (why the
//     seven close together);
//   * AFTER: no client privilege on any of the seven (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; plain staff, owner,
//     master, member and anon are refused every read and write by the grant;
//     every service-role path still works: a registration insert, a payment
//     status transition (its touch trigger fires), and the cascades
//     race_events -> registrations -> penalties (and payments, waves) and
//     teams -> team_members;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know about, a policy elsewhere that reads a closed table as the
//     caller, and RLS off; the plan's three mutations of the file itself
//     (no REVOKE; no race_waves DROP; race_penalties kept out of the file
//     while race_registrations closes) each abort with their message; a
//     second run passes; the rollback record restores the before-state.
//
// Every describe runs in BOTH prod states: before mig 677 (as planned) and
// after it (prod since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd),
// with 677 replayed from its real file. 677 on top of 682 is replayed too.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, MIG_677, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/682_event_tables_client_closed.sql'), 'utf8')
const TABLES = ['race_events', 'teams', 'race_registrations', 'race_payments', 'race_penalties', 'race_waves',
  'team_members']

// Row ids are fixed: <table index><k>, k = 1, 2 at A and b at B.
const rowId = (ti, k) => `6${ti}000000-0000-0000-0000-00000000000${k}`
const rowOf = (t, k) => rowId(TABLES.indexOf(t), k)
const E1 = rowOf('race_events', 1), E2 = rowOf('race_events', 2), EB = rowOf('race_events', 'b')
const T1 = rowOf('teams', 1), T2 = rowOf('teams', 2), TB = rowOf('teams', 'b')
const R1 = rowOf('race_registrations', 1), R2 = rowOf('race_registrations', 2), RB = rowOf('race_registrations', 'b')
const W1 = rowOf('race_waves', 1)

const TABLE_SQL = `
  CREATE TABLE public.race_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    slug text NOT NULL DEFAULT 'e');
  CREATE TABLE public.teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    name text NOT NULL DEFAULT 't');
  CREATE TABLE public.race_waves (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_event_id uuid NOT NULL REFERENCES public.race_events (id) ON DELETE CASCADE, label text);
  CREATE TABLE public.race_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_event_id uuid NOT NULL REFERENCES public.race_events (id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE,
    wave_id uuid REFERENCES public.race_waves (id) ON DELETE SET NULL,
    contact_id uuid, status text NOT NULL DEFAULT 'registered');
  CREATE TABLE public.race_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_event_id uuid NOT NULL REFERENCES public.race_events (id) ON DELETE CASCADE,
    race_registration_id uuid REFERENCES public.race_registrations (id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending', amount_cents integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT '2000-01-01 00:00:00+00');
  CREATE TABLE public.race_penalties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    race_registration_id uuid NOT NULL REFERENCES public.race_registrations (id) ON DELETE CASCADE,
    seconds integer NOT NULL DEFAULT 0);
  CREATE TABLE public.team_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams (id) ON DELETE CASCADE, contact_id uuid,
    name text NOT NULL DEFAULT 'm');
  -- Prod's five touch triggers are INVOKER functions in private; one stands in.
  CREATE FUNCTION private.touch_race_payments_updated_at() RETURNS trigger LANGUAGE plpgsql
    SET search_path TO '' AS $t$ BEGIN NEW.updated_at := now(); RETURN NEW; END $t$;
  CREATE TRIGGER race_payments_touch_updated_at BEFORE UPDATE ON public.race_payments
    FOR EACH ROW EXECUTE FUNCTION private.touch_race_payments_updated_at();
` + TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 7 live policies (plan §1), written so they deparse to prod's text.
const MASTER_OR_MEMBERSHIP = '(private.auth_is_master() OR private.auth_is_in_location(location_id))'
const viaEvent = (t) => `(private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = ${t}.race_event_id AND private.auth_is_in_location(re.location_id)))`
const PENALTIES_EXPR = '(private.auth_is_master() OR EXISTS (SELECT 1 FROM race_registrations rr JOIN race_events re ON re.id = rr.race_event_id WHERE rr.id = race_penalties.race_registration_id AND private.auth_is_in_location(re.location_id)))'
const TEAM_MEMBERS_EXPR = '(private.auth_is_master() OR EXISTS (SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND private.auth_is_in_location(t.location_id)))'
const policyAll = (name, t, expr) => `CREATE POLICY ${name} ON public.${t} FOR ALL TO authenticated
  USING ${expr}
  WITH CHECK ${expr};`
const POLICY_SQL = [
  policyAll('race_events_location_scoped', 'race_events', MASTER_OR_MEMBERSHIP),
  policyAll('teams_location_scoped', 'teams', MASTER_OR_MEMBERSHIP),
  policyAll('race_registrations_location_scoped', 'race_registrations', viaEvent('race_registrations')),
  policyAll('race_payments_location_scoped', 'race_payments', viaEvent('race_payments')),
  policyAll('race_penalties_location_scoped', 'race_penalties', PENALTIES_EXPR),
  policyAll('race_waves_location_scoped', 'race_waves', viaEvent('race_waves')),
  policyAll('team_members_location_scoped', 'team_members', TEAM_MEMBERS_EXPR),
].join('\n')

// Prod text (pg_policies.qual = with_check, re-read 30 Sep 2026 for this PR).
const PROD_MASTER_OR_MEMBERSHIP = '(private.auth_is_master() OR private.auth_is_in_location(location_id))'
const prodViaEvent = (t) => `(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM race_events re\n  WHERE ((re.id = ${t}.race_event_id) AND private.auth_is_in_location(re.location_id)))))`
const PROD_POLICIES = {
  race_events: ['race_events_location_scoped', PROD_MASTER_OR_MEMBERSHIP],
  teams: ['teams_location_scoped', PROD_MASTER_OR_MEMBERSHIP],
  race_registrations: ['race_registrations_location_scoped', prodViaEvent('race_registrations')],
  race_payments: ['race_payments_location_scoped', prodViaEvent('race_payments')],
  race_penalties: ['race_penalties_location_scoped',
    '(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM (race_registrations rr\n     JOIN race_events re ON ((re.id = rr.race_event_id)))\n  WHERE ((rr.id = race_penalties.race_registration_id) AND private.auth_is_in_location(re.location_id)))))'],
  race_waves: ['race_waves_location_scoped', prodViaEvent('race_waves')],
  team_members: ['team_members_location_scoped',
    '(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM teams t\n  WHERE ((t.id = team_members.team_id) AND private.auth_is_in_location(t.location_id)))))'],
}

const SEED = `
  INSERT INTO public.race_events (id, location_id) VALUES
    ('${E1}', '${IDS.LOC_A}'), ('${E2}', '${IDS.LOC_A}'), ('${EB}', '${IDS.LOC_B}');
  INSERT INTO public.teams (id, location_id) VALUES
    ('${T1}', '${IDS.LOC_A}'), ('${T2}', '${IDS.LOC_A}'), ('${TB}', '${IDS.LOC_B}');
  INSERT INTO public.race_waves (id, race_event_id) VALUES
    ('${W1}', '${E1}'), ('${rowOf('race_waves', 2)}', '${E1}'), ('${rowOf('race_waves', 'b')}', '${EB}');
  INSERT INTO public.race_registrations (id, race_event_id, team_id, wave_id, contact_id) VALUES
    ('${R1}', '${E1}', '${T1}', '${W1}', '${IDS.C_MEMBER}'), ('${R2}', '${E1}', '${T2}', NULL, '${IDS.C_MEMBER2}'),
    ('${RB}', '${EB}', '${TB}', NULL, '${IDS.C_B}');
  INSERT INTO public.race_payments (id, race_event_id, race_registration_id, amount_cents) VALUES
    ('${rowOf('race_payments', 1)}', '${E1}', '${R1}', 4000), ('${rowOf('race_payments', 2)}', '${E1}', '${R2}', 4000),
    ('${rowOf('race_payments', 'b')}', '${EB}', '${RB}', 4000);
  INSERT INTO public.race_penalties (id, race_registration_id, seconds) VALUES
    ('${rowOf('race_penalties', 1)}', '${R1}', 30), ('${rowOf('race_penalties', 2)}', '${R2}', 30),
    ('${rowOf('race_penalties', 'b')}', '${RB}', 30);
  INSERT INTO public.team_members (id, team_id, contact_id) VALUES
    ('${rowOf('team_members', 1)}', '${T1}', '${IDS.C_MEMBER}'), ('${rowOf('team_members', 2)}', '${T1}', '${IDS.C_MEMBER2}'),
    ('${rowOf('team_members', 'b')}', '${TB}', '${IDS.C_B}');`

// The rollback record (plan Task 1c-5). Prod is in 677's end state (pre-probe
// 30 Sep: authenticated=arwd/postgres, no anon, on all seven), so the
// POST_677 form is the one to use; the PRE_677 form would hand anon all eight
// privileges back and authenticated the four 677 removed.
const SEVEN = `public.race_events, public.teams, public.race_registrations, public.race_payments,
     public.race_penalties, public.race_waves, public.team_members`
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ${SEVEN}
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON ${SEVEN}
  TO authenticated;`
const rollback682 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
CREATE POLICY race_events_location_scoped ON public.race_events FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY teams_location_scoped ON public.teams FOR ALL TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY race_registrations_location_scoped ON public.race_registrations FOR ALL TO authenticated
  USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_registrations.race_event_id AND private.auth_is_in_location(re.location_id)))
  WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_registrations.race_event_id AND private.auth_is_in_location(re.location_id)));
CREATE POLICY race_payments_location_scoped ON public.race_payments FOR ALL TO authenticated
  USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_payments.race_event_id AND private.auth_is_in_location(re.location_id)))
  WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_payments.race_event_id AND private.auth_is_in_location(re.location_id)));
CREATE POLICY race_penalties_location_scoped ON public.race_penalties FOR ALL TO authenticated
  USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_registrations rr JOIN race_events re ON re.id = rr.race_event_id WHERE rr.id = race_penalties.race_registration_id AND private.auth_is_in_location(re.location_id)))
  WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_registrations rr JOIN race_events re ON re.id = rr.race_event_id WHERE rr.id = race_penalties.race_registration_id AND private.auth_is_in_location(re.location_id)));
CREATE POLICY race_waves_location_scoped ON public.race_waves FOR ALL TO authenticated
  USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_waves.race_event_id AND private.auth_is_in_location(re.location_id)))
  WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM race_events re WHERE re.id = race_waves.race_event_id AND private.auth_is_in_location(re.location_id)));
CREATE POLICY team_members_location_scoped ON public.team_members FOR ALL TO authenticated
  USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND private.auth_is_in_location(t.location_id)))
  WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND private.auth_is_in_location(t.location_id)));
COMMIT;
`
const ROLLBACK_682 = { false: rollback682(ROLLBACK_GRANT_PRE_677), true: rollback682(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
// Rows at a studio: the parents carry location_id; the children reach it through their parent.
const AT = {
  race_events: (loc) => `SELECT count(*)::int AS n FROM public.race_events WHERE location_id = '${loc}'`,
  teams: (loc) => `SELECT count(*)::int AS n FROM public.teams WHERE location_id = '${loc}'`,
  race_registrations: (loc) => `SELECT count(*)::int AS n FROM public.race_registrations x JOIN public.race_events e ON e.id = x.race_event_id WHERE e.location_id = '${loc}'`,
  race_payments: (loc) => `SELECT count(*)::int AS n FROM public.race_payments x JOIN public.race_events e ON e.id = x.race_event_id WHERE e.location_id = '${loc}'`,
  race_waves: (loc) => `SELECT count(*)::int AS n FROM public.race_waves x JOIN public.race_events e ON e.id = x.race_event_id WHERE e.location_id = '${loc}'`,
  race_penalties: (loc) => `SELECT count(*)::int AS n FROM public.race_penalties p JOIN public.race_registrations r ON r.id = p.race_registration_id JOIN public.race_events e ON e.id = r.race_event_id WHERE e.location_id = '${loc}'`,
  team_members: (loc) => `SELECT count(*)::int AS n FROM public.team_members m JOIN public.teams t ON t.id = m.team_id WHERE t.location_id = '${loc}'`,
}
// One INSERT per table that satisfies its NOT NULLs (the parents exist at A).
const INSERT = {
  race_events: `INSERT INTO public.race_events (location_id, slug) VALUES ('${IDS.LOC_A}', 'new')`,
  teams: `INSERT INTO public.teams (location_id) VALUES ('${IDS.LOC_A}')`,
  race_registrations: `INSERT INTO public.race_registrations (race_event_id, team_id, contact_id) VALUES ('${E2}', '${T2}', '${IDS.C_MEMBER}')`,
  race_payments: `INSERT INTO public.race_payments (race_event_id, race_registration_id, amount_cents) VALUES ('${E2}', '${R2}', 100)`,
  race_penalties: `INSERT INTO public.race_penalties (race_registration_id, seconds) VALUES ('${R2}', 60)`,
  race_waves: `INSERT INTO public.race_waves (race_event_id, label) VALUES ('${E2}', 'w')`,
  team_members: `INSERT INTO public.team_members (team_id, contact_id) VALUES ('${T2}', '${IDS.C_MEMBER}')`,
}
const UPDATE = (t) => `UPDATE public.${t} SET id = id WHERE id = '${rowOf(t, 1)}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE id = '${rowOf(t, 2)}'`

// What authenticated holds on each table before 682 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

/** Run statements as a user with one parent's SELECT revoked, in a transaction always rolled back. */
async function withParentRevoked(db, parent, uid, sql) {
  await db.query('BEGIN')
  try {
    await db.query(`REVOKE SELECT ON public.${parent} FROM authenticated`)
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await db.query('ROLLBACK')
  }
}

describe.each(PROD_STATES)('before 682: the holes (prod on 30 Sep 2026), $label', ({ after677 }) => {
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

  it("the replay's 7 policies read exactly as prod's pg_policies", async () => {
    const pols = await policiesOf(db, TABLES)
    expect(pols).toHaveLength(7)
    for (const t of TABLES) {
      const [name, text] = PROD_POLICIES[t]
      expect(pols.filter((p) => p.tablename === t), t).toEqual([{
        tablename: t, policyname: name, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{authenticated}', qual: text, with_check: text,
      }])
    }
  })

  it('plain staff at A: reads every A row of all seven (two each), marks a payment completed, rewrites a registration, adds a penalty, moves a team member, deletes a wave', async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 2 }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.race_payments SET status = 'completed' WHERE id = '${rowOf('race_payments', 1)}' RETURNING status`)).toEqual([{ status: 'completed' }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.race_registrations SET status = 'cancelled' WHERE id = '${R1}' RETURNING status`)).toEqual([{ status: 'cancelled' }])
    expect(await asUser(db, IDS.STAFF_A, `${INSERT.race_penalties} RETURNING seconds`)).toEqual([{ seconds: 60 }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.team_members SET team_id = '${T2}' WHERE id = '${rowOf('team_members', 1)}' RETURNING team_id::text`)).toEqual([{ team_id: T2 }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.race_waves WHERE id = '${rowOf('race_waves', 2)}' RETURNING id::text`)).toEqual([{ id: rowOf('race_waves', 2) }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, AT[t](IDS.LOC_A)), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B,
      `UPDATE public.race_payments SET status = 'completed' WHERE race_event_id = '${E1}' RETURNING id`)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT.race_penalties)).rejects.toThrow(rlsRefused('race_penalties'))
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

  it('each child reads its parent AS THE CALLER: closing a parent alone turns every read of its children into a 42501 (why the seven close together)', async () => {
    for (const child of ['race_registrations', 'race_payments', 'race_waves', 'race_penalties']) {
      await expect(withParentRevoked(db, 'race_events', IDS.STAFF_A, count(child)), child).rejects.toThrow(denied('race_events'))
    }
    await expect(withParentRevoked(db, 'race_registrations', IDS.STAFF_A, count('race_penalties')))
      .rejects.toThrow(denied('race_registrations'))
    await expect(withParentRevoked(db, 'teams', IDS.STAFF_A, count('team_members'))).rejects.toThrow(denied('teams'))
    // The master branch does not save it either: the policy expression is planned as a whole.
    await expect(withParentRevoked(db, 'teams', IDS.MASTER, count('team_members'))).rejects.toThrow(denied('teams'))
  })
})

describe.each(PROD_STATES)('after 682: the catalog, $label', ({ after677 }) => {
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

describe.each(PROD_STATES)('after 682: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on all seven is refused by the grant', async () => {
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
    await expect(asUser(db, IDS.STAFF_A, `UPDATE public.race_payments SET status = 'completed' WHERE id = '${rowOf('race_payments', 1)}'`))
      .rejects.toThrow(denied('race_payments'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it('service_role: a registration insert and a payment status transition succeed (the touch trigger fires), and every table takes an insert and an update', async () => {
    expect(await asRole(db, 'service_role', `${INSERT.race_registrations} RETURNING status`)).toEqual([{ status: 'registered' }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.race_payments SET status = 'completed' WHERE id = '${rowOf('race_payments', 1)}'
        RETURNING status, updated_at > '2000-01-01 00:00:00+00' AS touched`)).toEqual([{ status: 'completed', touched: true }])
    for (const t of TABLES) {
      expect(await asRole(db, 'service_role', INSERT[t], UPDATE(t), count(t)), t).toEqual([{ n: 4 }])
    }
  })

  it('service_role: deleting an event takes its registrations, their penalties, its payments and waves; deleting a team takes its members (the FK cascades run as the owner)', async () => {
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.race_events WHERE id = '${E1}'`,
      `DELETE FROM public.teams WHERE id = '${T1}'`,
      `SELECT (SELECT count(*)::int FROM public.race_registrations) AS registrations,
              (SELECT count(*)::int FROM public.race_penalties) AS penalties,
              (SELECT count(*)::int FROM public.race_payments) AS payments,
              (SELECT count(*)::int FROM public.race_waves) AS waves,
              (SELECT count(*)::int FROM public.team_members WHERE team_id = '${T1}') AS members_of_t1,
              (SELECT count(*)::int FROM public.team_members) AS members_left`))
      .toEqual([{ registrations: 1, penalties: 1, payments: 1, waves: 1, members_of_t1: 0, members_left: 1 }])
  })
})

describe.each(PROD_STATES)('the self-check aborts the whole file, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG) {
    db = await boot({ ...spec, before })
    const msg = await abortMessage(db, sql)
    expect(msg).toMatch(message)
    // Nothing applied: the old policies and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['race_events_location_scoped', 'race_penalties_location_scoped',
      'team_members_location_scoped']))
    expect(await clientPrivileges(db, 'race_payments')).toContain('authenticated:UPDATE')
  }

  it("when another grantor's UPDATE on race_payments to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.race_payments TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.race_payments TO authenticated; RESET ROLE;`,
    /mig 682: (client roles still hold privileges on public\.race_payments: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.race_payments)/,
  ), 120_000)

  it('when INSERT on race_penalties is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.race_penalties TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 682: authenticated still holds INSERT on public\.race_penalties/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (status) on race_registrations survives", () => expectAbort(
    `GRANT UPDATE (status) ON public.race_registrations TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (status) ON public.race_registrations TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.race_registrations|client roles still hold privileges on public\.race_registrations/,
  ), 120_000)

  it('when a policy the file does not know about is left on race_waves', () => expectAbort(
    `CREATE POLICY race_waves_stray ON public.race_waves FOR SELECT TO authenticated USING (true);`,
    /mig 682: public\.race_waves should have no policy left: race_waves_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads race_events as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.race_events));`,
    /mig 682: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on teams (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.teams DISABLE ROW LEVEL SECURITY;`,
    /mig 682: row level security is off on public\.teams/,
  ), 120_000)

  // The plan's mutation table (Task 1c-2), kept as tests: each edit of the
  // file itself must abort it.
  const mutate = (from, to) => {
    const out = MIG.replace(from, to)
    expect(out, `mutation did not apply: ${from}`).not.toBe(MIG)
    return out
  }

  it('mutation: without the REVOKE the file aborts on race_events', () => expectAbort('',
    /mig 682: client roles still hold privileges on public\.race_events: (anon|authenticated):DELETE \(from postgres\)/,
    mutate(/REVOKE ALL\s+ON public\.race_events[\s\S]*?FROM anon, authenticated, PUBLIC;\n/, '')), 120_000)

  it('mutation: without the race_waves DROP the file aborts on race_waves', () => expectAbort('',
    /mig 682: public\.race_waves should have no policy left: race_waves_location_scoped ALL/,
    mutate('DROP POLICY IF EXISTS race_waves_location_scoped ON public.race_waves;\n', '')), 120_000)

  it('mutation: race_penalties left out of the file (DROP and array entry) while race_registrations closes: check 5 names its policy', () => expectAbort('',
    /mig 682: policies on other tables still read a closed table as the caller: public\.race_penalties\.race_penalties_location_scoped$/,
    mutate(/'race_penalties', /, '').replace('DROP POLICY IF EXISTS race_penalties_location_scoped ON public.race_penalties;\n', '')), 120_000)
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

  it('the rollback record restores the 7 policies and the before privileges (and so the holes)', async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_682[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('race_payments'))).toEqual([{ n: 2 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_682[false])).toBeNull()
      const held = await clientPrivileges(db, 'race_payments')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  } else {
    it('677 applied on top of 682 still passes its own self-check and leaves 682\'s end state', async () => {
      db = await boot({ ...spec, migrate: [MIG] })
      const privsAfter682 = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
      expect(await abortMessage(db, `CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;`)).toBeNull()
      expect(await abortMessage(db, MIG_677)).toBeNull()
      expect(await policiesOf(db, TABLES)).toEqual([])
      expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsAfter682)
    }, 120_000)
  }
})
