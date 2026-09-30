// TABLEDEFAULTACL.1 guard (mig 677). Since 677 a table, view or sequence
// postgres creates in public is open to postgres + service_role only: the
// default privileges no longer hand anything to anon or authenticated, anon
// holds nothing in public, and authenticated holds no TRUNCATE, REFERENCES,
// TRIGGER or MAINTAIN and no sequence privilege. The failure mode FLIPS:
// forgetting a REVOKE is now closed by default, while forgetting a GRANT
// blanks a client screen with 42501. Pinned here, for every migration from
// SCAN_FROM on (numbers are reserved ahead of time, so 676 may land after 677
// and is held to the same rule):
//
//  1. Nothing gives anon or PUBLIC a privilege on a public table, view,
//     column or sequence (ANON_ALLOWED is empty), by name or through ALL
//     TABLES/SEQUENCES IN SCHEMA public.
//  2. Nothing gives authenticated TRUNCATE, REFERENCES, TRIGGER, MAINTAIN or
//     ALL on a public relation (name the privileges a client needs), or any
//     privilege on a sequence (use an identity column or a uuid default).
//  3. No blanket grant to a client role on ALL TABLES/SEQUENCES IN SCHEMA
//     public.
//  4. No ALTER DEFAULT PRIVILEGES re-opens TABLES or SEQUENCES to a client
//     role, globally or IN SCHEMA public.
//  5. Every CREATE TABLE / VIEW / MATERIALIZED VIEW / SEQUENCE in public, and
//     every ALTER … SET SCHEMA public, states its client decision in the same
//     file: a GRANT naming it TO authenticated, or a REVOKE naming it FROM a
//     list with both anon and authenticated (the 607/630/635/641/649 house
//     style, still right on a database whose defaults were reset).
//  6. No role-membership grant into anon/authenticated/PUBLIC, and no
//     ALTER … OWNER TO a client role.
//  7. A table first created from TABLE_ACL_MIGRATION on that client-run code
//     reads (.from('<t>') in shared/, mobile/, or a src/ client file) is
//     granted to authenticated by a migration.
//
// Comments are blanked by the quote-aware, $tag$-pairing scan
// (tests/helpers/sql-code.js) and by the TypeScript parser's comment ranges
// (tests/helpers/js-code.js), never by a regex. A floor, not a proof: SQL
// built at runtime (EXECUTE of a concatenated string) and a table name held
// in a variable are invisible.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { sqlCode, ident, splitTop } from './helpers/sql-code.js'
import { stripComments, isClientFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const TABLE_ACL_MIGRATION = 677
const SCAN_FROM = 676
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

/** Public relations anon may hold a privilege on. Empty on purpose (mig 677). */
export const ANON_ALLOWED = []
/** New tables a shared/ file reads only through a service-role client. Add with a reason. */
export const SERVER_ONLY_SHARED_READS = {}

const CLIENT_ROLES = ['anon', 'authenticated', 'public']
const MAINTENANCE = ['truncate', 'references', 'trigger', 'maintain', 'all', 'all privileges']
const NOT_A_RELATION = /^(function|procedure|routine|schema|database|large\s+object|type|domain|foreign\s+(data\s+wrapper|server)|tablespace|language|parameter|all\s+(functions|procedures|routines)\b)/i

const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_RE = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const REVOKE_RE = /\brevoke\s+([^;]+?)\s+on\s+([^;]+?)\s+from\s+([^;'$]+)/gi
const MEMBERSHIP_RE = /\bgrant\s+((?:(?!\bon\b)[^;'$])+?)\s+to\s+([^;'$]+)/gi
const NAME = String.raw`((?:"?[a-z_][\w]*"?\s*\.\s*)?"?[a-z_][\w]*"?)(?![\w."%$])`
const CREATE_RE = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?(temp|temporary|unlogged)\s+)?(table|view|materialized\s+view|sequence)\s+(?:if\s+not\s+exists\s+)?${NAME}`, 'gi')
const SET_SCHEMA_RE = new RegExp(String.raw`\balter\s+(table|view|materialized\s+view|sequence)\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+set\s+schema\s+"?public"?`, 'gi')
const OWNER_RE = /\balter\s+(?:table|view|materialized\s+view|sequence)\s+[^;]+?\bowner\s+to\s+"?(anon|authenticated|public)"?/gi
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\s+option|with\s+(admin|inherit|set)\s+\w+|granted\s+by\b|cascade|restrict)[\s\S]*$/i, '')).map(ident)
const privNames = (privs) => splitTop(privs).map((p) => p.replace(/\([\s\S]*$/, '').trim().toLowerCase().replace(/\s+/g, ' '))

function splitName(qualified) {
  const parts = qualified.split('.').map(ident)
  return parts.length === 2 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] }
}

/** What a GRANT/REVOKE target names: { kind: 'relation'|'sequence'|'all-tables'|'all-sequences'|'other', names, schemas }. */
export function targetOf(target) {
  const t = target.trim()
  const all = t.match(/^all\s+(tables|sequences)\s+in\s+schema\s+([\s\S]+)$/i)
  if (all) return { kind: all[1].toLowerCase() === 'tables' ? 'all-tables' : 'all-sequences', schemas: splitTop(all[2]).map(ident), names: [] }
  if (NOT_A_RELATION.test(t)) return { kind: 'other', names: [], schemas: [] }
  const seq = /^sequence\s/i.test(t)
  const list = t.replace(/^(table|sequence)\s+/i, '')
  const names = splitTop(list).map((n) => splitName(n.replace(/\s+[\s\S]*$/, ''))).filter((n) => n.schema === 'public').map((n) => n.name)
  return { kind: seq ? 'sequence' : 'relation', names, schemas: ['public'] }
}

/** Every client-role GRANT in one migration that breaks rules 1-3. */
export function clientGrantViolations(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const out = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_RE)) {
    const roles = rolesOf(to).filter((r) => CLIENT_ROLES.includes(r))
    if (!roles.length) continue
    const tgt = targetOf(target)
    if (tgt.kind === 'other') continue
    const inPublic = tgt.kind.startsWith('all-') ? tgt.schemas.includes('public') : tgt.names.length > 0
    if (!inPublic) continue
    const s = stmt.trim().replace(/\s+/g, ' ')
    if (tgt.kind.startsWith('all-')) { out.push(`blanket: ${s}`); continue }
    if (roles.includes('anon') || roles.includes('public')) {
      if (!tgt.names.every((n) => ANON_ALLOWED.includes(n))) out.push(`anon/PUBLIC: ${s}`)
    }
    if (roles.includes('authenticated')) {
      if (tgt.kind === 'sequence') out.push(`sequence to authenticated: ${s}`)
      else if (privNames(privs).some((p) => MAINTENANCE.includes(p))) out.push(`TRUNCATE/REFERENCES/TRIGGER/MAINTAIN/ALL to authenticated: ${s}`)
    }
  }
  return out
}

/** ALTER DEFAULT PRIVILEGES that re-open tables/sequences in public (or globally) to a client role. */
export function defaultReopeners(sql) {
  const hits = []
  for (const [stmt] of sqlCode(sql).matchAll(ADP_RE)) {
    if (!/\bgrant\s+[\s\S]+?\s+on\s+(tables|sequences)\b/i.test(stmt)) continue
    const to = stmt.match(/\bto\s+([\s\S]+?)\s*;?\s*$/i)
    if (!to || !rolesOf(to[1]).some((r) => CLIENT_ROLES.includes(r))) continue
    const schemas = stmt.match(/\bin\s+schema\s+([\s\S]+?)\s+grant\b/i)
    if (!schemas || splitTop(schemas[1]).map(ident).includes('public')) hits.push(stmt.trim().replace(/\s+/g, ' '))
  }
  return hits
}

/** Public relations this file creates (or moves into public): [{ kind, name }]. TEMP ones excluded. */
export function createdRelations(sql) {
  const code = sqlCode(sql)
  const out = []
  for (const m of code.matchAll(CREATE_RE)) {
    if (m[1] && !/unlogged/i.test(m[1])) continue   // TEMP/TEMPORARY: session-only
    const { schema, name } = splitName(m[3])
    if (schema === 'public') out.push({ kind: m[2].toLowerCase().replace(/\s+/g, ' '), name })
  }
  for (const m of code.matchAll(SET_SCHEMA_RE)) out.push({ kind: m[1].toLowerCase().replace(/\s+/g, ' '), name: splitName(m[2]).name })
  return out
}

/** Relations named by a GRANT … TO authenticated / a REVOKE … FROM anon+authenticated in this file. */
export function clientDecisions(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const granted = new Set()
  const revoked = new Set()
  for (const [, , target, to] of code.matchAll(GRANT_RE)) {
    if (rolesOf(to).includes('authenticated')) for (const n of targetOf(target).names) granted.add(n)
  }
  for (const [, , target, from] of code.matchAll(REVOKE_RE)) {
    const roles = rolesOf(from)
    if (roles.includes('anon') && roles.includes('authenticated')) for (const n of targetOf(target).names) revoked.add(n)
  }
  return { granted, revoked }
}

/** New public relations with no client decision in the same file (rule 5). */
export function undeclared(sql) {
  const { granted, revoked } = clientDecisions(sql)
  return [...new Set(createdRelations(sql).filter((r) => !granted.has(r.name) && !revoked.has(r.name)).map((r) => `${r.kind} ${r.name}`))]
}

/** Role memberships into a client role, and client-role owners (rule 6). */
export function roleLeaks(sql) {
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const out = []
  for (const [stmt, , to] of code.matchAll(MEMBERSHIP_RE)) {
    if (/\bon\b/i.test(stmt)) continue
    if (rolesOf(to).some((r) => CLIENT_ROLES.includes(r))) out.push(stmt.trim().replace(/\s+/g, ' '))
  }
  for (const [stmt] of code.matchAll(OWNER_RE)) out.push(stmt.trim().replace(/\s+/g, ' '))
  return out
}

// ── the migrations ───────────────────────────────────────────────────────
const migrationFiles = () => readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))
const readMig = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')

describe('later migrations keep public relations closed by default (mig 677)', () => {
  it('mig 677 is present', () => {
    expect(migrationFiles().some((f) => f.startsWith(`${TABLE_ACL_MIGRATION}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM)
  it.each(later)('%s: no client re-grant, no re-opened default, every new relation declared', (file) => {
    const sql = readMig(file)
    expect(clientGrantViolations(sql), `${file}: anon holds nothing in public, and authenticated gets named read/write privileges only (mig 677)`).toEqual([])
    expect(defaultReopeners(sql), `${file}: the public table/sequence default stays postgres + service_role (mig 677)`).toEqual([])
    expect(undeclared(sql), `${file}: add GRANT <privileges> ON public.<name> TO authenticated (a client reads it) or REVOKE ALL ON public.<name> FROM anon, authenticated (server-only)`).toEqual([])
    expect(roleLeaks(sql), `${file}: no role membership into, or ownership by, a client role`).toEqual([])
  })
})

// ── client code (rule 7) ─────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'ios', 'android', 'dist', 'web-build'].includes(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** Tables whose LATEST creating migration is 677 or later, with that file. */
export function newTables(files = migrationFiles()) {
  const latest = new Map()
  for (const f of files) {
    for (const r of createdRelations(readMig(f))) if (r.kind === 'table' || r.kind === 'view' || r.kind === 'materialized view') latest.set(r.name, f)
  }
  return new Map([...latest].filter(([, f]) => parseInt(f, 10) >= TABLE_ACL_MIGRATION))
}

describe('client-run code reads only new tables granted to authenticated (mig 677)', () => {
  const fresh = newTables()
  const grantedAnywhere = (name) => migrationFiles().filter((f) => parseInt(f, 10) >= parseInt(fresh.get(name), 10))
    .some((f) => clientDecisions(readMig(f)).granted.has(name))

  it('every .from() of a new table in client code has its GRANT', () => {
    if (!fresh.size) return
    const names = [...fresh.keys()]
    const hit = (text) => names.filter((n) => text.includes(`'${n}'`) || text.includes(`"${n}"`) || text.includes(`\`${n}\``))
    const bad = []
    const scan = (f, clientOnly) => {
      const text = readFileSync(f, 'utf8')
      const cand = hit(text)
      if (!cand.length || (clientOnly && !isClientFile(text))) return
      const code = stripComments(text)
      for (const n of cand) {
        if (!new RegExp(String.raw`\.from\(\s*['"\`]${n}['"\`]`).test(code)) continue
        if (SERVER_ONLY_SHARED_READS[n]?.includes(rel(f))) continue
        if (!grantedAnywhere(n)) bad.push(`${rel(f)}: .from('${n}') but no migration grants ${n} to authenticated`)
      }
    }
    for (const f of [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]) scan(f, false)
    for (const f of walk(path.join(ROOT, 'src'))) scan(f, true)
    expect(bad).toEqual([])
  }, 60_000)
})

describe('the detectors', () => {
  it('clientGrantViolations flags anon/PUBLIC, maintenance, sequences and blanket grants', () => {
    for (const sql of [
      'GRANT SELECT ON public.google_reviews TO anon;',
      'GRANT SELECT ON TABLE landing_page_settings TO anon, authenticated;',
      'GRANT SELECT (id) ON public.notes TO PUBLIC;',
      'GRANT ALL ON public.notes TO authenticated;',
      'GRANT ALL PRIVILEGES ON TABLE public.notes TO authenticated;',
      'GRANT SELECT, TRUNCATE ON public.notes TO authenticated;',
      'GRANT REFERENCES (id) ON public.notes TO authenticated;',
      'GRANT MAINTAIN ON public.whatsapp_messages TO authenticated;',
      'GRANT USAGE ON SEQUENCE public.webhook_dead_letter_id_seq TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'grant usage on all sequences in schema public to anon;',
      `DO $$ BEGIN EXECUTE 'GRANT SELECT ON public.notes TO anon'; END $$;`,
      // a DO body's closing $$ must not flip parity and hide the next statement (C74)
      `DO $$ BEGIN PERFORM 1; END $$;\nGRANT SELECT ON public.notes TO anon; -- /* not a comment start`,
    ]) expect(clientGrantViolations(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT SELECT ON public.notes TO authenticated;',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;',
      'GRANT SELECT (id, name), UPDATE (name) ON public.locations TO authenticated;',
      'GRANT ALL ON public.notes TO service_role;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.f() TO authenticated;',
      'GRANT USAGE ON SCHEMA public TO anon;',
      'GRANT SELECT ON other.notes TO anon;',
      '-- rollback: GRANT ALL ON public.notes TO anon;',
      '/* GRANT ALL ON public.notes TO anon; */',
    ]) expect(clientGrantViolations(sql), sql).toEqual([])
  })

  it('defaultReopeners catches tables/sequences re-opened in public or globally', () => {
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;',
      'alter default privileges for role postgres grant usage on sequences to authenticated;',
    ]) expect(defaultReopeners(sql), sql).not.toEqual([])
    for (const sql of [
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT SELECT ON TABLES TO authenticated;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;',
    ]) expect(defaultReopeners(sql), sql).toEqual([])
  })

  it('undeclared catches a new relation with no client decision and passes the house styles', () => {
    for (const [sql, want] of [
      ['CREATE TABLE public.widgets (id uuid PRIMARY KEY);', ['table widgets']],
      ['create table if not exists widgets (id uuid);', ['table widgets']],
      ['CREATE VIEW public.v WITH (security_invoker = on) AS SELECT 1;', ['view v']],
      ['CREATE OR REPLACE VIEW public.v AS SELECT 1;', ['view v']],
      ['CREATE UNLOGGED TABLE public.u (id int);', ['table u']],
      ['CREATE SEQUENCE public.s;', ['sequence s']],
      ['CREATE TABLE public.w (id int);\nREVOKE ALL ON public.w FROM anon;', ['table w']],
      ['ALTER TABLE staging.w SET SCHEMA public;', ['table w']],
    ]) expect(undeclared(sql), sql).toEqual(want)
    for (const sql of [
      'CREATE TABLE public.w (id int);\nREVOKE ALL ON public.w FROM anon, authenticated;',
      'CREATE TABLE public.w (id int);\nREVOKE ALL ON TABLE public.w FROM anon, authenticated, PUBLIC;\nGRANT SELECT, INSERT ON public.w TO service_role;',
      'CREATE TABLE w (id int);\nGRANT SELECT ON w TO authenticated;',
      'CREATE TABLE public.a (id int); CREATE TABLE public.b (id int);\nREVOKE ALL ON public.a, public.b FROM anon, authenticated;',
      'CREATE TEMP TABLE scratch (id int);',
      'CREATE TEMP VIEW mig_state AS SELECT 1;',
      'CREATE TABLE private.p (id int);',
      "EXECUTE format('CREATE TABLE public.%I (id integer)', '_probe');",
      "EXECUTE format('CREATE VIEW public.%I AS SELECT 1', '_probe_v');",
      '-- CREATE TABLE public.w (id int);',
    ]) expect(undeclared(sql), sql).toEqual([])
  })

  it('roleLeaks catches memberships into and ownership by a client role', () => {
    for (const sql of [
      'GRANT sneaky TO anon;',
      'GRANT reporting TO authenticated WITH INHERIT TRUE;',
      'ALTER TABLE public.notes OWNER TO authenticated;',
    ]) expect(roleLeaks(sql), sql).not.toEqual([])
    for (const sql of [
      'GRANT SELECT ON public.notes TO authenticated;',
      'GRANT anon TO authenticator;',
      'ALTER TABLE public.notes OWNER TO postgres;',
    ]) expect(roleLeaks(sql), sql).toEqual([])
  })

  it('newTables reads the LATEST creating migration', () => {
    const files = migrationFiles()
    expect(files.some((f) => parseInt(f, 10) >= TABLE_ACL_MIGRATION)).toBe(true)
    // 677 creates nothing a scanner can read (its probes are format() strings).
    expect([...newTables()].filter(([, f]) => f.startsWith('677_'))).toEqual([])
  })
})
