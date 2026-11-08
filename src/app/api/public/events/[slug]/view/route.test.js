// HOSTSTATS.1 — POST /api/public/events/[slug]/view: the signup page's
// page-view beacon. One row per (event, session, day in the studio's zone);
// a repeat is not counted; a draft is 404; telemetry never 5xxs the visitor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let race
let insertAnswer
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { POST } = await import('./route.js')
const { logWarn } = await import('@/lib/log')

const HC = '80000000-0000-4000-8000-000000000001'
const RACE = { id: 'e1', active: true, status: 'published', host_id: null, location_id: 'L1', locations: { timezone: 'Europe/Dublin' } }
const post = (body) => POST(
  new Request('https://un1t.repset.ie/api/public/events/mob/view', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'mob' }) },
)
const inserted = () => db.queries.find((q) => q.table === 'event_page_views' && q.action === 'insert')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-18T23:30:00Z'))
  race = RACE
  insertAnswer = { data: null, error: null }
  db = fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'host_campaigns') return { data: q.ops.some((o) => o[0] === 'eq' && o[1] === 'host_id' && o[2] === 'h1') ? { id: HC } : null, error: null }
    if (q.table === 'event_page_views') return insertAnswer
    return { data: null, error: null }
  })
})
afterEach(() => vi.useRealTimers())

describe('POST /api/public/events/[slug]/view', () => {
  it('records the view with the derived source and the day on the studio clock, not UTC', async () => {
    const res = await post({ session_id: 'sess-000001', attribution: { session_id: 'sess-000001', utm_source: 'Instagram', utm_campaign: 'nov', referrer: 'https://l.instagram.com/' } })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ recorded: true })
    expect(inserted().payload).toEqual({
      race_event_id: 'e1', session_id: 'sess-000001', source: 'instagram', utm_campaign: 'nov', utm_content: null, referrer_host: 'l.instagram.com',
      day: '2026-07-19', // 23:30Z on the 18th is 00:30 Irish Summer Time on the 19th
    })
  })
  it('a view without attribution is direct', async () => {
    await post({ session_id: 'sess-000001' })
    expect(inserted().payload).toMatchObject({ source: 'direct', utm_campaign: null, referrer_host: null })
  })
  it('a host campaign link is host_email when the campaign is the event host\'s; otherwise it falls through', async () => {
    race = { ...RACE, host_id: 'h1' }
    await post({ session_id: 'sess-000001', attribution: { hc: HC, utm_source: 'instagram' } })
    expect(inserted().payload.source).toBe('host_email')
    race = { ...RACE, host_id: 'h2' }
    db = fakeDb((q) => {
      if (q.table === 'race_events') return { data: race, error: null }
      if (q.table === 'host_campaigns') return { data: null, error: null }
      return { data: null, error: null }
    })
    await post({ session_id: 'sess-000001', attribution: { hc: HC, utm_source: 'instagram' } })
    expect(inserted().payload.source).toBe('instagram')
  })
  it('the same session on the same day is not counted twice, and still answers 200', async () => {
    insertAnswer = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const res = await post({ session_id: 'sess-000001' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ recorded: false })
    expect(logWarn).not.toHaveBeenCalled()
  })
  it('another insert error is logged and still answers 200 recorded:false', async () => {
    insertAnswer = { data: null, error: { code: '42P01', message: 'boom' } }
    const res = await post({ session_id: 'sess-000001' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ recorded: false })
    expect(logWarn).toHaveBeenCalled()
  })
  it('404 for a draft event and for an unknown slug; nothing is inserted', async () => {
    race = { ...RACE, status: 'draft' }
    expect((await post({ session_id: 'sess-000001' })).status).toBe(404)
    race = null
    expect((await post({ session_id: 'sess-000001' })).status).toBe(404)
    expect(inserted()).toBeUndefined()
  })
  it('400 for a bad session id', async () => {
    expect((await post({ session_id: 'short' })).status).toBe(400)
    expect((await post({ session_id: 'has space in it' })).status).toBe(400)
    expect(inserted()).toBeUndefined()
  })
})
