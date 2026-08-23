// BUNDLES.5 — the feature-bundle layer. The programme's final phase:
// a sellable, location/plan-level gate that sits ABOVE the ~110
// fine-grained WEB_PERMISSIONS / MOBILE_PERMISSIONS keys in
// shared/permissions.js, so a SaaS location can be provisioned by
// setting ≤8 bundle flags instead of ~47 individual keys (Task 3
// wires the plan mirror + seeding; this file is the pure data + the
// resolver primitive both Task 1's wiring and Task 2's approvals
// registry consume).
//
// Grounding: docs/superpowers/plans/2026-08-16-phase5-bundles.md
// ("Corrected facts" + "Design decisions" sections) plus a fresh read
// of shared/permissions.js (WEB_PERMISSIONS / MOBILE_PERMISSIONS) and
// src/lib/nav-items.js (the sidebar hub `anyPermission` unions — the
// most direct evidence for which hub a given key actually gates).
//
// Storage + polarity: bundle keys (`bundle_*` + `module_cars`) live in
// `locations.features` ALONGSIDE the existing per-key entries (mig
// 032), using the SAME deny-by-explicit-false polarity — missing or
// `true` = enabled, only an explicit `false` denies. `{}` (today's
// shape on every existing location) therefore still means "everything
// on" — back-compat is sacred, see the polarity tests in
// permission-bundles.test.js.
//
// Plain JS, no Next.js / React imports — the shared/ web+mobile seam
// (see the header comment in shared/permissions.js).

// ============================================================
// BUNDLE_KEYS — one per sidebar hub (src/lib/nav-items.js
// NAV_SECTIONS: messages, sales, members, money, marketing, team,
// operations) plus one vertical module (Cars). Home and Settings are
// never bundle-gated — every tenant has them regardless of plan.
// ============================================================

export const BUNDLE_KEYS = Object.freeze([
  'bundle_messaging',
  'bundle_sales',
  'bundle_members',
  'bundle_money',
  'bundle_marketing',
  'bundle_team',
  'bundle_operations',
  // module_cars — vertical module, not a hub. Opt-in in spirit (Task 3
  // seeds it off for a new location) but uses the SAME explicit-false
  // polarity as every other bundle key — an unset module_cars is not
  // itself denied, Task 3's seeding is what actually keeps it off for
  // new locations. Replaces nothing: `car_processing` maps to it 1:1.
  'module_cars',
])

// ============================================================
// BUNDLE_LABELS — human-readable label per BUNDLE_KEYS entry, for the
// Task 3 UI (LocationFeatures.jsx / AdminFeatureMatrix.jsx bundles
// section). Mirrors the hub labels in src/lib/nav-items.js ALL_NAV.
// ============================================================

export const BUNDLE_LABELS = Object.freeze({
  bundle_messaging: 'Messages',
  bundle_sales: 'Sales',
  bundle_members: 'Members',
  bundle_money: 'Money',
  bundle_marketing: 'Marketing',
  bundle_team: 'Team',
  bundle_operations: 'Operations',
  module_cars: 'Cars (module)',
})

// ============================================================
// KEY_BUNDLES — key → array of bundles that OWN it.
//
// This is a SET, not a partition: several keys legitimately belong to
// more than one bundle, because src/lib/nav-items.js's own
// `anyPermission` unions already OR the same underlying key into more
// than one hub's sidebar entry:
//   - `email` / `whatsapp` / `sms`   → both bundle_messaging (the
//     Messages hub / inbox) AND bundle_marketing (the Marketing hub's
//     campaign lifecycle + Automations' custom-flow gate).
//   - `studio_management`            → both bundle_members (the live
//     HR floor view) AND bundle_operations (the door/TV/presentations
//     panel).
//   - `device_control`               → both bundle_marketing (the
//     '/marketing' union, where its pages physically live) AND
//     bundle_operations (studio hardware: Sonos speakers, Shelly smart
//     plugs). SHELLY-UI.8 — see the pair's own comment below.
// bundlesDenyKey() below applies OR semantics the other way: a key is
// only bundle-denied when EVERY bundle that owns it is explicitly
// off. Phase 4B's chrome split did NOT split these keys apart, so
// this layer doesn't invent new ones either — it just OWNS the
// existing keys from more than one bundle where reality already does.
//
// Every key here is verified against a real page/gate (nav-items.js
// unions where they exist; the actual gating call site otherwise —
// cited per group below). Keys with NO natural hub (the plan's "17
// unassigned" + a handful of mobile-only keys nav-items.js never
// mentions because it's a web-only sidebar module) get an inline
// comment explaining the call.
//
// Completeness: every WEB_PERMISSIONS + MOBILE_PERMISSIONS key
// (shared/permissions.js) is either here, in CORE_KEYS, or in
// EXEMPT_KEYS — enforced by permission-bundles.test.js against the
// LIVE exports, not a hard-coded count.
// ============================================================

export const KEY_BUNDLES = Object.freeze({
  // ---- bundle_sales — src/lib/nav-items.js '/sales' anyPermission ----
  pipeline: ['bundle_sales'],
  contacts: ['bundle_sales'],
  activities: ['bundle_sales'],
  // lead_radar / churn_radar / engagement_analytics render INSIDE the
  // Dashboard tab strip (DASHBOARD_LINK_PERM_KEYS ORs them into the
  // pinned Dashboard sidebar link's visibility), which is why they
  // could be mistaken for core dashboard_* keys — but they are
  // distinct, substantive features (retention/lead-triage tooling), so
  // they get real bundle homes by data domain rather than riding
  // dashboard_*'s core exemption. lead_radar triages leads / trials /
  // ClassPass — pipeline/CRM territory.
  lead_radar: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned — no natural hub in
  // nav-items.js; AppShell mounts the AssistantBubble globally, not
  // inside any one hub route). Its own hint reads "In-app chat
  // assistant with CRM tool use" — grouped with the other CRM-data
  // utilities in this bundle rather than given a hub of its own.
  assistant: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned; plan draft: "→ bundle_sales?").
  // src/app/settings/glofox-import/page.js imports Glofox members
  // INTO contacts — a contacts/CRM-data operation surfaced from the
  // Settings index, not a Settings-key gate itself.
  glofox_import: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned; plan draft: "→ bundle_sales?").
  // src/app/settings/marketing-import/page.js bulk-imports marketing
  // consent onto contacts — same contact-data-utility class as
  // glofox_import above.
  preferences_import: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned; plan draft: "→ bundle_sales?").
  // Non-destructive identity linking, reached from
  // src/app/(sales)/contacts/page.js / contacts/[id]/page.js.
  contact_linking: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned; plan draft: "→ bundle_sales?").
  // Consultations/goals tab lives on src/app/(sales)/contacts/[id]/page.js.
  consultations: ['bundle_sales'],
  // JUDGEMENT CALL (plan's 17 unassigned — not in the plan's draft
  // list at all). Zoom Phone CONTACT-directory sync
  // (src/app/settings/integrations/zoom-contacts/page.js) — grouped
  // with the other contact-sync utilities above rather than
  // bundle_messaging, since what it moves is contact records, not
  // conversations.
  integrations_zoom_manage: ['bundle_sales'],
  // Mobile-only; webEquivalent: 'activities' (see MOBILE_PERMISSIONS) —
  // follows its web twin into bundle_sales.
  tasks: ['bundle_sales'],

  // ---- bundle_members — src/lib/nav-items.js '/members' anyPermission ----
  // churn_radar / engagement_analytics: see the lead_radar note above —
  // dashboard-tab-strip surfaces, bundled by data domain (at-risk /
  // engaged MEMBERS), not core dashboard_* keys.
  churn_radar: ['bundle_members'],
  engagement_analytics: ['bundle_members'],
  pulse_admin: ['bundle_members'],
  events: ['bundle_members'],
  bookings: ['bundle_members'],
  races: ['bundle_members'],
  // OR semantics — also owned by bundle_operations. See the KEY_BUNDLES
  // header comment; both the '/members' and '/operations' nav-items.js
  // unions list `studio_management`.
  studio_management: ['bundle_members', 'bundle_operations'],
  class_timer: ['bundle_members'],
  challenges: ['bundle_members'],
  // Mobile-only Hyrox planner. Its webEquivalent is
  // 'approvals_hyrox_sessions' (an EXEMPT approval sub-permission, for
  // the parity linter only) but the SCREEN itself is the mobile mirror
  // of the Members-hub Hyrox Training Club surface, so it gets a real
  // bundle home rather than following its webEquivalent into EXEMPT.
  hyrox: ['bundle_members'],

  // ---- bundle_money — src/lib/nav-items.js '/money' anyPermission ----
  orders: ['bundle_money'],
  card_receipts: ['bundle_money'],
  invoices_inbox: ['bundle_money'],
  accounting_hub: ['bundle_money'],
  // JUDGEMENT CALL (plan's 17 unassigned — not in nav-items.js at all,
  // since /money's tab strip reaches it via a route outside the hub's
  // own territory, same pattern as the fleet/live cross-hub tabs).
  // Gates /invoices' analyse + send-to-Xero actions and the bookkeeper
  // queue tab in /approvals (see the invoices_queue provider in Task
  // 2) — squarely the Money/Xero domain alongside invoices_inbox.
  bookkeeper: ['bundle_money'],

  // ---- bundle_messaging + bundle_marketing (shared — design decision) ----
  // src/lib/nav-items.js '/communications' (Messages) anyPermission
  // AND '/marketing' anyPermission both list these three.
  email: ['bundle_messaging', 'bundle_marketing'],
  whatsapp: ['bundle_messaging', 'bundle_marketing'],
  sms: ['bundle_messaging', 'bundle_marketing'],
  email_inbox: ['bundle_messaging'],

  // ---- bundle_marketing only — src/lib/nav-items.js '/marketing' anyPermission ----
  automations: ['bundle_marketing'],
  landing_page: ['bundle_marketing'],

  // ---- bundle_marketing + bundle_operations (shared — SHELLY-UI.8) ----
  // OR semantics, exactly as for `studio_management` and `email` above:
  // a location KEEPS device control while EITHER bundle is on, and only
  // loses it when Marketing AND Operations are both explicitly false.
  //
  // Richard's decision (2026-08-22): what this key gates is studio
  // HARDWARE — Sonos speakers (/automations/sonos) and Shelly smart
  // plugs (/automations/shelly, SHELLY-UI) — power and playback
  // schedules for the building. That is an operations concern as much
  // as a marketing one, and an Operations-only tenant that bought no
  // Marketing bundle must still be able to switch its own plugs on.
  //
  // Behaviour-neutral for every location live today: widening an OR set
  // can only ever ADD holders, never remove one, and the 2026-08-22 prod
  // snapshot found no location with `bundle_marketing: false` at all (a
  // re-run before merge is Obligation 17 of the SHELLY-UI plan).
  //
  // CONSEQUENCE, so nobody is surprised later: a location that used to
  // hide the device-control surfaces by turning Marketing OFF no longer
  // hides them by that alone — with Operations on, the bundle layer now
  // allows the key, so hiding it takes a per-user/per-role
  // `device_control: false` (or the location's own per-key feature
  // toggle, which is an independent AND clause — see
  // isFeatureEnabledAtLocation in shared/permissions.js).
  //
  // NAV UNIONS ARE UNCHANGED: `device_control` already sits in
  // src/lib/nav-items.js's '/marketing' anyPermission union (and the
  // Automations page's own gate), and this file does not touch nav. So
  // an Operations-only tenant sees the MARKETING sidebar entry purely as
  // the door to /automations — accepted rather than fixed here, because
  // splitting the nav entry is a hub-IA change, not a bundle change.
  device_control: ['bundle_marketing', 'bundle_operations'],

  // ---- bundle_team — src/lib/nav-items.js '/team' extraActivePaths ----
  // (the Team hub entry itself is openToAll — see the note above
  // CORE_KEYS below — so there is no anyPermission union to cite here;
  // these are the permission keys the pages BEHIND those paths gate on.)
  schedule: ['bundle_team'],
  // Per plan: Attendance tab inside ScheduleTabs.jsx (showAttendance).
  attendance_reports: ['bundle_team'],
  // Per plan: staff/contractor contracts, reached at /team → /contracts.
  contracts: ['bundle_team'],
  // Mobile-only; webEquivalent: 'schedule' — Time Off Requests.
  time_off: ['bundle_team'],
  // JUDGEMENT CALL — mobile contractor self-submit. No web permission
  // key of its own (ScheduleTabs.jsx's Invoices tab gates on
  // employment_type, not a permission key) but it's the submitter side
  // of the same Team/Schedule surface attendance_reports/contracts sit
  // beside — see src/components/ScheduleTabs.jsx `showInvoices`.
  invoices: ['bundle_team'],
  // JUDGEMENT CALL — mobile FTE self-submit, same reasoning as
  // `invoices` above (src/components/ScheduleTabs.jsx `showExpenses`).
  expenses: ['bundle_team'],

  // ---- bundle_operations — src/lib/nav-items.js '/operations' anyPermission ----
  equipment_admin: ['bundle_operations'],
  equipment_inspect: ['bundle_operations'],
  tv_displays: ['bundle_operations'],
  presentations: ['bundle_operations'],
  fleet_restart: ['bundle_operations'],
  fleet_admin: ['bundle_operations'],
  // ---- module_cars ----
  // Per plan: "module_cars replaces nothing: car_processing maps to it
  // 1:1." src/lib/nav-items.js '/cars/active' permission: 'car_processing'.
  car_processing: ['module_cars'],
})

// ============================================================
// CORE_KEYS — never bundle-gated. Every tenant has these regardless
// of which bundles they hold (per the plan: "settings, dashboards,
// issues_inbox, approvals_inbox = never-bundled (core)"), plus their
// direct mobile-only mirrors (each mirrors a core web key via
// `webEquivalent` in MOBILE_PERMISSIONS — comment per key below).
//
// NOTE: `bundle_team`'s hub ENTRY is openToAll (policies is
// login-only, per HUBS.2d) — that's a *sidebar-visibility* fact, not a
// bundle exemption. The Team hub's actual features (schedule,
// contracts, attendance_reports, …) are real bundle_team members
// above; bundle-off hides those TABS, not the /team hub shell itself.
// Documented here so a reader doesn't mistake "hub is openToAll" for
// "hub's keys are core."
// ============================================================

export const CORE_KEYS = Object.freeze([
  // The three cross-platform dashboard sub-views + the ads dashboard —
  // literal `dashboard_*` keys only. Distinct from churn_radar /
  // lead_radar / engagement_analytics, which are separate bundled
  // features that merely render as additional dashboard tabs (see the
  // KEY_BUNDLES comments above).
  'dashboard_personal',
  'dashboard_studio',
  'dashboard_business',
  'dashboard_ads',
  'settings',
  'issues_inbox',
  'approvals_inbox',
  // Mobile mirror of approvals_inbox (webEquivalent). The aggregator
  // itself stays core; Task 2 is what makes the CATEGORIES inside it
  // (contractor invoices, expenses, …) respect their own bundle.
  'approvals',
  // Mobile mirror of settings (webEquivalent) — staff directory + role
  // editors, the mobile half of the never-bundled config surface.
  'staff_management',
  // Mobile mirror of issues_inbox (webEquivalent) — the handler triage
  // inbox, same core exemption as its web twin.
  'issue_triage',
  // JUDGEMENT CALL — mobile-only personal master switch for ALL push
  // notifications. Not owned by any single hub (it silences every
  // category, hub or no hub); treated like settings/dashboards so a
  // tenant always retains control over their own device notifications
  // regardless of which bundles they hold. NOT one of `NOTIFY_KEYS` in
  // shared/permissions.js (no `isNotify` flag), so it stays subject to
  // its own individual `features.push_notifications` toggle exactly as
  // it always was — this classification only stops a BUNDLE from also
  // being able to deny it.
  'push_notifications',
  // ---- R1 (final-review rider) — moved OUT of KEY_BUNDLES into CORE ----
  // `issues` (mobile "Report a Problem") and `policies` (mobile HR-policy
  // reading) were originally bundled (issues → bundle_operations, policies
  // → bundle_team). Review finding: both are baseline/compliance surfaces
  // whose WEB analogues are deliberately ungated already — POST
  // /api/issues has "no permission gate" by design (any authenticated
  // profile may flag a problem) and the web Policies page is login-only
  // (POLICIES.1, no permission key at all). Letting a bundle hide the
  // MOBILE mirror of an intentionally-always-on web surface would be an
  // unintended side effect of the bundle layer, not a real product
  // decision — exactly the class of thing CORE_KEYS exists to prevent.
  // Promoted here instead; see permission-bundles.test.js for the pinned
  // assertions.
  'issues',
  'policies',
])

// ============================================================
// EXEMPT_KEYS — keys that were NEVER location-gated PER-KEY in the
// first place (shared/permissions.js `isFeatureGatedByLocation`): the
// 25 personal `notify_*` toggles and the 8 `approvals_*` per-category
// grants. bundlesDenyKey() (the KEY_BUNDLES-based single-key check)
// never denies them — that part is still exactly as documented before.
//
// BUNDLES.5 final-review fix 1 — the two halves of EXEMPT_KEYS are NO
// LONGER symmetric w.r.t. the bundle layer AS A WHOLE, only w.r.t.
// bundlesDenyKey specifically:
//   - `notify_*` (NOTIFY_KEYS) stay FULLY exempt — isFeatureEnabledAtLocation
//     short-circuits them to `true` unconditionally, same as always.
//   - `approvals_*` (APPROVAL_SUBPERMISSION_KEYS) are exempt from their
//     OWN per-key toggle only. isFeatureEnabledAtLocation now runs a
//     SEPARATE check for them — bundlesDenyCategory() against
//     CATEGORY_BUNDLES below, via each key's owning category
//     (shared/permissions.js APPROVAL_CATEGORY_PERMISSION) — so an
//     approvals_* key DOES get denied when every bundle owning its
//     category is off, even though `features['approvals_x'] = false`
//     alone still does nothing. See isFeatureEnabledAtLocation's own
//     comment for why (the Money-hub chrome-leak this closes).
// This classification (KEY_BUNDLES/CORE_KEYS/EXEMPT_KEYS) itself is
// UNCHANGED by that fix — approvals_* keys still don't belong in
// KEY_BUNDLES, because their bundle-following runs through the
// separate CATEGORY_BUNDLES mechanism, not this file's per-key one.
//
// Deliberately a LITERAL list, not `[...NOTIFY_KEYS,
// ...APPROVAL_SUBPERMISSION_KEYS]` imported from shared/permissions.js
// — permissions.js is about to import bundlesDenyKey FROM this file
// (Task 1's resolver wiring), and NOTIFY_KEYS / APPROVAL_SUBPERMISSION_KEYS
// are defined well after WEB_PERMISSIONS/MOBILE_PERMISSIONS in that
// file's top-to-bottom eval order — importing them back here would be
// a circular import racing module-init order. permission-bundles.test.js
// cross-checks this literal list against the live NOTIFY_KEYS /
// APPROVAL_SUBPERMISSION_KEYS exports every run, so drift fails loudly
// instead of silently.
// ============================================================

export const EXEMPT_KEYS = Object.freeze([
  // -- the 8 approvals_* per-category grants (APPROVAL_SUBPERMISSION_KEYS) --
  'approvals_contractor_invoices',
  'approvals_fte_expenses',
  'approvals_agent_requests',
  'approvals_time_off',
  'approvals_shift_swaps',
  'approvals_rosters',
  'approvals_hyrox_sessions',
  'approvals_offer_purchases',
  // -- the 25 personal notify_* toggles (NOTIFY_KEYS) --
  'notify_time_off',
  'notify_schedule',
  'notify_swap',
  'notify_lead',
  'notify_whatsapp',
  'notify_instagram',
  'notify_email',
  'notify_agent_activity',
  'notify_agent_requests',
  'notify_host_event_review',
  'notify_invoice_approved',
  'notify_invoice_declined',
  'notify_expense_submitted',
  'notify_expense_approved',
  'notify_expense_declined',
  'notify_shift_adjusted',
  'notify_contract_issued',
  'notify_tasks',
  'notify_bookings',
  'notify_checklist_overdue',
  'notify_checklist_compliance',
  'notify_issue_submitted',
  'notify_issue_resolved',
  'notify_inspection_due',
  'notify_inspection_overdue',
])

// ============================================================
// Resolver primitive
// ============================================================

// Internal: true iff `bundles` is non-empty and EVERY bundle in it is
// explicitly `false` in `features`. A key/category owning zero
// bundles is never denied (core/exempt keys, and — for
// bundlesDenyCategory — categories with no bundle mapping).
function deniedByEveryBundle(features, bundles) {
  if (!bundles || bundles.length === 0) return false
  const f = features || {}
  return bundles.every(b => f[b] === false)
}

/**
 * True iff `key` is denied by the bundle layer at a location with the
 * given `features` blob: OWNED by at least one bundle, and EVERY
 * bundle that owns it is explicitly `false`. A key nobody owns
 * (core/exempt) is never denied. Missing/`{}`/`null` features denies
 * nothing (back-compat: every existing location's `{}` still means
 * "everything on").
 *
 * @param {object|null|undefined} features  location.features
 * @param {string} key
 * @returns {boolean}
 */
export function bundlesDenyKey(features, key) {
  return deniedByEveryBundle(features, KEY_BUNDLES[key])
}

// ============================================================
// Task 2 — approval categories follow bundles.
//
// CLOSES the parked HOME.3 decision: the approvals registry's
// visibility filter (src/lib/approvals/registry.js) previously gated
// each category on ONLY the per-user `approvals_*` grant
// (hasPermission), which is a pure per-user override — the 8
// `approvals_*` keys are in EXEMPT_KEYS above precisely because
// `isFeatureGatedByLocation` has always skipped the location gate for
// them (they're grants, not location features). That means turning a
// bundle off at a location did NOT stop an approver who held the
// per-user grant from seeing that category — the queue's approvals
// source bypassed location-level gating entirely. CATEGORY_BUNDLES +
// bundlesDenyCategory give the registry its OWN, separate bundle
// check (independent of the exempt per-user grant) so a bundle-off
// location genuinely stops surfacing that category, and the Home
// queue (src/lib/home-queue.js, which reads the same registry)
// inherits the fix for free.
//
// Category keys match `provider.key` in
// src/lib/approvals/providers/*.js (APPROVALS_PROVIDERS in registry.js).
// `issues` is deliberately ABSENT — it mirrors the core `issues_inbox`
// key (see CORE_KEYS above) and so is never bundle-denied.
// ============================================================

export const CATEGORY_BUNDLES = Object.freeze({
  // Money hub: nav-items.js's '/money' anyPermission union already
  // lists 'approvals_contractor_invoices' / 'approvals_fte_expenses' /
  // 'approvals_offer_purchases' for hub-entry VISIBILITY — direct
  // confirmation these three categories are Money's.
  contractor_invoices: ['bundle_money'],
  fte_expenses: ['bundle_money'],
  offer_purchases: ['bundle_money'],
  // JUDGEMENT CALL, confirmed by reading providers/invoices-queue.js:
  // the bookkeeper → Xero sign-off queue is the same Money/Xero domain
  // as `bookkeeper` itself (KEY_BUNDLES above) and invoices_inbox.
  invoices_queue: ['bundle_money'],
  // Members hub: nav-items.js '/members' anyPermission union lists
  // 'approvals_hyrox_sessions' directly.
  hyrox_sessions: ['bundle_members'],
  // JUDGEMENT CALL, confirmed by reading providers/host-events.js:
  // HOST-APPROVALS.1 events-platform submissions are Events content,
  // which lives in the Members hub (`events` is a bundle_members key).
  host_events: ['bundle_members'],
  // JUDGEMENT CALL — not in any nav-items.js union (ScheduleApprovals
  // is a tab INSIDE /schedule, gated on MANAGER_ROLES not a permission
  // key). All three are staff-scheduling reviews that live beside
  // `schedule`/`contracts`/`attendance_reports` in bundle_team.
  time_off: ['bundle_team'],
  shift_swaps: ['bundle_team'],
  rosters: ['bundle_team'],
  // JUDGEMENT CALL, confirmed by reading providers/agent-requests.js:
  // genuinely mixed-domain, unlike the categories above. `pause` /
  // `cancellation` are membership-lifecycle actions reviewed off the
  // contact record (the same CRM territory as `contact_linking` /
  // `consultations` in bundle_sales); `class_booking` /
  // `consultation` kinds are Members-hub bookings (the same domain as
  // `bookings`/`events`). Real OR-semantics case (like `email` and
  // `studio_management` in KEY_BUNDLES above), not an artificial one:
  // a location that dropped Sales but kept Members (or vice versa)
  // should still see agent requests, since either hub alone accounts
  // for a real slice of what this category contains.
  agent_requests: ['bundle_sales', 'bundle_members'],
})

/**
 * True iff `category` (an APPROVALS_PROVIDERS[].key) is denied by the
 * bundle layer: same OR-across-owning-bundles semantics as
 * bundlesDenyKey, applied to CATEGORY_BUNDLES. A category with no
 * mapping (`issues` — core) is never denied.
 *
 * @param {object|null|undefined} features  location.features
 * @param {string} category
 * @returns {boolean}
 */
export function bundlesDenyCategory(features, category) {
  return deniedByEveryBundle(features, CATEGORY_BUNDLES[category])
}
