import { describe, it, expect, vi } from 'vitest'
import { handleDataExchange, parseFlowCompletion } from './handler.js'
import { SCREEN } from './screens.js'

// REAL shapes: computeAvailableDays → [{date,label}]; computeAvailableSlots → [{start,end}]
vi.mock('@/lib/booking-slots.js', () => ({
  computeAvailableDays: vi.fn(async () => [{ date: '2026-07-03', label: 'Thu 3 Jul' }]),
  computeAvailableSlots: vi.fn(async () => [{ start: '18:00', end: '18:30' }]),
}))
vi.mock('@/lib/public-classes.js', () => ({
  listPublicClasses: vi.fn(async () => ([{ event_id: 'c1', name: 'HIIT', starts_at: '2026-07-03T18:00:00Z', spots_left: 4 }])),
}))

const config = { consult_event_slug: 'free-un1t-consultation' }
const contact = { id: 'ct1', name: 'Ann', email: 'ann@x.ie' }
const eventRow = { id: 'ev1', availability: { Fri: {} }, max_advance_days: 14, duration_minutes: 30, buffer_minutes: 0 }
const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: eventRow }) }
const db = { from: () => chain }

describe('handleDataExchange', () => {
  it('INIT returns the PATH screen', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'INIT' }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.PATH)
  })

  it('ping short-circuits to the health response', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'ping' }, contact, locationId: 'loc1', config })
    expect(res).toEqual({ data: { status: 'active' } })
  })

  it('class PATH returns DAY with {id,title} days and threads path', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.PATH, data: { path: 'class' } }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.days[0]).toEqual({ id: '2026-07-03', title: expect.any(String) })
    expect(res.data.path).toBe('class')
  })

  it('consult PATH maps computeAvailableDays {date,label} → {id,title}', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.PATH, data: { path: 'consult' } }, contact, locationId: 'loc1', config })
    expect(res.data.days).toEqual([{ id: '2026-07-03', title: 'Thu 3 Jul' }])
    expect(res.data.path).toBe('consult')
  })

  it('class DAY returns SLOT with slot id `event|starts_at|name` and threads path', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day: '2026-07-03' } }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.SLOT)
    expect(res.data.slots[0].id).toBe('c1|2026-07-03T18:00:00Z|HIIT')
    expect(res.data.path).toBe('class')
  })

  it('consult DAY returns SLOT with slot id `event|date|start|end`', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'consult', day: '2026-07-03' } }, contact, locationId: 'loc1', config })
    expect(res.data.slots[0].id).toBe('ev1|2026-07-03|18:00|18:30')
  })

  it('SLOT returns DETAILS prefilled and carries path + slot', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.SLOT, data: { path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT' } }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.DETAILS)
    expect(res.data.name).toBe('Ann')
    expect(res.data.path).toBe('class')
    expect(res.data.slot).toBe('c1|2026-07-03T18:00:00Z|HIIT')
  })

  it('DETAILS returns CONFIRM with a flat selection object', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'data_exchange', screen: SCREEN.DETAILS, data: { path: 'class', slot: 'c1|x|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true } }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.CONFIRM)
    expect(res.data.selection).toEqual({ path: 'class', slot: 'c1|x|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true })
  })
})

describe('parseFlowCompletion', () => {
  it('extracts path + slot + contactFields from a flat nfm_reply', () => {
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({ path: 'class', slot: 'c1|2026-07-03T18:00:00Z|HIIT', name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true }) } }
    const out = parseFlowCompletion(interactive)
    expect(out.path).toBe('class')
    expect(out.selection.slot).toBe('c1|2026-07-03T18:00:00Z|HIIT')
    expect(out.contactFields).toEqual({ name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true })
  })

  it('returns null for a non-Flow interactive', () => {
    expect(parseFlowCompletion({ type: 'button_reply' })).toBeNull()
  })
})
