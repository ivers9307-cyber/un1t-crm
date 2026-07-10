import { describe, it, expect, vi } from 'vitest'
import { NUMBER_EVENT_FIELDS, numberColumnUpdate, numberNotification, broadcastPauseReason, applyNumberEvent } from './whatsapp-number-events.js'

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

describe('broadcastPauseReason', () => {
  it('FLAGGED → a quality-collapse reason', () => {
    expect(broadcastPauseReason('phone_number_quality_update', { event: 'FLAGGED' })).toMatch(/flagged/i)
  })
  it('DOWNGRADE → a limit-downgrade reason naming the new tier', () => {
    const reason = broadcastPauseReason('phone_number_quality_update', { event: 'DOWNGRADE', current_limit: 'TIER_250' })
    expect(reason).toMatch(/downgrad/i)
    expect(reason).toContain('TIER_250')
  })
  it('recoveries and other fields never pause', () => {
    expect(broadcastPauseReason('phone_number_quality_update', { event: 'UNFLAGGED' })).toBeNull()
    expect(broadcastPauseReason('phone_number_quality_update', { event: 'UPGRADE', current_limit: 'TIER_10K' })).toBeNull()
    expect(broadcastPauseReason('phone_number_name_update', { decision: 'REJECTED' })).toBeNull()
    expect(broadcastPauseReason('account_update', { event: 'DISABLED_UPDATE' })).toBeNull()
  })
})

// Table-routing fake: whatsapp_numbers supports the select/update(+eq) shapes
// applyNumberEvent uses; whatsapp_broadcasts supports the auto-pause chain
// update(..).eq(..).eq(..).eq(..).is(..).select(..) and records its filters.
function fakeDb({ numbers = [], pausedRows = [] } = {}) {
  const calls = { updates: [], pauseFilters: [] }
  const db = {
    from: (table) => {
      if (table === 'whatsapp_broadcasts') {
        return {
          update: (patch) => {
            calls.updates.push([table, patch])
            const chain = {
              filters: [],
              eq(col, val) { this.filters.push(['eq', col, val]); return this },
              is(col, val) { this.filters.push(['is', col, val]); return this },
              select() { calls.pauseFilters.push(this.filters); return Promise.resolve({ data: pausedRows, error: null }) },
            }
            return chain
          },
        }
      }
      return {
        select: () => Promise.resolve({ data: numbers }),
        update: (patch) => { calls.updates.push([table, patch]); return { eq: () => Promise.resolve({ error: null }) } },
      }
    },
  }
  return { db, calls }
}

const STILLORGAN = {
  id: 'n1', location_id: 'loc1', label: 'UN1T Stillorgan',
  display_phone: '+353 1 578 9401', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: null,
}

describe('applyNumberEvent', () => {
  it('matches the row by digits despite Meta formatting, patches, notifies its location', async () => {
    const { db, calls } = fakeDb({ numbers: [STILLORGAN] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })
    expect(calls.updates.filter(([t]) => t === 'whatsapp_numbers')).toEqual([['whatsapp_numbers', { quality_rating: 'RED' }]])
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify.title).toMatch(/FLAGGED/)
  })

  it('is idempotent: an already-applied patch updates nothing, pauses nothing, stays silent', async () => {
    const { db, calls } = fakeDb({ numbers: [{ ...STILLORGAN, quality_rating: 'RED' }], pausedRows: [{ id: 'b1', name: 'July promo' }] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })
    expect(calls.updates).toEqual([])
    expect(res.notify).toBeNull()
    expect(res.pausedBroadcasts).toEqual([])
  })

  it('account-level events fan out to every number location', async () => {
    const { db } = fakeDb({ numbers: [STILLORGAN, { ...STILLORGAN, id: 'n2', location_id: 'loc2', display_phone: '+353 1 111 2222' }] })
    const res = await applyNumberEvent(db, 'account_update', { event: 'DISABLED_UPDATE' })
    expect(res.locations.sort()).toEqual(['loc1', 'loc2'])
    expect(res.notify.body).toMatch(/disabled/i)
  })

  it('unmatched number with a column patch still notifies (all locations) without updating', async () => {
    const { db, calls } = fakeDb({ numbers: [STILLORGAN] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '999999', event: 'FLAGGED' })
    expect(calls.updates).toEqual([])
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify).not.toBeNull()
  })
})

describe('applyNumberEvent — auto-pause on quality collapse (WA-QUALITY.1)', () => {
  it('FLAGGED pauses in-flight drips at the matched location and says so in the push', async () => {
    const { db, calls } = fakeDb({ numbers: [STILLORGAN], pausedRows: [{ id: 'b1', name: 'July promo' }, { id: 'b2', name: 'Win-back' }] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })

    const pause = calls.updates.find(([t]) => t === 'whatsapp_broadcasts')
    expect(pause).toBeTruthy()
    expect(pause[1]).toEqual({ paused_at: expect.any(String) })
    // Scoped to the matched location's IN-FLIGHT drips only, and only rows not
    // already paused (webhook redeliveries must be no-ops at the DB).
    expect(calls.pauseFilters[0]).toEqual([
      ['eq', 'location_id', 'loc1'],
      ['eq', 'status', 'sending'],
      ['eq', 'delivery_mode', 'drip'],
      ['is', 'paused_at', null],
    ])
    expect(res.pausedBroadcasts).toHaveLength(2)
    expect(res.notify.body).toMatch(/auto-paused 2 in-flight drip broadcasts/i)
    expect(res.notify.body).toMatch(/flagged/i)
  })

  it('a messaging-limit DOWNGRADE pauses drips too', async () => {
    const { db, calls } = fakeDb({ numbers: [STILLORGAN], pausedRows: [{ id: 'b1', name: 'July promo' }] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'DOWNGRADE', current_limit: 'TIER_250' })
    expect(calls.updates.find(([t]) => t === 'whatsapp_broadcasts')).toBeTruthy()
    expect(res.pausedBroadcasts).toHaveLength(1)
    expect(res.notify.body).toMatch(/auto-paused 1 in-flight drip broadcast\b/i)
  })

  it('UNFLAGGED / UPGRADE recoveries never touch broadcasts', async () => {
    const flagged = { ...STILLORGAN, quality_rating: 'RED' }
    const { db, calls } = fakeDb({ numbers: [flagged], pausedRows: [{ id: 'b1', name: 'x' }] })
    await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'UNFLAGGED' })
    await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'UPGRADE', current_limit: 'TIER_10K' })
    expect(calls.updates.filter(([t]) => t === 'whatsapp_broadcasts')).toEqual([])
  })

  it('an unmatched number cannot scope a pause — notifies but pauses nothing', async () => {
    const { db, calls } = fakeDb({ numbers: [STILLORGAN], pausedRows: [{ id: 'b1', name: 'x' }] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '999999', event: 'FLAGGED' })
    expect(calls.updates.filter(([t]) => t === 'whatsapp_broadcasts')).toEqual([])
    expect(res.pausedBroadcasts).toEqual([])
    expect(res.notify).not.toBeNull()
  })

  it('nothing actually in flight → push keeps its original body (no misleading pause note)', async () => {
    const { db } = fakeDb({ numbers: [STILLORGAN], pausedRows: [] })
    const res = await applyNumberEvent(db, 'phone_number_quality_update', { display_phone_number: '35315789401', event: 'FLAGGED' })
    expect(res.notify.body).not.toMatch(/auto-paused/i)
  })
})
