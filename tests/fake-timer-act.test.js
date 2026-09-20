// A component test that moves the fake clock OUTSIDE act() is reading the DOM
// on a race it usually wins.
//
// `vi.useFakeTimers()` fakes the timers the COMPONENT uses. It does not fake
// the ones React uses to render: React's Scheduler captures the real
// `setImmediate` and the real `performance` object when it is first imported,
// long before any test installs a fake clock. So a state update that happens
// outside act() — every update made from a timer callback, a resolved fetch, or
// the tail of an `async` handler after its first `await` — is rendered by the
// real Scheduler, in real time, whenever the real event loop gets to it.
//
// `await vi.advanceTimersByTimeAsync(n)` yields to that event loop a FIXED
// number of times (once, plus once per fake timer it fires). On an idle machine
// that is enough, which is why the pattern looks fine. It stops being enough
// when the Scheduler yields to the host first — and it does that on the REAL
// clock, after any task that overruns its 5ms frame budget. It also yields after
// every commit, so the previous render's passive-effect flush is always still
// queued ahead of the next render: one GC pause or one preempted worker inside
// that flush moves the render a macrotask later, the advance resolves first,
// and the next `getBy*` reads the DOM from before the update.
//
// That is exactly how `CampaignEditor.test.jsx` failed ONE test of 26,023 in the
// EAS Update gate for 77b92f39 (2026-09-20) and cost that merge its OTA until
// the workflow was re-run by hand. It was the only component test in the repo
// advancing the clock bare; every other one already wrote
// `await act(async () => { await vi.advanceTimersByTimeAsync(n) })`. Inside
// act() React queues its work on the act queue instead of the Scheduler and
// drains it before act resolves — no frame budget, no hop count, nothing to
// lose to. Because the idiom was a habit rather than a rule, one file missed
// it. This file is the rule.
//
// Not the fix: a longer wait, a second `advanceTimersByTimeAsync(0)`, a retry.
// Each is just more hops. And not `findBy*`/`waitFor` under a plain
// `vi.useFakeTimers()` — RTL's async wrapper awaits a `setTimeout(0)` on the
// FAKED clock and never returns, so the test dies at its 5000ms budget. (The
// files that do mix them install the clock with `{ shouldAdvanceTime: true }`,
// which leaks real elapsed time into the fake clock: fine for a 30s poll, wrong
// for a test that counts debounced calls. They still advance inside act.)
//
// It reads source, so it is a FLOOR, not proof: "inside act(" is judged by
// counting parentheses back to the nearest `act(`, which errs toward silence
// (a stray "(" in a string between a closed act() and the call hides it), and a
// helper that advances the clock on the test's behalf is judged where the
// helper is written, not where it is called.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Every vitest call that moves the fake clock, sync or async.
const CLOCK_MOVE = /\bvi\s*\.\s*(advanceTimersByTime|advanceTimersToNextTimer|advanceTimersToNextFrame|runAllTimers|runOnlyPendingTimers|runAllTicks)(Async)?\s*\(/g

// A bare clock move is fine when NOTHING React renders is read after it. Each
// entry says why, keyed `file:snippet` so an entry cannot outlive its call.
const BARE_OK = {
  'src/components/communications/useUnlayerEditor.test.jsx:advanceTimersByTimeAsync(3000)':
    'Drives the export TIMEOUT so a returned promise rejects; the assertion is on that promise, not on hook state or the DOM.',
}

/** Tracked component test files that render through React Testing Library. */
function componentTestFiles() {
  // Fixed argv, no shell — same reader as tests/test-timeout-budgets.test.js.
  return execFileSync('git', ['ls-files', '*.test.jsx', '*.test.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => file !== 'tests/fake-timer-act.test.js')
    .filter((file) => /@testing-library\/react/.test(readFileSync(`${ROOT}${file}`, 'utf8')))
}

/** Source with comments blanked (same length, same line numbers). */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

/** Is the call at `index` inside the parentheses of the nearest preceding act( ? */
export function isInsideAct(source, index) {
  const before = source.slice(0, index)
  const opener = /\bact\s*\(/g
  let last = -1
  for (let m = opener.exec(before); m; m = opener.exec(before)) last = m.index + m[0].length
  if (last === -1) return false
  let depth = 1
  for (const ch of before.slice(last)) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth === 0) return false   // that act( closed before we got here
  }
  return true
}

/** Every bare clock move in a source string: [{ line, snippet }] */
export function bareClockMoves(rawSource) {
  const source = withoutComments(rawSource)
  const found = []
  for (const m of source.matchAll(CLOCK_MOVE)) {
    if (isInsideAct(source, m.index)) continue
    const line = source.slice(0, m.index).split('\n').length
    const rest = source.slice(m.index)
    const snippet = rest.slice(rest.indexOf('.') + 1, rest.indexOf(')') + 1).replace(/\s+/g, '')
    found.push({ line, snippet })
  }
  return found
}

describe('the detector itself', () => {
  it('sees a bare advance', () => {
    expect(bareClockMoves('await vi.advanceTimersByTimeAsync(0)\nscreen.getByRole("button")'))
      .toEqual([{ line: 1, snippet: 'advanceTimersByTimeAsync(0)' }])
  })

  it('accepts the house idiom, on one line or several', () => {
    expect(bareClockMoves('await act(async () => { await vi.advanceTimersByTimeAsync(0) })')).toEqual([])
    expect(bareClockMoves('await act(async () => {\n  release()\n  await vi.advanceTimersByTimeAsync(30_000)\n})')).toEqual([])
  })

  it('accepts a helper that wraps the advance in act', () => {
    expect(bareClockMoves('const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })')).toEqual([])
  })

  it('is not fooled by an act() that already closed', () => {
    expect(bareClockMoves('await act(async () => { click() })\nawait vi.advanceTimersByTimeAsync(0)'))
      .toEqual([{ line: 2, snippet: 'advanceTimersByTimeAsync(0)' }])
  })

  it('ignores a call that only appears in a comment', () => {
    expect(bareClockMoves('// await vi.advanceTimersByTimeAsync(0) was the bug\n/* vi.runAllTimers() */')).toEqual([])
  })

  it('covers the whole clock-moving family', () => {
    expect(bareClockMoves('vi.runAllTimers()\nawait vi.runOnlyPendingTimersAsync()\nvi.advanceTimersToNextTimer()').map((f) => f.line))
      .toEqual([1, 2, 3])
  })
})

describe('a component test never moves the fake clock outside act()', () => {
  const files = componentTestFiles()

  it('finds the component tests at all', () => {
    // A glob that silently matches nothing would make the rule below vacuous.
    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain('src/components/CampaignEditor.test.jsx')
  })

  it('every clock move is inside act(), or listed in BARE_OK with a reason', () => {
    const offenders = []
    for (const file of files) {
      for (const { line, snippet } of bareClockMoves(readFileSync(`${ROOT}${file}`, 'utf8'))) {
        if (BARE_OK[`${file}:${snippet}`]) continue
        offenders.push(`${file}:${line}  vi.${snippet}`)
      }
    }
    expect(offenders, [
      'These component tests move the fake clock OUTSIDE act(). React renders the',
      'resulting updates on its real Scheduler, so the next DOM read races the render',
      'and loses on a loaded runner. Write',
      '  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })',
      'or, if nothing React renders is read afterwards, add the call to BARE_OK in',
      'tests/fake-timer-act.test.js with the reason.',
      '',
      ...offenders,
    ].join('\n')).toEqual([])
  })

  it('has no stale BARE_OK entry', () => {
    const live = new Set()
    for (const file of files) {
      for (const { snippet } of bareClockMoves(readFileSync(`${ROOT}${file}`, 'utf8'))) live.add(`${file}:${snippet}`)
    }
    expect(Object.keys(BARE_OK).filter((key) => !live.has(key))).toEqual([])
  })
})
