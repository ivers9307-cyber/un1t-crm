// ORGCONTACTS.4 — behavioural test for migration 766: contact_location_audience
// (the send-path read surface) gains the per-studio stage from contact_studios.
//
// Models prod after mig 712 (the view's 111 columns: 689's list as 705 and 712
// extended it, read from the 712 file's own SELECT so nothing is transcribed; security_invoker; closed to clients by
// 662/677) plus contact_studios as mig 764 left it, then runs the REAL 766
// file and proves:
//   * the 107 columns are unchanged and in order; studio_stage_slug,
//     studio_kind and studio_status are appended at the end, type text;
//   * a preferences row at a studio where the person has no contact_studios
//     row is KEPT (LEFT JOIN) with a NULL studio stage (Review Focus 4), and a
//     row where they have one carries THAT studio's stage, not the primary's;
//   * OID, owner, comment, security_invoker and the ACL are unchanged; no
//     client role can read the view; a second run changes nothing;
//   * the file refuses to run without contact_studios, when a client role
//     holds anything on the view, or without WITH (security_invoker = on).
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_712 = readFileSync(path.join(MIG_DIR, '712_contacts_organization_email_unique.sql'), 'utf8')
const MIG_766 = readFileSync(path.join(MIG_DIR, '766_audience_view_studio_stage.sql'), 'utf8')

// The view's SELECT list exactly as 712 wrote it (111 columns in the live order).
function select712() {
  const head = 'CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS'
  const i = MIG_712.indexOf(head)
  const j = MIG_712.indexOf('FROM public.contacts c', i)
  if (i < 0 || j < 0) throw new Error('712 view statement not found')
  return MIG_712.slice(i + head.length, j).replace(/^\s*SELECT/, '').trim()
}
const SELECT_712 = select712()
const CONTACT_COLS = [...SELECT_712.matchAll(/\bc\.([a-z0-9_]+)/g)].map((m) => m[1])
const COLS_712 = SELECT_712.split(',').map((s) => s.trim()).map((s) => (s.match(/AS\s+(\w+)$/) || [, s.replace(/^c\./, '')])[1])
const NEW_COLS = [['studio_stage_slug', 'text'], ['studio_kind', 'text'], ['studio_status', 'text']]
const AFTER = [...COLS_712, ...NEW_COLS.map(([c]) => c)]

const colType = (c) => (c === 'id' ? 'uuid PRIMARY KEY'
  : ['location_id', 'user_id', 'organization_id'].includes(c) ? 'uuid'
  : c === 'email_marketing' ? 'boolean NOT NULL DEFAULT true'
  : c === 'tags' ? 'text[]'
  : c === 'created_at' ? 'timestamptz DEFAULT now()'
  : 'text')
const COMMENT = 'LOCCOMMS.3 — send-path read surface. Filter audience_location_id + loc_*_marketing. A view rather than a PostgREST embed because embedded-resource filters silently break head:true counts (CLASSIFY.1).'

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const ORG = 'f0000000-0000-0000-0000-000000000001'
const STAFF = '10000000-0000-0000-0000-000000000001'
const C1 = '30000000-0000-0000-0000-000000000001'
const C2 = '30000000-0000-0000-0000-000000000002'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public, private TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations(id));
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.contacts (${CONTACT_COLS.map((c) => `${c} ${colType(c)}`).join(', ')});
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid, location_id uuid, email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true, whatsapp_marketing boolean NOT NULL DEFAULT true, source text
  );
  GRANT SELECT ON public.contacts TO authenticated;
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.contact_location_preferences ENABLE ROW LEVEL SECURITY;

  -- the view as mig 712 left it, closed by 662/677
  CREATE VIEW public.contact_location_audience WITH (security_invoker = on) AS
    SELECT ${SELECT_712}
      FROM public.contacts c JOIN public.contact_location_preferences clp ON clp.contact_id = c.id;
  REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;
  COMMENT ON VIEW public.contact_location_audience IS '${COMMENT}';
`
// contact_studios as mig 764 left it (the columns 766 reads, same types and checks).
const CONTACT_STUDIOS = `
  CREATE TABLE public.contact_studios (
    contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    kind text NOT NULL CHECK (kind IN ('member', 'client', 'lead')),
    status text NOT NULL CHECK (status IN ('active', 'ended')),
    source text NOT NULL,
    stage_slug text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz, ended_at timestamptz,
    PRIMARY KEY (contact_id, location_id)
  );
  ALTER TABLE public.contact_studios ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.contact_studios FROM PUBLIC, anon, authenticated;
`
const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG}'), ('${LOC_B}', '${ORG}');
  INSERT INTO public.profiles (id, role) VALUES ('${STAFF}', 'staff');
  -- C1: primary A, dormant contact-wide; on A's and B's lists; a relationship row at A only.
  INSERT INTO public.contacts (id, name, email, location_id, pipeline_stage_slug) VALUES
    ('${C1}', 'Synth One', 'one@example.test', '${LOC_A}', 'dormant'),
    ('${C2}', 'Synth Two', 'two@example.test', '${LOC_B}', 'member');
  INSERT INTO public.contact_location_preferences (contact_id, location_id) VALUES
    ('${C1}', '${LOC_A}'), ('${C1}', '${LOC_B}'), ('${C2}', '${LOC_B}'), ('${C2}', '${LOC_A}');
  INSERT INTO public.contact_studios (contact_id, location_id, organization_id, kind, status, source, stage_slug) VALUES
    ('${C1}', '${LOC_A}', '${ORG}', 'member', 'ended', 'glofox', 'dormant'),
    ('${C2}', '${LOC_B}', '${ORG}', 'member', 'active', 'un1t_online', 'member'),
    ('${C2}', '${LOC_A}', '${ORG}', 'lead', 'active', 'lead_form', 'new_lead');
`

let db
const runSql = (text) => db['exec'](text)
async function asRole(role, sql, sub = null) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally { await runSql('ROLLBACK') }
}
async function viewCols() {
  const { rows } = await db.query(`SELECT attname, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
    WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)
  return rows
}
async function aclItems(rel) {
  const { rows } = await db.query(`
    SELECT coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || ':' || a.is_grantable || ':' || g.rolname AS item
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee JOIN pg_roles g ON g.oid = a.grantor
     WHERE c.oid = $1::regclass ORDER BY 1`, [rel])
  return rows.map((r) => r.item)
}
async function viewState() {
  const { rows: [r] } = await db.query(`SELECT oid::int AS oid, reloptions::text AS opts,
      pg_get_userbyid(relowner) AS owner, obj_description(oid, 'pg_class') AS comment
    FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass`)
  return { ...r, acl: await aclItems('public.contact_location_audience') }
}
async function abortMessage(sql) {
  try { await runSql(sql); return null } catch (e) { await runSql('ROLLBACK'); return String(e.message || e) }
}
async function boot({ studios = true, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  if (studios) await runSql(CONTACT_STUDIOS)
  await runSql(studios ? SEED : SEED.replace(/INSERT INTO public\.contact_studios[\s\S]*?;\n/, ''))
  if (before) await runSql(before)
}
const STAGE_AT = `SELECT id, audience_location_id AS loc, pipeline_stage_slug AS contact_wide, studio_stage_slug, studio_kind, studio_status
  FROM public.contact_location_audience ORDER BY id, audience_location_id`

describe('before 766', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the model is the 111-column view mig 712 left (not vacuous)', async () => {
    expect(COLS_712).toHaveLength(111)
    expect(COLS_712.slice(-1)).toEqual(['organization_id'])
    expect((await viewCols()).map((r) => r.attname)).toEqual(COLS_712)
  })

  it('an audience filtered on the studio stage fails (the column does not exist)', async () => {
    await expect(asRole('service_role', STAGE_AT)).rejects.toThrow(/column "studio_stage_slug" does not exist/)
  })
})

describe('after 766', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = { view: await viewState(), contactsAcl: await aclItems('public.contacts') }
    await runSql(MIG_766)
  }, 60_000)
  afterAll(() => db?.close())

  it('the 712 columns are unchanged and in order; three new columns at the end', async () => {
    const cols = await viewCols()
    expect(cols.map((r) => r.attname)).toEqual(AFTER)
    expect(cols.slice(COLS_712.length).map((r) => [r.attname, r.typ])).toEqual(NEW_COLS)
  })

  it('a Hatch preferences row with a Stillorgan stage and no Hatch row: studio_stage_slug NULL, row kept', async () => {
    const rows = await asRole('service_role', STAGE_AT)
    expect(rows).toEqual([
      { id: C1, loc: LOC_A, contact_wide: 'dormant', studio_stage_slug: 'dormant', studio_kind: 'member', studio_status: 'ended' },
      { id: C1, loc: LOC_B, contact_wide: 'dormant', studio_stage_slug: null, studio_kind: null, studio_status: null },
      { id: C2, loc: LOC_A, contact_wide: 'member', studio_stage_slug: 'new_lead', studio_kind: 'lead', studio_status: 'active' },
      { id: C2, loc: LOC_B, contact_wide: 'member', studio_stage_slug: 'member', studio_kind: 'member', studio_status: 'active' },
    ])
  })

  it('security_invoker on; closed to clients; OID, owner, comment and ACL as before; contacts ACL untouched', async () => {
    const s = await viewState()
    expect(s).toEqual(before.view)
    expect(s.opts).toBe('{security_invoker=on}')
    expect(s.acl.every((i) => i.startsWith('postgres:') || i.startsWith('service_role:'))).toBe(true)
    expect(await aclItems('public.contacts')).toEqual(before.contactsAcl)
    await expect(asRole('authenticated', 'SELECT id FROM public.contact_location_audience', STAFF))
      .rejects.toThrow(/permission denied for (view|table|relation) contact_location_audience/)
    await expect(asRole('anon', 'SELECT id FROM public.contact_location_audience'))
      .rejects.toThrow(/permission denied for (view|table|relation) contact_location_audience/)
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    const s = await viewState()
    await expect(runSql(MIG_766)).resolves.toBeDefined()
    expect((await viewCols()).map((r) => r.attname)).toEqual(AFTER)
    expect(await viewState()).toEqual(s)
  })
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })

  it('without contact_studios (mig 764 not applied)', async () => {
    await boot({ studios: false })
    expect(await abortMessage(MIG_766)).toMatch(/mig 766: apply 764_contact_studios first/)
    expect((await viewCols()).map((r) => r.attname)).toEqual(COLS_712)
  }, 60_000)

  it('when a client role holds anything on the view', async () => {
    await boot({ before: 'GRANT SELECT ON public.contact_location_audience TO authenticated;' })
    expect(await abortMessage(MIG_766)).toMatch(/mig 766: a client role holds a privilege on contact_location_audience/)
    expect((await viewCols()).map((r) => r.attname)).toEqual(COLS_712)
  }, 60_000)

  it('the OR REPLACE trap: without WITH (security_invoker = on) the self-check refuses', async () => {
    await boot()
    const trapped = MIG_766.replace(/ WITH \(security_invoker = on\) AS/, ' AS')
    expect(trapped).not.toBe(MIG_766)
    expect(await abortMessage(trapped)).toMatch(/mig 766: contact_location_audience lost security_invoker/)
    expect((await viewState()).opts).toBe('{security_invoker=on}')
  }, 60_000)
})
