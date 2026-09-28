// CONTACTSELFWRITE.1 — behavioural test for migration 653.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite with Supabase's DEFAULT PRIVILEGES (every table
// created in public gets ALL for anon, authenticated and service_role — which
// is where contacts' arwdDxtm came from), a `contacts` table carrying the
// columns the live readers name (mig 653 grants no column, so the other ~80 are
// immaterial to it), the four live contacts policies and the private.* helpers
// verbatim (pg_policies / pg_proc, 28 Sep 2026), plus the paths that touch
// contacts on a client's behalf: the phone's deals update (SECURITY DEFINER
// stage-slug trigger, a stand-in with the live shape), the verbatim INVOKER
// WhatsApp timeline trigger, and the verbatim contact_devices policies that
// read contacts as the caller. It proves:
//
//   * BEFORE: a member rewrites Glofox id / studio / tags / lifetime value on
//     their own row; a plain staff member inserts and deletes contacts at their
//     studio; anon is fenced only by an error;
//   * AFTER: every write refused for anon and authenticated (masters too); one
//     SELECT policy left; every live read shape still returns the same rows;
//     the DEFINER trigger still stamps contacts; the INVOKER WhatsApp trigger
//     fails for a client insert (none exists) and works for service_role;
//   * the self-check aborts the WHOLE file on another grantor's grant, an
//     inherited grant, and a leftover write policy; a second run passes; the
//     plan's rollback record restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_653 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/653_contacts_client_writes_off.sql'), 'utf8')

// The rollback record from the C49 plan (Task 5 Step 7), verbatim. Proven below
// to restore the 28 Sep grants and policies exactly.
const ROLLBACK_653 = `
BEGIN;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts TO anon, authenticated;
CREATE POLICY contacts_insert ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY contacts_update ON public.contacts FOR UPDATE TO public
  USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())))
  WITH CHECK (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
CREATE POLICY contacts_delete ON public.contacts FOR DELETE TO authenticated
  USING (private.auth_is_in_location(location_id));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const MASTER = '10000000-0000-0000-0000-000000000002'
const MEMBER_USER = '20000000-0000-0000-0000-000000000001'
const OTHER_USER = '20000000-0000-0000-0000-000000000002'
const C_MEMBER = '30000000-0000-0000-0000-000000000001'   // MEMBER_USER's row, studio A
const C_OTHER = '30000000-0000-0000-0000-000000000002'    // OTHER_USER's row, studio A
const C_B = '30000000-0000-0000-0000-000000000003'        // studio B, no login
const DEAL_A = '40000000-0000-0000-0000-000000000001'

const DENIED = /permission denied for (table|relation) contacts/
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

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

  -- Supabase's default privileges on schema public (the source of arwdDxtm).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;   -- mig 153b

  -- The columns the live readers and the two triggers name (prod has 104).
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, first_name text, last_name text, email text, phone text, wa_phone text,
    glofox_member_id text, trial_credits_remaining integer DEFAULT 3, lead_source text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    location_id uuid REFERENCES public.locations(id),
    total_wa_sent integer NOT NULL DEFAULT 0, total_wa_received integer NOT NULL DEFAULT 0,
    last_wa_message_at timestamptz, tags text[] DEFAULT '{}'::text[],
    user_id uuid, dob date, lifetime_value_cents bigint NOT NULL DEFAULT 0,
    pipeline_stage_slug text, email_marketing boolean NOT NULL DEFAULT true,
    gender text, weight_kg numeric, profile_setup_completed_at timestamptz,
    is_primary_contact boolean NOT NULL DEFAULT true, push_prefs jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX contacts_user_id_unique ON public.contacts (user_id);

  CREATE TABLE public.deals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid, stage_slug text, status text DEFAULT 'open'
  );
  CREATE TABLE public.activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, type text, subject text, note text,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.whatsapp_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid, direction text,
    body text, template_name text, sent_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.contact_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE, identifier text
  );

  -- Helpers, verbatim from prod (pg_proc.prosrc, 28 Sep 2026; mig 626).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND role = 'master' AND active IS NOT FALSE AND deleted_at IS NULL
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
              WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id
            )
          )
      )
  $$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $$;
  -- Live: the private helpers are not executable by anon (an anon read of contacts
  -- errors 42501 "permission denied for function auth_is_in_location").
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  -- Stand-in for sync_contacts_pipeline_stage_slug (live: SECURITY DEFINER,
  -- owner postgres, AFTER INSERT OR UPDATE OR DELETE ON deals). Only the
  -- DEFINER-writes-contacts shape matters here.
  CREATE FUNCTION public.sync_contacts_pipeline_stage_slug() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
  BEGIN
    UPDATE public.contacts SET pipeline_stage_slug = NEW.stage_slug WHERE id = NEW.contact_id;
    RETURN NEW;
  END $$;
  CREATE TRIGGER sync_contacts_pipeline_stage_slug_trigger AFTER INSERT OR UPDATE ON public.deals
    FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_pipeline_stage_slug();

  -- log_wa_message_to_timeline, verbatim (INVOKER, owner postgres).
  CREATE FUNCTION public.log_wa_message_to_timeline() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.contact_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.direction = 'outbound' THEN
      INSERT INTO public.activities (contact_id, type, subject, note, created_at)
      VALUES (NEW.contact_id, 'whatsapp_sent', 'WhatsApp sent',
        COALESCE('WhatsApp: ' || LEFT(NEW.body, 100), 'WhatsApp template: ' || NEW.template_name),
        NEW.created_at);
      UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_sent = total_wa_sent + 1
      WHERE id = NEW.contact_id;
    ELSIF NEW.direction = 'inbound' THEN
      INSERT INTO public.activities (contact_id, type, subject, note, created_at)
      VALUES (NEW.contact_id, 'whatsapp_received', 'WhatsApp received',
        'WhatsApp: ' || LEFT(NEW.body, 100), NEW.created_at);
      UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_received = total_wa_received + 1
      WHERE id = NEW.contact_id;
    END IF;
    RETURN NEW;
  END;
  $$;
  CREATE TRIGGER trg_wa_message_timeline AFTER INSERT ON public.whatsapp_messages
    FOR EACH ROW EXECUTE FUNCTION public.log_wa_message_to_timeline();
`

const PROD_POLICIES = `
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

  -- deals / whatsapp_messages: stand-ins for the live role- and
  -- permission-aware policies (a staff member at the studio may update a deal
  -- or insert a message there). activities: RLS off in this replay.
  ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
  CREATE POLICY deals_select ON public.deals FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));
  CREATE POLICY deals_update ON public.deals FOR UPDATE TO authenticated
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
  CREATE POLICY wa_msg_insert ON public.whatsapp_messages FOR INSERT TO authenticated WITH CHECK (private.auth_is_in_location(location_id));

  -- contact_devices, verbatim (its EXISTS reads contacts as the caller).
  ALTER TABLE public.contact_devices ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_devices_read ON public.contact_devices FOR SELECT TO public
    USING ((contact_id = private.auth_contact_id()) OR (EXISTS (SELECT 1 FROM public.contacts c
      WHERE ((c.id = contact_devices.contact_id) AND private.auth_is_in_location(c.location_id)))));
  CREATE POLICY contact_devices_insert ON public.contact_devices FOR INSERT TO public
    WITH CHECK ((contact_id = private.auth_contact_id()) OR (EXISTS (SELECT 1 FROM public.contacts c
      WHERE ((c.id = contact_devices.contact_id) AND private.auth_is_in_location(c.location_id)))));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF_A}', 'staff'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO public.contacts (id, name, email, location_id, user_id, glofox_member_id, created_at) VALUES
    ('${C_MEMBER}', 'Synth Member', 'member@example.test', '${LOC_A}', '${MEMBER_USER}', 'gx-synth-1', '2026-09-01'),
    ('${C_OTHER}', 'Synth Other', 'other@example.test', '${LOC_A}', '${OTHER_USER}', 'gx-synth-2', '2026-09-02'),
    ('${C_B}', 'Synth Elsewhere', 'b@example.test', '${LOC_B}', NULL, NULL, '2026-09-03');
  INSERT INTO public.deals (id, contact_id, location_id, stage_slug) VALUES ('${DEAL_A}', '${C_MEMBER}', '${LOC_A}', 'trial');
`

// mobile/lib/contacts-api.js searchContacts (CONTACT_SELECT, primary contacts, newest first).
const STAFF_DIRECTORY_SQL = `
  SELECT id, name, first_name, last_name, email, phone, wa_phone, pipeline_stage_slug, lead_source, tags, created_at
    FROM public.contacts WHERE location_id = '${LOC_A}' AND is_primary_contact ORDER BY created_at DESC`
// mobile/lib/identity-context.jsx + member/contact-context.jsx (and champ-app's own-row reads).
const MEMBER_OWN_ROW_SQL = `
  SELECT id, name, email, dob, gender, weight_kg, profile_setup_completed_at
    FROM public.contacts WHERE user_id = '${MEMBER_USER}'`

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

/** The same as a bare role (anon, service_role): claims carry only the role, as PostgREST sets them. */
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
    `SELECT policyname, cmd, roles::text AS roles FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'contacts' ORDER BY policyname`)
  return rows
}

async function clientAcl() {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.contacts'::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`)
  return rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_653)
}

describe('before 653 — the hole (prod on 28 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the default privileges gave both client roles every table privilege (arwdDxtm, PG 17)', async () => {
    expect(await clientAcl()).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it('a member rewrites their own Glofox id, studio, tags and lifetime value', async () => {
    const rows = await asUser(MEMBER_USER, `UPDATE public.contacts
       SET glofox_member_id = 'gx-synth-2', location_id = '${LOC_B}', tags = '{vip}', lifetime_value_cents = 999999
       WHERE user_id = '${MEMBER_USER}' RETURNING id`)
    expect(rows).toEqual([{ id: C_MEMBER }])
  })

  it('…but only their own row: the policy is row-scoped, not column-scoped', async () => {
    expect(await asUser(MEMBER_USER, `UPDATE public.contacts SET name = 'x' WHERE id = '${C_OTHER}' RETURNING id`)).toEqual([])
  })

  it('a plain staff member inserts, relinks and deletes contacts at their studio directly', async () => {
    expect(await asUser(STAFF_A, `INSERT INTO public.contacts (name, location_id) VALUES ('Synth New', '${LOC_A}') RETURNING location_id`))
      .toEqual([{ location_id: LOC_A }])
    expect(await asUser(STAFF_A, `UPDATE public.contacts SET user_id = '${STAFF_A}' WHERE id = '${C_OTHER}' RETURNING id`))
      .toEqual([{ id: C_OTHER }])
    expect(await asUser(STAFF_A, `DELETE FROM public.contacts WHERE id = '${C_OTHER}' RETURNING id`)).toEqual([{ id: C_OTHER }])
  })

  it('anon is fenced only by an error (no EXECUTE on the private helpers), not by the grant', async () => {
    await expect(asRole('anon', 'SELECT id FROM public.contacts')).rejects.toThrow(/permission denied for function auth_is_in_location/)
  })
})

describe('after 653 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(['anon', 'authenticated', 'public'])('%s holds no write privilege on contacts', async (role) => {
    for (const p of WRITE_PRIVS) {
      const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, 'public.contacts', $2) AS held`, [role, p])
      expect(r.held, `${role} ${p}`).toBe(false)
    }
  })

  it('no column-level write privilege either; SELECT unchanged; service_role still writes', async () => {
    // One privilege per call: a comma list is true if ANY is held.
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) {
        const { rows: [c] } = await db.query(`SELECT has_any_column_privilege($1, 'public.contacts', $2) AS held`, [role, p])
        expect(c.held, `${role} column ${p}`).toBe(false)
      }
    }
    const { rows: [r] } = await db.query(`SELECT
      has_table_privilege('authenticated', 'public.contacts', 'SELECT') AS a_sel,
      has_table_privilege('anon', 'public.contacts', 'SELECT') AS n_sel,
      has_table_privilege('service_role', 'public.contacts', 'UPDATE') AS svc_upd`)
    expect(r).toEqual({ a_sel: true, n_sel: true, svc_upd: true })
    // MAINTAIN (VACUUM/ANALYZE/LOCK; the `m` in arwdDxtm) stays, as after
    // migs 625 and 650: it is no write and PostgREST cannot reach it.
    expect(await clientAcl()).toEqual([
      { grantee: 'anon', privs: 'MAINTAIN,SELECT' },
      { grantee: 'authenticated', privs: 'MAINTAIN,SELECT' },
    ])
  })

  it('exactly one policy is left: contacts_select, FOR SELECT, unchanged', async () => {
    expect(await policies()).toEqual([{ policyname: 'contacts_select', cmd: 'SELECT', roles: '{public}' }])
  })
})

describe('after 653 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  // Member (customer session, no profile)
  it.each([
    ['glofox_member_id', `'gx-synth-2'`], ['location_id', `'${LOC_B}'`], ['tags', `'{}'::text[]`],
    ['lifetime_value_cents', '0'], ['pipeline_stage_slug', `'member'`], ['email_marketing', 'false'],
    ['push_prefs', `'{}'::jsonb`], ['name', `'X'`], ['user_id', 'NULL'],
  ])('member: UPDATE own contacts.%s is refused', async (col, value) => {
    await expect(asUser(MEMBER_USER, `UPDATE public.contacts SET ${col} = ${value} WHERE user_id = '${MEMBER_USER}'`))
      .rejects.toThrow(DENIED)
  })

  it("member: the app's own-row read still works", async () => {
    const rows = await asUser(MEMBER_USER, MEMBER_OWN_ROW_SQL)
    expect(rows.map((r) => r.id)).toEqual([C_MEMBER])
  })

  it('member: pairing a device (contact_devices policy reads contacts as them) still works', async () => {
    expect(await asUser(MEMBER_USER,
      `INSERT INTO public.contact_devices (contact_id, identifier) VALUES ('${C_MEMBER}', 'synth-strap') RETURNING contact_id`))
      .toEqual([{ contact_id: C_MEMBER }])
  })

  // Staff and master
  it.each([['staff', STAFF_A], ['master', MASTER]])('%s: INSERT, UPDATE, UPSERT and DELETE on contacts are refused', async (_label, uid) => {
    await expect(asUser(uid, `INSERT INTO public.contacts (name, location_id) VALUES ('Synth New', '${LOC_A}')`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `UPDATE public.contacts SET tags = tags WHERE id = '${C_OTHER}'`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `INSERT INTO public.contacts (id, name, location_id) VALUES ('${C_OTHER}', 'x', '${LOC_A}')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, `DELETE FROM public.contacts WHERE id = '${C_OTHER}'`)).rejects.toThrow(DENIED)
    await expect(asUser(uid, 'TRUNCATE public.contacts CASCADE')).rejects.toThrow(DENIED)
  })

  it("staff: the phone directory read returns the studio's contacts and nothing else", async () => {
    const rows = await asUser(STAFF_A, STAFF_DIRECTORY_SQL)
    expect(rows.map((r) => r.id)).toEqual([C_OTHER, C_MEMBER])
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.contacts`)).toEqual([{ n: 2 }])
  })

  it('staff: pairing a device for a studio contact still works (EXISTS on contacts)', async () => {
    expect(await asUser(STAFF_A,
      `INSERT INTO public.contact_devices (contact_id, identifier) VALUES ('${C_OTHER}', 'synth-strap-2') RETURNING contact_id`))
      .toEqual([{ contact_id: C_OTHER }])
  })

  it('staff: moving a deal still re-stamps contacts.pipeline_stage_slug (SECURITY DEFINER trigger)', async () => {
    const rows = await asUser(STAFF_A,
      `UPDATE public.deals SET stage_slug = 'member' WHERE id = '${DEAL_A}'`,
      `SELECT pipeline_stage_slug FROM public.contacts WHERE id = '${C_MEMBER}'`)
    expect(rows).toEqual([{ pipeline_stage_slug: 'member' }])
  })

  it('staff: a DIRECT whatsapp_messages insert now fails inside the INVOKER timeline trigger (no client does this)', async () => {
    await expect(asUser(STAFF_A, `INSERT INTO public.whatsapp_messages (contact_id, location_id, direction, body)
      VALUES ('${C_MEMBER}', '${LOC_A}', 'outbound', 'hi')`)).rejects.toThrow(DENIED)
  })

  it('service_role: writes contacts, and a WhatsApp insert still bumps the counters', async () => {
    const rows = await asRole('service_role',
      `UPDATE public.contacts SET tags = '{synth}' WHERE id = '${C_MEMBER}'`,
      `INSERT INTO public.whatsapp_messages (contact_id, location_id, direction, body) VALUES ('${C_MEMBER}', '${LOC_A}', 'outbound', 'hi')`,
      `SELECT tags, total_wa_sent FROM public.contacts WHERE id = '${C_MEMBER}'`)
    expect(rows).toEqual([{ tags: ['synth'], total_wa_sent: 1 }])
  })

  it('anon: a write is refused by the grant itself now', async () => {
    await expect(asRole('anon', `UPDATE public.contacts SET name = name`)).rejects.toThrow(DENIED)
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    await expect(runSql(MIG_653)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    // Nothing applied: the three write policies are still there.
    expect((await policies()).map((p) => p.policyname))
      .toEqual(expect.arrayContaining(['contacts_delete', 'contacts_insert', 'contacts_select', 'contacts_update']))
    expect((await clientAcl()).find((r) => r.grantee === 'authenticated').privs).toContain('DELETE')
  }

  it("when another grantor's UPDATE grant survives the REVOKE", () => expectAbort(
    `GRANT UPDATE ON public.contacts TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.contacts TO authenticated; RESET ROLE;`,
    /mig 653: anon\/authenticated\/PUBLIC still hold write privileges on public\.contacts: authenticated:UPDATE/,
  ), 60_000)

  it('when UPDATE is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT UPDATE ON public.contacts TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 653: authenticated still holds UPDATE on public\.contacts/,
  ), 60_000)

  it('when a write policy the file does not know about is left', () => expectAbort(
    `CREATE POLICY contacts_self_update ON public.contacts FOR UPDATE TO authenticated
       USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));`,
    /mig 653: write policies remain on public\.contacts: contacts_self_update UPDATE/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_653)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 28 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await clientAcl()
    const policiesBefore = await policies()
    await runSql(MIG_653)
    await runSql(ROLLBACK_653)
    expect(await clientAcl()).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(MEMBER_USER, `UPDATE public.contacts SET tags = '{x}' WHERE user_id = '${MEMBER_USER}' RETURNING id`))
      .toEqual([{ id: C_MEMBER }])
  }, 60_000)
})
