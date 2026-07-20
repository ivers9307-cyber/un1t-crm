// REPSET-PLATFORM.1 — platform-tier (master console) nav contract.

import { describe, it, expect } from 'vitest'
import {
  PLATFORM_TIER_PATHS,
  isPlatformTierPath,
  resolvePlatformNav,
  PLATFORM_EXIT_ROUTE,
  PLATFORM_BRAND,
} from './platform-nav'

describe('isPlatformTierPath', () => {
  it('matches the four console roots exactly', () => {
    expect(isPlatformTierPath('/admin/tenants')).toBe(true)
    expect(isPlatformTierPath('/admin/plans')).toBe(true)
    expect(isPlatformTierPath('/admin/tenant-domains')).toBe(true)
    expect(isPlatformTierPath('/admin/health')).toBe(true)
  })

  it('matches nested console segments (drill-in / provision stay in the shell)', () => {
    expect(isPlatformTierPath('/admin/tenants/new')).toBe(true)
    expect(isPlatformTierPath('/admin/tenants/org-123')).toBe(true)
    expect(isPlatformTierPath('/admin/plans/anything')).toBe(true)
  })

  it('does NOT claim other /admin pages (they keep their studio shell)', () => {
    // Per Richard's Phase-2 decision, ONLY the four console pages move.
    expect(isPlatformTierPath('/admin')).toBe(false)
    expect(isPlatformTierPath('/admin/matrix')).toBe(false)
    expect(isPlatformTierPath('/admin/audit-log')).toBe(false)
    expect(isPlatformTierPath('/admin/integrations')).toBe(false)
    expect(isPlatformTierPath('/admin/contracts')).toBe(false)
    expect(isPlatformTierPath('/admin/tv-displays')).toBe(false)
  })

  it('does not match studio or account surfaces', () => {
    expect(isPlatformTierPath('/dashboard')).toBe(false)
    expect(isPlatformTierPath('/portfolio')).toBe(false)
    // guard against a naive substring / prefix false-positive
    expect(isPlatformTierPath('/admin/tenants-archive')).toBe(false)
    expect(isPlatformTierPath('/admin/plans-legacy')).toBe(false)
    expect(isPlatformTierPath(null)).toBe(false)
    expect(isPlatformTierPath(undefined)).toBe(false)
  })

  it('claims exactly the four documented roots', () => {
    expect([...PLATFORM_TIER_PATHS]).toEqual([
      '/admin/tenants',
      '/admin/plans',
      '/admin/tenant-domains',
      '/admin/health',
    ])
  })
})

describe('resolvePlatformNav', () => {
  it('exposes the four console pages in order, Tenants as the home', () => {
    const { primary } = resolvePlatformNav(null)
    expect(primary.map((p) => p.href)).toEqual([
      '/admin/tenants',
      '/admin/plans',
      '/admin/tenant-domains',
      '/admin/health',
    ])
    // Tenants is first (the master landing target / console home).
    expect(primary[0].key).toBe('tenants')
    expect(primary[0].label).toBe('Tenants')
  })

  it('includes the live cross-links: Provision tenant + Audit log', () => {
    const { actions } = resolvePlatformNav(null)
    const byKey = Object.fromEntries(actions.map((a) => [a.key, a]))

    // Both routes exist in-repo, so both are live.
    expect(byKey.provision.href).toBe('/admin/tenants/new')
    expect(byKey.audit.href).toBe('/admin/audit-log')
  })

  it('flags Provision tenant as inside the console shell (nested under /admin/tenants)', () => {
    const { actions } = resolvePlatformNav(null)
    const byKey = Object.fromEntries(actions.map((a) => [a.key, a]))
    expect(byKey.provision.insideShell).toBe(true)
    // isPlatformTierPath must agree — the provision route stays shelled.
    expect(isPlatformTierPath(byKey.provision.href)).toBe(true)
  })

  it('flags Audit log as a cross-link OUT of the console (keeps its studio shell)', () => {
    const { actions } = resolvePlatformNav(null)
    const byKey = Object.fromEntries(actions.map((a) => [a.key, a]))
    expect(byKey.audit.insideShell).toBe(false)
    // isPlatformTierPath must agree — audit-log is NOT a console root.
    expect(isPlatformTierPath(byKey.audit.href)).toBe(false)
  })

  it('never emits a dead/omitted action row (only live items survive)', () => {
    const { actions } = resolvePlatformNav(null)
    expect(actions.every((a) => a.href)).toBe(true)
  })

  it('exits to the app at /dashboard (loop-safe: not a console path, not `/`)', () => {
    const { exitHref } = resolvePlatformNav(null)
    expect(exitHref).toBe(PLATFORM_EXIT_ROUTE)
    expect(exitHref).toBe('/dashboard')
    expect(isPlatformTierPath(exitHref)).toBe(false)
  })

  it('brands the console header "Repset" / "Platform"', () => {
    const { brand } = resolvePlatformNav(null)
    expect(brand).toBe(PLATFORM_BRAND)
    expect(brand.title).toBe('Repset')
    expect(brand.eyebrow).toBe('Platform')
  })
})
