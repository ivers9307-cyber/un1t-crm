// EVENTTYPERLS.1b — behavioural test for migration 650.
//
// No local Supabase stack, so DDL would otherwise get its first execution on
// prod. This boots an in-process Postgres (PGlite) and recreates event_types
// the way prod has it (read 28 Sep 2026): Supabase's DEFAULT PRIVILEGES in
// schema public (ALL on new tables to anon, authenticated, service_role, so
// relacl = anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres), one
// PERMISSIVE FOR ALL policy TO authenticated on private.auth_is_in_location,
// the three live private.* helpers verbatim, the event_types_updated_at
// trigger, the four live event_type_reminders policies (whose EXISTS reads
// event_types AS THE CALLER), and a bookings table the phone embeds through.
// It proves:
//
//   * BEFORE: a plain staff member's own JWT INSERTs, UPDATEs and DELETEs a
//     booking type at their studio (the hole — so the "after" is not vacuous);
//   * the self-check aborts the WHOLE file when a write grant survives
//     (another grantor's grant, or one inherited through role membership);
//   * AFTER: INSERT/UPDATE/DELETE/TRUNCATE refused for anon and authenticated
//     (masters and managers too — every write is a service-role route);
//     exactly one SELECT policy; every reader sees EXACTLY what it saw before
//     (a snapshot taken pre-apply: staff, a manager, a member of the other
//     studio, a master, anon, the reminders policies' EXISTS, the phone's
//     bookings→event_types embed); service_role still writes; the file is
//     re-runnable.
//
// `npm run check:rls-restrictive` is run separately (it reads the migration
// files, not a database); 650 adds one permissive SELECT policy and no
// restrictive one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_650 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/650_event_types_browser_writes_off.sql'), 'utf8')

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'
const MANAGER_A = '10000000-0000-0000-0000-000000000002'
const STAFF_B = '10000000-0000-0000-0000-000000000003'
const MASTER = '10000000-0000-0000-0000-000000000004'
const ET_A = '20000000-0000-0000-0000-00000000000a'
const ET_B = '20000000-0000-0000-0000-00000000000b'
const BOOKING_A = '30000000-0000-0000-0000-00000000000a'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;   -- anon has none (live, 28 Sep)

  -- Supabase's default privileges: every table postgres creates in public is
  -- ALL to the three API roles. This is where prod's arwdDxtm comes from.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id),
    role text NOT NULL, PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.event_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text UNIQUE,
    active boolean DEFAULT true,
    location_id uuid REFERENCES public.locations(id),
    color text,
    webhook_url text,
    create_in_glofox boolean DEFAULT false,
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.event_type_reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type_id uuid REFERENCES public.event_types(id) ON DELETE CASCADE,
    hours_before int NOT NULL DEFAULT 24
  );
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations(id),
    event_type_id uuid REFERENCES public.event_types(id) ON DELETE SET NULL
  );

  -- The live BEFORE UPDATE trigger (event_types_updated_at).
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TRIGGER event_types_updated_at BEFORE UPDATE ON public.event_types
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- The three live helpers, verbatim (pg_get_functiondef, 28 Sep 2026).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid())
        AND role = 'master'
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    )
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
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
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
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
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.event_types ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.event_type_reminders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

  -- The live policy (mig 014, helper since moved to private.).
  CREATE POLICY event_types_location_scoped ON public.event_types
    FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id))
    WITH CHECK (private.auth_is_in_location(location_id));

  -- The four live event_type_reminders policies: each EXISTS reads event_types
  -- AS THE CALLER, so they need event_types SELECT (grant + policy) to survive.
  CREATE POLICY "event_type_reminders readable in-location" ON public.event_type_reminders
    FOR SELECT TO authenticated
    USING (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.event_types et
       WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_in_location(et.location_id)));
  CREATE POLICY event_type_reminders_ins ON public.event_type_reminders
    FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.event_types et
       WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)));
  CREATE POLICY event_type_reminders_upd ON public.event_type_reminders
    FOR UPDATE TO authenticated
    USING (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.event_types et
       WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)))
    WITH CHECK (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.event_types et
       WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)));
  CREATE POLICY event_type_reminders_del ON public.event_type_reminders
    FOR DELETE TO authenticated
    USING (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.event_types et
       WHERE et.id = event_type_reminders.event_type_id AND private.auth_is_manager_at(et.location_id)));

  -- bookings: simplified (prod also gates on the mobile 'bookings' permission,
  -- mig 219). What matters here is the event_types side of the phone's embed.
  CREATE POLICY bookings_select ON public.bookings FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES
    ('${STAFF_A}', 'staff'), ('${MANAGER_A}', 'manager'), ('${STAFF_B}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES
    ('${STAFF_A}', '${LOC_A}', 'staff'), ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${STAFF_B}', '${LOC_B}', 'staff');
  INSERT INTO public.event_types (id, name, slug, location_id, color) VALUES
    ('${ET_A}', 'Consult A', 'consult-a', '${LOC_A}', '#3B82F6'),
    ('${ET_B}', 'Consult B', 'consult-b', '${LOC_B}', '#10B981');
  INSERT INTO public.event_type_reminders (event_type_id) VALUES ('${ET_A}');
  INSERT INTO public.bookings (id, location_id, event_type_id) VALUES ('${BOOKING_A}', '${LOC_A}', '${ET_A}');
`

let db
// PGlite's multi-statement SQL runner (an in-process Postgres call, no shell,
// no child process), as in the 625/646 replays.
const runSql = (text) => db['exec'](text)

/** Run `sql` as `role` with a JWT for `uid`, inside a rolled-back tx; returns rows. */
async function asUser(uid, sql, role = 'authenticated') {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

const ids = (rows) => rows.map((r) => r.id).sort()
const policies = async () => (await db.query(`
  SELECT policyname, cmd, permissive, roles::text AS roles, qual, with_check FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'event_types' ORDER BY 1`)).rows
const heldPrivileges = async () => (await db.query(`
  SELECT r, p FROM unnest(ARRAY['anon','authenticated','public']) r,
                   unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
   WHERE has_table_privilege(r, 'public.event_types', p) ORDER BY 1, 2`)).rows.map((x) => `${x.r}:${x.p}`)
const relacl = async () => (await db.query(
  `SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.event_types'::regclass`)).rows[0].acl

const INSERT_AT_A = `INSERT INTO public.event_types (name, slug, location_id) VALUES ('Forged', 'forged', '${LOC_A}') RETURNING id`
const UPDATE_A = `UPDATE public.event_types SET webhook_url = 'https://attacker.example/hook', active = false, create_in_glofox = true WHERE id = '${ET_A}' RETURNING id`
const DELETE_A = `DELETE FROM public.event_types WHERE id = '${ET_A}' RETURNING id`

/**
 * Everything an RLS-bound reader gets out of event_types, directly or through
 * another table's policy / embed. Taken before 650 and compared after it.
 */
async function readMatrix() {
  const out = {}
  const readers = { STAFF_A, MANAGER_A, STAFF_B, MASTER }
  for (const [name, uid] of Object.entries(readers)) {
    out[name] = {
      event_types: ids(await asUser(uid, 'SELECT id FROM public.event_types')),
      // the reminders SELECT policy's EXISTS (SELECT 1 FROM event_types …)
      reminders: (await asUser(uid, 'SELECT count(*)::int AS n FROM public.event_type_reminders'))[0].n,
      // mobile/lib/bookings-api.js + contacts-api.js: bookings → event_types(name, color).
      // PostgREST's embed is a LEFT JOIN filtered by the embedded table's policy.
      embed: await asUser(uid, `
        SELECT b.id, et.name, et.color FROM public.bookings b
          LEFT JOIN public.event_types et ON et.id = b.event_type_id ORDER BY b.id`),
    }
  }
  out.anon = { event_types: ids(await asUser(null, 'SELECT id FROM public.event_types', 'anon')) }
  return out
}

let readsBefore

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
}, 60_000)
afterAll(async () => { await db?.close() })

describe('before 650: the browser write door is real (guards against a vacuous pass)', () => {
  it('the replay has prod\'s grants (Supabase default privileges, all granted by postgres)', async () => {
    const acl = await relacl()
    expect(acl).toContain('anon=arwdDxtm/postgres')
    expect(acl).toContain('authenticated=arwdDxtm/postgres')
    expect(acl).toContain('service_role=arwdDxtm/postgres')
  })

  it('a plain staff member inserts, rewrites and deletes a booking type at their studio', async () => {
    expect(await asUser(STAFF_A, INSERT_AT_A)).toHaveLength(1)
    expect(await asUser(STAFF_A, UPDATE_A)).toEqual([{ id: ET_A }])
    expect(await asUser(STAFF_A, DELETE_A)).toEqual([{ id: ET_A }])
  })

  it('...only at their own studio (the policy scopes rows, not roles)', async () => {
    await expect(asUser(STAFF_B, INSERT_AT_A)).rejects.toThrow(/row-level security/)
  })

  it('snapshot of every reader (compared after 650)', async () => {
    readsBefore = await readMatrix()
    // sanity: the snapshot is not empty-handed
    expect(readsBefore.STAFF_A.event_types).toEqual([ET_A])
    expect(readsBefore.MASTER.event_types).toEqual([ET_A, ET_B])
    expect(readsBefore.STAFF_A.embed).toEqual([{ id: BOOKING_A, name: 'Consult A', color: '#3B82F6' }])
  })
})

describe('the self-check aborts the WHOLE file when a write grant survives', () => {
  it('another grantor\'s INSERT outlives the REVOKE: the DO block raises and nothing is applied', async () => {
    await runSql(`
      GRANT INSERT ON public.event_types TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT INSERT ON public.event_types TO authenticated;
      RESET ROLE;
    `)
    await expect(runSql(MIG_650)).rejects.toThrow(/mig 650: anon\/authenticated still hold write privileges.*INSERT \(grantor other_grantor\)/)
    await runSql('ROLLBACK')
    expect((await policies()).map((p) => p.policyname)).toEqual(['event_types_location_scoped'])
    expect(await heldPrivileges()).toContain('anon:DELETE')
    await runSql(`
      SET ROLE other_grantor;
      REVOKE INSERT ON public.event_types FROM authenticated;
      RESET ROLE;
      REVOKE INSERT ON public.event_types FROM other_grantor;
    `)
  })

  it('an INHERITED write privilege (role membership) aborts it too', async () => {
    await runSql(`
      CREATE ROLE inherits_update NOLOGIN;
      GRANT UPDATE ON public.event_types TO inherits_update;
      GRANT inherits_update TO authenticated;
    `)
    await expect(runSql(MIG_650)).rejects.toThrow(/mig 650: authenticated still holds UPDATE on public.event_types/)
    await runSql('ROLLBACK')
    expect((await policies()).map((p) => p.policyname)).toEqual(['event_types_location_scoped'])
    await runSql(`
      REVOKE inherits_update FROM authenticated;
      REVOKE UPDATE ON public.event_types FROM inherits_update;
      DROP ROLE inherits_update;
    `)
  })

  it('after both aborts the table is exactly as prod has it', async () => {
    expect(await relacl()).toBe('{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
  })
})

describe('after 650', () => {
  beforeAll(async () => { await runSql(MIG_650) }, 60_000)

  it('takes a short lock_timeout inside its transaction (it touches a live table)', () => {
    const begin = MIG_650.search(/^BEGIN;$/m)
    const lock = MIG_650.search(/^SET LOCAL lock_timeout = '5s';$/m)
    const firstDdl = MIG_650.search(/^(DROP|CREATE|REVOKE|ALTER|GRANT) /m)
    expect(begin).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(begin)
    expect(firstDdl).toBeGreaterThan(lock)
  })

  it('anon and authenticated hold exactly SELECT (the real catalog, inherited roles included)', async () => {
    expect(await heldPrivileges()).toEqual(['anon:SELECT', 'authenticated:SELECT'])
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'event_types'
         AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type <> 'SELECT'`)
    expect(rows[0].n).toBe(0)
    // r = SELECT, m = MAINTAIN (Postgres 17, prod is 17.6): VACUUM/ANALYZE/
    // LOCK, no data write and no PostgREST path. Mig 625 left it the same
    // way (time_off_requests is anon=rm/postgres live); C15 GRANTSWEEP's.
    expect(await relacl()).toBe('{postgres=arwdDxtm/postgres,anon=rm/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres}')
  })

  it('exactly one policy: a permissive SELECT for authenticated, with the old predicate', async () => {
    const p = await policies()
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ policyname: 'event_types_select', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: '{authenticated}', with_check: null })
    expect(p[0].qual).toBe('private.auth_is_in_location(location_id)')
  })

  it('every browser write is refused — staff, a manager, a master, and anon', async () => {
    for (const who of [STAFF_A, MANAGER_A, MASTER]) {
      await expect(asUser(who, INSERT_AT_A)).rejects.toThrow(/permission denied for table event_types/)
      await expect(asUser(who, UPDATE_A)).rejects.toThrow(/permission denied for table event_types/)
      await expect(asUser(who, DELETE_A)).rejects.toThrow(/permission denied for table event_types/)
      await expect(asUser(who, `TRUNCATE public.event_types CASCADE`)).rejects.toThrow(/permission denied/)
    }
    await expect(asUser(null, INSERT_AT_A, 'anon')).rejects.toThrow(/permission denied for table event_types/)
    await expect(asUser(null, UPDATE_A, 'anon')).rejects.toThrow(/permission denied for table event_types/)
    await expect(asUser(null, DELETE_A, 'anon')).rejects.toThrow(/permission denied for table event_types/)
    const { rows } = await db.query(`SELECT count(*)::int AS n, bool_and(active) AS all_active, count(webhook_url)::int AS hooks, bool_or(create_in_glofox) AS glofox FROM public.event_types`)
    expect(rows[0]).toEqual({ n: 2, all_active: true, hooks: 0, glofox: false })
  })

  it('the plan\'s post-apply probes (C39 Task 1b-4 Step 5 (b)) get 42501 before touching a row', async () => {
    // The same three statements the operator runs as a plain staff member.
    for (const probe of [
      'update public.event_types set name = name where active',
      `insert into public.event_types (name, slug, location_id) values ('probe', 'probe-' || gen_random_uuid(), '${LOC_A}')`,
      'delete from public.event_types where false',
    ]) {
      const err = await asUser(STAFF_A, probe).then(() => null, (e) => e)
      expect(err?.message).toMatch(/permission denied for table event_types/)
      expect(err?.code).toBe('42501')
    }
  })

  it('reads are EXACTLY what they were before 650, for every reader and every path', async () => {
    expect(readsBefore).toBeDefined()
    expect(await readMatrix()).toEqual(readsBefore)
    // spelled out, so a regression reads plainly
    expect(readsBefore).toMatchObject({
      STAFF_A: { event_types: [ET_A], reminders: 1 },
      MANAGER_A: { event_types: [ET_A], reminders: 1 },
      STAFF_B: { event_types: [ET_B], reminders: 0, embed: [] },
      MASTER: { event_types: [ET_A, ET_B], reminders: 1 },
      anon: { event_types: [] },
    })
  })

  it('the reminders write policies still resolve their EXISTS through event_types (manager yes, staff no)', async () => {
    const add = `INSERT INTO public.event_type_reminders (event_type_id, hours_before) VALUES ('${ET_A}', 2) RETURNING hours_before`
    expect(await asUser(MANAGER_A, add)).toEqual([{ hours_before: 2 }])
    await expect(asUser(STAFF_A, add)).rejects.toThrow(/row-level security/)
  })

  it('service_role still creates, edits and deactivates (the two routes\' path)', async () => {
    await runSql('BEGIN')
    try {
      await runSql('SET LOCAL ROLE service_role')
      const { rows } = await db.query(`INSERT INTO public.event_types (name, slug, location_id) VALUES ('Route made', 'route-made', '${LOC_A}') RETURNING id`)
      await db.query(`UPDATE public.event_types SET active = false, webhook_url = 'https://example.test/hook' WHERE id = $1`, [rows[0].id])
      const after = await db.query(`SELECT active, webhook_url FROM public.event_types WHERE id = $1`, [rows[0].id])
      expect(after.rows).toEqual([{ active: false, webhook_url: 'https://example.test/hook' }])
      await db.query(`DELETE FROM public.event_types WHERE id = $1`, [rows[0].id])
    } finally {
      await runSql('ROLLBACK')
    }
  })

  it('is re-runnable', async () => {
    await expect(runSql(MIG_650)).resolves.toBeDefined()
    expect(await heldPrivileges()).toEqual(['anon:SELECT', 'authenticated:SELECT'])
    expect((await policies()).map((p) => p.policyname)).toEqual(['event_types_select'])
    expect(await readMatrix()).toEqual(readsBefore)
  })
})

// Runs the ROLLBACK recorded in the migration's own header, verbatim, so the
// recipe the operator would reach for in an emergency is known to restore the
// pre-650 catalog exactly. Last on purpose: it undoes 650.
describe('the rollback recorded in the header restores prod exactly', () => {
  const ROLLBACK = (() => {
    const m = MIG_650.match(/^-- ROLLBACK[^\n]*\n(?:--[^\n]*\n)*?((?:--   [^\n]*\n)+)-- END ROLLBACK$/m)
    return m ? m[1].split('\n').map((l) => l.replace(/^--   /, '')).join('\n') : null
  })()

  it('is present, and replays to the pre-650 relacl and policy', async () => {
    expect(ROLLBACK).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/)
    await runSql(ROLLBACK)
    expect(await relacl()).toBe('{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
    const p = await policies()
    expect(p).toEqual([{
      policyname: 'event_types_location_scoped', cmd: 'ALL', permissive: 'PERMISSIVE', roles: '{authenticated}',
      qual: 'private.auth_is_in_location(location_id)', with_check: 'private.auth_is_in_location(location_id)',
    }])
    expect(await readMatrix()).toEqual(readsBefore)
    // the hole is back, which is what a rollback means
    expect(await asUser(STAFF_A, UPDATE_A)).toEqual([{ id: ET_A }])
  })

  it('and 650 then re-applies cleanly on top of it', async () => {
    await runSql(MIG_650)
    expect(await heldPrivileges()).toEqual(['anon:SELECT', 'authenticated:SELECT'])
  })
})
