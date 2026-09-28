// SECFIX.3c — behavioural GRANT test for migration 648.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// run on prod. This boots PGlite with the five tables in PROD column order,
// the prod helpers and policies (read out of the catalog on 28 Sep 2026) and
// the prod grants (Supabase's default privileges: ALL on every new public
// table for anon + authenticated + service_role), proves the leak and the xero
// write hole, applies the REAL 648 file, and asserts:
//   * the catalog holds exactly the lists (column_privileges + has_column_privilege)
//   * a staff member, an owner and a member are refused every withheld column
//     and `SELECT *`, and every write outside the lists
//   * every live reader's shape still works: the phone's locations(id, name)
//     embed, the organisations policy's join on locations, LocationForm's
//     update + select('id'), CarDepositSettings' update, the member
//     integrations select + toggle + disconnect
//   * the self-check aborts the WHOLE file when the table REVOKE is missing, a
//     column is unclassified or a granted column is missing, and a second run
//     passes.
// Fictional values only (SYNTH-…): the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { CREDENTIAL_COLUMN_GRANTS, NO_CLIENT_ACCESS_TABLES, CREDENTIAL_GRANT_TABLES } from './helpers/credential-column-grants.js'

const MIG_648 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/648_credential_column_grants.sql'), 'utf8')

const ORG = '0a000000-0000-0000-0000-00000000000a'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const STAFF = '10000000-0000-0000-0000-000000000001'
const OWNER = '10000000-0000-0000-0000-000000000002'
const MEMBER_USER = '20000000-0000-0000-0000-000000000001'
const MEMBER_CONTACT = '30000000-0000-0000-0000-000000000001'
const CEI = '40000000-0000-0000-0000-000000000001'

const DENIED = /permission denied for (table|relation) (locations|channel_connections|whatsapp_numbers|xero_connections|contact_external_integrations)/

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO authenticated, anon, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;  -- prod nspacl: anon has none

  -- Supabase's default privileges: every table created in public is born with
  -- ALL for the three API roles. This is what mig 648's table-level REVOKE
  -- has to undo, so the replay models it rather than granting by hand.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  -- Supabase's own auth.uid() shape: an empty claims setting (what a rolled-
  -- back set_config leaves behind) reads as NULL, never as bad JSON.
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid, user_id uuid);

  -- Prod column order (information_schema.columns, 28 Sep 2026).
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, name text NOT NULL, slug text, address text, phone text, email text,
    timezone text, active boolean DEFAULT true, settings jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), country character(2),
    features jsonb, car_deposit_default_amount numeric(10,2), car_deposit_terms text,
    car_deposit_terms_version integer DEFAULT 1, car_deposit_whatsapp_template_id uuid,
    twilio_alpha_sender_id text, monthly_contractor_budget_eur numeric,
    car_deposit_receipt_sms_enabled boolean, organization_id uuid REFERENCES public.organizations(id),
    sensibo_api_key text, sensibo_pod_id text, ac_default_mode text, ac_default_temp integer,
    ac_default_fan text, ac_session_minutes integer, bca_config jsonb, notification_config jsonb,
    invoices_inbound_slug text, churn_digest_recipients text[], thinq_pat text, thinq_client_id text,
    thinq_country_code text, dunning_sequence_id uuid, is_host_anchor boolean DEFAULT false,
    email_inbox_reply_to text, dunning_auto_enroll boolean, glofox_auto_cancel_memberships boolean
  );
  CREATE TABLE public.channel_connections (
    id uuid PRIMARY KEY, location_id uuid, platform text, label text, external_account_id text,
    page_id text, app_id text, access_token text, app_secret text, display_name text,
    is_active boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    updated_by uuid, agent_enabled boolean, token_expires_at timestamptz, token_refreshed_at timestamptz,
    status text, last_error text, last_ok_at timestamptz, config jsonb
  );
  CREATE TABLE public.whatsapp_numbers (
    id uuid PRIMARY KEY, location_id uuid, label text, phone_number_id text, business_account_id text,
    app_id text, access_token text, display_phone text, source text, is_default boolean, is_active boolean,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), is_on_biz_app boolean,
    platform_type text, history_sync_status text, history_sync_started_at timestamptz,
    history_sync_completed_at timestamptz, history_sync_error text, embedded_signup_session_id text,
    quality_rating text, messaging_limit_tier text, name_status text, quality_checked_at timestamptz,
    token_invalid_at timestamptz, token_type text, connected_via text, signup_meta jsonb
  );
  CREATE TABLE public.xero_connections (
    id uuid PRIMARY KEY, location_id uuid, tenant_id text, tenant_name text, tenant_type text,
    access_token text, refresh_token text, expires_at timestamptz, scopes text, connected_at timestamptz,
    connected_by uuid, last_refreshed_at timestamptz, bills_email_address text,
    accounts_last_synced_at timestamptz, contacts_last_synced_at timestamptz, accounts_sync_error text,
    contacts_sync_error text, car_sales_account_code text, tax_rates_last_synced_at timestamptz,
    tax_rates_sync_error text
  );
  CREATE TABLE public.contact_external_integrations (
    id uuid PRIMARY KEY, contact_id uuid, provider text, external_athlete_id text, access_token text,
    refresh_token text, expires_at timestamptz, scopes text, auto_export_enabled boolean DEFAULT true,
    connected_at timestamptz DEFAULT now(), disconnected_at timestamptz, last_export_at timestamptz,
    last_error text, import_backfilled_at timestamptz
  );

  REVOKE SELECT ON public.profiles FROM authenticated, anon;  -- mig 153b

  -- Helpers, verbatim from prod (pg_proc.prosrc, 28 Sep).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master'
                   AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_is_owner_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.profile_id = (SELECT auth.uid()) AND pl.location_id = p_location_id AND pl.role = 'owner')))
  $$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $$;
  -- Prod: the private.* helpers are not executable by PUBLIC/anon (the
  -- plan's inventory: anon's query against these policies ERRORS, 42501 on
  -- the helper), only by authenticated.
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;
`

const PROD_POLICIES = `
  ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.channel_connections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.whatsapp_numbers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.xero_connections ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.contact_external_integrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

  CREATE POLICY locations_read ON public.locations FOR SELECT
    USING ((SELECT private.auth_is_master()) OR private.auth_is_owner_at(id) OR private.auth_is_in_location(id));
  CREATE POLICY locations_ins ON public.locations FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_master() OR private.auth_is_owner_at(id));
  CREATE POLICY locations_upd ON public.locations FOR UPDATE TO authenticated
    USING (private.auth_is_master() OR private.auth_is_owner_at(id))
    WITH CHECK (private.auth_is_master() OR private.auth_is_owner_at(id));
  CREATE POLICY locations_del ON public.locations FOR DELETE TO authenticated
    USING (private.auth_is_master() OR private.auth_is_owner_at(id));

  CREATE POLICY channel_connections_select ON public.channel_connections FOR SELECT
    USING ((SELECT private.auth_is_master()) OR EXISTS (SELECT 1 FROM public.profile_locations pl
      WHERE pl.location_id = channel_connections.location_id AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY channel_connections_deny_anon ON public.channel_connections AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
  CREATE POLICY channel_connections_deny_insert ON public.channel_connections AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false);
  CREATE POLICY channel_connections_deny_update ON public.channel_connections AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
  CREATE POLICY channel_connections_deny_delete ON public.channel_connections AS RESTRICTIVE FOR DELETE TO authenticated USING (false);

  CREATE POLICY whatsapp_numbers_select ON public.whatsapp_numbers FOR SELECT
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY whatsapp_numbers_deny_anon ON public.whatsapp_numbers AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
  CREATE POLICY whatsapp_numbers_deny_insert ON public.whatsapp_numbers AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false);
  CREATE POLICY whatsapp_numbers_deny_update ON public.whatsapp_numbers AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
  CREATE POLICY whatsapp_numbers_deny_delete ON public.whatsapp_numbers AS RESTRICTIVE FOR DELETE TO authenticated USING (false);

  CREATE POLICY xero_connections_member_select ON public.xero_connections FOR SELECT USING (private.auth_is_in_location(location_id));
  CREATE POLICY xero_connections_ins ON public.xero_connections FOR INSERT WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY xero_connections_upd ON public.xero_connections FOR UPDATE
    USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
  CREATE POLICY xero_connections_del ON public.xero_connections FOR DELETE USING (private.auth_is_in_location(location_id));

  CREATE POLICY contact_external_integrations_read ON public.contact_external_integrations FOR SELECT
    USING ((contact_id = private.auth_contact_id()) OR private.auth_is_master() OR EXISTS (SELECT 1 FROM public.contacts c
      WHERE c.id = contact_external_integrations.contact_id AND private.auth_is_in_location(c.location_id)));
  CREATE POLICY "Customers update own integration toggle" ON public.contact_external_integrations FOR UPDATE
    USING (contact_id = private.auth_contact_id()) WITH CHECK (contact_id = private.auth_contact_id());

  -- A policy on ANOTHER table that joins locations as the invoking user
  -- (the same shape as org_settings / contracts / storage.objects; on prod all
  -- sixteen such policies read l.id and l.organization_id only).
  CREATE POLICY organizations_select ON public.organizations FOR SELECT TO authenticated
    USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
      WHERE l.organization_id = organizations.id AND pl.profile_id = (SELECT auth.uid())
        AND (SELECT private.auth_is_active_staff())));
`

const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG}', 'Org');
  INSERT INTO public.locations (id, name, slug, organization_id, settings, sensibo_api_key, thinq_pat) VALUES
    ('${LOC_A}', 'Studio A', 'studio-a', '${ORG}',
     '{"glofox":{"branch_id":"b1","api_key":"SYNTH-GK","api_token":"SYNTH-GT","webhook_secret":"SYNTH-GW"},"unifi":{"api_token":"SYNTH-UT"}}',
     'SYNTH-SENSIBO', 'SYNTH-THINQ'),
    ('${LOC_B}', 'Studio B', 'studio-b', '${ORG}', '{}', NULL, NULL);
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff'), ('${OWNER}', 'owner');
  INSERT INTO public.profile_locations VALUES ('${STAFF}', '${LOC_A}', 'staff'), ('${OWNER}', '${LOC_A}', 'owner');
  INSERT INTO public.contacts VALUES ('${MEMBER_CONTACT}', '${LOC_A}', '${MEMBER_USER}');
  INSERT INTO public.channel_connections (id, location_id, platform, access_token, app_secret, is_active, config) VALUES
    ('50000000-0000-0000-0000-000000000001', '${LOC_A}', 'glofox', 'SYNTH-CC', 'SYNTH-CCS', true, '{"api_token":"SYNTH-CFG"}');
  INSERT INTO public.whatsapp_numbers (id, location_id, access_token) VALUES ('60000000-0000-0000-0000-000000000001', '${LOC_A}', 'SYNTH-WA');
  INSERT INTO public.xero_connections (id, location_id, tenant_id, access_token, refresh_token) VALUES
    ('70000000-0000-0000-0000-000000000001', '${LOC_A}', 't1', 'SYNTH-XA', 'SYNTH-XR');
  INSERT INTO public.contact_external_integrations (id, contact_id, provider, access_token, refresh_token) VALUES
    ('${CEI}', '${MEMBER_CONTACT}', 'strava', 'SYNTH-SA', 'SYNTH-SR');
`

// shared/dashboard-data.js fetchDashboardShifts' `locations:location_id ( id, name )`
// embed, as PostgREST emits it (a correlated subquery on the named columns).
const PHONE_LOCATION_EMBED_SQL = `
  SELECT (SELECT row_to_json(l1.*) FROM (SELECT l.id, l.name FROM public.locations l WHERE l.id = $1) l1) AS locations`

// mobile/app/(member)/account/integrations.jsx + champ-app IntegrationsManager.
const MEMBER_INTEGRATIONS_SQL = `
  SELECT id, provider, external_athlete_id, auto_export_enabled, connected_at, disconnected_at, last_export_at, last_error
    FROM public.contact_external_integrations WHERE contact_id = $1 AND disconnected_at IS NULL`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx; returns rows. */
async function asUser(uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function asAnon(sql) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
    await runSql('SET LOCAL ROLE anon')
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function columnGrants(table, grantee, privilege) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 AND privilege_type = $3
      ORDER BY column_name`, [table, grantee, privilege])
  return rows.map((r) => r.column_name)
}

async function tablePrivileges(table, grantee) {
  const { rows } = await db.query(
    `SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY privilege_type`, [table, grantee])
  return rows.map((r) => r.privilege_type)
}

async function tableColumns(table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, [table])
  return rows.map((r) => r.column_name)
}

const sorted = (xs) => [...xs].sort()
const ALL_TABLE_PRIVS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']

async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (migrate) await runSql(MIG_648)
}

describe('before 648 — the leak and the write hole (prod today)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(CREDENTIAL_GRANT_TABLES)('%s: both client roles hold the default table-level ALL (prod relacl arwdDxtm)', async (table) => {
    expect(await tablePrivileges(table, 'authenticated')).toEqual(ALL_TABLE_PRIVS)
    expect(await tablePrivileges(table, 'anon')).toEqual(ALL_TABLE_PRIVS)
  })

  it('a plain staff member reads every stored credential at their studio', async () => {
    const [r] = await asUser(STAFF, `SELECT
      (SELECT count(sensibo_api_key) FROM public.locations)::int AS sensibo,
      (SELECT count(thinq_pat) FROM public.locations)::int AS thinq,
      (SELECT count(*) FROM public.locations WHERE settings->'glofox' ? 'api_key')::int AS glofox,
      (SELECT count(access_token) FROM public.channel_connections)::int AS cc,
      (SELECT count(access_token) FROM public.whatsapp_numbers)::int AS wa,
      (SELECT count(refresh_token) FROM public.xero_connections)::int AS xero,
      (SELECT count(access_token) FROM public.contact_external_integrations)::int AS strava`)
    expect(r).toEqual({ sensibo: 1, thinq: 1, glofox: 1, cc: 1, wa: 1, xero: 1, strava: 1 })
  })

  it("a plain staff member can rewrite the studio's Xero connection", async () => {
    const rows = await asUser(STAFF, `UPDATE public.xero_connections SET tenant_id = 'attacker' RETURNING id`)
    expect(rows).toHaveLength(1)
  })

  it('a member can overwrite their own Strava token (UPDATE on any column)', async () => {
    const rows = await asUser(MEMBER_USER, `UPDATE public.contact_external_integrations SET access_token = 'x' WHERE id = $1 RETURNING id`, [CEI])
    expect(rows).toHaveLength(1)
  })

  it('anon is fenced only by an error (the private.* helpers), not by the grant', async () => {
    await expect(asAnon('SELECT id FROM public.locations')).rejects.toThrow(/permission denied for (schema private|function auth_is_)/)
  })
})

describe('after 648 — the catalog', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it.each(Object.keys(CREDENTIAL_COLUMN_GRANTS))('%s: select + withheld = every column, no overlap', async (table) => {
    const { select, withheld } = CREDENTIAL_COLUMN_GRANTS[table]
    expect(sorted([...select, ...withheld])).toEqual(await tableColumns(table))
    expect(select.filter((c) => withheld.includes(c))).toEqual([])
  })

  it.each(Object.keys(CREDENTIAL_COLUMN_GRANTS))('%s: every UPDATE column exists on the table', async (table) => {
    const cols = await tableColumns(table)
    expect(CREDENTIAL_COLUMN_GRANTS[table].update.filter((c) => !cols.includes(c))).toEqual([])
  })

  it.each(CREDENTIAL_GRANT_TABLES)('%s: no table-level privilege remains for either client role', async (table) => {
    expect(await tablePrivileges(table, 'authenticated')).toEqual([])
    expect(await tablePrivileges(table, 'anon')).toEqual([])
    expect(await tablePrivileges(table, 'PUBLIC')).toEqual([])
    expect(await tablePrivileges(table, 'service_role')).toEqual(ALL_TABLE_PRIVS)
  })

  it.each(Object.keys(CREDENTIAL_COLUMN_GRANTS))('%s: authenticated holds exactly the SELECT and UPDATE lists', async (table) => {
    const { select, update } = CREDENTIAL_COLUMN_GRANTS[table]
    expect(await columnGrants(table, 'authenticated', 'SELECT')).toEqual(sorted(select))
    expect(await columnGrants(table, 'authenticated', 'UPDATE')).toEqual(sorted(update))
    expect(await columnGrants(table, 'authenticated', 'INSERT')).toEqual([])
    expect(await columnGrants(table, 'authenticated', 'REFERENCES')).toEqual([])
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      expect(await columnGrants(table, 'anon', priv)).toEqual([])
    }
  })

  it.each(NO_CLIENT_ACCESS_TABLES)('%s: neither client role holds anything', async (table) => {
    const { rows: [r] } = await db.query(
      `SELECT has_table_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') a_tbl,
              has_any_column_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,REFERENCES') a_col,
              has_table_privilege('anon', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') n_tbl,
              has_any_column_privilege('anon', $1, 'SELECT,INSERT,UPDATE,REFERENCES') n_col`, [`public.${table}`])
    expect(r).toEqual({ a_tbl: false, a_col: false, n_tbl: false, n_col: false })
  })

  it("the migration's GRANT lines name exactly the helper's lists", () => {
    for (const [table, { select, update }] of Object.entries(CREDENTIAL_COLUMN_GRANTS)) {
      const sel = MIG_648.match(new RegExp(`^GRANT SELECT \\(([^)]*)\\) ON public\\.${table} TO authenticated;`, 'm'))
      const upd = MIG_648.match(new RegExp(`^GRANT UPDATE \\(([^)]*)\\) ON public\\.${table} TO authenticated;`, 'm'))
      expect(sorted(sel[1].split(',').map((s) => s.trim()))).toEqual(sorted(select))
      expect(sorted(upd[1].split(',').map((s) => s.trim()))).toEqual(sorted(update))
    }
  })

  it("takes its locks with a 5s lock_timeout, set right after BEGIN (never queues behind a long reader)", () => {
    expect(MIG_648).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';\n/m)
  })

  it('a second run passes its own self-check (idempotent)', async () => {
    await expect(runSql(MIG_648)).resolves.toBeDefined()
    expect(await columnGrants('locations', 'authenticated', 'SELECT')).toEqual(sorted(CREDENTIAL_COLUMN_GRANTS.locations.select))
  })
})

describe('after 648 — people', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  // Staff
  it("staff: the phone's locations(id, name) embed still works", async () => {
    const rows = await asUser(STAFF, PHONE_LOCATION_EMBED_SQL, [LOC_A])
    expect(rows[0].locations).toEqual({ id: LOC_A, name: 'Studio A' })
  })

  it('staff: their studio identity still reads, RLS unchanged (one row, not two)', async () => {
    expect(await asUser(STAFF, 'SELECT id, name, slug, organization_id, features, is_host_anchor FROM public.locations'))
      .toEqual([{ id: LOC_A, name: 'Studio A', slug: 'studio-a', organization_id: ORG, features: null, is_host_anchor: false }])
  })

  it('staff: their organisation is still visible (the policy joins locations as them)', async () => {
    expect(await asUser(STAFF, 'SELECT id FROM public.organizations')).toHaveLength(1)
  })

  it.each(CREDENTIAL_COLUMN_GRANTS.locations.withheld)('staff: locations.%s is refused', async (col) => {
    await expect(asUser(STAFF, `SELECT ${col} FROM public.locations`)).rejects.toThrow(DENIED)
  })

  it('staff: SELECT * on locations is refused whole, and so is a filter on a withheld column', async () => {
    await expect(asUser(STAFF, 'SELECT * FROM public.locations')).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, `SELECT id FROM public.locations WHERE settings->'glofox' ? 'api_key'`)).rejects.toThrow(DENIED)
  })

  it.each(NO_CLIENT_ACCESS_TABLES)('staff: %s is refused entirely, reads and writes', async (table) => {
    await expect(asUser(STAFF, `SELECT id FROM public.${table}`)).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, `UPDATE public.${table} SET id = id`)).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, `DELETE FROM public.${table}`)).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, `INSERT INTO public.${table} (id, location_id) VALUES ('80000000-0000-0000-0000-000000000001', '${LOC_A}')`)).rejects.toThrow(DENIED)
  })

  it("staff: members' Strava tokens are refused; the safe columns read", async () => {
    await expect(asUser(STAFF, 'SELECT access_token FROM public.contact_external_integrations')).rejects.toThrow(DENIED)
    await expect(asUser(STAFF, 'SELECT * FROM public.contact_external_integrations')).rejects.toThrow(DENIED)
    expect(await asUser(STAFF, MEMBER_INTEGRATIONS_SQL, [MEMBER_CONTACT])).toHaveLength(1)
  })

  // Owner (the two browser forms)
  it("owner: LocationForm's edit (update + select id) still works", async () => {
    const rows = await asUser(OWNER, `UPDATE public.locations SET name = 'Studio A2', slug = 'studio-a2', address = NULL,
      phone = NULL, email = NULL, timezone = 'Europe/Dublin', country = 'IE', active = true,
      monthly_contractor_budget_eur = 100, invoices_inbound_slug = NULL, updated_at = now()
      WHERE id = $1 RETURNING id`, [LOC_A])
    expect(rows).toEqual([{ id: LOC_A }])
  })

  it("owner: CarDepositSettings' update still works", async () => {
    const rows = await asUser(OWNER, `UPDATE public.locations SET car_deposit_default_amount = 200, car_deposit_terms = 't',
      car_deposit_terms_version = 2, car_deposit_receipt_sms_enabled = true WHERE id = $1 RETURNING id`, [LOC_A])
    expect(rows).toHaveLength(1)
  })

  it('owner: RLS still decides WHICH row (staff UPDATE touches 0 rows, no error)', async () => {
    expect(await asUser(STAFF, `UPDATE public.locations SET name = 'x' WHERE id = $1 RETURNING id`, [LOC_A])).toEqual([])
  })

  it.each([
    ['settings', `'{}'::jsonb`], ['sensibo_api_key', 'NULL'], ['thinq_pat', 'NULL'],
    ['twilio_alpha_sender_id', `'X'`], ['organization_id', 'NULL'], ['features', `'{}'::jsonb`],
  ])('owner: UPDATE locations.%s is refused', async (col, value) => {
    await expect(asUser(OWNER, `UPDATE public.locations SET ${col} = ${value} WHERE id = '${LOC_A}'`)).rejects.toThrow(DENIED)
  })

  it('owner: a write that RETURNs a withheld column (a bare .select()) is refused whole', async () => {
    await expect(asUser(OWNER, `UPDATE public.locations SET name = 'x' WHERE id = '${LOC_A}' RETURNING *`)).rejects.toThrow(DENIED)
  })

  it('owner: no INSERT or DELETE on locations from a client', async () => {
    await expect(asUser(OWNER, `INSERT INTO public.locations (id, name) VALUES ('c0000000-0000-0000-0000-00000000000c', 'New')`)).rejects.toThrow(DENIED)
    await expect(asUser(OWNER, `DELETE FROM public.locations WHERE id = '${LOC_B}'`)).rejects.toThrow(DENIED)
  })

  // Member (customer session, no profile)
  it('member: the integrations screen reads, toggles and disconnects; tokens are refused', async () => {
    expect(await asUser(MEMBER_USER, MEMBER_INTEGRATIONS_SQL, [MEMBER_CONTACT])).toHaveLength(1)
    expect(await asUser(MEMBER_USER, `UPDATE public.contact_external_integrations SET auto_export_enabled = false WHERE id = $1 RETURNING id`, [CEI])).toHaveLength(1)
    expect(await asUser(MEMBER_USER, `UPDATE public.contact_external_integrations SET disconnected_at = now(), auto_export_enabled = false WHERE id = $1 RETURNING id`, [CEI])).toHaveLength(1)
    await expect(asUser(MEMBER_USER, 'SELECT access_token FROM public.contact_external_integrations')).rejects.toThrow(DENIED)
    await expect(asUser(MEMBER_USER, `UPDATE public.contact_external_integrations SET access_token = 'x' WHERE id = '${CEI}'`)).rejects.toThrow(DENIED)
    await expect(asUser(MEMBER_USER, `DELETE FROM public.contact_external_integrations WHERE id = '${CEI}'`)).rejects.toThrow(DENIED)
  })

  it('anon: refused by the grant itself now', async () => {
    await expect(asAnon('SELECT id FROM public.locations')).rejects.toThrow(DENIED)
    // The planner pre-evaluates the STABLE auth_contact_id() in this table's
    // policy while estimating, so anon's first error here is the helper's
    // EXECUTE, raised before the executor's table check. Refused either way;
    // the catalog cases above prove anon holds no column of it.
    await expect(asAnon('SELECT id FROM public.contact_external_integrations'))
      .rejects.toThrow(/permission denied for (table contact_external_integrations|function auth_contact_id)/)
    expect((await db.query(`SELECT has_any_column_privilege('anon', 'public.contact_external_integrations', 'SELECT') AS v`)).rows[0].v).toBe(false)
  })
})

describe('the self-check aborts the whole file', () => {
  // The file is one transaction (BEGIN … COMMIT), so a RAISE leaves it
  // aborted; ROLLBACK then restores the pre-648 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  const stillOpen = async () => {
    expect(await tablePrivileges('locations', 'authenticated')).toEqual(ALL_TABLE_PRIVS)
    expect(await tablePrivileges('xero_connections', 'authenticated')).toEqual(ALL_TABLE_PRIVS)
    expect(await columnGrants('locations', 'authenticated', 'SELECT')).toHaveLength(39)
  }

  it('when the table-level REVOKE on locations is missing (the mig 153 mistake)', async () => {
    const line = 'REVOKE ALL ON public.locations FROM authenticated, anon;\n'
    expect(MIG_648).toContain(line)
    await expect(runSql(MIG_648.replace(line, ''))).rejects.toThrow(/SECFIX\.3c: table-level privilege on public\.locations survived/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when the table-level REVOKE on xero_connections is missing', async () => {
    const line = 'REVOKE ALL ON public.xero_connections FROM authenticated, anon;\n'
    expect(MIG_648).toContain(line)
    await expect(runSql(MIG_648.replace(line, ''))).rejects.toThrow(/SECFIX\.3c: authenticated still holds a privilege on public\.xero_connections/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it.each(CREDENTIAL_GRANT_TABLES)('when service_role has lost a privilege on %s (every route would break)', async (table) => {
    // has_table_privilege with a comma list is true if ANY is held, so each
    // privilege is checked on its own: losing one alone must abort.
    await runSql(`BEGIN; REVOKE DELETE ON public.${table} FROM service_role;`)
    await expect(runSql(MIG_648)).rejects.toThrow(new RegExp(`SECFIX\\.3c: service_role lacks DELETE on public\\.${table}`))
    await runSql('ROLLBACK')
    expect(await tablePrivileges(table, 'service_role')).toEqual(ALL_TABLE_PRIVS)
    await stillOpen()
  })

  it('when a column is unclassified', async () => {
    // Inside the same transaction, so the ROLLBACK removes the column again.
    await runSql('BEGIN; ALTER TABLE public.locations ADD COLUMN shelly_token text;')
    await expect(runSql(MIG_648)).rejects.toThrow(/public\.locations has column\(s\) this migration does not classify: shelly_token/)
    await runSql('ROLLBACK')
    expect(await tableColumns('locations')).not.toContain('shelly_token')
    await stillOpen()
  })

  it('when a withheld column is granted (settings added to the SELECT list)', async () => {
    const broken = MIG_648.replace('organization_id, is_host_anchor) ON public.locations TO authenticated;',
      'organization_id, is_host_anchor, settings) ON public.locations TO authenticated;')
    expect(broken).not.toBe(MIG_648)
    await expect(runSql(broken)).rejects.toThrow(/SECFIX\.3c: public\.locations SELECT for authenticated is \[.*settings/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when a granted column is missing (the member toggle left out)', async () => {
    const broken = MIG_648.replace('GRANT UPDATE (auto_export_enabled, disconnected_at)', 'GRANT UPDATE (disconnected_at)')
    expect(broken).not.toBe(MIG_648)
    await expect(runSql(broken)).rejects.toThrow(/SECFIX\.3c: public\.contact_external_integrations UPDATE for authenticated is \[disconnected_at\]/)
    await runSql('ROLLBACK')
    await stillOpen()
  })
})

describe("the header's rollback restores the pre-648 grants exactly", () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('REVOKE ALL + GRANT ALL, no column lists: both roles back to table-level ALL, no column ACL left', async () => {
    const block = MIG_648.match(/^-- ROLLBACK:[\s\S]*?^--\s+BEGIN;\n([\s\S]*?^--\s+COMMIT;)$/m)
    expect(block, 'the rollback SQL in the header').not.toBeNull()
    const sql = `BEGIN;\n${block[1].replace(/^--\s?/gm, '')}`
    expect(sql).not.toMatch(/\(\s*id\s*,/) // no column lists
    await runSql(sql)
    for (const table of CREDENTIAL_GRANT_TABLES) {
      expect(await tablePrivileges(table, 'authenticated')).toEqual(ALL_TABLE_PRIVS)
      expect(await tablePrivileges(table, 'anon')).toEqual(ALL_TABLE_PRIVS)
      expect(await tablePrivileges(table, 'service_role')).toEqual(ALL_TABLE_PRIVS)
      const { rows } = await db.query(
        `SELECT count(*)::int n FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND attacl IS NOT NULL`, [`public.${table}`])
      expect(rows[0].n, `${table}: column ACLs left behind`).toBe(0)
    }
  })
})
