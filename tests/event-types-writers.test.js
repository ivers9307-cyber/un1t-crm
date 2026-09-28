// EVENTTYPERLS.1 — every writer of event_types is a guarded server route.
//
// The booking-type form used to write event_types with the BROWSER client, and
// RLS (event_types_location_scoped, FOR ALL) admitted any member of the
// studio, staff included. The form now saves through the two routes below;
// mig 650 takes INSERT/UPDATE/DELETE off anon + authenticated, so a new
// browser or phone writer would fail at runtime with 42501 — this catches it
// at review instead.
//
// supabase-js puts the mutation FIRST after .from(): .from('event_types')
// .insert/.update/.upsert/.delete. A builder held in a variable is the blind
// spot (a floor, not a proof). The list is EXACT: a new writer fails, and so
// does one that disappears (update the list in the PR that moves it).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const WRITE = /\.from\(\s*['"]event_types['"]\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/g

function files(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(full))
    else if (/\.(m?js|jsx|ts|tsx)$/.test(e.name) && !/\.test\.(js|jsx|ts|tsx)$/.test(e.name)) out.push(full)
  }
  return out
}

function writers(dirs) {
  const out = []
  for (const d of dirs) {
    for (const f of files(path.join(ROOT, d))) {
      for (const m of stripComments(fs.readFileSync(f, 'utf8')).matchAll(WRITE)) {
        out.push(`${path.relative(ROOT, f).split(path.sep).join('/')} ${m[1]}`)
      }
    }
  }
  return out.sort()
}

describe('EVENTTYPERLS.1 — event_types writers', () => {
  it('only the two booking-type routes write event_types (service role, judged at the studio)', () => {
    expect(writers(['src', 'shared', 'scripts', 'supabase/functions'])).toEqual([
      'src/app/api/bookings/event-types/[id]/route.js update', // PUT
      'src/app/api/bookings/event-types/[id]/route.js update', // DELETE (soft: active=false)
      'src/app/api/bookings/event-types/route.js insert',      // POST
    ])
  })

  it('the phone writes no event_types (it only embeds name/colour through bookings)', () => {
    expect(writers(['mobile'])).toEqual([])
  })
})
