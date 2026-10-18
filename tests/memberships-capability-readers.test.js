// UN1TRADAR.4 guard — every reader of the `memberships` membership capability
// is classified, with what a un1t.online `memberships: true` turns on for it
// (spec B §8 "What turns on"). Same mechanics as
// tests/invoices-capability-readers.test.js: a non-test file under src/,
// shared/ or mobile/ that reads the capability and is not in MANIFEST fails
// with its path; a MANIFEST entry that no longer reads it fails as stale; every
// entry carries a reason. Code is read with comments blanked. A floor, not a
// proof: a key read through a variable is invisible. radarReadsFor's
// `providesMemberships` (src/lib/membership/reads/index.js) is the radar
// read APIs' gate and is listed.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOf } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

/** path -> reason. The reason says what a un1t.online `memberships: true` means for the reader. */
const MANIFEST = Object.freeze({
  'src/app/api/cron/churn-radar-snapshot/route.js': 'weekly Hatch churn_radar_snapshots row (Mon 06:00 UTC) via the seam-aware loadRadar',
  'src/app/api/cron/lead-radar-snapshot/route.js': 'weekly Hatch lead_radar_snapshots row (Mon 06:30 UTC) via the seam-aware loadFunnel',
  'src/app/api/cron/churn-radar-digest/route.js': "Monday digest email to Hatch's churn_digest_recipients list (staff only)",
  'src/app/api/cron/morning-briefing/route.js': "the Studio pulse strip in Hatch's briefing (counts via the seam, comparator hidden until 30 days of snapshots)",
  'src/app/dashboard/churn-radar/page.js': 'full radar page at Hatch, incl. the digest and dunning settings cards',
  'src/app/dashboard/lead-radar/page.js': 'full lead radar page at Hatch',
  'src/app/dashboard/engagement/page.js': 'loadEngagementChurn cross-tab at Hatch (rows through the seam)',
  'src/app/dashboard/studio/page.js': 'radar-derived scorecard cells (radarOk) at Hatch',
  'src/app/dashboard/business/page.js': 'business page gate: the churn KPI and membership block read the seam',
  'src/lib/dashboard/business-kpis.js': 'Churn risk KPI and briefing labels from the seam-aware loadRadar',
  'src/components/MembershipSourceGate.jsx': 'generic gate: draws "does not provide" copy only when the capability is false',
  'src/lib/membership/state-for-page.js': 'providesCapability / membershipStatePayload: provides_memberships true on the phone (business dashboard, studio-contacts)',
  'src/lib/membership/reads/index.js': "radarReadsFor's providesMemberships: the radar read APIs, /api/mobile/radar and the today-feed churn row answer un1t data instead of data:null",
})

const PATTERNS = Object.freeze([
  /capabilities\s*\??\.\s*memberships\b/,
  /capabilities\s*\??\.?\s*\[\s*['"`]memberships['"`]\s*\]/,
  /providesCapability\(\s*[^,()]+,\s*['"`]memberships['"`]\s*\)/,
  /locationIdsWithoutCapability\(\s*[^,()]+,\s*['"`]memberships['"`]\s*\)/,
  /capability\s*=\s*(?:["']memberships["']|\{\s*['"`]memberships['"`]\s*\})/,
  /capability\s*:\s*['"`]memberships['"`]/,
])

/** True when `code` (comments already blanked) reads the memberships capability. */
export function readsMembershipsCapability(code) {
  return PATTERNS.some((re) => re.test(code))
}

/** Compare the files found with a manifest: who is unclassified, which entries are stale, which lack a reason. */
export function classify(found, manifest) {
  const listed = Object.keys(manifest)
  return {
    unclassified: [...found].filter((f) => !(f in manifest)).sort(),
    stale: listed.filter((f) => !found.has(f)).sort(),
    unreasoned: listed.filter((f) => !String(manifest[f] || '').trim()).sort(),
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|ts|tsx)$/.test(name) && !/\.d\.ts$|\.test\.(m?js|jsx|ts|tsx)$|\.test-helpers\.(m?js|jsx|ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

function foundReaders() {
  const found = new Set()
  for (const f of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
    const raw = readFileSync(f, 'utf8')
    if (!raw.includes('memberships')) continue
    if (readsMembershipsCapability(codeOf(raw, f))) found.add(rel(f))
  }
  return found
}

describe('memberships capability readers (UN1TRADAR.4)', () => {
  it('every reader of capabilities.memberships is classified', () => {
    const { unclassified, unreasoned } = classify(foundReaders(), MANIFEST)
    expect(unclassified, 'a new reader of the memberships capability: decide what un1t.online `true` means for it, then add it to MANIFEST').toEqual([])
    expect(unreasoned).toEqual([])
  })

  it('a manifest entry that no longer matches fails as stale', () => {
    // The real tree has no stale entry...
    expect(classify(foundReaders(), MANIFEST).stale).toEqual([])
    // ...and the check itself fires: an entry the scan did not find is stale,
    // a file the manifest does not list is unclassified, a blank reason is flagged.
    const verdict = classify(new Set(['a.js', 'c.js']), { 'a.js': 'ok', 'b.js': 'gone', 'c.js': '  ' })
    expect(verdict.stale).toEqual(['b.js'])
    expect(classify(new Set(['a.js', 'd.js']), { 'a.js': 'ok' }).unclassified).toEqual(['d.js'])
    expect(verdict.unreasoned).toEqual(['c.js'])
  })

  it('the patterns read each spelling the brief lists, and nothing else', () => {
    const reads = (s) => readsMembershipsCapability(codeOf(s, 'x.jsx'))
    expect(reads('if (r.capabilities.memberships) {}')).toBe(true)
    expect(reads('if (r.capabilities?.memberships !== true) {}')).toBe(true)
    expect(reads("const x = p.capabilities['memberships']")).toBe(true)
    expect(reads("providesCapability(membership, 'memberships')")).toBe(true)
    expect(reads("await locationIdsWithoutCapability(db, 'memberships')")).toBe(true)
    expect(reads('<MembershipSourceGate capability="memberships" />')).toBe(true)
    expect(reads("const g = { capability: 'memberships' }")).toBe(true)
    // not readers: the capability DECLARATION, another key, a comment
    expect(reads('capabilities: Object.freeze({ memberships: true, invoices: true })')).toBe(false)
    expect(reads("providesCapability(membership, 'invoices')")).toBe(false)
    expect(reads('// r.capabilities.memberships is read elsewhere')).toBe(false)
    expect(reads('data.memberships.length')).toBe(false)
  })
})
