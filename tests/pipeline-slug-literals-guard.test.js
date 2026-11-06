// PIPEBUILD.2f — no NEW hard-coded list of pipeline stage slugs.
//
// Boards are now data: a studio's stages (slug, label, colour, role) come from
// its stage rows, and `shared/pipelines/` is the one place that may name slugs.
// Every extra `['new_lead', 'rebook', 'first_class', ...]` outside it is a copy
// that silently misses a board a studio builds itself. This guard scans the
// non-test .js/.jsx source of src/, shared/ (except shared/pipelines/) and
// mobile/ (except node_modules, ios, android) for an array, Set or object
// literal that holds >= 3 DISTINCT known stage slugs (array/Set elements;
// object keys or string values), and fails on any site that is not in BASELINE.
//
// BASELINE is frozen: today's sites, each with a one-line reason. It can only
// shrink. Entries are keyed by file + the identifier the literal sits under
// (`const STAGE_LABELS = {...}` -> 'STAGE_LABELS'; a bare argument/JSX attribute
// falls back to the nearest enclosing function or '(top)'), NOT by line number,
// so an edit elsewhere in the file never invalidates it. `count` is how many
// literals that key covers. A baseline entry whose file no longer has a match
// (or whose count shrank) fails as stale: delete it. To add a site you must add
// a baseline line with a reason in review; the better answer is to read the
// studio's stage rows instead.
//
// A floor, not a proof: a list built at runtime or split across several small
// literals is invisible to it.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')

export const KNOWN_STAGE_SLUGS = new Set([
  'new_lead', 'rebook', 'first_class', 'second_class', 'trial_done', 'converted', 'member', 'pack_member',
  'classpass', 'gympass', 'cold_lead', 'dormant',
  'paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done', 'paid_trial_converted',
  'programme_lead', 'programme_first_class', 'programme_converted',
  'waitlist_new_enquiry', 'waitlist_no_answer', 'waitlist_interested', 'waitlist_not_interested', 'waitlist_converted',
  'returning_booked', 'returning_first_class', 'returning_second_class', 'returning_final_class', 'returning_converted',
])
const MIN_DISTINCT = 3

const SCAN_DIRS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build', '.next'])
const EXEMPT_PREFIX = 'shared/pipelines/'

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test(-helpers)?\.(js|jsx)$/.test(name) && !/\.test-helpers\.js$/.test(name)) out.push(full)
  }
  return out
}

function stringOf(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function slugsIn(node) {
  const found = new Set()
  const add = (s) => { if (s != null && KNOWN_STAGE_SLUGS.has(s)) found.add(s) }
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) add(stringOf(el))
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const n = p.name
        if (ts.isIdentifier(n) || ts.isStringLiteral(n)) add(n.text)
        if (ts.isPropertyAssignment(p)) add(stringOf(p.initializer))
      }
    }
  }
  return found
}

function labelFor(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
    if (ts.isJsxAttribute(p)) return `<${p.name.getText()}>`
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return `${p.name.getText()}()`
    if (ts.isExportAssignment(p)) return 'export default'
  }
  return '(top)'
}

export function findSlugLiterals(text, file) {
  const kind = file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const sites = []
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
      const found = slugsIn(node)
      if (found.size >= MIN_DISTINCT) {
        sites.push({ id: labelFor(node), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/** @returns {Map<string, {count:number, lines:number[]}>} key = `<file> :: <identifier>` */
export function scanRepo(root = ROOT) {
  const result = new Map()
  for (const d of SCAN_DIRS) {
    const base = path.join(root, d)
    try { statSync(base) } catch { continue }
    for (const full of walk(base, [])) {
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (rel.startsWith(EXEMPT_PREFIX)) continue
      for (const site of findSlugLiterals(readFileSync(full, 'utf8'), rel)) {
        const key = `${rel} :: ${site.id}`
        const cur = result.get(key) || { count: 0, lines: [] }
        cur.count += 1
        cur.lines.push(site.line)
        result.set(key, cur)
      }
    }
  }
  return result
}

/** Compare a scan to a baseline: new sites, and baseline entries that no longer match. */
export function compareToBaseline(scan, baseline) {
  const unexpected = []
  const stale = []
  for (const [key, { count, lines }] of scan) {
    const allowed = baseline[key]?.count ?? 0
    if (count > allowed) unexpected.push(`${key} (${count} found, ${allowed} baselined; line ${lines.join(', ')})`)
  }
  for (const [key, { count }] of Object.entries(baseline)) {
    const got = scan.get(key)?.count ?? 0
    if (got < count) stale.push(`${key} (baseline ${count}, found ${got})`)
  }
  return { unexpected, stale }
}

export const BASELINE = {
  'src/components/AudienceBuilder.jsx :: STAGE_LABELS': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/AudienceBuilder.jsx :: options': { count: 1, reason: 'existing board semantics' },
  'src/components/ContactsTable.jsx :: statusBadge': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/ContactsView.jsx :: STATUSES': { count: 1, reason: 'existing board semantics' },
  'src/components/DealCard.jsx :: statusColors': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/DealCard.jsx :: BADGE_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/components/KanbanBoard.jsx :: stageColors': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/PersonHeader.jsx :: STAGE_PILL': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/PipelineReclassifyTab.jsx :: STAGE_LABELS': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/contact/ContactDrawer.jsx :: funnel': { count: 1, reason: 'existing board semantics' },
  'src/components/contact/ContactHeaderBand.jsx :: BADGE_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/components/dashboard/BusinessBlocks.jsx :: LABELS': { count: 1, reason: 'fallback for code-built boards' },
  'src/components/sequences/SequenceSettings.jsx :: PIPELINE_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/lib/agent/followups.js :: CHECKIN_STAGES': { count: 1, reason: 'existing board semantics' },
  'src/lib/agent/followups.js :: runFirstClassCheckins()': { count: 1, reason: 'existing board semantics' },
  'src/lib/contact-view.js :: FUNNEL_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/lib/location-seed.js :: STAGE_DETAILS': { count: 1, reason: 'seed data for the code-built boards' },
  'src/lib/pipeline-board.js :: BADGE_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/lib/pipeline-card-signal-slugs.js :: SIGNAL_SLUGS': { count: 1, reason: 'existing board semantics' },
  'src/lib/pipeline-other-studio-members.js :: OWN_STUDIO_MEMBER_SLUGS': { count: 1, reason: 'existing board semantics' },
  'shared/dashboard-metrics.js :: FUNNEL_SLUGS': { count: 1, reason: 'existing board semantics' },
  'shared/pipeline-classifier.js :: FUNNEL_STAGE_SLUGS': { count: 1, reason: 'the classifier owns the definition of the code-built funnel' },
  'shared/pipeline-classifier.js :: OFF_FUNNEL_STAGE_SLUGS': { count: 1, reason: 'the classifier owns the definition of the code-built funnel' },
  'mobile/components/dashboard/BusinessDashboard.jsx :: FUNNEL_LABELS': { count: 1, reason: 'fallback for code-built boards' },
  'mobile/components/dashboard/StudioDashboard.jsx :: STATUS_LABEL': { count: 1, reason: 'fallback for code-built boards' },
  'mobile/components/dashboard/StudioDashboard.jsx :: headlineStatuses': { count: 1, reason: 'existing board semantics' },
  'mobile/lib/mail-compose.js :: MEMBER_STAGES': { count: 1, reason: 'existing board semantics' },
}

// One whole-repo scan (~5 s) shared by the three scan-dependent tests.
const SLOW = 60_000
let scan
beforeAll(() => { scan = scanRepo() }, SLOW)

describe('pipeline stage-slug literals', () => {
  it('noNewStageSlugLists', () => {
    const { unexpected } = compareToBaseline(scan, BASELINE)
    expect(unexpected, 'a new hard-coded list of pipeline stage slugs: read the studio stage rows (shared/pipelines/) instead, or baseline it with a reason').toEqual([])
  })

  it('every baseline entry still matches a site (nothing stale)', () => {
    expect(compareToBaseline(scan, BASELINE).stale).toEqual([])
  })

  it('staleBaselineFails', () => {
    const ghost = { ...BASELINE, 'src/lib/does-not-exist.js :: GONE': { count: 1, reason: 'x' } }
    expect(compareToBaseline(scan, ghost).stale).toEqual(['src/lib/does-not-exist.js :: GONE (baseline 1, found 0)'])
    // and a shrunken count is stale too
    const [firstKey] = Object.keys(BASELINE)
    if (firstKey) {
      const bumped = { ...BASELINE, [firstKey]: { ...BASELINE[firstKey], count: BASELINE[firstKey].count + 1 } }
      expect(compareToBaseline(scan, bumped).stale).toHaveLength(1)
    }
  })

  it('the scanner reads arrays, Sets, objects and quoted keys (and ignores < 3 slugs)', () => {
    const src = `
      const A = ['new_lead', 'rebook', 'first_class']
      const B = new Set(['member', 'dormant', 'converted', 'x'])
      const C = { new_lead: 1, 'rebook': 2, first_class: 3 }
      const D = { a: 'new_lead', b: 'rebook', c: 'converted' }
      const E = ['new_lead', 'rebook']
      const F = ['new_lead', 'new_lead', 'new_lead']
    `
    expect(findSlugLiterals(src, 'x.js').map(s => s.id)).toEqual(['A', 'B', 'C', 'D'])
  })
})
