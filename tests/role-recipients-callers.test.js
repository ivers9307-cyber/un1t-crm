// C1 RECIPIENTS.1 — resolveRoleRecipientIds turned a FAILED "who holds these
// roles here" read into [], which every caller read as "nobody to tell". Every
// caller moved to readRoleRecipientIds ({ ids, error }). The old helper stays
// in src/lib/push.js for ONE deploy (@deprecated), and D1 DEADCODE.1 deletes
// it with its one contract test; then shrink ALLOWED to this file alone.
//
// resolveLocationMemberIds had the same shape (error discarded, [] on a failed
// read) and was replaced outright by readLocationMemberIds in the same PR; it
// has no allowance at all.
//
// A source scan, so a FLOOR not proof: it cannot see a caller that builds the
// name at runtime. The behavioural proof is in push-roles.test.js,
// push-dedup.test.js and each migrated caller's own suite.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared', 'mobile', 'scripts', 'tests']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const SELF = 'tests/role-recipients-callers.test.js'
// ~4,400 files: a loaded runner took >5 s, so the tree is read once, at
// collection, and each test only matches.
const SCAN_TIMEOUT_MS = 30_000

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE.test(entry.name)) out.push(full)
  }
  return out
}

const SOURCES = SCAN
  .flatMap((d) => walk(join(ROOT, d)))
  .map((full) => ({ rel: relative(ROOT, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }))

function namers(name, allowed) {
  const re = new RegExp(`\\b${name}\\b`)
  return SOURCES.filter(({ rel, text }) => !allowed.has(rel) && re.test(text)).map(({ rel }) => rel)
}

describe('the swallowed-error recipient readers have no callers (C1 RECIPIENTS.1)', () => {
  it('nothing outside its own definition and test names resolveRoleRecipientIds', () => {
    const allowed = new Set([
      'src/lib/push.js', // the @deprecated definition, until D1 DEADCODE.1
      'src/lib/push.test.js', // its old-contract test, deleted with it
      SELF,
    ])
    expect(namers('resolveRoleRecipientIds', allowed)).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('nothing names resolveLocationMemberIds (replaced by readLocationMemberIds)', () => {
    // push.js keeps the old name in the replacement's docstring (a pointer
    // for whoever greps for it); nothing else may name it.
    expect(namers('resolveLocationMemberIds', new Set([SELF, 'src/lib/push.js']))).toEqual([])
  }, SCAN_TIMEOUT_MS)
})
