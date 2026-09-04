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
      ['bookings', 'email', 'expenses', 'invoices', 'pipeline', 'race', 'schedule', 'studio', 'whatsapp'].sort()
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

const ALL = ['schedule', 'whatsapp', 'email', 'studio', 'pipeline', 'bookings', 'expenses', 'tasks', 'radar', 'issues', 'contracts', 'policies']

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

  it('owner default puts WhatsApp in more (reachable via the More list)', () => {
    const r = resolveMobileLayout({ role: 'owner', employmentType: 'fte', enabledKeys: ['schedule', 'whatsapp', 'studio'], override: null })
    expect(r.bar).toEqual(['schedule', 'studio'])
    expect(r.more).toContain('whatsapp')
  })

  it('master default resolves (inherits owner-style lean bar)', () => {
    const r = resolveMobileLayout({ role: 'master', employmentType: 'fte', enabledKeys: ['schedule', 'studio', 'whatsapp'], override: null })
    expect(r.bar).toEqual(['schedule', 'studio'])
    expect(r.more).toContain('whatsapp')
  })
})

// INBOX-SPLIT.M1 — email is a surface of its own, so it resolves like any
// other nav feature rather than riding on `whatsapp`.
describe('email as its own nav feature', () => {
  it('is separate from whatsapp — a whatsapp-only user gets no email surface', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: ['schedule', 'whatsapp', 'studio'], override: null,
    })
    expect(r.more).not.toContain('email')
    expect(r.allowed).not.toContain('email')
    expect(r.bar).toContain('whatsapp')
  })

  it('an email-only user gets email and no Messages surface', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: ['schedule', 'email'], override: null,
    })
    expect(r.more).toContain('email')
    expect(r.more).not.toContain('whatsapp')
    expect(r.allowed).toContain('email')
  })

  it('is bar-placeable for the roles that hold email_inbox by default', () => {
    for (const role of ['owner', 'manager', 'master']) {
      const r = resolveMobileLayout({ role, employmentType: 'fte', enabledKeys: ALL, override: null })
      expect(r.allowed).toContain('email')
    }
    const r = resolveMobileLayout({ ...{ role: 'manager', employmentType: 'fte' }, enabledKeys: ALL, override: null, staffBar: ['email', 'schedule'] })
    expect(r.bar).toEqual(['email', 'schedule'])
  })

  it('a granted head_coach reaches it via More but cannot bar-place it', () => {
    const r = resolveMobileLayout({
      role: 'head_coach', employmentType: 'fte', enabledKeys: ALL,
      override: null, staffBar: ['email', 'schedule'],
    })
    expect(r.more).toContain('email')
    expect(r.allowed).not.toContain('email')
    expect(r.bar).toEqual(['schedule'])
  })
})

describe('resolveMobileLayout staffBar', () => {
  const ALLOWED_MGR = ['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings']
  const base = { role: 'manager', employmentType: 'fte', enabledKeys: ALLOWED_MGR }

  it('staffBar overrides the bar arrangement (within allowed)', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline', 'schedule'] })
    expect(r.bar).toEqual(['pipeline', 'schedule'])
  })

  it('staffBar is clamped to allowed (a non-allowed key is dropped)', () => {
    const r = resolveMobileLayout({
      role: 'staff', employmentType: 'fte', enabledKeys: ['schedule', 'bookings', 'expenses'],
      override: null, staffBar: ['pipeline', 'schedule'], // staff allowed = schedule+bookings+expenses, NOT pipeline
    })
    expect(r.bar).toEqual(['schedule'])
  })

  it('staffBar is clamped to enabled', () => {
    const r = resolveMobileLayout({ ...base, enabledKeys: ['schedule', 'studio'], override: null, staffBar: ['whatsapp', 'schedule'] })
    expect(r.bar).toEqual(['schedule'])
  })

  it('empty/missing staffBar falls back to the admin/template bar', () => {
    const r1 = resolveMobileLayout({ ...base, override: null, staffBar: [] })
    const r2 = resolveMobileLayout({ ...base, override: null, staffBar: null })
    expect(r1.bar).toEqual(['schedule', 'whatsapp', 'studio'])
    expect(r2.bar).toEqual(['schedule', 'whatsapp', 'studio'])
  })

  it('staffBar is capped at 3', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline', 'bookings', 'schedule', 'whatsapp'] })
    expect(r.bar).toEqual(['pipeline', 'bookings', 'schedule'])
  })

  it('allowed still comes from the admin layer, not staffBar', () => {
    const r = resolveMobileLayout({ ...base, override: null, staffBar: ['pipeline'] })
    expect(r.allowed).toEqual(expect.arrayContaining(['schedule', 'whatsapp', 'studio', 'pipeline', 'bookings']))
  })
})

// RACE-TAB.1 — the Race day surface. Bar-eligible so both planners offer it,
// but templated to nobody: pinning it is always a deliberate act, and the
// automatic race-day placement is a CONTEXTUAL tab (tabs)/_layout.jsx inserts
// outside the three resolved slots, not a layout change.
describe('race as a nav feature', () => {
  it('is registered, bar-eligible, and gated on the races permission', () => {
    const race = MOBILE_NAV_FEATURES.find(f => f.key === 'race')
    expect(race).toBeTruthy()
    expect(race.barEligible).toBe(true)
    expect(race.permKeys).toEqual(['races'])
    expect(BAR_ELIGIBLE).toContain('race')
  })

  it('appears in NO default template, for any role or employment type', () => {
    for (const role of Object.keys(DEFAULT_MOBILE_LAYOUT)) {
      for (const type of ['fte', 'contractor']) {
        const t = DEFAULT_MOBILE_LAYOUT[role][type]
        expect(t.bar).not.toContain('race')
        expect(t.allowed).not.toContain('race')
      }
    }
  })

  it('a races-holding manager reaches it via More but cannot pin it by default', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: [...ALL, 'race'], override: null, staffBar: ['race', 'schedule'],
    })
    expect(r.more).toContain('race')
    expect(r.allowed).not.toContain('race')
    expect(r.bar).toEqual(['schedule']) // 'race' clamped out — not admin-allowed
  })

  it('becomes pinnable once an admin lists it in the override allowed set', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte',
      enabledKeys: [...ALL, 'race'],
      override: { bar: ['schedule', 'whatsapp', 'studio'], allowed: ['schedule', 'whatsapp', 'studio', 'race'] },
      staffBar: ['race', 'schedule'],
    })
    expect(r.allowed).toContain('race')
    expect(r.bar).toEqual(['race', 'schedule'])
    expect(r.more).not.toContain('race')
  })

  it('stays invisible to a user without the races permission', () => {
    const r = resolveMobileLayout({
      role: 'manager', employmentType: 'fte', enabledKeys: ALL, // no 'race'
      override: { bar: ['race', 'schedule'], allowed: ['race', 'schedule'] },
    })
    expect(r.bar).toEqual(['schedule'])
    expect(r.more).not.toContain('race')
    expect(r.allowed).not.toContain('race')
  })
})
