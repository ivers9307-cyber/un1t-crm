// A component test that renders through React Testing Library must unmount
// what it rendered AFTER each test, not only before the next one.
//
// RTL only registers its own `afterEach(cleanup)` when the test runner exposes
// a global `afterEach`. This repo's vitest config has no `globals: true` and no
// setup file, so that never happens: every file that calls `render()` or
// `renderHook()` has to call `cleanup` itself.
//
// Calling it in `beforeEach` alone looks equivalent and is not. It unmounts the
// PREVIOUS test's tree, so every test but the last is covered, and the last
// test's tree is still mounted when vitest tears the jsdom environment down.
// If React's Scheduler still has work queued for that tree (a passive effect, a
// resolved promise from an async server component), it runs after `window` is
// gone and throws `ReferenceError: window is not defined` from
// react-dom-client. Vitest reports that as an UNHANDLED ERROR, which fails the
// run even though every test passed.
//
// That is exactly how CI run 36070079818 (PR #1746, 24 Sep 2026) failed with
// 26,818 of 26,818 tests green: the error was attributed to
// `src/app/communications/(marketing-era)/send/page.test.jsx`, one of six files
// that cleaned up only in beforeEach. It passes in isolation, so it reads as a
// flake; it is a race on teardown timing. 126 of the 134 RTL test files already
// wrote `afterEach(cleanup)` in some form. This file is the rule.
//
// It reads source, so it is a FLOOR, not proof: `cleanup` must appear inside
// the parentheses of an `afterEach(` call in the same file. A shared helper
// that registers the hook on the test's behalf is judged where it is written,
// and one registered inside a `describe` block still counts (it runs after
// each test of that block, which is where the renders are).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Tracked test files that import React Testing Library. */
function rtlTestFiles() {
  // Fixed argv, no shell: same reader as tests/fake-timer-act.test.js.
  return execFileSync('git', ['ls-files', '*.test.jsx', '*.test.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => file !== 'tests/rtl-cleanup-after-each.test.js')
    .filter((file) => /['"]@testing-library\/react['"]/.test(readFileSync(`${ROOT}${file}`, 'utf8')))
}

/** Source with comments blanked (same length, same line numbers). */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

/** Does the source mount anything through RTL? */
export function rendersThroughRtl(rawSource) {
  return /\b(render|renderHook)\s*\(/.test(withoutComments(rawSource))
}

/** Does some `afterEach( ... )` call contain `cleanup` inside its parentheses? */
export function cleansUpAfterEach(rawSource) {
  const source = withoutComments(rawSource)
  const opener = /\bafterEach\s*\(/g
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') depth -= 1
    }
    if (/\bcleanup\b/.test(source.slice(m.index, i))) return true
  }
  return false
}

describe('the detector itself', () => {
  it('accepts the house idioms', () => {
    expect(cleansUpAfterEach('afterEach(cleanup)')).toBe(true)
    expect(cleansUpAfterEach('afterEach(() => cleanup())')).toBe(true)
    expect(cleansUpAfterEach('afterEach(() => { cleanup(); vi.restoreAllMocks() })')).toBe(true)
    expect(cleansUpAfterEach('afterEach(() => {\n  vi.useRealTimers()\n  cleanup()\n})')).toBe(true)
  })

  it('rejects cleanup that only runs BEFORE each test', () => {
    expect(cleansUpAfterEach('beforeEach(() => { cleanup() })\nafterEach(() => { vi.restoreAllMocks() })')).toBe(false)
    expect(cleansUpAfterEach('beforeEach(() => cleanup())')).toBe(false)
  })

  it('is not fooled by a cleanup that sits after a closed afterEach', () => {
    expect(cleansUpAfterEach('afterEach(() => { vi.restoreAllMocks() })\nit("x", () => { cleanup() })')).toBe(false)
  })

  it('ignores cleanup mentioned only in a comment', () => {
    expect(cleansUpAfterEach('afterEach(() => { /* cleanup() was here */ vi.restoreAllMocks() })')).toBe(false)
    expect(cleansUpAfterEach('afterEach(() => {\n  // cleanup()\n})')).toBe(false)
  })

  it('knows what counts as rendering', () => {
    expect(rendersThroughRtl('render(<App />)')).toBe(true)
    expect(rendersThroughRtl('const { result } = renderHook(() => useX())')).toBe(true)
    expect(rendersThroughRtl('// render(<App />)\nscreen.getByText("x")')).toBe(false)
  })
})

describe('every RTL test file unmounts after each test', () => {
  const files = rtlTestFiles()

  it('finds the RTL test files (the scan is not empty)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('each file that renders calls cleanup inside an afterEach', () => {
    const offenders = files.filter((file) => {
      const source = readFileSync(`${ROOT}${file}`, 'utf8')
      return rendersThroughRtl(source) && !cleansUpAfterEach(source)
    })
    expect(offenders, `Add afterEach(cleanup) (import cleanup from '@testing-library/react'). See the header of tests/rtl-cleanup-after-each.test.js.`).toEqual([])
  })
})
