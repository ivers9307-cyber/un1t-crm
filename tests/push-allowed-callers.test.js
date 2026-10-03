// C16 PUSHREADERR.1 — resolvePushAllowedIds returns an empty Set on a FAILED
// read, which a caller reads as "nobody may be told". Production code uses
// readPushAllowedIds ({ allowed, error, templatesError }); the old helper keeps
// its contract for the tests that pin the permission tiers (push.test.js) and
// is not to be called again. A source scan: a FLOOR, not proof (it cannot see
// a name built at runtime). Test files and mocks may name it; comments that
// mention it without calling it do not match.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared', 'mobile', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const TEST = /\.test\.(js|jsx|mjs)$/
const CALL = /\bresolvePushAllowedIds\s*\(/
const ALLOWED = new Set(['src/lib/push.js']) // its definition
const SCAN_TIMEOUT_MS = 30_000

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(full)
  }
  return out
}

describe('no production code calls resolvePushAllowedIds (C16 PUSHREADERR.1)', () => {
  it('every permission read that feeds a send uses readPushAllowedIds', () => {
    const callers = SCAN.flatMap((d) => walk(join(ROOT, d)))
      .filter((full) => CALL.test(readFileSync(full, 'utf8')))
      .map((full) => relative(ROOT, full).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
    expect(callers).toEqual([])
  }, SCAN_TIMEOUT_MS)
})
