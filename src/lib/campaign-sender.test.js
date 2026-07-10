// COMMS-AUDIT 2026-07-10 — campaign send reliability (CAMPAIGN-REL).
//
// Locks down the tickCampaignSend failure handling:
//
//   1. TRANSIENT provider errors (network -1, HTTP 429/5xx, Postmark
//      rate-limit/maintenance codes) return the recipient to 'queued'
//      with a bounded attempt counter instead of being permanently
//      marked 'bounced'. Before this fix a single Postmark blip
//      mis-recorded a whole 500-chunk as bounced — unrecoverable.
//   2. PERMANENT rejections (300 invalid email, 406 inactive
//      recipient) still mark 'bounced' immediately — retrying them
//      can never succeed and hurts sender reputation.
//   3. Recipients stuck in 'sending' (a cron invocation died between
//      the CAS claim and result application) are reclaimed back to
//      'queued' after a lease timeout, so finalisation can't close
//      the campaign as 'sent' around them forever.
//   4. campaigns.preview_text is injected as a hidden preheader and
//      a plain-text alternative rides along to Postmark.
//
// The Supabase client is faked with a chainable thenable recorder
// (mirrors the style of sms.test.js / postmark.test.js) — no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./postmark.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendBatch: vi.fn(), buildAudienceQueryAsync: vi.fn() }
})

import { sendBatch } from './postmark.js'
import { tickCampaignSend, MAX_SEND_ATTEMPTS, SENDING_LEASE_MS } from './campaign-sender.js'

// ── chainable fake ─────────────────────────────────────────────────
// Each db.from() call creates a recorded "statement" ({ table, ops }).
// Awaiting the builder routes the statement through the test's route
// function to produce { data } / { count } / {}.
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
    rpc(...args) {
      statements.push({ table: '__rpc__', ops: [{ method: 'rpc', args }] })
      return Promise.resolve({ error: null })
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find(o => o.method === method)
const hasEq = (state, col, val) => state.ops.some(o => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

// Standard route: phase-2 campaign with recipients already populated.
function routeFor({ count = 1, stale = [], candidates = [] }) {
  return (state) => {
    if (state.table !== 'campaign_recipients') return { data: [] }
    const first = state.ops[0]
    if (first.method === 'select' && first.args[1]?.head) return { count }
    if (first.method === 'select' && hasEq(state, 'status', 'sending')) return { data: stale }
    if (first.method === 'select') return { data: candidates }
    if (first.method === 'update' && op(state, 'select')) {
      // claim CAS — grant everything asked for
      return { data: op(state, 'in').args[1].map(id => ({ id })) }
    }
    return {}
  }
}

const makeContact = (id) => ({
  id: `contact-${id}`,
  email: `${id}@x.ie`,
  first_name: 'Alice',
  last_name: 'M',
  name: 'Alice M',
  phone: null,
  pipeline_stage_slug: 'lead',
  email_status: 'active',
  email_marketing: true,
  email_administrative: true,
  glofox_passcode: null,
  contact_preferences: [{ unsubscribe_token: `tok-${id}` }],
})

const makeRecipient = (id, attempts = 0) => ({
  id,
  contact_id: `contact-${id}`,
  attempts,
  contact: makeContact(id),
})

const campaign = {
  id: 'camp-1',
  name: 'July offer',
  subject: 'Hi {{first_name}}',
  html_content: '<html><body><p>Hi {{first_name}}</p></body></html>',
  preview_text: 'Your July offer inside',
  location_id: 'loc-1',
  locations: { name: 'Stillorgan' },
  postmark_stream: null,
  cancel_requested_at: null,
  from_name: null,
  from_email: 'hello@un1t.ie',
  reply_to: null,
  sent_at: null,
}

// All statements that UPDATE campaign_recipients targeting a given id
// (either .eq('id', id) or .in('id', [...ids])).
function recipientUpdates(statements, id) {
  return statements.filter(s =>
    s.table === 'campaign_recipients' &&
    s.ops[0]?.method === 'update' &&
    s.ops.some(o =>
      (o.method === 'eq' && o.args[0] === 'id' && o.args[1] === id) ||
      (o.method === 'in' && o.args[0] === 'id' && o.args[1].includes(id))
    )
  ).map(s => s.ops[0].args[0])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tickCampaignSend — transient vs permanent errors (CAMPAIGN-REL.1)', () => {
  it('requeues a recipient on a transient error with attempts+1 (not bounced)', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: -1, Message: 'ECONNRESET' }])

    const result = await tickCampaignSend(db, campaign)

    const updates = recipientUpdates(statements, 'r1')
    expect(updates).toContainEqual(expect.objectContaining({ status: 'queued', attempts: 1 }))
    expect(updates.some(u => u.status === 'bounced')).toBe(false)
    expect(result.retried).toBe(1)
    expect(result.bounced).toBe(0)
  })

  it('marks a recipient failed once the attempt cap is exhausted', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', MAX_SEND_ATTEMPTS - 1)],
    }))
    sendBatch.mockResolvedValue([{ ErrorCode: 429, Message: 'Rate limit exceeded', HttpStatus: 429 }])

    const result = await tickCampaignSend(db, campaign)

    const updates = recipientUpdates(statements, 'r1')
    expect(updates).toContainEqual(expect.objectContaining({ status: 'failed', attempts: MAX_SEND_ATTEMPTS }))
    expect(updates.some(u => u.status === 'queued')).toBe(false)
    expect(result.failed).toBe(1)
    expect(result.retried).toBe(0)
  })

  it('still marks permanent Postmark rejections as bounced immediately', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 406, Message: 'Inactive recipient' }])

    const result = await tickCampaignSend(db, campaign)

    const updates = recipientUpdates(statements, 'r1')
    expect(updates).toContainEqual(expect.objectContaining({ status: 'bounced', bounce_type: 'rejected' }))
    expect(result.bounced).toBe(1)
    expect(result.retried).toBe(0)
  })

  it('handles a mixed batch — success sent+logged, transient requeued', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', 0), makeRecipient('r2', 0)],
    }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-1' },
      { ErrorCode: -1, Message: 'socket hang up' },
    ])

    const result = await tickCampaignSend(db, campaign)

    expect(recipientUpdates(statements, 'r1'))
      .toContainEqual(expect.objectContaining({ status: 'sent', postmark_message_id: 'pm-1' }))
    expect(recipientUpdates(statements, 'r2'))
      .toContainEqual(expect.objectContaining({ status: 'queued', attempts: 1 }))
    expect(result.sent).toBe(1)
    expect(result.retried).toBe(1)

    // Only the successful send gets an email_sends row.
    const inserts = statements.filter(s => s.table === 'email_sends' && s.ops[0].method === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].ops[0].args[0]).toHaveLength(1)
    expect(inserts[0].ops[0].args[0][0].postmark_message_id).toBe('pm-1')
  })
})

describe('tickCampaignSend — stuck-sending reclaim (CAMPAIGN-REL.2)', () => {
  it('reclaims lease-expired sending rows back to queued (attempts+1), failed at the cap', async () => {
    const { db, statements } = makeDb(routeFor({
      stale: [
        { id: 's1', attempts: 0 },
        { id: 's2', attempts: MAX_SEND_ATTEMPTS - 1 },
      ],
      candidates: [],
    }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, campaign)

    expect(recipientUpdates(statements, 's1'))
      .toContainEqual(expect.objectContaining({ status: 'queued', attempts: 1 }))
    expect(recipientUpdates(statements, 's2'))
      .toContainEqual(expect.objectContaining({ status: 'failed', attempts: MAX_SEND_ATTEMPTS }))
  })

  it('only sweeps rows whose lease expired (or that predate leasing)', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [] }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, campaign)

    const sweep = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'select' &&
      hasEq(s, 'status', 'sending')
    )
    expect(sweep).toBeTruthy()
    const orOp = op(sweep, 'or')
    expect(orOp).toBeTruthy()
    expect(orOp.args[0]).toContain('claimed_at.lt.')
    expect(orOp.args[0]).toContain('claimed_at.is.null')
    // Lease is ~10 minutes, mirroring the sequences scheduler.
    expect(SENDING_LEASE_MS).toBe(10 * 60_000)
  })

  it('stamps claimed_at when claiming a chunk so the lease clock starts', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const claim = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'update' &&
      s.ops[0].args[0].status === 'sending'
    )
    expect(claim).toBeTruthy()
    expect(claim.ops[0].args[0].claimed_at).toEqual(expect.any(String))
  })
})

describe('tickCampaignSend — preheader + text alternative (CAMPAIGN-REL.3/.4)', () => {
  it('injects preview_text as a hidden preheader before the body content', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const batch = sendBatch.mock.calls[0][0]
    const html = batch[0].htmlBody
    expect(html).toContain('Your July offer inside')
    expect(html.indexOf('Your July offer inside')).toBeLessThan(html.indexOf('<p>Hi Alice</p>'))
    expect(html).toMatch(/display:\s*none/)
  })

  it('passes a plain-text alternative that excludes the hidden preheader', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].textBody).toContain('Hi Alice')
    // The auto unsubscribe footer link survives into the text part.
    expect(batch[0].textBody).toContain('Unsubscribe')
    // The preheader is inbox-chrome, not content — keep it out of text.
    expect(batch[0].textBody).not.toContain('Your July offer inside')
  })

  it('sends no preheader when the campaign has no preview_text', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, preview_text: null })

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].htmlBody).not.toMatch(/mso-hide/)
  })
})
