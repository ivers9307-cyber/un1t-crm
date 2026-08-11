// CAMPHIST.1 — duplicate is the reuse path that `?edit=1` was being abused as.
//
// The send route has told operators to "clone the campaign if they want to
// send it again" since CAMPAIGN.13, for a capability that did not exist. The
// only reuse path that DID exist was editing the sent campaign in place, which
// leaves its recipients, opens, clicks and monthly rollups describing an email
// that was never sent.
//
// The clone therefore has to take the creative and NOTHING else: no recipient
// rows, no counters, no send timestamps, no A/B or resend state.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn(() => true) }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { POST } from './route'

const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555'
const LOC = 'aaaaaaaa-2222-4333-8444-555555555555'

const SENT = {
  id: CAMPAIGN_ID,
  location_id: LOC,
  name: 'August lock-in sale',
  subject: 'Last chance',
  preview_text: 'Ends Monday',
  from_name: 'UN1T', from_email: 'hi@un1t.com', reply_to: 'stillorgan@un1t.com',
  design_json: { body: { rows: [1, 2, 3] } },
  html_content: '<html><body>Hi {{first_name}}</body></html>',
  audience_filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'is', value: 'member' }] },
  template_id: 'tpl-1',
  postmark_stream: 'broadcast',
  status: 'sent',
  sent_at: '2026-08-08T10:00:00Z',
  send_started_at: '2026-08-08T09:59:00Z',
  scheduled_at: '2026-08-08T09:00:00Z',
  total_recipients: 2059, total_sent: 2059, total_delivered: 1980,
  total_opened: 640, total_clicked: 88, total_bounced: 12,
  total_complained: 1, total_unsubscribed: 9,
  ab_subject_b: 'Last chance (B)', ab_test_pct: 20, ab_wait_hours: 6,
  ab_winner: 'a', ab_test_started_at: '2026-08-08T10:00:00Z', ab_decided_at: '2026-08-08T16:00:00Z',
  parent_campaign_id: null,
  resend_enabled: true, resend_wait_hours: 48, resend_subject: 'Still time',
  cancel_requested_at: null, last_error: null,
  created_by: 'user-original',
  created_at: '2026-08-01T00:00:00Z',
}

function makeDb(campaign, { insertError = null } = {}) {
  const inserts = []
  const db = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        single: async () => (
          table === 'campaigns' && inserts.length === 0
            ? (campaign ? { data: campaign, error: null } : { data: null, error: { message: 'no rows' } })
            : { data: { ...inserts[inserts.length - 1], id: 'new-campaign-id' }, error: insertError }
        ),
        insert(row) { inserts.push(row); return api },
      }
      return api
    },
  }
  return { db, inserts }
}

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
const req = () => new Request('https://crm.example/api/campaigns/x/duplicate', { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'user-2', activeLocation: { id: LOC } })
  assertLocationAccessOr404.mockReturnValue(null)
  hasPermissionForLocation.mockReturnValue(true)
})

describe('the clone copies the creative', () => {
  it('carries subject, body, design and audience across verbatim', async () => {
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)

    const res = await POST(req(), props)
    expect(res.status).toBe(200)

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      subject: SENT.subject,
      preview_text: SENT.preview_text,
      html_content: SENT.html_content,
      design_json: SENT.design_json,
      audience_filter: SENT.audience_filter,
      from_name: SENT.from_name,
      from_email: SENT.from_email,
      reply_to: SENT.reply_to,
      template_id: SENT.template_id,
      postmark_stream: SENT.postmark_stream,
      location_id: LOC,
    })
  })

  it('names the copy distinguishably and starts it as a draft', async () => {
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await POST(req(), props)

    expect(inserts[0].status).toBe('draft')
    expect(inserts[0].name).toBe('Copy of August lock-in sale')
  })

  it('attributes the copy to whoever duplicated it, not the original author', async () => {
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await POST(req(), props)
    expect(inserts[0].created_by).toBe('user-2')
  })

  it('returns the new id so the caller can navigate straight into it', async () => {
    const { db } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    const body = await (await POST(req(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.id).toBe('new-campaign-id')
  })
})

describe('the clone carries NONE of the parent history', () => {
  it('copies no counters, timestamps, A/B outcome or resend state', async () => {
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await POST(req(), props)

    const forbidden = [
      'sent_at', 'send_started_at', 'scheduled_at',
      'total_recipients', 'total_sent', 'total_delivered', 'total_opened',
      'total_clicked', 'total_bounced', 'total_complained', 'total_unsubscribed',
      'ab_winner', 'ab_test_started_at', 'ab_decided_at',
      'resend_enabled', 'resend_wait_hours', 'resend_subject',
      'cancel_requested_at', 'last_error', 'created_at', 'id',
    ]
    for (const key of forbidden) {
      expect(inserts[0]).not.toHaveProperty(key)
    }
  })

  it('never sets parent_campaign_id', async () => {
    // `campaigns_one_resend_per_parent` (mig 506) is a UNIQUE index on that
    // column. Setting it here would both mislabel the copy as a non-opener
    // resend and make a second duplicate of the same campaign fail on a
    // constraint the operator cannot see.
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await POST(req(), props)
    expect(inserts[0]).not.toHaveProperty('parent_campaign_id')
  })

  it('carries the A/B TEST SETUP but not its result', async () => {
    const { db, inserts } = makeDb(SENT)
    createServerClient.mockReturnValue(db)
    await POST(req(), props)
    expect(inserts[0].ab_subject_b).toBe(SENT.ab_subject_b)
    expect(inserts[0].ab_test_pct).toBe(SENT.ab_test_pct)
    expect(inserts[0].ab_wait_hours).toBe(SENT.ab_wait_hours)
    expect(inserts[0]).not.toHaveProperty('ab_winner')
  })
})

describe('guards', () => {
  it('401s an anonymous caller', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(makeDb(SENT).db)
    expect((await POST(req(), props)).status).toBe(401)
  })

  it('404s a campaign that does not exist', async () => {
    createServerClient.mockReturnValue(makeDb(null).db)
    expect((await POST(req(), props)).status).toBe(404)
  })

  it('404s a campaign at a location the user cannot reach', async () => {
    assertLocationAccessOr404.mockReturnValue(
      new Response(JSON.stringify({ success: false }), { status: 404 }),
    )
    createServerClient.mockReturnValue(makeDb(SENT).db)
    expect((await POST(req(), props)).status).toBe(404)
  })

  it('403s a user without email permission AT THE CAMPAIGN LOCATION', async () => {
    // Same parity point as COMMSFIX.D.5 on the send route: check the
    // campaign's location, never the session's active one.
    hasPermissionForLocation.mockReturnValue(false)
    createServerClient.mockReturnValue(makeDb(SENT).db)
    expect((await POST(req(), props)).status).toBe(403)
    expect(hasPermissionForLocation.mock.calls[0][1]).toBe(LOC)
  })

  it('400s a malformed campaign id without querying', async () => {
    const { db } = makeDb(SENT)
    const spy = vi.spyOn(db, 'from')
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('duplicates a DRAFT too — this is a reuse tool, not only a sent-campaign escape hatch', async () => {
    const { db, inserts } = makeDb({ ...SENT, status: 'draft' })
    createServerClient.mockReturnValue(db)
    expect((await POST(req(), props)).status).toBe(200)
    expect(inserts[0].status).toBe('draft')
  })
})
