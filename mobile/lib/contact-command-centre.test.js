import { describe, it, expect } from 'vitest'
import {
  mergeTimeline,
  timelineFilterGroup,
  TIMELINE_FILTERS,
  isGlofoxSynced,
  timelineIconMeta,
  glofoxStatusMeta,
  glofoxStateMeta,
  relativeTime,
  formatMoney,
  formatShortDate,
  formatTenure,
  humanise,
  billingLine,
  splitCrmBookings,
  crmBookingStatusMeta,
  splitGlofoxBookings,
  glofoxBookingBadge,
  formatGlofoxBookingTime,
} from './contact-command-centre'

describe('mergeTimeline', () => {
  it('merges notes and activities newest-first with a reliable kind discriminator', () => {
    const notes = [{ id: 'n1', created_at: '2026-07-10T10:00:00Z', content: 'hello' }]
    const activities = [
      { id: 'a1', created_at: '2026-07-11T10:00:00Z', type: 'booking' },
      { id: 'a2', created_at: '2026-07-09T10:00:00Z', type: null },
    ]
    const tl = mergeTimeline(notes, activities)
    expect(tl.map((t) => t.id)).toEqual(['a1', 'n1', 'a2'])
    // Unlike the web merge (raw row clobbers `type`), kind survives the
    // activity's own type column — that's the point of this port.
    expect(tl[0]).toMatchObject({ kind: 'activity', activityType: 'booking', type: 'booking' })
    expect(tl[1]).toMatchObject({ kind: 'note', activityType: 'note' })
    expect(tl[2].activityType).toBe('task') // null type falls back to task
  })

  it('handles empty and nullish inputs', () => {
    expect(mergeTimeline([], [])).toEqual([])
    expect(mergeTimeline(null, undefined)).toEqual([])
  })
})

describe('timelineFilterGroup', () => {
  it('maps activity types to filter pills (same grouping as web)', () => {
    expect(timelineFilterGroup({ activityType: 'booking' })).toBe('classes')
    expect(timelineFilterGroup({ activityType: 'whatsapp_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'whatsapp_received' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'sms_sent' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'email' })).toBe('messages')
    expect(timelineFilterGroup({ activityType: 'note' })).toBe('notes')
    expect(timelineFilterGroup({ activityType: 'pipeline' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'task' })).toBe('system')
    expect(timelineFilterGroup({ activityType: 'call' })).toBe('system')
    expect(timelineFilterGroup(null)).toBe('system')
  })

  it('exposes the five filter pills, All first', () => {
    expect(TIMELINE_FILTERS.map((f) => f.key)).toEqual(['all', 'classes', 'messages', 'notes', 'system'])
  })
})

describe('isGlofoxSynced', () => {
  it('flags only Glofox-sourced activities, never CRM notes', () => {
    expect(isGlofoxSynced({ kind: 'activity', source: 'glofox' })).toBe(true)
    expect(isGlofoxSynced({ kind: 'activity', source: 'crm' })).toBe(false)
    expect(isGlofoxSynced({ kind: 'note', source: 'glofox' })).toBe(false)
    expect(isGlofoxSynced(null)).toBe(false)
  })
})

describe('timelineIconMeta', () => {
  it('returns a full meta object per known type and falls back to task', () => {
    const note = timelineIconMeta('note')
    expect(note).toMatchObject({ label: 'Note' })
    expect(note.icon).toBeTruthy()
    expect(note.bg).toMatch(/^bg-/)
    expect(note.color).toMatch(/^#/)
    expect(timelineIconMeta('whatsapp_received').label).toBe('WhatsApp Received')
    expect(timelineIconMeta('nonsense')).toEqual(timelineIconMeta('task'))
    expect(timelineIconMeta(undefined)).toEqual(timelineIconMeta('task'))
  })
})

describe('glofoxStatusMeta / glofoxStateMeta', () => {
  it('maps known lead statuses and renders unknown ones verbatim in gray', () => {
    expect(glofoxStatusMeta('member').label).toBe('Member')
    expect(glofoxStatusMeta('classpass_payg').label).toBe('ClassPass PAYG')
    expect(glofoxStatusMeta('weird_new_status')).toMatchObject({
      label: 'weird_new_status', text: 'text-gray-700',
    })
    expect(glofoxStatusMeta(null)).toBeNull()
  })

  it('maps live membership states; locked reads as the Overdue arrears signal', () => {
    expect(glofoxStateMeta('locked')).toMatchObject({ label: 'Overdue', text: 'text-red-700' })
    expect(glofoxStateMeta('active').label).toBe('Active')
    expect(glofoxStateMeta('future').label).toBe('Upcoming')
    expect(glofoxStateMeta('unknown')).toBeNull()
    expect(glofoxStateMeta(null)).toBeNull()
  })

  it('uses the light-theme chip ramp (bg-*-500/10 + text-*-700)', () => {
    for (const meta of [glofoxStatusMeta('member'), glofoxStateMeta('locked')]) {
      expect(meta.cls).toMatch(/^bg-[a-z]+-500\/10$/)
      expect(meta.text).toMatch(/^text-[a-z]+-700$/)
    }
  })
})

describe('formatting ports', () => {
  it('relativeTime handles past, future and nullish', () => {
    expect(relativeTime(null)).toBeNull()
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('just now')
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago')
    expect(relativeTime(new Date(Date.now() - 2 * 86_400_000 - 3_600_000).toISOString())).toBe('2d ago')
    expect(relativeTime(new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString())).toBe('in 2d')
    expect(relativeTime(new Date(Date.now() - 65 * 86_400_000).toISOString())).toBe('2mo ago')
  })

  it('formatMoney renders cents with a currency symbol', () => {
    expect(formatMoney(12000, 'EUR')).toBe('€120')
    expect(formatMoney(9900, 'GBP')).toBe('£99')
    expect(formatMoney(5000, null)).toBe('€50')
    expect(formatMoney(NaN, 'EUR')).toBeNull()
    expect(formatMoney(undefined, 'EUR')).toBeNull()
  })

  it('formatShortDate renders en-IE style and rejects garbage', () => {
    expect(formatShortDate('2026-07-14T10:00:00Z')).toMatch(/14 Jul 2026/)
    expect(formatShortDate('not-a-date')).toBeNull()
    expect(formatShortDate(null)).toBeNull()
  })

  it('formatTenure buckets days, months and years', () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
    expect(formatTenure(daysAgo(1))).toBe('Joined 1 day ago')
    expect(formatTenure(daysAgo(10))).toBe('Joined 10 days ago')
    expect(formatTenure(daysAgo(90))).toBe('Joined 2 months ago')
    expect(formatTenure(daysAgo(400))).toMatch(/^Joined 1y/)
    expect(formatTenure(null)).toBeNull()
    // Future joined_at is nonsense — refuse rather than "-3 days ago".
    expect(formatTenure(new Date(Date.now() + 86_400_000).toISOString())).toBeNull()
  })

  it('humanise title-cases slug-ish values', () => {
    expect(humanise('direct_debit')).toBe('Direct debit')
    expect(humanise('  card ')).toBe('Card')
    expect(humanise('')).toBeNull()
    expect(humanise(42)).toBeNull()
  })
})

describe('billingLine', () => {
  it('joins price/interval and membership type', () => {
    expect(billingLine({
      glofox_membership_price_cents: 12000,
      lifetime_currency: 'EUR',
      glofox_billing_interval: '6 months',
      glofox_membership_type: 'time',
    })).toBe('€120 / 6 months · Subscription')
  })

  it('degrades gracefully when parts are missing', () => {
    expect(billingLine({ glofox_membership_type: 'num_classes' })).toBe('Class pack')
    expect(billingLine({ glofox_billing_interval: 'month' })).toBe('Billed every month')
    expect(billingLine({ glofox_membership_price_cents: 5000 })).toBe('€50')
    expect(billingLine({})).toBe('')
    expect(billingLine(null)).toBe('')
  })
})

describe('splitCrmBookings', () => {
  const rows = [
    { id: 'past-cancelled', booking_date: '2026-07-20', start_time: '09:00', status: 'cancelled' },
    { id: 'up-later', booking_date: '2026-07-21', start_time: '10:00', status: 'confirmed' },
    { id: 'up-today', booking_date: '2026-07-16', start_time: '07:00', status: 'confirmed' },
    { id: 'past-old', booking_date: '2026-07-01', start_time: '09:00', status: 'completed' },
    { id: 'past-recent', booking_date: '2026-07-10', start_time: '18:00', status: 'no_show' },
  ]

  it('splits on todayStr + confirmed, upcoming soonest-first, past newest-first', () => {
    const { upcoming, past } = splitCrmBookings(rows, '2026-07-16')
    expect(upcoming.map((b) => b.id)).toEqual(['up-today', 'up-later'])
    // A future-dated cancelled booking is not "upcoming" (web parity).
    expect(past.map((b) => b.id)).toEqual(['past-cancelled', 'past-recent', 'past-old'])
  })

  it('handles empty input', () => {
    expect(splitCrmBookings(null, '2026-07-16')).toEqual({ upcoming: [], past: [] })
  })
})

describe('crmBookingStatusMeta', () => {
  it('maps the four web statuses and humanises unknown ones', () => {
    expect(crmBookingStatusMeta('confirmed').label).toBe('Confirmed')
    expect(crmBookingStatusMeta('no_show')).toMatchObject({ label: 'No-show', text: 'text-yellow-700' })
    expect(crmBookingStatusMeta('pending_payment').label).toBe('Pending payment')
    expect(crmBookingStatusMeta(null)).toBeNull()
  })
})

describe('splitGlofoxBookings', () => {
  const nowSec = 1_000_000
  const rows = [
    { glofox_id: 'g1', time_start: nowSec + 100 },
    { glofox_id: 'g2', time_start: nowSec + 50 },
    { glofox_id: 'g3', time_start: nowSec - 10 },
    { glofox_id: 'g4', time_start: nowSec - 500 },
  ]

  it('splits on the epoch boundary, upcoming asc / past desc (web parity)', () => {
    const { upcoming, past } = splitGlofoxBookings(rows, nowSec)
    expect(upcoming.map((b) => b.glofox_id)).toEqual(['g2', 'g1'])
    expect(past.map((b) => b.glofox_id)).toEqual(['g3', 'g4'])
  })

  it('tolerates a non-array recent_bookings blob', () => {
    expect(splitGlofoxBookings(null, nowSec)).toEqual({ upcoming: [], past: [] })
    expect(splitGlofoxBookings({}, nowSec)).toEqual({ upcoming: [], past: [] })
  })
})

describe('glofoxBookingBadge', () => {
  it('ports the web BookingRow badge matrix', () => {
    expect(glofoxBookingBadge({ status: 'CANCELLED' }, 'past').label).toBe('Cancelled')
    expect(glofoxBookingBadge({ status: 'CANCELED' }, 'future').label).toBe('Cancelled')
    expect(glofoxBookingBadge({ status: 'WAITING' }, 'future').label).toBe('Waitlist')
    expect(glofoxBookingBadge({ status: 'BOOKED', attended: true }, 'past').label).toBe('Attended')
    expect(glofoxBookingBadge({ status: 'BOOKED', attended: false }, 'past').label).toBe('No-show')
    expect(glofoxBookingBadge({ status: 'BOOKED' }, 'future').label).toBe('Booked')
    expect(glofoxBookingBadge({ status: 'SOMETHING_ELSE' }, 'past')).toBeNull()
    expect(glofoxBookingBadge({}, 'future')).toBeNull()
  })
})

describe('formatGlofoxBookingTime', () => {
  it('renders an epoch-second start and blanks invalid input', () => {
    // 2026-07-14T07:00:00Z
    const out = formatGlofoxBookingTime(1784012400)
    expect(out).toContain('Jul')
    expect(formatGlofoxBookingTime(null)).toBe('')
    expect(formatGlofoxBookingTime('nope')).toBe('')
  })
})
