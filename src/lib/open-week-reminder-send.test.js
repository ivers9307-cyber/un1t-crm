// OPENWEEK.7 — the open week reminder run: who is reminded, once, and when not.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

const m = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: m.send }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { runOpenWeekReminders, REMINDER_TYPE } from './open-week-reminder-send'

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const NOW = new Date('2026-11-23T18:05:00Z') // Monday evening: Tuesday's morning classes are due
const promo = (over = {}) => ({
  id: 'p1', location_id: HATCH, key: 'hatch-open-week', name: 'Open Week (Hatch Street)', platform: 'un1t_online', credits: 5, expires_in_days: 14,
  live: true, tag: 't', lead_source: 'corp_promo', kind: 'open_week', window_starts_on: '2026-11-23', window_ends_on: '2026-11-29', max_classes: 5, max_per_day: 1, ...over,
})
const booking = (id, contact, startsAt, over = {}) => ({ id, location_id: HATCH, contact_id: contact, class_name: 'FORCE', starts_at: startsAt, status: 'BOOKED', source_platform: 'un1t_online', ...over })
function seed(extra = {}) {
  return createFakeDb({
    tables: {
      corp_promos: [promo()],
      locations: [{ id: HATCH, name: 'UN1T Hatch Street', timezone: 'Europe/Dublin' }],
      corp_promo_claims: [
        { id: 'c1', location_id: HATCH, contact_id: 'k1', promo_key: 'hatch-open-week', status: 'granted' },
        { id: 'c2', location_id: HATCH, contact_id: 'k2', promo_key: 'hatch-open-week', status: 'ineligible' },
      ],
      contacts: [
        { id: 'k1', first_name: 'Aoife', name: 'Aoife Byrne', phone: '0871234567', wa_phone: '353871234567' },
        { id: 'k2', first_name: 'Ben', name: 'Ben Ryan', phone: '0870000000', wa_phone: '353870000000' },
      ],
      class_bookings: [
        booking('b1', 'k1', '2026-11-24T07:00:00Z'), // Tue morning: due at 18:00 Mon
        booking('b2', 'k1', '2026-11-24T18:00:00Z'), // Tue evening: due 09:00 Tue
        booking('b3', 'k1', '2026-11-25T07:00:00Z', { status: 'CANCELLED' }),
        booking('b4', 'k2', '2026-11-24T07:00:00Z'), // not a granted claimant
        booking('b5', 'k1', '2026-12-01T07:00:00Z'), // outside the week
      ],
      customer_engagement_nudges: [],
      ...extra,
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  m.send.mockResolvedValue({ sent: true, messageId: 'wamid.1' })
})

describe('runOpenWeekReminders', () => {
  it('reminds a granted claimant of a booked open week class that is due, with the template values', async () => {
    const db = seed()
    const out = await runOpenWeekReminders(db, { now: NOW })
    expect(m.send).toHaveBeenCalledTimes(1)
    expect(m.send.mock.calls[0][0]).toMatchObject({
      locationId: HATCH, purpose: 'class_reminder', contact: expect.objectContaining({ id: 'k1' }),
      bodyParams: ['Aoife', 'tomorrow', '07:00', 'FORCE', 'UN1T Hatch Street'],
    })
    expect(out).toMatchObject({ ok: true, sent: 1 })
    expect(db.tables.customer_engagement_nudges).toEqual([expect.objectContaining({ contact_id: 'k1', type: REMINDER_TYPE, dedup_key: 'cb:b1' })])
  })

  it('never twice for the same booking', async () => {
    const db = seed()
    await runOpenWeekReminders(db, { now: NOW })
    await runOpenWeekReminders(db, { now: new Date('2026-11-23T18:20:00Z') })
    expect(m.send).toHaveBeenCalledTimes(1)
  })

  it('a failed send releases the claim so the next run retries it', async () => {
    m.send.mockResolvedValueOnce({ sent: false, reason: 'send_failed' })
    const db = seed()
    const out = await runOpenWeekReminders(db, { now: NOW })
    expect(out.retry).toBe(1)
    expect(db.tables.customer_engagement_nudges).toEqual([])
    await runOpenWeekReminders(db, { now: new Date('2026-11-23T18:20:00Z') })
    expect(m.send).toHaveBeenCalledTimes(2)
  })

  it('a person who opted out of admin WhatsApp is skipped, for good', async () => {
    const db = seed({ contact_preferences: [{ contact_id: 'k1', whatsapp_administrative: false }] })
    const out = await runOpenWeekReminders(db, { now: NOW })
    expect(m.send).not.toHaveBeenCalled()
    expect(out.suppressed).toBe(1)
    expect(db.tables.customer_engagement_nudges).toHaveLength(1)
  })

  it('a switched-off or ended open week sends nothing', async () => {
    expect((await runOpenWeekReminders(seed({ corp_promos: [promo({ live: false })] }), { now: NOW })).sent).toBe(0)
    expect((await runOpenWeekReminders(seed(), { now: new Date('2026-11-30T09:00:00Z') })).sent).toBe(0)
    expect(m.send).not.toHaveBeenCalled()
  })

  it('a failed read of the claimants is a failed run, nothing sent', async () => {
    const db = seed()
    db.errors = { ...(db.errors || {}), corp_promo_claims: { select: { message: 'down' } } }
    const out = await runOpenWeekReminders(createFakeDb({ tables: db.tables, errors: { corp_promo_claims: { select: { message: 'down' } } } }), { now: NOW })
    expect(out.ok).toBe(false)
    expect(m.send).not.toHaveBeenCalled()
  })
})
