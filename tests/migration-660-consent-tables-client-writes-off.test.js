// CONSENTCLIENTWRITE.1 — behavioural test for migration 660.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) with Supabase's DEFAULT PRIVILEGES
// (every table in public gets ALL for anon, authenticated and service_role —
// the source of the three tables' arwdDxtm), contact_preferences,
// contact_location_preferences and consent_log in PROD column order (29 Sep
// 2026) with their FKs and CHECKs, the three live FOR ALL policies, the
// verbatim trigger functions (update_updated_at; the DEFINER mirrors
// sync_contact_location_preferences / sync_contacts_email_administrative /
// sync_contacts_email_marketing / sync_contacts_whatsapp_marketing; the DEFINER
// create-on-insert pair; the INVOKER auto_unsubscribe_classpass), and contacts
// in its post-653 state (clients read only; contacts_select verbatim; a column
// SUBSET of the real 104). private.auth_is_in_location is verbatim. It proves:
//
//   * BEFORE: a plain staff member re-subscribes a customer who opted out and
//     the DEFINER mirror rewrites contacts (read-only since 653) with no audit
//     row; flips a transactional flag, rotates the unsubscribe token, deletes a
//     preferences row, adds another studio's contact to their list, deletes
//     and forges consent_log — all from their own session;
//   * AFTER: every write (and LOCK … ACCESS EXCLUSIVE, i.e. MAINTAIN) refused
//     for anon and authenticated, masters included; one SELECT policy per
//     table with the SAME expression; identical reads; the service role's
//     consent path, the ClassPass auto opt-out, contact creation and the
//     contact-delete cascade all still work;
//   * the self-check aborts the WHOLE file on another grantor's write, an
//     inherited write, a surviving MAINTAIN, a leftover write policy and an
//     extra read policy; a second run passes; the plan's rollback record
//     restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_660 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/660_consent_tables_client_writes_off.sql'), 'utf8')

// The rollback record from the C64 plan (Task 5 Step 7), verbatim.
const ROLLBACK_660 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.contact_preferences, public.contact_location_preferences, public.consent_log
  TO anon, authenticated;
DROP POLICY IF EXISTS contact_preferences_select ON public.contact_preferences;
DROP POLICY IF EXISTS contact_preferences_location_scoped ON public.contact_preferences;
CREATE POLICY contact_preferences_location_scoped ON public.contact_preferences FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
DROP POLICY IF EXISTS contact_location_preferences_select ON public.contact_location_preferences;
DROP POLICY IF EXISTS contact_location_preferences_location_scoped ON public.contact_location_preferences;
CREATE POLICY contact_location_preferences_location_scoped ON public.contact_location_preferences FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));
DROP POLICY IF EXISTS consent_log_select ON public.consent_log;
DROP POLICY IF EXISTS consent_log_via_contact ON public.consent_log;
CREATE POLICY consent_log_via_contact ON public.consent_log FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.id = consent_log.contact_id AND private.auth_is_in_location(c.location_id)));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF_A = '10000000-0000-0000-0000-000000000001'   // plain staff at A
const OWNER_A = '10000000-0000-0000-0000-000000000002'   // owner at A
const MASTER = '10000000-0000-0000-0000-000000000003'
const MEMBER = '20000000-0000-0000-0000-000000000001'    // a customer's auth user (no profile)
const C_OUT = '30000000-0000-0000-0000-000000000001'     // at A, opted out of email marketing, the member's own contact
const C_TWO = '30000000-0000-0000-0000-000000000002'     // at A
const C_B = '30000000-0000-0000-0000-000000000003'       // at B
const C_NEW = '30000000-0000-0000-0000-000000000009'
const TOKEN = '40000000-0000-0000-0000-000000000001'

const TABLES = ['consent_log', 'contact_location_preferences', 'contact_preferences']
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)

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

  -- contacts: a SUBSET of the 104 live columns (what the triggers and policies touch).
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

  -- Trigger functions, verbatim bodies (pg_proc.prosrc, 29 Sep). Owner = the
  -- PGlite superuser, as postgres owns them in prod.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$;

  CREATE FUNCTION public.sync_contact_location_preferences() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  declare
    own_location uuid;
  begin
    select location_id into own_location from contacts where id = new.contact_id;

    if coalesce(new.email_marketing, true) = false then
      update contact_location_preferences
         set email_marketing = false,
             unsubscribed_at = coalesce(unsubscribed_at, now()),
             updated_at = now()
       where contact_id = new.contact_id and email_marketing is distinct from false;
    end if;

    if coalesce(new.sms_marketing, true) = false then
      update contact_location_preferences
         set sms_marketing = false, updated_at = now()
       where contact_id = new.contact_id and sms_marketing is distinct from false;
    end if;

    if coalesce(new.whatsapp_marketing, true) = false then
      update contact_location_preferences
         set whatsapp_marketing = false, updated_at = now()
       where contact_id = new.contact_id and whatsapp_marketing is distinct from false;
    end if;

    if own_location is not null then
      update contact_location_preferences
         set email_marketing    = coalesce(new.email_marketing, true),
             sms_marketing      = coalesce(new.sms_marketing, true),
             whatsapp_marketing = coalesce(new.whatsapp_marketing, true),
             unsubscribed_at    = case
                                    when coalesce(new.email_marketing, true) = false
                                      then coalesce(unsubscribed_at, now())
                                    else null
                                  end,
             updated_at         = now()
       where contact_id = new.contact_id
         and location_id = own_location
         and (email_marketing    is distinct from coalesce(new.email_marketing, true)
           or sms_marketing      is distinct from coalesce(new.sms_marketing, true)
           or whatsapp_marketing is distinct from coalesce(new.whatsapp_marketing, true));
    end if;

    return new;
  end;
  $$;

  CREATE FUNCTION public.sync_contacts_email_administrative() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    UPDATE contacts
    SET email_administrative = NEW.email_administrative
    WHERE id = NEW.contact_id
      AND email_administrative IS DISTINCT FROM NEW.email_administrative;
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

  CREATE FUNCTION public.sync_contacts_whatsapp_marketing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    UPDATE contacts
      SET whatsapp_marketing = NEW.whatsapp_marketing
      WHERE id = NEW.contact_id
        AND whatsapp_marketing IS DISTINCT FROM NEW.whatsapp_marketing;
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

  -- INVOKER (prod: prosecdef false, proconfig search_path=pg_catalog, public): runs as whoever writes contacts.
  CREATE FUNCTION public.auto_unsubscribe_classpass() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
  CREATE TRIGGER sync_contact_location_preferences_trigger AFTER INSERT OR UPDATE ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contact_location_preferences();
  CREATE TRIGGER sync_contacts_email_administrative_trigger AFTER INSERT OR UPDATE OF email_administrative ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_email_administrative();
  CREATE TRIGGER sync_contacts_email_marketing_trigger AFTER INSERT OR UPDATE OF email_marketing ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_email_marketing();
  CREATE TRIGGER sync_contacts_whatsapp_marketing_trigger AFTER INSERT OR UPDATE OF whatsapp_marketing ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contacts_whatsapp_marketing();
  CREATE TRIGGER contact_location_preferences_updated_at BEFORE UPDATE ON public.contact_location_preferences
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
`

// The live policies (pg_policies, 29 Sep 2026; migs 014, 487, and contacts_select after 653).
const PROD_POLICIES = `
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
// triggers (one preferences row + one home-studio list row per contact); the
// opt-out fires the DEFINER mirrors (contacts.email_marketing false, list row off).
const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF_A}', 'staff'), ('${OWNER_A}', 'owner'), ('${MASTER}', 'master');
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff'), ('${OWNER_A}', '${LOC_A}', 'owner');
  INSERT INTO public.contacts (id, name, location_id, user_id) VALUES
    ('${C_OUT}', 'Synth Opted Out', '${LOC_A}', '${MEMBER}'),
    ('${C_TWO}', 'Synth Two', '${LOC_A}', NULL),
    ('${C_B}', 'Synth Elsewhere', '${LOC_B}', NULL);
  UPDATE public.contact_preferences SET email_marketing = false, unsubscribe_token = '${TOKEN}' WHERE contact_id = '${C_OUT}';
  INSERT INTO public.consent_log (contact_id, channel, action, source, location_id) VALUES
    ('${C_OUT}', 'email_marketing', 'opt_out', 'preference_centre', '${LOC_A}'),
    ('${C_B}', 'email_marketing', 'opt_in', 'event_form', '${LOC_B}');
`

const COUNTS_SQL = `SELECT (SELECT count(*)::int FROM public.contact_preferences) AS cp,
                           (SELECT count(*)::int FROM public.contact_location_preferences) AS clp,
                           (SELECT count(*)::int FROM public.consent_log) AS log`

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
    `SELECT tablename::text AS tablename, policyname::text AS policyname, permissive, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('contact_preferences', 'contact_location_preferences', 'consent_log')
      ORDER BY tablename, policyname`)
  return rows
}

async function clientAcl(table) {
  const { rows } = await db.query(`
    SELECT r.rolname AS grantee, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE r.rolname IN ('anon', 'authenticated')
     GROUP BY r.rolname ORDER BY r.rolname`, [`public.${table}`])
  return rows
}

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_660)
}

describe('before 660 — the hole (prod on 29 Sep 2026)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('%s: the default privileges gave both client roles every table privilege (arwdDxtm, PG 17)', async (t) => {
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
      { grantee: 'authenticated', privs: 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' },
    ])
  })

  it('plain staff re-subscribes a customer who opted out; the DEFINER mirror rewrites contacts; no audit row', async () => {
    const rows = await asUser(STAFF_A,
      `UPDATE public.contact_preferences SET email_marketing = true WHERE contact_id = '${C_OUT}'`,
      `SELECT (SELECT email_marketing FROM public.contacts WHERE id = '${C_OUT}') AS contact_em,
              (SELECT email_marketing FROM public.contact_location_preferences
                WHERE contact_id = '${C_OUT}' AND location_id = '${LOC_A}') AS list_em,
              (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_OUT}') AS audit_rows`)
    expect(rows).toEqual([{ contact_em: true, list_em: true, audit_rows: 1 }])
  })

  it('…even though writing contacts directly is refused (mig 653)', async () => {
    await expect(asUser(STAFF_A, `UPDATE public.contacts SET email_marketing = true WHERE id = '${C_OUT}'`))
      .rejects.toThrow(denied('contacts'))
  })

  it('…turns off a transactional flag, rotates the unsubscribe token and deletes a preferences row', async () => {
    expect(await asUser(STAFF_A, `UPDATE public.contact_preferences
        SET email_administrative = false, unsubscribe_token = gen_random_uuid()
      WHERE contact_id = '${C_OUT}' RETURNING contact_id`)).toEqual([{ contact_id: C_OUT }])
    expect(await asUser(STAFF_A, `DELETE FROM public.contact_preferences WHERE contact_id = '${C_TWO}' RETURNING contact_id`))
      .toEqual([{ contact_id: C_TWO }])
  })

  it("…adds another studio's contact to their own studio's marketing list", async () => {
    expect(await asUser(STAFF_A, `INSERT INTO public.contact_location_preferences (contact_id, location_id, source)
      VALUES ('${C_B}', '${LOC_A}', 'synthetic') RETURNING contact_id`)).toEqual([{ contact_id: C_B }])
  })

  it('…deletes consent history and forges an entry in the owner\'s name', async () => {
    expect(await asUser(STAFF_A, `DELETE FROM public.consent_log WHERE contact_id = '${C_OUT}' RETURNING contact_id`))
      .toEqual([{ contact_id: C_OUT }])
    expect(await asUser(STAFF_A, `INSERT INTO public.consent_log (contact_id, channel, action, source, performed_by)
      VALUES ('${C_OUT}', 'email_marketing', 'opt_in', 'admin_panel', '${OWNER_A}') RETURNING performed_by`))
      .toEqual([{ performed_by: OWNER_A }])
  })

  it('…and can take an ACCESS EXCLUSIVE lock on the table (UPDATE/MAINTAIN)', async () => {
    await expect(asUser(STAFF_A, 'LOCK TABLE public.contact_preferences IN ACCESS EXCLUSIVE MODE')).resolves.toBeDefined()
  })

  it('a member (no staff profile) never could read or change their preferences directly', async () => {
    expect(await asUser(MEMBER, COUNTS_SQL)).toEqual([{ cp: 0, clp: 0, log: 0 }])
    expect(await asUser(MEMBER, `UPDATE public.contact_preferences SET email_marketing = true RETURNING id`)).toEqual([])
  })
})

describe('after 660 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(TABLES)('%s: anon, authenticated and PUBLIC hold no write privilege (MAINTAIN included)', async (t) => {
    for (const role of ['anon', 'authenticated', 'public']) {
      for (const p of WRITE_PRIVS) {
        const { rows: [r] } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS held`, [role, `public.${t}`, p])
        expect(r.held, `${role} ${p} on ${t}`).toBe(false)
      }
    }
  })

  it.each(TABLES)('%s: no column-level write; SELECT kept; service_role still reads and writes', async (t) => {
    const { rows: [r] } = await db.query(`SELECT
      has_any_column_privilege('authenticated', $1, 'INSERT,UPDATE,REFERENCES') AS a_col,
      has_any_column_privilege('anon', $1, 'INSERT,UPDATE,REFERENCES') AS n_col,
      has_table_privilege('authenticated', $1, 'SELECT') AS a_sel,
      has_table_privilege('anon', $1, 'SELECT') AS n_sel,
      has_table_privilege('service_role', $1, 'SELECT') AND has_table_privilege('service_role', $1, 'INSERT')
        AND has_table_privilege('service_role', $1, 'UPDATE') AND has_table_privilege('service_role', $1, 'DELETE') AS svc`,
      [`public.${t}`])
    expect(r).toEqual({ a_col: false, n_col: false, a_sel: true, n_sel: true, svc: true })
    expect(await clientAcl(t)).toEqual([
      { grantee: 'anon', privs: 'SELECT' },
      { grantee: 'authenticated', privs: 'SELECT' },
    ])
  })

  it('exactly one policy per table: <table>_select, FOR SELECT, TO authenticated', async () => {
    expect((await policies()).map(({ tablename, policyname, permissive, cmd, roles, with_check }) =>
      ({ tablename, policyname, permissive, cmd, roles, with_check }))).toEqual([
      { tablename: 'consent_log', policyname: 'consent_log_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}', with_check: null },
      { tablename: 'contact_location_preferences', policyname: 'contact_location_preferences_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}', with_check: null },
      { tablename: 'contact_preferences', policyname: 'contact_preferences_select', permissive: 'PERMISSIVE', cmd: 'SELECT', roles: '{authenticated}', with_check: null },
    ])
  })
})

describe('after 660 — reads are identical', () => {
  afterEach(async () => { await db?.close() })

  it("each new SELECT policy's expression is the old FOR ALL policy's, and every reader sees the same rows", async () => {
    await boot()
    const before = (await policies()).map((p) => [p.tablename, p.qual])
    const reads = {}
    for (const [who, uid] of [['staff', STAFF_A], ['owner', OWNER_A], ['master', MASTER], ['member', MEMBER]]) {
      reads[who] = await asUser(uid, COUNTS_SQL)
    }
    await runSql(MIG_660)
    expect((await policies()).map((p) => [p.tablename, p.qual])).toEqual(before)
    for (const [who, uid] of [['staff', STAFF_A], ['owner', OWNER_A], ['master', MASTER], ['member', MEMBER]]) {
      expect(await asUser(uid, COUNTS_SQL), who).toEqual(reads[who])
    }
    expect(reads).toEqual({
      staff: [{ cp: 2, clp: 2, log: 1 }], owner: [{ cp: 2, clp: 2, log: 1 }],
      master: [{ cp: 3, clp: 3, log: 2 }], member: [{ cp: 0, clp: 0, log: 0 }],
    })
  }, 60_000)
})

describe('after 660 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  const WRITES = {
    contact_preferences: [
      `INSERT INTO public.contact_preferences (contact_id, location_id) VALUES ('${C_B}', '${LOC_A}')`,
      `UPDATE public.contact_preferences SET email_marketing = true WHERE contact_id = '${C_OUT}'`,
      `INSERT INTO public.contact_preferences (contact_id, location_id) VALUES ('${C_OUT}', '${LOC_A}')
         ON CONFLICT (contact_id) DO UPDATE SET email_marketing = true`,
      `DELETE FROM public.contact_preferences WHERE contact_id = '${C_TWO}'`,
      'TRUNCATE public.contact_preferences CASCADE',
      'LOCK TABLE public.contact_preferences IN ACCESS EXCLUSIVE MODE',
    ],
    contact_location_preferences: [
      `INSERT INTO public.contact_location_preferences (contact_id, location_id, source) VALUES ('${C_B}', '${LOC_A}', 'synthetic')`,
      `UPDATE public.contact_location_preferences SET email_marketing = true WHERE contact_id = '${C_OUT}'`,
      `INSERT INTO public.contact_location_preferences (contact_id, location_id, source) VALUES ('${C_OUT}', '${LOC_A}', 'x')
         ON CONFLICT (contact_id, location_id) DO UPDATE SET email_marketing = true`,
      `DELETE FROM public.contact_location_preferences WHERE contact_id = '${C_TWO}'`,
      'TRUNCATE public.contact_location_preferences',
      'LOCK TABLE public.contact_location_preferences IN ACCESS EXCLUSIVE MODE',
    ],
    consent_log: [
      `INSERT INTO public.consent_log (contact_id, channel, action, source) VALUES ('${C_OUT}', 'email_marketing', 'opt_in', 'admin_panel')`,
      `UPDATE public.consent_log SET action = 'opt_in' WHERE contact_id = '${C_OUT}'`,
      `DELETE FROM public.consent_log WHERE contact_id = '${C_OUT}'`,
      'TRUNCATE public.consent_log',
      'LOCK TABLE public.consent_log IN ACCESS EXCLUSIVE MODE',
    ],
  }

  for (const [label, uid] of [['staff', STAFF_A], ['owner', OWNER_A], ['master', MASTER]]) {
    it.each(TABLES)(`${label}: every write, upsert, truncate and exclusive lock on %s is refused`, async (t) => {
      for (const sql of WRITES[t]) await expect(asUser(uid, sql), sql).rejects.toThrow(denied(t))
    })
  }

  it('staff: a plain read (and an ACCESS SHARE lock, which SELECT allows) still works', async () => {
    expect(await asUser(STAFF_A, 'LOCK TABLE public.consent_log IN ACCESS SHARE MODE', COUNTS_SQL))
      .toEqual([{ cp: 2, clp: 2, log: 1 }])
  })

  it("service_role: the consent routes' writes land and the DEFINER mirrors still fire", async () => {
    const rows = await asRole('service_role',
      `UPDATE public.contact_preferences SET email_marketing = true WHERE contact_id = '${C_OUT}'`,
      `INSERT INTO public.consent_log (contact_id, channel, action, source, performed_by, location_id)
         VALUES ('${C_OUT}', 'email_marketing', 'opt_in', 'admin_panel', '${OWNER_A}', '${LOC_A}')`,
      `SELECT (SELECT email_marketing FROM public.contacts WHERE id = '${C_OUT}') AS contact_em,
              (SELECT email_marketing FROM public.contact_location_preferences
                WHERE contact_id = '${C_OUT}' AND location_id = '${LOC_A}') AS list_em,
              (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_OUT}') AS audit_rows`)
    expect(rows).toEqual([{ contact_em: true, list_em: true, audit_rows: 2 }])
  })

  it('service_role: the ClassPass auto opt-out (INVOKER trigger on contacts) still writes all three tables', async () => {
    const rows = await asRole('service_role',
      `UPDATE public.contacts SET glofox_membership_status = 'classpass_payg' WHERE id = '${C_TWO}'`,
      `SELECT (SELECT email_marketing OR email_administrative OR sms_marketing OR sms_administrative
                      OR whatsapp_marketing OR whatsapp_administrative
                 FROM public.contact_preferences WHERE contact_id = '${C_TWO}') AS any_pref_on,
              (SELECT email_marketing OR sms_marketing OR whatsapp_marketing
                 FROM public.contact_location_preferences WHERE contact_id = '${C_TWO}' AND location_id = '${LOC_A}') AS any_list_on,
              (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_TWO}' AND source = 'auto_classpass') AS logged`)
    expect(rows).toEqual([{ any_pref_on: false, any_list_on: false, logged: 6 }])
  })

  it('service_role: a new contact still gets its preferences and home-studio list rows', async () => {
    const rows = await asRole('service_role',
      `INSERT INTO public.contacts (id, name, location_id) VALUES ('${C_NEW}', 'Synth New', '${LOC_A}')`,
      `SELECT (SELECT count(*)::int FROM public.contact_preferences WHERE contact_id = '${C_NEW}') AS cp,
              (SELECT count(*)::int FROM public.contact_location_preferences WHERE contact_id = '${C_NEW}') AS clp`)
    expect(rows).toEqual([{ cp: 1, clp: 1 }])
  })

  it("service_role: deleting a contact still cascades to all three (RI runs as the table's owner)", async () => {
    const rows = await asRole('service_role',
      `DELETE FROM public.contacts WHERE id = '${C_OUT}'`,
      `SELECT (SELECT count(*)::int FROM public.contact_preferences WHERE contact_id = '${C_OUT}')
            + (SELECT count(*)::int FROM public.contact_location_preferences WHERE contact_id = '${C_OUT}')
            + (SELECT count(*)::int FROM public.consent_log WHERE contact_id = '${C_OUT}') AS left_behind`)
    expect(rows).toEqual([{ left_behind: 0 }])
  })

  it('anon: a write is refused by the grant itself; a read is an empty set (no anon policy)', async () => {
    await expect(asRole('anon', `UPDATE public.contact_preferences SET email_marketing = email_marketing`))
      .rejects.toThrow(denied('contact_preferences'))
    expect(await asRole('anon', COUNTS_SQL)).toEqual([{ cp: 0, clp: 0, log: 0 }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    await expect(runSql(MIG_660)).rejects.toThrow(message)
    await runSql('ROLLBACK')   // the failed multi-statement run leaves its BEGIN open and aborted
    // Nothing was half-applied: the three old policies are still there (plus
    // whatever `before` added) and every table still grants INSERT to clients.
    expect((await policies()).map((p) => p.policyname)).toEqual(expect.arrayContaining([
      'consent_log_via_contact', 'contact_location_preferences_location_scoped', 'contact_preferences_location_scoped',
    ]))
    for (const t of TABLES) expect((await clientAcl(t)).find((r) => r.grantee === 'authenticated').privs, t).toContain('INSERT')
  }

  it('when the old FOR ALL policy read different rows than the new SELECT policy (check 6)', () => expectAbort(
    `DROP POLICY contact_preferences_location_scoped ON public.contact_preferences;
     CREATE POLICY contact_preferences_location_scoped ON public.contact_preferences FOR ALL TO authenticated USING (true) WITH CHECK (true);`,
    /mig 660: contact_preferences_select does not read the same rows as the policy it replaces/,
  ), 60_000)

  it("when another grantor's INSERT on consent_log survives the REVOKE", () => expectAbort(
    `GRANT INSERT ON public.consent_log TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT INSERT ON public.consent_log TO authenticated; RESET ROLE;`,
    /mig 660: anon\/authenticated\/PUBLIC still hold write privileges on public\.consent_log: authenticated:INSERT/,
  ), 60_000)

  it('when UPDATE on contact_preferences is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT UPDATE ON public.contact_preferences TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 660: authenticated still holds UPDATE on public\.contact_preferences/,
  ), 60_000)

  it('when MAINTAIN on contact_location_preferences survives from another grantor', () => expectAbort(
    `GRANT MAINTAIN ON public.contact_location_preferences TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT MAINTAIN ON public.contact_location_preferences TO authenticated; RESET ROLE;`,
    /mig 660: (authenticated still holds MAINTAIN on public\.contact_location_preferences|anon\/authenticated\/PUBLIC still hold write privileges on public\.contact_location_preferences: authenticated:MAINTAIN)/,
  ), 60_000)

  it('when a write policy the file does not know about is left', () => expectAbort(
    `CREATE POLICY consent_log_staff_insert ON public.consent_log FOR INSERT TO authenticated WITH CHECK (true);`,
    /mig 660: write policies remain on public\.consent_log: consent_log_staff_insert INSERT/,
  ), 60_000)

  it('when an extra read policy would widen what staff see', () => expectAbort(
    `CREATE POLICY contact_preferences_read_all ON public.contact_preferences FOR SELECT TO authenticated USING (true);`,
    /mig 660: public\.contact_preferences should keep exactly one policy, contact_preferences_select FOR SELECT/,
  ), 60_000)

  it('a second run passes its own self-check (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_660)).resolves.toBeDefined()
    expect((await policies()).map((p) => p.policyname))
      .toEqual(['consent_log_select', 'contact_location_preferences_select', 'contact_preferences_select'])
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores the 29 Sep grants and policies exactly (and so the hole)', async () => {
    await boot()
    const aclBefore = await Promise.all(TABLES.map(clientAcl))
    const policiesBefore = await policies()
    await runSql(MIG_660)
    await runSql(ROLLBACK_660)
    expect(await Promise.all(TABLES.map(clientAcl))).toEqual(aclBefore)
    expect(await policies()).toEqual(policiesBefore)
    expect(await asUser(STAFF_A, `UPDATE public.contact_preferences SET email_marketing = true
      WHERE contact_id = '${C_OUT}' RETURNING contact_id`)).toEqual([{ contact_id: C_OUT }])
  }, 60_000)
})
