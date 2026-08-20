// XERO-ONE-ORG.1 — the rule is: one location, one Xero organisation, never
// shared. These cases are written against the REAL failure: three locations
// (UN1T Stillorgan, CCF Autos, SourceIt), three separate OAuth flows, all
// silently bound to the same tenant because the callback took tenants[0].
import { describe, it, expect } from 'vitest'
import { classifyTenants, chooseTenantToBind, validateTenantChoice } from './tenant-binding.js'

const GIVERS = { tenantId: 'b8a764df', tenantName: 'Givers Consultancy LTD', tenantType: 'ORGANISATION' }
const CHAMP = { tenantId: 'champ-01', tenantName: 'Champ Fitness Ltd', tenantType: 'ORGANISATION' }
const CCF = { tenantId: 'ccf-01', tenantName: 'CCF Autos Ltd', tenantType: 'ORGANISATION' }

const STILLORGAN = 'a0000000-0000-0000-0000-000000000001'
const CCF_LOC = 'f45ef67e'

// Givers is already held by CCF Autos — the state that actually shipped.
const EXISTING = [{ tenant_id: 'b8a764df', location_id: CCF_LOC, location_name: 'CCF Autos' }]

describe('classifyTenants', () => {
  it('marks a tenant held by another location as taken, and names the holder', () => {
    const { free, taken } = classifyTenants([GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(free).toEqual([CHAMP])
    expect(taken).toHaveLength(1)
    expect(taken[0].claimedBy).toBe('CCF Autos')
  })

  it('does NOT treat a location\'s own binding as a conflict (reconnect is fine)', () => {
    const { free, taken } = classifyTenants([GIVERS], EXISTING, CCF_LOC)
    expect(free).toEqual([GIVERS])
    expect(taken).toEqual([])
  })

  it('ignores malformed rows and tenants rather than throwing', () => {
    const { free } = classifyTenants([null, {}, CHAMP], [null, { location_id: 'x' }], STILLORGAN)
    expect(free).toEqual([CHAMP])
  })
})

describe('chooseTenantToBind', () => {
  it('THE BUG: never re-binds an org another location already holds', () => {
    // tenants[0] is Givers — exactly what the old callback would have taken.
    const r = chooseTenantToBind([GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(r.ok).toBe(true)
    expect(r.tenant).toEqual(CHAMP)
  })

  it('reports ambiguity when more than one org is free, so the operator confirms', () => {
    const r = chooseTenantToBind([CHAMP, CCF], [], STILLORGAN)
    expect(r.ok).toBe(true)
    expect(r.tenant).toEqual(CHAMP)
    expect(r.ambiguous).toBe(true)
    expect(r.alternatives).toEqual([CCF])
  })

  it('is not ambiguous when exactly one org is free', () => {
    const r = chooseTenantToBind([GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(r.ambiguous).toBe(false)
  })

  it('refuses when every granted org is already spoken for', () => {
    const r = chooseTenantToBind([GIVERS], EXISTING, STILLORGAN)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('all_taken')
    expect(r.taken[0].claimedBy).toBe('CCF Autos')
  })

  it('refuses when Xero grants nothing', () => {
    expect(chooseTenantToBind([], EXISTING, STILLORGAN)).toEqual({ ok: false, reason: 'none_granted' })
    expect(chooseTenantToBind(null, EXISTING, STILLORGAN).ok).toBe(false)
  })

  it('allows a reconnect of the location to the org it already holds', () => {
    const r = chooseTenantToBind([GIVERS], EXISTING, CCF_LOC)
    expect(r.ok).toBe(true)
    expect(r.tenant).toEqual(GIVERS)
  })
})

describe('validateTenantChoice', () => {
  it('accepts a free org the login actually granted', () => {
    const r = validateTenantChoice('champ-01', [GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(r.ok).toBe(true)
    expect(r.tenant).toEqual(CHAMP)
  })

  it('refuses an org another location holds, naming that location', () => {
    const r = validateTenantChoice('b8a764df', [GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already connected to CCF Autos/)
    expect(r.error).toMatch(/its own Xero organisation/)
  })

  it('refuses an org the login never authorised — no silent fallback', () => {
    const r = validateTenantChoice('someone-elses-org', [GIVERS, CHAMP], EXISTING, STILLORGAN)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not one this Xero login has authorised/)
  })

  it('refuses an empty choice', () => {
    expect(validateTenantChoice('', [CHAMP], [], STILLORGAN).ok).toBe(false)
    expect(validateTenantChoice(null, [CHAMP], [], STILLORGAN).ok).toBe(false)
  })

  it('lets a location re-select the org it already holds', () => {
    const r = validateTenantChoice('b8a764df', [GIVERS], EXISTING, CCF_LOC)
    expect(r.ok).toBe(true)
  })
})
