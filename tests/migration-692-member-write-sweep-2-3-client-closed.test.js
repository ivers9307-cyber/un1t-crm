// MEMBERWRITESWEEP.2 + .3 (C112, C121) — behavioural test for migration 692.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds private.auth_is_manager_at (verbatim from prod,
// 2 Oct 2026, with prod EXECUTE), event_types in mig 650's state, and the
// twelve tables 692 closes, reduced to the columns the policies and the
// service paths need, with the 20 live policies written so they deparse to
// prod's pg_policies text (2 Oct 2026; pinned by a test). It proves:
//
//   * BEFORE: a PLAIN STAFF member reads every contact tag, contact event,
//     blocked time, race check-in and event-type reminder at their studio and
//     inserts a tag, deletes an event and rewrites a blocked time; a MEMBER
//     (a customer, no profile) can tag ANY contact and write a contact event
//     for one by leaving location_id NULL (the `location_id IS NULL` branch);
//     a manager writes scheduled reports, slot removals, allowances and
//     reminders straight from the browser, past the routes' validation; the
//     four policy-less tables still hand authenticated arwd (RLS is the only
//     fence);
//   * AFTER: no client privilege on any of the twelve (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; every person is
//     refused every read and write by the grant; every service-role path
//     still works, the event-type cascades included; event_types keeps its
//     studio read (the phone embeds it from bookings) and nothing else;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know about, a policy elsewhere that reads a closed table as the
//     caller, RLS off, and an event_types write or extra policy; a second run
//     passes; the two rollback records (C112's and C121's) restore the
//     before-state.
//
// Every describe runs in BOTH prod states: before mig 677 and after it (prod
// since 30 Sep 2026: no anon, authenticated arwd), with 677 replayed from its
// real file. Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/692_member_write_sweep_2_3_client_closed.sql'), 'utf8')
const C112_TABLES = ['blocked_times', 'contact_events', 'contact_tags', 'shift_block_removals',
  'staff_allowances', 'scheduled_reports']
const C121_TABLES = ['race_checkins', 'event_type_reminders', 'promo_codes', 'event_reminder_sends',
  'host_contacts', 'host_campaigns']
const TABLES = [...C112_TABLES, ...C121_TABLES]
const NO_POLICY = ['promo_codes', 'event_reminder_sends', 'host_contacts', 'host_campaigns']

const ET_A = 'e0000000-0000-0000-0000-00000000000a'
const ET_B = 'e0000000-0000-0000-0000-00000000000b'

const TABLE_SQL = `
  -- private.auth_is_manager_at, VERBATIM from prod (pg_get_functiondef, 2 Oct 2026); prod EXECUTE:
  -- postgres, authenticated, service_role.
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid)
   RETURNS boolean
   LANGUAGE sql
   STABLE SECURITY DEFINER
   SET search_path TO ''
  AS $function$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = (SELECT auth.uid())
              AND pl.location_id = p_location_id
              AND pl.role IN ('owner','manager','head_coach')
          )
        )
    )
  $function$;
  REVOKE ALL ON FUNCTION private.auth_is_manager_at(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_manager_at(uuid) TO authenticated, service_role;
  -- staff_allowances' policies read profile_locations AS THE CALLER; prod
  -- grants authenticated SELECT on it (behind its own RLS). Reduced: the grant.
  GRANT SELECT ON public.profile_locations TO authenticated;

  CREATE TABLE public.event_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    name text NOT NULL DEFAULT 'Intro');
  -- mig 650 (EVENTTYPERLS.1): the browser lost every event_types write.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_types FROM anon, authenticated, PUBLIC;

  CREATE TABLE public.blocked_times (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type_id uuid NOT NULL REFERENCES public.event_types (id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL DEFAULT '2026-10-05 09:00+00');
  CREATE TABLE public.contact_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid REFERENCES public.contacts (id) ON DELETE SET NULL, location_id uuid,
    kind text NOT NULL DEFAULT 'note');
  CREATE TABLE public.contact_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE, location_id uuid,
    tag text NOT NULL DEFAULT 'vip', removed_at timestamptz);
  CREATE TABLE public.shift_block_removals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    template_id uuid NOT NULL DEFAULT gen_random_uuid(), block_date date NOT NULL DEFAULT '2026-10-05',
    removed_by uuid, reason text);
  CREATE TABLE public.staff_allowances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL,
    year int NOT NULL DEFAULT 2026, days numeric NOT NULL DEFAULT 20);
  CREATE TABLE public.scheduled_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    name text NOT NULL DEFAULT 'weekly', recipients text[]);
  CREATE TABLE public.race_checkins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    contact_id uuid);
  CREATE TABLE public.event_type_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type_id uuid NOT NULL REFERENCES public.event_types (id) ON DELETE CASCADE,
    offset_minutes int NOT NULL DEFAULT 60);
  CREATE TABLE public.promo_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    code text NOT NULL DEFAULT 'FREE');
  CREATE TABLE public.event_reminder_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid NOT NULL DEFAULT gen_random_uuid(), kind text NOT NULL DEFAULT '24h');
  CREATE TABLE public.host_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id uuid NOT NULL DEFAULT gen_random_uuid(), contact_id uuid);
  CREATE TABLE public.host_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id uuid NOT NULL DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'draft');
` + ['event_types', ...TABLES].map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 20 live policies (19 on the twelve, 1 on event_types), written so they deparse to prod's text.
const BT = 'EXISTS (SELECT 1 FROM event_types et WHERE et.id = blocked_times.event_type_id AND private.auth_is_in_location(et.location_id))'
const LOC_NULL = 'private.auth_is_master() OR location_id IS NULL OR private.auth_is_in_location(location_id)'
const ETR = (fn) => `private.auth_is_master() OR EXISTS (SELECT 1 FROM event_types et WHERE et.id = event_type_reminders.event_type_id AND private.${fn}(et.location_id))`
const SA = 'EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = staff_allowances.profile_id AND private.auth_is_manager_at(pl.location_id))'
const MGR = 'private.auth_is_manager_at(location_id)'
const C112_POLICY_SQL = `
CREATE POLICY blocked_times_via_event_type ON public.blocked_times FOR ALL TO authenticated
  USING (${BT}) WITH CHECK (${BT});
CREATE POLICY contact_events_location_scoped ON public.contact_events FOR ALL TO authenticated
  USING (${LOC_NULL}) WITH CHECK (${LOC_NULL});
CREATE POLICY contact_tags_location_scoped ON public.contact_tags FOR ALL TO authenticated
  USING (${LOC_NULL}) WITH CHECK (${LOC_NULL});
CREATE POLICY shift_block_removals_select ON public.shift_block_removals FOR SELECT TO authenticated USING (${MGR});
CREATE POLICY shift_block_removals_insert ON public.shift_block_removals FOR INSERT TO authenticated
  WITH CHECK (${MGR} AND (removed_by IS NULL OR removed_by = (SELECT auth.uid())));
CREATE POLICY shift_block_removals_delete ON public.shift_block_removals FOR DELETE TO authenticated USING (${MGR});
CREATE POLICY staff_allowances_select ON public.staff_allowances FOR SELECT TO authenticated
  USING (profile_id = (SELECT auth.uid()) OR ${SA});
CREATE POLICY staff_allowances_ins ON public.staff_allowances FOR INSERT TO authenticated WITH CHECK (${SA});
CREATE POLICY staff_allowances_upd ON public.staff_allowances FOR UPDATE TO authenticated USING (${SA}) WITH CHECK (${SA});
CREATE POLICY staff_allowances_del ON public.staff_allowances FOR DELETE TO authenticated USING (${SA});
CREATE POLICY scheduled_reports_select ON public.scheduled_reports FOR SELECT TO authenticated USING (${MGR});
CREATE POLICY scheduled_reports_ins ON public.scheduled_reports FOR INSERT TO authenticated WITH CHECK (${MGR});
CREATE POLICY scheduled_reports_upd ON public.scheduled_reports FOR UPDATE TO authenticated USING (${MGR}) WITH CHECK (${MGR});
CREATE POLICY scheduled_reports_del ON public.scheduled_reports FOR DELETE TO authenticated USING (${MGR});
`
const C121_POLICY_SQL = `
CREATE POLICY race_checkins_location_scoped_select ON public.race_checkins FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY "event_type_reminders readable in-location" ON public.event_type_reminders FOR SELECT TO authenticated
  USING (${ETR('auth_is_in_location')});
CREATE POLICY event_type_reminders_ins ON public.event_type_reminders FOR INSERT TO authenticated
  WITH CHECK (${ETR('auth_is_manager_at')});
CREATE POLICY event_type_reminders_upd ON public.event_type_reminders FOR UPDATE TO authenticated
  USING (${ETR('auth_is_manager_at')}) WITH CHECK (${ETR('auth_is_manager_at')});
CREATE POLICY event_type_reminders_del ON public.event_type_reminders FOR DELETE TO authenticated
  USING (${ETR('auth_is_manager_at')});
`
const EVENT_TYPES_POLICY_SQL = `
CREATE POLICY event_types_select ON public.event_types FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
`
const POLICY_SQL = EVENT_TYPES_POLICY_SQL + C112_POLICY_SQL + C121_POLICY_SQL

// Prod text (pg_policies.qual / with_check, read 2 Oct 2026 for this PR).
const P_BT = '(EXISTS ( SELECT 1\n   FROM event_types et\n  WHERE ((et.id = blocked_times.event_type_id) AND private.auth_is_in_location(et.location_id))))'
const P_LOC_NULL = '(private.auth_is_master() OR (location_id IS NULL) OR private.auth_is_in_location(location_id))'
const P_ETR = (fn) => `(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM event_types et\n  WHERE ((et.id = event_type_reminders.event_type_id) AND private.${fn}(et.location_id)))))`
const P_SA = '(EXISTS ( SELECT 1\n   FROM profile_locations pl\n  WHERE ((pl.profile_id = staff_allowances.profile_id) AND private.auth_is_manager_at(pl.location_id))))'
const P_SA_SEL = '((profile_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1\n   FROM profile_locations pl\n  WHERE ((pl.profile_id = staff_allowances.profile_id) AND private.auth_is_manager_at(pl.location_id)))))'
const P_MGR = 'private.auth_is_manager_at(location_id)'
const P_IN = 'private.auth_is_in_location(location_id)'
const pol = (tablename, policyname, cmd, qual, with_check) =>
  ({ tablename, policyname, permissive: 'PERMISSIVE', cmd, roles: '{authenticated}', qual, with_check })
const PROD_POLICIES = [
  pol('blocked_times', 'blocked_times_via_event_type', 'ALL', P_BT, P_BT),
  pol('contact_events', 'contact_events_location_scoped', 'ALL', P_LOC_NULL, P_LOC_NULL),
  pol('contact_tags', 'contact_tags_location_scoped', 'ALL', P_LOC_NULL, P_LOC_NULL),
  pol('event_type_reminders', 'event_type_reminders readable in-location', 'SELECT', P_ETR('auth_is_in_location'), null),
  pol('event_type_reminders', 'event_type_reminders_del', 'DELETE', P_ETR('auth_is_manager_at'), null),
  pol('event_type_reminders', 'event_type_reminders_ins', 'INSERT', null, P_ETR('auth_is_manager_at')),
  pol('event_type_reminders', 'event_type_reminders_upd', 'UPDATE', P_ETR('auth_is_manager_at'), P_ETR('auth_is_manager_at')),
  pol('event_types', 'event_types_select', 'SELECT', P_IN, null),
  pol('race_checkins', 'race_checkins_location_scoped_select', 'SELECT', P_IN, null),
  pol('scheduled_reports', 'scheduled_reports_del', 'DELETE', P_MGR, null),
  pol('scheduled_reports', 'scheduled_reports_ins', 'INSERT', null, P_MGR),
  pol('scheduled_reports', 'scheduled_reports_select', 'SELECT', P_MGR, null),
  pol('scheduled_reports', 'scheduled_reports_upd', 'UPDATE', P_MGR, P_MGR),
  pol('shift_block_removals', 'shift_block_removals_delete', 'DELETE', P_MGR, null),
  pol('shift_block_removals', 'shift_block_removals_insert', 'INSERT', null,
    '(private.auth_is_manager_at(location_id) AND ((removed_by IS NULL) OR (removed_by = ( SELECT auth.uid() AS uid))))'),
  pol('shift_block_removals', 'shift_block_removals_select', 'SELECT', P_MGR, null),
  pol('staff_allowances', 'staff_allowances_del', 'DELETE', P_SA, null),
  pol('staff_allowances', 'staff_allowances_ins', 'INSERT', null, P_SA),
  pol('staff_allowances', 'staff_allowances_select', 'SELECT', P_SA_SEL, null),
  pol('staff_allowances', 'staff_allowances_upd', 'UPDATE', P_SA, P_SA),
]

// Row ids are fixed: <table index (hex)><k>, k = 1, 2 at A and b at B.
const rowOf = (t, k) => `7${TABLES.indexOf(t).toString(16)}000000-0000-0000-0000-00000000000${k}`
const LOCATED = ['contact_events', 'contact_tags', 'shift_block_removals', 'scheduled_reports', 'race_checkins', 'promo_codes']
const CONTACT_OF = { 1: IDS.C_MEMBER, 2: IDS.C_MEMBER2, b: IDS.C_B }
const LOC_OF = { 1: IDS.LOC_A, 2: IDS.LOC_A, b: IDS.LOC_B }
const ET_OF = { 1: ET_A, 2: ET_A, b: ET_B }
const PROFILE_OF = { 1: IDS.STAFF_A, 2: IDS.STAFF_MEMBER, b: IDS.STAFF_B }
const KS = [1, 2, 'b']
const SEED = `
  INSERT INTO public.event_types (id, location_id) VALUES ('${ET_A}', '${IDS.LOC_A}'), ('${ET_B}', '${IDS.LOC_B}');
` + LOCATED.map((t) => `INSERT INTO public.${t} (id, location_id${['contact_events', 'contact_tags'].includes(t) ? ', contact_id' : ''}) VALUES ` +
  KS.map((k) => `('${rowOf(t, k)}', '${LOC_OF[k]}'${['contact_events', 'contact_tags'].includes(t) ? `, '${CONTACT_OF[k]}'` : ''})`).join(', ') + ';').join('\n') +
  ['blocked_times', 'event_type_reminders'].map((t) => `INSERT INTO public.${t} (id, event_type_id) VALUES ` +
    KS.map((k) => `('${rowOf(t, k)}', '${ET_OF[k]}')`).join(', ') + ';').join('\n') +
  `INSERT INTO public.staff_allowances (id, profile_id) VALUES ` + KS.map((k) => `('${rowOf('staff_allowances', k)}', '${PROFILE_OF[k]}')`).join(', ') + ';' +
  ['event_reminder_sends', 'host_contacts', 'host_campaigns'].map((t) => `INSERT INTO public.${t} (id) VALUES ` +
    KS.map((k) => `('${rowOf(t, k)}')`).join(', ') + ';').join('\n')

// One INSERT per table that satisfies its NOT NULLs.
const INSERT = {
  blocked_times: `INSERT INTO public.blocked_times (event_type_id) VALUES ('${ET_A}')`,
  contact_events: `INSERT INTO public.contact_events (contact_id, location_id) VALUES ('${IDS.C_MEMBER}', '${IDS.LOC_A}')`,
  contact_tags: `INSERT INTO public.contact_tags (contact_id, location_id) VALUES ('${IDS.C_MEMBER}', '${IDS.LOC_A}')`,
  shift_block_removals: `INSERT INTO public.shift_block_removals (location_id) VALUES ('${IDS.LOC_A}')`,
  staff_allowances: `INSERT INTO public.staff_allowances (profile_id) VALUES ('${IDS.STAFF_A}')`,
  scheduled_reports: `INSERT INTO public.scheduled_reports (location_id) VALUES ('${IDS.LOC_A}')`,
  race_checkins: `INSERT INTO public.race_checkins (location_id) VALUES ('${IDS.LOC_A}')`,
  event_type_reminders: `INSERT INTO public.event_type_reminders (event_type_id) VALUES ('${ET_A}')`,
  promo_codes: `INSERT INTO public.promo_codes (location_id) VALUES ('${IDS.LOC_A}')`,
  event_reminder_sends: 'INSERT INTO public.event_reminder_sends DEFAULT VALUES',
  host_contacts: 'INSERT INTO public.host_contacts DEFAULT VALUES',
  host_campaigns: 'INSERT INTO public.host_campaigns DEFAULT VALUES',
}
const UPDATE = (t) => `UPDATE public.${t} SET id = id WHERE id = '${rowOf(t, 1)}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE id = '${rowOf(t, 2)}'`
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`

// The rollback records (PR body). Prod is in 677's end state
// (authenticated=arwd/postgres, no anon, on all twelve), so the POST_677
// GRANT is the one to use; the PRE_677 form would hand anon everything back.
const ROLLBACK_POLICIES = { 2: C112_POLICY_SQL, 3: C121_POLICY_SQL }
const ROLLBACK_TABLES = { 2: C112_TABLES, 3: C121_TABLES }
const rollback = (part, post677) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${post677
    ? `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ROLLBACK_TABLES[part].map((t) => `public.${t}`).join(', ')} TO authenticated;`
    : `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ${ROLLBACK_TABLES[part].map((t) => `public.${t}`).join(', ')} TO anon, authenticated;`}
${ROLLBACK_POLICIES[part]}
COMMIT;
`
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

describe.each(PROD_STATES)('before 692: the holes (prod on 2 Oct 2026), $label', ({ after677 }) => {
  let db
  beforeAll(async () => { db = await boot({ ...baseSpec, after677 }) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)("the client grants on %s are the state's (default privileges, or 677's arwd for authenticated and nothing for anon)", async (t) => {
    const held = (await clientPrivileges(db, t)).filter((h) => !h.includes(':col-'))
    const expected = [
      ...(after677 ? [] : ALL_PRIVS.map((p) => `anon:${p}`)),
      ...AUTH_BEFORE[after677].map((p) => `authenticated:${p}`),
    ]
    expect(held.sort()).toEqual(expected.sort())
  })

  it("the replay's 20 policies read exactly as prod's pg_policies", async () => {
    expect(await policiesOf(db, ['event_types', ...TABLES])).toEqual(PROD_POLICIES)
  })

  it('plain staff at A: reads every A row behind the membership policies, inserts a tag, deletes a contact event, moves a blocked time; reads its own allowance only', async () => {
    for (const t of ['blocked_times', 'contact_events', 'contact_tags', 'race_checkins', 'event_type_reminders']) {
      expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 2 }])
    }
    for (const t of ['shift_block_removals', 'scheduled_reports', ...NO_POLICY]) {
      expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 0 }])
    }
    expect(await asUser(db, IDS.STAFF_A, count('staff_allowances'))).toEqual([{ n: 1 }])
    expect(await asUser(db, IDS.STAFF_A, `${INSERT.contact_tags} RETURNING tag`)).toEqual([{ tag: 'vip' }])
    expect(await asUser(db, IDS.STAFF_A, `${DELETE('contact_events')} RETURNING kind`)).toEqual([{ kind: 'note' }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.blocked_times SET starts_at = '2026-10-06 09:00+00' WHERE id = '${rowOf('blocked_times', 1)}' RETURNING id::text`))
      .toEqual([{ id: rowOf('blocked_times', 1) }])
    await expect(asUser(db, IDS.STAFF_A, INSERT.scheduled_reports)).rejects.toThrow(rlsRefused('scheduled_reports'))
  })

  it('a member (no profile) tags ANY contact, even at another studio, and writes a contact event for it, by leaving location_id NULL', async () => {
    expect(await asUser(db, IDS.MEMBER_UID,
      `INSERT INTO public.contact_tags (contact_id, location_id, tag) VALUES ('${IDS.C_B}', NULL, 'spam') RETURNING tag`,
      `SELECT count(*)::int AS n FROM public.contact_tags`)).toEqual([{ n: 1 }])
    expect(await asUser(db, IDS.MEMBER_UID,
      `INSERT INTO public.contact_events (contact_id, location_id, kind) VALUES ('${IDS.C_B}', NULL, 'forged') RETURNING kind`))
      .toEqual([{ kind: 'forged' }])
    for (const t of TABLES) expect(await asUser(db, IDS.MEMBER_UID, count(t)), t).toEqual([{ n: 0 }])
  })

  it('owner at A (a manager): writes scheduled reports, slot removals, allowances and reminders from the browser', async () => {
    for (const t of ['shift_block_removals', 'scheduled_reports', 'staff_allowances', 'event_type_reminders']) {
      expect(await asUser(db, IDS.OWNER_A, count(t)), t).toEqual([{ n: 2 }])
    }
    expect(await asUser(db, IDS.OWNER_A,
      `UPDATE public.scheduled_reports SET recipients = ARRAY['someone@example.com'] WHERE id = '${rowOf('scheduled_reports', 1)}' RETURNING name`))
      .toEqual([{ name: 'weekly' }])
    expect(await asUser(db, IDS.OWNER_A, `${DELETE('shift_block_removals')} RETURNING id::text`)).toEqual([{ id: rowOf('shift_block_removals', 2) }])
    expect(await asUser(db, IDS.OWNER_A,
      `UPDATE public.staff_allowances SET days = 99 WHERE id = '${rowOf('staff_allowances', 1)}' RETURNING days::int`)).toEqual([{ days: 99 }])
    expect(await asUser(db, IDS.OWNER_A, `${INSERT.event_type_reminders} RETURNING offset_minutes`)).toEqual([{ offset_minutes: 60 }])
  })

  it('the four policy-less tables: authenticated holds arwd, so RLS (no policy) is the only fence', async () => {
    for (const t of NO_POLICY) {
      expect(await asUser(db, IDS.MASTER, count(t)), t).toEqual([{ n: 0 }])
      await expect(asUser(db, IDS.MASTER, INSERT[t]), t).rejects.toThrow(rlsRefused(t))
    }
  })

  it('anon: before 677 a read returns 0 rows (every policy is TO authenticated); after it the grant refuses', async () => {
    for (const t of TABLES) {
      if (after677) await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      else expect(await asRole(db, 'anon', count(t)), t).toEqual([{ n: 0 }])
    }
  })
})

describe.each(PROD_STATES)('after 692: the catalog, $label', ({ after677 }) => {
  let db
  beforeAll(async () => { db = await boot({ ...baseSpec, after677, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)('%s: no client privilege, RLS on, service_role DML, no policy', async (t) => {
    expect(await clientPrivileges(db, t)).toEqual([])
    expect(await rlsOn(db, t)).toBe(true)
    expect(await serviceRoleDml(db, t)).toBe(true)
    expect(await policiesOf(db, [t])).toEqual([])
  })

  it('event_types keeps exactly its studio read: authenticated SELECT, anon nothing, the one policy unchanged', async () => {
    expect(await clientPrivileges(db, 'event_types')).toEqual(['authenticated:SELECT', 'authenticated:col-SELECT'])
    expect(await rlsOn(db, 'event_types')).toBe(true)
    expect(await serviceRoleDml(db, 'event_types')).toBe(true)
    expect(await policiesOf(db, ['event_types'])).toEqual([pol('event_types', 'event_types_select', 'SELECT', P_IN, null)])
  })
})

describe.each(PROD_STATES)('after 692: people, $label', ({ after677 }) => {
  let db
  beforeAll(async () => { db = await boot({ ...baseSpec, after677, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on all twelve is refused by the grant', async () => {
    for (const uid of [IDS.STAFF_A, IDS.OWNER_A, IDS.MASTER, IDS.MEMBER_UID]) {
      for (const t of TABLES) {
        await expect(asUser(db, uid, count(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, INSERT[t]), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, UPDATE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, DELETE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `TRUNCATE public.${t}`), `${uid} ${t}`).rejects.toThrow(/permission denied/)
      }
    }
    // The finding's own write, as the member: refused.
    await expect(asUser(db, IDS.MEMBER_UID,
      `INSERT INTO public.contact_tags (contact_id, location_id, tag) VALUES ('${IDS.C_B}', NULL, 'spam')`)).rejects.toThrow(denied('contact_tags'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
    }
  })

  it("event_types: staff still read their studio's types (the phone's bookings embed), a member reads none, nobody writes", async () => {
    expect(await asUser(db, IDS.STAFF_A, 'SELECT id::text FROM public.event_types')).toEqual([{ id: ET_A }])
    expect(await asUser(db, IDS.MEMBER_UID, count('event_types'))).toEqual([{ n: 0 }])
    await expect(asUser(db, IDS.OWNER_A, `UPDATE public.event_types SET name = 'x' WHERE id = '${ET_A}'`)).rejects.toThrow(denied('event_types'))
    await expect(asRole(db, 'anon', count('event_types'))).rejects.toThrow(denied('event_types'))
  })

  it('service_role: every table takes an insert and an update', async () => {
    for (const t of TABLES) {
      expect(await asRole(db, 'service_role', INSERT[t], UPDATE(t), count(t)), t).toEqual([{ n: 4 }])
    }
  })

  it('service_role: deleting an event type takes its blocked times and reminders (the FK cascades run as the owner)', async () => {
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.event_types WHERE id = '${ET_A}'`,
      `SELECT (SELECT count(*)::int FROM public.blocked_times) AS bt, (SELECT count(*)::int FROM public.event_type_reminders) AS etr`))
      .toEqual([{ bt: 1, etr: 1 }])
  })
})

describe.each(PROD_STATES)('the self-check aborts the whole file, $label', ({ after677 }) => {
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    db = await boot({ ...baseSpec, after677, before })
    expect(await abortMessage(db, MIG)).toMatch(message)
    // Nothing applied: the old policies and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['contact_tags_location_scoped', 'scheduled_reports_upd']))
    expect(await clientPrivileges(db, 'contact_tags')).toContain('authenticated:UPDATE')
  }

  it("when another grantor's UPDATE on contact_tags to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.contact_tags TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.contact_tags TO authenticated; RESET ROLE;`,
    /mig 692: (client roles still hold privileges on public\.contact_tags: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.contact_tags)/,
  ), 120_000)

  it('when INSERT on scheduled_reports is inherited through role membership', () => expectAbort(
    'GRANT INSERT ON public.scheduled_reports TO sneaky; GRANT sneaky TO authenticated;',
    /mig 692: authenticated still holds INSERT on public\.scheduled_reports/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (days) on staff_allowances survives", () => expectAbort(
    `GRANT UPDATE (days) ON public.staff_allowances TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (days) ON public.staff_allowances TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.staff_allowances|client roles still hold privileges on public\.staff_allowances/,
  ), 120_000)

  it('when a policy the file does not know about is left on host_contacts', () => expectAbort(
    'CREATE POLICY hc_stray ON public.host_contacts FOR SELECT TO authenticated USING (true);',
    /mig 692: public\.host_contacts should have no policy left: hc_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads contact_tags as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.contact_tags));`,
    /mig 692: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on promo_codes', () => expectAbort(
    'ALTER TABLE public.promo_codes DISABLE ROW LEVEL SECURITY;',
    /mig 692: row level security is off on public\.promo_codes/,
  ), 120_000)

  it("when another grantor's INSERT on event_types to authenticated survives (event_types stays read-only)", () => expectAbort(
    `GRANT ALL ON public.event_types TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT INSERT ON public.event_types TO authenticated; RESET ROLE;`,
    /mig 692: (client roles hold more than authenticated SELECT on public\.event_types|authenticated holds INSERT on public\.event_types)/,
  ), 120_000)

  it('when event_types carries a policy besides its studio read', () => expectAbort(
    'CREATE POLICY et_all ON public.event_types FOR SELECT TO authenticated USING (true);',
    /mig 692: public\.event_types should keep exactly one policy, event_types_select/,
  ), 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes its own self-check', async () => {
    db = await boot({ ...baseSpec, after677, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual([])
  }, 120_000)

  it('the two rollback records (C112, C121) restore the 19 policies and the before privileges (and so the holes)', async () => {
    db = await boot({ ...baseSpec, after677 })
    const policiesBefore = await policiesOf(db, ['event_types', ...TABLES])
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    const etBefore = await clientPrivileges(db, 'event_types')
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, rollback(2, after677))).toBeNull()
    expect(await abortMessage(db, rollback(3, after677))).toBeNull()
    expect(await policiesOf(db, ['event_types', ...TABLES])).toEqual(policiesBefore)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    // On prod (after 677) 692 does not change event_types at all.
    if (after677) expect(await clientPrivileges(db, 'event_types')).toEqual(etBefore)
    expect(await asUser(db, IDS.STAFF_A, count('contact_tags'))).toEqual([{ n: 2 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed: use the POST_677 form on prod', async () => {
      db = await boot({ ...baseSpec, after677 })
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, rollback(2, false))).toBeNull()
      const held = await clientPrivileges(db, 'contact_tags')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  }
})
