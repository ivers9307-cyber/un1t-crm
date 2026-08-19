// OTA-PATHS.1 — executable proof of what does and does not publish an OTA.
//
// .github/workflows/eas-update.yml publishes to production phones. Its
// trigger is the whole safety mechanism, and a paths filter that LOOKS
// right but MATCHES wrong is exactly how this class of bug keeps
// recurring (a docs-only push and a dependency-allowlist-only push each
// published a no-op update group at 10% on top of a live ramp).
//
// So: read the REAL workflow file and assert, file-set by file-set,
// whether a push would fire. If someone edits the trigger, these tests
// speak up.
//
// The matcher in scripts/check-ota-trigger-paths.mjs implements GitHub's
// documented rules ("if at least one path matches… the workflow runs";
// "a matching negative pattern after a positive match will exclude the
// path"). The first describe block calibrates it against two REAL
// observed runs so the model is anchored to behaviour, not to my reading
// of the docs.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  parseTriggerPaths,
  globToRegExp,
  isIncluded,
  wouldFire,
} from '../scripts/check-ota-trigger-paths.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const WORKFLOW = join(repoRoot, '.github/workflows/eas-update.yml')

const patterns = parseTriggerPaths(readFileSync(WORKFLOW, 'utf8'))

// ── Calibration: the matcher must reproduce two runs that actually happened ──
//
// Both are on origin/main and both are visible in
// `gh run list --workflow=eas-update.yml`.
describe('matcher calibrated against observed GitHub behaviour', () => {
  // The OLD filter, as it stood at each of those commits.
  const DENYLIST_BEFORE_1455 = ['mobile/**', 'shared/**']
  const DENYLIST_AFTER_1455 = ['mobile/**', '!mobile/docs/**', 'shared/**']

  it('2ce8971c (#1434) fired — and did so on a DOTFILE, which settles that ** matches dotfiles', () => {
    const changed = [
      'docs/CHANGELOG.md',
      'mobile/.audit-allowlist.json',
      'tests/dependency-audit.test.js',
    ]
    // Observed: run exists, conclusion "success" → it published.
    expect(wouldFire(changed, DENYLIST_BEFORE_1455)).toBe(true)
    // Still broken after #1455 — the negation only covered docs.
    expect(wouldFire(changed, DENYLIST_AFTER_1455)).toBe(true)
    // Fixed by the allowlist.
    expect(wouldFire(changed, patterns)).toBe(false)
  })

  it('e8d68ff1 (#1455) did NOT fire — the docs negation genuinely worked', () => {
    const changed = [
      '.github/workflows/eas-update.yml',
      'mobile/docs/store-release-one-app.md',
    ]
    // Observed: no run for this sha.
    expect(wouldFire(changed, DENYLIST_AFTER_1455)).toBe(false)
    // The allowlist preserves that behaviour — #1455 is not regressed.
    expect(wouldFire(changed, patterns)).toBe(false)
  })

  it('ddf01aef (#1451) fired under the pre-#1455 filter — the incident that prompted the fix', () => {
    const changed = [
      'docs/domain-migration-stage3.md',
      'docs/repset-asc-metadata.md',
      'mobile/docs/store-release-one-app.md',
    ]
    expect(wouldFire(changed, DENYLIST_BEFORE_1455)).toBe(true)
    expect(wouldFire(changed, patterns)).toBe(false)
  })
})

describe('glob semantics', () => {
  it('** crosses separators, * does not', () => {
    expect(globToRegExp('mobile/app/**').test('mobile/app/(staff)/(auth)/login.jsx')).toBe(true)
    expect(globToRegExp('mobile/*.js').test('mobile/index.js')).toBe(true)
    expect(globToRegExp('mobile/*.js').test('mobile/lib/api.js')).toBe(false)
  })

  it('literal regex metacharacters in real paths are escaped, not interpreted', () => {
    // These are real tracked filenames — parentheses and @ and . would all
    // be regex metacharacters if the compiler were naive.
    expect(globToRegExp('mobile/app/**').test('mobile/app/(member)/(tabs)/home.jsx')).toBe(true)
    expect(
      globToRegExp('mobile/asc-screenshots/**').test('mobile/asc-screenshots/IMG_6564@6.5.png')
    ).toBe(true)
    // `.` must not act as "any character".
    expect(globToRegExp('mobile/package.json').test('mobile/packageXjson')).toBe(false)
  })

  it('last matching pattern wins, in order', () => {
    const p = ['a/**', '!a/b/**', 'a/b/c/**']
    expect(isIncluded('a/x.js', p)).toBe(true)
    expect(isIncluded('a/b/y.js', p)).toBe(false)
    expect(isIncluded('a/b/c/z.js', p)).toBe(true) // re-included by the later positive
  })

  it('refuses to model `+` rather than silently mis-matching', () => {
    expect(() => globToRegExp('mobile/a+/**')).toThrow(/does not model/)
  })
})

describe('the live trigger is a pure allowlist', () => {
  it('contains no negations at all', () => {
    expect(patterns.filter((p) => p.startsWith('!'))).toEqual([])
  })

  it('keeps shared/** wholesale', () => {
    expect(patterns).toContain('shared/**')
  })

  it('does not list its own workflow file — editing the pipeline must not publish', () => {
    expect(wouldFire(['.github/workflows/eas-update.yml'], patterns)).toBe(false)
  })
})

// ── The evidence table. Each row is a plausible push. ──
describe('what publishes an OTA', () => {
  const FIRES = {
    'a route change': ['mobile/app/(staff)/(tabs)/index.jsx'],
    'a component change': ['mobile/components/RepsetLoader.jsx'],
    'a lib change': ['mobile/lib/api.js'],
    'the bundle entry point': ['mobile/index.js'],
    'a bundled font (require()d from app/_layout.jsx)': [
      'mobile/assets/fonts/ArchivoExpanded-700.ttf',
    ],
    'expo config / runtimeVersion': ['mobile/app.config.js'],
    'the Babel transform': ['mobile/babel.config.js'],
    'the Metro resolver': ['mobile/metro.config.js'],
    'the NativeWind stylesheet': ['mobile/global.css'],
    'the Tailwind config': ['mobile/tailwind.config.js'],
    'a mobile dependency bump': ['mobile/package.json', 'mobile/package-lock.json'],
    'a shared module (wholesale on purpose)': ['shared/permissions.js'],
    'a web-only shared module (accepted over-trigger)': ['shared/pipeline-classifier.js'],
    'screenshots alongside a real code change': [
      'mobile/asc-screenshots/IMG_6564@6.5.png',
      'mobile/lib/api.js',
    ],
  }

  const DOES_NOT_FIRE = {
    // The four the audit named.
    'App Store screenshots only (the launch-window trap)': [
      'mobile/asc-screenshots/IMG_6564@6.5.png',
      'mobile/asc-screenshots/IMG_6565@6.5.png',
      'mobile/asc-screenshots/source/IMG_6564.jpg',
    ],
    'a certificate': ['mobile/certs/certificate.pem'],
    'EAS build profiles': ['mobile/eas.json'],
    'the mobile dependency-audit allowlist': ['mobile/.audit-allowlist.json'],
    // Everything else non-bundle under mobile/.
    'mobile runbooks (the #1455 case, still true)': ['mobile/docs/ota-rollout.md'],
    'EAS Workflows orchestration': ['mobile/.eas/workflows/release.yml'],
    'the screenshot-resize helper': ['mobile/scripts/resize-screenshots.sh'],
    'the version-bump helper': ['mobile/scripts/bump-version.mjs'],
    'the env example': ['mobile/.env.example'],
    'mobile gitignore': ['mobile/.gitignore'],
    // Web-side pushes.
    'a web-only change': ['src/app/api/deals/route.js'],
    'a migration': ['supabase/migrations/999_x.sql'],
    'root docs': ['docs/CHANGELOG.md', 'CLAUDE.md'],
    'the root package.json (NOT mobile/package.json)': ['package.json', 'package-lock.json'],
    'this very PR (workflow + guard + runbooks)': [
      '.github/workflows/eas-update.yml',
      '.github/workflows/web-ci.yml',
      'scripts/check-ota-trigger-paths.mjs',
      'tests/ota-trigger-paths.test.js',
      'mobile/docs/ota-rollout.md',
      'mobile/docs/store-release-one-app.md',
      'package.json',
      'CLAUDE.md',
    ],
  }

  for (const [name, files] of Object.entries(FIRES)) {
    it(`FIRES — ${name}`, () => {
      expect(wouldFire(files, patterns)).toBe(true)
    })
  }

  for (const [name, files] of Object.entries(DOES_NOT_FIRE)) {
    it(`does NOT fire — ${name}`, () => {
      expect(wouldFire(files, patterns)).toBe(false)
    })
  }
})

describe('parseTriggerPaths', () => {
  it('reads the push paths list, not some other paths: key', () => {
    expect(patterns.length).toBeGreaterThan(5)
    expect(patterns).toContain('mobile/app/**')
    // mobile-export.yml also has a paths: under pull_request first — make
    // sure a push block is what gets picked up there too.
    const other = parseTriggerPaths(
      readFileSync(join(repoRoot, '.github/workflows/mobile-export.yml'), 'utf8')
    )
    expect(other).toContain('.github/workflows/mobile-export.yml')
  })

  it('throws rather than reporting an empty (therefore inert) filter', () => {
    expect(() => parseTriggerPaths('name: x\non:\n  workflow_dispatch: {}\n')).toThrow(
      /Could not parse/
    )
  })
})
