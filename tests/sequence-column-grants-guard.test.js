// PROFILESPREAD.1b guard (mig 654). A signed-in client session may SELECT 27
// columns of email_sequences (never webhook_token / webhook_secret, never
// `*`) and read sequence_steps / sequence_enrollments, and may write none of
// the three (tests/helpers/sequence-column-grants.js). Pinned here:
//  1. Client-run code (shared/, mobile/, and every src/ file that is
//     'use client' or imports createBrowserClient) names granted
//     email_sequences columns only, and never writes the three tables.
//     PostgREST refuses the WHOLE select (42501) when one column is withheld,
//     and every client write is now a 42501. A select on the three tables
//     that the scanner cannot evaluate fails closed.
//  2. A migration after 654 that ADDs a column to email_sequences decides its
//     grant (`GRANT SELECT (<col>) ON public.email_sequences TO authenticated`
//     or `-- column-grant: withheld email_sequences.<col>`), and the helper
//     lists it.
//  3. A migration after 654 fails when it grants, to a client role (by name,
//     PUBLIC, or ALL TABLES IN SCHEMA public): anything at all to anon or
//     PUBLIC on the three tables; a table-level privilege on email_sequences;
//     a table-level WRITE on sequence_steps / sequence_enrollments; any
//     column-level privilege other than SELECT on the three; or a column-level
//     SELECT naming a withheld email_sequences column. The one exemption is a
//     rollback migration named `<NNN>_profilespread1b_rollback.sql` (its body
//     is mig 654's header ROLLBACK).
//  4. A migration after 654 that CREATE TABLEs one of the three names in
//     public fails (the default ACL would re-grant ALL to anon and
//     authenticated). No exemption.
// What the scanner reads is SECFIX.3c's (tests/helpers/postgrest-column-uses.js):
// every link of a `.from()` chain, a literal or same-file-const select, embeds
// by table name or through ANY FK column into the three tables (derived from
// the migrations: sequence_id, sequence_step_id, dunning_sequence_id at 654),
// `.or()`/`.and()` trees, dotted filters. Still a floor, not a proof:
// `.from(<variable>)`, a chain split across statements and an unevaluable
// select on ANOTHER table are invisible. Server code (service_role) is not
// checked because it bypasses grants.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  EMAIL_SEQUENCES_SELECT, EMAIL_SEQUENCES_WITHHELD, READ_ONLY_TABLES, SEQUENCE_TABLES, SEQUENCE_GRANT_MIGRATION,
} from './helpers/sequence-column-grants.js'
import { columnUses, fkAliasesInto } from './helpers/postgrest-column-uses.js'
import { collectSchema } from '../scripts/check-select-columns.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const MIG_DIR = path.join(ROOT, 'supabase/migrations')
const FK_ALIASES = fkAliasesInto(collectSchema(MIG_DIR).fks, SEQUENCE_TABLES)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

function clientFiles() {
  const phone = [...walk(path.join(ROOT, 'shared')), ...walk(path.join(ROOT, 'mobile'))]
  const browser = walk(path.join(ROOT, 'src')).filter((f) => {
    const t = readFileSync(f, 'utf8')
    return /^\s*['"]use client['"]/.test(t) || /\bcreateBrowserClient\b/.test(t)
  })
  return [...phone, ...browser]
}

const uses = (src) => columnUses(src, SEQUENCE_TABLES, FK_ALIASES)
const readable = (table, col) =>
  READ_ONLY_TABLES.includes(table) || (col !== '*' && EMAIL_SEQUENCES_SELECT.includes(col))

describe('client code and the sequence tables (PROFILESPREAD.1b)', () => {
  const files = clientFiles()

  it('scans the client files it is meant to (not vacuous)', () => {
    const rel = files.map((f) => path.relative(ROOT, f))
    expect(rel).toEqual(expect.arrayContaining([
      'shared/dashboard-data.js', 'src/components/contact/ContactDrawer.jsx',
      'src/components/automations/AutomationPerformance.jsx',
    ]))
    expect(rel.some((f) => f.startsWith('mobile/app/'))).toBe(true)
    expect(FK_ALIASES).toMatchObject({
      sequence_id: 'email_sequences', sequence_step_id: 'sequence_steps', dunning_sequence_id: 'email_sequences',
    })
  })

  it('reads only granted email_sequences columns (never `*`, never a webhook credential)', () => {
    const offenders = []
    for (const f of files) {
      for (const [t, c] of uses(readFileSync(f, 'utf8')).reads) {
        if (!readable(t, c)) offenders.push(`${path.relative(ROOT, f)}: ${t}.${c}`)
      }
    }
    expect(offenders, 'read it through a service-role /api route, or grant the column in a migration').toEqual([])
  })

  it('every select on a sequence table is readable (fail closed)', () => {
    // A select the scanner cannot evaluate could name any column (or embed
    // email_sequences(webhook_secret)), so it is an offender unless reviewed
    // by hand and listed here as `<file>: <table> <arg text>`.
    const REVIEWED_DYNAMIC_SELECTS = []
    const unread = []
    for (const f of files) {
      for (const [t, arg] of uses(readFileSync(f, 'utf8')).unresolved) {
        const key = `${path.relative(ROOT, f)}: ${t} ${arg}`
        if (!REVIEWED_DYNAMIC_SELECTS.includes(key)) unread.push(key)
      }
    }
    expect(unread, 'name the columns in a literal or a same-file const, or review it and list it').toEqual([])
  })

  it('writes none of the three tables (mig 654 grants no client write)', () => {
    const writes = []
    for (const f of files) {
      for (const [t, op] of uses(readFileSync(f, 'utf8')).writes) writes.push(`${path.relative(ROOT, f)}: ${op} on ${t}`)
    }
    expect(writes, 'write through a service-role /api/sequences route').toEqual([])
  })

  it('the scanner sees the forms it must', () => {
    const r = (src) => uses(src).reads.map(([t, c]) => `${t}.${c}`)
    expect(r(`db.from('email_sequences').select('id, webhook_secret')`)).toEqual(['email_sequences.id', 'email_sequences.webhook_secret'])
    expect(r(`db.from('email_sequences').select()`)).toContain('email_sequences.*')
    expect(r(`db.from('sequence_enrollments').select('id, email_sequences ( name, webhook_token )')`))
      .toEqual(expect.arrayContaining(['email_sequences.name', 'email_sequences.webhook_token']))
    expect(r(`db.from('email_sends').select('id, seq:sequence_id ( webhook_secret )')`)).toContain('email_sequences.webhook_secret')
    expect(r(`db.from('locations').select('id, dunning_sequence_id ( webhook_token )')`)).toContain('email_sequences.webhook_token')
    expect(r(`db.from('email_sequences').select('id').or('webhook_token.is.null,name.eq.x')`)).toContain('email_sequences.webhook_token')
    expect(r(`const S = 'id, webhook_secret'\ndb.from('email_sequences').select(S)`)).toContain('email_sequences.webhook_secret')
    expect(uses(`function f(c) { return db.from('email_sequences').select(c) }`).unresolved).toEqual([['email_sequences', 'c']])
    expect(uses(`db.from('sequence_steps').update({ subject: 'x' }).eq('id', i)`).writes).toEqual([['sequence_steps', 'update']])
    expect(uses(`db.from('sequence_enrollments').insert(row)`).writes).toEqual([['sequence_enrollments', 'insert']])
    expect(uses(`db.from('email_sequences').delete().eq('id', i)`).writes).toEqual([['email_sequences', 'delete']])
    // …and the granted forms pass.
    for (const [t, c] of uses(`db.from('email_sequences').select('id, name, status')
      db.from('sequence_steps').select('*')`).reads) expect(readable(t, c), `${t}.${c}`).toBe(true)
  })
})

// ── migrations after 654 ──────────────────────────────────────────────
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

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const CLIENT_ROLES = ['authenticated', 'anon', 'public']

/**
 * Every GRANT to a client role (authenticated, anon, PUBLIC) that reopens what
 * mig 654 closed:
 *  - anything at all to anon or PUBLIC on the three tables;
 *  - for authenticated, a table-level privilege on email_sequences, a
 *    table-level privilege other than SELECT on the two children, any
 *    column-level privilege other than SELECT on the three, or a column-level
 *    SELECT naming an EMAIL_SEQUENCES_WITHHELD column;
 *  - any privilege on ALL TABLES IN SCHEMA public.
 * A column-level SELECT of a non-withheld column is how a new column is
 * granted on purpose, so it passes (the column-add check judges it). Comments
 * are ignored; a GRANT inside EXECUTE '…' is not.
 */
function clientTableGrants(sql) {
  const hits = []
  for (const m of stripComments(sql).matchAll(/\bgrant\s+([^;']+?)\s+on\s+([^;']+?)\s+to\s+([^;']+?)(?:;|'|$)/gi)) {
    const [stmt, privs, target, to] = m
    const grantees = splitTop(to.replace(/\s+(with\s+grant\s+option|granted\s+by\b)[\s\S]*$/i, '')).map(ident)
    if (!grantees.some((g) => CLIENT_ROLES.includes(g))) continue
    const all = target.match(/^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i)
    if (all) { if (splitTop(all[1]).map(ident).includes('public')) hits.push(stmt.trim()); continue }
    // An object-type keyword needs its trailing space: `sequence_steps` is a
    // table, `SEQUENCE foo` is not.
    if (/^(sequence|function|procedure|routine|schema|database|foreign|large|language|tablespace|type|domain|all)\s/i.test(target.trim())) continue
    const tables = splitTop(target.replace(/^\s*table\s+/i, '')).map((t) => ident(t).replace(/^public\./, ''))
      .filter((t) => SEQUENCE_TABLES.includes(t))
    if (!tables.length) continue
    if (grantees.some((g) => g === 'anon' || g === 'public')) { hits.push(stmt.trim()); continue }
    const reopens = splitTop(privs).some((p) => {
      const col = p.match(/^([a-z\s]+?)\s*\(([\s\S]*)\)$/i)
      const name = (col ? col[1] : p).toLowerCase().replace(/\s+/g, ' ').trim()
      if (!col) return tables.includes('email_sequences') || name !== 'select'
      if (name !== 'select') return true
      return tables.includes('email_sequences') && splitTop(col[2]).map(ident).some((c) => EMAIL_SEQUENCES_WITHHELD.includes(c))
    })
    if (reopens) hits.push(stmt.trim())
  }
  return hits
}

/**
 * Every CREATE TABLE of one of the three names in schema public. A re-created
 * table takes the schema's default ACL (on Supabase, ALL for anon and
 * authenticated), so it silently undoes every grant mig 654 made.
 */
function recreatedSequenceTables(sql) {
  const re = /\bcreate\s+(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$."])/gi
  return [...stripComments(sql).matchAll(re)].map((m) => m[1].toLowerCase()).filter((t) => SEQUENCE_TABLES.includes(t))
}

// ROLLING BACK mig 654: forward-only, so the rollback is a NEW migration named
// `<NNN>_profilespread1b_rollback.sql` (NNN > 654). That exact name is exempt
// from the table-level-grant check below and from nothing else.
const isProfilespread1bRollback = (file) =>
  /^\d+_profilespread1b_rollback\.sql$/.test(file) && Number.parseInt(file, 10) > SEQUENCE_GRANT_MIGRATION

function addedSequenceColumns(sql) {
  const code = stripComments(sql)
  return [...code.matchAll(/alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\.)?"?email_sequences"?\s([\s\S]*?);/gi)]
    .flatMap((m) => [...m[1].matchAll(/add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)].map((c) => c[1]))
    .filter((c) => !['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(c.toLowerCase()))
}

const decided = (sql, col) =>
  new RegExp(`grant\\s+select\\s*\\([^)]*\\b${col}\\b[^)]*\\)\\s*on\\s+(?:table\\s+)?(?:"?public"?\\s*\\.\\s*)?"?email_sequences"?\\s+to\\s+"?authenticated"?`, 'i').test(stripComments(sql))
  || new RegExp(`--\\s*column-grant:\\s*withheld\\s+email_sequences\\.${col}\\b`, 'i').test(sql)

describe('later migrations keep the sequence grants (PROFILESPREAD.1b)', () => {
  const all = readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f))
  const later = all.filter((f) => Number.parseInt(f, 10) > SEQUENCE_GRANT_MIGRATION)

  it('mig 654 itself is on disk, grants no client privilege it forbids and re-creates no table', () => {
    const file = all.find((f) => Number.parseInt(f, 10) === SEQUENCE_GRANT_MIGRATION && /email_sequences_column_grants/.test(f))
    expect(file).toBe('654_email_sequences_column_grants.sql')
    const sql = readFileSync(path.join(MIG_DIR, file), 'utf8')
    expect(clientTableGrants(sql)).toEqual([])
    expect(recreatedSequenceTables(sql)).toEqual([])
    // Its header ROLLBACK is exactly what the check below would flag (so the
    // rollback file needs the name exemption, and nothing else gets it).
    const rollback = sql.match(/^-- ROLLBACK:[\s\S]*?^--\s+BEGIN;\n([\s\S]*?^--\s+COMMIT;)$/m)[1].replace(/^--\s?/gm, '')
    expect(clientTableGrants(rollback)).toHaveLength(1)
  })

  it.each(later.length ? later : ['(none yet)'])('%s: a new email_sequences column is granted or withheld on purpose', (file) => {
    if (file === '(none yet)') return
    const sql = readFileSync(path.join(MIG_DIR, file), 'utf8')
    for (const col of addedSequenceColumns(sql)) {
      expect(decided(sql, col), `${file} adds email_sequences.${col}: GRANT SELECT (${col}) ON public.email_sequences TO authenticated, or "-- column-grant: withheld email_sequences.${col}"`).toBe(true)
      expect([...EMAIL_SEQUENCES_SELECT, ...EMAIL_SEQUENCES_WITHHELD], `add ${col} to tests/helpers/sequence-column-grants.js`).toContain(col)
    }
  })

  it.each(later.length ? later : ['(none yet)'])('%s: no client grant that reopens mig 654', (file) => {
    if (file === '(none yet)' || isProfilespread1bRollback(file)) return
    expect(clientTableGrants(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: this reopens the webhook secrets or a client write (mig 654). Grant non-withheld columns SELECT to authenticated only`).toEqual([])
  })

  it.each(later.length ? later : ['(none yet)'])('%s: does not re-create a sequence table', (file) => {
    if (file === '(none yet)') return
    expect(recreatedSequenceTables(readFileSync(path.join(MIG_DIR, file), 'utf8')),
      `${file}: a re-created table takes the default ACL (ALL for anon + authenticated) and undoes mig 654`).toEqual([])
  })

  it('a PROFILESPREAD.1b rollback migration is allow-listed by its file name, and nothing else is', () => {
    expect(isProfilespread1bRollback('655_profilespread1b_rollback.sql')).toBe(true)
    for (const name of ['655_restore_sequence_grants.sql', '655_profilespread1b_rollback_and_more.sql',
      'profilespread1b_rollback.sql', '653_profilespread1b_rollback.sql', '655_profilespread1b_rollback.sql.bak']) {
      expect(isProfilespread1bRollback(name), name).toBe(false)
    }
  })

  it('the column-add detector sees an added column and accepts either decision', () => {
    const undecided = 'ALTER TABLE public.email_sequences ADD COLUMN signing_key text;'
    expect(addedSequenceColumns(undecided)).toEqual(['signing_key'])
    expect(addedSequenceColumns('alter table if exists "public"."email_sequences" add column if not exists foo text, add bar int;'))
      .toEqual(['foo', 'bar'])
    expect(addedSequenceColumns('ALTER TABLE public.email_sequences ADD CONSTRAINT x CHECK (true);')).toEqual([])
    expect(addedSequenceColumns('ALTER TABLE public.email_sequences_archive ADD COLUMN foo text;')).toEqual([])
    expect(decided(undecided, 'signing_key')).toBe(false)
    expect(decided(`${undecided}\n-- column-grant: withheld email_sequences.signing_key`, 'signing_key')).toBe(true)
    expect(decided(`${undecided}\nGRANT SELECT (signing_key) ON public.email_sequences TO authenticated;`, 'signing_key')).toBe(true)
  })

  it('the table-level detector catches every reopening form and passes the safe ones', () => {
    const bad = [
      'GRANT SELECT ON public.email_sequences TO authenticated;',
      'grant all on table email_sequences to anon;',
      'GRANT UPDATE ON "public"."email_sequences" TO PUBLIC;',
      'GRANT UPDATE ON public.sequence_steps TO authenticated;',
      'GRANT INSERT, SELECT ON public.sequence_enrollments TO authenticated;',
      'GRANT ALL ON public.sequence_steps, public.sequence_enrollments TO anon, authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;',
      `DO $$ BEGIN EXECUTE 'GRANT DELETE ON public.sequence_enrollments TO authenticated'; END $$;`,
    ]
    for (const sql of bad) expect(clientTableGrants(sql), sql).not.toEqual([])
    const ok = [
      'GRANT SELECT (id, name) ON public.email_sequences TO authenticated;',
      'GRANT SELECT ON public.sequence_steps, public.sequence_enrollments TO authenticated;',
      'GRANT ALL ON public.email_sequences TO service_role;',
      'GRANT UPDATE ON public.email_sends TO authenticated;',
      'GRANT SELECT ON ALL TABLES IN SCHEMA private TO authenticated;',
      'REVOKE ALL ON public.email_sequences FROM authenticated, anon;',
      '-- rollback: GRANT ALL ON public.email_sequences TO authenticated;',
    ]
    for (const sql of ok) expect(clientTableGrants(sql), sql).toEqual([])
  })

  // Column-level grants reopen mig 654 just as well: a SELECT naming a
  // withheld column, any column-level write, and anything at all to anon or
  // PUBLIC on the three tables.
  it.each([
    'GRANT SELECT (webhook_secret) ON public.email_sequences TO authenticated;',
    'GRANT SELECT (id, webhook_token) ON TABLE "public"."email_sequences" TO authenticated;',
    'GRANT UPDATE (status, graph) ON email_sequences TO authenticated;',
    'GRANT INSERT (sequence_id, contact_id) ON sequence_enrollments TO authenticated;',
    'GRANT UPDATE (subject) ON public.sequence_steps TO authenticated;',
    'GRANT REFERENCES (id) ON public.email_sequences TO authenticated;',
    'GRANT ALL (name) ON public.email_sequences TO authenticated;',
    'GRANT SELECT (id), UPDATE (status) ON public.email_sequences TO authenticated;',
    'GRANT SELECT ON public.sequence_steps TO anon;',
    'GRANT SELECT ON public.sequence_enrollments TO PUBLIC;',
    'GRANT SELECT (id, name) ON public.email_sequences TO anon;',
    'GRANT SELECT (id) ON public.sequence_steps TO public;',
    'GRANT UPDATE ON sequence_steps TO authenticated;',
  ])('the grant detector flags %s', (sql) => {
    expect(clientTableGrants(sql)).not.toEqual([])
  })

  it.each([
    'GRANT SELECT (id) ON public.sequence_steps TO authenticated;',
    'GRANT SELECT (signing_key) ON "public"."email_sequences" TO authenticated;',
    'GRANT SELECT ON public.email_sends TO anon;',
    'GRANT UPDATE (status) ON public.email_sequences TO service_role;',
    'GRANT USAGE ON SEQUENCE public.sequence_steps_id_seq TO authenticated;',
  ])('the grant detector passes %s', (sql) => {
    expect(clientTableGrants(sql)).toEqual([])
  })

  // A re-created table gets the schema's default ACL, which on Supabase is
  // ALL for anon + authenticated: every grant mig 654 revoked, back at once.
  it.each([
    'CREATE TABLE public.email_sequences (id uuid PRIMARY KEY);',
    'create table if not exists "public"."sequence_steps" (id uuid);',
    'CREATE UNLOGGED TABLE sequence_enrollments (id uuid);',
  ])('the create-table detector flags %s', (sql) => {
    expect(recreatedSequenceTables(sql)).not.toEqual([])
  })

  it.each([
    'CREATE TABLE public.email_sequences_archive (id uuid);',
    'CREATE TABLE private.email_sequences (id uuid);',
    '-- CREATE TABLE public.email_sequences (id uuid);',
    '/* CREATE TABLE public.sequence_steps (id uuid); */',
    'CREATE INDEX ON public.email_sequences (status);',
  ])('the create-table detector passes %s', (sql) => {
    expect(recreatedSequenceTables(sql)).toEqual([])
  })

  it.each([
    ['a comment before the table name', 'ALTER TABLE /* why */ public.email_sequences ADD COLUMN signing_key text;', ['signing_key']],
    ['a comment holding a semicolon', 'ALTER TABLE public.email_sequences ADD /* ; */ COLUMN signing_key text;', ['signing_key']],
    ['a commented-out ALTER', '/* ALTER TABLE public.email_sequences ADD COLUMN ghost text; */', []],
  ])('the column-add detector reads /* */ comments: %s', (_, sql, cols) => {
    expect(addedSequenceColumns(sql)).toEqual(cols)
  })

  it.each([
    ['a quoted "public"."email_sequences"', 'GRANT SELECT (signing_key) ON "public"."email_sequences" TO authenticated;', true],
    ['quoted names throughout', 'GRANT SELECT ("signing_key") ON TABLE "public"."email_sequences" TO "authenticated";', true],
    ['a commented-out grant', '-- GRANT SELECT (signing_key) ON public.email_sequences TO authenticated;', false],
    ['a grant in a /* */ block', '/* GRANT SELECT (signing_key) ON public.email_sequences TO authenticated; */', false],
  ])('decided() reads %s', (_, sql, want) => {
    expect(decided(`ALTER TABLE public.email_sequences ADD COLUMN signing_key text;\n${sql}`, 'signing_key')).toBe(want)
  })
})
