// SHIFTCLIENTWRITE.1 guard (mig 676). No client role writes public.shift_blocks
// or public.shift_assignments: authenticated holds only mig 646's column
// SELECT list, anon and PUBLIC nothing, and each table has exactly one
// policy, its SELECT policy. Pinned here:
//
//  1. Client-run code (shared/, mobile/, desktop/, and every src/ file that
//     is 'use client' after any header comment, names createBrowserClient,
//     calls createAuthClient() or holds the anon key) never INSERTs,
//     UPDATEs, UPSERTs or DELETEs either table through PostgREST, and never
//     names a raw /rest/v1/shift_blocks or /rest/v1/shift_assignments URL.
//     Any such write is a 42501 after 676. Write through a service-role
//     /api/schedule/* route (or /api/attendance/geofence-checkin). Reads are
//     policed by tests/shift-column-grants-guard.test.js (mig 646).
//  2. A later migration may not give a client role back a write: any
//     privilege at all to anon or PUBLIC on the two tables; to authenticated,
//     anything but a column-list SELECT (so no table-level privilege, no ALL,
//     no column-list INSERT/UPDATE/REFERENCES); any client grant ON ALL
//     TABLES IN SCHEMA public; any GRANT <role> TO a client role; a policy on
//     either table that is not FOR SELECT (no FOR means ALL); DISABLE ROW
//     LEVEL SECURITY or OWNER TO a client role on either; a CREATE TABLE or
//     RENAME TO either name (the default ACL re-grants ALL). A GRANT run from
//     EXECUTE '…' or $q$…$q$ counts. The one exemption is a rollback
//     migration named `<NNN>_shiftclientwrite1_rollback.sql`.
//
// codeOf, isClientCode and stripSqlComments are copied verbatim from
// tests/scheduling-client-grants-guard.test.js (importing a test file would
// run its suites here too). A floor, not a proof: `.from(<variable>)`, a
// chain split across statements and SQL built at runtime are invisible.
// Server code is not checked: service_role bypasses grants. No other repo on
// this project names either table (C82 plan §3).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { columnUses, fkAliasesInto } from './helpers/postgrest-column-uses.js'
import { collectSchema } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const CLOSED_MIGRATION = 676
// Scanned from 631, not 676: numbers are reserved ahead of time and a lower
// one can merge later (631 is the HELD #1774). 631-675 hold nothing the
// detector flags (646 grants column SELECT only; 668 only revokes).
const SCAN_FROM = 631
const TABLES = ['shift_blocks', 'shift_assignments']
const FK_ALIASES = fkAliasesInto(collectSchema(MIG_DIR).fks, TABLES)
const ROLLBACK_FILE = /^\d+_shiftclientwrite1_rollback\.sql$/
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

function isClientCode(code) {
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}

// Every file is parsed once per run (the TypeScript parse is the slow part).
const CODE = new Map()
const codeOfFile = (f) => {
  if (!CODE.has(f)) CODE.set(f, codeOf(readFileSync(f, 'utf8'), f))
  return CODE.get(f)
}
let CLIENT_FILES = null
function clientFiles() {
  if (CLIENT_FILES) return CLIENT_FILES
  const phone = ['shared', 'mobile', 'desktop'].flatMap((d) => walk(path.join(ROOT, d)))
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientCode(codeOfFile(f).trimStart()))
  CLIENT_FILES = [...phone, ...browser]
  return CLIENT_FILES
}

/** PostgREST reads/writes on the two tables in one file's code. */
export const scanUses = (text, file) => columnUses(codeOf(text, file), TABLES, FK_ALIASES)
const USES = new Map()
const usesOf = (f) => {
  if (!USES.has(f)) USES.set(f, columnUses(codeOfFile(f), TABLES, FK_ALIASES))
  return USES.get(f)
}
const RAW_URL = /\/rest\/v1\/(shift_blocks|shift_assignments)\b/

describe('client code never writes the shift tables (SHIFTCLIENTWRITE.1)', { timeout: 120_000 }, () => {
  const files = clientFiles()

  it('scans the client files and finds the phone reads (not vacuous)', () => {
    const names = files.map(rel)
    expect(names).toContain('shared/dashboard-data.js')
    expect(names.some((f) => f.startsWith('mobile/app/'))).toBe(true)
    const reads = usesOf(path.join(ROOT, 'shared/dashboard-data.js')).reads.map(([t, c]) => `${t}.${c}`)
    expect(reads).toEqual(expect.arrayContaining(['shift_assignments.status', 'shift_blocks.briefing', 'shift_blocks.block_date']))
  })

  it('no INSERT, UPDATE, UPSERT or DELETE on either table from a browser or phone', () => {
    const offenders = []
    for (const f of files) for (const [t, op] of usesOf(f).writes) offenders.push(`${rel(f)}: ${op} on ${t}`)
    expect(offenders, 'write through a service-role /api/schedule route (mig 676 grants no client write)').toEqual([])
  })

  it('no raw /rest/v1/shift_* URL in client code', () => {
    const offenders = files.filter((f) => RAW_URL.test(codeOfFile(f))).map(rel)
    expect(offenders).toEqual([])
  })

  it('the scanner sees the write forms it must, and passes reads', () => {
    expect(scanUses(`db.from('shift_assignments').update({ arrived_at: x }).eq('id', i)`).writes).toEqual([['shift_assignments', 'update']])
    expect(scanUses(`db.from('shift_blocks').insert(row)`).writes).toEqual([['shift_blocks', 'insert']])
    expect(scanUses(`db.from("shift_assignments").upsert(rows)`).writes).toEqual([['shift_assignments', 'upsert']])
    expect(scanUses(`db.from('shift_blocks').delete().eq('id', i)`).writes).toEqual([['shift_blocks', 'delete']])
    expect(scanUses(`db.from('shift_assignments').select('id, status').eq('profile_id', p)`).writes).toEqual([])
    expect(scanUses(`// db.from('shift_blocks').delete()\n/* db.from('shift_assignments').insert({}) */\n`).writes).toEqual([])
    expect(isClientCode("'use client'\nexport const x = 1")).toBe(true)
    expect(isClientCode("import { createServerClient } from '@/lib/supabase'")).toBe(false)
  })
})

// ── migrations ───────────────────────────────────────────────────────────
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
const NOT_A_TABLE = /^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all)\s/i

/** Every statement in `sql` that gives a client role a write (or more) on the shift tables. */
export function shiftWriteReopeners(sql) {
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
    if (NOT_A_TABLE.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map(tableName).filter((t) => TABLES.includes(t))
    if (!tables.length) continue
    if (grantees.some((g) => g === 'anon' || g === 'public')) { hits.push(stmt.trim()); continue }
    // authenticated: only a column-list SELECT is allowed (mig 646's shape).
    const onlyColumnSelect = splitTop(privs).every((p) => /^select\s*\([^)]*\)$/i.test(p.trim()))
    if (!onlyColumnSelect) hits.push(stmt.trim())
  }
  // Role membership: a client role that inherits another role gets every
  // privilege that role holds, on these tables too.
  for (const m of code.matchAll(/\bgrant\s+([^;'$]+?)\s+to\s+([^;'$]+?)(?:;|'|\$|$)/gi)) {
    const [stmt, roles, to] = m
    if (/\bon\b/i.test(roles)) continue
    const grantees = splitTop(to.replace(/\s+(with\s+\w+\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (grantees.some((g) => CLIENT.includes(g))) hits.push(stmt.trim())
  }
  const policyRe = /\bcreate\s+policy\s+(?:"[^"]*"|[a-z_][a-z0-9_]*)\s+on\s+(?:table\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;]*)/gi
  for (const m of code.matchAll(policyRe)) {
    const cmd = (m[2].match(/\bfor\s+(all|select|insert|update|delete)\b/i)?.[1] || 'all').toLowerCase()
    if (TABLES.includes(tableName(m[1])) && cmd !== 'select') hits.push(m[0].trim())
  }
  const alterRe = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?[a-z_][a-z0-9_]*"?\s*\.\s*)?"?[a-z_][a-z0-9_]*"?)([^;'$]*)/gi
  for (const m of code.matchAll(alterRe)) {
    const t = tableName(m[1])
    const rest = m[2]
    const rename = rest.match(/\brename\s+to\s+"?([a-z_][a-z0-9_]*)"?/i)
    if (rename && TABLES.includes(rename[1].toLowerCase())) { hits.push(m[0].trim()); continue }
    if (!TABLES.includes(t)) continue
    if (/\bdisable\s+row\s+level\s+security\b/i.test(rest)) hits.push(m[0].trim())
    const owner = rest.match(/\bowner\s+to\s+"?([a-z_][a-z0-9_]*)"?/i)
    if (owner && CLIENT.includes(owner[1].toLowerCase())) hits.push(m[0].trim())
  }
  const createRe = /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$."])/gi
  for (const m of code.matchAll(createRe)) if (TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
  return hits
}

describe('later migrations keep the shift tables write-closed (SHIFTCLIENTWRITE.1)', () => {
  const all = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f))
  const scanned = all.filter((f) => Number.parseInt(f, 10) >= SCAN_FROM && Number.parseInt(f, 10) !== CLOSED_MIGRATION)

  it('mig 676 is on disk and reopens nothing', () => {
    const file = all.find((f) => Number.parseInt(f, 10) === CLOSED_MIGRATION && /shift_tables_client_writes_off/.test(f))
    expect(file).toBe('676_shift_tables_client_writes_off.sql')
    expect(shiftWriteReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8'))).toEqual([])
  })

  it('the scan covers 646 and 668 (not vacuous)', () => {
    expect(scanned).toEqual(expect.arrayContaining(['646_shift_notes_column_grants.sql', '668_scheduling_tables_client_grants.sql']))
  })

  it.each(scanned)('%s gives no client role a write on the shift tables', (file) => {
    if (ROLLBACK_FILE.test(file) && Number.parseInt(file, 10) > CLOSED_MIGRATION) return
    expect(shiftWriteReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: this gives a browser or phone a write on shift_blocks/shift_assignments again (mig 676). Write through a service-role /api/schedule route`).toEqual([])
  })

  it('a SHIFTCLIENTWRITE.1 rollback migration is allow-listed by its file name, and nothing else is', () => {
    const exempt = (f) => ROLLBACK_FILE.test(f) && Number.parseInt(f, 10) > CLOSED_MIGRATION
    expect(exempt('677_shiftclientwrite1_rollback.sql')).toBe(true)
    for (const name of ['677_restore_shift_writes.sql', '677_shiftclientwrite1_rollback_and_more.sql',
      'shiftclientwrite1_rollback.sql', '675_shiftclientwrite1_rollback.sql', '677_shiftclientwrite1_rollback.sql.bak']) {
      expect(exempt(name), name).toBe(false)
    }
  })

  it.each([
    'GRANT INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments TO authenticated;',
    'GRANT UPDATE ON public.shift_assignments TO authenticated;',
    'GRANT UPDATE (arrived_at) ON public.shift_assignments TO authenticated;',
    'GRANT SELECT (id), INSERT (id) ON public.shift_blocks TO authenticated;',
    'GRANT SELECT ON public.shift_blocks TO authenticated;',
    'GRANT ALL ON "public"."shift_assignments" TO "authenticated" WITH GRANT OPTION;',
    'grant delete on table shift_blocks to authenticated;',
    'GRANT SELECT (id) ON public.shift_blocks TO anon;',
    'GRANT REFERENCES ON public.shift_assignments TO PUBLIC;',
    'GRANT INSERT ON ALL TABLES IN SCHEMA public TO authenticated;',
    `DO $$ BEGIN EXECUTE 'GRANT UPDATE ON public.shift_assignments TO authenticated'; END $$;`,
    `DO $$ BEGIN EXECUTE $q$GRANT DELETE ON public.shift_blocks TO authenticated$q$; END $$;`,
    'GRANT sneaky TO authenticated;',
    'CREATE POLICY shift_blocks_upd ON public.shift_blocks FOR UPDATE TO authenticated USING (true);',
    'CREATE POLICY "p" ON shift_assignments TO authenticated USING (true);',
    'CREATE POLICY p ON public.shift_assignments FOR INSERT TO authenticated WITH CHECK (true);',
    'ALTER TABLE public.shift_blocks DISABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.shift_assignments OWNER TO authenticated;',
    'ALTER TABLE public.shift_blocks_new RENAME TO shift_blocks;',
    'CREATE TABLE IF NOT EXISTS public.shift_assignments (id uuid);',
    // The rollback record reopens the writes: that is why it needs the name exemption.
    'GRANT INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments TO authenticated;\nCREATE POLICY "shift_blocks_ins" ON public.shift_blocks FOR INSERT TO authenticated WITH CHECK (true);',
  ])('the detector flags %s', (sql) => {
    expect(shiftWriteReopeners(sql)).not.toEqual([])
  })

  it.each([
    'GRANT SELECT (colour) ON public.shift_blocks TO authenticated;',
    'GRANT SELECT (id, block_date) ON public.shift_blocks TO authenticated;',
    'GRANT ALL ON public.shift_blocks, public.shift_assignments TO service_role;',
    'GRANT UPDATE ON public.shift_templates TO authenticated;',
    'GRANT UPDATE ON public.shift_blocks_archive TO authenticated;',
    'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
    'GRANT EXECUTE ON FUNCTION public.shift_blocks_x() TO authenticated;',
    'GRANT USAGE ON SCHEMA public TO authenticated;',
    'GRANT authenticated TO some_role;',
    'REVOKE INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments FROM authenticated;',
    'CREATE POLICY shift_blocks_select ON public.shift_blocks FOR SELECT TO authenticated USING (true);',
    'CREATE POLICY p ON public.shift_offers FOR UPDATE TO authenticated USING (true);',
    'ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.shift_blocks ADD COLUMN colour text;',
    'ALTER TABLE public.shift_blocks RENAME TO shift_blocks_old;',
    'CREATE TABLE public.shift_blocks_archive (id uuid);',
    'CREATE INDEX ON public.shift_assignments (block_id);',
    '-- GRANT UPDATE ON public.shift_assignments TO authenticated;',
    '/* GRANT ALL ON public.shift_blocks TO anon; */',
  ])('the detector passes %s', (sql) => {
    expect(shiftWriteReopeners(sql)).toEqual([])
  })

  it.each([
    ['a /* inside a string before a real grant', "SELECT '/* not a comment';\nGRANT UPDATE ON public.shift_assignments TO authenticated;"],
    ['a /* inside a -- comment before a real grant', '-- see migrations/*.sql\nGRANT DELETE ON public.shift_blocks TO authenticated;\n/* x */'],
    ['a /* inside a $$ string after a DO block', [
      'DO $$ BEGIN NULL; END $$;',
      'COMMENT ON TABLE public.shift_blocks IS $$ see /* $$;',
      'GRANT INSERT ON public.shift_assignments TO authenticated;',
      'COMMENT ON TABLE public.shift_blocks IS $$ */ $$;',
    ].join('\n')],
  ])('comments cannot hide a reopener: %s', (_, sql) => {
    expect(shiftWriteReopeners(sql)).not.toEqual([])
  })
})
