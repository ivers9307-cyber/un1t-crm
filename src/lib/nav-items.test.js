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
    expect(ops.extraActivePaths).toEqual(['/maintenance', '/studio-management', '/tv-displays', '/presentations', '/checklists'])
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
