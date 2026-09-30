// MEMBERWRITESWEEP.1 guard (migs 680-685). The sweep closes every table whose
// write policies tested studio MEMBERSHIP and nothing narrower
// (private.auth_is_in_location, optionally OR auth_is_master): no client role
// (anon, authenticated, PUBLIC) writes any of them, and a client may read one
// only where its registry row names an own-row read policy (`keepRead`,
// `FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id())`,
// the member's own rows). Pinned here, per registry row:
//
//  1. Browser and phone code may `.from('<own-read table>').select(…)` and
//     nothing else: no write on any swept table, no use at all of a closed one
//     (read, write, a `.from()` held in a variable), and no embed of a swept
//     table in another table's select string, no realtime subscription, no raw
//     /rest/v1/<t> URL. Client-bound code = shared/, mobile/, desktop/, and
//     every src/ file that is 'use client' (after any header comment), names
//     createBrowserClient, calls createAuthClient() or holds the anon key.
//     Anything else is a 42501 once the table's migration has applied. Act
//     through the service-role routes that check the caller's role or
//     permission (for 680: /api/contacts/[id]/{kudos,goals,consultations,
//     consultation-photos}*, /api/consultations/me, /api/consultation-photos/me).
//  2. A later migration may not give anon or PUBLIC any privilege on a swept
//     table; give authenticated anything but SELECT, or SELECT on a table
//     without `keepRead`; do either through ALL TABLES IN SCHEMA public; hand
//     a client role another role; create a permissive policy on it (on a
//     `keepRead` table only that exact own-row SELECT policy); ALTER a policy
//     on it; disable RLS on it (any ALTER TABLE form); make a client role its
//     OWNER; or CREATE/RENAME a table to its name (the default ACL re-grants
//     ALL to anon and authenticated). A GRANT run from EXECUTE '…' counts.
//     The one exemption is a rollback migration named
//     `<NNN>_memberwritesweep1<letter>_rollback.sql`, for the rows whose
//     `rollback` letter it carries.
//  3. The class detector (C94 F2's ask): no migration from 680 on creates a
//     permissive INSERT/UPDATE/DELETE/ALL policy, on ANY table, whose USING
//     and WITH CHECK test auth_is_in_location and nothing narrower (no role,
//     permission, ownership or auth.uid()). Membership is not a write test.
//
// JS comments are blanked from the TypeScript parser's comment ranges (never
// a regex; JSX text is never read as a comment), SQL comments by one quote-
// and dollar-aware pass that pairs each $tag$ body with its own closing tag
// (sqlCode, tests/function-execute-guard.test.js). Both helpers are copied
// verbatim from tests/cars-company-settings-client-closed-guard.test.js. A
// floor, not a proof: a table name held in a variable, a `.from(<variable>)`,
// SQL built at runtime or a policy made with EXECUTE format(…) is invisible
// (the live catalog probe at the end of the sweep is the proof). Server code
// is not checked: service_role bypasses grants. champ-app only writes
// coach_kudos.seen_at through its own service-role route (C101 plan §4).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')

// One row per table this sweep closed. `keepRead` names the ONE permissive
// SELECT policy a client may still use (own-row, TO authenticated); null =
// no client privilege at all. `rollback` = the rollback file letter that may
// reopen it (<NNN>_memberwritesweep1<letter>_rollback.sql).
export const SWEEP = [
  // 1a — mig 680
  { table: 'coach_kudos', mig: 680, keepRead: 'coach_kudos_read_own', rollback: 'a' },
  { table: 'coaching_goals', mig: 680, keepRead: 'coaching_goals_read_own', rollback: 'a' },
  { table: 'inbody_scans', mig: 680, keepRead: 'inbody_scans_read_own', rollback: 'a' },
  { table: 'consultation_photos', mig: 680, keepRead: null, rollback: 'a' },
  { table: 'consultations', mig: 680, keepRead: null, rollback: 'a' },
  // 1b, 1c, 1d, 1e, 1g append their rows here.
]
const SCAN_FROM = 680            // the class detector: every migration from the first sweep file
// Reopeners are scanned from 631, not 680: migration numbers are reserved
// ahead of time and a lower number can merge later (631 is the HELD #1774;
// 677-679 are reserved for C76/C77/C110 when 680 was written). 631-679 hold
// nothing the detector flags on the swept tables (checked).
const REOPEN_SCAN_FROM = 631
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const ROLLBACK_FILE = /^\d+_memberwritesweep1([a-g])_rollback\.sql$/
const ALL_T = SWEEP.map((r) => r.table)
const CLOSED_T = SWEEP.filter((r) => !r.keepRead).map((r) => r.table)
const OWN_READ_T = SWEEP.filter((r) => r.keepRead).map((r) => r.table)
const T = ALL_T.join('|')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

// ── client code ──────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * JS/TS with comments blanked (newlines and offsets kept), from the
 * TypeScript parser's own comment ranges, so a '/*' or '//' inside a string,
 * template or regex literal is never read as a comment. JSX text is not
 * trivia, but asked for comments at its start the scanner reads
 * `<p>/* note</p>` as one, so no range is taken at a position where JSX text
 * begins (tests/staff-profile-to-client.test.js). A file the parser cannot
 * read is returned raw: a false positive beats a blind spot.
 */
export function stripComments(text, file = 'scan.jsx') {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  if (sf.parseDiagnostics?.length) return text
  const jsxTextAt = new Set()
  const findJsxText = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxTextAt.add(node.pos)
    for (const child of node.getChildren(sf)) findJsxText(child)
  }
  findJsxText(sf)
  const ranges = new Map()
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) ranges.set(r.pos, r.end)
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  let out = text
  for (const [pos, end] of ranges) out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end)
  return out
}

function isClientCode(code) {
  return /^['"]use client['"]/.test(code.trimStart()) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}
export const isClientFile = (text, file) => isClientCode(stripComments(text, file))

// Every file is parsed once per run (the TypeScript parse is the slow part).
const CODE = new Map()
const codeOfFile = (f) => {
  if (!CODE.has(f)) CODE.set(f, stripComments(readFileSync(f, 'utf8'), f))
  return CODE.get(f)
}
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile')), ...walk(path.join(ROOT, 'desktop'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f)))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

// Any .from('<t>'), with the verb that follows it when there is one.
const FROM = new RegExp(`\\.from\\(\\s*['"\`](${T})['"\`]\\s*\\)(?:\\s*\\??\\.\\s*(\\w+)\\s*\\()?`, 'g')
// A PostgREST embed inside another table's select string: 'id, coach_kudos(message)'
// or 'consultations!fk(*)'. A '…' or "…" string ends at its line; a backtick
// template may span lines (the house style is a multi-line template select).
const EMBED = new RegExp(`(?:['"][^'"\\n]*?|\`[^\`]*?)\\b(${T})\\s*(?:!\\s*\\w+\\s*)?\\(`, 'g')
const REALTIME = new RegExp(`\\btable\\s*:\\s*['"\`](${T})['"\`]`, 'g')
const REST = new RegExp(`/rest/v1/(${T})\\b`, 'g')

/**
 * Every forbidden client use in already-stripped code, as "<table>.<op>". A
 * `.from()` on an own-read table is allowed only when `.select(` follows it
 * directly; everything on a closed table, and every embed, realtime
 * subscription or raw REST URL of any swept table, is forbidden.
 */
function usesIn(code) {
  return [
    ...[...code.matchAll(FROM)]
      .filter((m) => CLOSED_T.includes(m[1]) || m[2] !== 'select')
      .map((m) => `${m[1]}.${m[2] || 'from'}`),
    ...[...code.matchAll(EMBED)].map((m) => `${m[1]}.embed`),
    ...[...code.matchAll(REALTIME)].map((m) => `${m[1]}.realtime`),
    ...[...code.matchAll(REST)].map((m) => `${m[1]}.rest`),
  ]
}
/** The allowed own-row reads in already-stripped code (what the "not vacuous" test counts). */
const ownReadsIn = (code) => [...code.matchAll(FROM)]
  .filter((m) => OWN_READ_T.includes(m[1]) && m[2] === 'select').map((m) => `${m[1]}.select`)
/** Every forbidden client use in `text` (comments excluded). */
export const sweepClientUses = (text, file) => usesIn(stripComments(text, file))

// ── migrations ───────────────────────────────────────────────────────────
/**
 * The SQL with its comments blanked (newlines kept), by a quote-aware scan:
 * '…' (with '' doubling, and backslash escapes in E'…'), "…" identifiers and
 * $tag$…$tag$ bodies are never read as comment markers, so a '/*' or '--'
 * inside one cannot hide code. Block comments nest, as in Postgres. A
 * dollar-quoted body is matched to its own closing tag first and scanned the
 * same way on its own, so nothing inside can run past it. String contents
 * are kept verbatim: a GRANT run from EXECUTE '…' counts.
 * (tests/function-execute-guard.test.js sqlCode, copied verbatim rather than
 * imported: importing a test file would re-register its tests here.)
 */
export function sqlCode(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const DOLLAR = /\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/y
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(sql.slice(i, stop))
      i = stop
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      out += blank(sql.slice(i, j))
      i = j
      continue
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue } break }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      DOLLAR.lastIndex = i
      const m = DOLLAR.exec(sql)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) { out += sql.slice(i); break }
        out += tag + sqlCode(sql.slice(i + tag.length, end)) + tag
        i = end + tag.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

const ident = (s) => s.trim().replace(/"/g, '').toLowerCase()
function splitTop(list) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}
const rolesOf = (list) => splitTop(list.replace(/\s+(with\s+(grant|admin|inherit|set)\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
const tableName = (s) => ident(s).replace(/^public\s*\.\s*/, '')

// One statement each: no part may cross a ';', and the role list also ends
// at a quote or a dollar sign (a GRANT run from EXECUTE '…'). ALTER DEFAULT
// PRIVILEGES statements are removed first: they change future tables only.
const ADP_RE = /\balter\s+default\s+privileges\b[^;]*;?/gi
const GRANT_ON = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const GRANT_ROLE = /\bgrant\s+([^;]+?)\s+to\s+([^;'$]+)/gi
const PRIV_WORDS = ['all', 'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'usage', 'execute', 'create', 'connect', 'temporary', 'temp']

const CLIENT = ['anon', 'authenticated', 'public']
const OWN_ROW_USING = /^\(*\s*contact_id\s*=\s*private\s*\.\s*auth_contact_id\s*\(\s*\)\s*\)*$/i

function balancedAfter(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(openIdx + 1, i) }
  }
  return text.slice(openIdx + 1)
}
/** The parts of a CREATE POLICY body (the text after `ON <table>`). */
function policyParts(body) {
  const cmd = (body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] || 'all').toLowerCase()
  const to = body.match(/\bto\s+([\s\S]+?)(?=\busing\b|\bwith\s+check\b|$)/i)?.[1]
  const roles = to ? splitTop(to).map(ident) : ['public']
  const using = [...body.matchAll(/\busing\s*\(/gi)].map((x) => balancedAfter(body, x.index + x[0].length - 1))
  const check = [...body.matchAll(/\bwith\s+check\s*\(/gi)].map((x) => balancedAfter(body, x.index + x[0].length - 1))
  return { cmd, roles, using, check, restrictive: /\bas\s+restrictive\b/i.test(body) }
}
const PRIVS_OF = (list) => splitTop(list).map((p) => p.replace(/\s*\([\s\S]*\)\s*$/, '').trim().toLowerCase().replace(/^all\s+privileges$/, 'all'))

/**
 * Every statement in `sql` that would re-open a swept table to a client role.
 * `exempt` = a rollback letter: rows carrying it are not checked.
 */
export function sweepReopeners(sql, { exempt = null } = {}) {
  const rows = SWEEP.filter((r) => r.rollback !== exempt)
  if (rows.length === 0) return []
  const byName = new Map(rows.map((r) => [r.table, r]))
  const names = rows.map((r) => r.table).join('|')
  const NAMES_R = `(?:"?public"?\\s*\\.\\s*)?"?(${names})"?`
  const code = sqlCode(sql).replace(ADP_RE, ' ')
  const hits = []
  for (const [stmt, privs, target, to] of code.matchAll(GRANT_ON)) {
    const roles = rolesOf(to).filter((r) => CLIENT.includes(r))
    if (roles.length === 0) continue
    const t = target.trim()
    const all = t.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    // Any client privilege through ALL TABLES reaches the closed tables.
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all\s)/i.test(t)) continue
    const tables = splitTop(t.replace(/^table\s+/i, '')).map(tableName).filter((x) => byName.has(x))
    if (tables.length === 0) continue
    const selectOnly = PRIVS_OF(privs).every((p) => p === 'select')
    const ok = roles.every((r) => r === 'authenticated') && selectOnly && tables.every((x) => byName.get(x).keepRead)
    if (!ok) hits.push(stmt.trim())
  }
  for (const [stmt, granted, to] of code.matchAll(GRANT_ROLE)) {
    if (/\s+on\s+/i.test(stmt)) continue
    if (splitTop(granted).map(ident).some((r) => PRIV_WORDS.includes(r))) continue
    if (rolesOf(to).some((r) => CLIENT.includes(r))) hits.push(stmt.trim())
  }
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+policy\\s+("[^"]+"|\\S+)\\s+on\\s+${NAMES_R}(?=[\\s;])([^;]*)`, 'gi'))) {
    const p = policyParts(m[3])
    if (p.restrictive) continue
    const keep = byName.get(tableName(m[2])).keepRead
    const ownRead = keep && ident(m[1]) === keep && p.cmd === 'select' && p.roles.length === 1 && p.roles[0] === 'authenticated' &&
      p.check.length === 0 && p.using.length === 1 && OWN_ROW_USING.test(p.using[0].trim())
    if (!ownRead) hits.push(m[0].trim())
  }
  for (const m of code.matchAll(new RegExp(`\\balter\\s+policy\\s+(?:"[^"]+"|\\S+)\\s+on\\s+${NAMES_R}(?=[\\s;])[^;]*`, 'gi'))) hits.push(m[0].trim())
  // ALTER TABLE [IF EXISTS] [ONLY] <name> …: DISABLE RLS anywhere in a multi-action
  // statement, or the table handed to a client role (an owner bypasses its grants and RLS).
  const ALTER_ONE = `\\balter\\s+table\\s+(?:(?:only|if\\s+exists)\\s+)*${NAMES_R}(?=[\\s;])[^;]*?`
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bdisable\\s+row\\s+level\\s+security\\b`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`${ALTER_ONE}\\bowner\\s+to\\s+"?(anon|authenticated|public)"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\bcreate\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAMES_R}(?=[\\s(;])`, 'gi'))) hits.push(m[0].trim())
  for (const m of code.matchAll(new RegExp(`\\balter\\s+table\\s+[^;]*?\\brename\\s+to\\s+"?(${names})"?(?=[\\s;]|$)`, 'gi'))) hits.push(m[0].trim())
  return hits
}

// ── the class detector ───────────────────────────────────────────────────
// A permissive INSERT/UPDATE/DELETE/ALL policy whose USING and WITH CHECK
// test studio membership and nothing narrower (no role, permission,
// ownership or auth.uid()) is the class this sweep closed. Fail it in any
// migration from 680 on, on ANY table. Floor, not proof: a policy built with
// EXECUTE format(...) is invisible (the live probe at the end of the sweep
// is the proof).
const NARROWING = /\b(auth_role|auth_is_owner|auth_is_manager|auth_is_active_staff|auth_contact_id|role|permissions?|has_\w*perm\w*)\b|auth\.uid\s*\(|\bfalse\b/i
const CREATE_POLICY = /\bcreate\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)([\s\S]*?)(?=;)/gi
export function membershipOnlyWritePolicies(sql) {
  const code = sqlCode(sql)
  const hits = []
  for (const m of code.matchAll(CREATE_POLICY)) {
    const body = m[3]
    if (/\bas\s+restrictive\b/i.test(body)) continue
    const cmd = (body.match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] || 'all').toLowerCase()
    if (cmd === 'select') continue
    const exprs = [...body.matchAll(/\b(using|with\s+check)\s*\(/gi)]
      .map((x) => balancedAfter(body, x.index + x[0].length - 1))
    if (exprs.length === 0) continue
    const joined = exprs.join(' ')
    if (/auth_is_in_location/i.test(joined) && !NARROWING.test(joined)) hits.push(`${tableName(m[2])}.${ident(m[1])}`)
  }
  return hits
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
const MEMBER_READS = [
  'mobile/app/(member)/(tabs)/home.jsx', 'mobile/app/(member)/kudos.jsx', 'mobile/app/(member)/coaching/index.jsx',
  'mobile/app/(member)/coaching/inbody.jsx', 'mobile/app/(member)/wrapped/challenge/[id].jsx',
  'mobile/components/member/ChallengeTransformationCard.jsx',
]

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code only reads its own rows of the swept tables (MEMBERWRITESWEEP.1, migs 680-685)', { timeout: 120_000 }, () => {
  it('scans the files it is meant to police (not vacuous): the member reads are seen, and allowed', () => {
    const names = clientFiles().map(rel)
    expect(names).toEqual(expect.arrayContaining(MEMBER_READS))
    for (const server of ['src/app/(sales)/contacts/[id]/page.js', 'src/app/api/consultations/me/route.js',
      'src/lib/inbody-ingest.js']) {
      expect(names).not.toContain(server)
    }
    const seen = new Set()
    for (const f of clientFiles()) if (ownReadsIn(codeOfFile(f)).length) seen.add(rel(f))
    expect([...seen].sort()).toEqual(expect.arrayContaining(MEMBER_READS))
    const reads = clientFiles().flatMap((f) => ownReadsIn(codeOfFile(f)))
    expect(reads.length).toBeGreaterThanOrEqual(7)
  })

  it('no browser, phone or desktop file writes a swept table or touches a closed one', () => {
    const offenders = []
    for (const f of clientFiles()) for (const op of usesIn(codeOfFile(f))) offenders.push(`${rel(f)}: ${op}`)
    expect(offenders, 'act through the service-role routes (the sweep\'s migrations refuse every client write, and every read of a closed table)').toEqual([])
  })

  it('the detector catches every write, every closed-table use and every embed, and ignores own-row reads, routes, comments and look-alikes', () => {
    const bad = `
      await supabase.from('coach_kudos').insert({ message: 'x' })
      await supabase.from("coaching_goals")
        .update({ status: 'done' }).eq('id', id)
      await db.from(\`inbody_scans\`).upsert(row)
      await supabase?.from('inbody_scans')?.delete()
      await supabase.from('consultations').select('notes')
      await supabase.from('consultation_photos') . select('storage_path')
      const q = supabase.from('coaching_goals')
      await supabase.from('contacts').select('id, coach_kudos(message)')
      await supabase.from('contacts').select(\`id, consultations!consultations_contact_id_fkey(*)\`)
      channel.on('postgres_changes', { event: '*', schema: 'public', table: 'inbody_scans' }, cb)
      await fetch(\`\${SUPABASE_URL}/rest/v1/consultations?select=*\`)`
    expect(sweepClientUses(bad)).toEqual([
      'coach_kudos.insert', 'coaching_goals.update', 'inbody_scans.upsert', 'inbody_scans.delete',
      'consultations.select', 'consultation_photos.select', 'coaching_goals.from',
      'coach_kudos.embed', 'consultations.embed', 'inbody_scans.realtime', 'consultations.rest',
    ])
    const ok = `
      const { data } = await supabase.from('coach_kudos').select('id, message').eq('contact_id', contact.id)
      await supabase
        .from('inbody_scans')
        .select('scanned_at, weight_kg')
        .order('scanned_at', { ascending: false })
      await supabase?.from('coaching_goals')?.select('title')
      const r = await crmApi('/api/consultations/me')
      await api(\`/api/contacts/\${id}/consultation-photos\`)
      await fetch('/api/contacts/' + id + '/kudos', { method: 'POST', body })
      // await supabase.from('consultations').select('*')
      /* supabase.from('coach_kudos').update(x) */
      await supabase.from('consultations_archive').select('*')
      const consultations = []
      consultations.map((c) => c.id)
      hasPermission(user, 'consultations')
      const label = 'No consultations yet.'`
    expect(sweepClientUses(ok)).toEqual([])
  })

  it("a '/*' in a string, a regex or JSX text hides nothing; a real JSX comment is a comment", () => {
    expect(sweepClientUses("const a = 'image/*'\nsupabase.from('coach_kudos').update(p)\nconst b = '*/'\n")).toEqual(['coach_kudos.update'])
    expect(sweepClientUses("const r = /\\/*/\nsupabase.from('consultations').delete()\nconst s = '*/'\n")).toEqual(['consultations.delete'])
    expect(sweepClientUses("'use client'\nexport default function P() {\n  return <div><p>/* note</p>{supabase.from('inbody_scans').insert(p)}<p>end */</p></div>\n}\n"))
      .toEqual(['inbody_scans.insert'])
    expect(sweepClientUses("'use client'\nexport default function P() {\n  return <div>\n    {/* supabase.from('consultations').select('*') */}\n  </div>\n}\n"))
      .toEqual([])
  })
})

describe('later migrations keep the swept tables closed to clients', () => {
  it.each([...new Set(SWEEP.map((r) => r.mig))])('mig %s is present', (mig) => {
    expect(migrationFiles().some((f) => f.startsWith(`${mig}_`))).toBe(true)
  })

  const later = migrationFiles().filter((f) => parseInt(f, 10) >= REOPEN_SCAN_FROM)
  it.each(later)('%s: no client write, no client role, no reopening policy, RLS kept on the swept tables', (file) => {
    const exempt = file.match(ROLLBACK_FILE)?.[1] ?? null
    expect(sweepReopeners(readFileSync(path.join(MIGRATIONS, file), 'utf8'), { exempt }),
      `${file} re-opens a MEMBERWRITESWEEP table to a client role. Go through a service-role route instead`).toEqual([])
  })

  it('the migration detector catches every form', () => {
    const bad = [
      'GRANT UPDATE ON public.coaching_goals TO authenticated;',
      'grant insert on table coach_kudos to authenticated;',
      'GRANT SELECT ON public.consultations TO authenticated;',
      'GRANT SELECT (notes) ON public.consultations TO authenticated;',
      'GRANT SELECT ON public.inbody_scans TO anon;',
      'GRANT SELECT ON public.coach_kudos TO PUBLIC;',
      'GRANT SELECT, UPDATE ON public.inbody_scans TO authenticated;',
      'GRANT ALL ON "public"."consultation_photos" TO authenticated;',
      'GRANT UPDATE (seen_at) ON public.coach_kudos TO authenticated;',
      'GRANT MAINTAIN ON public.coaching_goals TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      'GRANT DELETE ON public.orders, public.consultations TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.inbody_scans TO authenticated'; END $$;`,
      'CREATE POLICY coaching_goals_loc ON public.coaching_goals FOR ALL TO authenticated USING (private.auth_is_in_location(location_id));',
      'CREATE POLICY coach_kudos_read_own ON public.coach_kudos FOR SELECT TO authenticated USING (true);',
      'CREATE POLICY coach_kudos_read_own ON public.coach_kudos FOR SELECT TO public USING (contact_id = private.auth_contact_id());',
      'CREATE POLICY coach_kudos_read_own ON public.coach_kudos FOR ALL TO authenticated USING (contact_id = private.auth_contact_id());',
      'CREATE POLICY other_name ON public.inbody_scans FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());',
      'CREATE POLICY inbody_scans_read_own ON public.inbody_scans FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id() OR private.auth_is_in_location(location_id));',
      'CREATE POLICY consultations_read_own ON public.consultations FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());',
      'create policy "x" on consultation_photos to authenticated using (true);',
      'ALTER POLICY coach_kudos_read_own ON public.coach_kudos USING (true);',
      'ALTER TABLE public.consultations DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE IF EXISTS ONLY public.inbody_scans ADD COLUMN x int, DISABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.coach_kudos OWNER TO authenticated;',
      'GRANT coach_writer TO authenticated;',
      'CREATE TABLE IF NOT EXISTS public.consultations (id uuid);',
      'ALTER TABLE public.consultations_v2 RENAME TO consultations;',
      "SELECT '/*';\nGRANT UPDATE ON public.coaching_goals TO authenticated;\nSELECT '*/';",
      "COMMENT ON TABLE x IS $c$ /* $c$;\nGRANT INSERT ON public.inbody_scans TO authenticated;\nSELECT $d$ */ $d$;",
    ]
    for (const sql of bad) expect(sweepReopeners(sql), sql).not.toEqual([])
  })

  it('…and passes the safe ones', () => {
    const ok = [
      'GRANT SELECT ON public.coach_kudos, public.coaching_goals, public.inbody_scans TO authenticated;',
      'GRANT SELECT (scanned_at, weight_kg) ON public.inbody_scans TO authenticated;',
      'GRANT ALL ON public.consultations TO service_role;',
      'GRANT UPDATE ON public.orders TO authenticated;',
      'GRANT SELECT ON public.consultations_archive TO authenticated;',
      'REVOKE ALL ON public.consultations, public.consultation_photos FROM anon, authenticated, PUBLIC;',
      'CREATE POLICY coach_kudos_read_own ON public.coach_kudos FOR SELECT TO authenticated USING (contact_id = private.auth_contact_id());',
      'CREATE POLICY inbody_scans_read_own ON public.inbody_scans\n  FOR SELECT TO authenticated USING ((contact_id = private.auth_contact_id()));',
      'CREATE POLICY d ON public.consultations AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);',
      'CREATE POLICY p ON public.consultation_notes FOR ALL TO authenticated USING (true);',
      'DROP POLICY IF EXISTS coach_kudos_ins ON public.coach_kudos;',
      'ALTER TABLE public.inbody_scans ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE public.coach_kudos ADD COLUMN reaction text;',
      'ALTER TABLE public.consultations OWNER TO postgres;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'CREATE TABLE public.consultation_notes (id uuid);',
      'ALTER TABLE public.consultations RENAME COLUMN notes TO coach_notes;',
      '-- rollback: GRANT UPDATE ON public.coaching_goals TO authenticated;',
      '/* GRANT ALL ON public.consultations TO anon; */',
    ]
    for (const sql of ok) expect(sweepReopeners(sql), sql).toEqual([])
  })

  it('a rollback migration is exempt only under its exact name and letter', () => {
    const reopen = 'GRANT UPDATE ON public.coaching_goals TO authenticated;'
    const exemptOf = (f) => f.match(ROLLBACK_FILE)?.[1] ?? null
    expect(sweepReopeners(reopen, { exempt: exemptOf('686_memberwritesweep1a_rollback.sql') })).toEqual([])
    expect(sweepReopeners(reopen, { exempt: exemptOf('686_memberwritesweep1b_rollback.sql') })).not.toEqual([])
    expect(sweepReopeners(reopen, { exempt: exemptOf('686_coaching_regrant.sql') })).not.toEqual([])
    expect(exemptOf('686_memberwritesweep1a_rollback.sql')).toBe('a')
    expect(exemptOf('686_carsclientwrite1_rollback.sql')).toBe(null)
  })
})

describe('no migration from 680 on writes a membership-only write policy, on any table (the class detector)', () => {
  const later = migrationFiles().filter((f) => parseInt(f, 10) >= SCAN_FROM)
  it('scans mig 680 at least', () => expect(later.some((f) => f.startsWith('680_'))).toBe(true))

  it.each(later)('%s: no permissive write policy that tests only studio membership', (file) => {
    expect(membershipOnlyWritePolicies(readFileSync(path.join(MIGRATIONS, file), 'utf8')),
      `${file}: a write policy that tests only auth_is_in_location admits every plain staff member at the studio. Test a role, a permission or ownership, or write through a service-role route`).toEqual([])
  })

  it('the detector catches the membership-only write shapes', () => {
    const bad = [
      'CREATE POLICY t_loc ON public.blocked_times FOR ALL TO authenticated USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));',
      'CREATE POLICY t_loc ON public.orders FOR ALL TO authenticated USING ((SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id));',
      'CREATE POLICY t_via ON public.t FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.p WHERE p.id = t.p_id AND private.auth_is_in_location(p.location_id)));',
      'CREATE POLICY "Location members write" ON public.t FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));',
      'CREATE POLICY t_upd ON public.t FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id));',
      'CREATE POLICY t_any ON public.t TO authenticated USING (private.auth_is_in_location(location_id));',
    ]
    for (const sql of bad) expect(membershipOnlyWritePolicies(sql), sql).toHaveLength(1)
  })

  it('…and passes the narrower ones and the non-writes', () => {
    const ok = [
      'CREATE POLICY t_read ON public.t FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));',
      'CREATE POLICY t_deny ON public.t AS RESTRICTIVE FOR ALL TO authenticated USING (private.auth_is_in_location(location_id));',
      "CREATE POLICY t_mgr ON public.t FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id) AND private.auth_role(location_id) = ANY (ARRAY['owner','manager']));",
      'CREATE POLICY t_own ON public.t FOR UPDATE TO authenticated USING (private.auth_is_in_location(location_id) AND (SELECT auth.uid()) = profile_id);',
      'CREATE POLICY t_member ON public.t FOR INSERT TO authenticated WITH CHECK (contact_id = private.auth_contact_id() AND private.auth_is_in_location(location_id));',
      'CREATE POLICY t_none ON public.t FOR INSERT TO authenticated WITH CHECK (false);',
      '-- CREATE POLICY t_loc ON public.t FOR ALL TO authenticated USING (private.auth_is_in_location(location_id));',
      `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $c$ BEGIN
         -- CREATE POLICY t_loc ON public.t FOR ALL TO authenticated USING (private.auth_is_in_location(location_id));
       END $c$;`,
    ]
    for (const sql of ok) expect(membershipOnlyWritePolicies(sql), sql).toEqual([])
  })

  it('every role and permission helper is a gate, whatever its suffix', () => {
    const gated = [
      'private.auth_is_manager_at(location_id)',
      'private.auth_is_owner_at(location_id)',
      'public.auth_is_owner_or_manager()',
      'private.auth_is_admin_at(location_id)',
      '(SELECT private.auth_is_admin_or_head_coach())',
      "private.auth_mobile_can(location_id, 'inbox')",
      "private.auth_role(location_id) = 'owner'",
      'private.auth_is_manager_at_bridge(location_id)',
    ]
    for (const g of gated) {
      const sql = `CREATE POLICY t_w ON public.t FOR ALL TO authenticated USING (${g} AND private.auth_is_in_location(location_id)) WITH CHECK (${g} AND private.auth_is_in_location(location_id));`
      expect(membershipOnlyWritePolicies(sql), sql).toEqual([])
    }
  })

  it("mig 014's pipeline_stages_admin_write (owner/manager AND membership) passes, read from the file", () => {
    const text = readFileSync(path.join(MIGRATIONS, '014_rls_location_scoping.sql'), 'utf8')
    const stmt = text.match(/CREATE POLICY pipeline_stages_admin_write[\s\S]*?;/)?.[0]
    expect(stmt).toMatch(/auth_is_owner_or_manager\(\)[\s\S]*auth_is_in_location/)
    expect(membershipOnlyWritePolicies(stmt)).toEqual([])
  })
})
