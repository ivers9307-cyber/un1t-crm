// TZ.18a/TZ.18b — the no-hardcoded-dublin-zone gate (scripts/check-dublin-zone.mjs).
// TZ.18b emptied and deleted the baseline: the ban is outright. The rule's own
// cases live in tests/guardrails-rules.test.js; these drive the gate end to end
// on fixture strings (the real flat config, allowlist and verdict).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DUBLIN_ZONE_ALLOW,
  createDublinZoneLinter,
  checkDublinZone,
  formatReport,
  failed,
} from '../scripts/check-dublin-zone.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const linter = createDublinZoneLinter(ROOT)

// Lint virtual files ({ 'src/x.js': code }) through the gate's real config.
async function lintFixtures(files) {
  const results = []
  for (const [rel, code] of Object.entries(files)) {
    const out = await linter.lintText(code, { filePath: path.join(ROOT, rel), warnIgnored: false })
    for (const r of out) results.push({ filePath: rel, messages: r.messages })
  }
  return results
}
const verdict = async (files) => checkDublinZone({ results: await lintFixtures(files) })

const LITERAL = "export const tz = loc.timezone || 'Europe/Dublin'\n"
const IMPORT = "import { dublinTodayStr } from '@/lib/dublin-time'\nexport const t = dublinTodayStr()\n"
const CLEAN = "import { todayStrIn } from '@/lib/location-time'\nexport const t = (zone) => todayStrIn(zone)\n"

describe('TZ.18b gate: what fails', () => {
  it('a source file that names the zone fails, with its line', async () => {
    const v = await verdict({ 'src/lib/new-feature.js': LITERAL })
    expect(v.offenders).toStrictEqual([
      { file: 'src/lib/new-feature.js', messages: [expect.objectContaining({ line: 1 })] },
    ])
    expect(failed(v)).toBe(true)
    expect(formatReport(v)).toContain('src/lib/new-feature.js:1:')
  })

  it('a dublin-time import fails, in src/, mobile/ and shared/', async () => {
    const v = await verdict({
      'mobile/app/(staff)/new-screen.jsx': "import { dublinDateKey } from '../../lib/dublin-time'\nexport default () => <Text>{dublinDateKey(1)}</Text>\n",
      'shared/new-seam.js': IMPORT,
      'src/app/api/x/route.js': IMPORT,
    })
    expect(v.offenders.map((o) => o.file)).toStrictEqual(['mobile/app/(staff)/new-screen.jsx', 'shared/new-seam.js', 'src/app/api/x/route.js'])
  })

  it('a dublin-time import fails in a TEST file too (only its own tests and the parity test may)', async () => {
    const v = await verdict({
      'src/lib/foo.test.js': IMPORT,
      'src/components/Foo.test.jsx': "const m = await import('@/lib/dublin-time')\n",
      'src/lib/foo.legacy-dublin.test-helpers.js': IMPORT,
      'mobile/lib/__tests__/foo.js': "import { dublinDateKey } from 'shared/dublin-time'\n",
      'tests/some-guard.test.js': "import { dublinTodayStr } from '../src/lib/dublin-time.js'\n",
    })
    expect(v.offenders.map((o) => o.file)).toStrictEqual([
      'mobile/lib/__tests__/foo.js',
      'src/components/Foo.test.jsx',
      'src/lib/foo.legacy-dublin.test-helpers.js',
      'src/lib/foo.test.js',
      'tests/some-guard.test.js',
    ])
    expect(v.offenders.every((o) => o.messages.every((m) => /dublin-time/.test(m.message)))).toBe(true)
  })

  it('an eslint-disable comment does not hide an offender (noInlineConfig)', async () => {
    const code = "// eslint-disable-next-line guardrails/no-hardcoded-dublin-zone\nexport const tz = 'Europe/Dublin'\n"
    const v = await verdict({ 'src/lib/sneaky.js': code })
    expect(v.offenders.map((o) => o.file)).toStrictEqual(['src/lib/sneaky.js'])
  })
})

describe('TZ.18b gate: what passes', () => {
  it('clean files pass', async () => {
    expect(failed(await verdict({ 'src/lib/clean.js': CLEAN, 'shared/clean.js': "export { PLATFORM_TZ } from './zoned-time.js'\n" }))).toBe(false)
  })

  it('the allowlist: zoned-time.js (PLATFORM_TZ / DEFAULT_TZ), the dublin-time modules, their tests, the parity test', async () => {
    const v = await verdict({
      'shared/zoned-time.js': "export const PLATFORM_TZ = 'Europe/Dublin'\nexport const DEFAULT_TZ = PLATFORM_TZ\n",
      'shared/dublin-time.js': "const DUBLIN_TZ = 'Europe/Dublin'\n",
      'src/lib/dublin-time.js': "const DUBLIN_TZ = 'Europe/Dublin'\n",
      'shared/dublin-time.test.js': "import { dublinDateKey } from './dublin-time.js'\n",
      'src/lib/dublin-time.test.js': "import { dublinDateKey } from './dublin-time.js'\n",
      'shared/zoned-time.parity.test.js': "const S = await import('./dublin-time.js')\n",
    })
    expect(v).toStrictEqual({ offenders: [], fatal: [] })
  })

  it('tests may NAME the zone (the Europe/Dublin pins), in every test shape', async () => {
    const v = await verdict({
      'src/lib/foo.test.js': LITERAL,
      'src/components/Foo.test.jsx': LITERAL,
      'src/lib/foo.test-helpers.js': LITERAL,
      'src/lib/_test-fixture.js': LITERAL,
      'mobile/lib/__tests__/foo.js': LITERAL,
      'mobile/__mocks__/foo.js': LITERAL,
      'tests/some-guard.test.js': LITERAL,
    })
    expect(v).toStrictEqual({ offenders: [], fatal: [] })
  })

  it('prose that mentions the zone is not a zone value', async () => {
    expect(failed(await verdict({ 'src/lib/copy.js': "export const s = 'Times are shown in Europe/Dublin for this studio'\n" }))).toBe(false)
  })

  it('files outside src/, shared/, mobile/ and tests/ are not linted', async () => {
    expect(failed(await verdict({ 'scripts/one-off.js': LITERAL, 'mobile/node_modules/x/index.js': LITERAL }))).toBe(false)
  })
})

describe('TZ.18b the baseline is gone', () => {
  it('neither the baseline nor its frozen snapshot exists', () => {
    expect(fs.existsSync(path.join(ROOT, 'eslint-rules/dublin-zone-baseline.txt'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'eslint-rules/dublin-zone-baseline.tz18a-snapshot.txt'))).toBe(false)
  })

  it('no *.legacy-dublin.test-helpers.js frozen copy is left', () => {
    const found = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.legacy-dublin.test-helpers.js')) found.push(rel)
      }
    }
    for (const d of ['src', 'shared', 'mobile/lib']) walk(d)
    expect(found).toStrictEqual([])
  })

  it('every allowlist entry carries a reason', () => {
    for (const a of DUBLIN_ZONE_ALLOW) expect(a.reason.length, a.glob).toBeGreaterThan(10)
  })
})
