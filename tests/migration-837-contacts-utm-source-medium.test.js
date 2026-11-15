// UTMSOURCE.1 — behavioural test for migration 837: contacts gains utm_source
// and utm_medium, and contact_location_audience (the send-path read surface)
// gets both appended.
//
// Models prod after mig 766 (the view's 114 columns, read from the 766 file's
// own SELECT so nothing is transcribed; security_invoker; closed to clients by
// 662/677; contacts with table-level SELECT for authenticated), then runs the
// REAL 837 file and proves:
//   * contacts has both columns, nullable text, and its ACL is unchanged
//     (authenticated reads them through the table grant, anon reads nothing);
//   * the view's 114 columns are unchanged and in order, the two appended;
//   * OID, owner, comment, security_invoker and the view ACL are unchanged; no
//     client role can read the view; a second run changes nothing;
//   * the file refuses to run when a client role holds anything on the view,
//     or without WITH (security_invoker = on), and leaves no column behind.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_DIR = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_766 = readFileSync(path.join(MIG_DIR, '766_audience_view_studio_stage.sql'), 'utf8')
const MIG_837 = readFileSync(path.join(MIG_DIR, '837_contacts_utm_source_medium.sql'), 'utf8')

const HEAD = 'CREATE OR REPLACE VIEW public.contact_location_audience WITH (security_invoker = on) AS'
function viewStatement(sql) {
  const i = sql.indexOf(HEAD)
  const j = sql.indexOf(';', i)
  if (i < 0 || j < 0) throw new Error('view statement not found')
  return sql.slice(i, j + 1)
}
function selectList(sql) {
  const stmt = viewStatement(sql)
  return stmt.slice(HEAD.length, stmt.indexOf('FROM public.contacts c')).replace(/^\s*SELECT/, '').trim()
}
const colsOf = (list) => list.split(',').map((s) => s.trim()).map((s) => (s.match(/AS\s+(\w+)$/) || [null, s.replace(/^c\./, '')])[1])
const SELECT_766 = selectList(MIG_766)
const COLS_766 = colsOf(SELECT_766)
const CONTACT_COLS = [...SELECT_766.matchAll(/\bc\.([a-z0-9_]+)/g)].map((m) => m[1])
const NEW_COLS = [['utm_source', 'text'], ['utm_medium', 'text']]
const AFTER = [...COLS_766, ...NEW_COLS.map(([c]) => c)]

const colType = (c) => (c === 'id' ? 'uuid PRIMARY KEY'
  : ['location_id', 'user_id', 'organization_id'].includes(c) ? 'uuid'
  : c === 'email_marketing' ? 'boolean NOT NULL DEFAULT true'
  : c === 'tags' ? 'text[]'
  : 'text')
const COMMENT = 'LOCCOMMS.3 — send-path read surface.'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const C1 = '30000000-0000-0000-0000-000000000001'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

  CREATE TABLE public.contacts (${CONTACT_COLS.map((c) => `${c} ${colType(c)}`).join(', ')});
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid, location_id uuid, email_marketing boolean NOT NULL DEFAULT true,
    sms_marketing boolean NOT NULL DEFAULT true, whatsapp_marketing boolean NOT NULL DEFAULT true
  );
  CREATE TABLE public.contact_studios (
    contact_id uuid NOT NULL, location_id uuid NOT NULL, kind text, status text, stage_slug text,
    PRIMARY KEY (contact_id, location_id)
  );
  GRANT SELECT ON public.contacts TO authenticated;
  REVOKE ALL ON public.contact_studios, public.contact_location_preferences FROM PUBLIC, anon, authenticated;

  -- the view as mig 766 left it, closed by 662/677
  ${viewStatement(MIG_766).replace('CREATE OR REPLACE VIEW', 'CREATE VIEW')}
  REVOKE ALL ON public.contact_location_audience FROM anon, authenticated, PUBLIC;
  COMMENT ON VIEW public.contact_location_audience IS '${COMMENT}';

  INSERT INTO public.contacts (id, name, location_id, utm_campaign) VALUES ('${C1}', 'Synth One', '${LOC}', 'synth-campaign');
  INSERT INTO public.contact_location_preferences (contact_id, location_id) VALUES ('${C1}', '${LOC}');
`

let db
const runSql = (text) => db['exec'](text)
async function asRole(role, sql) {
  await runSql('BEGIN')
  try {
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally { await runSql('ROLLBACK') }
}
async function viewCols() {
  const { rows } = await db.query(`SELECT attname, format_type(atttypid, atttypmod) AS typ FROM pg_attribute
    WHERE attrelid = 'public.contact_location_audience'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)
  return rows
}
async function contactsHas() {
  const { rows } = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name IN ('utm_source', 'utm_medium') ORDER BY ordinal_position`)
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
async function boot(before = '') {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  if (before) await runSql(before)
}

describe('before 837', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the model is the 114-column view mig 766 left (not vacuous)', async () => {
    expect(COLS_766).toHaveLength(114)
    expect(COLS_766.slice(-3)).toEqual(['studio_stage_slug', 'studio_kind', 'studio_status'])
    expect((await viewCols()).map((r) => r.attname)).toEqual(COLS_766)
    expect(await contactsHas()).toEqual([])
  })

  it('the 837 view statement is 766 with exactly the two columns appended', () => {
    expect(colsOf(selectList(MIG_837))).toEqual(AFTER)
    expect(selectList(MIG_837).startsWith(SELECT_766)).toBe(true)
  })
})

describe('after 837', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = { view: await viewState(), contactsAcl: await aclItems('public.contacts') }
    await runSql(MIG_837)
  }, 60_000)
  afterAll(() => db?.close())

  it('contacts has both columns, nullable text, commented', async () => {
    expect(await contactsHas()).toEqual([
      { column_name: 'utm_source', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'utm_medium', data_type: 'text', is_nullable: 'YES' },
    ])
    const { rows } = await db.query(`SELECT col_description('public.contacts'::regclass, attnum) AS c FROM pg_attribute
      WHERE attrelid = 'public.contacts'::regclass AND attname IN ('utm_source', 'utm_medium')`)
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.c).toMatch(/UTMSOURCE\.1 \(mig 837\)/)
  })

  it('the 766 columns are unchanged and in order; the two new columns at the end', async () => {
    const cols = await viewCols()
    expect(cols.map((r) => r.attname)).toEqual(AFTER)
    expect(cols.slice(COLS_766.length).map((r) => [r.attname, r.typ])).toEqual(NEW_COLS)
  })

  it('the view carries the contact value', async () => {
    await runSql(`UPDATE public.contacts SET utm_source = 'instagram', utm_medium = 'bio' WHERE id = '${C1}'`)
    expect(await asRole('service_role', 'SELECT utm_campaign, utm_source, utm_medium FROM public.contact_location_audience'))
      .toEqual([{ utm_campaign: 'synth-campaign', utm_source: 'instagram', utm_medium: 'bio' }])
  })

  it('view: security_invoker, OID, owner, comment and ACL as before, closed to clients; contacts ACL untouched', async () => {
    const s = await viewState()
    expect(s).toEqual(before.view)
    expect(s.opts).toBe('{security_invoker=on}')
    expect(s.acl.every((i) => i.startsWith('postgres:') || i.startsWith('service_role:'))).toBe(true)
    expect(await aclItems('public.contacts')).toEqual(before.contactsAcl)
    for (const role of ['authenticated', 'anon']) {
      await expect(asRole(role, 'SELECT id FROM public.contact_location_audience'))
        .rejects.toThrow(/permission denied for (view|table|relation) contact_location_audience/)
    }
  })

  it('the grant decision: authenticated reads the columns through the table grant, anon reads nothing, neither writes', async () => {
    await expect(asRole('authenticated', 'SELECT utm_source, utm_medium FROM public.contacts')).resolves.toHaveLength(1)
    await expect(asRole('anon', 'SELECT utm_source FROM public.contacts')).rejects.toThrow(/permission denied/)
    await expect(asRole('authenticated', `UPDATE public.contacts SET utm_source = 'x'`)).rejects.toThrow(/permission denied/)
  })

  it('idempotent: a second run passes and changes nothing', async () => {
    const s = await viewState()
    await expect(runSql(MIG_837)).resolves.toBeDefined()
    expect((await viewCols()).map((r) => r.attname)).toEqual(AFTER)
    expect(await viewState()).toEqual(s)
  })
})

describe('the file aborts as a whole', () => {
  afterEach(async () => { await db?.close() })

  it('when a client role holds anything on the view', async () => {
    await boot('GRANT SELECT ON public.contact_location_audience TO authenticated;')
    expect(await abortMessage(MIG_837)).toMatch(/mig 837: a client role holds a privilege on contact_location_audience/)
    expect((await viewCols()).map((r) => r.attname)).toEqual(COLS_766)
    expect(await contactsHas()).toEqual([])
  }, 60_000)

  it('the OR REPLACE trap: without WITH (security_invoker = on) the self-check refuses and nothing is left behind', async () => {
    await boot()
    const trapped = MIG_837.replace(/ WITH \(security_invoker = on\) AS/, ' AS')
    expect(trapped).not.toBe(MIG_837)
    expect(await abortMessage(trapped)).toMatch(/mig 837: contact_location_audience lost security_invoker/)
    expect((await viewState()).opts).toBe('{security_invoker=on}')
    expect(await contactsHas()).toEqual([])
  }, 60_000)
})
