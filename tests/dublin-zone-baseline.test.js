// TZ.18a — the no-hardcoded-dublin-zone gate (scripts/check-dublin-zone.mjs)
// and its baseline. The rule's own cases live in tests/guardrails-rules.test.js;
// these drive the gate end to end on fixture strings (the real flat config,
// allowlist and verdict), then pin the invariants of the real baseline file.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  BASELINE_PATH,
  FROZEN_PATH,
  DUBLIN_ZONE_ALLOW,
  createDublinZoneLinter,
  parseList,
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

async function verdict(files, baseline, frozen = baseline) {
  return checkDublinZone({ results: await lintFixtures(files), baseline, frozen })
}

const LITERAL = "export const tz = loc.timezone || 'Europe/Dublin'\n"
const IMPORT = "import { dublinTodayStr } from '@/lib/dublin-time'\nexport const t = dublinTodayStr()\n"
const CLEAN = "import { todayStrIn } from '@/lib/location-time'\nexport const t = (zone) => todayStrIn(zone)\n"

describe('TZ.18a gate: what fails', () => {
  it('a file outside the baseline that adds the literal fails, with its line', async () => {
    const v = await verdict({ 'src/lib/new-feature.js': LITERAL }, [])
    expect(v.newOffenders).toStrictEqual([
      { file: 'src/lib/new-feature.js', messages: [expect.objectContaining({ line: 1 })] },
    ])
    expect(failed(v)).toBe(true)
    expect(formatReport(v)).toContain('src/lib/new-feature.js:1:')
  })

  it('a new dublin-time import fails, in mobile/ and shared/ too', async () => {
    const v = await verdict(
      {
        'mobile/app/(staff)/new-screen.jsx': "import { dublinDateKey } from '../../lib/dublin-time'\nexport default () => <Text>{dublinDateKey(1)}</Text>\n",
        'shared/new-seam.js': IMPORT,
      },
      [],
    )
    expect(v.newOffenders.map((o) => o.file)).toStrictEqual(['mobile/app/(staff)/new-screen.jsx', 'shared/new-seam.js'])
  })

  it('an eslint-disable comment does not hide an offender (noInlineConfig)', async () => {
    const code = "// eslint-disable-next-line guardrails/no-hardcoded-dublin-zone\nexport const tz = 'Europe/Dublin'\n"
    const v = await verdict({ 'src/lib/sneaky.js': code }, [])
    expect(v.newOffenders.map((o) => o.file)).toStrictEqual(['src/lib/sneaky.js'])
  })

  it('a baseline file that no longer offends fails until its line is deleted', async () => {
    const v = await verdict({ 'src/lib/swept.js': CLEAN, 'src/lib/still-dublin.js': LITERAL }, ['src/lib/still-dublin.js', 'src/lib/swept.js'])
    expect(v.stale).toStrictEqual(['src/lib/swept.js'])
    expect(v.newOffenders).toStrictEqual([])
    expect(formatReport(v)).toMatch(/Delete their lines[\s\S]*src\/lib\/swept\.js/)
  })

  it('a baseline line for a file that is gone (or now allowlisted) is stale too', async () => {
    const v = await verdict({ 'src/lib/x.test.js': LITERAL }, ['src/lib/deleted.js', 'src/lib/x.test.js'])
    expect(v.stale).toStrictEqual(['src/lib/deleted.js', 'src/lib/x.test.js'])
  })

  it('the baseline cannot grow: a line missing from the TZ.18a snapshot fails', async () => {
    const v = await verdict({ 'src/lib/a.js': LITERAL, 'src/lib/b.js': LITERAL }, ['src/lib/a.js', 'src/lib/b.js'], ['src/lib/a.js'])
    expect(v.growth).toStrictEqual(['src/lib/b.js'])
    expect(failed(v)).toBe(true)
  })

  it('the baseline must stay sorted and unique', () => {
    const v = checkDublinZone({ results: [], baseline: ['src/b.js', 'src/a.js', 'src/a.js'], frozen: ['src/a.js', 'src/b.js'] })
    expect(v.order).toStrictEqual([
      'out of order: src/a.js must come before src/b.js',
      'duplicate entry: src/a.js',
    ])
  })
})

describe('TZ.18a gate: what passes', () => {
  it('a listed file that still offends passes, and clean files pass', async () => {
    const v = await verdict({ 'src/lib/legacy.js': IMPORT, 'src/lib/clean.js': CLEAN }, ['src/lib/legacy.js'])
    expect(failed(v)).toBe(false)
  })

  it('the allowlist: zoned-time.js (PLATFORM_TZ / DEFAULT_TZ), the dublin-time modules, and tests', async () => {
    const v = await verdict(
      {
        'shared/zoned-time.js': "export const PLATFORM_TZ = 'Europe/Dublin'\nexport const DEFAULT_TZ = PLATFORM_TZ\n",
        'shared/dublin-time.js': "const DUBLIN_TZ = 'Europe/Dublin'\n",
        'src/lib/dublin-time.js': "const DUBLIN_TZ = 'Europe/Dublin'\n",
        'src/lib/foo.test.js': LITERAL,
        'src/components/Foo.test.jsx': IMPORT,
        'src/lib/foo.legacy-dublin.test-helpers.js': LITERAL,
        'mobile/lib/__tests__/foo.js': LITERAL,
        'mobile/lib/foo.tz.test.js': IMPORT,
      },
      [],
    )
    expect(v).toStrictEqual({ newOffenders: [], stale: [], growth: [], order: [], fatal: [] })
  })

  it('prose that mentions the zone is not a zone value', async () => {
    const v = await verdict({ 'src/lib/copy.js': "export const s = 'Times are shown in Europe/Dublin for this studio'\n" }, [])
    expect(failed(v)).toBe(false)
  })

  it('files outside src/, shared/ and mobile/ are not linted', async () => {
    const v = await verdict({ 'scripts/one-off.js': LITERAL, 'mobile/node_modules/x/index.js': LITERAL }, [])
    expect(failed(v)).toBe(false)
  })

  it('parseList skips # comments and blank lines', () => {
    expect(parseList('# header\n\nsrc/a.js\n  # indented comment\nsrc/b.js\n')).toStrictEqual(['src/a.js', 'src/b.js'])
  })
})

describe('TZ.18a the real baseline only shrinks', () => {
  const baseline = parseList(fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8'))
  const frozen = parseList(fs.readFileSync(path.join(ROOT, FROZEN_PATH), 'utf8'))

  it('is sorted and has no duplicates', () => {
    expect(baseline).toStrictEqual([...new Set(baseline)].sort())
  })

  it('is a subset of the frozen TZ.18a snapshot (it may only lose lines)', () => {
    const snap = new Set(frozen)
    expect(baseline.filter((f) => !snap.has(f))).toStrictEqual([])
  })

  it('every listed file still exists (else delete its line)', () => {
    expect(baseline.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toStrictEqual([])
  })

  it('tells a sweep how to shrink it in its header', () => {
    const header = fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n')
    expect(header).toMatch(/delete (its|the file's) line/i)
  })

  it('every allowlist entry carries a reason', () => {
    for (const a of DUBLIN_ZONE_ALLOW) expect(a.reason.length, a.glob).toBeGreaterThan(10)
  })
})
