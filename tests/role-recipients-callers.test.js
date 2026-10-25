// C1 RECIPIENTS.1 — resolveRoleRecipientIds turned a FAILED "who holds these
// roles here" read into [], which every caller read as "nobody to tell". Every
// caller moved to readRoleRecipientIds ({ ids, error }), and D1 DEADCODE.1
// deleted the old helper and its contract test. Nothing may name it again.
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
// collection, and each test only matches. Each file is tested against every
// name as it is read and only the PATHS that name one are kept: holding the
// text itself pinned ~39 MB of source for the life of the file.
const SCAN_TIMEOUT_MS = 30_000
const NAMES = ['resolveRoleRecipientIds', 'resolveLocationMemberIds']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE.test(entry.name)) out.push(full)
  }
  return out
}

// name -> the repo-relative paths whose source names it.
const HITS = (() => {
  const patterns = NAMES.map((name) => [name, new RegExp(`\\b${name}\\b`)])
  const hits = Object.fromEntries(NAMES.map((name) => [name, []]))
  for (const full of SCAN.flatMap((d) => walk(join(ROOT, d)))) {
    const text = readFileSync(full, 'utf8')
    const rel = relative(ROOT, full).split(sep).join('/')
    for (const [name, re] of patterns) if (re.test(text)) hits[name].push(rel)
  }
  return hits
})()

function namers(name, allowed) {
  return HITS[name].filter((rel) => !allowed.has(rel))
}

describe('the swallowed-error recipient readers have no callers (C1 RECIPIENTS.1)', () => {
  it('nothing names resolveRoleRecipientIds (deleted by D1 DEADCODE.1)', () => {
    expect(namers('resolveRoleRecipientIds', new Set([SELF]))).toEqual([])
  }, SCAN_TIMEOUT_MS)

  it('nothing names resolveLocationMemberIds (replaced by readLocationMemberIds)', () => {
    // push.js keeps the old name in the replacement's docstring (a pointer
    // for whoever greps for it); nothing else may name it.
    expect(namers('resolveLocationMemberIds', new Set([SELF, 'src/lib/push.js']))).toEqual([])
  }, SCAN_TIMEOUT_MS)
})
