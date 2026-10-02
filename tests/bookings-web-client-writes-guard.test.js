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
