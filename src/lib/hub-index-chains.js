// HUBDOOR.1 — the hub index redirect chains, as data.
//
// Every collapsed hub (HUBS.2a–2f) has a sidebar entry pointing at a bare
// `/<hub>` URL that renders nothing itself: it redirects to the first tab
// the current user can actually open. Until this module those chains lived
// as hand-written `if (hasPermission(...)) redirect(...)` ladders inside
// each `src/app/<hub>/page.js`, with no mechanical relationship to the
// sidebar entry's `anyPermission` union in src/lib/nav-items.js.
//
// That gap is a defect FACTORY, and it fired twice:
//
//   - Marketing: `sms` was added to the union (DEEP.4 Task 2) so an
//     sms-only holder would get a Marketing door to /communications/send
//     and /sent — but marketing/page.js never grew an `sms` branch, so
//     that persona clicked the door and bounced to '/'.
//   - Operations: `fleet_restart`/`fleet_admin` were added to the union
//     (ADMIN.2h Task 2 review fix) so a fleet-only persona could discover
//     the Fleet tab — but operations/page.js never grew a fleet branch,
//     same bounce. Worse there: the Fleet tab lives on /admin/fleet,
//     OUTSIDE the (operations) route group, so that persona could never
//     SEE the tab either (no strip renders on /admin/fleet at all, and
//     HubTabs hides the strip below 2 visible tabs — a fleet-only user
//     has exactly 1 anywhere it would render).
//
// Holding the chains as data lets nav-items.test.js assert the real
// invariant — every key in a hub's sidebar union reaches a real surface,
// not merely "is present in the union" — which is the assertion that would
// have caught both of the above when they were written.
//
// Shape, per hub:
//   chain          ordered [{ keys, roles?, target }]; the FIRST step the
//                  user satisfies wins — they must hold ANY of `keys` and,
//                  where `roles` is present, hold one of those ACTIVE-
//                  LOCATION roles. Order MIRRORS the hub's tab strip (each
//                  (hub)/layout.js TABS array) so an operator's landing tab
//                  is the leftmost one they can see.
//   fallback       where a user satisfying no step goes. '/' everywhere
//                  except Team, whose /policies tab is login-only so its
//                  chain never dead-ends.
//   visibilityOnly union keys that deliberately reach NO surface for
//                  ANYONE, each with the reason. Not a TODO list — an
//                  assertion that the gap is known and accepted. Empty for
//                  every hub but Members; see its note.
//
// WHAT THIS MODULE GUARANTEES, EXACTLY: every `target` below is a route
// whose own PERMISSION and ROLE gate the winning step satisfies — read off
// each destination's guard, all 25 of them, and re-read at HUBDOOR.3. So a
// step can never hand someone a door the destination refuses them *on the
// grant*. That statement is only true because of `roles`, and it used to be
// false:
//
// TWO of these targets gate on a ROLE FLOOR as well as a permission key —
// Money's /orders and Members' /challenges are both
// `MANAGER_ROLES.includes(user.role) && hasPermission(user, <key>)`. A
// step carrying only the key would hand a `staff`/`reception` holder of
// that key a redirect into a page that bounces them straight back out,
// which is precisely the defect shape this module exists to prevent. So
// the role floor is recorded here as data and the resolver honours it: a
// key-holder below the floor falls THROUGH to the next step, and to the
// fallback if there is none.
//
// That leaves an accepted, declared overshow: `orders`/`challenges` are in
// their hub's sidebar `anyPermission` union without a role qualifier
// (unions are permission-keyed; nav-items.js has no role dimension), so a
// staff-role holder of one of those keys still LIGHTS the hub entry and
// then lands on the fallback. Narrowing the union would take the entry
// away from a manager who holds only that key, and widening either page's
// gate would be loosening a gate to make a door work. The honest options
// are a role-aware union or retiring the grant — both registry decisions,
// neither a redirect line. Prod population of both personas: 0 (every
// `orders`/`challenges` holder today is manager+; verified 2026-08-20
// across all 21 active profile_locations assignments). The set is pinned
// in nav-items.test.js so a THIRD one cannot appear undeclared.
//
// The role floor is enforced at the destination too, not just here:
// /orders has always redirected on it, and HUBDOOR.2 gave /challenges the
// server gate it never had (src/app/(members)/challenges/layout.js) so the
// page can no longer render-then-bounce a client-side white flash.
//
// WHAT IT DOES NOT GUARANTEE — the header used to say "a redirect out of
// here never lands on a second bounce", full stop, and that is a wider
// claim than the module can keep, so it is narrowed here rather than left
// for the next person to trust wrongly. FIVE targets carry a second
// precondition that is not a grant at all — an ACTIVE LOCATION —
//
//     /activities, /hyrox, /tv-displays  (…redirect('/') if !locationId)
//     /communications/send               (…redirect('/communications'))
//     /live                              (…redirect('/') with no active id)
//
// — and a permission-keyed chain cannot see session state. It is not
// papered over with a `needsActiveLocation` flag because skipping such a
// step would send the same user to the same fallback the destination
// already sends them to: the flag would buy one fewer HTTP redirect and a
// new thing to keep in sync, not a different outcome. Nor is it reachable
// today by the persona it would hurt: a master (the archetypal
// no-active-location session) resolves every key true, so step 1 wins for
// them in all six hubs, and no hub's step 1 is on that list. Anyone else
// resolving one of those five keys true is doing so through an assignment
// at a location. If a step is ever added whose target both is location-
// preconditioned and can win for a location-less session, that is the
// moment this stops being a note and becomes a step-skip.

import { CHALLENGE_ADMIN_ROLES } from './challenges-access'
import { MANAGER_ROLES } from './schemas'

export const HUB_INDEX_CHAINS = Object.freeze({
  // /sales — tab order: Pipeline, Contacts, Tasks.
  '/sales': Object.freeze({
    chain: Object.freeze([
      { keys: ['pipeline'], target: '/pipeline' },
      { keys: ['contacts'], target: '/contacts' },
      { keys: ['activities'], target: '/activities' },
    ]),
    fallback: '/',
    visibilityOnly: Object.freeze([]),
  }),

  // /members — tab order: Bookings, Events, Challenges, Pulse, Live HR,
  // Class timer, Hyrox. Gate keys mirror each PAGE's own gate (the events
  // page checks `races`, not `events` — see visibilityOnly below).
  '/members': Object.freeze({
    chain: Object.freeze([
      { keys: ['bookings'], target: '/bookings' },
      { keys: ['races'], target: '/events' },
      // Role floor: /challenges and /api/challenges both require
      // MANAGER_ROLES on top of the key (canAdminChallenges). A staff or
      // reception holder of `challenges` falls through to /pulse, /live,
      // … and to '/' if they hold nothing else — never into a page that
      // would bounce them.
      { keys: ['challenges'], roles: CHALLENGE_ADMIN_ROLES, target: '/challenges' },
      { keys: ['pulse_admin'], target: '/pulse' },
      { keys: ['studio_management'], target: '/live' },
      { keys: ['class_timer'], target: '/studio-management/timer' },
      { keys: ['approvals_hyrox_sessions'], target: '/hyrox' },
    ]),
    fallback: '/',
    // `events` ("Calendly events", shared/permissions.js) is the pre-mig-092
    // key that `races` was split OUT of. NOTHING gates on it any more:
    // /bookings requires `bookings` and /events requires `races`, so an
    // events-only holder has no permitted Members surface at all and a
    // redirect branch could only send them to a page that bounces them
    // again. It stays in the union as the visibility superset the HUBS.2b
    // collapse promised ("nobody loses visibility"), and it is NOT fixed
    // here because the honest fix is a permissions-registry decision
    // (retire the key, or give it a surface), not a redirect line —
    // widening /bookings to accept it would be loosening a gate to make a
    // door work. Prod population of events-without-bookings: 0.
    visibilityOnly: Object.freeze(['events']),
  }),

  // /money — tab order: Accounting, Invoices, Card receipts, Orders, Offer
  // sales, Contractor invoices, Staff expenses. The last two are (team)
  // pages reached only by this hub's reviewer door.
  '/money': Object.freeze({
    chain: Object.freeze([
      { keys: ['accounting_hub'], target: '/accounting' },
      { keys: ['invoices_inbox'], target: '/invoices' },
      { keys: ['card_receipts'], target: '/card-receipts' },
      // Role floor: src/app/(money)/orders/page.js redirects unless
      // MANAGER_ROLES.includes(user.role) AND hasPermission('orders').
      // Long-standing (HUBS.2c documented the overshow); now honoured
      // rather than merely noted, so the step cannot double-bounce.
      { keys: ['orders'], roles: MANAGER_ROLES, target: '/orders' },
      { keys: ['approvals_offer_purchases'], target: '/offer-sales' },
      { keys: ['approvals_contractor_invoices'], target: '/schedule/invoices' },
      { keys: ['approvals_fte_expenses'], target: '/schedule/expenses' },
    ]),
    fallback: '/',
    visibilityOnly: Object.freeze([]),
  }),

  // /marketing — tab order: Automations, Landing page, Send, Sent,
  // Templates, Segments, List health.
  //
  // Step 1's OR matches /automations' own gate exactly (canCurated ||
  // canFlows || canDevices in (marketing)/automations/page.js).
  //
  // Step 2 routes to /settings/landing-page, NOT /welcome: /welcome is the
  // PUBLIC marketing site (no auth), never an in-app pathname to redirect a
  // signed-in operator into. /settings/landing-page gates on `landing_page`
  // directly, so a landing-page-only editor lands and stays.
  //
  // Step 3 (HUBDOOR.1) closes defect A: `sms` joined the union in DEEP.4
  // Task 2 precisely so an sms-only holder gets a Marketing door to the
  // campaign-lifecycle pages, and /communications/send admits `sms` alone
  // (its own gate builds a channel list and only bounces when it is empty;
  // the (marketing-era) layout and Marketing's own Send/Sent tabs both
  // list `sms` too). Placed AFTER landing_page to match the tab order.
  '/marketing': Object.freeze({
    chain: Object.freeze([
      { keys: ['automations', 'email', 'whatsapp', 'device_control'], target: '/automations' },
      { keys: ['landing_page'], target: '/settings/landing-page' },
      { keys: ['sms'], target: '/communications/send' },
    ]),
    fallback: '/',
    visibilityOnly: Object.freeze([]),
  }),

  // /team — tab order: Schedule, Contracts, Policies. Policies is
  // login-only (POLICIES.1), so it is the universal fallback and this
  // chain never dead-ends at '/'. The entry is `openToAll` for the same
  // reason, so there is no union to satisfy.
  '/team': Object.freeze({
    chain: Object.freeze([
      { keys: ['schedule'], target: '/schedule' },
      { keys: ['contracts'], target: '/contracts' },
    ]),
    fallback: '/policies',
    visibilityOnly: Object.freeze([]),
  }),

  // /operations — tab order: Maintenance, Studio, TV displays,
  // Presentations, Checklists, Fleet. Checklists shares
  // `studio_management` with the Studio tab so it never needs its own step.
  //
  // The last step (HUBDOOR.1) closes defect B. Its target is /admin/fleet,
  // which is OUTSIDE the (operations) route group — the same cross-hub tab
  // shape as (money)'s two reviewer tabs and (members)'s `live`. So a
  // fleet-only persona lands on a real, permitted surface (src/app/admin/
  // layout.js admits fleet_restart/fleet_admin explicitly), but they do NOT
  // get an Operations tab strip there and never will: no (operations)
  // layout wraps /admin/fleet, and even where one does, HubTabs hides the
  // strip below 2 visible tabs and this persona has exactly 1. The honest
  // chrome fix that IS available is sidebar active-state — Operations now
  // claims '/admin/fleet' in its extraActivePaths (src/lib/nav-items.js),
  // which no other nav entry competes for, so the entry they clicked stays
  // lit on arrival instead of the sidebar going dark.
  '/operations': Object.freeze({
    chain: Object.freeze([
      { keys: ['equipment_admin', 'equipment_inspect'], target: '/maintenance' },
      { keys: ['studio_management'], target: '/studio-management' },
      { keys: ['tv_displays'], target: '/tv-displays' },
      { keys: ['presentations'], target: '/presentations' },
      { keys: ['fleet_restart', 'fleet_admin'], target: '/admin/fleet' },
    ]),
    fallback: '/',
    visibilityOnly: Object.freeze([]),
  }),
})

/**
 * Does `user` clear a step's role floor?
 *
 * Compares against `user.role`, the ACTIVE-LOCATION role
 * (src/lib/auth.js resolveActiveLocationRole) — deliberately the same
 * field both destination gates read, so this can never be more generous
 * than the page it sends someone to. A master whose active assignment
 * says 'staff' is refused by /orders and /api/challenges alike, so they
 * are refused here too rather than being redirected into that refusal.
 *
 * A step with no `roles` has no floor and is open to any role.
 */
function clearsRoleFloor(user, step) {
  if (!step.roles) return true
  return step.roles.includes(user?.role)
}

/**
 * Where should `user` land when they open a hub's bare index URL?
 *
 * @param {object|null} user            getCurrentUser() result
 * @param {string} hubHref              e.g. '/operations'
 * @param {(user, key) => boolean} can  permission predicate (hasPermission)
 * @returns {string} a route to redirect to — never null, never ''
 */
export function resolveHubIndexTarget(user, hubHref, can) {
  const hub = HUB_INDEX_CHAINS[hubHref]
  if (!hub) throw new Error(`hub-index-chains: unknown hub "${hubHref}"`)
  for (const step of hub.chain) {
    if (!clearsRoleFloor(user, step)) continue
    if (step.keys.some((k) => can(user, k))) return step.target
  }
  return hub.fallback
}
