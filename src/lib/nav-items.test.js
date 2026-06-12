// SIDEBAR-IA.1 — policy contract for the sidebar information
// architecture. The nav data lives in src/lib/nav-items.js (extracted
// from Sidebar.jsx so the structure is testable without a DOM). These
// tests pin the regrouped IA:
//
//   Work    — the five badge/action queues, top of the sidebar
//   Sales   — pipeline, contacts, tasks
//   Gym     — what's on at the gym (schedule, events, live floor, orders)
//   studio  — the self-labelled Studio Management group (header-less)
//   cars    — the car-import business, separated from gym ops (header-less)
//   Account — policies + settings
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
  it('renders the regrouped sections in order', () => {
    expect(NAV_SECTIONS).toEqual([
      { id: 'work',    label: 'Work' },
      { id: 'sales',   label: 'Sales' },
      { id: 'gym',     label: 'Gym' },
      { id: 'studio',  label: null },
      { id: 'cars',    label: null },
      { id: 'account', label: 'Account' },
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

  it('pins exactly one section-less item: the Dashboard group link', () => {
    const pinned = ALL_NAV.filter((i) => !i.section)
    expect(pinned).toHaveLength(1)
    expect(pinned[0].href).toBe('/dashboard')
    expect(pinned[0].dashboardGroup).toBe(true)
  })

  it('gives every entry a label, an icon, and a visibility gate', () => {
    const gated = (i) =>
      i.openToAll || i.dashboardGroup || i.anyPermission || i.permission
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

describe('Work — the action queues, grouped and ordered', () => {
  it('contains exactly the five queue surfaces', () => {
    expect(hrefsIn('work')).toEqual([
      '/communications',
      '/bookings',
      '/approvals',
      '/issues',
      '/invoices',
    ])
  })
})

describe('Sales', () => {
  it('contains pipeline, contacts and tasks', () => {
    expect(hrefsIn('sales')).toEqual(['/pipeline', '/contacts', '/activities'])
  })
})

describe('Gym', () => {
  it('contains schedule, events, live HR and orders', () => {
    expect(hrefsIn('gym')).toEqual(['/schedule', '/events', '/live', '/orders'])
  })

  it('keeps Live HR a top-level entry (primary coach screen, not an admin task)', () => {
    const live = ALL_NAV.find((i) => i.href === '/live')
    expect(live.section).toBe('gym')
  })
})

describe('Studio Management group', () => {
  it('is the only studio-section entry', () => {
    expect(hrefsIn('studio')).toEqual(['/studio-management'])
  })

  it('keeps only studio surfaces as children — imports + landing-page settings moved to Settings', () => {
    const group = itemsIn('studio')[0]
    const childHrefs = group.children.map((c) => c.href)
    expect(childHrefs).toEqual(['/admin/contracts', '/admin/tv-displays', '/welcome'])
    expect(childHrefs).not.toContain('/admin/glofox-import')
    expect(childHrefs).not.toContain('/admin/marketing-import')
    expect(childHrefs).not.toContain('/settings/landing-page')
  })
})

describe('Car Processing', () => {
  it('moves to its own header-less section at the bottom, out of gym ops', () => {
    expect(hrefsIn('cars')).toEqual(['/cars'])
    expect(hrefsIn('gym')).not.toContain('/cars')
  })
})

describe('Account', () => {
  it('contains policies and settings', () => {
    expect(hrefsIn('account')).toEqual(['/policies', '/settings'])
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
    ])
  })
})
