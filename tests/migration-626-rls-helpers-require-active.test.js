// RLSACTIVE.1 — behavioural RLS test for migration 626.
//
// WHY THIS FILE EXISTS
// ────────────────────
// A deactivated coach who is ALSO a gym member keeps a refreshing Supabase
// JWT (the ban is skipped so the member app keeps working). Before 626 every
// RLS helper and inline policy decided staff authority from profiles.role /
// profile_locations / profile_organizations and ignored `active`, so that
// JWT still read studio data as staff. This file boots an in-process Postgres
// (PGlite) with the state 626 lands on — every helper is the LAST definition
// the real migrations give it (extracted from supabase/migrations, not
// retyped), every re-created policy is the net migration state replayed by
// scripts/check-rls-restrictive.mjs — proves the leak, applies the real 626
// file, and asserts:
//   * every staff helper: active → true, NULL active → true, inactive → false,
//     tombstone → false, member-only → unchanged (false);
//   * the p_user_id helpers judge THAT user, not the caller;
//   * member authority (auth_contact_id, member branches) is untouched;
//   * every re-created SELECT policy: active staff still reads, inactive reads 0;
//   * policy shape (cmd / roles / permissive) is identical before and after;
//   * the file's self-check aborts EVERYTHING on an ungated policy or a
//     drifted is_owner().
//
// Tables are the minimum the policies touch, not the full schema.
// (`pg.exec` below is PGlite's multi-statement SQL runner — a SQL call, no shell.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { netPolicyState } from '../scripts/check-rls-restrictive.mjs'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_626 = readFileSync(path.join(MIG_DIR, '626_rls_helpers_require_active.sql'), 'utf8')

// ─── the policies 626 re-creates (schema, table, policy) ────────────────────
const GATED_POLICIES = [
  ['public', 'profile_compensation', 'profile_compensation_select'],
  ['public', 'profile_compensation', 'profile_compensation_insert'],
  ['public', 'profile_compensation', 'profile_compensation_update'],
  ['public', 'password_overrides_audit', 'password_overrides_audit_master_read'],
  ['public', 'policies', 'policies_ins'], ['public', 'policies', 'policies_upd'], ['public', 'policies', 'policies_del'],
  ['public', 'policy_versions', 'policy_versions_ins'], ['public', 'policy_versions', 'policy_versions_upd'],
  ['public', 'policy_versions', 'policy_versions_del'],
  ['public', 'policy_views', 'policy_views_select_own_or_admin'],
  ['public', 'audit_events', 'audit_events_select_master_owner'],
  ['public', 'fte_expense_claims', 'fte_expense_claims_read'],
  ['public', 'fte_expense_items', 'fte_expense_items_read'],
  ['public', 'inbound_invoices', 'inbound_invoices_read'],
  ['storage', 'objects', 'Owner reads org signed PDFs'],
  ['public', 'organizations', 'organizations_select'],
  ['public', 'contract_templates', 'contract_templates_write'],
  ['public', 'contracts', 'contracts_read'], ['public', 'contracts', 'contracts_insert'],
  ['public', 'contracts', 'contracts_update'], ['public', 'contracts', 'contracts_delete'],
  ['public', 'landing_page_settings', 'landing_page_settings_ins'],
  ['public', 'landing_page_settings', 'landing_page_settings_upd'],
  ['public', 'landing_page_settings', 'landing_page_settings_del'],
  ['public', 'glofox_invoices', 'glofox_invoices_select'],
  ['public', 'glofox_sync_runs', 'glofox_sync_runs_select'],
  ['public', 'glofox_push_events', 'glofox_push_events_select'],
  ['public', 'pipeline_classification_runs', 'pipeline_classification_runs_select'],
  ['public', 'car_bca_submissions', 'car_bca_submissions_read_at_location'],
  ['public', 'car_bca_submission_events', 'car_bca_submission_events_read_at_location'],
  ['public', 'chooser_settings', 'chooser_settings_ins'], ['public', 'chooser_settings', 'chooser_settings_upd'],
  ['public', 'chooser_settings', 'chooser_settings_del'],
  ['public', 'agent_knowledge', 'agent_knowledge_read'],
  ['public', 'channel_connections', 'channel_connections_select'],
  ['public', 'instagram_conversations', 'ig_conv_select'],
  ['public', 'instagram_messages', 'ig_msg_select'],
  ['public', 'glofox_memberships', 'glofox_memberships_select'],
  ['public', 'agent_membership_requests', 'agent_membership_requests_read'],
  ['public', 'org_settings', 'org_settings_select'], ['public', 'org_settings', 'org_settings_ins'],
  ['public', 'org_settings', 'org_settings_upd'], ['public', 'org_settings', 'org_settings_del'],
  ['public', 'contract_template_versions', 'contract_template_versions_read'],
  ['public', 'zoom_sync_runs', 'zoom_sync_runs_select'],
  ['public', 'cancellation_form_links', 'cancellation_form_links_select'],
]

// Unchanged helper-based policies installed too, to prove member + staff
// branches through the helpers (contacts, champ-app HR, mobile bookings).
const HELPER_POLICIES = [
  ['public', 'contacts', 'contacts_select'],
  ['public', 'heart_rate_sessions', 'heart_rate_sessions_read'],
  ['public', 'bookings', 'bookings_select'],
]

// ─── ids ──────────────────────────────────────────────────────────────────
const ORG_A = '0a000000-0000-0000-0000-00000000000a'
const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

const ACTIVE = '10000000-0000-0000-0000-000000000001'   // owner at A, active
const INACTIVE = '10000000-0000-0000-0000-000000000002' // owner at A, active=false, ALSO a member
const NULLACT = '10000000-0000-0000-0000-000000000003'  // owner at A, active IS NULL
const TOMB = '10000000-0000-0000-0000-000000000004'     // tombstone WITH stray access rows (mig 622 limit D)
const MASTER_ON = '10000000-0000-0000-0000-000000000005'
const MASTER_OFF = '10000000-0000-0000-0000-000000000006'
const MEMBER = '10000000-0000-0000-0000-000000000007'   // member-only login, no profile

const INACTIVE_CONTACT = 'c0000000-0000-0000-0000-000000000002'
const MEMBER_CONTACT = 'c0000000-0000-0000-0000-000000000007'
const OTHER_CONTACT = 'c0000000-0000-0000-0000-000000000009'
const MB1 = 'e0000000-0000-0000-0000-000000000001'
const T1 = 'e1000000-0000-0000-0000-000000000001'
const BRIDGE = 'f0000000-0000-0000-0000-000000000001'
const ROSTER_PUB = '20000000-0000-0000-0000-000000000001'
const OWN_CONTRACT = 'd0000000-0000-0000-0000-000000000002'
const ORG_CONTRACT = 'd0000000-0000-0000-0000-000000000001'
const TEMPLATE = 'd1000000-0000-0000-0000-000000000001'
const BCA = 'd2000000-0000-0000-0000-000000000001'

// ─── the real helper bodies, as the migrations last define them ─────────────
const HELPERS = [
  'auth_is_master', 'auth_role', 'auth_is_in_location', 'auth_is_owner_at', 'auth_is_admin_at',
  'auth_is_manager_at', 'auth_is_in_organization', 'get_user_role', 'get_user_role_at', 'auth_is_owner',
  'auth_is_owner_or_manager', 'auth_can_view_all_profiles', 'auth_is_admin_or_head_coach',
  'auth_contact_id', 'mobile_can_for', 'auth_mobile_can', 'auth_has_mailbox_grant',
  'auth_has_ticket_mailbox_grant', 'auth_is_manager_at_bridge', 'auth_can_read_shift_block',
  'auth_can_read_shift_assignment',
]

const migrationFiles = (before) => readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql') && parseInt(f, 10) < before)
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))

/** The last `CREATE OR REPLACE FUNCTION private.<name>(…) … $tag$…$tag$;` before `before`. */
function latestPrivateFunctionSql (name, before = 626) {
  let found = null
  for (const f of migrationFiles(before)) {
    const text = readFileSync(path.join(MIG_DIR, f), 'utf8')
    const re = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.${name}\s*\(`, 'gi')
    let m
    while ((m = re.exec(text))) {
      const rest = text.slice(m.index)
      const open = rest.match(/\$(\w*)\$/)
      const close = rest.indexOf(open[0], open.index + open[0].length)
      const end = rest.indexOf(';', close + open[0].length)
      found = { file: f, sql: rest.slice(0, end + 1) }
    }
  }
  if (!found) throw new Error(`no migration defines private.${name}`)
  return found
}

function netPolicySql (list) {
  const byKey = new Map(netPolicyState(MIG_DIR, { before: 626 }).map((p) => [`${p.table}|${p.name}`, p]))
  return list.map(([s, t, n]) => {
    const p = byKey.get(`${s}.${t}|${n}`)
    if (!p) throw new Error(`net state has no policy ${s}.${t} :: ${n}`)
    return `CREATE POLICY "${n}" ON ${s}.${t} ${p.body};`
  }).join('\n')
}

const locTables = ['landing_page_settings', 'glofox_invoices', 'glofox_sync_runs', 'glofox_push_events',
  'pipeline_classification_runs', 'agent_knowledge', 'channel_connections', 'instagram_conversations',
  'instagram_messages', 'glofox_memberships', 'agent_membership_requests', 'cancellation_form_links',
  'inbound_invoices', 'bookings']
const orgTables = ['chooser_settings', 'org_settings', 'zoom_sync_runs']

const BASE_SCHEMA = `
  SET check_function_bodies = off;
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA storage;
  GRANT USAGE ON SCHEMA auth, public, storage TO authenticated, anon;
  GRANT USAGE ON SCHEMA private TO authenticated;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations(id), features jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'staff', active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id),
    role text NOT NULL, permissions jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.profile_organizations (profile_id uuid REFERENCES public.profiles(id), organization_id uuid REFERENCES public.organizations(id),
    role text NOT NULL DEFAULT 'org_admin', PRIMARY KEY (profile_id, organization_id));
  CREATE TABLE public.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, user_id uuid);
  CREATE TABLE public.heart_rate_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, location_id uuid);
  CREATE TABLE public.email_mailbox_access (mailbox_id uuid, profile_id uuid);
  CREATE TABLE public.email_tickets (id uuid PRIMARY KEY, mailbox_id uuid);
  CREATE TABLE public.ble_bridges (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text);
  CREATE TABLE public.shift_blocks (id uuid PRIMARY KEY, location_id uuid, roster_id uuid);
  CREATE TABLE private.mobile_permission_defaults (role text, key text, allowed boolean, PRIMARY KEY (role, key));
  CREATE TABLE private.permission_key_bundles (key text, bundle text, PRIMARY KEY (key, bundle));

  CREATE TABLE public.profile_compensation (profile_id uuid);
  CREATE TABLE public.password_overrides_audit (id serial PRIMARY KEY);
  CREATE TABLE public.policies (id serial PRIMARY KEY);
  CREATE TABLE public.policy_versions (id serial PRIMARY KEY);
  CREATE TABLE public.policy_views (id serial PRIMARY KEY, profile_id uuid);
  CREATE TABLE public.audit_events (id serial PRIMARY KEY);
  CREATE TABLE public.fte_expense_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid, location_id uuid);
  CREATE TABLE public.fte_expense_items (id serial PRIMARY KEY, claim_id uuid);
  CREATE TABLE public.contracts (id uuid PRIMARY KEY, organization_id uuid, profile_id uuid);
  CREATE TABLE public.contract_templates (id uuid PRIMARY KEY, organization_id uuid);
  CREATE TABLE public.contract_template_versions (id serial PRIMARY KEY, template_id uuid);
  CREATE TABLE public.car_bca_submissions (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.car_bca_submission_events (id serial PRIMARY KEY, submission_id uuid);
  ${locTables.map((t) => `CREATE TABLE public.${t} (id serial PRIMARY KEY, location_id uuid);`).join('\n  ')}
  ${orgTables.map((t) => `CREATE TABLE public.${t} (id serial PRIMARY KEY, organization_id uuid);`).join('\n  ')}

  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  GRANT EXECUTE ON FUNCTION storage.foldername(text) TO authenticated, anon;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, storage TO authenticated;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
  -- Prod: no SELECT on profiles for the browser roles (mig 153b), no writes (mig 622).
  REVOKE ALL ON public.profiles FROM authenticated, anon;

  -- is_owner(): out-of-band on prod; mig 549 documents role IN (owner, master).
  CREATE FUNCTION public.is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('owner', 'master'))
  $$;
  ALTER FUNCTION public.is_owner() SET SCHEMA private;
`

const PROD_BRANDING = `
  CREATE POLICY "Owners can upload branding" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'branding' AND private.is_owner());
  CREATE POLICY "Owners can update branding" ON storage.objects FOR UPDATE USING (bucket_id = 'branding' AND private.is_owner());
  CREATE POLICY "Owners can delete branding" ON storage.objects FOR DELETE USING (bucket_id = 'branding' AND private.is_owner());
`

const rlsTables = [...new Set([...GATED_POLICIES, ...HELPER_POLICIES].map(([s, t]) => `${s}.${t}`))]

const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG_A}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG_A}', '{}'), ('${LOC_B}', '${ORG_A}', '{}');
  INSERT INTO public.profiles (id, role, active, deleted_at) VALUES
    ('${ACTIVE}', 'owner', true, NULL), ('${INACTIVE}', 'owner', false, NULL), ('${NULLACT}', 'owner', NULL, NULL),
    ('${TOMB}', 'staff', false, now()), ('${MASTER_ON}', 'master', true, NULL), ('${MASTER_OFF}', 'master', false, NULL);
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES
    ('${ACTIVE}', '${LOC_A}', 'owner'), ('${INACTIVE}', '${LOC_A}', 'owner'),
    ('${NULLACT}', '${LOC_A}', 'owner'), ('${TOMB}', '${LOC_A}', 'owner');
  INSERT INTO public.profile_organizations (profile_id, organization_id) VALUES
    ('${ACTIVE}', '${ORG_A}'), ('${INACTIVE}', '${ORG_A}'), ('${NULLACT}', '${ORG_A}'), ('${TOMB}', '${ORG_A}');
  INSERT INTO public.email_tickets VALUES ('${T1}', '${MB1}');
  INSERT INTO public.email_mailbox_access VALUES ('${MB1}', '${ACTIVE}'), ('${MB1}', '${INACTIVE}'), ('${MB1}', '${NULLACT}'), ('${MB1}', '${TOMB}');
  INSERT INTO public.ble_bridges VALUES ('${BRIDGE}', '${LOC_A}');
  INSERT INTO public.rosters VALUES ('${ROSTER_PUB}', 'published');
  INSERT INTO private.mobile_permission_defaults VALUES ('owner', 'bookings', true);
  INSERT INTO private.permission_key_bundles VALUES ('bookings', 'bundle_members');

  INSERT INTO public.contacts (id, location_id, user_id) VALUES
    ('${INACTIVE_CONTACT}', '${LOC_A}', '${INACTIVE}'), ('${MEMBER_CONTACT}', '${LOC_A}', '${MEMBER}'),
    ('${OTHER_CONTACT}', '${LOC_A}', NULL);
  INSERT INTO public.heart_rate_sessions (contact_id, location_id) VALUES
    ('${INACTIVE_CONTACT}', '${LOC_A}'), ('${MEMBER_CONTACT}', '${LOC_A}'), ('${OTHER_CONTACT}', '${LOC_A}');

  ${locTables.map((t) => `INSERT INTO public.${t} (location_id) VALUES ('${LOC_A}');`).join('\n  ')}
  ${orgTables.map((t) => `INSERT INTO public.${t} (organization_id) VALUES ('${ORG_A}');`).join('\n  ')}
  INSERT INTO public.contracts VALUES ('${ORG_CONTRACT}', '${ORG_A}', '${ACTIVE}'), ('${OWN_CONTRACT}', '${ORG_A}', '${INACTIVE}');
  INSERT INTO public.contract_templates VALUES ('${TEMPLATE}', '${ORG_A}');
  INSERT INTO public.contract_template_versions (template_id) VALUES ('${TEMPLATE}');
  INSERT INTO public.car_bca_submissions VALUES ('${BCA}', '${LOC_A}');
  INSERT INTO public.car_bca_submission_events (submission_id) VALUES ('${BCA}');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('contracts', '${ORG_CONTRACT}/signed.pdf');
`

/** The state 626 lands on: schema, helpers from the migrations, net-state policies, seed. */
async function buildPre626 (pg) {
  const run = (text) => pg.exec(text)
  await run(BASE_SCHEMA)
  for (const name of HELPERS) await run(latestPrivateFunctionSql(name).sql)
  await run('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;')
  await run(rlsTables.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n'))
  await run(netPolicySql([...GATED_POLICIES, ...HELPER_POLICIES]))
  await run(PROD_BRANDING)
  await run(SEED)
  await run('RESET check_function_bodies;')
}

let db
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx. */
async function asUser (uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
const scalar = async (uid, expr) => (await asUser(uid, `SELECT ${expr} AS v`))[0].v
const truthy = async (uid, expr) => (await scalar(uid, `coalesce((${expr})::boolean, false)`)) === true
const count = async (uid, sql) => Number((await asUser(uid, `SELECT count(*)::int AS n FROM (${sql}) q`))[0].n)

// Staff-authority expressions that are TRUE for an owner at LOC_A before 626.
const OWNER_HELPERS = [
  `private.auth_is_in_location('${LOC_A}')`,
  `private.auth_is_owner_at('${LOC_A}')`,
  `private.auth_is_admin_at('${LOC_A}')`,
  `private.auth_is_manager_at('${LOC_A}')`,
  `private.auth_is_in_organization('${ORG_A}')`,
  `private.auth_role() = 'owner'`,
  'private.auth_is_owner()',
  'private.auth_is_owner_or_manager()',
  'private.auth_can_view_all_profiles()',
  'private.auth_is_admin_or_head_coach()',
  'private.is_owner()',
  `private.auth_has_mailbox_grant('${MB1}')`,
  `private.auth_has_ticket_mailbox_grant('${T1}')`,
  `private.auth_mobile_can('${LOC_A}', 'bookings')`,
  `private.auth_is_manager_at_bridge('${BRIDGE}')`,
  `private.auth_can_read_shift_block('${LOC_A}', '${ROSTER_PUB}')`,
]
// Of those, the ones a tombstone (role 'staff' + stray access rows) passed before 626.
const TOMB_LEAKS = OWNER_HELPERS.filter((e) => !/auth_can_view_all_profiles|admin_or_head_coach|is_owner\(\)$/.test(e))

// SELECT reads the gated policies grant an owner at LOC_A / ORG_A.
const STAFF_READS = {
  organizations: 'SELECT id FROM public.organizations',
  contract_templates: 'SELECT id FROM public.contract_templates',
  contracts_org: `SELECT id FROM public.contracts WHERE id = '${ORG_CONTRACT}'`,
  contract_template_versions: 'SELECT id FROM public.contract_template_versions',
  car_bca_submissions: 'SELECT id FROM public.car_bca_submissions',
  car_bca_submission_events: 'SELECT id FROM public.car_bca_submission_events',
  signed_pdfs: `SELECT id FROM storage.objects WHERE bucket_id = 'contracts'`,
  staff_contacts: `SELECT id FROM public.contacts WHERE id = '${OTHER_CONTACT}'`,
  others_hr_sessions: `SELECT id FROM public.heart_rate_sessions WHERE contact_id = '${OTHER_CONTACT}'`,
  ...Object.fromEntries([...locTables, ...orgTables].map((t) => [t, `SELECT id FROM public.${t}`])),
}
delete STAFF_READS.landing_page_settings // write-only policies (no SELECT policy installed)
delete STAFF_READS.inbound_invoices      // reads profiles inline: errors for authenticated (asserted below)
delete STAFF_READS.chooser_settings      // write policies only here (its SELECT policy uses the helpers)

beforeAll(async () => {
  db = new PGlite()
  await buildPre626(db)
}, 120_000)

afterAll(async () => { await db?.close() })

describe('the replayed pre-626 state is the real one', () => {
  it('extracts every helper from the migration that last defines it', () => {
    expect(latestPrivateFunctionSql('auth_is_in_organization').file).toMatch(/^417_/)
    expect(latestPrivateFunctionSql('auth_mobile_can').file).toMatch(/^550_/)
    expect(latestPrivateFunctionSql('auth_is_manager_at_bridge').file).toMatch(/^618_/)
    expect(latestPrivateFunctionSql('auth_is_master').file).toMatch(/^051_/)
  })

  it('the 626 file re-creates exactly the policies this test replays', () => {
    const created = [...MIG_626.replace(/--.*$/gm, '').matchAll(/CREATE POLICY\s+("[^"]+"|\w+)\s+ON\s+([\w.]+)/g)]
      .map(([, n, t]) => `${t.includes('.') ? t : `public.${t}`} :: ${n.replace(/"/g, '')}`).sort()
    expect(created).toEqual(GATED_POLICIES.map(([s, t, n]) => `${s}.${t} :: ${n}`).sort())
  })
})

describe('before 626 — the leak is real (guards against a vacuous pass)', () => {
  it('an INACTIVE owner still passes every staff helper', async () => {
    for (const e of OWNER_HELPERS) expect(await truthy(INACTIVE, e), e).toBe(true)
  })
  it('a TOMBSTONE with stray access rows passes the location helpers', async () => {
    for (const e of TOMB_LEAKS) expect(await truthy(TOMB, e), e).toBe(true)
  })
  it('an INACTIVE master is still a master', async () => {
    expect(await truthy(MASTER_OFF, 'private.auth_is_master()')).toBe(true)
  })
  it('an INACTIVE owner reads studio data through the policies', async () => {
    for (const [k, sql] of Object.entries(STAFF_READS)) expect(await count(INACTIVE, sql), k).toBeGreaterThan(0)
  })
  it('the p_user_id helpers answer for an inactive user', async () => {
    expect(await scalar(ACTIVE, `private.get_user_role('${INACTIVE}')`)).toBe('owner')
    expect(await truthy(ACTIVE, `private.mobile_can_for('${INACTIVE}', '${LOC_A}', 'bookings')`)).toBe(true)
  })
})

describe('after 626', () => {
  let shapeBefore
  const shape = async () => (await db.query(`
    SELECT schemaname, tablename, policyname, cmd, roles::text, permissive
      FROM pg_policies ORDER BY 1, 2, 3`)).rows

  beforeAll(async () => {
    shapeBefore = await shape()
    await runSql(MIG_626)
  }, 60_000)

  it('keeps every policy\'s command, roles and PERMISSIVE — and the set of policies', async () => {
    expect(await shape()).toEqual(shapeBefore)
  })

  describe('staff helpers', () => {
    it('ACTIVE and NULL-active owners: every helper still true', async () => {
      for (const uid of [ACTIVE, NULLACT]) {
        for (const e of OWNER_HELPERS) expect(await truthy(uid, e), `${uid} ${e}`).toBe(true)
        expect(await truthy(uid, 'private.auth_is_active_staff()')).toBe(true)
      }
    })
    it('INACTIVE owner and TOMBSTONE: every helper false', async () => {
      for (const uid of [INACTIVE, TOMB]) {
        for (const e of OWNER_HELPERS) expect(await truthy(uid, e), `${uid} ${e}`).toBe(false)
        expect(await truthy(uid, 'private.auth_is_active_staff()')).toBe(false)
        expect(await scalar(uid, 'private.auth_role()')).toBeNull()
      }
    })
    it('masters: an active one is master everywhere, an inactive one nowhere', async () => {
      expect(await truthy(MASTER_ON, 'private.auth_is_master()')).toBe(true)
      expect(await truthy(MASTER_ON, `private.auth_is_in_location('${LOC_B}')`)).toBe(true)
      expect(await truthy(MASTER_ON, `private.auth_is_manager_at('${LOC_B}')`)).toBe(true)
      expect(await scalar(MASTER_ON, 'private.auth_role()')).toBe('master')
      expect(await truthy(MASTER_OFF, 'private.auth_is_master()')).toBe(false)
      expect(await truthy(MASTER_OFF, `private.auth_is_in_location('${LOC_B}')`)).toBe(false)
      expect(await scalar(MASTER_OFF, 'private.auth_role()')).toBeNull()
    })
    it('a MEMBER-only login: every staff helper false, as before', async () => {
      for (const e of [...OWNER_HELPERS, 'private.auth_is_master()', 'private.auth_is_active_staff()']) {
        expect(await truthy(MEMBER, e), e).toBe(false)
      }
    })
    it('NULL location / org arguments stay false', async () => {
      expect(await truthy(ACTIVE, 'private.auth_is_in_location(NULL)')).toBe(false)
      expect(await truthy(ACTIVE, 'private.auth_is_in_organization(NULL)')).toBe(false)
      expect(await truthy(MASTER_ON, 'private.auth_is_in_location(NULL)')).toBe(false)
    })
  })

  describe('the p_user_id helpers judge THAT user, not the caller', () => {
    it('get_user_role / get_user_role_at / mobile_can_for', async () => {
      expect(await scalar(ACTIVE, `private.get_user_role('${INACTIVE}')`)).toBeNull()
      expect(await scalar(ACTIVE, `private.get_user_role('${TOMB}')`)).toBeNull()
      expect(await scalar(ACTIVE, `private.get_user_role('${NULLACT}')`)).toBe('owner')
      expect(await scalar(ACTIVE, `private.get_user_role_at('${INACTIVE}', '${LOC_A}')`)).toBeNull()
      expect(await scalar(ACTIVE, `private.get_user_role_at('${ACTIVE}', '${LOC_A}')`)).toBe('owner')
      expect(await truthy(ACTIVE, `private.mobile_can_for('${INACTIVE}', '${LOC_A}', 'bookings')`)).toBe(false)
      expect(await truthy(ACTIVE, `private.mobile_can_for('${ACTIVE}', '${LOC_A}', 'bookings')`)).toBe(true)
      // …and an inactive CALLER still gets the truth about an active user.
      expect(await scalar(INACTIVE, `private.get_user_role('${ACTIVE}')`)).toBe('owner')
      expect(await truthy(INACTIVE, `private.mobile_can_for('${ACTIVE}', '${LOC_A}', 'bookings')`)).toBe(true)
    })
  })

  describe('member authority is untouched', () => {
    it('auth_contact_id() still resolves for the deactivated coach and for a member', async () => {
      expect(await scalar(INACTIVE, 'private.auth_contact_id()')).toBe(INACTIVE_CONTACT)
      expect(await scalar(MEMBER, 'private.auth_contact_id()')).toBe(MEMBER_CONTACT)
    })
    it('the deactivated coach keeps every MEMBER read', async () => {
      expect(await count(INACTIVE, `SELECT id FROM public.contacts WHERE user_id = '${INACTIVE}'`)).toBe(1)
      expect(await count(INACTIVE, `SELECT id FROM public.heart_rate_sessions WHERE contact_id = '${INACTIVE_CONTACT}'`)).toBe(1)
      expect(await count(MEMBER, `SELECT id FROM public.contacts WHERE user_id = '${MEMBER}'`)).toBe(1)
      expect(await count(MEMBER, 'SELECT id FROM public.heart_rate_sessions')).toBe(1)
    })
    it('and keeps own-row (subject) reads: their own contract', async () => {
      expect(await count(INACTIVE, `SELECT id FROM public.contracts WHERE id = '${OWN_CONTRACT}'`)).toBe(1)
    })
  })

  describe('policies', () => {
    it('the deactivated coach reads NO staff data through any re-created policy', async () => {
      for (const [k, sql] of Object.entries(STAFF_READS)) expect(await count(INACTIVE, sql), k).toBe(0)
      expect(await count(INACTIVE, `SELECT id FROM public.contacts WHERE user_id IS DISTINCT FROM '${INACTIVE}'`)).toBe(0)
      expect(await count(INACTIVE, 'SELECT id FROM public.heart_rate_sessions')).toBe(1) // own only
    })
    it('nor does a tombstone with stray access rows', async () => {
      for (const [k, sql] of Object.entries(STAFF_READS)) expect(await count(TOMB, sql), k).toBe(0)
    })
    it('active and NULL-active owners read exactly what they read before', async () => {
      for (const uid of [ACTIVE, NULLACT]) {
        for (const [k, sql] of Object.entries(STAFF_READS)) expect(await count(uid, sql), `${uid} ${k}`).toBe(1)
      }
    })
    it('writes are gated too: an inactive owner cannot update org_settings or insert a chooser row', async () => {
      const upd = async (uid) => (await asUser(uid, 'UPDATE public.org_settings SET organization_id = organization_id RETURNING id')).length
      expect(await upd(ACTIVE)).toBe(1)
      expect(await upd(INACTIVE)).toBe(0)
      await expect(asUser(INACTIVE, `INSERT INTO public.chooser_settings (organization_id) VALUES ('${ORG_A}')`))
        .rejects.toThrow(/row-level security/)
      await asUser(ACTIVE, `INSERT INTO public.chooser_settings (organization_id) VALUES ('${ORG_A}')`)
    })
    it('policies that read public.profiles inline still ERROR for authenticated (no SELECT on profiles, mig 153b) — fail-closed as before', async () => {
      await expect(count(ACTIVE, 'SELECT id FROM public.audit_events')).rejects.toThrow(/permission denied for table profiles/)
      await expect(count(INACTIVE, 'SELECT id FROM public.inbound_invoices')).rejects.toThrow(/permission denied for table profiles/)
    })
  })

  it('grants: auth_is_active_staff is executable by authenticated, not anon', async () => {
    const one = async (sql) => (await db.query(sql)).rows[0].v
    expect(await one(`SELECT has_function_privilege('authenticated', 'private.auth_is_active_staff()', 'EXECUTE') AS v`)).toBe(true)
    expect(await one(`SELECT has_function_privilege('anon', 'private.auth_is_active_staff()', 'EXECUTE') AS v`)).toBe(false)
  })
})

describe('mig 626 — all or nothing', () => {
  it('wraps itself in one explicit transaction', () => {
    const sql = MIG_626.replace(/--.*$/gm, '')
    expect(sql.match(/^\s*BEGIN;\s*$/gm)).toHaveLength(1)
    expect(sql.match(/^\s*COMMIT;\s*$/gm)).toHaveLength(1)
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  async function expectAbort (setup, message) {
    const fresh = new PGlite()
    const run = (text) => fresh.exec(text)
    try {
      await buildPre626(fresh)
      await run(setup)
      await expect(run(MIG_626)).rejects.toThrow(message)
      await run('ROLLBACK') // what any client does after a failed transaction
      const left = (await fresh.query(`SELECT to_regprocedure('private.auth_is_active_staff()') IS NULL AS gone,
        (SELECT prosrc !~* 'active' FROM pg_proc WHERE oid = 'private.auth_is_master()'::regprocedure) AS master_untouched`)).rows[0]
      expect(left).toEqual({ gone: true, master_untouched: true })
    } finally {
      await fresh.close()
    }
  }

  it('an ungated inline policy anywhere (e.g. one that exists only on prod) aborts the whole file', async () => {
    await expectAbort(`CREATE POLICY rogue_prod_only ON public.agent_knowledge FOR UPDATE TO authenticated
      USING (EXISTS (SELECT 1 FROM profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())));`,
    /ungated inline policy public\.agent_knowledge :: rogue_prod_only/)
  }, 120_000)

  it('an is_owner() that is not the documented shape aborts the whole file', async () => {
    await expectAbort(`CREATE OR REPLACE FUNCTION private.is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM profile_locations WHERE profile_id = auth.uid() AND role = 'owner') $$;`,
    /is_owner\(\) is not the shape mig 549 documents/)
  }, 120_000)
})
