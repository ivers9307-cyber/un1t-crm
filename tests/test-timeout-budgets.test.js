// A test that declares a wait longer than its own budget can never reach it.
//
// vitest's per-test timeout defaults to 5000ms and nothing in vitest.config.js
// raises it. So `await waitFor(fn, { timeout: 8000 })` inside a test is a
// budget the runner will never honour: the TEST aborts at 5000ms first, and
// the failure reads "Test timed out in 5000ms" — which looks like a broken
// assertion rather than a starved one. Proven by construction: an inner
// 5000ms wait under a 1000ms test budget fails at 1000ms.
//
// The consequence is a flake that cannot be reproduced. On an idle machine the
// waits resolve in a tenth of a second and the file passes in isolation
// forever; under a full-suite run, with many jsdom environments competing for
// the box, the cumulative time crosses the budget and the test dies. That is
// exactly what `ScheduleCalendar.errors.test.jsx` did — intermittently red in
// CI, green every time anyone looked at it.
//
// 🔴 THIS ESTATE ALREADY FIXED THIS ONCE AND DID NOT WRITE IT DOWN.
// `AudienceCount.test.jsx` carries a `vi.setConfig` and a comment recording
// that it "went flaky roughly 1 run in 8 before these were widened" — the same
// diagnosis, reached the same way, months earlier. Because the fix stayed a
// local patch rather than a rule, the next file to declare a generous wait
// inherited the same latent flake. This file is the rule.
//
// It reads the DECLARED numbers, not the elapsed ones, so it is deterministic
// and costs nothing: a file may declare whatever waits it likes, as long as it
// also declares a budget that can accommodate them.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// vitest's own default. If vitest.config.js ever sets `test.testTimeout`, this
// must move with it — the assertion below is only meaningful against the
// budget that actually applies.
const DEFAULT_TEST_TIMEOUT = 5000

/** Every tracked test file, via git so nothing untracked or ignored is read. */
function testFiles() {
  return execFileSync('git', ['ls-files', '*.test.js', '*.test.jsx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

/** The largest `timeout: N` a file declares for a wait, or 0. */
function largestDeclaredWait(source) {
  let max = 0
  for (const m of source.matchAll(/\btimeout:\s*(\d+)/g)) {
    // `vi.setConfig({ testTimeout: N })` is the budget, not a wait — the
    // property name differs, so this regex does not match it.
    max = Math.max(max, Number(m[1]))
  }
  return max
}

/** The budget the file sets for itself, or 0 when it relies on the default. */
function declaredBudget(source) {
  let max = 0
  for (const m of source.matchAll(/testTimeout:\s*(\d+)/g)) max = Math.max(max, Number(m[1]))
  return max
}

describe('a test file never declares a wait it cannot afford', () => {
  it('every file with a long wait also raises its own budget', () => {
    const offenders = []
    for (const file of testFiles()) {
      const source = readFileSync(`${ROOT}${file}`, 'utf8')
      const wait = largestDeclaredWait(source)
      if (wait === 0) continue
      const budget = declaredBudget(source) || DEFAULT_TEST_TIMEOUT
      // Strictly greater: a wait EQUAL to the budget is the pathological case
      // — the runner and the wait race, and the runner always wins.
      if (wait >= budget) {
        offenders.push(`${file}: declares a ${wait}ms wait under a ${budget}ms test budget`)
      }
    }
    expect(offenders, [
      'These files declare a wait their own test budget cannot reach, so the wait',
      'is never honoured and the file is an unreproducible flake under load.',
      'Fix: add `vi.setConfig({ testTimeout: N })` at file scope, above the sum',
      'of the waits the file declares.',
      '',
      ...offenders,
    ].join('\n')).toEqual([])
  })

  it('detects the shape it exists to catch', () => {
    // The scan is only worth having if it fires, so prove both directions on
    // synthetic sources rather than trusting the repo to stay clean.
    const bad = "await waitFor(fn, { timeout: 8000 })"
    expect(largestDeclaredWait(bad)).toBe(8000)
    expect(declaredBudget(bad) || DEFAULT_TEST_TIMEOUT).toBe(DEFAULT_TEST_TIMEOUT)

    const good = "vi.setConfig({ testTimeout: 20000 })\nawait waitFor(fn, { timeout: 8000 })"
    expect(largestDeclaredWait(good)).toBe(8000)
    expect(declaredBudget(good)).toBe(20000)
  })

  it('does not mistake the budget itself for a wait', () => {
    // `testTimeout: N` must not be read as a declared wait, or every fixed
    // file would immediately re-offend against its own budget.
    expect(largestDeclaredWait('vi.setConfig({ testTimeout: 20000 })')).toBe(0)
  })
})
