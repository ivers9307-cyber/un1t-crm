// UN1TRADAR.4 guard — every reader of the `memberships` membership capability
// is classified, with what a un1t.online `memberships: true` turns on for it
// (spec B §8 "What turns on"). Same mechanics as
// tests/invoices-capability-readers.test.js: a non-test file under src/,
// shared/ or mobile/ that matches and is not in MANIFEST fails with its path; a
// MANIFEST entry that no longer matches fails as stale; every entry carries a
// reason. Code is read with comments blanked.
//
// The net is the plan's broad one (any `capabilit*.memberships` and ANY
// 'memberships' string literal, so a key passed through a const or a
// `capability = 'memberships'` default is seen), widened to the derived
// gates: radarReadsFor's `providesMemberships`, `radarAvailability(` (the
// gate of the radar read APIs) and a `<MembershipSourceGate` (whose
// capability prop defaults to 'memberships'). The price is a few entries
// marked "not the capability". A floor, not a proof.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { codeOf } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'shared', 'mobile']
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')

const NOT_CAP = 'not the capability: '
const RA = "radarAvailability gate: answers un1t data at Hatch instead of data:null, unavailable:'memberships'"

/** path -> reason. The reason says what a un1t.online `memberships: true` means for the reader. */
const MANIFEST = Object.freeze({
  // crons
  'src/app/api/cron/churn-radar-snapshot/route.js': 'weekly Hatch churn_radar_snapshots row (Mon 06:00 UTC) via the seam-aware loadRadar',
  'src/app/api/cron/lead-radar-snapshot/route.js': 'weekly Hatch lead_radar_snapshots row (Mon 06:30 UTC) via the seam-aware loadFunnel',
  'src/app/api/cron/churn-radar-digest/route.js': "Monday digest email to Hatch's churn_digest_recipients list (staff only; an empty list sends nothing)",
  'src/app/api/cron/morning-briefing/route.js': "the Studio pulse strip in Hatch's briefing (counts via the seam, comparator hidden until 30 days of snapshots)",
  // pages
  'src/app/dashboard/churn-radar/page.js': 'full radar page at Hatch, incl. the digest and dunning settings cards',
  'src/app/dashboard/lead-radar/page.js': 'full lead radar page at Hatch',
  'src/app/dashboard/engagement/page.js': 'loadEngagementChurn cross-tab at Hatch (rows through the seam)',
  'src/app/dashboard/studio/page.js': 'radar-derived scorecard cells (radarOk) at Hatch',
  'src/app/dashboard/business/page.js': 'business page gate: the churn KPI and membership block read the seam',
  'src/app/(marketing)/automations/page.js': NOT_CAP + 'its MembershipSourceGate passes capability="schedule"',
  // radar read APIs (radarAvailability)
  'src/app/api/churn-radar/route.js': RA,
  'src/app/api/churn-radar/winback/route.js': RA,
  'src/app/api/churn-radar/overdue/route.js': RA,
  'src/app/api/churn-radar/unpaid-charges/route.js': RA + ' (un1t: UNAVAILABLE_TAB, no invoice data)',
  'src/app/api/churn-radar/awaiting-authorization/route.js': RA + ' (un1t: UNAVAILABLE_TAB, no invoice data)',
  'src/app/api/churn-radar/quarantine/route.js': RA + ' (GET); the POST writes contacts only at a Glofox source',
  'src/app/api/lead-radar/route.js': RA,
  'src/app/api/lead-radar/classpass/route.js': RA,
  'src/app/api/lead-radar/cleanup/route.js': RA + ' (GET); the POST writes contacts only at a Glofox source',
  'src/app/api/mobile/radar/route.js': RA + ' (phone radar sections)',
  'src/lib/today-feed-data.js': 'radarAvailability gate: the today-feed churn row counts Hatch members',
  'src/lib/radar-availability.js': 'the radar read gate itself (providesMemberships from radarReadsFor)',
  // libs and components
  'src/lib/dashboard/business-kpis.js': 'Churn risk KPI and briefing labels from the seam-aware loadRadar',
  'src/components/MembershipSourceGate.jsx': 'generic gate (capability defaults to memberships): draws "does not provide" copy only when the capability is false',
  'src/lib/membership/state-for-page.js': 'providesCapability / membershipStatePayload: provides_memberships true on the phone (business dashboard, studio-contacts)',
  'src/lib/membership/reads/index.js': "radarReadsFor's providesMemberships: the static capability every radar gate reads",
  'src/lib/membership/locations-for-source.js': 'locationIdsWithoutCapability: Hatch leaves the without-memberships list, so the snapshot and digest crons visit it',
  'src/lib/account-home.js': "portfolio home: Hatch's Members tile counts total_members through the seam's membershipCounts instead of the glofox_* head-count (Glofox studios unchanged)",
  'src/lib/dashboard/business-rail.js': "business rail Leads row: at Hatch (manual primary board) counts the acquisition board's uncontacted new_lead deals and links to the lead radar; arrearsRow reads radarReadsFor too",
  'mobile/lib/membership-source-copy.js': 'phone source card: no "does not provide membership data" card at Hatch (reads provides_memberships)',
  // matches of the net that are not the capability
  'src/lib/glofox-sync.js': NOT_CAP + "'memberships' names the Glofox membership read that failed",
  'src/lib/qualifications-server.js': NOT_CAP + "'memberships' names a failed read of coach memberships",
  'src/lib/un1t-online-status.js': NOT_CAP + "'memberships' is a sync count key",
})

const PATTERNS = Object.freeze([
  /capabilit[a-z]*\s*\??\.\s*memberships\b/,
  /'memberships'|"memberships"|`memberships`/,
  /\bprovidesMemberships\b/,
  /\bradarAvailability\s*\(/,
  /<MembershipSourceGate\b/,
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
    if (!/memberships|Memberships|radarAvailability|MembershipSourceGate/.test(raw)) continue
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

  it('the net catches each spelling, the derived gates and a const key; not the declaration', () => {
    const reads = (src) => readsMembershipsCapability(codeOf(src, 'x.jsx'))
    expect(reads('if (r.capabilities.memberships) {}')).toBe(true)
    expect(reads('if (r.capabilities?.memberships !== true) {}')).toBe(true)
    expect(reads("const x = p.capabilities['memberships']")).toBe(true)
    expect(reads("providesCapability(membership, 'memberships')")).toBe(true)
    expect(reads("const CAP = 'memberships'; await locationIdsWithoutCapability(db, CAP)")).toBe(true)
    expect(reads('<MembershipSourceGate capability="memberships" />')).toBe(true)
    expect(reads('<MembershipSourceGate state={s}>x</MembershipSourceGate>')).toBe(true)
    expect(reads('const { providesMemberships } = await radarReadsFor(db, L)')).toBe(true)
    expect(reads("const avail = await radarAvailability(db, L, { module: 'churn-radar' })")).toBe(true)
    // not readers: the capability DECLARATION, another key, a comment, a data field
    expect(reads('capabilities: Object.freeze({ memberships: true, invoices: true })')).toBe(false)
    expect(reads("providesCapability(membership, 'invoices')")).toBe(false)
    expect(reads('// r.capabilities.memberships is read elsewhere')).toBe(false)
    expect(reads('data.memberships.length')).toBe(false)
  })

})
