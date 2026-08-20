// SIDEBAR-IA.1 / HUBS.2a — policy contract for the sidebar information
// architecture. The nav data lives in src/lib/nav-items.js (extracted
// from Sidebar.jsx so the structure is testable without a DOM). These
// tests pin the HUBS.2a hub regroup:
//
//   Messages    — Communications hub + the email ticket queue
//   Sales       — the collapsed Sales hub (single entry, tabs at the page)
//   Members     — what's on for members: bookings, events, challenges,
//                 pulse, live floor, Hyrox
//   Money       — bookkeeping + orders
//   Marketing   — the collapsed Marketing hub (automations + the public
//                 landing page, HUBS.2f Task 2)
//   Team        — schedule, contracts, policies
//   Operations  — studio management + maintenance
//   modules     — vertical modules (Cars), header-less
//   Account     — settings
//
// Radars are deliberately ABSENT here — they relocated to dashboard
// tabs (/dashboard/churn-radar, /dashboard/lead-radar) and the
// Dashboard sidebar entry's visibility ORs their permissions in via
// DASHBOARD_LINK_PERM_KEYS.

import { describe, it, expect } from 'vitest'
import { ALL_NAV, NAV_SECTIONS, DASHBOARD_LINK_PERM_KEYS, activeHrefFor } from './nav-items'
import { HUB_INDEX_CHAINS, resolveHubIndexTarget } from './hub-index-chains'

const sectionIds = NAV_SECTIONS.map((s) => s.id)
const itemsIn = (id) => ALL_NAV.filter((i) => i.section === id)
const hrefsIn = (id) => itemsIn(id).map((i) => i.href)

describe('NAV_SECTIONS', () => {
  it('renders the hub sections in order', () => {
    expect(NAV_SECTIONS).toEqual([
      { id: 'messages',   label: 'Messages' },
      { id: 'sales',      label: 'Sales' },
      { id: 'members',    label: 'Members' },
      { id: 'money',      label: 'Money' },
      { id: 'marketing',  label: 'Marketing' },
      { id: 'team',       label: 'Team' },
      { id: 'operations', label: 'Operations' },
      { id: 'modules',    label: null },
      { id: 'account',    label: 'Account' },
    ])
  })
})

describe('ALL_NAV structure', () => {
  it('assigns every sectioned item to a declared section (no orphans)', () => {
    for (const item of ALL_NAV.filter((i) => i.section)) {
      expect(sectionIds, `${item.href} points at unknown section "${item.section}"`)
        .toContain(item.section)
    }
  })

  it('pins exactly three section-less items: Account home, Dashboard, Approvals', () => {
    // REPSET-ACCOUNT.1 — the Account-home portfolio entry pins above the
    // Dashboard link (Account tier sits above Studio). Order matters.
    // Approvals pins beneath Dashboard (restored by operator request,
    // 19 Aug 2026 — see the entry's comment in nav-items.js).
    const pinned = ALL_NAV.filter((i) => !i.section)
    expect(pinned.map((i) => i.href)).toEqual(['/portfolio', '/dashboard', '/approvals'])
    expect(pinned[0].masterOrOwnerOnly).toBe(true) // owner+/master only
    expect(pinned[1].dashboardGroup).toBe(true)
    expect(pinned[2].permission).toBe('approvals_inbox')
  })

  it('gives every entry a label, an icon, and a visibility gate', () => {
    const gated = (i) =>
      i.openToAll || i.dashboardGroup || i.anyPermission || i.permission ||
      i.masterOrOwnerOnly || i.masterOnly
    for (const item of ALL_NAV) {
      expect(item.label, item.href).toBeTruthy()
      expect(item.icon, item.href).toBeTruthy()
      expect(gated(item), `${item.href} has no visibility gate`).toBeTruthy()
      for (const child of item.children || []) {
        expect(child.label, child.href).toBeTruthy()
        expect(child.icon, child.href).toBeTruthy()
        expect(gated(child), `${child.href} has no visibility gate`).toBeTruthy()
      }
    }
  })

  it('has no duplicate hrefs across items and children', () => {
    const hrefs = ALL_NAV.flatMap((i) => [i.href, ...(i.children || []).map((c) => c.href)])
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

describe('Messages hub', () => {
  // HUBS.2f Task 1 — collapsed the two Messages entries (the Communications
  // hub + the standalone Email inbox ticket queue) into ONE sidebar entry.
  // The email ticket surface didn't move — it's still a tab inside
  // CommunicationsTabs (canEmailInbox) — only its OWN top-level sidebar row
  // is gone. See the entry comment below for why `email_inbox` moved into
  // the union instead of just disappearing.
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('messages')).toEqual(['/communications'])
  })

  it('the Messages entry ORs all four channel permissions', () => {
    const messages = ALL_NAV.find(i => i.href === '/communications')
    expect(messages.label).toBe('Messages')
    expect(messages.anyPermission).toEqual(['email', 'whatsapp', 'sms', 'email_inbox'])
    expect(messages.extraActivePaths).toBeUndefined()
  })
})

describe('Sales hub', () => {
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('sales')).toEqual(['/sales'])
  })

  it('the Sales hub entry ORs its member permissions and lights on member paths', () => {
    const sales = ALL_NAV.find(i => i.href === '/sales')
    expect(sales.anyPermission).toEqual(['pipeline', 'contacts', 'activities'])
    expect(sales.extraActivePaths).toEqual(['/pipeline', '/contacts', '/activities'])
  })
})

describe('Members hub', () => {
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('members')).toEqual(['/members'])
  })

  it('the Members hub entry ORs its member permissions and lights on member paths', () => {
    const members = ALL_NAV.find(i => i.href === '/members')
    expect(members.anyPermission).toEqual(['bookings', 'events', 'races', 'challenges', 'pulse_admin', 'studio_management', 'class_timer', 'approvals_hyrox_sessions'])
    expect(members.extraActivePaths).toEqual(['/bookings', '/events', '/challenges', '/pulse', '/live', '/studio-management/timer', '/hyrox'])
  })
})

describe('Money hub', () => {
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('money')).toEqual(['/money'])
  })

  it('the Money hub entry ORs its member permissions and lights on member paths', () => {
    const money = ALL_NAV.find(i => i.href === '/money')
    expect(money.anyPermission).toEqual(['accounting_hub', 'invoices_inbox', 'card_receipts', 'orders', 'approvals_offer_purchases', 'approvals_contractor_invoices', 'approvals_fte_expenses'])
    expect(money.extraActivePaths).toEqual(['/accounting', '/invoices', '/card-receipts', '/orders', '/offer-sales'])
  })

  // DEEP.4 Task 1 (4A) — the two review tabs added to (money)/layout.js
  // point at /schedule/invoices and /schedule/expenses, which are Team
  // URLs, not Money ones. Deliberately NOT added to extraActivePaths
  // above: those paths are already claimed by Team's own `/schedule`
  // extraActivePath, and activeHrefFor is a longest-match ONE winner —
  // see the "cross-hub tab active-state" case below for the proof that
  // Team wins, not Money.
  it('the two approver keys join the union without joining extraActivePaths (Team already claims /schedule/*)', () => {
    const money = ALL_NAV.find(i => i.href === '/money')
    expect(money.anyPermission).toContain('approvals_contractor_invoices')
    expect(money.anyPermission).toContain('approvals_fte_expenses')
    expect(money.extraActivePaths).not.toContain('/schedule/invoices')
    expect(money.extraActivePaths).not.toContain('/schedule/expenses')
  })
})

describe('Marketing hub', () => {
  // HUBS.2f Task 2 — seventh application of the hub-collapse pattern
  // (after Sales HUBS.2a, Members HUBS.2b, Money HUBS.2c, Team HUBS.2d,
  // Operations HUBS.2e, Messages HUBS.2f Task 1): what was two
  // standalone sidebar entries (Automations, the public Landing page
  // link) becomes one hub entry. `landing_page` folds into the union
  // so a landing-page-only editor still sees the hub — the same
  // fold-into-the-OR reasoning as Messages' email_inbox. No
  // '/welcome' in extraActivePaths: it's the PUBLIC site, never an
  // in-app pathname the sidebar could be sitting on, so there's
  // nothing for the hub entry to light against there — its
  // reachability moves entirely to the (marketing) hub's own Landing
  // page tab (newTab: true, HubTabs capability), not to sidebar
  // active-state.
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('marketing')).toEqual(['/marketing'])
  })

  it('the Marketing hub entry ORs its member permissions and lights on the automations path', () => {
    const marketing = ALL_NAV.find(i => i.href === '/marketing')
    expect(marketing.anyPermission).toEqual(['automations', 'email', 'whatsapp', 'device_control', 'landing_page', 'sms'])
    expect(marketing.extraActivePaths).toEqual(['/automations', '/communications/send', '/communications/sent', '/communications/templates', '/communications/segments', '/communications/list-health'])
  })

  // DEEP.4 Task 2 (4B) — the campaign-lifecycle pages moved OWNERSHIP to
  // Marketing (their own (marketing-era) chrome), even though their URLs
  // stayed literal children of /communications. Marketing's
  // extraActivePaths now claims them, so activeHrefFor's longest-match
  // picks Marketing over Messages' bare `/communications` prefix. Unlike
  // DEEP.4 Task 1's Money case (where Team's PRE-EXISTING extraActivePath
  // won and Money deliberately did NOT compete), this is a genuine
  // ownership transfer, so Marketing DOES compete and DOES win.
  it('a Marketing cross-hub campaign page (send) lights Marketing, not Messages', () => {
    expect(activeHrefFor('/communications/send', ALL_NAV)).toEqual({
      itemHref: '/marketing',
      matchedPath: '/communications/send',
    })
  })

  it('a Marketing cross-hub campaign page (segments) lights Marketing, not Messages', () => {
    expect(activeHrefFor('/communications/segments', ALL_NAV)).toEqual({
      itemHref: '/marketing',
      matchedPath: '/communications/segments',
    })
  })

  it('the templates list page lights Marketing, not Messages (moved with the rest of the campaign-content lifecycle)', () => {
    expect(activeHrefFor('/communications/templates', ALL_NAV)).toEqual({
      itemHref: '/marketing',
      matchedPath: '/communications/templates',
    })
  })

  it('Messages still wins on its own genuinely-owned pages (inbox, tickets, the bare index)', () => {
    expect(activeHrefFor('/communications', ALL_NAV)).toEqual({
      itemHref: '/communications',
      matchedPath: '/communications',
    })
    expect(activeHrefFor('/communications/inbox', ALL_NAV)).toEqual({
      itemHref: '/communications',
      matchedPath: '/communications',
    })
  })
})

describe('Team hub', () => {
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('team')).toEqual(['/team'])
  })

  it('the Team hub entry is open to all and lights on member paths', () => {
    const team = ALL_NAV.find(i => i.href === '/team')
    expect(team.openToAll).toBe(true)
    expect(team.anyPermission).toBeUndefined()
    expect(team.extraActivePaths).toEqual(['/schedule', '/contracts', '/policies'])
  })
})

describe('Operations hub', () => {
  it('is a single collapsed hub entry', () => {
    expect(hrefsIn('operations')).toEqual(['/operations'])
  })

  it('the Operations hub entry ORs its member permissions and lights on member paths', () => {
    const ops = ALL_NAV.find(i => i.href === '/operations')
    // ADMIN.2h Task 2 review fix — fleet_restart/fleet_admin joined the
    // union so a fleet-only edge persona (every other Operations
    // permission revoked) still sees the Operations sidebar entry and
    // can discover the fleet tab from it.
    expect(ops.anyPermission).toEqual(['equipment_admin', 'equipment_inspect', 'studio_management', 'tv_displays', 'presentations', 'fleet_restart', 'fleet_admin'])
    // HUBDOOR.1 — '/admin/fleet' joins the list: the Operations index now
    // redirects a fleet-only holder there, and nothing else in ALL_NAV
    // claims any /admin path, so without this the sidebar would go dark on
    // a page this hub deliberately sends people to.
    expect(ops.extraActivePaths).toEqual(['/maintenance', '/studio-management', '/tv-displays', '/presentations', '/checklists', '/admin/fleet'])
  })

  it('HUBDOOR.1: /admin/fleet lights Operations (uncontested — no other entry owns an /admin path)', () => {
    expect(activeHrefFor('/admin/fleet', ALL_NAV)).toEqual({
      itemHref: '/operations',
      matchedPath: '/admin/fleet',
    })
  })
})

// ============================================================
// HUBDOOR.1 — the invariant that would have caught defects A and B.
//
// Every prior test in this file pins what is IN a hub entry's
// `anyPermission` union. None of them asked the only question that
// matters to the person holding the key: does clicking this sidebar entry
// land me on a surface I can use? Twice it didn't. `sms` was added to
// Marketing's union (DEEP.4 Task 2) and the fleet keys to Operations'
// (ADMIN.2h Task 2 review fix), each with a written rationale about the
// persona it was for — and in neither case did the hub's index page grow
// the matching redirect branch, so exactly that persona clicked the door
// and bounced to '/'.
//
// The chains now live as data in hub-index-chains.js, so the union and the
// chain can be compared mechanically. A key may be in a union for exactly
// two reasons: it appears in that hub's redirect chain, or it is declared
// `visibilityOnly` with a written reason. Silently missing is a failure.
// ============================================================
describe('every hub sidebar union key reaches a real surface', () => {
  // Entries that gate on a union but are NOT redirect indexes. Messages
  // (/communications) renders a real landing page whose own layout admits
  // all four of its union keys and whose cards are per-channel, so every
  // member of that union genuinely lands somewhere it can use.
  const RENDERED_LANDINGS = ['/communications']

  const unionEntries = ALL_NAV.filter((i) => i.anyPermission)

  it('every unioned entry is either a known redirect index or a known rendered landing', () => {
    for (const item of unionEntries) {
      const known = Boolean(HUB_INDEX_CHAINS[item.href]) || RENDERED_LANDINGS.includes(item.href)
      expect(known, `${item.href} has an anyPermission union but no chain and is not a declared landing`).toBe(true)
    }
  })

  it('no union key is silently missing from its hub chain', () => {
    for (const item of unionEntries) {
      const hub = HUB_INDEX_CHAINS[item.href]
      if (!hub) continue
      const reachable = new Set([...hub.chain.flatMap((s) => s.keys), ...hub.visibilityOnly])
      for (const key of item.anyPermission) {
        expect(
          reachable.has(key),
          `${item.href}: sidebar union key "${key}" reaches no chain step and is not declared visibilityOnly — this persona clicks the entry and bounces to ${hub.fallback}`,
        ).toBe(true)
      }
    }
  })

  it('every chain key is actually in its hub union (no branch only reachable by URL)', () => {
    for (const [href, hub] of Object.entries(HUB_INDEX_CHAINS)) {
      const item = ALL_NAV.find((i) => i.href === href)
      if (!item?.anyPermission) continue // Team is openToAll: no union to match
      for (const key of hub.chain.flatMap((s) => s.keys)) {
        expect(
          item.anyPermission.includes(key),
          `${href}: chain step key "${key}" is not in the sidebar union, so nobody holding only it ever sees the entry`,
        ).toBe(true)
      }
    }
  })

  // The end-to-end statement of the same thing, one persona per key: a
  // user holding EXACTLY one union key must not be redirected to the
  // hub's fallback. Reads as the bug report each defect was.
  //
  // HUBDOOR.2 — the persona now carries a ROLE, because two chain steps
  // declare a role floor matching their destination's own gate. The
  // persona is built AT a role that clears the step, which is the honest
  // reading of the invariant: the question is whether the key reaches a
  // surface for the population that can hold it usefully, not whether it
  // reaches one for every role in the enum. The complementary statement —
  // that a BELOW-floor holder is not sent into a bounce — is
  // hub-index-chains.test.js's role-floor suite, and the set of floors is
  // pinned there so a third one cannot be added silently.
  const can = (user, key) => user.has(key)
  const stepFor = (hub, key) => hub.chain.find((s) => s.keys.includes(key))
  const personaFor = (hub, key) => {
    const step = stepFor(hub, key)
    const keySet = new Set([key])
    // Any role that clears this step's floor; 'staff' where there is none.
    return { role: step?.roles ? step.roles[step.roles.length - 1] : 'staff', has: (k) => keySet.has(k) }
  }

  it('a single-key holder never lands on the hub fallback', () => {
    for (const item of unionEntries) {
      const hub = HUB_INDEX_CHAINS[item.href]
      if (!hub) continue
      for (const key of item.anyPermission) {
        if (hub.visibilityOnly.includes(key)) continue
        const landed = resolveHubIndexTarget(personaFor(hub, key), item.href, can)
        expect(landed, `${item.href}: a "${key}"-only holder lands on the fallback`).not.toBe(hub.fallback)
      }
    }
  })

  // The accepted overshow, stated rather than left to be discovered: a
  // union is permission-keyed and has no role dimension, so a below-floor
  // holder of a role-gated key still LIGHTS the hub entry and then lands
  // on the fallback. Narrowing the union would take the entry from a
  // manager holding only that key; widening either page's gate would be
  // loosening a gate to make a door work. Both are registry decisions.
  // Prod population of both personas: 0 (verified 2026-08-20).
  it('names every union key whose door is role-conditional', () => {
    const conditional = []
    for (const item of unionEntries) {
      const hub = HUB_INDEX_CHAINS[item.href]
      if (!hub) continue
      for (const key of item.anyPermission) {
        const step = stepFor(hub, key)
        if (step?.roles) conditional.push([item.href, key])
      }
    }
    expect(conditional).toEqual([
      ['/members', 'challenges'],
      ['/money', 'orders'],
    ])
  })
})

describe('modules — vertical modules zone', () => {
  it('holds Car Processing, out of daily gym ops', () => {
    expect(hrefsIn('modules')).toEqual(['/cars/active'])
  })
})

describe('Account', () => {
  it('contains settings', () => {
    expect(hrefsIn('account')).toEqual(['/settings'])
  })
})

// HUBS.2e Task 4/5 — activeHrefFor is the ONE-winner, longest-match
// replacement for Sidebar's old per-item bare startsWith (which let
// every prefix-matching item light simultaneously). Cases below assert
// against the REAL ALL_NAV at this commit. Task 5 folded Studio
// Management + Maintenance into a single Operations hub entry, which
// removed the last children-bearing entry from ALL_NAV — the one case
// that depended on a real group (child-match semantics) is now a
// SYNTHETIC hand-built fixture below, so that behaviour stays pinned
// even though no grouped entry remains in production nav data.
describe('activeHrefFor — longest-match single winner', () => {
  it('HUBS.2f: /communications/tickets now lights the single Messages entry (the standalone Email inbox sidebar row is gone — it is a CommunicationsTabs tab now)', () => {
    expect(activeHrefFor('/communications/tickets', ALL_NAV)).toEqual({
      itemHref: '/communications',
      matchedPath: '/communications',
    })
  })

  // DEEP.4 Task 2 (4B) UPDATED EXPECTATION — this used to assert
  // /communications/send lights Messages via its own bare href (the only
  // candidate at the time). Marketing's extraActivePaths now also claims
  // this path (the campaign-lifecycle ownership move), and it's the
  // LONGER match, so Marketing wins. See "Marketing hub"'s own
  // cross-hub-tab active-state cases above for the full set (send,
  // segments, templates) plus the companion proof that Messages still
  // wins on the pages it actually owns (inbox, tickets, the bare index).
  it('a route under the Communications hub that moved to Marketing (send) lights Marketing, not the Messages hub', () => {
    expect(activeHrefFor('/communications/send', ALL_NAV)).toEqual({
      itemHref: '/marketing',
      matchedPath: '/communications/send',
    })
  })

  it('a Sales extraActivePaths route lights the Sales hub entry', () => {
    expect(activeHrefFor('/contacts/abc123', ALL_NAV)).toEqual({
      itemHref: '/sales',
      matchedPath: '/contacts',
    })
  })

  it('kills double-light #2: /studio-management/timer lights ONLY Members (its extraActivePath beats the shorter Operations href, now that Task 5 folded the old Studio Management group under Operations)', () => {
    expect(activeHrefFor('/studio-management/timer', ALL_NAV)).toEqual({
      itemHref: '/members',
      matchedPath: '/studio-management/timer',
    })
  })

  it('the class timer still resolves to Members, not Operations (longest match)', () => {
    expect(activeHrefFor('/studio-management/timer', ALL_NAV)).toEqual({ itemHref: '/members', matchedPath: '/studio-management/timer' })
  })

  it('a Members extraActivePaths route (Hyrox) lights the Members hub entry', () => {
    expect(activeHrefFor('/hyrox', ALL_NAV)).toEqual({
      itemHref: '/members',
      matchedPath: '/hyrox',
    })
  })

  it('returns null when nothing matches', () => {
    expect(activeHrefFor('/nonexistent', ALL_NAV)).toBeNull()
  })

  // DEEP.4 Task 1 (4A) — the Money hub's two new cross-hub review tabs
  // (Contractor invoices, Staff expenses; see (money)/layout.js) point
  // at /schedule/invoices and /schedule/expenses. Those routes live in
  // the (team) route group and Team's own extraActivePaths already
  // claims the /schedule prefix — Money's extraActivePaths does NOT
  // list them (see nav-items.test.js's Money hub describe block above),
  // so Team is the only candidate and wins outright. This is the
  // accepted cross-hub-tab UX (same shape as (operations)'s `fleet`
  // tab at /admin/fleet, and (members)'s `live` tab at /live): landing
  // on the tab's page shows the OTHER hub's sidebar highlight and
  // strip, not Money's — there is no Money chrome on a (team) page.
  it('a Money cross-hub review tab (contractor invoices) lights Team, not Money', () => {
    expect(activeHrefFor('/schedule/invoices', ALL_NAV)).toEqual({
      itemHref: '/team',
      matchedPath: '/schedule',
    })
  })

  it('a Money cross-hub review tab (staff expenses) lights Team, not Money', () => {
    expect(activeHrefFor('/schedule/expenses', ALL_NAV)).toEqual({
      itemHref: '/team',
      matchedPath: '/schedule',
    })
  })

  it('a child match reports the PARENT item as itemHref, and the matched child href as matchedPath, so the group opens and the child row lights (SYNTHETIC fixture — HUBS.2e Task 5 removed the last children-bearing entry, Studio Management, from ALL_NAV; this hand-built items array keeps child-match semantics tested forever, independent of what nav data looks like)', () => {
    const items = [
      { href: '/parent', children: [{ href: '/parent/child-a' }, { href: '/parent/child-b' }] },
    ]
    expect(activeHrefFor('/parent/child-b/deep', items)).toEqual({
      itemHref: '/parent',
      matchedPath: '/parent/child-b',
    })
  })
})

describe('HOME.3 — queues section retired', () => {
  it('removes the queues section id entirely (no header-less holding pen left)', () => {
    expect(sectionIds).not.toContain('queues')
  })

  it('removes the standalone Issues sidebar entry — the needs-attention queue is its entry point', () => {
    const hrefs = ALL_NAV.flatMap((i) => [i.href, ...(i.children || []).map((c) => c.href)])
    expect(hrefs).not.toContain('/issues')
  })

  it('keeps Approvals as a pinned sectionless row (HOME.3 retired it; restored by operator request 19 Aug 2026)', () => {
    const approvals = ALL_NAV.find((i) => i.href === '/approvals')
    expect(approvals).toBeTruthy()
    expect(approvals.section).toBeUndefined()
    expect(approvals.permission).toBe('approvals_inbox')
  })
})

describe('Radar relocation', () => {
  it('removes the standalone radar entries from the sidebar', () => {
    const hrefs = ALL_NAV.flatMap((i) => [i.href, ...(i.children || []).map((c) => c.href)])
    expect(hrefs).not.toContain('/churn-radar')
    expect(hrefs).not.toContain('/lead-radar')
  })

  it('ORs the radar permissions into the Dashboard link visibility', () => {
    expect(DASHBOARD_LINK_PERM_KEYS).toEqual([
      'dashboard_personal',
      'dashboard_studio',
      'dashboard_business',
      'churn_radar',
      'lead_radar',
      'engagement_analytics',
      'dashboard_ads',
    ])
  })
})
