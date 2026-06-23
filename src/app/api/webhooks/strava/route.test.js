import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/strava-import', () => ({ loadStravaConfig: vi.fn(), ingestActivity: vi.fn() }))
import { GET, POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { loadStravaConfig, ingestActivity } from '@/lib/strava-import'

beforeEach(() => { vi.clearAllMocks(); process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = 'vtok' })

function req(url, body) {
  return { url, json: async () => body }
}
// db where the connection lookup resolves to `connection`
function db(connection) {
  return { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: connection }) }) }) }) }) }) }
}

describe('GET handshake', () => {
  it('echoes challenge when verify_token matches', async () => {
    const res = await GET(req('https://x/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=abc'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'hub.challenge': 'abc' })
  })
  it('403 on token mismatch', async () => {
    const res = await GET(req('https://x/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=abc'))
    expect(res.status).toBe(403)
  })
})

describe('POST events', () => {
  it('create → ingestActivity for the matched member', async () => {
    createServerClient.mockReturnValue(db({ id: 'conn', contact_id: 'c1', external_athlete_id: '999' }))
    loadStravaConfig.mockResolvedValue({ clientId: 'a', clientSecret: 'b' })
    ingestActivity.mockResolvedValue({ ingested: '123' })
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'activity', aspect_type: 'create', object_id: 123, owner_id: 999 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ activityId: 123 }))
  })
  it('unknown athlete → 200, no ingest', async () => {
    createServerClient.mockReturnValue(db(null))
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'activity', aspect_type: 'create', object_id: 1, owner_id: 5 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).not.toHaveBeenCalled()
  })
  it('non-activity object → ignored', async () => {
    const res = await POST(req('https://x/api/webhooks/strava', { object_type: 'athlete', aspect_type: 'update', object_id: 1, owner_id: 5 }))
    expect(res.status).toBe(200)
    expect(ingestActivity).not.toHaveBeenCalled()
  })
})
