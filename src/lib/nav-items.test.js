// SIDEBAR-IA.1 / HUBS.2a — policy contract for the sidebar information
// architecture. The nav data lives in src/lib/nav-items.js (extracted
// from Sidebar.jsx so the structure is testable without a DOM). These
// tests pin the HUBS.2a hub regroup:
//
//   Messages    — Communications hub + the email ticket queue
//   queues      — Approvals + Issues (interim, header-less — the phase-3
//                 Home queue eventually absorbs these)
//   Sales       — the collapsed Sales hub (single entry, tabs at the page)
//   Members     — what's on for members: bookings, events, challenges,
//                 pulse, live floor, Hyrox
//   Money       — bookkeeping + orders
//   Marketing   — automations + the public landing page
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
import { ALL_NAV, NAV_SECTIONS, DASHBOARD_LINK_PERM_KEYS } from './nav-items'

const sectionIds = NAV_SECTIONS.map((s) => s.id)
const itemsIn = (id) => ALL_NAV.filter((i) => i.section === id)
const hrefsIn = (id) => itemsIn(id).map((i) => i.href)

describe('NAV_SECTIONS', () => {
  it('renders the hub sections in order', () => {
    expect(NAV_SECTIONS).toEqual([
      { id: 'messages',   label: 'Messages' },
      { id: 'queues',     label: null },
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

  it('pins exactly two section-less items: the Account-home + Dashboard links', () => {
    // REPSET-ACCOUNT.1 — the Account-home portfolio entry pins above the
    // Dashboard link (Account tier sits above Studio). Order matters.
    const pinned = ALL_NAV.filter((i) => !i.section)
    expect(pinned.map((i) => i.href)).toEqual(['/portfolio', '/dashboard'])
    expect(pinned[0].masterOrOwnerOnly).toBe(true) // owner+/master only
    expect(pinned[1].dashboardGroup).toBe(true)
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
  it('contains the Communications hub and the email ticket queue', () => {
    expect(hrefsIn('messages')).toEqual([
      '/communications',
      // EMAIL-TICKET.4 — the studio email queue is an action queue too, and
      // sits next to the hub it lives inside.
      '/communications/tickets',
    ])
  })

  it('gates the email ticket queue on email_inbox, NOT the marketing `email` key', () => {
    // Two different populations: `email` is campaign/broadcast mail,
    // `email_inbox` is the ticketed studio accounts (accounts@, sales@).
    const tickets = ALL_NAV.find((i) => i.href === '/communications/tickets')
    expect(tickets.permission).toBe('email_inbox')
    expect(tickets.anyPermission).toBeUndefined()
  })
})

describe('queues — interim action-queue zone', () => {
  it('holds Approvals and Issues until the phase-3 Home queue absorbs them', () => {
    expect(hrefsIn('queues')).toEqual(['/approvals', '/issues'])
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
  it('contains bookings, events, challenges, pulse, live HR, and Hyrox', () => {
    expect(hrefsIn('members')).toEqual(['/bookings', '/events', '/challenges', '/pulse', '/live', '/admin/hyrox'])
  })

  it('keeps Live HR a top-level members entry with Class timer nested under it', () => {
    const live = ALL_NAV.find((i) => i.href === '/live')
    expect(live.section).toBe('members')
    expect(live.children.map((c) => c.href)).toEqual(['/studio-management/timer'])
  })
})

describe('Money hub', () => {
  it('leads with the accounting hub, then the invoices queue, card receipts, and orders', () => {
    expect(hrefsIn('money')).toEqual(['/accounting', '/invoices', '/card-receipts', '/orders'])
  })
})

describe('Marketing hub', () => {
  it('contains automations and the public landing page', () => {
    expect(hrefsIn('marketing')).toEqual(['/automations', '/welcome'])
  })
})

describe('Team hub', () => {
  it('contains schedule, contracts, and policies', () => {
    expect(hrefsIn('team')).toEqual(['/schedule', '/admin/contracts', '/policies'])
  })
})

describe('Operations hub', () => {
  it('contains maintenance and studio management', () => {
    expect(hrefsIn('operations')).toEqual(['/maintenance', '/studio-management'])
  })

  it('gates Maintenance on equipment_admin OR equipment_inspect (EQUIP-MAINT.1)', () => {
    const maintenance = ALL_NAV.find((i) => i.href === '/maintenance')
    expect(maintenance.anyPermission).toEqual(['equipment_admin', 'equipment_inspect'])
  })
})

describe('Studio Management group', () => {
  it('is the only operations-section group entry with children', () => {
    const group = ALL_NAV.find((i) => i.href === '/studio-management')
    expect(group.section).toBe('operations')
  })

  it('Studio Management group keeps only its display children after promotions', () => {
    const sm = ALL_NAV.find(i => i.href === '/studio-management')
    expect(sm.children.map(c => c.href)).toEqual(['/admin/tv-displays', '/presentations'])
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
