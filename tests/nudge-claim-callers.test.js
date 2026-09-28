// C21 PUSHDONE.1b — every member engagement push claims, sends and releases
// through sendNudgeOnce (src/lib/customer-nudge-claim.js). Five callers used
// to hand-roll the claim and ignore the send's result, so a push that reached
// nobody kept its claim and the nudge was lost. A source scan: a FLOOR, not
// proof (it cannot see a table name built at runtime). Tests may name the table,
// and any file may READ it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN = ['src', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build'])
const SOURCE = /\.(js|jsx|mjs)$/
const TEST = /\.test\.(js|jsx|mjs)$/
// Only WRITES are fenced: mig 296 says the ledger seeds a future member
// feed, so a read elsewhere is fine. A write is `.insert(` / `.update(` /
// `.upsert(` / `.delete(` in the same chain as `.from('customer_engagement_nudges')`
// (any quote, backticks included). The chain is read method by method with
// each call's arguments skipped by bracket depth; a comment inside the chain
// ends it, one more way this stays a floor.
const FROM = /\.from\(\s*(['"`])customer_engagement_nudges\1\s*\)/g
const METHOD = /\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/y
const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

function chainedMethods(source, at) {
  const names = []
  let i = at
  for (;;) {
    METHOD.lastIndex = i
    const m = METHOD.exec(source)
    if (!m) return names
    names.push(m[1])
    i = METHOD.lastIndex
    for (let depth = 1; i < source.length && depth > 0; i++) {
      const c = source[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
    }
  }
}

function writesNudgeLedger(source) {
  for (const m of source.matchAll(FROM)) {
    if (chainedMethods(source, m.index + m[0].length).some((name) => WRITES.has(name))) return true
  }
  return false
}
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
  it('no other production file writes the nudge ledger', () => {
    const touching = SCAN.flatMap((d) => walk(join(ROOT, d)))
      .filter((full) => writesNudgeLedger(readFileSync(full, 'utf8')))
      .map((full) => relative(ROOT, full).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
    expect(touching).toEqual([])
  }, SCAN_TIMEOUT_MS)
})

describe('writesNudgeLedger — writes are flagged, reads are not', () => {
  it('a read is allowed (mig 296: the ledger seeds a future member feed)', () => {
    expect(writesNudgeLedger("const { data } = await db.from('customer_engagement_nudges').select('id, type').eq('contact_id', id)")).toBe(false)
    expect(writesNudgeLedger("await db\n  .from(\"customer_engagement_nudges\")\n  .select('*')\n  .order('created_at')\nawait db.from('contacts').update({ a: 1 })")).toBe(false)
  })
  it.each([
    ['insert', "await db.from('customer_engagement_nudges').insert({ contact_id: c, type: 't', dedup_key: k })"],
    ['update', "await db\n  .from('customer_engagement_nudges')\n  .update({ type: 'x' })\n  .eq('id', id)"],
    ['upsert', "await db.from(\"customer_engagement_nudges\").upsert({ contact_id: c }, { onConflict: 'contact_id,type,dedup_key' })"],
    ['delete', "await db.from('customer_engagement_nudges').delete().eq('id', id)"],
    ['a write after a filter', "await db.from('customer_engagement_nudges').select('id').eq('a', f(1, 2)).delete()"],
    ['a backtick table name', "await db.from(`customer_engagement_nudges`).insert({ contact_id: c })"],
  ])('%s is flagged', (_name, source) => {
    expect(writesNudgeLedger(source)).toBe(true)
  })
})
