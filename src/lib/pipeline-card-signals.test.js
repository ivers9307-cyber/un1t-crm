// HATCHCARD.1 — the per-card signals a un1t.online board shows: classes done,
// credits left, next class, last class, and the last WhatsApp contact.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/paid-trial-products', () => ({ paidTrialProductIdsFor: vi.fn() }))
import { paidTrialProductIdsFor } from '@/lib/paid-trial-products'
import {
  shapeCardSignals, loadUn1tCardSignals, cardSignalsEnabledForModule,
  SIGNAL_SLUGS, LAST_CLASS_WARM_DAYS,
} from './pipeline-card-signals.js'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const DAY = 86_400_000
const ago = (d) => new Date(NOW - d * DAY).toISOString()
const ahead = (d) => new Date(NOW + d * DAY).toISOString()
const LOC = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'

describe('shapeCardSignals (pure)', () => {
  it('nothing known: 0 classes, no credits, no class, never messaged', () => {
    expect(shapeCardSignals({ nowMs: NOW })).toEqual({
      classes_attended: 0,
      credits_left: null,
      credits_unlimited: false,
      next_class_at: null,
      last_class_days: null,
      last_class_warm: false,
      wa_state: 'never',
      wa_days: null,
      trial_kind: null,
      trial_ends_at: null,
      trial_days_left: null,
      trial_ended_days: null,
    })
  })

  // HATCHCARD.2 — the trial window (shapeTrialWindow) becomes days left, or days since it ended.
  it('a live trial: days left (rounded up), the end date kept for the card to print', () => {
    const s = shapeCardSignals({ nowMs: NOW, trialWindow: { kind: 'paid', started_at: ago(1), ends_at: ahead(12.5) } })
    expect(s).toMatchObject({ trial_kind: 'paid', trial_ends_at: ahead(12.5), trial_days_left: 13, trial_ended_days: null })
  })
  it('an ended trial: days since it ended (0 = today), no days left', () => {
    expect(shapeCardSignals({ nowMs: NOW, trialWindow: { kind: 'free', started_at: ago(10), ends_at: ago(3.2) } }))
      .toMatchObject({ trial_kind: 'free', trial_days_left: null, trial_ended_days: 3 })
    expect(shapeCardSignals({ nowMs: NOW, trialWindow: { kind: 'free', started_at: ago(7), ends_at: ago(0.1) } }).trial_ended_days).toBe(0)
  })
  // HATCHCARD.4 — with the studio zone, days are CALENDAR days in that zone,
  // so the count agrees with the date printed beside it.
  it('with the studio zone: calendar days, so "15 Nov" two weeks out reads 13, and later today reads 0', () => {
    const z = 'Europe/Dublin'
    expect(shapeCardSignals({ nowMs: NOW, zone: z, trialWindow: { kind: 'paid', started_at: ago(1), ends_at: '2026-11-15T12:16:53Z' } }).trial_days_left).toBe(13)
    expect(shapeCardSignals({ nowMs: NOW, zone: z, trialWindow: { kind: 'paid', started_at: ago(1), ends_at: '2026-11-02T20:00:00Z' } }).trial_days_left).toBe(0)
    expect(shapeCardSignals({ nowMs: NOW, zone: z, trialWindow: { kind: 'paid', started_at: ago(1), ends_at: '2026-11-03T00:30:00Z' } }).trial_days_left).toBe(1)
  })
  it('with the studio zone: an ended trial counts calendar days since its end date', () => {
    const z = 'Europe/Dublin'
    expect(shapeCardSignals({ nowMs: NOW, zone: z, trialWindow: { kind: 'free', started_at: ago(10), ends_at: '2026-10-30T23:30:00Z' } }).trial_ended_days).toBe(3)
    expect(shapeCardSignals({ nowMs: NOW, zone: z, trialWindow: { kind: 'free', started_at: ago(7), ends_at: '2026-11-02T09:00:00Z' } }).trial_ended_days).toBe(0)
  })
  it('a trial with no known end: the kind only', () => {
    expect(shapeCardSignals({ nowMs: NOW, trialWindow: { kind: 'free', started_at: ago(2), ends_at: null } }))
      .toMatchObject({ trial_kind: 'free', trial_ends_at: null, trial_days_left: null, trial_ended_days: null })
  })

  it('counts ATTENDED (or attended=true) bookings, takes the newest past one as the last class', () => {
    const s = shapeCardSignals({
      nowMs: NOW,
      bookings: [
        { starts_at: ago(9), status: 'ATTENDED', attended: true },
        { starts_at: ago(3), status: 'attended', attended: false },
        { starts_at: ago(5), status: 'NO_SHOW', attended: false },
        { starts_at: ago(2), status: 'CANCELLED', attended: false },
        { starts_at: ago(1), status: 'BOOKED', attended: true },
      ],
    })
    expect(s.classes_attended).toBe(3)
    expect(s.last_class_days).toBe(1)
    expect(s.last_class_warm).toBe(false)
  })

  it('the last class turns warm past the threshold', () => {
    const at = (d) => shapeCardSignals({ nowMs: NOW, bookings: [{ starts_at: ago(d), status: 'ATTENDED' }] })
    expect(at(LAST_CLASS_WARM_DAYS).last_class_warm).toBe(false)
    expect(at(LAST_CLASS_WARM_DAYS + 1).last_class_warm).toBe(true)
  })

  it('the next class is the earliest future BOOKED one; a cancelled or past booking is not', () => {
    const s = shapeCardSignals({
      nowMs: NOW,
      bookings: [
        { starts_at: ahead(4), status: 'BOOKED' },
        { starts_at: ahead(1), status: 'CANCELLED' },
        { starts_at: ahead(2), status: 'BOOKED' },
        { starts_at: ago(1), status: 'BOOKED' },
      ],
    })
    expect(s.next_class_at).toBe(ahead(2))
  })

  it('credits: a number, unlimited, or null when the account is unknown; several accounts sum', () => {
    expect(shapeCardSignals({ nowMs: NOW, clients: [{ credit_balance: 2, credit_unlimited: false }] }))
      .toMatchObject({ credits_left: 2, credits_unlimited: false })
    expect(shapeCardSignals({ nowMs: NOW, clients: [{ credit_balance: 0, credit_unlimited: true }] }))
      .toMatchObject({ credits_left: null, credits_unlimited: true })
    expect(shapeCardSignals({ nowMs: NOW, clients: [{ credit_balance: null, credit_unlimited: false }] }))
      .toMatchObject({ credits_left: null, credits_unlimited: false })
    expect(shapeCardSignals({ nowMs: NOW, clients: [{ credit_balance: 1 }, { credit_balance: 2 }] }).credits_left).toBe(3)
  })

  it('WhatsApp: replied (days since their last message), no reply (days since ours), never', () => {
    expect(shapeCardSignals({ nowMs: NOW, conversations: [{ window_open_at: ago(2), last_message_at: ago(1) }] }))
      .toMatchObject({ wa_state: 'replied', wa_days: 2 })
    expect(shapeCardSignals({ nowMs: NOW, conversations: [{ window_open_at: null, last_message_at: ago(6) }] }))
      .toMatchObject({ wa_state: 'no_reply', wa_days: 6 })
    expect(shapeCardSignals({ nowMs: NOW, conversations: [] })).toMatchObject({ wa_state: 'never', wa_days: null })
  })

  it('WhatsApp across two threads: any reply wins, and the newest reply dates it', () => {
    const s = shapeCardSignals({ nowMs: NOW, conversations: [
      { window_open_at: null, last_message_at: ago(1) },
      { window_open_at: ago(10), last_message_at: ago(10) },
      { window_open_at: ago(4), last_message_at: ago(4) },
    ] })
    expect(s).toMatchObject({ wa_state: 'replied', wa_days: 4 })
  })

  it('an unreadable date is ignored, never a NaN', () => {
    const s = shapeCardSignals({ nowMs: NOW, bookings: [{ starts_at: 'nope', status: 'ATTENDED' }], conversations: [{ window_open_at: 'x', last_message_at: null }] })
    expect(s.classes_attended).toBe(1)
    expect(s.last_class_days).toBeNull()
    expect(s.wa_state).toBe('no_reply')
    expect(s.wa_days).toBeNull()
  })
})

describe('cardSignalsEnabledForModule / SIGNAL_SLUGS', () => {
  it('only a un1t.online board carries signals', () => {
    expect(cardSignalsEnabledForModule('acquisition_un1t')).toBe(true)
    expect(cardSignalsEnabledForModule('paid_trial_un1t')).toBe(true)
    expect(cardSignalsEnabledForModule('acquisition')).toBe(false)
    expect(cardSignalsEnabledForModule('paid_trial')).toBe(false)
    expect(cardSignalsEnabledForModule(null)).toBe(false)
  })
  it('the live funnel columns of both boards, never the piles or Converted', () => {
    for (const s of ['new_lead', 'first_class', 'second_class', 'trial_done', 'paid_trial_new_lead', 'paid_trial_first_class', 'paid_trial_day_7', 'paid_trial_done']) {
      expect(SIGNAL_SLUGS.has(s)).toBe(true)
    }
    for (const s of ['converted', 'paid_trial_converted', 'member', 'pack_member', 'dormant', 'cold_lead']) {
      expect(SIGNAL_SLUGS.has(s)).toBe(false)
    }
  })
})

// A fake service-role client: each table serves its rows filtered by the
// .eq/.in calls the reader makes, honouring .range, and records every call.
function fakeDb(tables, { failOn = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const st = { table, eq: {}, in: {}, range: null, order: [], cols: null }
      const chain = {
        select(cols) { st.cols = cols; return chain },
        eq(c, v) { st.eq[c] = v; return chain },
        in(c, v) { st.in[c] = v; return chain },
        order(c) { st.order.push(c); return chain },
        range(a, b) { st.range = [a, b]; return chain },
        then(res, rej) {
          calls.push(st)
          if (failOn === table) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej)
          let rows = (tables[table] || []).filter((r) => Object.entries(st.eq).every(([c, v]) => r[c] === v)
            && Object.entries(st.in).every(([c, v]) => v.includes(r[c])))
          if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1)
          return Promise.resolve({ data: rows, error: null }).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('loadUn1tCardSignals', () => {
  const OTHER = 'a0000000-0000-0000-0000-000000000001'
  const tables = {
    class_bookings: [
      { id: 'b1', location_id: LOC, contact_id: 'c1', source_platform: 'un1t_online', starts_at: ago(3), status: 'ATTENDED', attended: true },
      { id: 'b2', location_id: LOC, contact_id: 'c1', source_platform: 'un1t_online', starts_at: ahead(1), status: 'BOOKED', attended: false },
      { id: 'b3', location_id: OTHER, contact_id: 'c1', source_platform: 'glofox', starts_at: ago(1), status: 'ATTENDED', attended: true },
      { id: 'b4', location_id: LOC, contact_id: 'c1', source_platform: 'glofox', starts_at: ago(1), status: 'ATTENDED', attended: true },
    ],
    un1t_clients: [
      { location_id: LOC, contact_id: 'c1', credit_balance: 2, credit_unlimited: false },
      { location_id: OTHER, contact_id: 'c2', credit_balance: 9, credit_unlimited: false },
    ],
    whatsapp_conversations: [
      { location_id: LOC, contact_id: 'c1', window_open_at: ago(2), last_message_at: ago(1) },
      { location_id: OTHER, contact_id: 'c2', window_open_at: ago(1), last_message_at: ago(1) },
    ],
    un1t_transactions: [
      { id: 't1', location_id: LOC, contact_id: 'c1', product_id: 'paid-39', amount_cents: 3900, refunded: false, remote_created_at: ago(1), type: 'one_time', product_type: 'pack' },
      { id: 't2', location_id: OTHER, contact_id: 'c2', product_id: 'paid-39', amount_cents: 3900, refunded: false, remote_created_at: ago(1), type: 'one_time', product_type: 'pack' },
    ],
    un1t_products: [
      { location_id: LOC, un1t_id: 'paid-39', type: 'one_time', price_cents: 3900, credits_per_period: -1, title: 'The UN1T Trial', expire_credits_in_days: '14' },
    ],
  }
  beforeEach(() => { paidTrialProductIdsFor.mockReset(); paidTrialProductIdsFor.mockResolvedValue(new Set(['paid-39'])) })

  it('returns a signal for every requested contact, from this studio\'s un1t rows only', async () => {
    const db = fakeDb(tables)
    const { signals, error } = await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ['c1', 'c2'], nowMs: NOW, zone: 'Europe/Dublin' })
    expect(error).toBeUndefined()
    expect(signals.get('c1')).toMatchObject({ classes_attended: 1, credits_left: 2, next_class_at: ahead(1), last_class_days: 3, wa_state: 'replied', wa_days: 2, trial_kind: 'paid', trial_days_left: 13 })
    // c2's rows are all at another studio: nothing known here
    expect(signals.get('c2')).toMatchObject({ classes_attended: 0, credits_left: null, wa_state: 'never', trial_kind: null })
  })

  it('every read is scoped to the studio, names its columns, and orders before it ranges', async () => {
    const db = fakeDb(tables)
    await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ['c1'], nowMs: NOW })
    for (const c of db.calls) {
      expect(c.eq.location_id).toBe(LOC)
      expect(c.cols).not.toMatch(/\*/)
      expect(c.range).not.toBeNull()
      expect(c.order.length).toBeGreaterThan(0)
    }
    expect(db.calls.find((c) => c.table === 'class_bookings').eq.source_platform).toBe('un1t_online')
  })

  it('chunks a long contact list and pages each chunk under the 1,000-row cap', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`)
    const many = { class_bookings: ids.flatMap((id) => [0, 1, 2].map((k) => ({ id: `${id}-${k}`, location_id: LOC, contact_id: id, source_platform: 'un1t_online', starts_at: ago(k + 1), status: 'ATTENDED' }))) }
    const db = fakeDb(many)
    const { signals } = await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ids, nowMs: NOW })
    expect(signals.size).toBe(450)
    expect([...signals.values()].every((s) => s.classes_attended === 3)).toBe(true)
    const bookingCalls = db.calls.filter((c) => c.table === 'class_bookings')
    expect(bookingCalls.every((c) => c.in.contact_id.length <= 200)).toBe(true)
    expect(bookingCalls.every((c) => c.range[1] - c.range[0] + 1 <= 1000)).toBe(true)
  })

  it('a failed read returns { error }, never an empty map that reads as "nothing known"', async () => {
    const db = fakeDb(tables, { failOn: 'un1t_clients' })
    const res = await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ['c1'], nowMs: NOW })
    expect(res.signals).toBeUndefined()
    expect(res.error).toBeTruthy()
  })

  it('no contacts: no reads, an empty map', async () => {
    const db = fakeDb(tables)
    const res = await loadUn1tCardSignals(db, { locationId: LOC, contactIds: [], nowMs: NOW })
    expect(res.signals.size).toBe(0)
    expect(db.calls).toHaveLength(0)
  })
})

describe('loadUn1tCardSignals — the trial window (HATCHCARD.2)', () => {
  beforeEach(() => { paidTrialProductIdsFor.mockReset() })
  it('an unreadable paid-trial product set is { error }, never "no paid trials"', async () => {
    paidTrialProductIdsFor.mockRejectedValue(new Error('settings down'))
    const db = fakeDb({})
    const res = await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ['c1'], nowMs: NOW })
    expect(res.signals).toBeUndefined()
    expect(res.error).toBeTruthy()
  })
  it('reads the studio\'s products once and the contacts\' transactions in chunks, named columns only', async () => {
    paidTrialProductIdsFor.mockResolvedValue(new Set())
    const db = fakeDb({})
    await loadUn1tCardSignals(db, { locationId: LOC, contactIds: ['c1'], nowMs: NOW })
    const products = db.calls.filter((c) => c.table === 'un1t_products')
    const txs = db.calls.filter((c) => c.table === 'un1t_transactions')
    expect(products).toHaveLength(1)
    expect(products[0].cols).toContain('expire_credits_in_days:raw->>expire_credits_in_days')
    expect(txs).toHaveLength(1)
    expect(txs[0].in.contact_id).toEqual(['c1'])
    expect(paidTrialProductIdsFor).toHaveBeenCalledWith(db, LOC)
  })
})
