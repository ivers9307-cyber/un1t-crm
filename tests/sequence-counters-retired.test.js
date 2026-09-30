// SEQCOUNTERS.1 — email_sequences.total_enrolled / total_completed /
// total_exited were never maintained (the increment_sequence_* RPCs the code
// called never existed; every call 404'd and the { error } was dropped), and
// mig 663 marks them DEPRECATED. Enrolment numbers are counted from
// sequence_enrollments. This fails if any source file under src/, shared/ or
// mobile/ names such an RPC or a counter again.
//
// It scans the RAW source, comments included. A comment stripper is a
// parser, and a regex one is wrong: a `/*` inside a string (accept="image/*")
// or inside a `//` comment ("the /api/* routes") swallowed everything up to
// the next `*/`, hiding ~50 files from an earlier version of this guard. A
// comment that must mention a retired name spells it so it does not match.
//
// total_completed etc. are matched repo-wide, not only next to
// email_sequences, because only email_sequences has columns by these names
// today. If another table gains one, narrow the pattern and say why here.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ROOTS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', '.next', 'ios', 'android'])
const RETIRED = [/increment_sequence_/, /\btotal_(enrolled|completed|exited)\b/]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.test\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const namesRetired = (src) => RETIRED.some((re) => re.test(src))

describe('sequence counters stay retired (SEQCOUNTERS.1)', () => {
  const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('no source names an increment_sequence_* rpc or a total_enrolled / total_completed / total_exited counter', () => {
    const hits = files.filter((f) => namesRetired(readFileSync(f, 'utf8')))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  // openapi.js is the measured case: its `// the /api/shelly/* request
  // vocabulary` comment opened a "block comment" that a regex stripper closed
  // thousands of lines later. Inject in the middle of the file (inside that
  // span) and near the end; the guard's own matcher must see both.
  it('canary: reads injected into a big real file with /* in its comments are still seen', () => {
    const real = readFileSync(path.join(ROOT, 'src/lib/openapi.js'), 'utf8')
    const lines = real.split('\n')
    expect(lines.length).toBeGreaterThan(5000)
    for (const at of [Math.floor(lines.length / 4), lines.length - 5]) {
      const copy = [...lines]
      copy.splice(at, 0, "seq.total_enrolled; db.rpc('increment_sequence_completed')")
      const injected = copy.join('\n')
      for (const re of RETIRED) expect(injected).toMatch(re)
      expect(namesRetired(injected)).toBe(true)
    }
    expect(namesRetired(real)).toBe(false)
  })
})
