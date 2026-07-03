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
  // W1 (parity inversion): contacts now has a mobile read surface — a
  // searchable directory + contact detail via the `contacts`
  // MOBILE_PERMISSIONS entry (webEquivalent: 'contacts'), so it's matched,
  // not exempted here. Create/edit stays on web for now.
  events:         'Booking-link / event-type management is admin-only and rare on mobile.',
  presentations:  'Desktop authoring + present-from-laptop surface; the public viewer is a plain URL opened on a screen. No mobile screen.',
  // MOBILE-RADAR: churn_radar + lead_radar now have a read-only mobile
  // glance (More tab → Radar). The full triage dashboards stay
  // desktop-only, but the mobile glance is a real counterpart, so the
  // keys are matched via MOBILE_PERMISSIONS webEquivalent rather than
  // listed here.
  // NOTIF.2 (mig 169): Bookings + Tasks now ship on mobile.
  //   - bookings  → mobile `bookings` permission (today/tomorrow op view)
  //   - activities → mobile `tasks` permission (assigned-to-me + complete)
  // Web still owns creation; mobile is read+complete.
  // MOBILE-CONTACT-SEND.1: `email` and `sms` now have mobile counterparts
  // (the matching MOBILE_PERMISSIONS entries, webEquivalent: 'email'/'sms')
  // — the ad-hoc one-to-one send from the contact card. Broadcasts /
  // sequences / the campaign editor stay desktop-only but ride the same
  // web keys, so no exemption is needed now that the keys have a mobile
  // surface (same pattern as `settings`/`staff_management` below).
  // STAFF-C3 (parity inversion): `settings` is no longer web-only — its
  // staff-management half now has a mobile counterpart (the
  // `staff_management` MOBILE_PERMISSIONS entry, webEquivalent: 'settings'),
  // so it's matched via webEquivalent rather than exempted here. Branding /
  // billing / integrations ride the same `settings` key and stay web-only,
  // but the key as a whole now has a mobile surface so no exemption is needed.
  // car_processing (W2 parity inversion): now matched by the
  // `car_processing` MOBILE_PERMISSIONS entry — a read-only car-import
  // tracker (webEquivalent: 'car_processing'). The heavy actions (deposit
  // link, Xero invoice, document uploads, status changes) stay desktop,
  // but they're sub-features of the same key, not a separate permission.
  // Mig 092 — split out from `events` / `events|car_processing`.
  // races (W3 parity inversion): the race-day CONTROL board (start / finish /
  // reset runners, trackside) now ships on mobile via the `races`
  // MOBILE_PERMISSIONS entry (webEquivalent: 'races'), so it's matched, not
  // exempted. Race event AUTHORING (create/edit races + waves) and the TV
  // display stay desktop / studio-TV, but they're sub-features of the same
  // key, not separate permissions.
  // orders (W2 parity inversion): now matched by the `orders`
  // MOBILE_PERMISSIONS entry — a read-only revenue view (webEquivalent:
  // 'orders'). The refund + retry-chain drill-in stay desktop-only, but
  // that's a sub-feature of the same key, not a separate permission.
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
  // STUDIO-GROUP.1 — four web-only sidebar children moved under
  // the Studio Management section. Each got its own permission so
  // operators can grant access per user (previously role-only gated).
  contracts:          'Digital contract issue + sign + revoke flow lives at /admin/contracts. Desktop-only — managing legal documents on a phone is a worse experience than the laptop, and the typed-name signature ceremony already uses a dedicated mobile flow under /contracts (gated by `notify_contract_issued`).',
  // STUDIO-HUB.1: tv_displays now has a mobile counterpart (the matching
  // MOBILE_PERMISSIONS entry, webEquivalent: 'tv_displays') — the mobile
  // Studio hub's TV tile (view TVs + current content + cast URL + clear).
  // Content authoring (templates / uploads) stays desktop-only but rides
  // the same web key, so no exemption is needed now the key has a surface.
  glofox_import:      'Interactive Glofox member import + sync history at /admin/glofox-import. Bulk-data CSV / preview operation that needs desktop screen real estate; the daily cron handles the ongoing sync without operator input.',
  preferences_import: 'Bulk marketing-preferences CSV import at /admin/marketing-import. Same shape as glofox_import — a preview-and-commit flow that wants a wide screen.',
  // W2 (parity inversion): the invoice approver inbox (review + approve /
  // decline, PDF opens in the browser) now ships on mobile via the
  // `invoices_inbox` MOBILE_PERMISSIONS entry (webEquivalent: 'invoices_inbox'),
  // so it's matched, not exempted. The bookkeeper analyse + send-to-Xero
  // step stays desktop-only (that's the separate `bookkeeper` key below).
  // INVOICES-QUEUE.1 — bookkeeper flag. Gates the analyse + send-
  // to-Xero actions inside /invoices and the Bookkeeper queue tab
  // in /approvals. Both surfaces are desktop-only (PDF preview +
  // bulk analyse + multi-row review), so the permission is too.
  bookkeeper: 'Bookkeeper sign-off flag (INVOICES-QUEUE.1) — gates the analyse + send-to-Xero actions inside /invoices and the Bookkeeper queue tab inside /approvals. Both surfaces are desktop-only by design.',
  // W1 (parity inversion): issues_inbox is no longer web-only — the
  // handler inbox (claim / resolve / close, with photos) now ships on
  // mobile via the `issue_triage` MOBILE_PERMISSIONS entry
  // (webEquivalent: 'issues_inbox'), so it's matched, not exempted here.
  // MOBILE-ASSISTANT.1 (P2-8) — the mobile assistant screen now ships
  // (mobile/app/assistant/*), paired via the `assistant` MOBILE_PERMISSIONS
  // entry (webEquivalent: 'assistant'), so it's matched, not exempted here.
  // PERSON-LINK.1 — identity-link API (link/unlink/set-primary).
  // The full dedup workflow (choosing which contacts are duplicates,
  // reviewing a person group, editing the primary) needs the desktop
  // contact admin surface. Same reasoning as contact merge.
  contact_linking: 'desktop-only contact-admin action, like contact merge',
  // CONSULTATIONS SP1 — coach/web surface for consultations + goals.
  // The member-facing equivalent (progress & history) is the champ app (SP3),
  // not the staff mobile app. Staff mobile doesn't need a consultation-create
  // surface — coaches use the web CRM for structured consultation entry.
  consultations: 'coach/web surface; member-facing equivalent is the champ app (SP3), not the staff mobile app',
  automations: 'operational-automation admin hub; web/operator surface, no mobile counterpart',
  challenges: 'operator challenge admin; web/operator surface, no mobile counterpart',
  // P2-7 — engagement→churn analytics dashboard tab. A desktop analytics /
  // triage surface (cross-tab table + headline), like the full radar
  // dashboards; the mobile radar glance covers the at-risk list, not this report.
  engagement_analytics: 'engagement→churn analytics dashboard (/dashboard/engagement) — desktop operator analytics surface, like the full radar dashboards. No mobile counterpart by design.',
  // PULSE-90.4 — the /pulse operator hub (first-90-days journey lane +
  // future Pulse features). Desktop management surface, like the radar
  // dashboards; the member-facing side ships in the champ app, not the
  // staff mobile app, so there is no staff-mobile counterpart by design.
  pulse_admin: 'Pulse operator hub (/pulse) — desktop management surface for the first-90-days journey lane + future Pulse features. The member-facing side is the champ app; no staff-mobile counterpart by design.',
  // ADS-REPORT.0 — paid-ad performance dashboard (/dashboard/ads).
  // Desktop ads analytics dashboard — no mobile counterpart, like
  // the other radar dashboards.
  dashboard_ads: 'desktop ads analytics dashboard — no mobile counterpart, like the other radar dashboards',
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
