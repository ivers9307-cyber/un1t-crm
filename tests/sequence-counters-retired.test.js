// SEQCOUNTERS.1 — email_sequences.total_enrolled / total_completed /
// total_exited were never maintained (the increment_sequence_* RPCs the code
// called never existed; every call 404'd and the { error } was dropped), and
// mig 663 marks them DEPRECATED. Enrolment numbers are counted from
// sequence_enrollments. This fails if code (comments stripped) under src/,
// shared/ or mobile/ calls such an RPC or reads a counter again.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ROOTS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', '.next', 'ios', 'android'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('sequence counters stay retired (SEQCOUNTERS.1)', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('no code calls an increment_sequence_* rpc', () => {
    const hits = files.filter((f) => /increment_sequence_/.test(strip(readFileSync(f, 'utf8'))))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  it('no code reads or writes total_enrolled / total_completed / total_exited', () => {
    const hits = files.filter((f) => /\btotal_(enrolled|completed|exited)\b/.test(strip(readFileSync(f, 'utf8'))))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
  })
})
