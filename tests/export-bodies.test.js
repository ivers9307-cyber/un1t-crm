// PAIRSYNC.1 — pin the extractor that tests/shared-pair-sync.test.js reads
// duplicated modules with.
//
// The sync guard is only worth as much as this: if exportBodies() quietly
// returned {} for a file, every pair would compare "no exports to no exports"
// and the guard would pass forever while the copies rotted. So the extractor
// gets its own tests, including the ones that prove it does NOT silently
// under-report.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportBodies, collectExportNames } from '../scripts/lib/export-bodies.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repo = join(__dirname, '..')

describe('exportBodies — what it captures', () => {
  it('slices a function declaration to its own closing brace, not to the next export', () => {
    const src = [
      'export function a() {',
      '  return 1',
      '}',
      '',
      'function privateHelper() { return 2 }',
      '',
      'export function b() {',
      '  return 3',
      '}',
      '',
    ].join('\n')
    const out = exportBodies(src)
    expect(out.a).toBe('export function a() { return 1 }')
    expect(out.b).toBe('export function b() { return 3 }')
    // The private helper between them belongs to neither.
    expect(out.a).not.toContain('privateHelper')
  })

  it('handles a single-line const with no brackets at all', () => {
    const out = exportBodies("export const VERSION = 1\nexport const NAME = 'x'\n")
    expect(out.VERSION).toBe('export const VERSION = 1')
    expect(out.NAME).toBe("export const NAME = 'x'")
  })

  it('handles a multi-line object/array literal', () => {
    const src = ['export const T = [', "  { slug: 'a' },", "  { slug: 'b' },", ']', 'const after = 1', ''].join('\n')
    expect(exportBodies(src).T).toBe("export const T = [ { slug: 'a' }, { slug: 'b' }, ]")
  })

  it('does not let brackets inside a string move the depth counter', () => {
    const src = ['export function f() {', "  return '}'", '}', 'const after = 1', ''].join('\n')
    expect(exportBodies(src).f).toBe("export function f() { return '}' }")
    expect(exportBodies(src).f).not.toContain('after')
  })

  it('strips comments, so a reworded header is not drift', () => {
    const a = exportBodies('// canonical copy\nexport const X = 1\n')
    const b = exportBodies('// KEEP IN SYNC — champ-app is canon\nexport const X = 1\n')
    expect(a.X).toBe(b.X)
  })

  it('collapses whitespace, so reindenting is not drift', () => {
    const a = exportBodies('export function f() {\n  return 1\n}\n')
    const b = exportBodies('export function f() {\n    return 1\n}\n')
    expect(a.f).toBe(b.f)
  })

  it('DOES see a changed token — the whole point', () => {
    const a = exportBodies('export function f() {\n  return 1\n}\n')
    const b = exportBodies('export function f() {\n  return 2\n}\n')
    expect(a.f).not.toBe(b.f)
  })
})

describe('collectExportNames', () => {
  it('picks up declarations, export lists and aliased re-exports', () => {
    const src = ["export const A = 1", "export { B, C as D } from './x'", 'export function E() {}', ''].join('\n')
    expect(collectExportNames(src)).toEqual(['A', 'B', 'D', 'E'])
  })

  it("reports `export *` as '*' rather than pretending the module exports nothing", () => {
    expect(collectExportNames("export * from '@shared/x'\n")).toEqual(['*'])
  })
})

describe('exportBodies — against the real tree, so it cannot silently no-op', () => {
  // A regression that made the extractor return {} would make the pair guard
  // vacuous. These are the real files it is pointed at.
  const cases = [
    ['shared/tiers.js', ['TIERS', 'tierForMonths', 'nextTier']],
    ['src/lib/tiers.js', ['TIERS', 'tierForMonths', 'nextTier', 'tierWindowMonths', 'shiftMonthKey', 'windowedMonthsHit']],
    ['shared/hr-analytics.js', ['buildSessionAnalytics', 'currentStreak', 'weeklyStreak']],
    ['shared/zone-colors.js', ['ZONE_COLORS_DARK', 'zoneColorDark']],
  ]
  for (const [file, expected] of cases) {
    it(`finds every named export in ${file}`, () => {
      const found = Object.keys(exportBodies(readFileSync(join(repo, file), 'utf8')))
      for (const name of expected) expect(found).toContain(name)
      expect(found.length).toBeGreaterThan(0)
    })
  }

  it('reads the TIERS ladder as one slice, colours and all', () => {
    const body = exportBodies(readFileSync(join(repo, 'shared/tiers.js'), 'utf8')).TIERS
    expect(body).toContain('bronze')
    expect(body).toContain('elite')
    expect(body).toContain('#ff5a1f')
    // and stops there — the function below it is a separate slice.
    expect(body).not.toContain('tierForMonths')
  })
})
