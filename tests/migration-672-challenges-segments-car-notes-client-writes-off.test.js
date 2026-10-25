// ANYMEMBERWRITE.1 — behavioural test for migration 672.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role —
// the source of the three tables' arwdDxtm), challenges, contact_segments and
// car_notes in PROD column order (30 Sep 2026) with their FKs, CHECKs and
// UNIQUE, the ten live policies verbatim (TO public, as prod), contacts with
// contacts_select verbatim and its post-653/657 privileges (challenges_read
// reads contacts as the caller), and private.auth_is_master,
// private.auth_is_in_location and private.auth_contact_id verbatim with
// their prod EXECUTE (auth_is_master: PUBLIC; the other two: authenticated
// and service_role). cars and contact_segment_memberships are reduced to the
// columns the FKs need. It proves:
//
//   * BEFORE: a PLAIN STAFF member creates a challenge that starts today (the
//     cron would push its name to every app-linked member), re-arms a sent
//     announcement and deletes the running challenge; stamps
//     memberships_initialized_at on an unsynced segment (the next sync would
//     enrol the whole membership) and deletes a segment (memberships
//     cascade); attaches a note to ANOTHER studio's car; an owner at the car
//     studio (the policy cannot see car_processing) forges a system note and
//     reads the deposit link; a member reads only their studio's RUNNING
//     challenge and writes nothing; anon errors on a helper;
//   * AFTER: every write (and LOCK … ACCESS EXCLUSIVE, i.e. MAINTAIN) refused
//     for authenticated, masters included, on all three; car_notes refused
//     even a read; anon refused by the grant itself; challenges_read and
//     contact_segments_select exactly as before; the same rows read by staff,
//     the member and the master; every service-role path (routes, the
//     challenge cron's claim, the segment sync's stamp, the deposit-link
//     system note, cascades) still works;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (write, anon read, car_notes read), an inherited write, a leftover
//     write policy, an extra read policy, any car_notes policy, RLS off, and
//     a kept read policy changed by the file (expression or roles); a second
//     run passes; the plan's rollback record restores the before-state.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_672 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/672_challenges_segments_car_notes_client_writes_off.sql'), 'utf8')

// The rollback record from the C83 plan (Task 5 Step 7), verbatim.
const ROLLBACK_672 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.challenges, public.contact_segments, public.car_notes
  TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.challenges, public.contact_segments
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.car_notes
  TO authenticated;
CREATE POLICY challenges_ins ON public.challenges FOR INSERT TO public
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY challenges_upd ON public.challenges FOR UPDATE TO public
  USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id))
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY challenges_del ON public.challenges FOR DELETE TO public
  USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
CREATE POLICY contact_segments_insert ON public.contact_segments FOR INSERT TO public
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY contact_segments_update ON public.contact_segments FOR UPDATE TO public
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY contact_segments_delete ON public.contact_segments FOR DELETE TO public
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY car_notes_select ON public.car_notes FOR SELECT TO public
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY car_notes_insert ON public.car_notes FOR INSERT TO public
  WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
CREATE POLICY car_notes_delete ON public.car_notes FOR DELETE TO public
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
COMMENT ON TABLE public.car_notes IS NULL;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'   // a studio
const LOC_C = 'c0000000-0000-0000-0000-00000000000c'   // the car business
const STAFF_A = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const MANAGER_A = '10000000-0000-0000-0000-000000000002'
const OWNER_C = '10000000-0000-0000-0000-000000000003'   // owner at C (car_processing is per user, off by default)
const MASTER = '10000000-0000-0000-0000-000000000004'
const MEMBER_UID = '20000000-0000-0000-0000-000000000001' // a customer's auth user (no profile)
const CONTACT_M = '30000000-0000-0000-0000-000000000001'
const CH_RUN = '40000000-0000-0000-0000-000000000001'    // running, start announced
const CH_DONE = '40000000-0000-0000-0000-000000000002'   // flagship, ended 3 days ago
const SEG_A = '50000000-0000-0000-0000-000000000001'     // not yet synced
const CAR_C = '60000000-0000-0000-0000-000000000001'
const NOTE_C = '70000000-0000-0000-0000-000000000001'    // a system note with a deposit link

const CH = 'challenges'
const SEG = 'contact_segments'
const NOTES = 'car_notes'
const TABLES = [CH, NOTES, SEG]
const READ_KEPT = { [CH]: true, [SEG]: true, [NOTES]: false }
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)
const rlsRefused = (t) => new RegExp(`new row violates row-level security policy for table "${t}"`)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- live: anon has none

  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;   -- mig 153b

  -- contacts: only what challenges_read touches. contacts_select verbatim;
  -- post-653 authenticated SELECT only, post-657 anon nothing.
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, user_id uuid, location_id uuid REFERENCES public.locations(id));
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.contacts FROM authenticated;
  REVOKE ALL ON public.contacts FROM anon;

  -- Reduced to the columns the FKs need.
  CREATE TABLE public.cars (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id));

  -- The three tables: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 30 Sep 2026).
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
  CREATE TABLE public.contact_segments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    filter jsonb NOT NULL DEFAULT '{"logic": "and", "filters": []}'::jsonb,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    memberships_initialized_at timestamptz,
    CONSTRAINT contact_segments_location_id_name_key UNIQUE (location_id, name)
  );
  CREATE TABLE public.contact_segment_memberships (
    segment_id uuid NOT NULL REFERENCES public.contact_segments(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL
  );
  CREATE TABLE public.car_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    car_id uuid NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
    location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
    content text NOT NULL,
    kind text NOT NULL DEFAULT 'manual' CONSTRAINT car_notes_kind_check CHECK (kind = ANY (ARRAY['manual'::text, 'system'::text])),
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now()
  );

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
  -- Prod EXECUTE: auth_is_master keeps the PUBLIC default; the other two
  -- postgres + authenticated + service_role (so anon errors on them).
  REVOKE EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() TO authenticated, service_role;
`

// The live policies (pg_policies, 30 Sep 2026; migs 043, 047, 320, contacts).
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
  CREATE POLICY challenges_ins ON public.challenges FOR INSERT TO public
    WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
  CREATE POLICY challenges_upd ON public.challenges FOR UPDATE TO public
    USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id))
    WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
  CREATE POLICY challenges_del ON public.challenges FOR DELETE TO public
    USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));

  ALTER TABLE public.contact_segments ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_segments_select ON public.contact_segments FOR SELECT TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY contact_segments_insert ON public.contact_segments FOR INSERT TO public
    WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY contact_segments_update ON public.contact_segments FOR UPDATE TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY contact_segments_delete ON public.contact_segments FOR DELETE TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));

  ALTER TABLE public.car_notes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY car_notes_select ON public.car_notes FOR SELECT TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY car_notes_insert ON public.car_notes FOR INSERT TO public
    WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY car_notes_delete ON public.car_notes FOR DELETE TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_C}');
  INSERT INTO public.profiles (id, role) VALUES
    ('${STAFF_A}', 'staff'), ('${MANAGER_A}', 'manager'), ('${OWNER_C}', 'owner'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES
    ('${STAFF_A}', '${LOC_A}', 'staff'), ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${OWNER_C}', '${LOC_C}', 'owner');
  INSERT INTO public.contacts VALUES ('${CONTACT_M}', '${MEMBER_UID}', '${LOC_A}');
  INSERT INTO public.challenges (id, location_id, name, mode, metric, starts_on, ends_on, announced_start_at, is_flagship) VALUES
    ('${CH_RUN}', '${LOC_A}', 'Synthetic running', 'individual', 'classes', current_date - 5, current_date + 10, now() - interval '5 days', false),
    ('${CH_DONE}', '${LOC_A}', 'Synthetic flagship', 'individual', 'points', current_date - 40, current_date - 3, now() - interval '40 days', true);
  INSERT INTO public.contact_segments (id, location_id, name, filter) VALUES
    ('${SEG_A}', '${LOC_A}', 'Synthetic segment', '{"logic":"and","filters":[{"field":"status","op":"eq","value":"lead"}]}');
  INSERT INTO public.contact_segment_memberships VALUES ('${SEG_A}', '${CONTACT_M}');
  INSERT INTO public.cars VALUES ('${CAR_C}', '${LOC_C}');
  INSERT INTO public.car_notes (id, car_id, location_id, content, kind, created_by) VALUES
    ('${NOTE_C}', '${CAR_C}', '${LOC_C}', 'Deposit link issued. Share it with the buyer: https://example.invalid/deposit/synthetic-token', 'system', '${OWNER_C}');
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run statements as an authenticated JWT for `uid` in a rolled-back tx; returns the LAST statement's rows. */
async function asUser(uid, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function asRole(role, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function policies() {
  const { rows } = await db.query(
    `SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, [TABLES])
  return rows
}

async function clientAcl(table) {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = ('public.' || $1)::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`, [table])
  return rows
}

const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_672)
}

describe('before 672 — the hole (prod on 30 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the default privileges gave both client roles every privilege on %s (arwdDxtm, PG 17)', async (t) => {
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it('plain staff: creates a challenge that starts today, re-arms a sent announcement, deletes the running one', async () => {
    expect(await asUser(STAFF_A,
      `INSERT INTO public.challenges (location_id, name, mode, metric, starts_on, ends_on)
       VALUES ('${LOC_A}', 'Synthetic push text', 'individual', 'classes', current_date, current_date + 7)
       RETURNING (starts_on = current_date) AS starts_today, announced_start_at`))
      .toEqual([{ starts_today: true, announced_start_at: null }])
    expect(await asUser(STAFF_A,
      `UPDATE public.challenges SET announced_start_at = NULL, starts_on = current_date WHERE id = '${CH_RUN}' RETURNING announced_start_at`))
      .toEqual([{ announced_start_at: null }])
    expect(await asUser(STAFF_A, `DELETE FROM public.challenges WHERE id = '${CH_RUN}' RETURNING id`)).toEqual([{ id: CH_RUN }])
  })

  it('plain staff: stamps an unsynced segment as initialised, rewrites its filter unvalidated, deletes it (memberships cascade)', async () => {
    expect(await asUser(STAFF_A,
      `UPDATE public.contact_segments SET memberships_initialized_at = now() - interval '1 day', filter = '{"logic":"and","filters":[]}'
        WHERE id = '${SEG_A}' RETURNING (memberships_initialized_at IS NOT NULL) AS stamped`)).toEqual([{ stamped: true }])
    expect(await asUser(STAFF_A,
      `INSERT INTO public.contact_segments (location_id, name, filter) VALUES ('${LOC_A}', 'Synthetic unvalidated', '{"nonsense":true}') RETURNING name`))
      .toEqual([{ name: 'Synthetic unvalidated' }])
    expect(await asUser(STAFF_A,
      `DELETE FROM public.contact_segments WHERE id = '${SEG_A}'`,
      `SELECT count(*)::int AS n FROM public.contact_segment_memberships`)).toEqual([{ n: 0 }])
  })

  it('car notes: an owner at the car studio forges a system note and reads the deposit link; staff elsewhere attach a note to that car', async () => {
    expect(await asUser(OWNER_C,
      `INSERT INTO public.car_notes (car_id, location_id, content, kind) VALUES ('${CAR_C}', '${LOC_C}', 'forged', 'system') RETURNING kind`))
      .toEqual([{ kind: 'system' }])
    expect(await asUser(OWNER_C, `SELECT count(*)::int AS n FROM public.car_notes WHERE content LIKE '%/deposit/%'`)).toEqual([{ n: 1 }])
    expect(await asUser(OWNER_C, `DELETE FROM public.car_notes WHERE id = '${NOTE_C}' RETURNING id`)).toEqual([{ id: NOTE_C }])
    expect(await asUser(STAFF_A,
      `INSERT INTO public.car_notes (car_id, location_id, content) VALUES ('${CAR_C}', '${LOC_A}', 'cross-studio') RETURNING car_id`))
      .toEqual([{ car_id: CAR_C }])
  })

  it('a member reads only the running challenge at their studio (not the ended flagship) and writes nothing', async () => {
    expect(await asUser(MEMBER_UID, 'SELECT id FROM public.challenges ORDER BY id')).toEqual([{ id: CH_RUN }])
    await expect(asUser(MEMBER_UID,
      `INSERT INTO public.challenges (location_id, name, mode, metric, starts_on, ends_on)
       VALUES ('${LOC_A}', 'x', 'individual', 'classes', current_date, current_date)`)).rejects.toThrow(rlsRefused(CH))
    expect(await asUser(MEMBER_UID, count(SEG))).toEqual([{ n: 0 }])
    expect(await asUser(MEMBER_UID, count(NOTES))).toEqual([{ n: 0 }])
  })

  it('anon reaches no row: every read errors on a helper or on contacts, not on the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole('anon', count(t))).rejects.toThrow(/permission denied for (table contacts|function auth_is_in_location|function auth_contact_id)/)
    }
  })
})

describe('after 672 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('anon and public hold nothing; authenticated holds only what it reads (MAINTAIN checked) on %s', async (t) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of ALL_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} ${t}`).toBe(role === 'authenticated' && p === 'SELECT' && READ_KEPT[t])
      }
    }
  })

  it.each(TABLES)('%s: no column-level client privilege; RLS on; service_role still reads and writes', async (t) => {
    const rel = `public.${t}`
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', $1, 'INSERT') OR has_any_column_privilege('authenticated', $1, 'UPDATE')
        OR has_any_column_privilege('authenticated', $1, 'REFERENCES') AS a_col,
      has_any_column_privilege('anon', $1, 'SELECT') OR has_any_column_privilege('anon', $1, 'INSERT')
        OR has_any_column_privilege('anon', $1, 'UPDATE') AS n_col,
      has_table_privilege('service_role', $1, 'SELECT') AND has_table_privilege('service_role', $1, 'INSERT')
        AND has_table_privilege('service_role', $1, 'UPDATE') AND has_table_privilege('service_role', $1, 'DELETE') AS svc,
      (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`, [rel])
    expect(r).toEqual({ a_col: false, n_col: false, svc: true, rls: true })
    expect(await clientAcl(t)).toEqual(READ_KEPT[t] ? [{ grantee: 'authenticated', privs: 'SELECT' }] : [])
  })

  it('exactly the two kept read policies remain, identical to before in every column; car_notes has none', async () => {
    const after = await policies()
    await db.close()
    await boot()
    const before = (await policies()).filter((p) => ['challenges_read', 'contact_segments_select'].includes(p.policyname))
    expect(after).toEqual(before)
    expect(after.map((p) => p.policyname)).toEqual(['challenges_read', 'contact_segments_select'])
  })
})

describe('after 672 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['plain staff', STAFF_A], ['manager', MANAGER_A], ['car-studio owner', OWNER_C], ['master', MASTER]])(
    '%s: INSERT, UPDATE, UPSERT, DELETE, TRUNCATE and LOCK are refused on all three; car_notes refuses even a read', async (_l, uid) => {
      await expect(asUser(uid, `INSERT INTO public.challenges (location_id, name, mode, metric, starts_on, ends_on)
        VALUES ('${LOC_A}', 'x', 'individual', 'classes', current_date, current_date)`)).rejects.toThrow(denied(CH))
      await expect(asUser(uid, `UPDATE public.challenges SET announced_start_at = NULL WHERE id = '${CH_RUN}'`)).rejects.toThrow(denied(CH))
      await expect(asUser(uid, `INSERT INTO public.challenges (id, location_id, name, mode, metric, starts_on, ends_on)
        VALUES ('${CH_RUN}', '${LOC_A}', 'x', 'individual', 'classes', current_date, current_date)
        ON CONFLICT (id) DO UPDATE SET name = 'x'`)).rejects.toThrow(denied(CH))
      await expect(asUser(uid, `DELETE FROM public.challenges WHERE id = '${CH_RUN}'`)).rejects.toThrow(denied(CH))
      await expect(asUser(uid, `INSERT INTO public.contact_segments (location_id, name) VALUES ('${LOC_A}', 'x')`)).rejects.toThrow(denied(SEG))
      await expect(asUser(uid, `UPDATE public.contact_segments SET memberships_initialized_at = now() WHERE id = '${SEG_A}'`))
        .rejects.toThrow(denied(SEG))
      await expect(asUser(uid, `DELETE FROM public.contact_segments WHERE id = '${SEG_A}'`)).rejects.toThrow(denied(SEG))
      await expect(asUser(uid, `INSERT INTO public.car_notes (car_id, location_id, content, kind) VALUES ('${CAR_C}', '${LOC_C}', 'x', 'system')`))
        .rejects.toThrow(denied(NOTES))
      await expect(asUser(uid, `DELETE FROM public.car_notes WHERE id = '${NOTE_C}'`)).rejects.toThrow(denied(NOTES))
      await expect(asUser(uid, count(NOTES))).rejects.toThrow(denied(NOTES))
      for (const t of TABLES) {
        await expect(asUser(uid, `TRUNCATE public.${t} CASCADE`)).rejects.toThrow(/permission denied/)
        await expect(asUser(uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied(t))
      }
    })

  it('reads are unchanged: staff and manager see their studio, the member the running challenge only, the master everything', async () => {
    expect(await asUser(STAFF_A, 'SELECT id FROM public.challenges ORDER BY id')).toEqual([{ id: CH_RUN }, { id: CH_DONE }])
    expect(await asUser(STAFF_A, count(SEG))).toEqual([{ n: 1 }])
    expect(await asUser(MANAGER_A, count(CH))).toEqual([{ n: 2 }])
    expect(await asUser(OWNER_C, count(CH))).toEqual([{ n: 0 }])
    expect(await asUser(MEMBER_UID, 'SELECT id FROM public.challenges ORDER BY id')).toEqual([{ id: CH_RUN }])
    expect(await asUser(MEMBER_UID, count(SEG))).toEqual([{ n: 0 }])
    expect(await asUser(MASTER, count(CH))).toEqual([{ n: 2 }])
    expect(await asUser(MASTER, count(SEG))).toEqual([{ n: 1 }])
  })

  it('the phone’s Compete and Wrapped reads keep their shape (member session)', async () => {
    expect(await asUser(MEMBER_UID,
      `SELECT id, name, mode, metric, starts_on, ends_on, is_flagship FROM public.challenges
        WHERE is_flagship = true AND ends_on >= current_date - 30 ORDER BY ends_on DESC`)).toEqual([])
    expect((await asUser(MEMBER_UID,
      `SELECT id, name, mode, metric, starts_on, ends_on, target, is_flagship FROM public.challenges WHERE id = '${CH_RUN}'`)).map((r) => r.id))
      .toEqual([CH_RUN])
  })

  it('service_role: challenge routes, the cron claim, segment routes + sync stamp, car notes routes + deposit note, cascades', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.challenges (location_id, name, mode, metric, starts_on, ends_on, created_by)
       VALUES ('${LOC_A}', 'Synthetic new', 'collective', 'points', current_date + 1, current_date + 8, '${MANAGER_A}')`,
      `UPDATE public.challenges SET name = 'Synthetic renamed', updated_at = now() WHERE id = '${CH_RUN}'`,
      `UPDATE public.challenges SET announced_end_at = now() WHERE id = '${CH_DONE}' AND announced_end_at IS NULL`,
      `DELETE FROM public.challenges WHERE id = '${CH_DONE}'`,
      `INSERT INTO public.contact_segments (location_id, name, filter, created_by) VALUES ('${LOC_A}', 'Synthetic two', '{"logic":"and","filters":[]}', '${STAFF_A}')`,
      `UPDATE public.contact_segments SET memberships_initialized_at = now() WHERE id = '${SEG_A}'`,
      `INSERT INTO public.car_notes (car_id, location_id, content, kind, created_by) VALUES ('${CAR_C}', '${LOC_C}', 'manual note', 'manual', '${OWNER_C}')`,
      `INSERT INTO public.car_notes (car_id, location_id, content, kind, created_by) VALUES ('${CAR_C}', '${LOC_C}', 'Deposit link issued', 'system', '${OWNER_C}')`,
      `DELETE FROM public.car_notes WHERE id = '${NOTE_C}'`,
      `DELETE FROM public.contact_segments WHERE id = '${SEG_A}'`,
      `SELECT (SELECT count(*)::int FROM public.challenges) AS ch,
              (SELECT announced_end_at IS NULL FROM public.challenges WHERE id = '${CH_RUN}') AS run_end_open,
              (SELECT count(*)::int FROM public.contact_segments) AS seg,
              (SELECT count(*)::int FROM public.contact_segment_memberships) AS mem,
              (SELECT count(*)::int FROM public.car_notes) AS notes`)
    expect(rows).toEqual([{ ch: 2, run_end_open: true, seg: 1, mem: 0, notes: 2 }])
    expect(await asRole('service_role', `DELETE FROM public.cars WHERE id = '${CAR_C}'`, count(NOTES))).toEqual([{ n: 0 }])
  })

  it('anon: every read and write is refused by the grant itself', async () => {
    for (const t of TABLES) {
      await expect(asRole('anon', count(t))).rejects.toThrow(denied(t))
      await expect(asRole('anon', `DELETE FROM public.${t}`)).rejects.toThrow(denied(t))
    }
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG_672) {
    await boot({ before })
    await expect(runSql(sql)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    const names = (await policies()).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['challenges_ins', 'contact_segments_update', 'car_notes_select']))
    expect((await clientAcl(CH)).find((r) => r.grantee === 'authenticated').privs).toContain('UPDATE')
  }

  it("when another grantor's UPDATE on challenges survives the REVOKE", () => expectAbort(
    `GRANT UPDATE ON public.challenges TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.challenges TO authenticated; RESET ROLE;`,
    /mig 672: client roles still hold privileges on public\.challenges: authenticated:UPDATE/,
  ), 60_000)

  it("when another grantor's SELECT to anon survives on contact_segments (anon must hold nothing)", () => expectAbort(
    `GRANT SELECT ON public.contact_segments TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.contact_segments TO anon; RESET ROLE;`,
    /mig 672: client roles still hold privileges on public\.contact_segments: anon:SELECT/,
  ), 60_000)

  it("when another grantor's SELECT to authenticated survives on car_notes (car_notes must hold nothing)", () => expectAbort(
    `GRANT SELECT ON public.car_notes TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.car_notes TO authenticated; RESET ROLE;`,
    /mig 672: client roles still hold privileges on public\.car_notes: authenticated:SELECT/,
  ), 60_000)

  it('when INSERT on contact_segments is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.contact_segments TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 672: authenticated still holds INSERT on public\.contact_segments/,
  ), 60_000)

  it('when a write policy the file does not know about is left on challenges', () => expectAbort(
    `CREATE POLICY challenges_ins_extra ON public.challenges FOR INSERT TO authenticated WITH CHECK (true);`,
    /mig 672: write policies remain on public\.challenges: challenges_ins_extra INSERT/,
  ), 60_000)

  it('when an extra read policy sits on contact_segments', () => expectAbort(
    `CREATE POLICY seg_read_all ON public.contact_segments FOR SELECT TO authenticated USING (true);`,
    /mig 672: public\.contact_segments should keep exactly one policy, contact_segments_select FOR SELECT/,
  ), 60_000)

  it('when any policy is left on car_notes, even a read one', () => expectAbort(
    `CREATE POLICY car_notes_read_extra ON public.car_notes FOR SELECT TO authenticated USING (true);`,
    /mig 672: public\.car_notes should have no policy left: car_notes_read_extra SELECT/,
  ), 60_000)

  it('when RLS is off on car_notes (no privilege would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.car_notes DISABLE ROW LEVEL SECURITY;`,
    /mig 672: row level security is off on public\.car_notes/,
  ), 60_000)

  it('when the file changes challenges_read’s expression (self-check 6)', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS challenges_del ON public.challenges;\n'
    expect(MIG_672.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 672: challenges_read is not the policy it was before this file/,
      MIG_672.replace(NEEDLE, `${NEEDLE}DROP POLICY challenges_read ON public.challenges;
CREATE POLICY challenges_read ON public.challenges FOR SELECT TO public
  USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));
`))
  }, 60_000)

  it('when the file changes contact_segments_select’s roles (self-check 6)', () => {
    const NEEDLE = 'DROP POLICY IF EXISTS contact_segments_delete ON public.contact_segments;\n'
    expect(MIG_672.split(NEEDLE).length).toBe(2)
    return expectAbort('', /mig 672: contact_segments_select is not the policy it was before this file/,
      MIG_672.replace(NEEDLE, `${NEEDLE}DROP POLICY contact_segments_select ON public.contact_segments;
CREATE POLICY contact_segments_select ON public.contact_segments FOR SELECT TO authenticated
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
`))
  }, 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_672)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 30 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await Promise.all(TABLES.map(clientAcl))
    const policiesBefore = await policies()
    await runSql(MIG_672)
    await runSql(ROLLBACK_672)
    expect(await Promise.all(TABLES.map(clientAcl))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    const { rows: [c] } = await db.query(`SELECT obj_description('public.car_notes'::regclass, 'pg_class') AS d`)
    expect(c.d).toBeNull()
    expect(await asUser(STAFF_A, `UPDATE public.challenges SET announced_start_at = NULL WHERE id = '${CH_RUN}' RETURNING id`))
      .toEqual([{ id: CH_RUN }])
  }, 60_000)
})
