// REBOOK.1 — the Hatch board's Rebook rule (acquisition-un1t.js needsRebook).
import { describe, it, expect } from 'vitest'
import { classify, needsRebook } from './acquisition-un1t.js'

const NOW = Date.parse('2026-11-03T19:00:00Z')
const DAY = 86_400_000
const sec = (ms) => Math.floor(ms / 1000)

// A Hatch lead who joined two days ago: classifyContact says new_lead.
function lead(recent_bookings = [], extra = {}) {
  return {
    glofox_membership_status: 'trial',
    glofox_membership_state: null,
    glofox_membership_expiry: null,
    last_attended_at: null,
    total_attended_7d: null,
    total_attended_30d: null,
    last_payment_at: null,
    joined_at: new Date(NOW - 6 * DAY).toISOString(),
    created_at: null,
    trial_credits_remaining: 3,
    recent_bookings,
    converted_at: null,
    pack_customer_at: null,
    pipeline_dismissed_at: null,
    last_lead_source_at: null,
    gympass_member_id: null,
    trial_expires_at: null,
    paid_trial_at: null,
    paid_trial_expires_at: null,
    ...extra,
  }
}

describe('needsRebook', () => {
  it('Conall: one trial class, cancelled before it ran, never attended → rebook', () => {
    const s = lead([{ attended: false, status: 'CANCELLED', time_start: sec(NOW - 1 * 3600_000) }])
    expect(needsRebook(s, NOW)).toBe(true)
    expect(classify(s, NOW)).toBe('rebook')
  })

  it('a class cancelled for a future date counts as missed too', () => {
    const s = lead([{ attended: false, status: 'CANCELLED', time_start: sec(NOW + 2 * DAY) }])
    expect(classify(s, NOW)).toBe('rebook')
  })

  it('a no-show, and a past booking un1t.online never marked, are missed', () => {
    expect(classify(lead([{ attended: false, status: 'NO_SHOW', time_start: sec(NOW - DAY) }]), NOW)).toBe('rebook')
    expect(classify(lead([{ attended: false, status: 'BOOKED', time_start: sec(NOW - DAY) }]), NOW)).toBe('rebook')
  })

  it('never booked → stays a New Lead', () => {
    expect(needsRebook(lead([]), NOW)).toBe(false)
    expect(classify(lead([]), NOW)).toBe('new_lead')
  })

  it('a live booking still to come → stays a New Lead, even beside a cancelled one', () => {
    const s = lead([
      { attended: false, status: 'BOOKED', time_start: sec(NOW + DAY) },
      { attended: false, status: 'CANCELLED', time_start: sec(NOW - DAY) },
    ])
    expect(classify(s, NOW)).toBe('new_lead')
    expect(classify(lead([{ attended: false, status: 'WAITLISTED', time_start: sec(NOW + DAY) }]), NOW)).toBe('new_lead')
  })

  it('anyone who has trained here is never Rebook', () => {
    expect(needsRebook(lead([{ attended: false, status: 'CANCELLED', time_start: sec(NOW - DAY) }], { last_attended_at: new Date(NOW - 90 * DAY).toISOString() }), NOW)).toBe(false)
    expect(needsRebook(lead([{ attended: true, status: 'ATTENDED', time_start: sec(NOW - 90 * DAY) }]), NOW)).toBe(false)
  })

  it('only ever turns a New Lead into Rebook', () => {
    // Cold stays Cold: the operator's dismissal outranks the booking history.
    const cold = lead([{ attended: false, status: 'CANCELLED', time_start: sec(NOW - DAY) }], { pipeline_dismissed_at: new Date(NOW - 3600_000).toISOString() })
    expect(classify(cold, NOW)).toBe('cold_lead')
  })

  it('reads nothing it cannot trust: no snapshot, no bookings array', () => {
    expect(needsRebook(null, NOW)).toBe(false)
    expect(needsRebook({ recent_bookings: 'x' }, NOW)).toBe(false)
  })
})
