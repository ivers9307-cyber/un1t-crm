#!/usr/bin/env node
/**
 * Web/mobile parity linter.
 *
 * Catches the most common drift modes between the Next.js web app
 * (src/) and the Expo iOS app (mobile/):
 *
 *   1. A web sidebar permission added without a mobile counterpart
 *      (or explicit "web-only" exception).
 *   2. A mobile permission added without a web counterpart (or
 *      explicit "mobile-only" exception).
 *   3. A web sidebar nav entry in Sidebar.jsx that doesn't exist in
 *      the mobile (tabs)/_layout.jsx tab list.
 *   4. A mobile tab that has no corresponding sidebar nav entry.
 *
 * The mapping between web and mobile permission keys lives in
 * shared/permissions.js (the `webEquivalent` and `mobileOnly` fields
 * on each MOBILE_PERMISSIONS entry). Adding `mobileOnly: true` to a
 * permission tells the linter "this is intentionally mobile-only —
 * don't flag it." The opposite (web-only features) is detected by
 * the absence of any MOBILE_PERMISSIONS entry whose webEquivalent
 * matches the web key.
 *
 * Exit codes:
 *   0  — clean
 *   1  — drift found
 *
 * Usage:
 *   npm run check:mobile-parity
 *   node scripts/check-mobile-parity.js  --json   (machine-readable)
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  WEB_PERMISSIONS,
  MOBILE_PERMISSIONS,
  WEB_PERMISSION_KEYS,
  MOBILE_PERMISSION_KEYS,
  CROSS_PLATFORM_KEYS,
} from '../shared/permissions.js'

// Cross-platform keys live in WEB_PERMISSIONS only on disk but
// satisfy both web and mobile — the mobile app reads them from the
// same key. Treat them as "implicitly satisfied on mobile" so the
// linter doesn't complain about a missing webEquivalent. Mig 093
// promoted studio_management to this list; future shared-by-design
// keys go in CROSS_PLATFORM_KEYS in shared/permissions.js.
const CROSS_PLATFORM_SET = new Set(CROSS_PLATFORM_KEYS)

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// --------------------------------------------------------------------
// Web/mobile permission drift
// --------------------------------------------------------------------

// Map of web-permission-key -> array of mobile-permission-keys that
// implement it (typically 1, but `schedule` covers both the schedule
// tab and time_off requests on mobile).
const mobileByWebKey = {}
for (const m of MOBILE_PERMISSIONS) {
  if (m.mobileOnly) continue
  if (!m.webEquivalent) continue
  if (!mobileByWebKey[m.webEquivalent]) mobileByWebKey[m.webEquivalent] = []
  mobileByWebKey[m.webEquivalent].push(m.key)
}

// Web features explicitly OK to be web-only — declare here with a
// reason. The linter will accept these. Add a new entry whenever
// you ship a web feature that genuinely doesn't make sense on
// mobile.
const WEB_ONLY_OK = {
  contacts:       'Searchable contact list lives only on web for now (mobile uses pipeline drill-in).',
  events:         'Booking-link / event-type management is admin-only and rare on mobile.',
  bookings:       'Bookings list lives in the web sidebar; mobile shows no equivalent.',
  activities:     'Activity log timeline; mobile surfaces this inside deal detail.',
  email:          'Campaign editor is desktop-only.',
  sms:            'SMS broadcasts/sequences/automations + ad-hoc sends from the contact profile are web-only — alpha sender ID is configured per-location in Location Settings (mig 059). No mobile SMS UI by design.',
  settings:       'Staff/branding/billing settings are managed on web.',
  car_processing: 'Tesla import tracker (CCF Autos) — operations workflow with file uploads; not part of mobile gym workflows.',
  // Mig 092 — split out from `events` / `events|car_processing`.
  // Both are operator-side ops surfaces with no mobile equivalent
  // today. Race-day starts/finishes happen on the desktop control
  // panel (RaceControlPanel.jsx); orders + refunds are
  // admin-on-laptop work.
  races:          'Race event management + race-day control panel + TV display are desktop / studio-TV surfaces (mig 082 / 092). No mobile UI by design.',
  orders:         'Orders list + refund flow + retry-chain drill-in are desktop-only (mig 085 / 092). Mobile users with revenue questions see the contact profile timeline.',
  // Mig 120 — auto-stamped from UniFi Access door unlocks. Owner /
  // manager / master only — operator monitoring view that lives
  // inside the Schedule hub (folded under the Schedule tab strip in
  // commit 138def1). No mobile counterpart by design — staff +
  // head_coach can't see it on web either.
  attendance_reports: 'Attendance report (mig 120) is an operator monitoring view inside the desktop Schedule hub. Owner/manager/master only — staff + head_coach are blocked even on web. No mobile UI by design.',
  // Mig 126-130 — operator-side editor for the public marketing
  // landing page (un1tdublin.com / /welcome). Includes the WYSIWYG
  // iframe editor + per-block edit forms. No mobile UI: editing
  // marketing copy + uploading hero video on a phone is a worse
  // experience than just opening the laptop, and the iframe
  // preview needs screen real estate the iOS app doesn't have.
  landing_page: 'Landing-page editor (mig 126-130) — operator-side WYSIWYG marketing-page editor. Desktop-only by design; the live-preview iframe needs the screen real estate the iOS app does not have.',
}

const webDrift = []
for (const w of WEB_PERMISSIONS) {
  const has = (mobileByWebKey[w.key] || []).length > 0
  if (has) continue
  if (WEB_ONLY_OK[w.key]) continue
  if (CROSS_PLATFORM_SET.has(w.key)) continue   // mobile reads it via canDashboard()
  webDrift.push({
    web_key: w.key,
    label: w.label,
    issue: 'No mobile permission references this web feature, and it is not on the WEB_ONLY_OK list.',
    fix: `Either add a MOBILE_PERMISSIONS entry with webEquivalent: '${w.key}' in shared/permissions.js, or add '${w.key}' to WEB_ONLY_OK in this script with a reason.`,
  })
}

const mobileDrift = []
const webKeySet = new Set(WEB_PERMISSION_KEYS)
for (const m of MOBILE_PERMISSIONS) {
  if (m.mobileOnly) continue
  if (!m.webEquivalent) {
    mobileDrift.push({
      mobile_key: m.key,
      label: m.label,
      issue: 'Mobile permission has no webEquivalent and is not flagged mobileOnly.',
      fix: `Add webEquivalent: '<key>' to this entry in shared/permissions.js, or set mobileOnly: true.`,
    })
    continue
  }
  if (!webKeySet.has(m.webEquivalent)) {
    mobileDrift.push({
      mobile_key: m.key,
      web_equivalent: m.webEquivalent,
      issue: `webEquivalent points at '${m.webEquivalent}' which is not a known web permission key.`,
      fix: `Either fix the webEquivalent value, or add '${m.webEquivalent}' to WEB_PERMISSIONS in shared/permissions.js.`,
    })
  }
}

// --------------------------------------------------------------------
// Sidebar nav vs mobile tab parity
//
// We grep Sidebar.jsx for the inline nav array. This is best-effort —
// if the file structure changes the linter will skip nav-parity checks
// rather than fail loudly, since permissions parity above is the
// stronger guarantee.
// --------------------------------------------------------------------

let navDrift = []
try {
  const sidebar = readFileSync(resolve(repoRoot, 'src/components/Sidebar.jsx'), 'utf8')
  const tabs = readFileSync(resolve(repoRoot, 'mobile/app/(tabs)/_layout.jsx'), 'utf8')

  // Sidebar nav entries look like { key: 'pipeline', label: 'Pipeline', ... }
  const webNav = new Set(
    [...sidebar.matchAll(/\bkey:\s*['"]([a-z_]+)['"]/g)]
      .map(m => m[1])
      .filter(k => WEB_PERMISSION_KEYS.includes(k))
  )

  // Mobile tabs are expo-router file-based; we look for <Tabs.Screen name=…>
  const mobileNav = new Set(
    [...tabs.matchAll(/<Tabs\.Screen[\s\S]*?name=["']([a-z_-]+)["']/g)].map(m => m[1])
  )

  for (const w of webNav) {
    const mobileEquivalent = (mobileByWebKey[w] || [])[0]
    if (mobileEquivalent && !mobileNav.has(mobileEquivalent)) {
      navDrift.push({
        web_nav: w,
        issue: `Sidebar shows '${w}' but mobile has no '${mobileEquivalent}' tab.`,
        fix: `Add a Tabs.Screen entry for '${mobileEquivalent}' in mobile/app/(tabs)/_layout.jsx.`,
      })
    }
  }
} catch (err) {
  navDrift = [{ note: 'Skipped nav check (could not read Sidebar.jsx or _layout.jsx)', err: err.message }]
}

// --------------------------------------------------------------------
// Report
// --------------------------------------------------------------------

const json = process.argv.includes('--json')
const totalIssues = webDrift.length + mobileDrift.length + navDrift.filter(n => !n.note).length

if (json) {
  console.log(JSON.stringify({
    web_drift: webDrift,
    mobile_drift: mobileDrift,
    nav_drift: navDrift,
    total_issues: totalIssues,
  }, null, 2))
  process.exit(totalIssues > 0 ? 1 : 0)
}

const banner = (s) => `\n\x1b[1m${s}\x1b[0m`

if (totalIssues === 0) {
  console.log(banner('Mobile parity: clean'))
  console.log(`  ${WEB_PERMISSIONS.length} web permissions, ${MOBILE_PERMISSIONS.length} mobile permissions.`)
  console.log(`  ${Object.keys(WEB_ONLY_OK).length} web-only features explicitly excluded:`)
  for (const [k, why] of Object.entries(WEB_ONLY_OK)) {
    console.log(`    - ${k}  (${why})`)
  }
  process.exit(0)
}

console.log(banner(`Mobile parity drift: ${totalIssues} issue${totalIssues === 1 ? '' : 's'}`))

if (webDrift.length) {
  console.log(banner('Web features missing mobile counterpart:'))
  for (const d of webDrift) {
    console.log(`  • ${d.web_key}  (${d.label})`)
    console.log(`      ${d.issue}`)
    console.log(`      Fix: ${d.fix}`)
  }
}
if (mobileDrift.length) {
  console.log(banner('Mobile permissions with broken web mapping:'))
  for (const d of mobileDrift) {
    console.log(`  • ${d.mobile_key}  (${d.label || ''})`)
    console.log(`      ${d.issue}`)
    console.log(`      Fix: ${d.fix}`)
  }
}
if (navDrift.length) {
  console.log(banner('Sidebar / tab nav drift:'))
  for (const d of navDrift) {
    if (d.note) {
      console.log(`  • ${d.note} (${d.err})`)
    } else {
      console.log(`  • ${d.web_nav}: ${d.issue}`)
      console.log(`      Fix: ${d.fix}`)
    }
  }
}

process.exit(1)
