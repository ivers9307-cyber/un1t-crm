// tests/staff-tombstone-readers.test.js
// STAFFDELETE.1 — a permanently deleted staff member keeps a `profiles` row.
// Any read that LISTS profiles with no id / active / email filter would show
// it in a picker or count it. This sweep finds every such read under src/ and
// fails unless it goes through excludeTombstones() — the same shape as
// check:ota-paths: a NEW unfiltered list cannot be added without deciding.
//
// A FLOOR, NOT A PROOF (same posture as check:select-columns): it reads one
// statement's text. A chain built across variables is judged on what it can
// see, and a list filtered only by something else (`.eq('role', …)`) does NOT
// count as safe — a deleted master keeps role='master'.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// A read is safe when it cannot return a tombstone: pinned to ids the caller
// already holds, active-only (DB CHECK: a tombstone is never active), matched
// on an email (a tombstone's is scrambled), a write, or explicitly guarded.
const SAFE = /isTombstone\(|\.eq\('id'|\.in\('id'|\.neq\('id'|\.eq\('active', true\)|\.ilike\('email'|\.update\(|\.insert\(|\.upsert\(|\.delete\(/
const WRAPPED = /excludeTombstones\(\s*[\w.\s]*$/

// Reads that are allowed to see tombstones, each with a reason.
const ALLOW = {}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.|test-helpers/.test(name)) out.push(p)
  }
  return out
}

export function unguardedProfileLists(root) {
  const hits = []
  for (const file of walk(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8')
    let i = -1
    while ((i = src.indexOf("from('profiles')", i + 1)) !== -1) {
      if (WRAPPED.test(src.slice(Math.max(0, i - 60), i))) continue
      const tail = src.slice(i, i + 400)
      const next = tail.indexOf('.from(', 10)
      const chain = next === -1 ? tail : tail.slice(0, next)
      if (SAFE.test(chain)) continue
      const key = `${file.slice(root.length + 1)}:${src.slice(0, i).split('\n').length}`
      if (!ALLOW[key]) hits.push(key)
    }
  }
  return hits.sort()
}

describe('every unfiltered profiles list excludes tombstones', () => {
  it('no read of `profiles` can list a permanently deleted staff member', () => {
    expect(
      unguardedProfileLists(repo),
      'A `from(\'profiles\')` read has no id / active / email filter and is not wrapped in excludeTombstones() ' +
      '(src/lib/staff-tombstone.js). Wrap it — `excludeTombstones(db.from(\'profiles\').select(…))` — or add it to ALLOW with a reason.',
    ).toEqual([])
  })
  it('every ALLOW entry carries a reason', () => {
    for (const [key, why] of Object.entries(ALLOW)) expect(why, key).toMatch(/\S{10,}/)
  })
})
