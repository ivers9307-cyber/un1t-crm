// PAIRSYNC.1 — the duplicated-module sync guards were comments. Now they run.
//
// ─── The defect ──────────────────────────────────────────────────────────────
//
// Mobile cannot import `src/lib`, so `shared/` is the seam. A pile of modules
// therefore exist twice, and several carry header comments asserting the two
// copies are "byte-identical", a "verbatim copy below line 1", or must be
// "KEPT IN SYNC". A comment is not a check. Measured on this tree, at least
// three of those pairs had ALREADY drifted, in two cases by the time the
// comment claiming otherwise was written:
//
//   • src/lib/tiers.js grew three windowed-decay helpers (tierWindowMonths,
//     shiftMonthKey, windowedMonthsHit) that shared/tiers.js never got, while
//     BOTH files' line 1 still said "verbatim copy below line 1".
//   • src/lib/goals.js and shared/goals.js disagree on the week/month
//     boundary (UTC vs Europe/Dublin) AND on periodEnd's arity — while
//     src/lib/goals.js line 1 claimed a verbatim copy. Web reads
//     `@/lib/goals`, mobile reads `shared/goals`, and they render the same
//     member's weekly goal progress.
//   • src/lib/heart-rate.js and shared/heart-rate.js disagree on the
//     zone LABELS ('Z1' vs 'Zone 1'), on resolveScoringConfig's return shape,
//     and on summariseSession's internals.
//
// ─── The design ──────────────────────────────────────────────────────────────
//
// Byte-identity is the WRONG assertion for most of these. Import specifiers
// legitimately differ ('./dublin-time.js' vs '@/lib/dublin-time'), header
// paragraphs legitimately differ, and some web copies legitimately carry
// helpers the mobile seam has no use for. Asserting byte-identity would fail
// on main today and get deleted within the week.
//
// So each pair declares WHAT must match, and the manifest below is the
// classification:
//
//   reexport      src/lib re-exports the shared implementation. Asserted by
//                 RUNTIME IDENTITY — the web binding must be the very same
//                 object as the shared one. Drift is structurally impossible;
//                 this is the pattern the other modes are a fallback for.
//   identical     Two hand-maintained copies. The whole module body, comments
//                 stripped and import specifiers canonicalised, must be equal.
//                 Catches private helpers too, not just exports.
//   web-superset  The web copy is shared's exports plus extras. Every export
//                 shared declares must be byte-equal in web; every extra must
//                 be listed in `webOnly`, so a NEW undeclared one still fails.
//   diverged      The copies are NOT in sync. The manifest pins exactly which
//                 exports differ. This is not a mute: it fails if a new export
//                 drifts AND if a pinned one is silently re-synced, either of
//                 which is a fact someone needs to re-decide.
//   unrelated     Same filename, different modules, disjoint export surfaces.
//                 Asserted to STAY disjoint.
//   shared-constant
//                 NOT copies — two different modules that must agree on one
//                 named value (a writer and a reader of the same table).
//                 Asserted on the RUNTIME VALUE of the named constants.
//
// And the property that actually stops the rot: COMPLETENESS, in three sweeps.
// A same-NAME sweep (recursive) requires every module present in both trees to
// be classified. A cross-NAMED sweep requires every shared/ ↔ src/lib/ pair
// that shares an exported name to be classified too, or declared coincidental
// with a reason. A SHIM sweep (PAIRSYNC.2) reads every `export * from
// '@shared/x'` under src/lib and requires the pair it names to be a
// `reexport` entry. A new duplicated module cannot be added without someone
// saying what it is — the same shape as the check:ota-paths allowlist.
//
// The cross-named sweep is not decorative: it is what found the
// wearable-trends TREND_METRICS pair, which the filename sweep alone could
// never see and which no comment anywhere claimed. The shim sweep exists
// because the cross-named sweep has a hole the first cross-named shim fell
// through: `collectExportNames` registers `export * from` as the single name
// `*`, which overlaps nothing, so src/lib/sonos/playback.js →
// shared/sonos-playback.js (SONOSMOB.1) passed both sweeps with no entry and
// was covered only because one was added by hand.
//
// ─── Known limits, on purpose ────────────────────────────────────────────────
//
//   • The champ-app leg is unguardable from here. CLAUDE.md records a
//     three-way sync rule with ~20 modules in a separate repo; nothing in
//     this repo can read that repo. This guard covers the in-repo half only,
//     and says so rather than implying more coverage than it has.
//   • The cross-named sweep keys on EXPORT NAMES. A duplicate that was
//     renamed on BOTH sides is invisible to it, and there is one on this tree
//     right now: src/lib/tiers.js's rolling-window decay helpers
//     (tierWindowMonths / shiftMonthKey / windowedMonthsHit) re-implement the
//     same concept as shared/tier-window.js (windowMonthKeys /
//     monthsHitInWindow / resolveTierMonths) under entirely different names,
//     so they share nothing for the sweep to catch. Named here rather than
//     omitted: it has to be added to PAIRS by hand, or the two reconciled.
//   • No sweep looks outside shared/ and src/lib/. A module duplicated
//     into mobile/lib/ is not covered.
//   • (CLOSED by PAIRSYNC.2) A cross-named `export * from` shim used to be
//     invisible to both sweeps. The shim sweep reads the specifier, so the
//     only remaining way to hide a wholesale re-export is to spell it as a
//     named list — and a named list IS visible to the export-name sweep.
//   • `diverged` pins export names, not behaviour. It tells you a pair is
//     known-unsynced and which exports; it does not tell you the divergence
//     is harmless. Two of the three are recorded here as open questions with
//     a live member-facing consequence, deliberately NOT "fixed" in the same
//     change that added the guard.
//   • The extractor is text, not a parser (scripts/lib/export-bodies.mjs).
//     Its failure direction is a LONGER slice, i.e. a false "differs", never
//     a false "matches".
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../scripts/lib/strip-comments.mjs'
import { exportBodies, collectExportNames } from '../scripts/lib/export-bodies.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repo = join(__dirname, '..')

// ── The manifest ─────────────────────────────────────────────────────────────
// `shared` and `web` are repo-relative paths; `shared` defaults to
// `shared/<file>` and `web` to `src/lib/<file>` when the names match.
const PAIRS = {
  // ── reexport: one implementation, two import paths ─────────────────────────
  'class-timer.js': {
    mode: 'reexport',
    why: 'The timer engine lives in shared/; src/lib is `export * from` so every web caller keeps its old import.',
  },
  'tv-template.js': {
    mode: 'reexport',
    why: 'TV zone/colour-run logic moved to shared/ for the mobile app; src/lib is a named re-export shim.',
  },
  'pipeline-classifier.js': {
    mode: 'reexport',
    why: 'FUNNEL-M.1 moved the pure classifier to shared/ for the mobile pipeline screen; src/lib re-exports it.',
  },
  'race-control.js': {
    mode: 'reexport',
    webOnly: ['ensureTeamForBooking'],
    why: 'Pure timing helpers live in shared/; the one IO helper (ensureTeamForBooking) stays web-only in src/lib.',
  },

  // ── identical: hand-maintained twins that really are twins ─────────────────
  'challenges.js': {
    mode: 'identical',
    why: 'Both files say "verbatim copy below line 1"; the only legitimate difference is the dublin-time import specifier.',
  },
  'customer-notifications.js': {
    mode: 'identical',
    twinTests: 'identical',
    why: 'Header says BYTE-SYNC, champ-app canon. Both surfaces push to the SAME member — drift means the once-per-period idempotency key or the push copy disagree.',
  },
  'hr-analytics.js': {
    mode: 'identical',
    twinTests: 'identical',
    why: 'Header says BYTE-SYNC, champ-app canon. Both apps render these numbers to the same member.',
  },
  'social.js': {
    mode: 'identical',
    twinTests: 'identical',
    why: 'Both files say "verbatim copy below line 1" / "byte-synced to champ-app".',
  },
  'hr-session-report.js': {
    mode: 'identical',
    why: 'Header says KEEP IN SYNC across champ-app + un1t-crm. Assembles the HR helpers into the versioned report payload both surfaces render.',
  },

  // ── web-superset: shared is the subset, web adds declared extras ───────────
  'tiers.js': {
    mode: 'web-superset',
    webOnly: ['tierWindowMonths', 'shiftMonthKey', 'windowedMonthsHit'],
    why:
      'The status-tier LADDER is the contract and must not diverge. The three web-only helpers are the rolling-window ' +
      'decay config, consumed by src/lib/live-class.js for the tier-up push — deleting them to force byte-identity ' +
      'would break that. Both files still claimed "verbatim copy below line 1" when this guard landed; the headers ' +
      'now say what is actually true.',
  },
  'zone-colors.js': {
    mode: 'web-superset',
    web: 'src/lib/tv-zone-colors.js',
    webOnly: ['ZONE_WASH_DARK', 'dominantZone'],
    why:
      'Named in CLAUDE.md as a cross-repo mirror ("the two must stay in sync by hand"). The five dark-canvas zone ' +
      'hues are the shared contract; the wash tints and dominant-zone glow are TV-board-only.',
  },

  // ── diverged: NOT in sync, and the drift is pinned so it stays visible ─────
  'goals.js': {
    mode: 'diverged',
    drifted: ['computeProgress', 'periodEnd', 'startOfIsoWeek', 'startOfMonth'],
    why:
      'OPEN, deliberately not fixed here. src/lib/goals.js (PR #610) buckets weeks and months on UTC boundaries; ' +
      'shared/goals.js (the champ-app copy landed by the Repset P1 drop) buckets them on Europe/Dublin boundaries, ' +
      'and its periodEnd takes (period, periodStart) where the web one takes (periodStart). The web dashboard reads ' +
      "@/lib/goals and the mobile member app reads shared/goals, so the SAME member's weekly goal progress can " +
      'disagree around Dublin midnight on a Monday during IST — the exact hazard CLAUDE.md\'s timezone invariant ' +
      'describes. src/lib/goals.js line 1 claimed a verbatim copy; that claim is corrected, but changing which ' +
      'boundary the web uses moves a member-visible number and is its own decision, not a drive-by in a guard PR.',
  },
  'heart-rate.js': {
    mode: 'diverged',
    drifted: ['ZONE_DEFS', 'resolveScoringConfig', 'summariseSession'],
    webOnly: [
      'MAX_SAMPLE_GAP_SECONDS',
      'applyBatchToRunningSummary',
      'computeAge',
      'effortPointsFromZones',
      'emptyRunningSummary',
      'flushRunningSummary',
      'normaliseRunningState',
      'zonesTotalSeconds',
    ],
    why:
      'OPEN. Both copies say "keep in sync" but they do not agree: ZONE_DEFS labels are "Z1".."Z5" on web and ' +
      '"Zone 1".."Zone 5" in shared (member-visible text), shared/resolveScoringConfig returns a tierWindowMonths ' +
      'the web one does not, and summariseSession was refactored on web to route through effortPointsFromZones. ' +
      'The web-only exports are the live-session running-summary path (bridge sample batching), which the mobile ' +
      'seam has no use for. Reconciling zone labels and the scoring-config shape is a product decision.',
  },
  'dublin-time.js': {
    mode: 'diverged',
    drifted: ['dublinDayStartMs'],
    webOnly: [
      'addDaysISO',
      'dublinDayStr',
      'dublinMonthStr',
      'dublinNowMinutes',
      'dublinTimeLabel',
      'dublinTodayStr',
    ],
    why:
      'Cosmetic only, and pinned so it STAYS cosmetic: dublinDayStartMs is `let guess` in shared and `const guess` ' +
      'on web, identical otherwise. The web-only helpers are server-side formatting the mobile seam does not need. ' +
      'shared/dublin-time.js asks for its semantics to be mirrored, and today they are.',
  },

  // ── shared-constant: different modules, one value that must agree ──────────
  'wearable-trends TREND_METRICS': {
    shared: 'shared/wearable-trends-view.js',
    web: 'src/lib/wearable-trends.js',
    mode: 'shared-constant',
    constants: ['TREND_METRICS'],
    why:
      'Not a copied module — a WRITE side and a READ side that must agree on one list. ' +
      'src/lib/wearable-trends.js owns the writer (samplesToMetricRows filters Apple Health samples ' +
      'down to TREND_METRICS before inserting member_health_metrics rows); shared/wearable-trends-view.js ' +
      "owns the reader, and its own comment says the list is exported so callers can server-side filter — " +
      'because an unfiltered ascending read hits the row cap and returns the OLDEST rows, hiding the ' +
      "member's latest reading. Add a metric to the writer only and it is stored but never displayed; add " +
      'it to the reader only and the filter asks for rows that never exist. The two lists are declared ' +
      'independently, in different files, with no import between them and nothing checking they agree — ' +
      'this is the check. Found by the cross-named sweep below, not by the filename sweep.',
  },

  // ── unrelated: same filename, different module ─────────────────────────────
  'permissions.js': {
    mode: 'unrelated',
    why: 'shared/permissions.js is the canonical 3-tier resolver + key registry; src/lib/permissions.js is the thin web-only adapter around it (hasPermission and friends).',
  },
  'plans.js': {
    mode: 'unrelated',
    why: 'shared/plans.js is the plan/meter/feature key vocabulary; src/lib/plans.js is the DB-backed resolution layer (INTEG-C1).',
  },
  'onboarding-journey.js': {
    mode: 'unrelated',
    why: 'shared/onboarding-journey.js shapes the journey CARD for the app; src/lib/onboarding-journey.js is the PULSE-90 pace math + nudge copy. No overlapping export.',
  },
}

const sharedPathFor = (key, cfg) => join(repo, cfg.shared || `shared/${key}`)
const webPathFor = (key, cfg) => join(repo, cfg.web || `src/lib/${key}`)
const read = (p) => readFileSync(p, 'utf8')

/** Whole-module body: comments gone, import specifiers canonicalised, blank
 *  lines collapsed. The canonicalisation is what lets `identical` mode ignore
 *  the ONE difference every twin legitimately has. */
function normaliseModule(src) {
  return stripComments(src)
    .replace(
      /(from\s*)['"](?:@\/lib\/|@shared\/|shared\/|\.\/|\.\.\/\.\.\/shared\/)([\w.-]+?)(?:\.js)?['"]/g,
      "$1'~$2'",
    )
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n')
}

function driftedExports(sharedSrc, webSrc) {
  const a = exportBodies(sharedSrc)
  const b = exportBodies(webSrc)
  return Object.keys(a)
    .filter((n) => n in b && a[n] !== b[n])
    .sort()
}

// ─────────────────────────────────────────────────────────────────────────────

// ── The completeness sweep ───────────────────────────────────────────────────
//
// Two sweeps, because the first one alone is weaker than its own name.
//
// The FILENAME sweep is what the guard shipped with: same basename in both
// directories → must be classified. It is exact and has no false positives,
// but it is blind by construction to a duplicate that was renamed on one side
// — and this repo has one (`shared/zone-colors.js` ↔ `src/lib/tv-zone-colors.js`),
// so the blind spot is not hypothetical. It was also non-recursive, which meant
// `src/lib/sdk/me.js` could shadow `shared/sdk/me.js` unseen. Both fixed here:
// the walk recurses, and the cross-named sweep below covers the renames.
//
// The CROSS-NAMED sweep compares every shared/**/*.js against every
// src/lib/**/*.js by EXPORTED NAME OVERLAP. Any pair sharing at least one
// top-level export name must be either in PAIRS or in COINCIDENTAL below with
// a reason. No threshold: the one real finding this sweep produced today
// (wearable-trends' TREND_METRICS) overlaps on exactly ONE name, so any
// "ignore small overlaps" rule would have thrown away the thing it caught.
//
// Measured cost of having no threshold, on this tree: 21 overlapping pairs
// total — 10 already-classified same-name pairs, zone-colors, the
// wearable-trends finding, and 9 genuine name collisions between unrelated
// modules. Nine allowlist entries is a reviewable amount of noise for a check
// that forces every future cross-named duplicate to be classified.
const COINCIDENTAL = {
  'shared/approval-cards.js::src/lib/contact-view.js':
    'Both define a local `mergeTimeline`, over different row shapes: approval cards merge approval events, contact-view merges a contact drawer timeline. No shared vocabulary.',
  'shared/dashboard-metrics.js::src/lib/ads/funnel.js':
    '`shapeFunnel` twice: the dashboard shapes the membership funnel, ads/funnel shapes a Meta ad funnel. Different stages, different inputs.',
  'shared/tiers.js::src/lib/hyrox/constants.js':
    '`TIERS` twice, and deliberately unrelated: shared/tiers.js is the status-tier ladder (months attended), hyrox/constants.js is the Hyrox race division list. The status ladder IS guarded — as the same-name tiers.js pair above.',
  'shared/share-card.js::src/lib/tv-zone-colors.js':
    '`dominantZone` twice. tv-zone-colors picks the dominant zone for the TV board glow; share-card picks it for a share image. The zone COLOURS they both build on are guarded by the zone-colors.js pair above; these two consumers are separate.',
  'shared/share-card.js::src/lib/challenges.js':
    '`shortName` twice — a display helper for a member name, independently written on both sides. Cosmetic, no contract.',
  'shared/dashboard-data.js::src/lib/goals.js':
    '`startOfMonth` twice. goals.js is inside the guarded goals.js pair (mode `diverged`, and startOfMonth is one of the pinned drifted exports); dashboard-data has its own for a dashboard range.',
  'shared/live-view.js::src/lib/race-control.js':
    '`formatElapsed` twice, and they deliberately DISAGREE — recorded here so the disagreement is ' +
    'visible rather than latent. shared/race-control.js (which src/lib/race-control.js re-exports, ' +
    'so the collision surfaces through the shim) renders a race clock: minutes zero-padded below an ' +
    'hour ("05:07") and "—" for a null/negative input. shared/live-view.js renders the in-class board ' +
    'clock: minutes UNpadded ("5:07") and 0:00 for junk input. Two different screens with two ' +
    'established conventions; unifying them changes a visible clock format and is a product decision, ' +
    'not a drive-by in a guard. Both live in shared/, so the champ-app leg would see it too.',
  'shared/live-view.js::src/lib/hr-session-lifecycle.js':
    '`STALE_AFTER_MS` twice, different subjects: live-view staleness for the in-class board, hr-session-lifecycle staleness for a session record. Coupling them would be wrong.',
  'shared/pipeline-classifier.js::src/lib/churn-radar.js':
    '`classifyContact` twice. pipeline-classifier is the funnel-stage classifier (guarded as a `reexport` pair); churn-radar classifies arrears/churn risk. Different outputs entirely.',
  'shared/dashboard-data.js::src/lib/dates.js':
    '`isoDate` twice — a one-line YYYY-MM-DD formatter. Too small to be a contract.',
  'shared/dashboard-data.js::src/lib/schemas.js':
    '`isoDate` twice, the same one-line YYYY-MM-DD formatter as the dates.js collision above. schemas.js uses it for request validation, dashboard-data for a range label; no contract binds them.',
}

/** Every .js under a directory, recursively, excluding tests and fixtures. */
function walkJs(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__fixtures__' || entry.name === 'node_modules') continue
      walkJs(abs, base, out)
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(relative(base, abs))
    }
  }
  return out
}

// ── PAIRSYNC.2 — the shim sweep ──────────────────────────────────────────────
// A wholesale re-export names its source in the specifier, so the pairing is
// read straight off the file: no basename heuristic, no export-name overlap.

const EXPORT_STAR_SHARED = /^\s*export\s*\*\s*from\s*['"](?:@shared|shared)\/([^'"]+)['"]/m

/** The shared module an `export * from '@shared/x'` shim re-exports, or null.
 *  Comments are stripped first so a comment that quotes the form is not a
 *  shim. Named re-exports (`export { a } from`) are deliberately null — those
 *  are already visible to the export-name sweep. */
function shimTarget(src) {
  const m = stripComments(src).match(EXPORT_STAR_SHARED)
  return m ? m[1] : null
}

/** Every export-* shim under src/lib, keyed the same way the manifest is. */
function exportStarShims() {
  const root = join(repo, 'src', 'lib')
  return walkJs(root)
    .map((rel) => {
      const target = shimTarget(readFileSync(join(root, rel), 'utf8'))
      if (!target) return null
      const file = `src/lib/${rel.split(sep).join('/')}`
      const sharedFile = `shared/${target.endsWith('.js') ? target : `${target}.js`}`
      return { key: `${sharedFile}::${file}`, file, target, sharedFile }
    })
    .filter(Boolean)
}

/** Shims with no `reexport` manifest entry for the pair they name. Pure, so
 *  the test can prove it fires without planting a file. */
function unclassifiedShims(shims, pairs) {
  const byKey = new Map(
    Object.entries(pairs).map(([k, c]) => [`${c.shared || `shared/${k}`}::${c.web || `src/lib/${k}`}`, c]),
  )
  const out = []
  for (const s of shims) {
    const cfg = byKey.get(s.key)
    const sharedFile = s.sharedFile || s.key.split('::')[0]
    if (!cfg) {
      out.push(`${s.key}  (${s.file} re-exports ${sharedFile}; no PAIRS entry)`)
    } else if (cfg.mode !== 'reexport') {
      out.push(`${s.key}  (${s.file} re-exports ${sharedFile}; PAIRS entry is mode ${cfg.mode}, not reexport)`)
    }
  }
  return out.sort()
}

describe('shared/ ↔ src/lib/ pair inventory is complete', () => {
  it('every module with the SAME NAME in both directories is classified', () => {
    const sameName = walkJs(join(repo, 'shared'))
      .filter((rel) => existsSync(join(repo, 'src', 'lib', rel)))
      .sort()
    const classified = Object.keys(PAIRS)
      .filter((k) => !PAIRS[k].web && !PAIRS[k].shared)
      .sort()
    expect(classified).toEqual(sameName)
  })

  it('every CROSS-NAMED module sharing an export name is classified or declared coincidental', () => {
    const surfaces = (prefix) => {
      const root = join(repo, prefix)
      return walkJs(root).map((rel) => ({
        key: `${prefix}/${rel.split(sep).join('/')}`,
        names: new Set(collectExportNames(readFileSync(join(root, rel), 'utf8'))),
      }))
    }
    const sharedMods = surfaces('shared')
    const webMods = surfaces('src/lib')

    // Pairs the manifest already covers, in the same `a::b` key shape.
    const known = new Set(
      Object.entries(PAIRS).map(
        ([k, c]) => `${c.shared || `shared/${k}`}::${c.web || `src/lib/${k}`}`,
      ),
    )

    const unclassified = []
    for (const s of sharedMods) {
      for (const w of webMods) {
        const shared = [...s.names].filter((n) => n !== 'default' && w.names.has(n))
        if (shared.length === 0) continue
        const key = `${s.key}::${w.key}`
        if (known.has(key) || key in COINCIDENTAL) continue
        unclassified.push(`${key}  (shares: ${shared.sort().join(', ')})`)
      }
    }

    expect(
      unclassified.sort(),
      'A shared/ module and a src/lib/ module export the same name(s) and neither PAIRS nor ' +
        'COINCIDENTAL says what that means. Classify it — do not delete this check to go green.',
    ).toEqual([])
  })

  it('no stale COINCIDENTAL entry — every declared collision still exists', () => {
    const surfaceOf = (rel) => new Set(collectExportNames(readFileSync(join(repo, rel), 'utf8')))
    const stale = []
    for (const key of Object.keys(COINCIDENTAL)) {
      const [s, w] = key.split('::')
      if (!existsSync(join(repo, s)) || !existsSync(join(repo, w))) {
        stale.push(`${key} — a side no longer exists`)
        continue
      }
      const overlap = [...surfaceOf(s)].filter((n) => n !== 'default' && surfaceOf(w).has(n))
      if (overlap.length === 0) stale.push(`${key} — the names no longer collide`)
    }
    expect(stale, 'Remove these from COINCIDENTAL; an allowlist that outlives its reason is a mute.').toEqual([])
  })

  it('every COINCIDENTAL entry carries a reason, not just a pass', () => {
    for (const [key, why] of Object.entries(COINCIDENTAL)) {
      expect(typeof why, `${key} has no reason`).toBe('string')
      expect(why.length, `${key}'s reason is too thin`).toBeGreaterThan(60)
    }
  })

  it('every manifest entry points at two files that exist', () => {
    for (const [key, cfg] of Object.entries(PAIRS)) {
      expect(existsSync(sharedPathFor(key, cfg)), `${key}: shared side missing`).toBe(true)
      expect(existsSync(webPathFor(key, cfg)), `${key}: web side missing`).toBe(true)
    }
  })

  it('every entry carries a reason — a classification with no argument is a mute', () => {
    for (const [key, cfg] of Object.entries(PAIRS)) {
      expect(typeof cfg.why, `${key} has no \`why\``).toBe('string')
      expect(cfg.why.length, `${key}'s \`why\` is too thin to be a reason`).toBeGreaterThan(60)
    }
  })

  // PAIRSYNC.2 — the third sweep. An `export * from '@shared/x'` shim is
  // invisible to BOTH sweeps above: the same-name sweep needs matching
  // basenames, and the export-name sweep sees only `*` on the shim side. So a
  // cross-named shim (src/lib/sonos/playback.js → shared/sonos-playback.js,
  // SONOSMOB.1) passed every check with no manifest entry, and was covered
  // only because one was hand-added. Now the shim's own `from` specifier IS
  // the pairing: it names the shared module directly, so there is nothing to
  // infer and nothing a rename on either side can hide.
  it('every `export * from` shim under src/lib names a classified reexport pair', () => {
    const shims = exportStarShims()
    // The scan itself must find something, or a broken regex passes
    // vacuously. class-timer.js is the oldest shim on the tree.
    expect(shims.map((s) => s.key)).toContain('shared/class-timer.js::src/lib/class-timer.js')
    expect(
      unclassifiedShims(shims, PAIRS),
      'A src/lib module re-exports a shared/ module wholesale and PAIRS has no `reexport` entry for the pair. ' +
        'Add one (with explicit `shared`/`web` paths if the names differ) — do not delete this check to go green.',
    ).toEqual([])
  })

  it('the shim sweep fires on a shim with no entry, and on one classified as anything but reexport', () => {
    // Fixture-free proof the check is live: feed the checker a shim the
    // manifest has never heard of, and one whose entry exists in the wrong
    // mode. Both must come back as unclassified.
    const ghost = { key: 'shared/ghost.js::src/lib/ghost.js', file: 'src/lib/ghost.js', target: 'ghost' }
    const wrongMode = { key: 'shared/wrong.js::src/lib/wrong.js', file: 'src/lib/wrong.js', target: 'wrong' }
    const manifest = { 'wrong.js': { mode: 'identical', why: 'x' } }
    expect(unclassifiedShims([ghost, wrongMode], manifest)).toEqual([
      'shared/ghost.js::src/lib/ghost.js  (src/lib/ghost.js re-exports shared/ghost.js; no PAIRS entry)',
      'shared/wrong.js::src/lib/wrong.js  (src/lib/wrong.js re-exports shared/wrong.js; PAIRS entry is mode identical, not reexport)',
    ])
    // And the two real shapes a classified shim can take: same-name defaults,
    // and explicit cross-named paths.
    const classified = {
      'ghost.js': { mode: 'reexport', why: 'x' },
      'wrong.js': { mode: 'reexport', shared: 'shared/wrong.js', web: 'src/lib/wrong.js', why: 'x' },
    }
    expect(unclassifiedShims([ghost, wrongMode], classified)).toEqual([])
  })

  it('shimTarget reads both specifier forms and ignores everything else', () => {
    expect(shimTarget("export * from '@shared/sonos-playback'")).toBe('sonos-playback')
    expect(shimTarget('export * from "shared/class-timer"')).toBe('class-timer')
    expect(shimTarget("// a comment\nexport * from '@shared/x'\n")).toBe('x')
    // A comment mentioning the form is not a shim.
    expect(shimTarget("// export * from '@shared/nope'\nexport const a = 1")).toBeNull()
    // Named re-exports are already visible to the export-name sweep.
    expect(shimTarget("export { a, b } from '@shared/x'")).toBeNull()
    // A relative or package re-export is not a shared/ pair.
    expect(shimTarget("export * from './local'")).toBeNull()
    expect(shimTarget("export * from 'zod'")).toBeNull()
  })
})

describe('reexport pairs — one implementation, proven by identity', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'reexport')
  for (const [key, cfg] of entries) {
    it(`${key}: every shared export is the SAME object on the web side`, async () => {
      const sharedMod = await import(/* @vite-ignore */ sharedPathFor(key, cfg))
      const webMod = await import(/* @vite-ignore */ webPathFor(key, cfg))
      const names = Object.keys(sharedMod).filter((n) => n !== 'default')
      expect(names.length).toBeGreaterThan(0)
      for (const n of names) {
        expect(webMod[n], `${key}: web does not export ${n}`).toBeDefined()
        expect(webMod[n], `${key}: web's ${n} is a COPY, not the shared implementation`).toBe(sharedMod[n])
      }
    })

    it(`${key}: the web side adds only its declared extras`, async () => {
      const sharedMod = await import(/* @vite-ignore */ sharedPathFor(key, cfg))
      const webMod = await import(/* @vite-ignore */ webPathFor(key, cfg))
      const extra = Object.keys(webMod)
        .filter((n) => n !== 'default' && !(n in sharedMod))
        .sort()
      expect(extra).toEqual((cfg.webOnly || []).slice().sort())
    })
  }
})

describe('identical pairs — the copies really are copies', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'identical')
  for (const [key, cfg] of entries) {
    it(`${key}: module bodies match once comments and import specifiers are set aside`, () => {
      const a = normaliseModule(read(sharedPathFor(key, cfg)))
      const b = normaliseModule(read(webPathFor(key, cfg)))
      if (a !== b) {
        // Point at the first differing line rather than dumping two files.
        const al = a.split('\n')
        const bl = b.split('\n')
        const i = al.findIndex((l, n) => l !== bl[n])
        throw new Error(
          `${key} has DRIFTED between shared/ and src/lib/.\n` +
            `  first difference at normalised line ${i + 1}:\n` +
            `    shared: ${al[i] ?? '(end of file)'}\n` +
            `    web:    ${bl[i] ?? '(end of file)'}\n` +
            `  Mirror the change into the other copy. If the copies are now MEANT to differ, ` +
            `move ${key} to mode 'diverged' or 'web-superset' in tests/shared-pair-sync.test.js ` +
            `with a reason, and fix the header comment that claims they are identical.`,
        )
      }
    })
  }

  const twins = entries.filter(([, c]) => c.twinTests === 'identical')
  for (const [key] of twins) {
    it(`${key}: the twin test files are byte-identical, as their headers claim`, () => {
      const a = read(join(repo, 'shared', key.replace(/\.js$/, '.test.js')))
      const b = read(join(repo, 'src', 'lib', key.replace(/\.js$/, '.test.js')))
      expect(a).toBe(b)
    })
  }
})

describe('web-superset pairs — shared is the subset, extras are declared', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'web-superset')
  for (const [key, cfg] of entries) {
    it(`${key}: every export shared declares is byte-equal on the web side`, () => {
      const a = exportBodies(read(sharedPathFor(key, cfg)))
      const b = exportBodies(read(webPathFor(key, cfg)))
      expect(Object.keys(a).length).toBeGreaterThan(0)
      for (const n of Object.keys(a)) {
        expect(b[n], `${key}: web is missing ${n}`).toBeDefined()
        expect(b[n], `${key}: ${n} has drifted — mirror it`).toBe(a[n])
      }
    })

    it(`${key}: the web-only extras are exactly the declared ones`, () => {
      const a = collectExportNames(read(sharedPathFor(key, cfg)))
      const b = collectExportNames(read(webPathFor(key, cfg)))
      const extra = b.filter((n) => !a.includes(n)).sort()
      expect(extra).toEqual((cfg.webOnly || []).slice().sort())
    })
  }
})

describe('diverged pairs — the drift is pinned, in both directions', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'diverged')
  for (const [key, cfg] of entries) {
    it(`${key}: exactly the recorded exports differ — no more, and no fewer`, () => {
      const actual = driftedExports(read(sharedPathFor(key, cfg)), read(webPathFor(key, cfg)))
      const pinned = (cfg.drifted || []).slice().sort()
      if (JSON.stringify(actual) !== JSON.stringify(pinned)) {
        const added = actual.filter((n) => !pinned.includes(n))
        const gone = pinned.filter((n) => !actual.includes(n))
        throw new Error(
          `${key}: the recorded divergence is out of date.\n` +
            (added.length ? `  NEWLY drifted (mirror it, or add it to \`drifted\`): ${added.join(', ')}\n` : '') +
            (gone.length ? `  no longer drifted (delete from \`drifted\`; if the pair is now fully in sync, promote it to mode 'identical' or 'web-superset'): ${gone.join(', ')}\n` : '') +
            `  This entry exists so a known-unsynced pair stays visible. Do not widen \`drifted\` ` +
            `to silence a real regression — read the \`why\` first.`,
        )
      }
    })

    it(`${key}: the web-only extras are exactly the declared ones`, () => {
      const a = collectExportNames(read(sharedPathFor(key, cfg)))
      const b = collectExportNames(read(webPathFor(key, cfg)))
      expect(b.filter((n) => !a.includes(n)).sort()).toEqual((cfg.webOnly || []).slice().sort())
      // A shared-only export would mean the web copy lost something.
      expect(a.filter((n) => !b.includes(n))).toEqual([])
    })
  }
})

describe('unrelated pairs — same filename, different module', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'unrelated')
  for (const [key, cfg] of entries) {
    it(`${key}: the export surfaces stay disjoint`, () => {
      const a = collectExportNames(read(sharedPathFor(key, cfg)))
      const b = collectExportNames(read(webPathFor(key, cfg)))
      const overlap = a.filter((n) => b.includes(n))
      expect(
        overlap,
        `${key}: these files were classified as unrelated but now share exports (${overlap.join(', ')}). ` +
          `Reclassify the pair — an overlapping name is exactly where a silent divergence hides.`,
      ).toEqual([])
    })
  }
})

describe('shared-constant pairs — different modules, one value that must agree', () => {
  const entries = Object.entries(PAIRS).filter(([, c]) => c.mode === 'shared-constant')
  for (const [key, cfg] of entries) {
    for (const name of cfg.constants) {
      // Asserted on the RUNTIME VALUE, not the source text. These two sides are
      // not copies of each other — they are a writer and a reader that happen
      // to need the same list — so their surrounding code differs completely
      // and only the value is comparable. Deep equality, and order matters:
      // the reader uses the list to build a server-side filter, so a
      // re-ordering is harmless but a membership change is not, and pinning
      // order costs nothing while making the diff obvious.
      it(`${key}: ${name} holds the same value on both sides`, async () => {
        const s = await import(/* @vite-ignore */ sharedPathFor(key, cfg))
        const w = await import(/* @vite-ignore */ webPathFor(key, cfg))
        expect(s[name], `${name} is not exported from ${cfg.shared}`).toBeDefined()
        expect(w[name], `${name} is not exported from ${cfg.web}`).toBeDefined()
        expect(
          w[name],
          `${name} disagrees between ${cfg.shared} and ${cfg.web}. These are declared ` +
            `independently with no import between them; that is why this check exists.`,
        ).toEqual(s[name])
      })
    }
  }
})

// ─── Value-level guards for the two pairs whose CONTRACT is a table ──────────
//
// Source comparison catches an edit. These catch the thing the edit would
// break, and they keep working through a refactor that rewrites the source.

describe('the status-tier ladder means the same thing on both surfaces', () => {
  it('TIERS is identical, slug/name/months/colour', async () => {
    const s = await import('../shared/tiers.js')
    const w = await import('../src/lib/tiers.js')
    expect(w.TIERS).toEqual(s.TIERS)
    // Guard the guard: an empty ladder would make the comparison vacuous.
    expect(s.TIERS.length).toBe(5)
    expect(s.TIERS.map((t) => t.slug)).toEqual(['bronze', 'silver', 'gold', 'platinum', 'elite'])
  })

  it('tierForMonths and nextTier agree across the whole ladder and past its top', () => {
    // Scanned rather than spot-checked: an off-by-one at a threshold is the
    // failure that would show a member the wrong badge.
    return Promise.all([import('../shared/tiers.js'), import('../src/lib/tiers.js')]).then(([s, w]) => {
      for (let m = 0; m <= 40; m++) {
        expect(w.tierForMonths(m), `tierForMonths(${m})`).toEqual(s.tierForMonths(m))
        expect(w.nextTier(m), `nextTier(${m})`).toEqual(s.nextTier(m))
      }
    })
  })
})

describe('the dark-canvas zone palette means the same thing on both surfaces', () => {
  it('all five zone hues are identical', async () => {
    const s = await import('../shared/zone-colors.js')
    const w = await import('../src/lib/tv-zone-colors.js')
    expect(w.ZONE_COLORS_DARK).toEqual(s.ZONE_COLORS_DARK)
    expect(Object.keys(s.ZONE_COLORS_DARK)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('zoneColorDark agrees, including on the out-of-range and string cases', async () => {
    const s = await import('../shared/zone-colors.js')
    const w = await import('../src/lib/tv-zone-colors.js')
    for (const id of [0, 1, 2, 3, 4, 5, 6, '3', 'x', null, undefined]) {
      expect(w.zoneColorDark(id), `zoneColorDark(${String(id)})`).toBe(s.zoneColorDark(id))
    }
  })
})

describe('the session-report fixture both copies assert against', () => {
  it('is identical in shared/__fixtures__ and src/lib/__fixtures__', () => {
    // hr-session-report.js is mode 'identical', so its two test files compute
    // against the same code. If the FIXTURES diverged, the two suites would
    // silently be testing different inputs and both stay green.
    const a = read(join(repo, 'shared/__fixtures__/session-report.fixture.json'))
    const b = read(join(repo, 'src/lib/__fixtures__/session-report.fixture.json'))
    expect(a).toBe(b)
  })
})
