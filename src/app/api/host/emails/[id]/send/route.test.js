// QSTASH.8 — enqueue-hook contract for POST /api/host/emails/[id]/send.
//
// After the CAS flips the campaign draft→sending AND the fan-out rows
// are enqueued, the route fire-and-forget publishes ONE campaign-level
// kick { campaignId } to QStash so the first chunk goes out in ~seconds
// instead of waiting for the next cron tick (the worker self-chains the
// rest — never a per-recipient publish). Ordering is load-bearing: a
// kick published BEFORE the pending rows land would look "drained" to
// the worker and mis-finalise the campaign, so every early-exit path
// (auth, kill switch, cap, CAS lost, enqueue error) must publish
// NOTHING. The publish must never affect the response: env-gated inside
// publishQueuePush, dedup id DASH-ONLY (QStash 400s on colons — the
// QSTASH.2 lesson), no delay, own try/catch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-campaign-email', () => ({ resolveHostRecipients: vi.fn() }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-kick' }),
  HOST_CAMPAIGNS_WORKER_PATH: '/api/webhooks/qstash/host-campaigns',
}))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

const HOST_ROW = {
  id: HOST_ID,
  sender_domain_verified: true,
  sender_email: 'news@runners.ie',
  sender_name: 'Dublin Runners CC',
  email_daily_send_cap: 2,
  postmark_stream_id: 'colm-events',
}

// ── chainable fake ─────────────────────────────────────────────────
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find((o) => o.method === method)

function routeFor(cfg = {}) {
  return (state) => {
    const first = state.ops[0]
    if (state.table === 'host_campaigns') {
      if (first.method === 'select' && first.args[1]?.head) return { count: cfg.sentToday ?? 0, error: null }
      if (first.method === 'select') return { data: cfg.campaign ?? { id: CAMPAIGN_ID, status: 'draft' }, error: null }
      if (first.method === 'update') return { data: cfg.casRows ?? [{ id: CAMPAIGN_ID }], error: null }
    }
    if (state.table === 'event_hosts') return { data: cfg.host ?? HOST_ROW, error: null }
    if (state.table === 'host_campaign_sends') return { error: cfg.enqueueErr ?? null }
    return {}
  }
}

function makeRequest() {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/send`, { method: 'POST' })
}
const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-kick' })
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
  resolveHostRecipients.mockResolvedValue([
    { contact_id: 'c1', email: 'a@x.ie' },
    { contact_id: 'c2', email: 'b@x.ie' },
  ])
})

describe('POST /api/host/emails/[id]/send — QStash kick', () => {
  it('publishes exactly ONE campaign-level kick after a successful enqueue', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.recipient_count).toBe(2)

    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: CAMPAIGN_ID },
      deduplicationId: `host-campaign-${CAMPAIGN_ID}-kick`,
    })
    // No delay — the first chunk should go out as soon as QStash delivers.
    expect(publishQueuePush.mock.calls[0][0]).not.toHaveProperty('delaySeconds')
  })

  it('uses a DASH-ONLY dedup id (QStash 400s on colons)', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    await POST(makeRequest(), props)
    const [{ deduplicationId }] = publishQueuePush.mock.calls[0]
    expect(deduplicationId).not.toContain(':')
  })

  it('a publish rejection never affects the send response', async () => {
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('publishes nothing when unauthenticated', async () => {
    getCurrentHost.mockResolvedValue(null)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(401)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('publishes nothing when the sender is unverified (kill switch)', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, sender_domain_verified: false } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(409)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('publishes nothing when the draft→sending CAS is lost (double send)', async () => {
    const { db } = makeDb(routeFor({ casRows: [] }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(409)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('publishes nothing on an enqueue failure — the rows are not all in, the cron drains what landed', async () => {
    const { db } = makeDb(routeFor({ enqueueErr: { message: 'insert broke' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(500)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('publishes only after the last enqueue chunk (the kick follows the upsert)', async () => {
    const order = []
    const { db } = makeDb((state) => {
      if (state.table === 'host_campaign_sends') { order.push('upsert'); return { error: null } }
      return routeFor()(state)
    })
    publishQueuePush.mockImplementation(async () => { order.push('publish'); return { ok: true } })
    createServerClient.mockReturnValue(db)
    await POST(makeRequest(), props)
    expect(order).toEqual(['upsert', 'publish'])
  })
})

// HOST-GROWTH.11 — audience_kind drives the recipient resolver: 'mailing_list'
// restricts to source='mailing_list' contacts, 'event' targets the event's
// confirmed attendees, 'all' (incl. legacy rows) targets the whole list.
describe('POST /api/host/emails/[id]/send — audience_kind → resolveHostRecipients', () => {
  it("audience_kind='mailing_list' resolves with mailingListOnly: true and no event", async () => {
    const { db } = makeDb(routeFor({
      campaign: { id: CAMPAIGN_ID, status: 'draft', audience_kind: 'mailing_list', audience_event_id: null, email_type: 'marketing' },
    }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, {
      audienceEventId: null,
      mailingListOnly: true,
      emailType: 'marketing',
    })
  })

  it("audience_kind='event' resolves against the event with mailingListOnly: false", async () => {
    const { db } = makeDb(routeFor({
      campaign: { id: CAMPAIGN_ID, status: 'draft', audience_kind: 'event', audience_event_id: 'ev-1', email_type: 'marketing' },
    }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, {
      audienceEventId: 'ev-1',
      mailingListOnly: false,
      emailType: 'marketing',
    })
  })

  it("legacy row: audience_kind='all' WITH an event id (pre-460 writer) still targets the event", async () => {
    // Rows created/patched by pre-audience_kind code get the column default
    // 'all' while carrying audience_event_id — the pre-460 semantic (event id
    // = per-event audience) must win, or the draft sends to the WHOLE list.
    const { db } = makeDb(routeFor({
      campaign: { id: CAMPAIGN_ID, status: 'draft', audience_kind: 'all', audience_event_id: 'ev-legacy', email_type: 'marketing' },
    }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, {
      audienceEventId: 'ev-legacy',
      mailingListOnly: false,
      emailType: 'marketing',
    })
  })

  it("audience_kind='all' (legacy-shaped row) resolves the whole list", async () => {
    const { db } = makeDb(routeFor({
      campaign: { id: CAMPAIGN_ID, status: 'draft', audience_kind: 'all', audience_event_id: null, email_type: 'marketing' },
    }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, {
      audienceEventId: null,
      mailingListOnly: false,
      emailType: 'marketing',
    })
  })
})

describe('POST /api/host/emails/[id]/send — HOST-CONSENT.1 stream gate', () => {
  it('409s a marketing send when the host has no postmark_stream_id and publishes nothing', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not set up/i)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
  it('treats a campaign with no email_type as marketing (legacy rows) and gates it too', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft' } }))
    createServerClient.mockReturnValue(db)
    expect((await POST(makeRequest(), props)).status).toBe(409)
  })
  it('lets a UTILITY send through without a stream', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
  })
})
