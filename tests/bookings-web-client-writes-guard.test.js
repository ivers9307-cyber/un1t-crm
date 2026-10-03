// C134 WEBBOOKINGWRITES.1 — no web browser code writes `bookings`.
//
// A browser-client write is judged by RLS, and the bookings write policies
// judge the PHONE `bookings` key, so a person with web Bookings but not the
// phone toggle had their status and skip-reminder toggles fail in silence.
// Web writes go through service-role routes that judge the WEB key at the
// booking's studio (POST /api/bookings/[id]/status, /skip-reminder, /cancel).
// This pins that no client file under src/ (a 'use client' file, or one that
// calls createBrowserClient()) chains a write onto .from('bookings'). A floor,
// not a proof: a table name in a variable, or a chain split across
// statements, is invisible. mobile/ is out of scope (the phone keeps its own
// key, and RLS is its rule).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'
import { codeOf, isClientFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.(js|jsx)$/.test(name)) out.push(full)
  }
  return out
}
// A client file (tests/helpers/js-code.js isClientFile: 'use client', a
// browser/auth client, or the anon key), read with comments blanked, so a
// comment that names createBrowserClient or a bookings write is not code.
const BOOKINGS_WRITE = /\.from\(\s*['"]bookings['"]\s*\)[\s\S]{0,300}?\.(update|insert|upsert|delete)\(/

describe('no web client code writes bookings (C134)', () => {
  it('the detector sees the old shape', () => {
    expect(BOOKINGS_WRITE.test("const db = createBrowserClient()\nawait db.from('bookings').update({ status }).eq('id', id)")).toBe(true)
    expect(BOOKINGS_WRITE.test("await db.from('bookings')\n  .update({ skip_reminder: next })\n  .eq('id', bookingId)")).toBe(true)
    expect(BOOKINGS_WRITE.test("await db.from('bookings').select('id').eq('id', id)")).toBe(false)
  })

  it('finds none under src/', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .filter((f) => { const s = readFileSync(f, 'utf8'); return isClientFile(s) && BOOKINGS_WRITE.test(codeOf(s, f)) })
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})

// C138 (e), mig 701 — and the table is closed to client writes: no client role
// may write bookings, the phone keeps its read (bookings_select). So client-
// bound code anywhere (mobile/, shared/, desktop/, not only src/) must not
// write it or name a raw /rest/v1/bookings URL, and no migration after 701 may
// give a client role a write on it or add a write policy. The one exemption is
// a rollback file named `<NNN>_bookingclientwrites_rollback.sql`.
const CLOSED_MIGRATION = 701
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations')
const migNum = (f) => Number((/^(\d+)/.exec(f) || [])[1])
function walkAny(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'ios', 'android', 'dist', 'web-build'].includes(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walkAny(full, out)
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name) && !/\.test\.(js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const RAW_URL = /\/rest\/v1\/bookings\b/
const CLIENT_WRITE_GRANT = /\bGRANT\s+[^;]*?\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b[^;]*?\bON\s+(TABLE\s+)?(public\.)?"?bookings"?\b[^;]*?\bTO\s+[^;]*?\b(anon|authenticated|PUBLIC)\b/i
const ALL_TABLES_GRANT = /\bGRANT\s+[^;]*?\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*?\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\b[^;]*?\bTO\s+[^;]*?\b(anon|authenticated|PUBLIC)\b/i
const WRITE_POLICY = /\bCREATE\s+POLICY\s+[^;]*?\bON\s+(public\.)?"?bookings"?\b(?![^;]*?\bFOR\s+SELECT\b)[^;]*;/i
const RLS_OFF = /\bALTER\s+TABLE\s+[^;]*?(public\.)?"?bookings"?\b[^;]*?\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i

describe('bookings stays closed to client writes (C138 e, mig 701)', () => {
  it('the migration that closes it exists', () => {
    expect(readdirSync(MIG_DIR).some((f) => migNum(f) === CLOSED_MIGRATION && /bookings_client_writes_closed/.test(f))).toBe(true)
  })

  it('no client-bound file in mobile/, shared/ or desktop/ writes bookings or names its raw REST URL', () => {
    const offenders = ['mobile', 'shared', 'desktop']
      .filter((d) => { try { return statSync(path.join(ROOT, d)).isDirectory() } catch { return false } })
      .flatMap((d) => walkAny(path.join(ROOT, d)))
      .filter((f) => { const s = readFileSync(f, 'utf8'); return BOOKINGS_WRITE.test(s) || RAW_URL.test(s) })
      .map((f) => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('no later migration reopens a client write (grant, ALL TABLES grant, write policy, RLS off)', () => {
    const offenders = []
    for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && migNum(x) > CLOSED_MIGRATION)) {
      if (/^\d+_bookingclientwrites_rollback\.sql$/.test(f)) continue
      const code = sqlCode(readFileSync(path.join(MIG_DIR, f), 'utf8'))
      for (const [name, re] of [['grant', CLIENT_WRITE_GRANT], ['all-tables grant', ALL_TABLES_GRANT], ['write policy', WRITE_POLICY], ['rls off', RLS_OFF]]) {
        if (re.test(code)) offenders.push(`${f}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the detectors see the shapes', () => {
    expect(CLIENT_WRITE_GRANT.test('GRANT INSERT, UPDATE ON public.bookings TO authenticated;')).toBe(true)
    expect(CLIENT_WRITE_GRANT.test('GRANT ALL ON TABLE bookings TO anon;')).toBe(true)
    expect(CLIENT_WRITE_GRANT.test('GRANT SELECT ON public.bookings TO authenticated;')).toBe(false)
    expect(CLIENT_WRITE_GRANT.test('GRANT INSERT ON public.bookings TO service_role;')).toBe(false)
    expect(CLIENT_WRITE_GRANT.test('GRANT INSERT ON public.booking_reminder_sends TO authenticated;')).toBe(false)
    expect(WRITE_POLICY.test('CREATE POLICY x ON public.bookings FOR UPDATE TO authenticated USING (true);')).toBe(true)
    expect(WRITE_POLICY.test('CREATE POLICY x ON public.bookings TO authenticated USING (true);')).toBe(true)
    expect(WRITE_POLICY.test('CREATE POLICY x ON public.bookings FOR SELECT TO authenticated USING (true);')).toBe(false)
    expect(RLS_OFF.test('ALTER TABLE public.bookings DISABLE ROW LEVEL SECURITY;')).toBe(true)
    expect(RAW_URL.test('fetch(`${url}/rest/v1/bookings?id=eq.1`, { method: "PATCH" })')).toBe(true)
  })
})
