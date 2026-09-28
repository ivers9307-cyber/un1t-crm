// C21 PUSHDONE.1b — every member engagement push claims, sends and releases
// through sendNudgeOnce (src/lib/customer-nudge-claim.js). Five callers used
// to hand-roll the claim and ignore the send's result, so a push that reached
// nobody kept its claim and the nudge was lost. A source scan: a FLOOR, not
// proof (it cannot see a table name built at runtime). Tests may name the table.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const TEST = /\.test\.(js|jsx|mjs)$/
const TOUCH = /\.from\(\s*['"]customer_engagement_nudges['"]\s*\)/
const ALLOWED = new Set(['src/lib/customer-nudge-claim.js'])
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

describe('customer_engagement_nudges is written only by customer-nudge-claim.js (C21 PUSHDONE.1b)', () => {
  it('no other production file touches the nudge ledger', () => {
    const touching = SCAN.flatMap((d) => walk(join(ROOT, d)))
      .filter((full) => TOUCH.test(readFileSync(full, 'utf8')))
      .map((full) => relative(ROOT, full).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
    expect(touching).toEqual([])
  }, SCAN_TIMEOUT_MS)
})
