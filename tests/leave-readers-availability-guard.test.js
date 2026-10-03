// AVAIL.3 D1 (Richard, 3 Oct 2026: "treat like leave") — every reader that
// asks "is this person off on this date" from APPROVED time off must also see
// all-day dated availability ("I can't work 11-13 Oct"), because that is
// where an Unavailable time-off request lives now (mig 703 moves the old ones
// across). The one rule is shared/unavailable-days.js; the server loader is
// src/lib/availability-leave.js.
//
// This fails a non-test file that reads time_off_requests with
// .eq('status', 'approved') unless it imports one of the two, or is listed in
// EXEMPT with the reason it is not asking "is this person off". It is a
// floor, not a proof: a reader that filters status some other way, or holds
// its select in another module, is invisible to it.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN = ['src', 'shared', 'mobile/lib', 'mobile/app', 'mobile/components']

const EXEMPT = {
  'src/app/api/schedule/time-off/[id]/route.js':
    'decides a time-off REQUEST (allowance, clashing shifts of that request)',
  'src/app/api/schedule/time-off/[id]/cancel-request/route.js':
    'a coach asking to cancel their own approved request',
  'src/lib/candidates-data.js':
    'CANDIDATES.1 already reads staff_unavailability itself and ranks it as its own state (on_leave vs unavailable)',
}

// Readers whose approved filter is not a literal .eq('status', 'approved')
// (the scan cannot see them), held to the same rule by name.
const ALSO_READERS = [
  'src/lib/report-generator.js', // fetchOverlappingTimeOff(..., status: 'approved'): roster coverage + time-off summary
]

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx)$/.test(e.name) && !/\.test\.(m?js|jsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)))
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const readsApprovedTimeOff = (src) =>
  /from\(\s*['"]time_off_requests['"]\s*\)/.test(src) && /\.eq\(\s*['"]status['"]\s*,\s*['"]approved['"]\s*\)/.test(src)
const usesTheRule = (src) => /from\s+['"][^'"]*(availability-leave|unavailable-days)['"]/.test(src)

const readers = [...new Set([
  ...files.filter((f) => readsApprovedTimeOff(fs.readFileSync(f, 'utf8'))).map(rel),
  ...ALSO_READERS,
])]

describe('readers of approved time off also see all-day availability (AVAIL.3 D1)', () => {
  it('finds the readers (the scan is not blind)', () => {
    expect(readers).toEqual(expect.arrayContaining(['src/lib/roster-copy.js', 'src/lib/roster-publish.js', 'src/lib/shift-reminders.js']))
  })

  it.each(readers)('%s uses shared/unavailable-days or src/lib/availability-leave, or is exempt', (file) => {
    if (EXEMPT[file]) return
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    expect(usesTheRule(src), `${file} reads approved time off but not availability: append readAvailabilityLeave/withAvailabilityLeave (src/lib/availability-leave.js) and decide with shared/unavailable-days, or add it to EXEMPT with a reason`).toBe(true)
  })

  it('every exemption still names a reader (no stale entries)', () => {
    for (const f of Object.keys(EXEMPT)) expect(readers, `${f} no longer reads approved time off: drop it from EXEMPT`).toContain(f)
  })
})
