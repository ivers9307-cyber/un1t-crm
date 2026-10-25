// ANONCONTACTS.1 — behavioural test for migration 657.
//
// Boots PGlite with Supabase's DEFAULT PRIVILEGES for tables (ALL to anon,
// authenticated, service_role) and for functions (EXECUTE to the same three,
// on top of Postgres's PUBLIC default) — prod's pg_default_acl, 29 Sep 2026.
// contacts starts in its pre-653 shape (default grants, the four live
// policies) and the REAL mig 653 file is replayed on it first, so its post-653
// state (clients hold SELECT + MAINTAIN only; one policy, contacts_select TO
// public) is 653's own output, not a hand model. The consent tables carry their live
// FOR ALL TO authenticated policies; consent_drift_rows() and the
// security_invoker audience view are verbatim in shape. It proves:
//
//   * BEFORE: anon's read of contacts is stopped only by an ERROR in the
//     policy (no EXECUTE on the private helper); anon, authenticated and
//     PUBLIC can execute consent_drift_rows(), and a staff member gets the
//     drifted emails at their studio from it;
//   * AFTER: anon holds nothing on contacts (not even MAINTAIN) and its read
//     fails on the grant; staff and member reads are unchanged; only
//     service_role can execute the function and still gets its rows;
//   * the pre-check refuses to run before 653; the self-check aborts the WHOLE
//     file on an inherited table privilege, an inherited EXECUTE and another
//     grantor's grant; a second run passes; the rollback record restores.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_653 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/653_contacts_client_writes_off.sql'), 'utf8')
const MIG_657 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/657_anon_contacts_consent_drift_closed.sql'), 'utf8')

// The rollback record from the C56 plan (Task 5 Step 7), verbatim.
const ROLLBACK_657 = `
BEGIN;
GRANT SELECT, MAINTAIN ON public.contacts TO anon;
GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO PUBLIC, anon, authenticated;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'
const MEMBER_USER = '20000000-0000-0000-0000-000000000001'
const C_DRIFT = '30000000-0000-0000-0000-000000000001'   // opted out globally, still on A's list
const C_MEMBER = '30000000-0000-0000-0000-000000000002'  // MEMBER_USER's row at A
const C_B = '30000000-0000-0000-0000-000000000003'       // studio B, drifted too

const TABLE_DENIED = /permission denied for (table|relation) contacts/
const FN_DENIED = /permission denied for function consent_drift_rows/
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']

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

  -- prod pg_default_acl for postgres in public (29 Sep 2026)
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;

  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY, name text, email text, location_id uuid, user_id uuid,
    email_status text, email_suppressed_at timestamptz, dob date
  );
  CREATE TABLE public.contact_preferences (contact_id uuid PRIMARY KEY, location_id uuid, email_marketing boolean NOT NULL DEFAULT true);
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid, location_id uuid, email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true, whatsapp_marketing boolean NOT NULL DEFAULT true, source text,
    PRIMARY KEY (contact_id, location_id)
  );

  -- Helper verbatim (pg_proc, 29 Sep; mig 626).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  -- consent_drift_rows, verbatim (pg_get_functiondef, 29 Sep; mig 544). Created
  -- AFTER the default privileges, so its ACL is prod's: PUBLIC + anon +
  -- authenticated + service_role.
  CREATE FUNCTION public.consent_drift_rows()
   RETURNS TABLE(contact_id uuid, location_id uuid, email text)
   LANGUAGE sql
   SET search_path TO 'pg_catalog', 'public'
  AS $function$
    select clp.contact_id, clp.location_id, c.email
      from contact_location_preferences clp
      join contact_preferences cp on cp.contact_id = clp.contact_id
      join contacts c on c.id = clp.contact_id
     where cp.email_marketing = false
       and clp.email_marketing = true
       and clp.source is distinct from 'waitlist_form';
  $function$;

  -- The send-path view (mig 491 shape, security_invoker; columns cut down).
  CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
    SELECT c.id, c.email, c.email_status, c.email_suppressed_at, clp.location_id AS audience_location_id,
           clp.email_marketing AS loc_email_marketing
      FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;

  -- contacts BEFORE mig 653 (pg_policies, 28 Sep; default grants arwdDxtm).
  -- boot() then replays the real 653 file, which leaves clients read-only and
  -- contacts_select as the one policy.
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY contacts_update ON public.contacts FOR UPDATE TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())))
    WITH CHECK (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  CREATE POLICY contacts_insert ON public.contacts FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY contacts_delete ON public.contacts FOR DELETE TO authenticated
    USING (private.auth_is_in_location(location_id));

  -- The consent tables' live policies (pg_policies, 29 Sep).
  ALTER TABLE public.contact_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_preferences_location_scoped ON public.contact_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  ALTER TABLE public.contact_location_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_location_preferences_location_scoped ON public.contact_location_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF_A}', 'staff');
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts (id, name, email, location_id, user_id) VALUES
    ('${C_DRIFT}', 'Synth Drift', 'drift@example.test', '${LOC_A}', NULL),
    ('${C_MEMBER}', 'Synth Member', 'member@example.test', '${LOC_A}', '${MEMBER_USER}'),
    ('${C_B}', 'Synth Elsewhere', 'b@example.test', '${LOC_B}', NULL);
  INSERT INTO public.contact_preferences VALUES
    ('${C_DRIFT}', '${LOC_A}', false), ('${C_MEMBER}', '${LOC_A}', true), ('${C_B}', '${LOC_B}', false);
  INSERT INTO public.contact_location_preferences (contact_id, location_id, email_marketing, source) VALUES
    ('${C_DRIFT}', '${LOC_A}', true, 'import'), ('${C_MEMBER}', '${LOC_A}', true, 'import'), ('${C_B}', '${LOC_B}', true, 'import');
`

let db
const runSql = (text) => db['exec'](text)

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

/** Set of 'grantee:privilege' items on an ACL (PUBLIC = 'PUBLIC'), sorted. */
async function aclItems(sqlAclExpr) {
  const { rows } = await db.query(`
    SELECT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type AS item
      FROM aclexplode((${sqlAclExpr})) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     ORDER BY 1`)
  return rows.map((r) => r.item)
}
const contactsAcl = () => aclItems(`SELECT relacl FROM pg_class WHERE oid = 'public.contacts'::regclass`)
const fnAcl = () => aclItems(`SELECT proacl FROM pg_proc WHERE oid = 'public.consent_drift_rows()'::regprocedure`)

// apply653: replay the real mig 653 file (prod's state since it was applied).
async function boot({ migrate = false, before = '', apply653 = true } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  if (apply653) await runSql(MIG_653)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_657)
}

describe('before 657 — shut by accident (prod after 653, 29 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('anon still holds SELECT and MAINTAIN on contacts', async () => {
    expect((await contactsAcl()).filter((i) => i.startsWith('anon:'))).toEqual(['anon:MAINTAIN', 'anon:SELECT'])
  })

  it("anon's read of contacts fails only because the policy's helper is not executable", async () => {
    await expect(asRole('anon', 'SELECT id FROM public.contacts')).rejects.toThrow(/permission denied for function auth_is_in_location/)
  })

  it('PUBLIC, anon and authenticated can execute consent_drift_rows()', async () => {
    const acl = await fnAcl()
    expect(acl).toEqual(expect.arrayContaining(['PUBLIC:EXECUTE', 'anon:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE']))
  })

  it('a staff member gets the drifted emails at their studio from it', async () => {
    expect(await asUser(STAFF_A, 'SELECT contact_id, email FROM public.consent_drift_rows()'))
      .toEqual([{ contact_id: C_DRIFT, email: 'drift@example.test' }])
  })

  it('anon gets 0 rows and no error (both consent tables are policy-less for anon, so contacts is never scanned)', async () => {
    // Measured the same way on prod (29 Sep). If a PGlite build plans it
    // differently and raises instead, assert the raise: either way anon gets no email.
    expect(await asRole('anon', 'SELECT count(*)::int AS n FROM public.consent_drift_rows()')).toEqual([{ n: 0 }])
  })
})

describe('after 657 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(['anon', 'public'])('%s holds no privilege of any kind on contacts', async (role) => {
    for (const p of ALL_PRIVS) {
      const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, 'public.contacts', $2) AS held`, [role, p])
      expect(r.held, `${role} ${p}`).toBe(false)
    }
  })

  it("anon is gone from contacts' ACL; authenticated and service_role are not", async () => {
    const acl = await contactsAcl()
    expect(acl.some((i) => i.startsWith('anon:') || i.startsWith('PUBLIC:'))).toBe(false)
    expect(acl).toEqual(expect.arrayContaining(['authenticated:MAINTAIN', 'authenticated:SELECT', 'service_role:UPDATE']))
  })

  it('only postgres and service_role can execute consent_drift_rows()', async () => {
    expect(await fnAcl()).toEqual(['postgres:EXECUTE', 'service_role:EXECUTE'])
    for (const role of ['anon', 'authenticated', 'public']) {
      const { rows: [r] } = await db.query(
        `SELECT has_function_privilege($1, 'public.consent_drift_rows()', 'EXECUTE') AS can`, [role])
      expect(r.can, role).toBe(false)
    }
  })
})

describe('after 657 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('anon: a contacts read now fails on the grant itself', async () => {
    await expect(asRole('anon', 'SELECT id FROM public.contacts')).rejects.toThrow(TABLE_DENIED)
    await expect(asRole('anon', 'SELECT count(*) FROM public.contacts')).rejects.toThrow(TABLE_DENIED)
  })

  it('anon: the security_invoker audience view fails on the contacts grant too (view grants unchanged)', async () => {
    await expect(asRole('anon', 'SELECT id FROM public.contact_location_audience')).rejects.toThrow(TABLE_DENIED)
  })

  it('staff: reads their studio exactly as before', async () => {
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.contacts')).toEqual([{ n: 2 }])
  })

  it("member: the app's own-row read still works", async () => {
    expect((await asUser(MEMBER_USER, `SELECT id FROM public.contacts WHERE user_id = '${MEMBER_USER}'`)).map((r) => r.id))
      .toEqual([C_MEMBER])
  })

  it('anon and authenticated: consent_drift_rows() is refused', async () => {
    await expect(asRole('anon', 'SELECT * FROM public.consent_drift_rows()')).rejects.toThrow(FN_DENIED)
    await expect(asUser(STAFF_A, 'SELECT * FROM public.consent_drift_rows()')).rejects.toThrow(FN_DENIED)
  })

  it('service_role: the cron still gets every drifted row', async () => {
    const rows = await asRole('service_role', 'SELECT contact_id FROM public.consent_drift_rows() ORDER BY contact_id')
    expect(rows.map((r) => r.contact_id)).toEqual([C_DRIFT, C_B])
  })
})

describe('the pre-check and self-check abort the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, { apply653 = true } = {}) {
    await boot({ before, apply653 })
    await expect(runSql(MIG_657)).rejects.toThrow(message)
    await runSql('ROLLBACK')
    // Nothing applied.
    expect(await contactsAcl()).toEqual(expect.arrayContaining(['anon:SELECT']))
    expect(await fnAcl()).toEqual(expect.arrayContaining(['anon:EXECUTE']))
  }

  it('before mig 653 is applied (653 would then abort on "anon lost SELECT")', () => expectAbort(
    '', /mig 657: apply 653_contacts_client_writes_off first/, { apply653: false },
  ), 60_000)

  it("when another grantor's SELECT to anon survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.contacts TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.contacts TO anon; RESET ROLE;`,
    /mig 657: anon\/PUBLIC still hold privileges on public\.contacts: anon:SELECT/,
  ), 60_000)

  it('when anon inherits SELECT through role membership', () => expectAbort(
    `GRANT SELECT ON public.contacts TO sneaky; GRANT sneaky TO anon;`,
    /mig 657: anon still holds SELECT on public\.contacts/,
  ), 60_000)

  it('when authenticated inherits EXECUTE through role membership', () => expectAbort(
    `GRANT EXECUTE ON FUNCTION public.consent_drift_rows() TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 657: authenticated can still execute public\.consent_drift_rows\(\)/,
  ), 60_000)

  it("why the order is enforced: 653's self-check refuses a database where 657 already ran", async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_653)).rejects.toThrow(/mig 653: anon lost SELECT on public\.contacts/)
    await runSql('ROLLBACK')
  }, 60_000)

  it('a second run passes (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_657)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores both ACLs exactly (as sets) and so the accident', async () => {
    await boot()
    const before = { c: await contactsAcl(), f: await fnAcl() }
    await runSql(MIG_657)
    await runSql(ROLLBACK_657)
    expect(await contactsAcl()).toEqual(before.c)
    expect(await fnAcl()).toEqual(before.f)
    await expect(asRole('anon', 'SELECT id FROM public.contacts')).rejects.toThrow(/permission denied for function auth_is_in_location/)
  }, 60_000)
})
