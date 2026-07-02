import { describe, it, expect, vi } from 'vitest'
import { NUMBER_EVENT_FIELDS, numberColumnUpdate, numberNotification, applyNumberEvent } from './whatsapp-number-events.js'

describe('NUMBER_EVENT_FIELDS', () => {
  it('covers the four health webhook fields', () => {
    expect([...NUMBER_EVENT_FIELDS].sort()).toEqual([
      'account_update', 'business_capability_update', 'phone_number_name_update', 'phone_number_quality_update',
    ])
  })
})

describe('numberColumnUpdate', () => {
  it('FLAGGED → quality RED; UNFLAGGED → GREEN', () => {
    expect(numberColumnUpdate('phone_number_quality_update', { event: 'FLAGGED' })).toEqual({ quality_rating: 'RED' })
    expect(numberColumnUpdate('phone_number_quality_update', { event: 'UNFLAGGED' })).toEqual({ quality_rating: 'GREEN' })
  })
  it('limit tier changes persist current_limit', () => {
    expect(numberColumnUpdate('phone_number_quality_update', { event: 'DOWNGRADE', current_limit: 'TIER_250' }))
      .toEqual({ messaging_limit_tier: 'TIER_250' })
  })
  it('name decision → name_status', () => {
    expect(numberColumnUpdate('phone_number_name_update', { decision: 'APPROVED' })).toEqual({ name_status: 'APPROVED' })
  })
  it('account/capability events persist nothing', () => {
    expect(numberColumnUpdate('account_update', { event: 'DISABLED_UPDATE' })).toBeNull()
    expect(numberColumnUpdate('business_capability_update', { max_daily_conversation_per_phone: 1000 })).toBeNull()
  })
  it('unknown event carries no patch', () => {
    expect(numberColumnUpdate('phone_number_quality_update', { event: 'SOMETHING_ELSE' })).toBeNull()
  })
})

describe('numberNotification', () => {
  it('FLAGGED alerts with the number label', () => {
    const n = numberNotification('phone_number_quality_update', { event: 'FLAGGED' }, 'UN1T Stillorgan')
    expect(n.title).toMatch(/FLAGGED/)
    expect(n.body).toContain('UN1T Stillorgan')
  })
  it('DOWNGRADE includes the new tier', () => {
    const n = numberNotification('phone_number_quality_update', { event: 'DOWNGRADE', current_limit: 'TIER_250' })
    expect(n.body).toContain('TIER_250')
  })
  it('name APPROVED carries the re-register warning', () => {
    const n = numberNotification('phone_number_name_update', { decision: 'APPROVED', requested_verified_name: 'UN1T Dublin' })
    expect(n.body).toMatch(/re-register/i)
    expect(n.body).toContain('UN1T Dublin')
  })
  it('severe account events alert; benign ones stay silent', () => {
    expect(numberNotification('account_update', { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION', expiration: '2026-08-01' }] }).body)
      .toMatch(/restricted/i)
    expect(numberNotification('account_update', { event: 'AD_ACCOUNT_LINKED' })).toBeNull()
  })
  it('capability update lists the new caps', () => {
    const n = numberNotification('business_capability_update', { max_daily_conversation_per_phone: 1000 })
    expect(n.body).toContain('1000')
  })
})

function fakeDb(rows, updateSpy) {
  return {
    from: (table) => ({
      select: () => Promise.resolve({ data: rows }),
      update: (patch) => { updateSpy(table, patch); return { eq: () => Promise.resolve({ error: null }) } },
    }),
  }
}

const STILLORGAN = {
  id: 'n1', location_id: 'loc1', label: 'UN1T Stillorgan',
  display_phone: '+353 1 578 9401', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: null,
}

describe('applyNumberEvent', () => {
  it('matches the row by digits despite Meta formatting, patches, notifies its location', async () => {
    const updates = []
    const db = fakeDb([STILLORGAN], (t, p) => updates.push([t, p]))
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })
    expect(updates).toEqual([['whatsapp_numbers', { quality_rating: 'RED' }]])
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify.title).toMatch(/FLAGGED/)
  })

  it('is idempotent: an already-applied patch updates nothing and stays silent', async () => {
    const updates = []
    const db = fakeDb([{ ...STILLORGAN, quality_rating: 'RED' }], (t, p) => updates.push([t, p]))
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })
    expect(updates).toEqual([])
    expect(res.notify).toBeNull()
  })

  it('account-level events fan out to every number location', async () => {
    const db = fakeDb([STILLORGAN, { ...STILLORGAN, id: 'n2', location_id: 'loc2', display_phone: '+353 1 111 2222' }], () => {})
    const res = await applyNumberEvent(db, 'account_update', { event: 'DISABLED_UPDATE' })
    expect(res.locations.sort()).toEqual(['loc1', 'loc2'])
    expect(res.notify.body).toMatch(/disabled/i)
  })

  it('unmatched number with a column patch still notifies (all locations) without updating', async () => {
    const updates = []
    const db = fakeDb([STILLORGAN], (t, p) => updates.push([t, p]))
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '999999', event: 'FLAGGED' })
    expect(updates).toEqual([])
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify).not.toBeNull()
  })
})
