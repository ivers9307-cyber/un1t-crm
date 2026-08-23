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
 *   3. A mobile nav feature (MOBILE_NAV_FEATURES in shared/mobile-nav.js
 *      — the bar/More registry the app actually renders) whose
 *      permission key has no representation anywhere in the web
 *      sidebar nav (ALL_NAV in src/lib/nav-items.js). See the "Sidebar
 *      nav vs mobile nav parity" section below for the parsing +
 *      comparison semantics and why this check is one-directional.
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
  // FLEET-CMD.1 — deferred, NOT excluded on principle. Richard chose
  // desktop-first for P1. `fleet_restart` in particular WANTS a mobile
  // counterpart in P3: the person who notices a frozen leaderboard is a coach
  // mid-class holding a phone, not someone at a desk. Revisit this entry then
  // rather than treating it as settled.
  fleet_restart:  'FLEET-CMD.1 P1 is desktop-only (Richard). Mobile is planned as P3 — see the spec; this exemption is temporary.',
  fleet_admin:    'Reboot/shutdown/redeploy are deliberate, low-frequency actions taken at a desk. No mobile screen planned.',
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
  glofox_import:      'Interactive Glofox member import + sync history at /settings/glofox-import. Bulk-data CSV / preview operation that needs desktop screen real estate; the daily cron handles the ongoing sync without operator input.',
  preferences_import: 'Bulk marketing-preferences CSV import at /settings/marketing-import. Same shape as glofox_import — a preview-and-commit flow that wants a wide screen.',
  // W2 (parity inversion): the invoice approver inbox (review + approve /
  // decline, PDF opens in the browser) now ships on mobile via the
  // `invoices_inbox` MOBILE_PERMISSIONS entry (webEquivalent: 'invoices_inbox'),
  // so it's matched, not exempted.
  // INV-M.1 (parity inversion): `bookkeeper` is no longer web-only — the
  // mobile bookkeeper queue (app/invoices/queue.jsx: multi-select bulk
  // extract + the Not-in-Xero supplier flag) reads the same top-level key
  // via CROSS_PLATFORM_KEYS, so it's matched, not exempted. Field edits +
  // the send-to-Xero step stay desktop-only, but they're sub-features of
  // the same key, not a separate permission.
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
  // RCOV.P0 — receipt-coverage board (/accounting). Desktop
  // bookkeeping surface, like bookkeeper/invoices analyse-and-send
  // flows; mobile counterpart deferred to RCOV.P2.
  accounting_hub: 'Desktop bookkeeping surface (coverage board); mobile counterpart deferred to RCOV.P2',
  // APPROVALS-PERCAT.1 — six per-category approval grants (splitting the
  // former all-or-nothing approvals_inbox). Each gates a source
  // approve/decline route + the inbox tab for that category; the mobile
  // `approvals` permission (webEquivalent: 'approvals_inbox') still covers
  // the aggregate mobile approvals surface. No per-category mobile grant
  // yet — revisit if/when mobile splits its own approvals screen by category.
  approvals_contractor_invoices: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_fte_expenses: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_agent_requests: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_time_off: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_shift_swaps: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_rosters: 'Per-category approval grant (APPROVALS-PERCAT.1). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  approvals_offer_purchases: 'Per-category approval grant (OFFERS.6). Mobile approvals surface is still gated by the aggregate `approvals` permission; no per-category mobile split yet.',
  // approvals_hyrox_sessions dropped from WEB_ONLY_OK: the mobile `hyrox`
  // feature (webEquivalent: 'approvals_hyrox_sessions') now covers it.
  equipment_admin: 'Register + checklist + interval setup is a desktop task; the mobile counterpart is equipment_inspect (the walk-round), which is matched via webEquivalent.',
  // email_inbox (EMAIL-TICKET-M.1 parity inversion): dropped from this list.
  // The mobile UI it was waiting on now exists — the Messages tab's email
  // channel and the ticket thread ride /api/email/tickets*, and those routes
  // gate on the TOP-LEVEL `email_inbox` key. Mobile therefore reads the same
  // top-level key via CROSS_PLATFORM_KEYS (like `bookkeeper`) rather than a
  // `.mobile`-namespaced counterpart, so the UI gate and the server gate
  // cannot drift apart. Mailbox tabs / compose-new / HTML rendering stay
  // desktop-only, but they are sub-features of the same key.
  // ZOOMOPS.1 — Zoom Phone contact sync operator controls.
  integrations_zoom_manage: 'Settings surface — no mobile equivalent; the destructive controls need a confirmation dialog the mobile app has no home for.',
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
// Sidebar nav vs mobile nav parity
//
// TOOLING-PARITY-CHECK.1 — this used to grep Sidebar.jsx for `key: '…'`
// nav entries and mobile/app/(tabs)/_layout.jsx for `<Tabs.Screen
// name="…">`. Both sources went stale without anyone noticing:
//   - Sidebar.jsx's nav array moved to src/lib/nav-items.js's ALL_NAV
//     (SIDEBAR-IA.1 / HUBS.2a) and stopped using a `key:` field at all
//     (`grep -c "key:\s*['\"]" src/components/Sidebar.jsx` → 0) — so
//     `webNav` was always the empty set.
//   - _layout.jsx's real tab list is data-driven (`name={key}`, a JS
//     expression, not a quoted literal) — only the two hardcoded
//     screens ("index", "more") ever matched the quoted-literal regex,
//     and neither is a permission-bearing tab.
// Both sides therefore silently produced zero candidates forever, so
// the `for` loop below never ran and this check never found anything —
// it just always reported clean. The bug that killed it (a dead check
// reporting success) is exactly the class of bug this check exists to
// catch, which is why the zero-entries guard below is CRITICAL: from
// now on, parsing either side down to nothing is a hard failure, not a
// quiet no-op.
//
// Correct sources today:
//   - Web: ALL_NAV in src/lib/nav-items.js. Each entry carries a single
//     `permission: '<key>'` OR an `anyPermission: [...]` OR-list (the
//     hub collapse — HUBS.2a onward — turned most entries into unions
//     of several permissions rather than one-key-per-entry), plus a
//     few `openToAll: true` entries with no permission field at all.
//     Also parsed: the DASHBOARD_LINK_PERM_KEYS export, which the
//     file's own header comment documents as OR'd into the pinned
//     Dashboard link's visibility (churn_radar/lead_radar/
//     engagement_analytics/dashboard_ads never get their own ALL_NAV
//     entry — they're reachable only through that union).
//   - Mobile: MOBILE_NAV_FEATURES in shared/mobile-nav.js. Each entry
//     carries a `permKeys: [...]` OR-list — the real bar/More registry
//     that resolveMobileLayout() renders from (unlike the old
//     _layout.jsx grep, this is genuinely where "is this feature
//     mobile-navigable" is decided).
//
// Comparison semantics — ONE direction only: does every mobile nav
// feature's permission resolve to something present in the web nav's
// permission union?
//
//   for each permKey in MOBILE_NAV_FEATURES:
//     resolve permKey -> its web-equivalent key (CROSS_PLATFORM_KEYS
//       for a shared-name key like studio_management; otherwise the
//       matching MOBILE_PERMISSIONS entry's `webEquivalent`; skip
//       outright if that entry is `mobileOnly: true` — those are
//       declared to have no web side at all, same "don't flag it"
//       contract the permission-parity check above already honours)
//     the resolved key MUST appear in webNavKeys (or the small,
//       documented WEB_NAV_OPEN_TO_ALL_KEYS exemption below)
//
// The reverse direction (a web nav permission key with no mobile nav
// feature) is deliberately NOT checked here. The permission-parity
// check above (webDrift, using the full WEB_PERMISSIONS list and the
// curated WEB_ONLY_OK exemptions) already owns that question at the
// permission-registry level, with reasons on file for every exemption.
// Re-deriving it here from the narrower nav-only data would either
// duplicate that check with weaker data, or need to re-invent
// WEB_ONLY_OK's exemption list a second time for hub-union keys that
// were never meant to be mobile-navigable (e.g. `automations` inside
// the Marketing hub's union) — the hub collapse is exactly why "one web
// nav entry ↔ one mobile tab" no longer holds, so this check only makes
// the claim that survives it: mobile's own chosen nav surface should
// point at something real.
//
// SHELLY-UI.8 — `device_control` used to be named above as a second
// example of a never-mobile-navigable hub-union key. It is not one, and
// hasn't been since SONOSMOB.2: shared/mobile-nav.js's Studio entry
// lists it in permKeys, and it rides CROSS_PLATFORM_KEYS (the
// `CROSS_PLATFORM_SET.has(w.key)` skip in webDrift above) rather than a
// WEB_ONLY_OK entry, which is why it appears in neither map. What is
// web-only is the AUTHORING half of both of its surfaces —
// /automations/sonos (playback windows, run-now, pause override) and
// /automations/shelly (power windows, class-linked rules, adopt/remove,
// 30-day kWh history) — schedule editors that want the screen. Mobile
// today offers live Sonos control only; a live on/off toggle for an
// adopted Shelly plug is the first planned mobile counterpart (see
// docs/BACKLOG.md, "Shelly smart plugs — deferred by decision"). When it
// ships it rides the same top-level key, so nothing in this file has to
// change for it.
// --------------------------------------------------------------------

const navItemsSrc = readFileSync(resolve(repoRoot, 'src/lib/nav-items.js'), 'utf8')
const mobileNavSrc = readFileSync(resolve(repoRoot, 'shared/mobile-nav.js'), 'utf8')

// `permission: '<key>'` — deliberately excludes `anyPermission:` (capital
// P, a different token) via the negative lookbehind.
const webSingle = [...navItemsSrc.matchAll(/(?<!any)\bpermission:\s*'([a-zA-Z_]+)'/g)].map(m => m[1])
// `anyPermission: ['a', 'b', ...]`
const webAny = [...navItemsSrc.matchAll(/anyPermission:\s*\[([^\]]+)\]/g)]
  .flatMap(block => [...block[1].matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1]))
// DASHBOARD_LINK_PERM_KEYS = [ 'dashboard_personal', ... ] — OR'd into
// the pinned Dashboard link per the file's own header comment; the
// radar/engagement/ads keys have no other ALL_NAV representation.
const dashboardLinkBlock = navItemsSrc.match(/DASHBOARD_LINK_PERM_KEYS\s*=\s*\[([^\]]+)\]/)
const webDashboardLink = dashboardLinkBlock
  ? [...dashboardLinkBlock[1].matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1])
  : []

// Team hub (`/team`) is `openToAll: true` — no permission/anyPermission
// field, so the regexes above find nothing for it, yet /schedule is
// genuinely reachable there for every signed-in user (POLICIES.1 /
// HUBS.2d). Mobile's `schedule` nav feature (webEquivalent 'schedule')
// would otherwise false-positive every run; this is the one documented
// exemption the openToAll shape needs.
const WEB_NAV_OPEN_TO_ALL_KEYS = new Set(['schedule'])

const webNavKeys = new Set([...webSingle, ...webAny, ...webDashboardLink])

const mobilePermKeysBlocks = [...mobileNavSrc.matchAll(/permKeys:\s*\[([^\]]+)\]/g)]
const mobileNavKeys = new Set(
  mobilePermKeysBlocks.flatMap(block => [...block[1].matchAll(/'([a-zA-Z_]+)'/g)].map(m => m[1]))
)

// CRITICAL guard — the exact failure mode that killed the old check:
// both sides silently parsing to zero entries and the loop below
// simply never running. Fail loudly instead of reporting a false
// "clean".
if (webNavKeys.size === 0) {
  throw new Error(
    'check-mobile-parity: parsed ZERO permission keys out of ALL_NAV in src/lib/nav-items.js. ' +
    'The regex (permission:/anyPermission:/DASHBOARD_LINK_PERM_KEYS) no longer matches this file\'s shape — fix the parser, don\'t silence this.'
  )
}
if (mobileNavKeys.size === 0) {
  throw new Error(
    'check-mobile-parity: parsed ZERO permKeys out of MOBILE_NAV_FEATURES in shared/mobile-nav.js. ' +
    'The regex (permKeys: [...]) no longer matches this file\'s shape — fix the parser, don\'t silence this.'
  )
}

const mobileKeyToWebEquivalent = Object.fromEntries(MOBILE_PERMISSIONS.map(m => [m.key, m.webEquivalent]))
const mobileOnlySet = new Set(MOBILE_PERMISSIONS.filter(m => m.mobileOnly).map(m => m.key))

const navDrift = []
for (const permKey of mobileNavKeys) {
  if (mobileOnlySet.has(permKey)) continue // declared mobile-only — no web side to check against

  const resolved = CROSS_PLATFORM_SET.has(permKey) ? permKey : mobileKeyToWebEquivalent[permKey]

  if (!resolved) {
    navDrift.push({
      mobile_nav_key: permKey,
      issue: `MOBILE_NAV_FEATURES references permKey '${permKey}', which is neither a CROSS_PLATFORM_KEYS entry nor a known MOBILE_PERMISSIONS key with a webEquivalent.`,
      fix: `Check the permKey for a typo, or add a MOBILE_PERMISSIONS entry (or CROSS_PLATFORM_KEYS entry) for '${permKey}' in shared/permissions.js.`,
    })
    continue
  }

  if (!webNavKeys.has(resolved) && !WEB_NAV_OPEN_TO_ALL_KEYS.has(resolved)) {
    navDrift.push({
      mobile_nav_key: permKey,
      web_equivalent: resolved,
      issue: `Mobile nav resolves '${permKey}' to web key '${resolved}', which has no permission/anyPermission entry anywhere in ALL_NAV (src/lib/nav-items.js).`,
      fix: `Either add '${resolved}' to a permission/anyPermission field in ALL_NAV, or add it to WEB_NAV_OPEN_TO_ALL_KEYS in this script with a reason (openToAll nav entries only).`,
    })
  }
}

// --------------------------------------------------------------------
// Report
// --------------------------------------------------------------------

const json = process.argv.includes('--json')
const totalIssues = webDrift.length + mobileDrift.length + navDrift.length

if (json) {
  console.log(JSON.stringify({
    web_drift: webDrift,
    mobile_drift: mobileDrift,
    nav_drift: navDrift,
    nav_counts: { web_nav_keys: webNavKeys.size, mobile_nav_keys: mobileNavKeys.size },
    total_issues: totalIssues,
  }, null, 2))
  process.exit(totalIssues > 0 ? 1 : 0)
}

const banner = (s) => `\n\x1b[1m${s}\x1b[0m`

if (totalIssues === 0) {
  console.log(banner('Mobile parity: clean'))
  console.log(`  ${WEB_PERMISSIONS.length} web permissions, ${MOBILE_PERMISSIONS.length} mobile permissions.`)
  console.log(`  ${webNavKeys.size} web nav permission keys, ${mobileNavKeys.size} mobile nav permKeys checked.`)
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
  console.log(banner('Sidebar / mobile nav drift:'))
  for (const d of navDrift) {
    console.log(`  • ${d.mobile_nav_key}: ${d.issue}`)
    console.log(`      Fix: ${d.fix}`)
  }
}

process.exit(1)
