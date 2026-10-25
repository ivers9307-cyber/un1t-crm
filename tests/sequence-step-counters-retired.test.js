// STEPSENTRPC.1 — sequence_steps.total_sent / total_opened / total_clicked
// were never maintained: the only writer was rpc('increment_step_sent'),
// a function that never existed (every call 404'd; the resolved { error } was
// dropped), and nothing ever wrote the open/click pair. Every step row still
// reads 0 (43 of 43, 30 Sep 2026), and a graph publish replaces every step
// row anyway, so a per-step counter could never have held history. Per-step
// email numbers are counted from email_sends (GET /api/sequences/[id]/stats).
//
// The names are shared with live counters on campaigns, broadcasts and
// templates, so this cannot be a repo-wide word search: it pins that the code
// that owns sequences (comments masked) never names them, so nobody starts
// reading a column that has only ever said 0. check:rpc-names separately
// stops the phantom call coming back.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { maskComments } from '../scripts/check-select-columns.mjs'
import { walkSources } from '../scripts/check-rpc-names.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SEQUENCE_DIRS = [
  'src/lib/sequences',
  'src/app/api/sequences',
  'src/components/automations',
  'src/components/sequences',
  'src/app/(marketing)/automations',
]
const STEP_COUNTER = /\btotal_(?:sent|opened|clicked)\b/

describe('sequence step counters stay retired (STEPSENTRPC.1)', () => {
  const files = SEQUENCE_DIRS.flatMap((d) => walkSources(path.join(ROOT, d)))

  it('scans the sequence code', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith(path.join('sequences', 'steps.js')))).toBe(true)
  })

  it('no sequence code reads or writes total_sent / total_opened / total_clicked', () => {
    const hits = files.filter((f) => STEP_COUNTER.test(maskComments(fs.readFileSync(f, 'utf8'))))
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  it('bites: the pattern sees a read, and not a comment', () => {
    expect(STEP_COUNTER.test(maskComments('const n = step.total_sent'))).toBe(true)
    expect(STEP_COUNTER.test(maskComments('// step.total_sent never moved'))).toBe(false)
  })
})
