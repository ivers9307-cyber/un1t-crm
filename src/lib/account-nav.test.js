// REPSET-ACCOUNT.2 — account-tier nav resolution contract.

import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_TIER_PATHS,
  isAccountTierPath,
  resolveAccountNav,
  ACCOUNT_MANAGE_ITEMS,
} from './account-nav'

describe('isAccountTierPath', () => {
  it('matches /portfolio and its nested segments', () => {
    expect(isAccountTierPath('/portfolio')).toBe(true)
    expect(isAccountTierPath('/portfolio/anything')).toBe(true)
  })

  it('does not match studio surfaces (so their shell is untouched)', () => {
    expect(isAccountTierPath('/dashboard')).toBe(false)
    expect(isAccountTierPath('/settings/billing')).toBe(false)
    expect(isAccountTierPath('/portfolios')).toBe(false) // not a prefixed segment
    expect(isAccountTierPath(null)).toBe(false)
    expect(isAccountTierPath(undefined)).toBe(false)
  })

  it('only claims /portfolio for now', () => {
    expect([...ACCOUNT_TIER_PATHS]).toEqual(['/portfolio'])
  })
})

describe('resolveAccountNav — manage items (live vs deferred)', () => {
  it('links Billing & usage and Integrations, defers Team & roles', () => {
    const { manage } = resolveAccountNav({})
    const byKey = Object.fromEntries(manage.map((m) => [m.key, m]))

    expect(byKey.billing.href).toBe('/settings/billing')
    expect(byKey.billing.live).toBe(true)

    expect(byKey.integrations.href).toBe('/settings/integrations-hub')
    expect(byKey.integrations.live).toBe(true)

    expect(byKey.team.live).toBe(false)   // coming soon
    expect(byKey.team.href).toBe(null)    // no page to open yet
  })

  it('always exposes Overview → /portfolio', () => {
    expect(resolveAccountNav(null).overview.href).toBe('/portfolio')
    expect(resolveAccountNav(ACCOUNT_MANAGE_ITEMS).manage).toBe(ACCOUNT_MANAGE_ITEMS)
  })
})

describe('resolveAccountNav — Studios list', () => {
  const user = {
    activeOrganization: { id: 'org-1', name: 'UN1T Group' },
    activeLocation: { id: 'loc-b' },
    locations: [
      { id: 'loc-b', name: 'Bravo', organization_id: 'org-1' },
      { id: 'loc-a', name: 'Alpha', organization_id: 'org-1' },
      { id: 'loc-x', name: 'Other-org studio', organization_id: 'org-2' },
    ],
  }

  it('lists only the active org studios, name-sorted', () => {
    const { studios } = resolveAccountNav(user)
    expect(studios.map((s) => s.id)).toEqual(['loc-a', 'loc-b'])
  })

  it('excludes studios from other orgs (no cross-tenant leak)', () => {
    const { studios } = resolveAccountNav(user)
    expect(studios.some((s) => s.id === 'loc-x')).toBe(false)
  })

  it('flags the active studio', () => {
    const { studios } = resolveAccountNav(user)
    expect(studios.find((s) => s.id === 'loc-b').isActive).toBe(true)
    expect(studios.find((s) => s.id === 'loc-a').isActive).toBe(false)
  })

  it('handles a user with no locations', () => {
    const nav = resolveAccountNav({ activeOrganization: { id: 'org-1' }, locations: [] })
    expect(nav.studios).toEqual([])
    expect(nav.enterStudioId).toBe(null)
  })
})

describe('resolveAccountNav — enterStudioId ("Enter studio →" target)', () => {
  it('prefers the active studio when it belongs to the active org', () => {
    const nav = resolveAccountNav({
      activeOrganization: { id: 'org-1' },
      activeLocation: { id: 'loc-b' },
      locations: [
        { id: 'loc-a', name: 'Alpha', organization_id: 'org-1' },
        { id: 'loc-b', name: 'Bravo', organization_id: 'org-1' },
      ],
    })
    expect(nav.enterStudioId).toBe('loc-b')
  })

  it('falls back to the first org studio when the active one is elsewhere', () => {
    const nav = resolveAccountNav({
      activeOrganization: { id: 'org-1' },
      activeLocation: { id: 'loc-x' }, // in another org
      locations: [
        { id: 'loc-b', name: 'Bravo', organization_id: 'org-1' },
        { id: 'loc-a', name: 'Alpha', organization_id: 'org-1' },
        { id: 'loc-x', name: 'X', organization_id: 'org-2' },
      ],
    })
    expect(nav.enterStudioId).toBe('loc-a') // first after name-sort
  })
})
