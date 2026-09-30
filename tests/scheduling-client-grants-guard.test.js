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
//     client grant on ALL TABLES IN SCHEMA public. A GRANT inside EXECUTE
//     '…' counts. The one exemption is a rollback migration named
//     `<NNN>_grantsweep1_rollback.sql`.
//  3. A migration after 668 fails when it creates a policy on
//     staff_attendance_events, or a write policy (FOR ALL/INSERT/UPDATE/
//     DELETE, or no FOR, which means ALL) on the two read-only tables; or
//     when it CREATE TABLEs any of the five names in public (the default ACL
//     re-grants ALL to anon and authenticated). No exemption for the table.
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
  const code = codeOf(text, file).trimStart()
  return /^['"]use client['"]/.test(code) || /\bcreateBrowserClient\b/.test(code) ||
    /\bcreateAuthClient\s*\(/.test(code) || /\bNEXT_PUBLIC_SUPABASE_ANON_KEY\b/.test(code)
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => isClientFile(readFileSync(f, 'utf8'), f))
  return [...phone, ...browser]
}

/** PostgREST reads/writes/unresolved selects on the three tables in one file's code. */
export const scanUses = (text, file) => columnUses(codeOf(text, file), SCANNED, FK_ALIASES)
const readUses = (f) => scanUses(readFileSync(f, 'utf8'), f)
const uses = scanUses

describe('client code and the scheduling tables (GRANTSWEEP.1)', () => {
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
  for (const m of code.matchAll(/\bgrant\s+([^;']+?)\s+on\s+([^;']+?)\s+to\s+([^;']+?)(?:;|'|$)/gi)) {
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
  const createRe = /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$."])/gi
  for (const m of code.matchAll(createRe)) if (ANON_NONE_TABLES.includes(m[1].toLowerCase())) hits.push(m[0].trim())
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
    expect(grantsweepReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8'))).toEqual([])
  })

  it.each(later.length ? later : ['(none yet)'])('%s: gives no client back what mig 668 took', (file) => {
    if (file === '(none yet)' || isGrantsweepRollback(file)) return
    expect(grantsweepReopeners(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: this reopens a scheduling table to a browser or phone (mig 668). Serve it through a service-role /api route`).toEqual([])
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
