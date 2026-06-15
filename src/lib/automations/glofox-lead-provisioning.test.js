import { describe, it, expect, vi } from 'vitest'
import { qualifiesForGlofoxProvisioning, maybeProvisionLeadInGlofox } from './glofox-lead-provisioning.js'

describe('qualifiesForGlofoxProvisioning', () => {
  it('true for a fresh emailed lead not yet in Glofox', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', glofox_member_id: null, source: 'manual' })).toBe(true)
  })
  it('false when already linked to a Glofox member', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', glofox_member_id: 'gm_1' })).toBe(false)
  })
  it('false with no email', () => {
    expect(qualifiesForGlofoxProvisioning({ email: null, glofox_member_id: null })).toBe(false)
  })
  it('false for ClassPass shadow contacts', () => {
    expect(qualifiesForGlofoxProvisioning({ email: 'a@b.com', source: 'classpass' })).toBe(false)
  })
  it('false for null/garbage input', () => {
    expect(qualifiesForGlofoxProvisioning(null)).toBe(false)
  })
})

describe('maybeProvisionLeadInGlofox', () => {
  function makeDb(enabledRow) {
    return {
      from(table) {
        if (table !== 'location_automations') throw new Error(`unexpected table ${table}`)
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: enabledRow }) }) }) }),
        }
      },
    }
  }

  it('calls findOrCreateGlofoxMember in CREATE+TRIAL mode when enabled and eligible', async () => {
    const spy = vi.fn(async () => ({ status: 'created' }))
    const db = makeDb({ enabled: true })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: true, attachTrial: true })
  })

  it('falls back to LINK-ONLY (createIfMissing:false) when the automation is disabled', async () => {
    const spy = vi.fn(async () => ({ status: 'linked' }))
    const db = makeDb({ enabled: false })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: false, attachTrial: false })
  })

  it('falls back to LINK-ONLY when enabled but the lead is ineligible (already linked)', async () => {
    const spy = vi.fn(async () => ({}))
    const db = makeDb({ enabled: true })
    await maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: 'gm_1', location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: false, attachTrial: false })
  })

  it('never throws when the helper throws', async () => {
    const spy = vi.fn(async () => { throw new Error('glofox down') })
    const db = makeDb({ enabled: true })
    await expect(maybeProvisionLeadInGlofox({
      db, locationId: 'loc1', source: 'manual',
      contact: { id: 'c1', email: 'a@b.com', glofox_member_id: null, location_id: 'loc1' },
      _findOrCreateGlofoxMember: spy,
    })).resolves.toBeUndefined()
  })
})
