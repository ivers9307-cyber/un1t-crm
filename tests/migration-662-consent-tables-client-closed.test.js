// CONSENTREAD.1 — behavioural test for migration 662.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table and view in public gets ALL for anon, authenticated and
// service_role), contact_preferences, contact_location_preferences and
// consent_log in PROD column order with their FKs and CHECKs, the pre-660
// FOR ALL policies, contacts in its post-653 state (a column SUBSET), the
// trigger functions the service paths rely on (verbatim: the DEFINER
// create-on-insert pair and email mirror, the INVOKER ClassPass opt-out,
// update_updated_at), and contact_location_audience as a security_invoker
// view (a column SUBSET of the live 98). Then it applies the REAL mig 660
// file, which is where prod will be when 662 applies. It proves:
//
//   * BEFORE (after 660): a plain staff member reads a customer's unsubscribe
//     token, consent IP and user agent, and the audience view; a signed-in
//     member reads nothing (no profiles row);
//   * AFTER: every privilege (SELECT and MAINTAIN included) is gone for anon,
//     authenticated and PUBLIC on the three tables and the view; no policy;
//     RLS still on; every client read fails 42501 (staff, owner, master,
//     member, anon); the service role's preference-centre flow, ClassPass
//     auto opt-out, contact create/delete and view read all still work;
//   * 662 refuses to run before 660; the self-check aborts the WHOLE file on
//     another grantor's SELECT, an inherited SELECT, a policy on another
//     table that reads consent_log, a second view over the tables and a
//     view over contact_location_audience itself; a
//     second run passes; the plan's rollback record restores the post-660
//     state exactly.
// Fictional ids and values only (192.0.2.0/24 is the documentation range):
// the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_660 = mig('660_consent_tables_client_writes_off.sql')
const MIG_662 = mig('662_consent_tables_client_closed.sql')

// The rollback record from the C68 plan (Task 5 Step 7), verbatim.
const ROLLBACK_662 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT ON public.contact_preferences, public.contact_location_preferences, public.consent_log TO anon, authenticated;
GRANT ALL ON public.contact_location_audience TO anon, authenticated;
CREATE POLICY contact_preferences_select ON public.contact_preferences
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY contact_location_preferences_select ON public.contact_location_preferences
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY consent_log_select ON public.consent_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const OWNER_A = '10000000-0000-0000-0000-000000000002'   // owner at A
const MASTER = '10000000-0000-0000-0000-000000000003'
const MEMBER = '20000000-0000-0000-0000-000000000001'    // a customer's auth user (no profile)
const C_OUT = '30000000-0000-0000-0000-000000000001'     // at A, opted out, the member's own contact
const C_TWO = '30000000-0000-0000-0000-000000000002'     // at A
const C_B = '30000000-0000-0000-0000-000000000003'       // at B
const C_NEW = '30000000-0000-0000-0000-000000000009'
const TOKEN = '40000000-0000-0000-0000-000000000001'
const SYNTH_IP = '192.0.2.10'
const SYNTH_UA = 'synthetic-agent/1.0'

const VIEW = 'contact_location_audience'
const TABLES = ['consent_log', 'contact_location_preferences', 'contact_preferences']
const RELS = [...TABLES, VIEW]
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const denied = (t) => new RegExp(`permission denied for (table|relation|view) ${t}\\b`)

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

  -- contacts: a SUBSET of the 104 live columns (what the triggers, policy and view touch).
  CREATE TABLE public.contacts (
    id uuid PRIMARY KEY, name text, location_id uuid, user_id uuid,
    email_marketing boolean DEFAULT true, email_administrative boolean DEFAULT true,
    whatsapp_marketing boolean DEFAULT true, glofox_membership_status text
  );
  -- mig 653 (applied 28 Sep): contacts is read-only for clients.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.contacts FROM anon, authenticated, PUBLIC;

  -- The three consent tables: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 29 Sep 2026).
  CREATE TABLE public.contact_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid NOT NULL UNIQUE REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid REFERENCES public.locations(id),
    email_marketing boolean DEFAULT true,
    email_administrative boolean DEFAULT true,
    whatsapp_marketing boolean DEFAULT true,
    whatsapp_administrative boolean DEFAULT true,
    unsubscribe_token uuid UNIQUE DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    sms_administrative boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true
  );
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true,
    whatsapp_marketing boolean NOT NULL DEFAULT true,
    subscribed_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL,
    unsubscribed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, location_id)
  );
  CREATE TABLE public.consent_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    channel text NOT NULL,
    action text NOT NULL,
    source text NOT NULL,
    ip_address text,
    user_agent text,
    performed_by uuid REFERENCES public.profiles(id),
    created_at timestamptz DEFAULT now(),
    location_id uuid REFERENCES public.locations(id),
    host_id uuid,   -- prod: REFERENCES event_hosts(id) ON DELETE CASCADE (not modelled)
    CONSTRAINT consent_log_action_vocabulary CHECK (action = ANY (ARRAY['opt_in'::text, 'opt_out'::text])),
    CONSTRAINT consent_log_channel_vocabulary CHECK (channel = ANY (ARRAY['email_marketing'::text, 'email_administrative'::text,
      'sms_marketing'::text, 'sms_administrative'::text, 'whatsapp_marketing'::text, 'whatsapp_administrative'::text,
      'host_email_marketing'::text]))
  );

  -- private.auth_is_in_location, verbatim (pg_proc, 29 Sep; mig 626).
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
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  -- Trigger functions, verbatim bodies (pg_proc.prosrc, 29 Sep; the subset the
  -- service paths below exercise). Owner = the PGlite superuser, as postgres in prod.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION public.sync_contacts_email_marketing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    UPDATE contacts
    SET email_marketing = NEW.email_marketing
    WHERE id = NEW.contact_id
      AND email_marketing IS DISTINCT FROM NEW.email_marketing;
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION public.create_contact_preferences() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    INSERT INTO contact_preferences (contact_id, location_id)
    VALUES (NEW.id, NEW.location_id)
    ON CONFLICT (contact_id) DO NOTHING;
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION public.create_contact_location_preferences() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  begin
    if new.location_id is not null then
      insert into contact_location_preferences
        (contact_id, location_id, source)
      values (new.id, new.location_id, 'contact_created')
      on conflict (contact_id, location_id) do nothing;
    end if;
    return new;
  end;
  $$;

  -- INVOKER (prod: prosecdef false): runs as whoever writes contacts.
  CREATE FUNCTION public.auto_unsubscribe_classpass() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    channels TEXT[] := ARRAY[
      'email_marketing', 'email_administrative',
      'sms_marketing',   'sms_administrative',
      'whatsapp_marketing', 'whatsapp_administrative'
    ];
  BEGIN
    IF NEW.glofox_membership_status IS DISTINCT FROM 'classpass_payg' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.glofox_membership_status IS NOT DISTINCT FROM NEW.glofox_membership_status THEN
      RETURN NEW;
    END IF;

    INSERT INTO contact_preferences (
      contact_id,
      email_marketing, email_administrative,
      sms_marketing,   sms_administrative,
      whatsapp_marketing, whatsapp_administrative
    )
    VALUES (
      NEW.id,
      false, false,
      false, false,
      false, false
    )
    ON CONFLICT (contact_id) DO UPDATE SET
      email_marketing         = false,
      email_administrative    = false,
      sms_marketing           = false,
      sms_administrative      = false,
      whatsapp_marketing      = false,
      whatsapp_administrative = false,
      updated_at              = NOW();

    IF NEW.location_id IS NOT NULL THEN
      INSERT INTO contact_location_preferences (
        contact_id, location_id, source,
        email_marketing, sms_marketing, whatsapp_marketing,
        unsubscribed_at
      )
      VALUES (NEW.id, NEW.location_id, 'auto_classpass', false, false, false, NOW())
      ON CONFLICT (contact_id, location_id) DO UPDATE SET
        email_marketing    = false,
        sms_marketing      = false,
        whatsapp_marketing = false,
        unsubscribed_at    = COALESCE(contact_location_preferences.unsubscribed_at, NOW()),
        updated_at         = NOW();
    END IF;

    INSERT INTO consent_log (contact_id, channel, action, source)
    SELECT NEW.id, ch, 'opt_out', 'auto_classpass'
    FROM unnest(channels) AS ch;

    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER contact_preferences_trigger AFTER INSERT ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.create_contact_preferences();
  CREATE TRIGGER contact_location_preferences_create_trigger AFTER INSERT ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.create_contact_location_preferences();
  CREATE TRIGGER auto_unsubscribe_classpass_trigger AFTER INSERT OR UPDATE OF glofox_membership_status ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.auto_unsubscribe_classpass();
  CREATE TRIGGER contact_preferences_updated_at BEFORE UPDATE ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TRIGGER sync_contacts_email_marketing_trigger AFTER INSERT OR UPDATE OF email_marketing ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_email_marketing();
  CREATE TRIGGER contact_location_preferences_updated_at BEFORE UPDATE ON public.contact_location_preferences
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- contact_location_audience (mig 491): security_invoker, a column SUBSET of
  -- c.* plus the four clp columns the live view adds. Default grants, as prod.
  CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
    SELECT c.id, c.name, c.location_id, c.email_marketing,
           clp.location_id AS audience_location_id,
           clp.email_marketing AS loc_email_marketing,
           clp.sms_marketing AS loc_sms_marketing,
           clp.whatsapp_marketing AS loc_whatsapp_marketing
      FROM public.contacts c
      JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;
  COMMENT ON VIEW public.contact_location_audience IS 'synthetic copy of the LOCCOMMS.3 comment';
`

// The live policies BEFORE 660 (pg_policies, 29 Sep 2026; migs 014, 487, and contacts_select after 653).
const PRE_660_POLICIES = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));

  ALTER TABLE public.contact_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_preferences_location_scoped ON public.contact_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id))
    WITH CHECK (private.auth_is_in_location(location_id));

  ALTER TABLE public.contact_location_preferences ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_location_preferences_location_scoped ON public.contact_location_preferences FOR ALL TO authenticated
    USING (private.auth_is_in_location(location_id))
    WITH CHECK (private.auth_is_in_location(location_id));

  ALTER TABLE public.consent_log ENABLE ROW LEVEL SECURITY;
  CREATE POLICY consent_log_via_contact ON public.consent_log FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.contacts c
                    WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)))
    WITH CHECK (EXISTS (SELECT 1 FROM public.contacts c
                    WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)));
`

// Seeded as the superuser: the contacts inserts fire the DEFINER create-on-insert
// triggers (one preferences row + one home-studio list row per contact).
const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF_A}', 'staff'), ('${OWNER_A}', 'owner'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff'), ('${OWNER_A}', '${LOC_A}', 'owner');
  INSERT INTO public.contacts (id, name, location_id, user_id) VALUES
    ('${C_OUT}', 'Synth Opted Out', '${LOC_A}', '${MEMBER}'),
    ('${C_TWO}', 'Synth Two', '${LOC_A}', NULL),
    ('${C_B}', 'Synth Elsewhere', '${LOC_B}', NULL);
  UPDATE public.contact_preferences SET email_marketing = false, unsubscribe_token = '${TOKEN}' WHERE contact_id = '${C_OUT}';
  INSERT INTO public.consent_log (contact_id, channel, action, source, location_id, ip_address, user_agent) VALUES
    ('${C_OUT}', 'email_marketing', 'opt_out', 'preference_centre', '${LOC_A}', '${SYNTH_IP}', '${SYNTH_UA}'),
    ('${C_B}', 'email_marketing', 'opt_in', 'event_form', '${LOC_B}', NULL, NULL);
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
    `SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, [TABLES])
  return rows
}

/** ACL as a sorted set of 'grantee:privilege' (item ORDER in relacl may differ after a re-grant). */
async function aclItems(rel) {
  const { rows } = await db.query(`
    SELECT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type AS item
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.oid = ('public.' || $1)::regclass ORDER BY 1`, [rel])
  return rows.map((r) => r.item)
}
const clientItems = async (rel) => (await aclItems(rel)).filter((i) => /^(anon|authenticated|PUBLIC):/.test(i))

async function boot({ with660 = true, migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PRE_660_POLICIES)
  await runSql(SEED)
  if (with660) await runSql(MIG_660)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_662)
}

describe('before 662 — the read hole (prod after 660)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('after 660 both client roles hold SELECT only on the tables, and the default ALL on the view', async () => {
    for (const t of TABLES) expect(await clientItems(t), t).toEqual(['anon:SELECT', 'authenticated:SELECT'])
    expect((await clientItems(VIEW)).length).toBe(16)
    expect((await policies()).map((p) => p.policyname))
      .toEqual(['consent_log_select', 'contact_location_preferences_select', 'contact_preferences_select'])
  })

  it("a plain staff member reads a customer's unsubscribe token (the preference-centre credential)", async () => {
    expect(await asUser(STAFF_A,
      `SELECT unsubscribe_token::text AS t FROM public.contact_preferences WHERE contact_id = '${C_OUT}'`))
      .toEqual([{ t: TOKEN }])
  })

  it("…the customer's consent IP address and user agent", async () => {
    expect(await asUser(STAFF_A, `SELECT ip_address, user_agent FROM public.consent_log WHERE contact_id = '${C_OUT}'`))
      .toEqual([{ ip_address: SYNTH_IP, user_agent: SYNTH_UA }])
  })

  it('…and the audience view at their studio', async () => {
    expect(await asUser(STAFF_A, `SELECT count(*)::int AS n FROM public.contact_location_audience`)).toEqual([{ n: 2 }])
  })

  it('a signed-in member (no profiles row) reads nothing: every policy needs a staff membership', async () => {
    for (const t of TABLES) {
      expect(await asUser(MEMBER, `SELECT count(*)::int AS n FROM public.${t}`), t).toEqual([{ n: 0 }])
    }
  })
})

describe('after 662 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(RELS)('anon, authenticated and public hold no privilege at all on %s (SELECT and MAINTAIN included)', async (rel) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of ALL_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${rel}`, p])
        expect(r.held, `${role} ${p} ${rel}`).toBe(false)
      }
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const { rows: [r] } = await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS held`, [role, `public.${rel}`, p])
        expect(r.held, `${role} column ${p} ${rel}`).toBe(false)
      }
    }
    expect(await clientItems(rel)).toEqual([])
  })

  it('no policy is left; RLS stays on; service_role keeps its access; the view stays security_invoker', async () => {
    expect(await policies()).toEqual([])
    for (const t of TABLES) {
      const { rows: [r] } = await db.query(`SELECT relrowsecurity AS rls,
          has_table_privilege('service_role', $1, 'SELECT') AND has_table_privilege('service_role', $1, 'INSERT')
            AND has_table_privilege('service_role', $1, 'UPDATE') AND has_table_privilege('service_role', $1, 'DELETE') AS svc
        FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])
      expect(r, t).toEqual({ rls: true, svc: true })
    }
    const { rows: [v] } = await db.query(`SELECT has_table_privilege('service_role', 'public.contact_location_audience', 'SELECT') AS svc,
        reloptions::text AS opts, obj_description('public.contact_location_audience'::regclass, 'pg_class') AS comment
      FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass`)
    expect(v.svc).toBe(true)
    expect(v.opts).toMatch(/security_invoker=(on|true)/)
    expect(v.comment).toBe('synthetic copy of the LOCCOMMS.3 comment')
  })
})

describe('after 662 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each([['plain staff', STAFF_A], ['owner', OWNER_A], ['master', MASTER], ['member', MEMBER]])(
    '%s: every read of the three tables and the view is refused; writes stay refused', async (_l, uid) => {
      for (const t of TABLES) {
        await expect(asUser(uid, `SELECT count(*) FROM public.${t}`), t).rejects.toThrow(denied(t))
      }
      await expect(asUser(uid, `SELECT unsubscribe_token FROM public.contact_preferences WHERE contact_id = '${C_OUT}'`))
        .rejects.toThrow(denied('contact_preferences'))
      await expect(asUser(uid, `SELECT count(*) FROM public.contact_location_audience`)).rejects.toThrow(denied(VIEW))
      await expect(asUser(uid, `UPDATE public.contact_preferences SET email_marketing = true WHERE contact_id = '${C_OUT}'`))
        .rejects.toThrow(denied('contact_preferences'))
      await expect(asUser(uid, `LOCK TABLE public.consent_log IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied('consent_log'))
    })

  it('anon: refused by the grant itself on every relation (it read an empty set before)', async () => {
    for (const rel of RELS) {
      await expect(asRole('anon', `SELECT count(*) FROM public.${rel}`), rel).rejects.toThrow(denied(rel))
    }
  })

  it('service_role: the preference-centre flow still resolves a token, changes consent, logs it, and the DEFINER mirror fires', async () => {
    const rows = await asRole('service_role',
      `SELECT contact_id FROM public.contact_preferences WHERE unsubscribe_token = '${TOKEN}'`,
      `UPDATE public.contact_preferences SET email_marketing = true WHERE unsubscribe_token = '${TOKEN}'`,
      `INSERT INTO public.consent_log (contact_id, channel, action, source, location_id)
         VALUES ('${C_OUT}', 'email_marketing', 'opt_in', 'preference_centre', '${LOC_A}')`,
      `SELECT (SELECT email_marketing FROM public.contacts WHERE id = '${C_OUT}') AS mirrored,
              (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_OUT}') AS logged`)
    expect(rows).toEqual([{ mirrored: true, logged: 2 }])
  })

  it('service_role: the INVOKER ClassPass opt-out (fired by the contacts writer) still upserts and logs', async () => {
    const rows = await asRole('service_role',
      `UPDATE public.contacts SET glofox_membership_status = 'classpass_payg' WHERE id = '${C_TWO}'`,
      `SELECT (SELECT email_marketing FROM public.contact_preferences WHERE contact_id = '${C_TWO}') AS prefs,
              (SELECT email_marketing FROM public.contact_location_preferences WHERE contact_id = '${C_TWO}') AS loc,
              (SELECT email_marketing FROM public.contacts WHERE id = '${C_TWO}') AS mirrored,
              (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_TWO}' AND source = 'auto_classpass') AS logged`)
    expect(rows).toEqual([{ prefs: false, loc: false, mirrored: false, logged: 6 }])
  })

  it('service_role: contact create still seeds both preference rows; contact delete still cascades all three', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.contacts (id, name, location_id) VALUES ('${C_NEW}', 'Synth New', '${LOC_A}')`,
      `DELETE FROM public.contacts WHERE id = '${C_B}'`,
      `SELECT (SELECT count(*)::int FROM public.contact_preferences WHERE contact_id = '${C_NEW}') AS new_prefs,
              (SELECT count(*)::int FROM public.contact_location_preferences WHERE contact_id = '${C_NEW}') AS new_loc,
              (SELECT count(*)::int FROM public.contact_preferences WHERE contact_id = '${C_B}')
                + (SELECT count(*)::int FROM public.contact_location_preferences WHERE contact_id = '${C_B}')
                + (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_B}') AS gone,
              (SELECT count(*)::int FROM public.contact_location_audience WHERE audience_location_id = '${LOC_A}') AS audience_a`)
    expect(rows).toEqual([{ new_prefs: 1, new_loc: 1, gone: 0, audience_a: 3 }])
  })
})

describe('order, and the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  it('662 refuses to run before 660 (it would make 660 abort forever)', async () => {
    await boot({ with660: false })
    await expect(runSql(MIG_662)).rejects.toThrow(/mig 662: apply 660 \(CONSENTCLIENTWRITE\.1\) first/)
    await runSql('ROLLBACK')
    expect((await policies()).map((p) => p.policyname)).toEqual(
      ['consent_log_via_contact', 'contact_location_preferences_location_scoped', 'contact_preferences_location_scoped'])
    expect(await clientItems('contact_preferences')).toContain('authenticated:SELECT')
  }, 60_000)

  async function expectAbort(before, message) {
    await boot({ before })
    await expect(runSql(MIG_662)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    expect((await policies()).map((p) => p.policyname))
      .toEqual(['consent_log_select', 'contact_location_preferences_select', 'contact_preferences_select'])
    expect(await clientItems('contact_preferences')).toContain('authenticated:SELECT')
  }

  it("when another grantor's SELECT on consent_log survives the REVOKE", () => expectAbort(
    `GRANT SELECT ON public.consent_log TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT ON public.consent_log TO authenticated; RESET ROLE;`,
    /mig 662: authenticated still holds SELECT on public\.consent_log/,
  ), 60_000)

  it('when SELECT on contact_preferences is inherited through role membership', () => expectAbort(
    `GRANT SELECT ON public.contact_preferences TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 662: authenticated still holds SELECT on public\.contact_preferences/,
  ), 60_000)

  it('when a policy on another table reads consent_log (a client read of that table would start failing)', () => expectAbort(
    `CREATE TABLE public.side_panel (id uuid PRIMARY KEY, contact_id uuid);
     ALTER TABLE public.side_panel ENABLE ROW LEVEL SECURITY;
     CREATE POLICY side_panel_read ON public.side_panel FOR SELECT TO authenticated
       USING (EXISTS (SELECT 1 FROM public.consent_log l WHERE l.contact_id = side_panel.contact_id));`,
    /mig 662: policies on other tables read the consent tables .*public\.side_panel\.side_panel_read/,
  ), 60_000)

  it('when a second view reads contact_preferences', () => expectAbort(
    `CREATE VIEW public.prefs_peek WITH (security_invoker = on) AS SELECT contact_id FROM public.contact_preferences;`,
    /mig 662: views other than contact_location_audience depend on the consent tables or on that view: public\.prefs_peek/,
  ), 60_000)

  it('when a view reads contact_location_audience itself (it kept default grants; as DEFINER it would expose the rows)', () => expectAbort(
    `CREATE VIEW public.audience_peek AS SELECT id, loc_email_marketing FROM public.contact_location_audience;`,
    /mig 662: views other than contact_location_audience depend on the consent tables or on that view: public\.audience_peek/,
  ), 60_000)

  it('a second run passes its own pre-check and self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_662)).resolves.toBeDefined()
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the post-660 grants and policies exactly (and so the read hole)', async () => {
    await boot()
    const aclBefore = await Promise.all(RELS.map(aclItems))
    const policiesBefore = await policies()
    await runSql(MIG_662)
    await runSql(ROLLBACK_662)
    expect(await Promise.all(RELS.map(aclItems))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(STAFF_A,
      `SELECT unsubscribe_token::text AS t FROM public.contact_preferences WHERE contact_id = '${C_OUT}'`))
      .toEqual([{ t: TOKEN }])
  }, 60_000)
})
