// ICSFEED.1 — the wire contract of the three calendar-link calls.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn(() => Promise.resolve({ success: true, data: {} })) }))

const { api } = await import('./api')
const feed = await import('./calendar-feed-api')

beforeEach(() => { api.mockClear() })

describe('calendar-feed-api', () => {
  it('exports exactly these helpers', () => {
    expect(Object.keys(feed).sort()).toEqual(['createMyCalendarFeed', 'getMyCalendarFeed', 'turnOffMyCalendarFeed'])
  })
  it('getMyCalendarFeed GETs the caller\'s own status (no id: there is none to send)', () => {
    feed.getMyCalendarFeed()
    expect(api).toHaveBeenCalledWith('/api/me/calendar-feed')
  })
  it('createMyCalendarFeed POSTs replace as a strict boolean', () => {
    feed.createMyCalendarFeed()
    expect(api).toHaveBeenLastCalledWith('/api/me/calendar-feed', { method: 'POST', body: { replace: false } })
    feed.createMyCalendarFeed({ replace: true })
    expect(api).toHaveBeenLastCalledWith('/api/me/calendar-feed', { method: 'POST', body: { replace: true } })
  })
  it('turnOffMyCalendarFeed DELETEs', () => {
    feed.turnOffMyCalendarFeed()
    expect(api).toHaveBeenCalledWith('/api/me/calendar-feed', { method: 'DELETE' })
  })
})
