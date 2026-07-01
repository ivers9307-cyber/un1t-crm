import { describe, it, expect, vi } from 'vitest'
import { handleDataExchange, parseFlowCompletion } from './handler.js'
import { SCREEN } from './screens.js'

vi.mock('@/lib/booking-slots.js', () => ({
  computeAvailableDays: vi.fn(async () => [{ id: '2026-07-03', title: 'Thu 3 Jul' }]),
  computeAvailableSlots: vi.fn(async () => [{ start: '18:00', end: '18:30' }]),
}))
vi.mock('@/lib/public-classes.js', () => ({
  listPublicClasses: vi.fn(async () => ([{ event_id: 'c1', name: 'HIIT', starts_at: '2026-07-03T18:00:00Z', spots_left: 4 }])),
}))

const config = { consult_event_slug: 'free-un1t-consultation' }
const contact = { id: 'ct1', name: 'Ann', email: 'ann@x.ie' }

describe('handleDataExchange', () => {
  it('INIT returns the PATH screen', async () => {
    const res = await handleDataExchange({}, { decryptedBody: { action: 'INIT' }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.PATH)
  })

  it('choosing a path returns DAY with available days', async () => {
    const res = await handleDataExchange({}, {
      decryptedBody: { action: 'data_exchange', screen: SCREEN.PATH, data: { path: 'class' } },
      contact, locationId: 'loc1', config,
    })
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.days[0].id).toBe('2026-07-03')
  })

  it('picking a class day returns SLOT with live classes', async () => {
    const res = await handleDataExchange({}, {
      decryptedBody: { action: 'data_exchange', screen: SCREEN.DAY, data: { path: 'class', day: '2026-07-03' } },
      contact, locationId: 'loc1', config,
    })
    expect(res.screen).toBe(SCREEN.SLOT)
    expect(res.data.slots[0].id).toBe('c1')
  })

  it('ping short-circuits to the health response', async () => {
    const res = await handleDataExchange({}, { decryptedBody: { action: 'ping' }, contact, locationId: 'loc1', config })
    expect(res).toEqual({ data: { status: 'active' } })
  })
})

describe('parseFlowCompletion', () => {
  it('extracts path + selection + contact fields from nfm_reply', () => {
    const interactive = { type: 'nfm_reply', nfm_reply: { response_json: JSON.stringify({
      path: 'class', slot: 'c1', class_name: 'HIIT', starts_at: '2026-07-03T18:00:00Z',
      name: 'Ann', email: 'ann@x.ie', marketing_opt_in: true,
    }) } }
    const out = parseFlowCompletion(interactive)
    expect(out.path).toBe('class')
    expect(out.selection.slot).toBe('c1')
    expect(out.contactFields.email).toBe('ann@x.ie')
    expect(out.contactFields.marketing_opt_in).toBe(true)
  })

  it('returns null for a non-Flow interactive', () => {
    expect(parseFlowCompletion({ type: 'button_reply' })).toBeNull()
  })
})
