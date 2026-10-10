import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/strava-import', () => ({ loadStravaConfig: vi.fn(), ingestActivity: vi.fn() }))
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, checkRateLimit: vi.fn() }
})
import { GET, POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { loadStravaConfig, ingestActivity } from '@/lib/strava-import'
import { checkRateLimit } from '@/lib/rate-limit'

const TOKEN = 'tok123'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = 'vtok'
  process.env.STRAVA_WEBHOOK_URL_TOKEN = TOKEN
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date(), retryAfterSec: 1 })
})

function req(url, body) {
  return { url, headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }), json: async () => body }
}
const props = (token) => ({ params: Promise.resolve({ token }) })

// db where the connection lookup resolves to `connection`. The lookup chains
// .eq().eq().is().order().limit().maybeSingle() — order+limit make it resilient
// to stray duplicate active rows (mig 312 defence-in-depth). `from` is a spy so
// a test can assert that NO read happened.
function db(connection) {
  const tail = { maybeSingle: async () => ({ data: connection }) }
  const from = vi.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ order: () => ({ limit: () => tail }) }) }) }) }) }))
  return { from }
}

describe('GET handshake', () => {
  it('echoes challenge when path token + verify_token match', async () => {
    const res = await GET(req(`https://x/api/webhooks/strava/${TOKEN}?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=abc`), props(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'hub.challenge': 'abc' })
  })
  it('403 on verify_token mismatch', async () => {
    const res = await GET(req(`https://x/api/webhooks/strava/${TOKEN}?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=abc`), props(TOKEN))
    expect(res.status).toBe(403)
  })
  it('403 on wrong path token even with the right verify_token', async () => {
    const res = await GET(req('https://x/api/webhooks/strava/wrong?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=abc'), props('wrong'))
    expect(res.status).toBe(403)
  })
})

describe('POST token gate', () => {
  it('wrong path token → 404 and no db client, no rate-limit call', async () => {
    const res = await POST(req('https://x/api/webhooks/strava/wrong', { object_type: 'activity', aspect_type: 'create', object_id: 1, owner_id: 5 }), props('wrong'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false })
    expect(createServerClient).not.toHaveBeenCalled()
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(ingestActivity).not.toHaveBeenCalled()
  })
  it('env unset → 404 (fails closed) even when the path token is empty', async () => {
    delete process.env.STRAVA_WEBHOOK_URL_TOKEN
    const res = await POST(req('https://x/api/webhooks/strava/', { object_type: 'activity', aspect_type: 'create', object_id: 1, owner_id: 5 }), props(''))
    expect(res.status).toBe(404)
    expect(createServerClient).not.toHaveBeenCalled()
  })
  it('rate-limited → 429 before any db read', async () => {
    const fake = db({ id: 'conn', contact_id: 'c1', external_athlete_id: '999' })
    createServerClient.mockReturnValue(fake)
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000), retryAfterSec: 30 })
    const res = await POST(req(`https://x/api/webhooks/strava/${TOKEN}`, { object_type: 'activity', aspect_type: 'create', object_id: 123, owner_id: 999 }), props(TOKEN))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(fake, 'strava-webhook:203.0.113.9', { max: 120, windowMs: 60_000 })
    expect(fake.from).not.toHaveBeenCalled()
    expect(ingestActivity).not.toHaveBeenCalled()
  })
})

describe('POST events', () => {
  it('create → ingestActivity for the matched member', async () => {
    createServerClient.mockReturnValue(db({ id: 'conn', contact_id: 'c1', external_athlete_id: '999' }))
    loadStravaConfig.mockResolvedValue({ clientId: 'a', clientSecret: 'b' })
    ingestActivity.mockResolvedValue({ ingested: '123' })
    const res = await POST(req(`https://x/api/webhooks/strava/${TOKEN}`, { object_type: 'activity', aspect_type: 'create', object_id: 123, owner_id: 999 }), props(TOKEN))
    expect(res.status).toBe(200)
    expect(ingestActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ activityId: 123 }))
  })
  it('unknown athlete → 200 { skipped: unknown_athlete }, no ingest', async () => {
    createServerClient.mockReturnValue(db(null))
    const res = await POST(req(`https://x/api/webhooks/strava/${TOKEN}`, { object_type: 'activity', aspect_type: 'create', object_id: 1, owner_id: 5 }), props(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, skipped: 'unknown_athlete' })
    expect(ingestActivity).not.toHaveBeenCalled()
  })
  it('non-activity object → ignored', async () => {
    const res = await POST(req(`https://x/api/webhooks/strava/${TOKEN}`, { object_type: 'athlete', aspect_type: 'update', object_id: 1, owner_id: 5 }), props(TOKEN))
    expect(res.status).toBe(200)
    expect(ingestActivity).not.toHaveBeenCalled()
  })
})
