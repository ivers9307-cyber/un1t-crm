// tests/glofox-settings-readers.test.js
// REGISTRYREAD.1 — glofoxCredentialsForLocation answers a FAILED settings
// read with every credential null AND `readError` set. A caller that only
// asks missingGlofoxCredentialsForLocation() still reads that as "Glofox is
// not configured here". So every file that calls it must decide: it mentions
// `readError` (it handles the failure), or it is listed in LOG_ONLY with the
// reason today's reading is acceptable. A NEW caller fails this test until
// someone decides; a LOG_ONLY entry that no longer applies fails too.
//
// A FLOOR, NOT A PROOF: it judges the file, not each call site.
//
// REGISTRYREAD.1a — the call match takes ANY first argument (a caller
// holding its client as `supabase`/`admin`/`this.db` was invisible when it
// required `db`), HANDLES requires a property read (`.readError`, not the
// bare word), and both run on comment-stripped source: a JSDoc line naming
// the helper is not a call, and a comment mentioning readError is not
// handling it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CALL = /(?<!function\s)glofoxCredentialsForLocation\(/
export const HANDLES = /\.readError\b/
const code = (p) => stripComments(readFileSync(p, 'utf8'))
const DEFINITION = 'src/lib/glofox.js'

// file → why "reads as not configured" is acceptable there. The helper's own
// logError is the signal for these.
export const LOG_ONLY = {
  'src/lib/agent/account-tools.js': 'get_my_payment_reminder returns the reminder with still_overdue unknown — its existing answer for "Glofox unreadable".',
  'src/lib/today-feed-data.js': 'the low-fill classes card is absent for one render.',
  // ── C9b REGISTRYREAD.1b handles these; each entry is removed as it lands ──
  'src/app/api/cron/glofox-arrears-reconcile/route.js': 'C9b',
  'src/app/api/cron/glofox-attendance-refresh/route.js': 'C9b',
  'src/app/api/cron/glofox-detail-backfill/route.js': 'C9b',
  'src/app/api/cron/glofox-sync/route.js': 'C9b',
  'src/app/api/cron/sync-class-occurrences/route.js': 'C9b',
  'src/lib/agent/booking-tools.js': 'C9b',
  'src/lib/agent/knowledge-import.js': 'C9b',
  'src/lib/dunning-payment.js': 'C9b',
  'src/lib/glofox-note-push.js': 'C9b',
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => relative(repo, p).split('\\').join('/')

export function undecidedCallers(root = repo) {
  const out = []
  for (const file of walk(join(root, 'src'))) {
    const r = rel(file)
    if (r === DEFINITION) continue
    const src = code(file)
    if (!CALL.test(src)) continue
    if (HANDLES.test(src) || LOG_ONLY[r]) continue
    out.push(r)
  }
  return out.sort()
}

describe('every glofoxCredentialsForLocation caller decides what a failed settings read means', () => {
  it('handles readError, or is LOG_ONLY with a reason', () => {
    expect(
      undecidedCallers(),
      'These files call glofoxCredentialsForLocation and never look at `readError`, so a DB blip reads as ' +
      '"Glofox is not configured". Handle it (retry / 503 / an honest code — see ' +
      'docs/superpowers/plans/2026-09-27-followups/C9-REGISTRYREAD.1.md) or add the file to LOG_ONLY with a reason.',
    ).toEqual([])
  })

  it('LOG_ONLY has no stale entries', () => {
    const stale = Object.keys(LOG_ONLY).filter((r) => {
      const p = join(repo, r)
      if (!existsSync(p)) return true
      const src = code(p)
      return !CALL.test(src) || HANDLES.test(src)
    })
    expect(stale, 'Remove these LOG_ONLY entries: the file no longer calls the helper, or now handles readError.').toEqual([])
  })

  it('the call match takes any first argument and ignores comments; HANDLES needs a property read', () => {
    expect(CALL.test('await glofoxCredentialsForLocation(supabase, id)')).toBe(true)
    expect(CALL.test('await glofoxCredentialsForLocation(this.db, id)')).toBe(true)
    expect(CALL.test('export async function glofoxCredentialsForLocation(db, id) {')).toBe(false)
    expect(CALL.test(stripComments('/**\n * @param {object} creds  glofoxCredentialsForLocation() result\n */\n'))).toBe(false)
    expect(HANDLES.test('if (creds?.readError) return')).toBe(true)
    expect(HANDLES.test('const readError = null')).toBe(false)
    expect(HANDLES.test(stripComments('// TODO: check creds.readError here\n'))).toBe(false)
  })

  it('nothing still calls the deleted silent reads', () => {
    const hits = walk(join(repo, 'src'))
      .filter((f) => /\bgetConnection\(|\bglofoxCredentialsByBranchId\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(hits).toEqual([])
  })
})
