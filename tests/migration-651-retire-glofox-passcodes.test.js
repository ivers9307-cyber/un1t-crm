// PASSCODEREAD.1 — behavioural test for migration 651.
//
// No local Supabase stack exists, so a migration otherwise gets its first run
// on prod. This boots PGlite with the parts of contacts / glofox_push_events
// the migration touches (glofox_push_events in PROD column order; contacts
// cut to the columns that matter — prod has 104), the prod helpers and
// policies (read out of the catalog on 28 Sep 2026) and the prod grants
// (Supabase's default ALL for anon + authenticated), proves the leak, applies
// the REAL 651 file, and asserts:
//   * no passcode remains, and none can be stored again (service role too)
//   * the orchestrator's own writes (link update, audit insert) still land
//   * glofox_push_events is closed to every client role, by the catalog
//   * contacts grants are untouched (staff + a member read as before)
//   * the self-check aborts the WHOLE file (the scrub rolls back with it)
//   * a second run passes.
// Fictional values only (SYNTH-…): the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_651 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/651_retire_glofox_passcodes.sql'), 'utf8')

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF = '10000000-0000-0000-0000-000000000001'       // staff at A
const MEMBER_USER = '20000000-0000-0000-0000-000000000001' // an app member (auth user)
const CONTACT_NEW = '30000000-0000-0000-0000-000000000001' // CRM-created Glofox account
const CONTACT_MEMBER = '30000000-0000-0000-0000-000000000002' // the app member's own row
const CONTACT_B = '30000000-0000-0000-0000-000000000003'   // another studio
const EVENT_CREATED = '40000000-0000-0000-0000-000000000001'
const PASSCODE = 'SYNTH-PC-0001'

const DENIED = /permission denied for (table|relation) glofox_push_events/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, private, public TO authenticated, anon;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz
  );
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );

  -- contacts: only the columns this migration and its readers touch.
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY,
    name text,
    email text,
    location_id uuid REFERENCES public.locations(id),
    user_id uuid,
    glofox_member_id text,
    glofox_synced_at timestamptz,
    glofox_passcode text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- glofox_push_events: prod column order (information_schema, 28 Sep 2026).
  CREATE TABLE public.glofox_push_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid,
    location_id uuid,
    source text NOT NULL,
    status text NOT NULL,
    glofox_member_id text,
    glofox_response jsonb,
    error_message text,
    passcode_sent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by uuid
  );

  -- Prod grants: Supabase's default table-level ALL to both client roles…
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon;
  -- …except profiles (mig 153b).
  REVOKE SELECT ON public.profiles FROM authenticated, anon;

  -- Helpers, verbatim from prod (pg_proc.prosrc, 28 Sep; mig 626).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_is_active_staff() TO authenticated;

  -- Prod policies (pg_policies, 28 Sep).
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.glofox_push_events ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY contacts_update ON public.contacts FOR UPDATE TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())))
    WITH CHECK (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY glofox_push_events_select ON public.glofox_push_events FOR SELECT TO public
    USING (location_id IN (SELECT pl.location_id FROM public.profile_locations pl
                           WHERE pl.profile_id = (SELECT auth.uid()) AND (SELECT private.auth_is_active_staff())));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Synth Studio A'), ('${LOC_B}', 'Synth Studio B');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff');
  INSERT INTO public.profile_locations VALUES ('${STAFF}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts (id, name, email, location_id, user_id, glofox_member_id, glofox_passcode) VALUES
    ('${CONTACT_NEW}', 'Synth New', 'new@example.test', '${LOC_A}', NULL, 'gx-synth-1', '${PASSCODE}'),
    ('${CONTACT_MEMBER}', 'Synth Member', 'member@example.test', '${LOC_A}', '${MEMBER_USER}', 'gx-synth-2', NULL),
    ('${CONTACT_B}', 'Synth Elsewhere', 'b@example.test', '${LOC_B}', NULL, NULL, NULL);
  INSERT INTO public.glofox_push_events (id, contact_id, location_id, source, status, glofox_member_id, glofox_response, passcode_sent) VALUES
    ('${EVENT_CREATED}', '${CONTACT_NEW}', '${LOC_A}', 'booking_form', 'created', 'gx-synth-1', '{"success":true,"user":{"_id":"gx-synth-1"}}', '${PASSCODE}');
`

let db
const runSql = (text) => db['exec'](text)

async function asUser(uid, sql) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
async function asAnon(sql) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE anon')
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  if (migrate) await runSql(MIG_651)
}

const staffReadsPasscode = async () =>
  (await asUser(STAFF, `SELECT glofox_passcode FROM public.contacts WHERE id = '${CONTACT_NEW}'`))[0]?.glofox_passcode

describe('before 651: any staff member at the studio reads the passcode', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('from contacts', async () => {
    expect(await staffReadsPasscode()).toBe(PASSCODE)
  })

  it('from glofox_push_events', async () => {
    expect(await asUser(STAFF, 'SELECT passcode_sent FROM public.glofox_push_events')).toEqual([{ passcode_sent: PASSCODE }])
  })
})

describe('after 651', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('holds no passcode anywhere', async () => {
    const { rows } = await db.query(`SELECT
      (SELECT count(glofox_passcode) FROM public.contacts)::int AS c,
      (SELECT count(passcode_sent) FROM public.glofox_push_events)::int AS e`)
    expect(rows).toEqual([{ c: 0, e: 0 }])
  })

  it('leaves the link and the audit row themselves alone', async () => {
    const { rows } = await db.query(`SELECT c.glofox_member_id, e.status, e.glofox_response->>'success' AS ok
      FROM public.contacts c JOIN public.glofox_push_events e ON e.contact_id = c.id WHERE c.id = '${CONTACT_NEW}'`)
    expect(rows).toEqual([{ glofox_member_id: 'gx-synth-1', status: 'created', ok: 'true' }])
  })

  it('refuses to store a passcode again, even from the service role', async () => {
    await expect(runSql(`UPDATE public.contacts SET glofox_passcode = 'SYNTH-PC-0002' WHERE id = '${CONTACT_NEW}'`))
      .rejects.toThrow(/contacts_glofox_passcode_retired/)
    await expect(runSql(`INSERT INTO public.glofox_push_events (contact_id, location_id, source, status, passcode_sent)
      VALUES ('${CONTACT_NEW}', '${LOC_A}', 'manual_button', 'created', 'SYNTH-PC-0003')`))
      .rejects.toThrow(/glofox_push_events_passcode_retired/)
  })

  it("still takes the orchestrator's own writes (no passcode in them)", async () => {
    await runSql('BEGIN')
    try {
      await runSql(`UPDATE public.contacts SET glofox_member_id = 'gx-synth-9', glofox_synced_at = now() WHERE id = '${CONTACT_B}'`)
      await runSql(`INSERT INTO public.glofox_push_events (contact_id, location_id, source, status, glofox_member_id)
        VALUES ('${CONTACT_B}', '${LOC_B}', 'booking_form', 'created', 'gx-synth-9')`)
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.glofox_push_events WHERE contact_id = '${CONTACT_B}'`)
      expect(rows).toEqual([{ n: 1 }])
    } finally {
      await runSql('ROLLBACK')
    }
  })

  it('closes glofox_push_events to every client role', async () => {
    await expect(asUser(STAFF, 'SELECT id FROM public.glofox_push_events')).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, 'SELECT count(*) FROM public.glofox_push_events')).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, `INSERT INTO public.glofox_push_events (source, status) VALUES ('manual_button', 'failed')`)).rejects.toThrow(DENIED)
    await expect(asAnon('SELECT id FROM public.glofox_push_events')).rejects.toThrow(DENIED)
    const { rows } = await db.query(`SELECT grantee, privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'glofox_push_events' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`)
    expect(rows).toEqual([])
  })

  it('leaves contacts grants alone: staff and a member read as before', async () => {
    expect(await asUser(STAFF, 'SELECT id, name, glofox_passcode FROM public.contacts ORDER BY id')).toEqual([
      { id: CONTACT_NEW, name: 'Synth New', glofox_passcode: null },
      { id: CONTACT_MEMBER, name: 'Synth Member', glofox_passcode: null },
    ])
    expect(await asUser(MEMBER_USER, 'SELECT id FROM public.contacts')).toEqual([{ id: CONTACT_MEMBER }])
    expect(await asUser(STAFF, 'SELECT * FROM public.contacts')).toHaveLength(2)
    const { rows } = await db.query(`SELECT has_table_privilege('authenticated', 'public.contacts', 'SELECT') AS s,
      has_table_privilege('authenticated', 'public.contacts', 'UPDATE') AS u`)
    expect(rows).toEqual([{ s: true, u: true }])
  })

  it('is idempotent: a second run passes its own self-check', async () => {
    await expect(runSql(MIG_651)).resolves.toBeDefined()
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction (BEGIN … COMMIT), so an error leaves it
  // aborted; ROLLBACK then restores the pre-651 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('when the REVOKE is missing (the scrub rolls back with it)', async () => {
    const broken = MIG_651.replace('REVOKE ALL ON TABLE public.glofox_push_events FROM anon, authenticated, PUBLIC;\n', '')
    expect(broken).not.toBe(MIG_651)
    await expect(runSql(broken)).rejects.toThrow(/SELECT on public\.glofox_push_events survived for a client role/)
    await runSql('ROLLBACK')
    expect(await staffReadsPasscode()).toBe(PASSCODE)
  })

  it('when the contacts scrub is missing (the CHECK refuses to validate)', async () => {
    const broken = MIG_651.replace('UPDATE public.contacts SET glofox_passcode = NULL WHERE glofox_passcode IS NOT NULL;\n', '')
    expect(broken).not.toBe(MIG_651)
    await expect(runSql(broken)).rejects.toThrow(/contacts_glofox_passcode_retired" of relation "contacts" is violated by some row/)
    await runSql('ROLLBACK')
    expect(await staffReadsPasscode()).toBe(PASSCODE)
  })

  it('when the file would narrow contacts grants (a future edit)', async () => {
    const broken = MIG_651.replace(
      'REVOKE ALL ON TABLE public.glofox_push_events FROM anon, authenticated, PUBLIC;\n',
      'REVOKE ALL ON TABLE public.glofox_push_events FROM anon, authenticated, PUBLIC;\nREVOKE SELECT ON public.contacts FROM authenticated;\n',
    )
    expect(broken).not.toBe(MIG_651)
    await expect(runSql(broken)).rejects.toThrow(/contacts grants changed/)
    await runSql('ROLLBACK')
    expect(await staffReadsPasscode()).toBe(PASSCODE)
  })
})
