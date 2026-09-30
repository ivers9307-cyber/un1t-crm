// GRANTSWEEP.1 guard (mig 668). What a browser or phone session may do on the
// staff scheduling tables (tests/helpers/scheduling-client-grants.js):
// staff_attendance_events is service-role only; shift_swap_requests and
// time_off_requests are read-only for authenticated; anon holds nothing on
// those three or on the two mig 646 shift tables. Pinned here:
//
//  1. Client-run code (shared/, mobile/, and every src/ file that is
//     'use client' after any header comment, or names createBrowserClient,
//     createAuthClient() or the anon key; .js/.jsx/.ts/.tsx) never reads
//     staff_attendance_events and never writes any of the three. Files are
//     read through the TypeScript parser (codeOf) with comments, JSX text and
//     regex literals blanked. A select on
//     the three that the scanner cannot evaluate fails closed. (A read of a
//     closed table, or any client write, is a 42501 after 668: on the phone's
//     Today tab that is a blank list, so it is caught here, not on a handset.)
//  2. A migration after 668 fails when it gives a client role back what 668
//     took: anything to anon or PUBLIC on the five tables; anything to
//     authenticated on staff_attendance_events; any privilege but SELECT to
//     authenticated on the two read-only tables; TRUNCATE, REFERENCES,
//     TRIGGER, MAINTAIN or ALL to authenticated on the shift tables; any
//     client grant on ALL TABLES IN SCHEMA public; any role-membership
//     GRANT <role> TO a client role; an ALTER TABLE … RENAME TO one of the
//     five names. A GRANT inside EXECUTE '…' or $q$…$q$ counts. The one
//     exemption is a rollback migration named
//     `<NNN>_grantsweep1_rollback.sql`.
//  3. A migration after 668 fails when it creates a policy on
//     staff_attendance_events, or a write policy (FOR ALL/INSERT/UPDATE/
//     DELETE, or no FOR, which means ALL) on the two read-only tables; or
//     when it CREATE TABLEs any of the five names in public (the default ACL
//     re-grants ALL to anon and authenticated). No exemption for the table.
//  4. A migration after 668 fails when it takes a privilege off a
//     column-granted table (COLUMN_GRANTED: rosters, the two shift tables,
//     locations, contact_external_integrations, email_sequences) with a
//     table-level REVOKE SELECT/UPDATE/ALL FROM authenticated: that revokes
//     it on every column too, unless the same file re-grants the column list
//     after it.
//
// SQL comments are blanked by ONE left-to-right, quote- and dollar-aware
// pass (stripSqlComments), never by a regex that removes /* */ first: a '/*'
// inside a string or a -- comment would hide the code up to the next */.
// A floor, not a proof: ALTER POLICY, a policy made by a function, and a
// `.from(<variable>)` in client code are invisible. Server code (service
// role) is not checked: it bypasses grants.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  GRANTSWEEP_MIGRATION, CLOSED_TABLES, READ_ONLY_TABLES, SHIFT_TABLES, ANON_NONE_TABLES,
} from './helpers/scheduling-client-grants.js'
import { columnUses, fkAliasesInto } from './helpers/postgrest-column-uses.js'
import { collectSchema } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const SCANNED = [...CLOSED_TABLES, ...READ_ONLY_TABLES]
const FK_ALIASES = fkAliasesInto(collectSchema(MIG_DIR).fks, SCANNED)
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/**
 * The file's CODE: comments, JSX text and regex literals blanked (newlines
 * and offsets kept), read by the TypeScript parser, never by a regex or a
 * hand state machine. JSX text is not trivia, but asked for comments where
 * it starts the scanner reads `<p>/* note</p>` as one, so no comment range is
 * taken there (tests/staff-profile-to-client.test.js, GUARDSTRIP.0). JSX text
 * and regex literals are blanked too, because columnUses' own comment mask
 * (check-select-columns' maskComments) would otherwise read the '/*' in
 * `<p>files/*.csv</p>` or `/\/*\/` as a comment and hide every call up to
 * the next '*\/'. Neither can hold a PostgREST call. A file the parser
 * cannot read is returned raw: a false positive beats a blind spot.
 */
export function codeOf(text, file = 'scan.jsx') {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  if (sf.parseDiagnostics?.length) return text
  const jsxTextAt = new Set()
  const blanks = []
  const find = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) { jsxTextAt.add(node.pos); blanks.push([node.pos, node.end]) }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) blanks.push([node.getStart(sf), node.end])
    for (const child of node.getChildren(sf)) find(child)
  }
  find(sf)
  const visit = (node) => {
    if (!jsxTextAt.has(node.pos)) {
      for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) || []), ...(ts.getTrailingCommentRanges(text, node.pos) || [])]) blanks.push([r.pos, r.end])
    }
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  const out = text.split('')
  for (const [from, to] of blanks) for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  return out.join('')
}

/**
 * Is this src/ file run in a browser session? A 'use client' directive
 * (after any header comment), createBrowserClient, createAuthClient() or the
 * anon key (what a session client is built from), read from the code only
 * (the same test as tests/function-execute-guard.test.js isClientFile).
 */
export function isClientFile(text, file) {
  return isClientCode(codeOf(text, file).trimStart())
}
function isClientCode(code) {
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}

// Every file is parsed once per run (the TypeScript parse is the slow part:
// a full repo scan per test ran past vitest's 5 s budget on the CI runner).
const CODE = new Map()
const codeOfFile = (f) => {
  if (!CODE.has(f)) CODE.set(f, codeOf(readFileSync(f, 'utf8'), f))
  return CODE.get(f)
}
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f).trimStart()))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

/** PostgREST reads/writes/unresolved selects on the three tables in one file's code. */
export const scanUses = (text, file) => columnUses(codeOf(text, file), SCANNED, FK_ALIASES)
const USES = new Map()
const readUses = (f) => {
  if (!USES.has(f)) USES.set(f, columnUses(codeOfFile(f), SCANNED, FK_ALIASES))
  return USES.get(f)
}
const uses = scanUses

// The whole-repo scans are parse-bound; give them room on a slow runner.
describe('client code and the scheduling tables (GRANTSWEEP.1)', { timeout: 120_000 }, () => {
  const files = clientFiles()

  it('scans the client files and finds the phone reads it is meant to police (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toContain('shared/dashboard-data.js')
    expect(names.some((f) => f.startsWith('mobile/app/'))).toBe(true)
    const reads = readUses(path.join(ROOT, 'shared/dashboard-data.js')).reads.map(([t, c]) => `${t}.${c}`)
    expect(reads).toEqual(expect.arrayContaining(['shift_swap_requests.reason', 'shift_swap_requests.status', 'time_off_requests.type']))
  })

  it('never reads staff_attendance_events (service role only since mig 668)', () => {
    const offenders = []
    for (const f of files) {
      for (const [t, c] of readUses(f).reads) if (CLOSED_TABLES.includes(t)) offenders.push(`${rel(f)}: ${t}.${c}`)
    }
    expect(offenders, 'read it through a service-role /api/attendance route').toEqual([])
  })

  it('never writes the three tables (mig 668 grants no client write)', () => {
    const offenders = []
    for (const f of files) {
      for (const [t, op] of readUses(f).writes) offenders.push(`${rel(f)}: ${op} on ${t}`)
    }
    expect(offenders, 'write through a service-role /api/schedule or /api/attendance route').toEqual([])
  })

  it('every select on the three is one the scanner can read (fail closed)', () => {
    // A select the scanner cannot evaluate could name anything. Review it by
    // hand and list it here as `<file>: <table> <arg text>`.
    const REVIEWED_DYNAMIC_SELECTS = []
    const unread = []
    for (const f of files) {
      for (const [t, arg] of readUses(f).unresolved) {
        const key = `${rel(f)}: ${t} ${arg}`
        if (!REVIEWED_DYNAMIC_SELECTS.includes(key)) unread.push(key)
      }
    }
    expect(unread, 'name the columns in a literal or a same-file const, or review it and list it').toEqual([])
  })

  it('finds every browser-session file: a comment header, createAuthClient, the anon key', () => {
    expect(isClientFile("/* header */\n'use client'\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("// Header line one.\n//\n// line two\n\"use client\"\nexport const x = 1\n")).toBe(true)
    expect(isClientFile("import { createAuthClient } from '@/lib/auth'\nconst db = await createAuthClient()\n")).toBe(true)
    expect(isClientFile("const c = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)\n")).toBe(true)
    // …and a comment is not a directive or a client.
    expect(isClientFile("// 'use client'\nimport { createServerClient } from '@/lib/supabase'\n")).toBe(false)
    expect(isClientFile("/* was createBrowserClient() before X */\nexport const y = 1\n")).toBe(false)
    expect(clientFiles().map(rel)).toContain('src/components/InvoicesManager.jsx')
  })

  it('a client write behind a comment header is still caught', () => {
    const src = "/**\n * Swap editor.\n */\n'use client'\nexport const post = (db, row) => db.from('shift_swap_requests').insert(row)\n"
    expect(isClientFile(src)).toBe(true)
    expect(scanUses(src).writes).toEqual([['shift_swap_requests', 'insert']])
  })

  it("JSX text or a regex holding '/*' cannot hide a call from the scanner", () => {
    const jsx = "'use client'\nexport default function P({ db }) {\n  return <div><p>Upload files/*.csv here</p></div>\n}\n" +
      "export const w = (db) => db.from('shift_swap_requests').insert({})\nexport const s = '*/'\n"
    expect(scanUses(jsx).writes).toEqual([['shift_swap_requests', 'insert']])
    const re = "export const r = /\\/*/\nexport const d = (db) => db.from('time_off_requests').delete().eq('id', 1)\nexport const s = '*/'\n"
    expect(scanUses(re).writes).toEqual([['time_off_requests', 'delete']])
    // a real comment is still a comment
    expect(scanUses("// db.from('shift_swap_requests').insert({})\n/* db.from('time_off_requests').delete() */\n").writes).toEqual([])
  })

  it('the scanner sees the forms it must', () => {
    const r = (src) => uses(src).reads.map(([t, c]) => `${t}.${c}`)
    expect(r(`db.from('staff_attendance_events').select('id, payload')`)).toEqual(['staff_attendance_events.id', 'staff_attendance_events.payload'])
    expect(r(`db.from('staff_attendance_events').select()`)).toContain('staff_attendance_events.*')
    expect(r(`db.from('shift_assignments').select('id, staff_attendance_events ( event_at )')`)).toContain('staff_attendance_events.event_at')
    expect(uses(`db.from('shift_swap_requests').insert(row)`).writes).toEqual([['shift_swap_requests', 'insert']])
    expect(uses(`db.from('shift_swap_requests').update({ status: 'approved' }).eq('id', i)`).writes).toEqual([['shift_swap_requests', 'update']])
    expect(uses(`db.from('time_off_requests').upsert(row)`).writes).toEqual([['time_off_requests', 'upsert']])
    expect(uses(`db.from('staff_attendance_events').delete().eq('id', i)`).writes).toEqual([['staff_attendance_events', 'delete']])
    expect(uses(`function f(c) { return db.from('time_off_requests').select(c) }`).unresolved).toEqual([['time_off_requests', 'c']])
    // …and the phone's own shapes pass.
    const phone = uses(`db.from('time_off_requests').select('id, type, start_date, end_date, status, created_at').eq('profile_id', p)`)
    expect(phone.writes).toEqual([])
    expect(phone.reads.every(([t]) => !CLOSED_TABLES.includes(t))).toBe(true)
  })
})

// ── migrations after 668 ──────────────────────────────────────────────
/**
 * SQL with its comments blanked, strings and code kept, in ONE left-to-right
 * pass: a "--" or "/*" inside a '…' string or a "…" identifier is not a
 * comment, and a "/*" inside a line comment does not open a block comment.
 * Block comments nest, as in Postgres. Each dollar-quoted body is matched to
 * its own closing tag before anything inside it is read; a body after DO or
 * AS is code (its comments are stripped, recursively), any other is a
 * literal and is kept verbatim. (CONSENTREAD.1's algorithm, with the dollar
 * body closed first as in tests/function-execute-guard.test.js sqlCode.)
 */
export function stripSqlComments(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '/' && d === '*') {
      let depth = 1
      i += 2
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 } else i++
      }
      out += ' '
      continue
    }
    if (c === "'") {
      const escapes = /(^|[^\w])[eE]$/.test(sql.slice(Math.max(0, i - 2), i))
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
      const j = sql.indexOf('"', i + 1)
      const end = j < 0 ? n : j
      out += sql.slice(i, end + 1)
      i = end + 1
      continue
    }
    const tag = c === '$' ? sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/) : null
    if (tag && !/[\w$]$/.test(sql.slice(0, i))) {
      // Match the body to ITS closing tag first, so nothing inside it can
      // run past the end, and code after the closing tag is code again.
      const open = tag[0]
      const j = sql.indexOf(open, i + open.length)
      const end = j < 0 ? n : j
      const body = sql.slice(i + open.length, end)
      const isCode = /\b(do|as)\s*$/i.test(out)
      out += open + (isCode ? stripSqlComments(body) : body) + (j < 0 ? '' : open)
      i = j < 0 ? n : j + open.length
      continue
    }
    out += c
    i++
  }
  return out
}

const ident = (s) => s.trim().replace(/["']/g, '').toLowerCase()
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
const tableName = (t) => ident(t).replace(/\s+/g, '').replace(/^public\./, '')
const CLIENT = ['authenticated', 'anon', 'public']
const SHIFT_FORBIDDEN = ['truncate', 'references', 'trigger', 'maintain', 'all', 'all privileges']

/** Every GRANT, CREATE POLICY or CREATE TABLE in `sql` that gives a client back what mig 668 took. */
export function grantsweepReopeners(sql) {
  const code = stripSqlComments(sql)
  const hits = []
  // Each part stops at ; ' or $, so a GRANT run from EXECUTE '…' or
  // EXECUTE $q$…$q$ ends at its quote.
  for (const m of code.matchAll(/\bgrant\s+([^;'$]+?)\s+on\s+([^;'$]+?)\s+to\s+([^;'$]+?)(?:;|'|\$|$)/gi)) {
    const [stmt, privs, target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT.includes(g))) continue
    const all = target.trim().match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all)\s/i.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map(tableName).filter((t) => ANON_NONE_TABLES.includes(t))
    if (!tables.length) continue
    if (grantees.some((g) => g === 'anon' || g === 'public')) { hits.push(stmt.trim()); continue }
    const names = splitTop(privs).map((p) => p.replace(/\s*\([\s\S]*\)\s*$/, '').toLowerCase().replace(/\s+/g, ' ').trim())
    const reopens = tables.some((t) => {
      if (CLOSED_TABLES.includes(t)) return true
      if (READ_ONLY_TABLES.includes(t)) return names.some((n) => n !== 'select')
      return SHIFT_TABLES.includes(t) && names.some((n) => SHIFT_FORBIDDEN.includes(n))
    })
    if (reopens) hits.push(stmt.trim())
  }
  const policyRe = /\bcreate\s+policy\s+(?:"[^"]*"|[a-z_][a-z0-9_]*)\s+on\s+(?:table\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;]*)/gi
  for (const m of code.matchAll(policyRe)) {
    const t = tableName(m[1])
    const cmd = (m[2].match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] || 'all').toLowerCase()
    if (CLOSED_TABLES.includes(t) || (READ_ONLY_TABLES.includes(t) && cmd !== 'select')) hits.push(m[0].trim())
  }
  // Role membership: a client role that inherits another role gets every
  // privilege that role holds, on these tables too, and nothing here can see
  // what the role will hold later. So any GRANT <role> TO a client role fails.
  for (const m of code.matchAll(/\bgrant\s+([^;'$]+?)\s+to\s+([^;'$]+?)(?:;|'|\$|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(roles)) continue
    const grantees = splitTop(to.replace(/\s+(with\s+\w+\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT.includes(g))) hits.push(stmt.trim())
  }
  // A table renamed INTO one of the five names inherits the old table's ACL.
  const renameRe = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[^;'$]+?\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)"?/gi
  for (const m of code.matchAll(renameRe)) if (ANON_NONE_TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
  const createRe = /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$."])/gi
  for (const m of code.matchAll(createRe)) if (ANON_NONE_TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
  return hits
}

/**
 * Tables whose authenticated privileges are COLUMN-level, and which ones
 * (migs 618, 646, 648, 654). A table-level REVOKE of one of these (or of
 * ALL) from authenticated also revokes it on every column, which silently
 * wipes the column grants (on the shift tables: the phone's Today tab 42501s).
 */
export const COLUMN_GRANTED = Object.freeze({
  rosters: Object.freeze(['select']),
  shift_blocks: Object.freeze(['select']),
  shift_assignments: Object.freeze(['select']),
  locations: Object.freeze(['select', 'update']),
  contact_external_integrations: Object.freeze(['select', 'update']),
  email_sequences: Object.freeze(['select']),
})

const NOT_A_TABLE = /^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain)\s/i
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does `code` grant `priv` on a column list of `table` to authenticated? */
function grantsColumns(code, priv, table) {
  const re = new RegExp(`\\bgrant\\s+[^;'$]*?\\b${priv}\\s*\\([^)]*\\)[^;'$]*?\\s+on\\s+(?:table\\s+)?(?:"?public"?\\s*\\.\\s*)?"?${escapeRe(table)}"?\\s+to\\s+[^;'$]*\\bauthenticated\\b`, 'i')
  return re.test(code)
}

/**
 * Every table-level REVOKE (no column list) of a privilege authenticated
 * holds by COLUMN on that table (COLUMN_GRANTED), or of ALL, from
 * authenticated, unless the same file re-grants a column list of each such
 * privilege on that table to authenticated AFTER it (the 618/646/648/654
 * shape). REVOKE GRANT OPTION FOR only drops the grant option: not counted.
 */
export function columnGrantWipers(sql) {
  const code = stripSqlComments(sql)
  const hits = []
  const revokeRe = /\brevoke\s+(?!grant\s+option\s+for\b)([^;'$]+?)\s+on\s+([^;'$]+?)\s+from\s+([^;'$]+?)(?:;|'|\$|$)/gi
  for (const m of code.matchAll(revokeRe)) {
    const [stmt, privs, target, from] = m
    const grantees = splitTop(from.replace(/\s+(granted\s+by\b|cascade\b|restrict\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.includes('authenticated')) continue
    const names = splitTop(privs).filter((p) => !p.includes('(')).map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim())
    const revokesAll = names.some((p) => p === 'all' || p === 'all privileges')
    const schemaWide = target.trim().match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    let tables
    if (schemaWide) {
      if (!splitTop(schemaWide[1]).map(ident).includes('public')) continue
      tables = Object.keys(COLUMN_GRANTED)
    } else {
      if (NOT_A_TABLE.test(target.trim())) continue
      tables = splitTop(target.replace(/^\s*table\s+/i, '')).map(tableName).filter((t) => t in COLUMN_GRANTED)
    }
    const after = code.slice(m.index + stmt.length)
    for (const t of tables) {
      const wiped = COLUMN_GRANTED[t].filter((p) => revokesAll || names.includes(p))
      if (wiped.length && !wiped.every((p) => grantsColumns(after, p, t))) hits.push(`${stmt.trim()} [wipes ${wiped.join('/')} column grants on ${t}]`)
    }
  }
  return hits
}

// ROLLING BACK mig 668: forward-only, so the rollback is a NEW migration named
// `<NNN>_grantsweep1_rollback.sql` (NNN > 668), whose body is the plan's
// rollback record. That exact name is exempt from the check below.
const isGrantsweepRollback = (file) =>
  /^\d+_grantsweep1_rollback\.sql$/.test(file) && Number.parseInt(file, 10) > GRANTSWEEP_MIGRATION

describe('later migrations keep the scheduling grants (GRANTSWEEP.1)', () => {
  const all = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f))
  const later = all.filter((f) => Number.parseInt(f, 10) > GRANTSWEEP_MIGRATION)

  it('mig 668 itself is on disk and reopens nothing', () => {
    const file = all.find((f) => Number.parseInt(f, 10) === GRANTSWEEP_MIGRATION && /scheduling_tables_client_grants/.test(f))
    expect(file).toBe('668_scheduling_tables_client_grants.sql')
    const sql = readFileSync(path.join(MIG_DIR, file), 'utf8')
    expect(grantsweepReopeners(sql)).toEqual([])
    expect(columnGrantWipers(sql)).toEqual([])
    // …and the D4 mistake (a table-level REVOKE on the shift tables) would be caught.
    const wiping = sql.replace('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.shift_blocks, public.shift_assignments FROM authenticated;',
      'REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM authenticated;')
    expect(wiping).not.toBe(sql)
    expect(columnGrantWipers(wiping)).toHaveLength(2)
  })

  it.each(later.length ? later : ['(none yet)'])('%s: gives no client back what mig 668 took', (file) => {
    if (file === '(none yet)' || isGrantsweepRollback(file)) return
    expect(grantsweepReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: this reopens a scheduling table to a browser or phone (mig 668). Serve it through a service-role /api route`).toEqual([])
  })

  it.each(later.length ? later : ['(none yet)'])('%s: wipes no column grant with a table-level REVOKE', (file) => {
    if (file === '(none yet)') return
    expect(columnGrantWipers(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: a table-level REVOKE of SELECT/UPDATE/ALL from authenticated also revokes it on every column. ` +
      'Revoke only the privileges you mean (e.g. INSERT, UPDATE, DELETE), or re-grant the column list after it in the same file (CLAUDE.md)').toEqual([])
  })

  it('the column-granted tables are the ones the migrations grant by column (not a stale list)', () => {
    const found = {}
    for (const f of all) {
      const code = stripSqlComments(readFileSync(path.join(MIG_DIR, f), 'utf8'))
      for (const m of code.matchAll(/\bgrant\s+(select|update)\s*\([^)]*\)[^;]*?\bon\s+(?:table\s+)?(?:public\.)?"?([a-z_]+)"?\s+to\s+[^;]*\bauthenticated\b/gi)) {
        (found[m[2]] ??= new Set()).add(m[1].toLowerCase())
      }
    }
    expect(Object.fromEntries(Object.entries(found).map(([t, p]) => [t, [...p].sort()]))).toEqual(
      Object.fromEntries(Object.entries(COLUMN_GRANTED).map(([t, p]) => [t, [...p].sort()])))
  })

  it.each([
    'REVOKE SELECT ON public.shift_blocks FROM authenticated;',
    'REVOKE ALL ON public.shift_assignments FROM anon, authenticated;',
    'REVOKE ALL PRIVILEGES ON TABLE public.rosters FROM authenticated;',
    'REVOKE UPDATE ON public.locations FROM authenticated;',
    'revoke select, insert on "public"."email_sequences" from "authenticated" cascade;',
    'REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM authenticated;',
    `DO $$ BEGIN EXECUTE 'REVOKE ALL ON public.contact_external_integrations FROM authenticated'; END $$;`,
    // ALL takes UPDATE too, and only SELECT is re-made
    'REVOKE ALL ON public.locations FROM authenticated;\nGRANT SELECT (id, name) ON public.locations TO authenticated;',
    // the column grant comes BEFORE the revoke, which then wipes it
    'GRANT SELECT (id) ON public.shift_blocks TO authenticated;\nREVOKE SELECT ON public.shift_blocks FROM authenticated;',
  ])('the column-grant wiper detector flags %s', (sql) => {
    expect(columnGrantWipers(sql)).not.toEqual([])
  })

  it.each([
    'REVOKE SELECT ON public.shift_blocks FROM anon;',
    'REVOKE INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments FROM authenticated;',
    'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.shift_blocks FROM authenticated;',
    'REVOKE UPDATE ON public.shift_blocks FROM authenticated;',
    'REVOKE SELECT (notes) ON public.shift_blocks FROM authenticated;',
    'REVOKE GRANT OPTION FOR SELECT ON public.rosters FROM authenticated;',
    'REVOKE SELECT ON public.shift_swap_requests FROM authenticated;',
    'REVOKE SELECT ON ALL TABLES IN SCHEMA private FROM authenticated;',
    // the 646 shape: a table-level revoke, then the column list re-made
    'REVOKE ALL ON public.shift_blocks FROM authenticated;\nGRANT SELECT (id, block_date) ON public.shift_blocks TO authenticated;\nGRANT INSERT, UPDATE, DELETE ON public.shift_blocks TO authenticated;',
    'REVOKE SELECT, UPDATE ON public.locations FROM anon, authenticated;\nGRANT SELECT (id, name), UPDATE (name) ON public.locations TO authenticated;',
    '-- REVOKE ALL ON public.locations FROM authenticated;',
  ])('the column-grant wiper detector passes %s', (sql) => {
    expect(columnGrantWipers(sql)).toEqual([])
  })

  it.each(['618_coach_budget_and_role_scope.sql', '646_shift_notes_column_grants.sql',
    '648_credential_column_grants.sql', '654_email_sequences_column_grants.sql'])(
    'the migration that made the column grants (%s) passes: it re-grants after its revoke', (file) => {
      expect(columnGrantWipers(readFileSync(path.join(MIG_DIR, file), 'utf8'))).toEqual([])
    })

  it('a GRANTSWEEP.1 rollback migration is allow-listed by its file name, and nothing else is', () => {
    expect(isGrantsweepRollback('669_grantsweep1_rollback.sql')).toBe(true)
    for (const name of ['669_restore_scheduling_grants.sql', '669_grantsweep1_rollback_and_more.sql',
      'grantsweep1_rollback.sql', '667_grantsweep1_rollback.sql', '669_grantsweep1_rollback.sql.bak']) {
      expect(isGrantsweepRollback(name), name).toBe(false)
    }
  })

  it.each([
    'GRANT SELECT ON public.staff_attendance_events TO authenticated;',
    'GRANT SELECT (id, event_at) ON "public"."staff_attendance_events" TO authenticated;',
    'grant all on table staff_attendance_events to anon;',
    'GRANT INSERT ON public.shift_swap_requests TO authenticated;',
    'GRANT UPDATE (status) ON public.shift_swap_requests TO authenticated;',
    'GRANT SELECT, DELETE ON public.time_off_requests TO authenticated;',
    'GRANT MAINTAIN ON public.time_off_requests TO authenticated;',
    'GRANT SELECT ON public.time_off_requests TO anon;',
    'GRANT SELECT ON public.shift_swap_requests TO PUBLIC;',
    'GRANT UPDATE ON public.shift_blocks TO anon;',
    'GRANT TRUNCATE ON public.shift_assignments TO authenticated;',
    'GRANT ALL ON public.shift_blocks TO authenticated;',
    'GRANT ALL PRIVILEGES ON public.shift_assignments TO "authenticated" WITH GRANT OPTION;',
    'GRANT REFERENCES (id) ON public.shift_blocks TO authenticated;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
    `DO $$ BEGIN EXECUTE 'GRANT INSERT ON public.shift_swap_requests TO authenticated'; END $$;`,
    'CREATE POLICY p ON public.staff_attendance_events FOR SELECT TO authenticated USING (true);',
    'CREATE POLICY "own" ON staff_attendance_events USING (profile_id = auth.uid());',
    'CREATE POLICY p ON public.shift_swap_requests FOR INSERT TO authenticated WITH CHECK (true);',
    'CREATE POLICY p ON public.time_off_requests TO authenticated USING (true);',
    'CREATE TABLE public.staff_attendance_events (id uuid);',
    'create table if not exists "public"."shift_swap_requests" (id uuid);',
    `DO $$ BEGIN EXECUTE $q$GRANT INSERT ON public.shift_swap_requests TO authenticated$q$; END $$;`,
    'ALTER TABLE public.staff_attendance_events_new RENAME TO staff_attendance_events;',
    'alter table if exists tmp_swaps rename to "shift_swap_requests";',
    'GRANT sneaky TO authenticated;',
    'GRANT some_role TO other_role, anon;',
    // The plan's rollback record reopens everything: that is why it needs the name exemption.
    'GRANT ALL ON public.staff_attendance_events TO anon, authenticated;',
  ])('the detector flags %s', (sql) => {
    expect(grantsweepReopeners(sql)).not.toEqual([])
  })

  it.each([
    'GRANT SELECT ON public.shift_swap_requests TO authenticated;',
    'GRANT SELECT (id, status) ON public.time_off_requests TO authenticated;',
    'GRANT SELECT (colour) ON public.shift_blocks TO authenticated;',
    'GRANT INSERT, UPDATE, DELETE ON public.shift_assignments TO authenticated;',
    'GRANT ALL ON public.staff_attendance_events TO service_role;',
    'GRANT SELECT ON public.time_off_balances TO anon;',
    'GRANT SELECT ON public.staff_attendance_events_archive TO authenticated;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
    'GRANT USAGE ON SEQUENCE public.shift_swap_requests_id_seq TO authenticated;',
    'REVOKE ALL ON public.staff_attendance_events FROM anon, authenticated, PUBLIC;',
    'CREATE POLICY p ON public.shift_swap_requests FOR SELECT TO authenticated USING (true);',
    'CREATE POLICY p ON public.shift_blocks FOR UPDATE TO authenticated USING (true);',
    'CREATE TABLE public.shift_swap_requests_archive (id uuid);',
    'CREATE INDEX ON public.staff_attendance_events (event_at);',
    '-- GRANT ALL ON public.staff_attendance_events TO anon;',
    '/* GRANT INSERT ON public.shift_swap_requests TO authenticated; */',
    'ALTER TABLE public.shift_swap_requests RENAME TO shift_swap_requests_old;',
    'ALTER TABLE public.shift_swap_requests RENAME COLUMN reason TO note;',
    'GRANT authenticated TO some_role;',
    'GRANT USAGE ON SCHEMA public TO authenticated;',
  ])('the detector passes %s', (sql) => {
    expect(grantsweepReopeners(sql)).toEqual([])
  })

  it.each([
    ['a /* inside a string before a real grant', "SELECT '/* not a comment';\nGRANT INSERT ON public.shift_swap_requests TO authenticated;"],
    ['a /* inside a -- comment before a real grant', '-- see migrations/*.sql\nGRANT INSERT ON public.time_off_requests TO authenticated;\n/* x */'],
    ['a grant after a nested block comment', '/* a /* b */ c */ GRANT SELECT ON public.staff_attendance_events TO authenticated;'],
    // A '/*' inside a dollar-quoted STRING that follows a DO block: each
    // dollar body is matched to its own closing tag, so the string is never
    // read as code.
    ['a /* inside a $$ string after a DO block', [
      'DO $$ BEGIN NULL; END $$;',
      'COMMENT ON TABLE public.shift_blocks IS $$ see /* $$;',
      'GRANT INSERT ON public.shift_swap_requests TO authenticated;',
      'COMMENT ON TABLE public.shift_blocks IS $$ */ $$;',
    ].join('\n')],
  ])('comments cannot hide a reopener: %s', (_, sql) => {
    expect(grantsweepReopeners(sql)).not.toEqual([])
  })

  it('the SQL comment stripper keeps strings and code, drops only comments', () => {
    expect(stripSqlComments("a -- x /* y\nb /* c -- d */ e '--f' \"/*g*/\"")).toBe("a  \nb   e '--f' \"/*g*/\"")
    expect(stripSqlComments('x /* a /* b */ c */ y')).toBe('x   y')
    expect(stripSqlComments("E'it\\'s -- here' z")).toBe("E'it\\'s -- here' z")
    // A DO or function body is code (its comments go); any other dollar
    // body is a literal (kept); code after a closing tag is code again.
    expect(stripSqlComments('DO $$ a -- b\n$$;\n-- c\nd $t$ -- e $t$ f')).toBe('DO $$ a  \n$$;\n \nd $t$ -- e $t$ f')
    expect(stripSqlComments('CREATE FUNCTION f() RETURNS int AS $f$ SELECT 1 /* x */ $f$ LANGUAGE sql; -- y')).toBe('CREATE FUNCTION f() RETURNS int AS $f$ SELECT 1   $f$ LANGUAGE sql;  ')
  })
})
