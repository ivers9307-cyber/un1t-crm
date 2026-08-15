// REPSET-PLATFORM.1 — platform-tier (master console) nav contract.
// ADMIN.2h Task 2 — the console grows from 4 to 8 roots: matrix, bridges,
// studio-devices and webhook-dead-letter join tenants/plans/tenant-domains/
// health. fleet is deliberately NOT here — it gets a home via the
// Operations hub tab instead (see (operations)/layout.js), so /admin/fleet
// keeps rendering the studio shell for everyone, master included.

import { describe, it, expect } from 'vitest'
import {
  PLATFORM_TIER_PATHS,
  isPlatformTierPath,
  resolvePlatformNav,
  PLATFORM_EXIT_ROUTE,
  PLATFORM_BRAND,
} from './platform-nav'

describe('isPlatformTierPath', () => {
  it('matches the eight console roots exactly', () => {
    expect(isPlatformTierPath('/admin/tenants')).toBe(true)
    expect(isPlatformTierPath('/admin/plans')).toBe(true)
    expect(isPlatformTierPath('/admin/tenant-domains')).toBe(true)
    expect(isPlatformTierPath('/admin/health')).toBe(true)
    expect(isPlatformTierPath('/admin/matrix')).toBe(true)
    expect(isPlatformTierPath('/admin/bridges')).toBe(true)
    expect(isPlatformTierPath('/admin/studio-devices')).toBe(true)
    expect(isPlatformTierPath('/admin/webhook-dead-letter')).toBe(true)
  })

  it('matches nested console segments (drill-in / provision stay in the shell)', () => {
    expect(isPlatformTierPath('/admin/tenants/new')).toBe(true)
    expect(isPlatformTierPath('/admin/tenants/org-123')).toBe(true)
    expect(isPlatformTierPath('/admin/plans/anything')).toBe(true)
    expect(isPlatformTierPath('/admin/matrix/anything')).toBe(true)
    expect(isPlatformTierPath('/admin/bridges/anything')).toBe(true)
    expect(isPlatformTierPath('/admin/studio-devices/anything')).toBe(true)
    expect(isPlatformTierPath('/admin/webhook-dead-letter/anything')).toBe(true)
  })

  it('does NOT claim /admin/fleet (it gets an Operations tab instead, not a console seat)', () => {
    expect(isPlatformTierPath('/admin/fleet')).toBe(false)
    expect(isPlatformTierPath('/admin/fleet/anything')).toBe(false)
  })

  it('does NOT claim other /admin pages (they keep their studio shell)', () => {
    expect(isPlatformTierPath('/admin')).toBe(false)
    // audit-log left /admin entirely in Task 1 (now /settings/audit-log) —
    // the OLD /admin/audit-log path was never a console root and still
    // is not one.
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
    expect(isPlatformTierPath('/admin/matrix-legacy')).toBe(false)
    expect(isPlatformTierPath('/admin/bridges-legacy')).toBe(false)
    expect(isPlatformTierPath(null)).toBe(false)
    expect(isPlatformTierPath(undefined)).toBe(false)
  })

  it('claims exactly the eight documented roots, in order', () => {
    expect([...PLATFORM_TIER_PATHS]).toEqual([
      '/admin/tenants',
      '/admin/plans',
      '/admin/tenant-domains',
      '/admin/health',
      '/admin/matrix',
      '/admin/bridges',
      '/admin/studio-devices',
      '/admin/webhook-dead-letter',
    ])
  })
})

describe('resolvePlatformNav', () => {
  it('exposes the eight console pages in order, Tenants as the home', () => {
    const { primary } = resolvePlatformNav(null)
    expect(primary.map((p) => p.href)).toEqual([
      '/admin/tenants',
      '/admin/plans',
      '/admin/tenant-domains',
      '/admin/health',
      '/admin/matrix',
      '/admin/bridges',
      '/admin/studio-devices',
      '/admin/webhook-dead-letter',
    ])
    // Tenants is first (the master landing target / console home).
    expect(primary[0].key).toBe('tenants')
    expect(primary[0].label).toBe('Tenants')
  })

  it('labels the four new console pages', () => {
    const { primary } = resolvePlatformNav(null)
    const byHref = Object.fromEntries(primary.map((p) => [p.href, p]))
    expect(byHref['/admin/health'].label).toBe('Platform health')
    expect(byHref['/admin/matrix'].label).toBe('Feature matrix')
    expect(byHref['/admin/bridges'].label).toBe('HR bridges')
    expect(byHref['/admin/studio-devices'].label).toBe('Studio devices')
    expect(byHref['/admin/webhook-dead-letter'].label).toBe('Dead letters')
  })

  it('every primary item carries an icon component', () => {
    const { primary } = resolvePlatformNav(null)
    for (const item of primary) {
      expect(typeof item.icon).toBe('object') // forwardRef component (lucide-react)
    }
  })

  it('includes the live cross-links: Provision tenant + Audit log', () => {
    const { actions } = resolvePlatformNav(null)
    const byKey = Object.fromEntries(actions.map((a) => [a.key, a]))

    // Both routes exist in-repo, so both are live.
    expect(byKey.provision.href).toBe('/admin/tenants/new')
    // ADMIN.2h Task 1 — audit log left /admin for /settings/audit-log.
    // Unchanged by Task 2's console expansion.
    expect(byKey.audit.href).toBe('/settings/audit-log')
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
