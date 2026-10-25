// BOOKINGOUTCOME.1 — the Needs outcome tab's controls.
//   BookingOutcomeButtons: Showed / No-show on one row, through
//     POST /api/bookings/[id]/status.
//   BookingOutcomeBulk: "Mark all as showed", confirmed first, through
//     POST /api/bookings/outcomes in batches of the route's 200.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import BookingOutcomeButtons, { postBookingStatus } from './BookingOutcomeButtons.jsx'
import BookingOutcomeBulk, { markAllOutcomes, OUTCOME_BATCH } from './BookingOutcomeBulk.jsx'

const answer = (status, body) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))

describe('BookingOutcomeButtons', () => {
  it('renders Showed and No-show as type="button" (never a stray submit)', () => {
    const html = renderToStaticMarkup(<BookingOutcomeButtons bookingId="b1" />)
    expect(html).toContain('>Showed<')
    expect(html).toContain('>No-show<')
    expect(html.match(/<button[^>]*type="button"/g)).toHaveLength(2)
  })

  it('posts the status to the single-booking route', async () => {
    const f = answer(200, { success: true, data: { id: 'b1', status: 'completed' } })
    expect(await postBookingStatus('b1', 'completed', f)).toEqual({ ok: true })
    expect(f).toHaveBeenCalledWith('/api/bookings/b1/status', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ status: 'completed' }),
    }))
  })

  it("a refusal carries the route's words; a network failure a plain message", async () => {
    expect(await postBookingStatus('b1', 'no_show', answer(409, { success: false, error: 'The booking changed while you were looking at it.' })))
      .toEqual({ ok: false, error: 'The booking changed while you were looking at it.' })
    const boom = vi.fn(async () => { throw new Error('offline') })
    expect((await postBookingStatus('b1', 'no_show', boom)).ok).toBe(false)
  })
})

describe('BookingOutcomeBulk', () => {
  it('renders the action as a typed button, and nothing for an empty list', () => {
    const html = renderToStaticMarkup(<BookingOutcomeBulk bookingIds={['a', 'b']} />)
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Mark all as showed<\/button>/)
    expect(renderToStaticMarkup(<BookingOutcomeBulk bookingIds={[]} />)).toBe('')
  })

  it('sends batches of 200 and adds up the results', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`)
    const f = vi.fn(async (_url, init) => {
      const { booking_ids } = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ success: true, data: { updated: booking_ids.slice(1), skipped: [{ id: booking_ids[0], reason: 'changed' }] } }) }
    })
    expect(await markAllOutcomes(ids, 'completed', f)).toEqual({ updated: 447, skipped: 3, error: null })
    expect(f.mock.calls.map(([, init]) => JSON.parse(init.body).booking_ids.length)).toEqual([OUTCOME_BATCH, OUTCOME_BATCH, 50])
    expect(f.mock.calls.every(([url, init]) => url === '/api/bookings/outcomes' && JSON.parse(init.body).status === 'completed')).toBe(true)
  })

  it('stops at the first failed batch and reports what was saved before it', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    let n = 0
    const f = vi.fn(async (_url, init) => {
      n += 1
      if (n === 2) return { ok: false, status: 500, json: async () => ({ success: false, error: 'Could not save the outcomes.' }) }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { updated: JSON.parse(init.body).booking_ids, skipped: [] } }) }
    })
    expect(await markAllOutcomes(ids, 'completed', f)).toEqual({ updated: 200, skipped: 0, error: 'Could not save the outcomes.' })
  })
})
