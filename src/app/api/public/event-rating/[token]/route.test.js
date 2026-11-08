// HOSTPAGE.2 — /api/public/event-rating/[token]: the token is the credential;
// one rating per entry; hosts' live events only; 404 on every failure.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let reg
let existing
let insertAnswer
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

process.env.SUPABASE_SERVICE_ROLE_KEY = 's3cret'
const { GET, POST } = await import('./route.js')
const { signRatingToken } = await import('@/lib/event-ratings')

const R = '80000000-0000-4000-8000-000000000001'
const E = 'e0000000-0000-4000-8000-0000000000e1'
const token = (over = {}) => signRatingToken({ registrationId: R, eventId: E, ...over }, 's3cret')
const REG = { id: R, status: 'confirmed', race_event_id: E, contact_id: 'c1', race: { id: E, name: 'Mobility', race_date: '2026-07-18', host_id: 'h1', active: true, host: { name: 'Acme' } } }
const get = (t = token()) => GET(new Request(`https://un1t.repset.ie/api/public/event-rating/${t}`), { params: Promise.resolve({ token: t }) })
const post = (body, t = token()) => POST(new Request(`https://un1t.repset.ie/api/public/event-rating/${t}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ token: t }) })
const inserted = () => db.queries.find((q) => q.table === 'event_ratings' && q.action === 'insert')

beforeEach(() => {
  vi.clearAllMocks()
  reg = REG; existing = null; insertAnswer = () => ({ data: { id: 'rt1', rating: 4, comment: 'Good' }, error: null })
  db = fakeDb((q) => {
    if (q.table === 'race_registrations') return { data: reg, error: null }
    if (q.table === 'event_ratings') return q.action === 'insert' ? insertAnswer(q) : { data: existing, error: null }
    return { data: null, error: null }
  })
})

describe('GET', () => {
  it('answers the event and no existing rating for a fresh link', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ event: { name: 'Mobility', date_label: 'Saturday 18 July 2026', host_name: 'Acme' }, existing: null })
  })
  it('answers what was given when already rated', async () => {
    existing = { rating: 5, comment: 'Loved it' }
    expect((await (await get()).json()).data.existing).toEqual({ rating: 5, comment: 'Loved it' })
  })
  it('404 for a bad token, a token whose event does not match the entry, a UN1T event, an inactive event, a missing entry', async () => {
    expect((await get('nope')).status).toBe(404)
    expect((await get(token({ eventId: 'e0000000-0000-4000-8000-0000000000e2' }))).status).toBe(404)
    reg = { ...REG, race: { ...REG.race, host_id: null } }
    expect((await get()).status).toBe(404)
    reg = { ...REG, race: { ...REG.race, active: false } }
    expect((await get()).status).toBe(404)
    reg = null
    expect((await get()).status).toBe(404)
  })
})

describe('POST', () => {
  it('stores one rating for the entry with the host and contact, and answers it', async () => {
    const res = await post({ rating: 4, comment: '  Good  ' })
    expect(res.status).toBe(200)
    expect(inserted().payload).toEqual({ race_event_id: E, registration_id: R, host_id: 'h1', contact_id: 'c1', rating: 4, comment: 'Good' })
    expect((await res.json()).data).toEqual({ rating: 4, comment: 'Good' })
  })
  it('an empty comment is stored as null', async () => {
    await post({ rating: 5, comment: '   ' })
    expect(inserted().payload.comment).toBeNull()
  })
  it('a second rating is 409 already_rated', async () => {
    insertAnswer = () => ({ data: null, error: { code: '23505' } })
    const res = await post({ rating: 3 })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('already_rated')
  })
  it('400 for a rating outside 1–5 or a 601-char comment; 404 for a bad token', async () => {
    expect((await post({ rating: 6 })).status).toBe(400)
    expect((await post({ rating: 0 })).status).toBe(400)
    expect((await post({ rating: 5, comment: 'x'.repeat(601) })).status).toBe(400)
    expect((await post({ rating: 5 }, 'nope')).status).toBe(404)
    expect(inserted()).toBeUndefined()
  })
})
