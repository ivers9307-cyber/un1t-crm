import { describe, it, expect } from 'vitest'
import {
  MOBILE_NAV_FEATURES, BAR_ELIGIBLE, DEFAULT_MOBILE_LAYOUT, MOBILE_NAV_ORDER,
} from './mobile-nav.js'
import { resolveMobileLayout } from './mobile-nav.js'

describe('mobile-nav registry', () => {
  it('every feature has key/label/permKeys/barEligible', () => {
    for (const f of MOBILE_NAV_FEATURES) {
      expect(typeof f.key).toBe('string')
      expect(typeof f.label).toBe('string')
      expect(Array.isArray(f.permKeys) && f.permKeys.length > 0).toBe(true)
      expect(typeof f.barEligible).toBe('boolean')
    }
  })

  it('BAR_ELIGIBLE is exactly the bar-eligible keys', () => {
    expect([...BAR_ELIGIBLE].sort()).toEqual(
      ['bookings', 'expenses', 'invoices', 'pipeline', 'schedule', 'studio', 'whatsapp'].sort()
    )
  })

  it('keys are unique and MOBILE_NAV_ORDER matches', () => {
    const keys = MOBILE_NAV_FEATURES.map(f => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(MOBILE_NAV_ORDER).toEqual(keys)
  })

  it('every role default references only known + bar-eligible keys', () => {
    const eligible = new Set(BAR_ELIGIBLE)
    for (const role of Object.keys(DEFAULT_MOBILE_LAYOUT)) {
      for (const type of ['fte', 'contractor']) {
        const t = DEFAULT_MOBILE_LAYOUT[role][type]
        for (const k of [...t.bar, ...t.allowed]) expect(eligible.has(k)).toBe(true)
        expect(t.bar.length).toBeLessThanOrEqual(3)
      }
    }
  })
})

const ALL = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings', 'expenses', 'tasks', 'radar', 'issues', 'contracts', 'policies']

describe('resolveMobileLayout', () => {
  it('manager default reproduces today\'s bar', () => {
    const r = resolveMobileLayout({ role: 'manager', employmentType: 'fte', enabledKeys: ALL, override: null })
    expect(r.bar).toEqual(['schedule', 'whatsapp', 'studio'])
    expect(r.more).toContain('pipeline')
    expect(r.more).not.toContain('schedule')
  })

  it('owner default is the lean Schedule + Studio', () => {
    const r = resolveMobileLayout({ role: 'owner', employmentType: 'fte', enabledKeys: ALL, override: null })
    expect(r.bar).toEqual(['schedule', 'studio'])
    expect(r.more).toContain('whatsapp') // WhatsApp dropped to More for owners
  })

  it('an override beats the template and is capped at 3, ordered', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['pipeline', 'schedule', 'whatsapp', 'studio'], allowed: ['pipeline', 'schedule', 'whatsapp', 'studio'] },
    })
    expect(r.bar).toEqual(['pipeline', 'schedule', 'whatsapp']) // 4th dropped by cap
  })

  it('drops bar/allowed entries that are not enabled', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: ['schedule', 'studio'], // whatsapp toggled off
      override: null,
    })
    expect(r.bar).toEqual(['schedule', 'studio'])
  })

  it('never exposes a non-bar-eligible key in the bar even if an override lists it', () => {
    const r = resolveMobileLayout({
      role: 'staff', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['tasks', 'schedule'], allowed: ['tasks', 'schedule'] },
    })
    expect(r.bar).toEqual(['schedule']) // 'tasks' is not bar-eligible
    expect(r.more).toContain('tasks')
  })

  it('contractor vs fte: finance surface differs', () => {
    const fte = resolveMobileLayout({ role: 'staff', employmentType: 'fte', enabledKeys: ['schedule', 'expenses'], override: null })
    const con = resolveMobileLayout({ role: 'staff', employmentType: 'contractor', enabledKeys: ['schedule', 'invoices'], override: null })
    expect(fte.more).toContain('expenses')
    expect(fte.allowed).toContain('expenses')
    expect(con.allowed).toContain('invoices')
    expect(con.allowed).not.toContain('expenses')
  })

  it('bar items are implicitly allowed (override with bar but empty allowed still works)', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte', enabledKeys: ALL,
      override: { bar: ['schedule', 'pipeline'], allowed: [] },
    })
    expect(r.bar).toEqual(['schedule', 'pipeline'])
  })

  it('more is ordered by MOBILE_NAV_ORDER and excludes bar items', () => {
    const r = resolveMobileLayout({ role: 'manager', employmentType: 'fte', enabledKeys: ALL, override: null })
    const idx = (k) => r.more.indexOf(k)
    expect(idx('pipeline')).toBeGreaterThanOrEqual(0)
    expect(idx('pipeline')).toBeLessThan(idx('tasks')) // registry order preserved
    for (const k of r.bar) expect(r.more).not.toContain(k)
  })

  it('unknown role falls back to staff/fte without throwing', () => {
    const r = resolveMobileLayout({ role: 'nope', employmentType: null, enabledKeys: ['schedule'], override: null })
    expect(r.bar).toEqual(['schedule'])
  })
})
