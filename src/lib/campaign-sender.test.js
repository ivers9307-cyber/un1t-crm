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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./postmark.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendBatch: vi.fn(), buildAudienceQueryAsync: vi.fn() }
})

import { sendBatch, buildAudienceQueryAsync } from './postmark.js'
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
      const state = { table: '__rpc__', ops: [{ method: 'rpc', args }] }
      statements.push(state)
      // Routable like from() so tests can feed RPC results (e.g. the
      // campaign_ab_variant_stats decide query); default keeps the
      // historical { error: null } shape.
      return Promise.resolve(route(state) ?? { error: null })
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find(o => o.method === method)
const hasEq = (state, col, val) => state.ops.some(o => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

// Standard route: phase-2 campaign with recipients already populated.
// viewSurvivors — COMMSFIX.A.1: what the mid-send consent re-check on
// contact_location_audience returns; defaults to "every candidate is
// still eligible" so tests that aren't about consent behave as before.
function routeFor({ count = 1, stale = [], candidates = [], viewSurvivors = null }) {
  return (state) => {
    if (state.table === 'contact_location_audience') {
      return { data: viewSurvivors ?? candidates.map(r => ({ id: r.contact_id })) }
    }
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
  // POPFIX.1 — populate completion is now read off the campaign row, not off
  // a recipient row count, so the default fixture is an already-populated
  // campaign (phase 2). Populate-phase tests pass send_started_at: null.
  send_started_at: '2026-07-10T09:00:00.000Z',
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

  it('stamps bounced_at on a permanent rejection so the event can be placed on a timeline', async () => {
    // BOUNCEDAT.1 — the rejection branch wrote status/bounce_type/attempts/
    // last_error but no timestamp, so 42 real rejection events across 11
    // contacts sat in campaign_recipients with bounced_at NULL. Anything
    // keyed on bounced_at (the contact timeline's Bounced chip, the sequence
    // stats bounce count, integration-health's `.not('bounced_at','is',null)`)
    // under-reported by exactly that number, silently. The Postmark webhook
    // path has always stamped it; this is the one writer that didn't.
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 300, Message: 'Invalid email address' }])

    await tickCampaignSend(db, campaign)

    const bounce = recipientUpdates(statements, 'r1').find(u => u.status === 'bounced')
    expect(bounce).toBeTruthy()
    expect(bounce.bounced_at).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(bounce.bounced_at))).toBe(false)
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

  // POSTMARK-RACE.1 — campaigns are 100% of the measured loss: all 3,231
  // Delivery events that outran their email_sends row over 21 days carried a
  // `campaign-<uuid>` tag. The batch cannot write the row first (Postmark mints
  // the MessageID, and the API call for up to 500 recipients takes seconds
  // during which Postmark is already delivering), so the marker is what tells
  // the webhook processor to wait rather than discard.
  it('stamps the crm_send marker on every message in the batch', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0), makeRecipient('r2', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }, { ErrorCode: 0, MessageID: 'pm-2' }])

    await tickCampaignSend(db, campaign)

    const batch = sendBatch.mock.calls.at(-1)[0]
    expect(batch).toHaveLength(2)
    for (const email of batch) {
      // POSTMARK-RACE.2 — the value is the send instant, not a constant.
      expect(Number(email.metadata.crm_send)).toBeGreaterThan(Date.now() - 60_000)
      // The existing attribution is preserved, not replaced.
      expect(email.metadata.campaign_id).toBe(campaign.id)
      expect(email.metadata.contact_id).toEqual(expect.any(String))
    }
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

describe('tickCampaignSend — Reply-To (EMAIL-MAILBOX-ADMIN.1)', () => {
  // routeFor() answers { data: [] } for every table but campaign_recipients,
  // so this route adds the studio's default account on top of it. The lookup
  // ends in .maybeSingle(), so the shape is a ROW (or null) — the proxy fake
  // does not unwrap it, the route function decides.
  function routeWithMailbox(mailboxes, base) {
    return (state) => (state.table === 'email_mailboxes' ? { data: mailboxes[0] ?? null } : base(state))
  }

  it('stamps the studio’s DEFAULT account, not the deprecated column', async () => {
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db } = makeDb(routeWithMailbox([{ address: 'studio@un1tdublin.com' }], base))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, {
      ...campaign,
      locations: { name: 'Stillorgan', email_inbox_reply_to: 'legacy@un1tdublin.com' },
    })

    expect(sendBatch.mock.calls[0][0][0].replyTo).toBe('studio@un1tdublin.com')
  })

  it('falls back to the deprecated column when the studio has no default account', async () => {
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db } = makeDb(routeWithMailbox([], base))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, {
      ...campaign,
      locations: { name: 'Stillorgan', email_inbox_reply_to: 'legacy@un1tdublin.com' },
    })

    expect(sendBatch.mock.calls[0][0][0].replyTo).toBe('legacy@un1tdublin.com')
  })

  it('a per-campaign reply_to still wins over both', async () => {
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db } = makeDb(routeWithMailbox([{ address: 'studio@un1tdublin.com' }], base))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, reply_to: 'hello@un1t.ie' })

    expect(sendBatch.mock.calls[0][0][0].replyTo).toBe('hello@un1t.ie')
  })

  it('sends with no Reply-To at a studio that has neither', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    expect(sendBatch.mock.calls[0][0][0].replyTo).toBeUndefined()
  })
})

// ── COMMSFIX.A.1 — mid-send consent re-check reads the per-location view ──
//
// Populate gates on contact_location_audience.loc_email_marketing (+
// email_suppressed_at IS NULL), but the old post-claim re-check gated on
// the embedded GLOBAL contacts.email_marketing. Since LOCCOMMS.4 every
// unsubscribe link is ?l=-scoped and writes ONLY
// contact_location_preferences — invisible to the global column — so a
// location-scoped opt-out between populate and send was ignored (and the
// inverse skew wrongly cancelled per-location-consented recipients whose
// global flag was false).
describe('tickCampaignSend — mid-send consent re-check (COMMSFIX.A.1)', () => {
  it('re-check cancels a recipient whose per-location email_marketing went false after populate', async () => {
    // Global column still true — only the VIEW knows about the scoped opt-out.
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', 0)],
      viewSurvivors: [],
    }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, campaign)

    expect(recipientUpdates(statements, 'r1'))
      .toContainEqual(expect.objectContaining({ status: 'cancelled' }))
    expect(sendBatch).not.toHaveBeenCalled()
    expect(result.sent).toBe(0)
  })

  it('re-check still sends a per-location-consented recipient even if the GLOBAL email_marketing is false', async () => {
    const recipient = makeRecipient('r1', 0)
    recipient.contact.email_marketing = false // global skew — must NOT cancel
    const { db, statements } = makeDb(routeFor({
      candidates: [recipient],
      viewSurvivors: [{ id: 'contact-r1' }],
    }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    expect(sendBatch).toHaveBeenCalledTimes(1)
    expect(sendBatch.mock.calls[0][0][0].to).toBe('r1@x.ie')
    const updates = recipientUpdates(statements, 'r1')
    expect(updates).toContainEqual(expect.objectContaining({ status: 'sent' }))
    expect(updates.some(u => u.status === 'cancelled')).toBe(false)
  })

  it('re-check re-applies email_suppressed_at via the per-location view', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', 0)],
      viewSurvivors: [], // suppressed after populate → absent from the view read
    }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, campaign)

    // The re-check carries the full populate-time marketing gate set.
    const viewRead = statements.find(s => s.table === 'contact_location_audience')
    expect(viewRead).toBeTruthy()
    expect(hasEq(viewRead, 'audience_location_id', 'loc-1')).toBe(true)
    expect(hasEq(viewRead, 'loc_email_marketing', true)).toBe(true)
    expect(viewRead.ops.find(o => o.method === 'is').args).toEqual(['email_suppressed_at', null])
    expect(viewRead.ops.find(o => o.method === 'in').args).toEqual(['id', ['contact-r1']])
    expect(recipientUpdates(statements, 'r1'))
      .toContainEqual(expect.objectContaining({ status: 'cancelled' }))
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('re-check gates a utility campaign on the view’s email_administrative with no suppression gate', async () => {
    // NOTE: administrative consent is deliberately GLOBAL (LOCCOMMS.3 —
    // LOCATION_CONSENT_COLUMNS maps only the marketing channels to loc_*);
    // the view surfaces it as plain email_administrative, and populate
    // gates on exactly that via consentColumnFor. The re-check must match.
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    const viewRead = statements.find(s => s.table === 'contact_location_audience')
    expect(viewRead).toBeTruthy()
    expect(hasEq(viewRead, 'email_administrative', true)).toBe(true)
    // Administrative mail is never suppression-gated (mirrors populate).
    expect(viewRead.ops.some(o => o.method === 'is' && o.args[0] === 'email_suppressed_at')).toBe(false)
    expect(sendBatch).toHaveBeenCalledTimes(1)
  })

  it('re-check view error releases the claim and fails the tick without sending', async () => {
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db, statements } = makeDb((state) => {
      if (state.table === 'contact_location_audience') {
        return { data: null, error: { message: 'view boom' } }
      }
      return base(state)
    })
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, campaign)

    expect(result.error).toMatch(/view boom/)
    expect(sendBatch).not.toHaveBeenCalled()
    const updates = recipientUpdates(statements, 'r1')
    // Claim released for a later tick — never sent, never cancelled.
    expect(updates).toContainEqual(expect.objectContaining({ status: 'queued', claimed_at: null }))
    expect(updates.some(u => u.status === 'sent' || u.status === 'cancelled')).toBe(false)
  })

  it('re-check keeps cancelling bounced/complained reputation flips', async () => {
    const recipient = makeRecipient('r1', 0)
    recipient.contact.email_status = 'bounced' // flipped after populate
    const { db, statements } = makeDb(routeFor({
      candidates: [recipient],
      viewSurvivors: [{ id: 'contact-r1' }], // consent itself still granted
    }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, campaign)

    expect(recipientUpdates(statements, 'r1'))
      .toContainEqual(expect.objectContaining({ status: 'cancelled' }))
    expect(sendBatch).not.toHaveBeenCalled()
  })
})

// ── CAMPAIGN-AB (COMMS-AUDIT 2026-07-10) — subject-line A/B testing ──

const HOUR = 3600_000

const abCampaign = (overrides = {}) => ({
  ...campaign,
  ab_subject_b: 'Better subject {{first_name}}',
  ab_test_pct: 20,
  ab_wait_hours: 4,
  ab_winner: null,
  ab_test_started_at: null,
  ab_decided_at: null,
  ...overrides,
})

const abRecipient = (id, variant) => ({ ...makeRecipient(id), ab_variant: variant })

// Route for A/B phase-2 scenarios. Distinguishes the head-count
// existing-recipients probe, the reclaim sweep, the inflight-slice
// probe, the chunk select, the claim CAS, the winner CAS, and the
// variant-stats RPC.
function abRouteFor({
  count = 1,
  stale = [],
  candidates = [],
  inflight = 0,
  statRows = [],
  winnerCasGranted = true,
  viewSurvivors = null,
} = {}) {
  return (state) => {
    if (state.table === 'contact_location_audience') {
      // COMMSFIX.A.1 — mid-send consent re-check; default: all eligible.
      return { data: viewSurvivors ?? candidates.map(r => ({ id: r.contact_id })) }
    }
    if (state.table === '__rpc__') {
      const [fn] = state.ops[0].args
      if (fn === 'campaign_ab_variant_stats') return { data: statRows, error: null }
      return { error: null }
    }
    if (state.table === 'campaigns') {
      const first = state.ops[0]
      if (first.method === 'update' && 'ab_winner' in (first.args[0] || {})) {
        return winnerCasGranted ? { data: [{ id: 'camp-1' }] } : { data: [] }
      }
      return {}
    }
    if (state.table !== 'campaign_recipients') return { data: [] }
    const first = state.ops[0]
    if (first.method === 'select' && first.args[1]?.head) {
      if (hasEq(state, 'status', 'sending')) return { count: inflight }
      return { count }
    }
    if (first.method === 'select' && hasEq(state, 'status', 'sending')) return { data: stale }
    if (first.method === 'select') return { data: candidates }
    if (first.method === 'update' && op(state, 'select')) {
      return { data: op(state, 'in').args[1].map(id => ({ id })) }
    }
    return {}
  }
}

// All UPDATE payloads applied to the campaigns table.
const campaignUpdates = (statements) =>
  statements
    .filter(s => s.table === 'campaigns' && s.ops[0]?.method === 'update')
    .map(s => s.ops[0].args[0])

// True when some statement filters ab_variant IS NOT NULL (`.not('ab_variant','is',null)`).
const hasVariantFilter = (state) =>
  state.ops.some(o => o.method === 'not' && o.args[0] === 'ab_variant')

describe('tickCampaignSend — A/B default-path regression (no ab_subject_b)', () => {
  it('never touches ab_* columns or filters by ab_variant for a plain campaign', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    for (const u of campaignUpdates(statements)) {
      expect(u).not.toHaveProperty('ab_test_started_at')
      expect(u).not.toHaveProperty('ab_winner')
      expect(u).not.toHaveProperty('ab_decided_at')
    }
    expect(statements.some(hasVariantFilter)).toBe(false)
    // Subject is the plain campaign subject, merged.
    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Hi Alice')
  })

  it('finalises a drained plain campaign as sent (no A/B stamp detour)', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [] }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, campaign)

    expect(result.phase).toBe('finalise')
    expect(campaignUpdates(statements)).toContainEqual(expect.objectContaining({ status: 'sent' }))
  })

  it('populate for a plain campaign inserts recipient rows WITHOUT an ab_variant key', async () => {
    const contacts = [makeContact('c1'), makeContact('c2'), makeContact('c3'), makeContact('c4')]
    const query = {
      order: vi.fn(() => query),
      range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })),
    }
    buildAudienceQueryAsync.mockResolvedValue({ query })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, { ...campaign, send_started_at: null })

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'upsert')
    expect(insert).toBeTruthy()
    for (const row of insert.ops[0].args[0]) {
      expect(row).not.toHaveProperty('ab_variant')
    }
  })
})

describe('tickCampaignSend — A/B populate (slice assignment at populate time)', () => {
  it('assigns ab_variant to ~pct% of recipients, half a / half b, remainder null', async () => {
    const contacts = Array.from({ length: 10 }, (_, i) => makeContact(`c${i + 1}`))
    const query = {
      order: vi.fn(() => query),
      range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })),
    }
    buildAudienceQueryAsync.mockResolvedValue({ query })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, abCampaign({ send_started_at: null })) // pct 20 of 10 → slice of 2

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'upsert')
    const rows = insert.ops[0].args[0]
    expect(rows).toHaveLength(10)
    const a = rows.filter(r => r.ab_variant === 'a')
    const b = rows.filter(r => r.ab_variant === 'b')
    const rest = rows.filter(r => r.ab_variant === null)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(rest).toHaveLength(8)
    // The A/B lifecycle has not started — no premature winner.
    for (const u of campaignUpdates(statements)) {
      expect(u).not.toHaveProperty('ab_winner')
    }
  })

  it('an audience too small to test short-circuits to winner A at populate time', async () => {
    const contacts = [makeContact('c1'), makeContact('c2')]
    const query = {
      order: vi.fn(() => query),
      range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })),
    }
    buildAudienceQueryAsync.mockResolvedValue({ query })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, abCampaign({ send_started_at: null }))

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'upsert')
    for (const row of insert.ops[0].args[0]) expect(row.ab_variant).toBe(null)
    expect(campaignUpdates(statements)).toContainEqual(expect.objectContaining({ ab_winner: 'a', status: 'sending' }))
  })
})

describe('tickCampaignSend — A/B slice phase', () => {
  it('sends only the test slice, with the subject per variant', async () => {
    const { db, statements } = makeDb(abRouteFor({
      candidates: [abRecipient('r1', 'a'), abRecipient('r2', 'b')],
    }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-1' },
      { ErrorCode: 0, MessageID: 'pm-2' },
    ])

    await tickCampaignSend(db, abCampaign())

    // Chunk select was restricted to slice rows (ab_variant IS NOT NULL).
    const chunkSelect = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'select' &&
      !s.ops[0].args[1]?.head &&
      hasEq(s, 'status', 'queued')
    )
    expect(hasVariantFilter(chunkSelect)).toBe(true)

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].subject).toBe('Hi Alice')            // variant A = campaigns.subject
    expect(batch[1].subject).toBe('Better subject Alice') // variant B = ab_subject_b

    // email_sends logs the subject each recipient actually got.
    const insert = statements.find(s => s.table === 'email_sends' && s.ops[0].method === 'insert')
    const subjects = insert.ops[0].args[0].map(r => r.subject)
    expect(subjects).toContain('Hi {{first_name}}')
    expect(subjects).toContain('Better subject {{first_name}}')
  })

  it('stamps ab_test_started_at (CAS on IS NULL) once the slice is fully drained', async () => {
    const { db, statements } = makeDb(abRouteFor({ candidates: [], inflight: 0 }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, abCampaign())

    expect(result.phase).toBe('ab_test_started')
    const stamp = statements.find(s =>
      s.table === 'campaigns' &&
      s.ops[0]?.method === 'update' &&
      'ab_test_started_at' in s.ops[0].args[0]
    )
    expect(stamp).toBeTruthy()
    // CAS — only one tick may start the wait clock.
    expect(stamp.ops.some(o => o.method === 'is' && o.args[0] === 'ab_test_started_at' && o.args[1] === null)).toBe(true)
    // The campaign must NOT be finalised as sent around the remainder.
    expect(campaignUpdates(statements).some(u => u.status === 'sent')).toBe(false)
  })

  it('does not start the wait clock while slice rows are still in flight (sending)', async () => {
    const { db, statements } = makeDb(abRouteFor({ candidates: [], inflight: 2 }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, abCampaign())

    expect(result.phase).toBe('ab_slice')
    expect(campaignUpdates(statements).every(u => !('ab_test_started_at' in u))).toBe(true)
  })
})

describe('tickCampaignSend — A/B waiting phase', () => {
  it('is a no-op for the remainder while inside the wait window', async () => {
    const { db, statements } = makeDb(abRouteFor({}))
    sendBatch.mockResolvedValue([])
    const started = new Date(Date.now() - 1 * HOUR).toISOString()

    const result = await tickCampaignSend(db, abCampaign({ ab_test_started_at: started }))

    expect(result.phase).toBe('ab_waiting')
    expect(sendBatch).not.toHaveBeenCalled()
    expect(campaignUpdates(statements).some(u => u.status === 'sent')).toBe(false)
  })

  it('rotates the waiting campaign to the back of the cron pick order (updated_at touch)', async () => {
    const { db, statements } = makeDb(abRouteFor({}))
    const started = new Date(Date.now() - 1 * HOUR).toISOString()

    await tickCampaignSend(db, abCampaign({ ab_test_started_at: started }))

    expect(campaignUpdates(statements)).toContainEqual({ updated_at: expect.any(String) })
  })
})

describe('tickCampaignSend — A/B decide phase', () => {
  const statRowsBWins = [
    { ab_variant: 'a', sent_count: 50, opened_count: 5 },
    { ab_variant: 'b', sent_count: 50, opened_count: 20 },
  ]
  const startedLongAgo = () => new Date(Date.now() - 5 * HOUR).toISOString()

  it('decides by open rate, CAS-stamps the winner, and sends the remainder with the winning subject in the same tick', async () => {
    const { db, statements } = makeDb(abRouteFor({
      candidates: [abRecipient('r9', null)],
      statRows: statRowsBWins,
    }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-9' }])

    const result = await tickCampaignSend(db, abCampaign({ ab_test_started_at: startedLongAgo() }))

    const stamp = statements.find(s =>
      s.table === 'campaigns' && s.ops[0]?.method === 'update' && 'ab_winner' in s.ops[0].args[0]
    )
    expect(stamp.ops[0].args[0]).toEqual(expect.objectContaining({ ab_winner: 'b', ab_decided_at: expect.any(String) }))
    // CAS — only one tick decides.
    expect(stamp.ops.some(o => o.method === 'is' && o.args[0] === 'ab_winner' && o.args[1] === null)).toBe(true)

    // Remainder went out with the winning (B) subject, merged.
    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Better subject Alice')
    expect(result.sent).toBe(1)
  })

  // ABHONEST.1 — the campaign must NOT hang waiting for a decision it can
  // never make. An inconclusive reading still stamps ab_winner (the only value
  // mig 398's CHECK allows for "carry on") and the remainder goes out with A.
  it('an inconclusive test still stamps A and sends the remainder', async () => {
    const { db, statements } = makeDb(abRouteFor({
      candidates: [abRecipient('r9', null)],
      statRows: [
        { ab_variant: 'a', sent_count: 50, opened_count: 0 },
        { ab_variant: 'b', sent_count: 50, opened_count: 0 },
      ],
    }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-9' }])

    await tickCampaignSend(db, abCampaign({ ab_test_started_at: startedLongAgo() }))

    const stamp = statements.find(s =>
      s.table === 'campaigns' && s.ops[0]?.method === 'update' && 'ab_winner' in s.ops[0].args[0]
    )
    expect(stamp.ops[0].args[0].ab_winner).toBe('a')
    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Hi Alice')
  })

  it('a tick that loses the winner CAS sends nothing (single decider)', async () => {
    const { db } = makeDb(abRouteFor({
      candidates: [abRecipient('r9', null)],
      statRows: statRowsBWins,
      winnerCasGranted: false,
    }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, abCampaign({ ab_test_started_at: startedLongAgo() }))

    expect(result.phase).toBe('ab_decide')
    expect(result.sent).toBe(0)
    expect(sendBatch).not.toHaveBeenCalled()
  })
})

describe('tickCampaignSend — A/B final phase + cancel', () => {
  it('after a decision, the remainder AND retried slice rows each get their correct subject', async () => {
    const { db, statements } = makeDb(abRouteFor({
      candidates: [abRecipient('r9', null), abRecipient('r2', 'b'), abRecipient('r1', 'a')],
    }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-9' },
      { ErrorCode: 0, MessageID: 'pm-2' },
      { ErrorCode: 0, MessageID: 'pm-1' },
    ])

    await tickCampaignSend(db, abCampaign({
      ab_winner: 'b',
      ab_test_started_at: new Date(Date.now() - 9 * HOUR).toISOString(),
      ab_decided_at: new Date(Date.now() - 4 * HOUR).toISOString(),
    }))

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].subject).toBe('Better subject Alice') // remainder → winner B
    expect(batch[1].subject).toBe('Better subject Alice') // retried slice B row keeps B
    expect(batch[2].subject).toBe('Hi Alice')             // retried slice A row keeps A

    // Final-phase chunk select is NOT slice-restricted.
    const chunkSelect = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'select' &&
      !s.ops[0].args[1]?.head &&
      hasEq(s, 'status', 'queued')
    )
    expect(hasVariantFilter(chunkSelect)).toBe(false)
  })

  it('winner A sends the remainder with subject A', async () => {
    const { db } = makeDb(abRouteFor({ candidates: [abRecipient('r9', null)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-9' }])

    await tickCampaignSend(db, abCampaign({
      ab_winner: 'a',
      ab_test_started_at: new Date(Date.now() - 9 * HOUR).toISOString(),
    }))

    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Hi Alice')
  })

  it('cancel mid-test still cancels immediately (even during the wait window)', async () => {
    const { db, statements } = makeDb(abRouteFor({}))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, abCampaign({
      ab_test_started_at: new Date(Date.now() - 1 * HOUR).toISOString(),
      cancel_requested_at: new Date().toISOString(),
    }))

    expect(result.phase).toBe('cancelled')
    expect(campaignUpdates(statements)).toContainEqual(expect.objectContaining({ status: 'cancelled' }))
    // Remaining queued recipients (slice + remainder) are parked.
    const parked = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'update' &&
      s.ops[0].args[0].status === 'cancelled'
    )
    expect(parked).toBeTruthy()
    expect(hasVariantFilter(parked)).toBe(false)
  })
})

// ── FREQ-CAP.1 — cross-channel marketing frequency cap ─────────────

describe('tickCampaignSend — marketing frequency cap (FREQ-CAP.1)', () => {
  const capLocations = (enabled = true, hours = 24) => ({
    name: 'Stillorgan',
    settings: { comms_frequency_cap: { enabled, min_hours_between: hours } },
  })
  const capCampaign = (overrides = {}) => ({
    ...campaign,
    locations: capLocations(),
    ...overrides,
  })

  // The queued-chunk fetch (non-head select on campaign_recipients with
  // status='queued').
  const chunkSelect = (statements) =>
    statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'select' &&
      !s.ops[0].args[1]?.head &&
      hasEq(s, 'status', 'queued')
    )
  const capOrOp = (state) =>
    state?.ops.find(o =>
      o.method === 'or' &&
      String(o.args[0]).includes('last_marketing_touch_at') &&
      o.args[1]?.referencedTable === 'contact'
    )

  it('applies the embedded-contact cap filter to the queued fetch when enabled', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, capCampaign())

    const orOp = capOrOp(chunkSelect(statements))
    expect(orOp).toBeTruthy()
    expect(orOp.args[0]).toContain('last_marketing_touch_at.is.null')
    expect(orOp.args[0]).toContain('last_marketing_touch_at.lt.')
  })

  it('does NOT filter when the cap is disabled (default)', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign) // locations.settings absent

    expect(capOrOp(chunkSelect(statements))).toBeFalsy()
  })

  it('does NOT filter utility (outbound-stream) campaigns even when enabled', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, capCampaign({ postmark_stream: 'outbound' }))

    expect(capOrOp(chunkSelect(statements))).toBeFalsy()
  })

  // Route for the "everything remaining is cap-deferred" shape: recipients
  // exist (existingCount=5), the cap-filtered chunk fetch is empty, and the
  // unfiltered queued head-count still shows rows.
  const capHeldRoute = ({ queuedRemaining = 3 }) => (state) => {
    if (state.table !== 'campaign_recipients') return { data: [] }
    const first = state.ops[0]
    if (first.method === 'select' && first.args[1]?.head) {
      return hasEq(state, 'status', 'queued') ? { count: queuedRemaining } : { count: 5 }
    }
    if (first.method === 'select' && hasEq(state, 'status', 'sending')) return { data: [] }
    if (first.method === 'select') return { data: [] }
    return {}
  }

  it('holds the campaign open (cap_deferred) while queued rows are cap-held', async () => {
    const { db, statements } = makeDb(capHeldRoute({ queuedRemaining: 3 }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, capCampaign({
      send_started_at: new Date().toISOString(),
    }))

    expect(result.phase).toBe('cap_deferred')
    expect(result.deferred).toBe(3)
    // NOT finalised — and rotated to the back of the pick order.
    const updates = campaignUpdates(statements)
    expect(updates.some(u => u.status === 'sent')).toBe(false)
    expect(updates).toContainEqual(expect.objectContaining({ updated_at: expect.any(String) }))
  })

  it('skips cap-held rows terminally after 7 days so the campaign can finalise', async () => {
    const { db, statements } = makeDb(capHeldRoute({ queuedRemaining: 2 }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, capCampaign({
      send_started_at: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    }))

    expect(result.phase).toBe('cap_skipped')
    const skip = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'update' &&
      s.ops[0].args[0].status === 'skipped_frequency_cap'
    )
    expect(skip).toBeTruthy()
    expect(hasEq(skip, 'status', 'queued')).toBe(true)
  })

  it('finalises normally when the cap is on and the queue is truly empty', async () => {
    const { db, statements } = makeDb(capHeldRoute({ queuedRemaining: 0 }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, capCampaign())

    expect(result.phase).toBe('finalise')
    expect(campaignUpdates(statements)).toContainEqual(expect.objectContaining({ status: 'sent' }))
  })

  const touchStamps = (statements) =>
    statements.filter(s =>
      s.table === 'contacts' &&
      s.ops[0]?.method === 'update' &&
      'last_marketing_touch_at' in s.ops[0].args[0]
    )

  it('stamps last_marketing_touch_at for sent contacts even while the cap is DISABLED', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', 0), makeRecipient('r2', 0)],
    }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-1' },
      { ErrorCode: 0, MessageID: 'pm-2' },
    ])

    await tickCampaignSend(db, campaign) // cap not configured

    const stamps = touchStamps(statements)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].ops.find(o => o.method === 'in').args[1])
      .toEqual(['contact-r1', 'contact-r2'])
  })

  it('does NOT stamp failed/bounced recipients', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 406, Message: 'Inactive recipient' }])

    await tickCampaignSend(db, campaign)

    expect(touchStamps(statements)).toHaveLength(0)
  })

  it('never stamps utility (outbound-stream) sends', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, capCampaign({ postmark_stream: 'outbound' }))

    expect(touchStamps(statements)).toHaveLength(0)
  })
})

// ── EMAIL-NOTRACK.1 — marketing tracking must not move ────────────
//
// The split lives in postmark.js resolveTracking(), but the thing that
// actually has to hold is end-to-end: a Marketing campaign's real
// emailBatch, fed through the REAL sendBatch, must still produce
// TrackOpens:true + TrackLinks:'HtmlOnly'. Asserting only on the pure
// helper would miss campaign-sender silently dropping `stream` from the
// email object — which is exactly what would turn every campaign
// untracked. So this reaches for vi.importActual and closes the loop.
describe('EMAIL-NOTRACK.1 — campaign-sender output is unchanged', () => {
  const realBatchPayload = async (emails) => {
    const { sendBatch: realSendBatch } = await vi.importActual('./postmark.js')
    process.env.POSTMARK_API_KEY = 'test-token'
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => emails.map((_, i) => ({ ErrorCode: 0, MessageID: `pm-${i}` })),
    })
    await realSendBatch(emails)
    const payload = JSON.parse(spy.mock.calls[0][1].body)
    spy.mockRestore()
    return payload
  }

  it('a MARKETING campaign still hands sendBatch an explicit broadcast stream', async () => {
    // If this regresses to an omitted stream, tracking silently turns off
    // for every campaign — the pure helper's tests would still pass.
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign) // postmark_stream: null → broadcast

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].stream).toBe('broadcast')
    expect(batch[0].trackEngagement).toBeUndefined()
  })

  it('that batch, through the REAL sendBatch, still tracks opens and clicks', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const payload = await realBatchPayload(sendBatch.mock.calls[0][0])
    expect(payload[0].MessageStream).toBe('broadcast')
    expect(payload[0].TrackOpens).toBe(true)
    expect(payload[0].TrackLinks).toBe('HtmlOnly')
  })

  it('a UTILITY (outbound-stream) campaign is the one path that loses tracking', async () => {
    // Documented, not accidental: a Utility campaign is gated on
    // email_administrative consent, not marketing consent, so it is
    // transactional mail wearing campaign machinery. Its open/click
    // stats will read zero from here on. `trackEngagement: true` on the
    // email object is the one-line restore if that is ever wanted.
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    const payload = await realBatchPayload(sendBatch.mock.calls[0][0])
    expect(payload[0].MessageStream).toBe('outbound')
    expect(payload[0].TrackOpens).toBe(false)
    expect(payload[0].TrackLinks).toBe('None')
  })
})

// ── CAMPAIGN-RESEND (mig 506) — resend children ───────────────────
//
// A campaign with parent_campaign_id set is a resend-to-non-openers
// child. Its populate step ignores the audience DSL and instead reads
// the PARENT's unopened sent/delivered recipients, re-intersected with
// contact_location_audience so consent / suppression / bounces since
// the original send are honoured. Resends also bypass the marketing
// frequency cap (deliberate operator action) but still stamp
// last_marketing_touch_at.
describe('tickCampaignSend — resend children (CAMPAIGN-RESEND)', () => {
  const childCampaign = (over = {}) => ({
    ...campaign,
    id: 'child-1',
    parent_campaign_id: 'parent-1',
    ...over,
  })

  const touchStamps = (statements) =>
    statements.filter(s =>
      s.table === 'contacts' &&
      s.ops[0]?.method === 'update' &&
      'last_marketing_touch_at' in s.ops[0].args[0]
    )

  // Populate-phase route: the child has no recipients yet; the parent's
  // non-openers come from campaign_recipients; the view returns survivors.
  const resendPopulateRoute = ({ nonOpeners, survivors }) => (state) => {
    if (state.table === 'campaign_recipients') {
      const first = state.ops[0]
      if (first.method === 'select' && first.args[1]?.head) return { count: 0 }
      if (first.method === 'select' && hasEq(state, 'campaign_id', 'parent-1')) return { data: nonOpeners }
      return {}
    }
    if (state.table === 'contact_location_audience') return { data: survivors }
    return {}
  }

  it('populates from the parent’s non-openers ∩ audience view, not the audience DSL', async () => {
    const { db, statements } = makeDb(resendPopulateRoute({
      nonOpeners: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }, { contact_id: 'c-3' }],
      survivors: [{ id: 'c-1' }, { id: 'c-3' }],
    }))

    const result = await tickCampaignSend(db, childCampaign({ send_started_at: null }))

    expect(result.phase).toBe('populate')
    expect(buildAudienceQueryAsync).not.toHaveBeenCalled()

    // Parent non-opener read: unopened + sent/delivered only.
    const parentRead = statements.find(s =>
      s.table === 'campaign_recipients' && hasEq(s, 'campaign_id', 'parent-1'))
    expect(parentRead.ops.find(o => o.method === 'is').args).toEqual(['opened_at', null])
    expect(parentRead.ops.find(o => o.method === 'in').args).toEqual(['status', ['sent', 'delivered']])

    // View re-check carries the full marketing gate set.
    const viewRead = statements.find(s => s.table === 'contact_location_audience')
    expect(hasEq(viewRead, 'audience_location_id', 'loc-1')).toBe(true)
    expect(hasEq(viewRead, 'loc_email_marketing', true)).toBe(true)
    expect(viewRead.ops.find(o => o.method === 'not').args)
      .toEqual(['email_status', 'in', '("bounced","complained")'])
    expect(viewRead.ops.find(o => o.method === 'is').args).toEqual(['email_suppressed_at', null])
    expect(viewRead.ops.find(o => o.method === 'in').args).toEqual(['id', ['c-1', 'c-2', 'c-3']])

    // Only survivors become recipient rows.
    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'upsert')
    expect(insert.ops[0].args[0]).toEqual([
      { campaign_id: 'child-1', contact_id: 'c-1', status: 'queued' },
      { campaign_id: 'child-1', contact_id: 'c-3', status: 'queued' },
    ])
    expect(campaignUpdates(statements)).toContainEqual(
      expect.objectContaining({ status: 'sending', total_recipients: 2 }))
  })

  it('finalises as sent-with-zero when nobody survives the view re-check', async () => {
    const { db, statements } = makeDb(resendPopulateRoute({
      nonOpeners: [{ contact_id: 'c-1' }],
      survivors: [],
    }))

    const result = await tickCampaignSend(db, childCampaign({ send_started_at: null }))

    expect(result).toEqual({ phase: 'populate', sent: 0 })
    expect(campaignUpdates(statements)).toContainEqual(
      expect.objectContaining({ status: 'sent', total_recipients: 0 }))
    expect(statements.some(s => s.table === 'campaign_recipients' && ['insert', 'upsert'].includes(s.ops[0].method))).toBe(false)
  })

  it('surfaces a populate error when the parent non-opener read fails', async () => {
    const { db } = makeDb((state) => {
      if (state.table === 'campaign_recipients') {
        const first = state.ops[0]
        if (first.method === 'select' && first.args[1]?.head) return { count: 0 }
        return { data: null, error: { message: 'boom' } }
      }
      return {}
    })

    const result = await tickCampaignSend(db, childCampaign({ send_started_at: null }))
    expect(result.phase).toBe('populate')
    expect(result.error).toMatch(/boom/)
  })

  it('bypasses the frequency cap for a resend child but still stamps the touch', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, childCampaign({
      locations: { name: 'Stillorgan', settings: { comms_frequency_cap: { enabled: true, min_hours_between: 24 } } },
    }))

    // No cap filter on the queued fetch even though the cap is enabled…
    const chunk = statements.find(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'select' &&
      !s.ops[0].args[1]?.head &&
      hasEq(s, 'status', 'queued'))
    expect(chunk.ops.some(o => o.method === 'or' && String(o.args[0]).includes('last_marketing_touch_at'))).toBe(false)

    // …and the successful send still consumes the contact's window.
    const stamps = touchStamps(statements)
    expect(stamps).toHaveLength(1)
    expect(stamps[0].ops.find(o => o.method === 'in').args[1]).toEqual(['contact-r1'])
  })
})

describe('tickCampaignSend — audience populate pagination (CAMPAIGN.14)', () => {
  // 8 Aug 2026 — the "SUMMER SALE" campaign reached 1,000 of 3,053
  // matched contacts. The CAMPAIGN.11 pagination loop had no ORDER BY,
  // so PostgREST pages could overlap/skip; a duplicated contact then
  // blew up the recipient insert on the (campaign_id, contact_id)
  // unique key AFTER chunk 1, leaving exactly 1,000 rows behind.
  function pagedAudience(pages) {
    const orderCalls = []
    const rangeCalls = []
    let call = 0
    const query = {
      order: vi.fn((...args) => { orderCalls.push(args); return query }),
      range: vi.fn(async (from, to) => {
        rangeCalls.push([from, to])
        const data = pages[call] ?? []
        call++
        return { data, error: null }
      }),
    }
    buildAudienceQueryAsync.mockImplementation(async () => ({ query }))
    return { orderCalls, rangeCalls }
  }

  it('orders every audience page by id so .range() pagination is stable', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeContact(`p${i}`))
    const { orderCalls, rangeCalls } = pagedAudience([page1, []])
    const { db } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, { ...campaign, send_started_at: null })

    expect(rangeCalls).toEqual([[0, 999], [1000, 1999]])
    expect(orderCalls).toHaveLength(2)
    for (const args of orderCalls) {
      expect(args[0]).toBe('id')
      expect(args[1]).toEqual(expect.objectContaining({ ascending: true }))
    }
  })

  it('dedupes contacts that appear on more than one page before inserting', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeContact(`p${i}`))
    // Page 2 overlaps page 1 (p998, p999) then adds three new contacts.
    const page2 = [makeContact('p998'), makeContact('p999'), makeContact('n1'), makeContact('n2'), makeContact('n3')]
    pagedAudience([page1, page2])
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, { ...campaign, send_started_at: null })

    const inserts = statements.filter(s => s.table === 'campaign_recipients' && s.ops[0].method === 'upsert')
    const rows = inserts.flatMap(s => s.ops[0].args[0])
    expect(rows).toHaveLength(1003)
    expect(new Set(rows.map(r => r.contact_id)).size).toBe(1003)

    const update = campaignUpdates(statements).find(u => 'total_recipients' in u)
    expect(update.total_recipients).toBe(1003)
  })

  it('surfaces a populate status-update failure instead of swallowing it', async () => {
    pagedAudience([[makeContact('c1')], []])
    const base = abRouteFor({ count: 0 })
    const { db } = makeDb((state) => {
      if (state.table === 'campaigns' && state.ops[0]?.method === 'update' && 'total_recipients' in (state.ops[0].args[0] || {})) {
        return { error: { message: 'column campaigns.send_started_at does not exist' } }
      }
      return base(state)
    })

    const result = await tickCampaignSend(db, { ...campaign, send_started_at: null })

    expect(result.phase).toBe('populate')
    expect(result.error).toMatch(/send_started_at/)
  })
})

// ── POPFIX.1 — populate must be RESUMABLE ──────────────────────────────────
//
// Recipient rows go in as 1,000-row chunks. If chunk N fails (transient DB
// error, Vercel timeout, deploy mid-tick) chunks 1..N-1 are already committed.
// The old guard asked "does this campaign have ANY recipient rows?", so the
// next tick saw rows, skipped populate entirely, sent only the partial set and
// finalised 'sent' with plausible-looking stats — the same outcome as the
// 8 Aug 2026 truncation, through the one path CAMPAIGN.14 did not close.
//
// The guard is now campaigns.send_started_at (mig 507), which is stamped only
// AFTER every chunk has succeeded — i.e. it means "populate finished" — and
// the write is an idempotent upsert so a re-run finishes the job instead of
// colliding on (campaign_id, contact_id).
describe('tickCampaignSend — resumable populate (POPFIX.1)', () => {
  // Audience of `n` contacts served through the paginated range query.
  function audienceOf(n) {
    const contacts = Array.from({ length: n }, (_, i) => makeContact(`p${String(i).padStart(4, '0')}`))
    const query = {
      order: vi.fn(() => query),
      range: vi.fn(async (from, to) => ({ data: contacts.slice(from, to + 1), error: null })),
    }
    buildAudienceQueryAsync.mockImplementation(async () => ({ query }))
    return contacts
  }

  // A campaign_recipients table that behaves like the real one: the
  // (campaign_id, contact_id) unique key rejects a plain INSERT of a pair that
  // already exists, and an ignoreDuplicates upsert leaves the stored row
  // EXACTLY as it was (status, ab_variant and any send progress intact).
  function makeWorld({ seed = [], failOnWriteCall = 0 } = {}) {
    const world = {
      rows: new Map(seed.map(r => [r.contact_id, { ...r }])),
      writes: [],
      campaignUpdates: [],
      sendStartedAt: null,
    }
    const route = (state) => {
      if (state.table === 'campaign_recipients') {
        const first = state.ops[0]
        if (first.method === 'select' && first.args[1]?.head) return { count: world.rows.size }
        if (first.method === 'insert' || first.method === 'upsert') {
          world.writes.push({ method: first.method, options: first.args[1] ?? null, rows: first.args[0] })
          if (world.writes.length === failOnWriteCall) return { error: { message: 'deadlock detected' } }
          const ignoreDuplicates = first.method === 'upsert' && first.args[1]?.ignoreDuplicates === true
          for (const row of first.args[0]) {
            if (world.rows.has(row.contact_id)) {
              if (first.method === 'insert') {
                return { error: { message: 'duplicate key value violates unique constraint "campaign_recipients_campaign_id_contact_id_key"' } }
              }
              if (ignoreDuplicates) continue
            }
            world.rows.set(row.contact_id, { ...row })
          }
          return {}
        }
        return { data: [] }
      }
      if (state.table === 'campaigns' && state.ops[0]?.method === 'update') {
        const payload = state.ops[0].args[0]
        world.campaignUpdates.push(payload)
        if (payload.send_started_at) world.sendStartedAt = payload.send_started_at
        return {}
      }
      return { data: [] }
    }
    return { world, route }
  }

  // The campaign row as the cron re-reads it on the NEXT tick.
  const asStored = (world, base = campaign) => ({ ...base, send_started_at: world.sendStartedAt })

  it('finishes a populate that died mid-chunk on the next tick (full audience, not the partial set)', async () => {
    audienceOf(2500)
    const { world, route } = makeWorld({ failOnWriteCall: 2 })
    const { db } = makeDb(route)

    // Tick 1 — chunk 1 commits, chunk 2 dies. 1,000 of 2,500 rows on disk
    // and NO send_started_at stamp.
    const first = await tickCampaignSend(db, { ...campaign, send_started_at: null })
    expect(first.phase).toBe('populate')
    expect(first.error).toMatch(/deadlock/)
    expect(world.rows.size).toBe(1000)
    expect(world.sendStartedAt).toBeNull()

    // Tick 2 — must RESUME populate, not send the partial set.
    const second = await tickCampaignSend(db, asStored(world))

    expect(second.error).toBeUndefined()
    expect(world.rows.size).toBe(2500)
    expect(world.campaignUpdates).toContainEqual(
      expect.objectContaining({ status: 'sending', total_recipients: 2500 }))
    expect(world.sendStartedAt).toBeTruthy()
  })

  it('skips populate entirely once send_started_at is stamped (no audience query, no write)', async () => {
    audienceOf(10)
    const { world, route } = makeWorld({
      seed: Array.from({ length: 10 }, (_, i) => ({
        contact_id: `contact-p${String(i).padStart(4, '0')}`, campaign_id: 'camp-1', status: 'sent',
      })),
    })
    const { db } = makeDb(route)

    await tickCampaignSend(db, { ...campaign, send_started_at: '2026-07-10T09:00:00.000Z' })

    expect(buildAudienceQueryAsync).not.toHaveBeenCalled()
    expect(world.writes).toHaveLength(0)
    expect(world.campaignUpdates.some(u => 'total_recipients' in u)).toBe(false)
  })

  it('self-heals a campaign whose chunks all landed but whose stamp failed', async () => {
    // CAMPAIGN.14 surfaced exactly this: every recipient row on disk, no
    // send_started_at. Populate re-runs as a no-op upsert and re-stamps.
    audienceOf(10)
    const seed = Array.from({ length: 10 }, (_, i) => ({
      contact_id: `contact-p${String(i).padStart(4, '0')}`, campaign_id: 'camp-1', status: 'queued',
    }))
    const { world, route } = makeWorld({ seed })
    const { db } = makeDb(route)

    const result = await tickCampaignSend(db, { ...campaign, send_started_at: null })

    expect(result).toEqual({ phase: 'populate', sent: 0 })
    expect(world.writes).toHaveLength(1)          // the upsert ran…
    expect(world.rows.size).toBe(10)              // …and added nothing
    expect(world.campaignUpdates).toContainEqual(
      expect.objectContaining({ status: 'sending', total_recipients: 10 }))
    expect(world.sendStartedAt).toBeTruthy()
  })

  it('leaves an already-SENT recipient row untouched when populate re-runs', async () => {
    // The whole reason the write is ignoreDuplicates rather than a plain
    // upsert: resetting a 'sent' row to 'queued' would re-send that person.
    audienceOf(10)
    const seed = Array.from({ length: 9 }, (_, i) => ({
      contact_id: `contact-p${String(i).padStart(4, '0')}`,
      campaign_id: 'camp-1',
      status: i === 0 ? 'sent' : 'queued',
      postmark_message_id: i === 0 ? 'pm-already-delivered' : null,
      attempts: i === 0 ? 1 : 0,
    }))
    const { world, route } = makeWorld({ seed })   // p0009 is missing
    const { db } = makeDb(route)

    await tickCampaignSend(db, { ...campaign, send_started_at: null })

    // The resumed populate added only the missing row…
    expect(world.rows.size).toBe(10)
    expect(world.rows.get('contact-p0009').status).toBe('queued')
    // …and the delivered one is byte-for-byte what it was.
    expect(world.rows.get('contact-p0000')).toEqual({
      contact_id: 'contact-p0000',
      campaign_id: 'camp-1',
      status: 'sent',
      postmark_message_id: 'pm-already-delivered',
      attempts: 1,
    })
    expect(world.sendStartedAt).toBeTruthy()
  })

  it('writes recipients with the (campaign_id, contact_id) conflict target and ignoreDuplicates', async () => {
    // Pinned: a plain .insert() here reintroduces the abort-on-collision that
    // truncated the 8 Aug send.
    audienceOf(3)
    const { db, statements } = makeDb(makeWorld().route)

    await tickCampaignSend(db, { ...campaign, send_started_at: null })

    const writes = statements.filter(s =>
      s.table === 'campaign_recipients' && ['insert', 'upsert'].includes(s.ops[0]?.method))
    expect(writes).toHaveLength(1)
    expect(writes[0].ops[0].method).toBe('upsert')
    expect(writes[0].ops[0].args[1]).toEqual({
      onConflict: 'campaign_id,contact_id',
      ignoreDuplicates: true,
    })
  })

  it('assigns a contact the SAME ab_variant on a second populate pass', async () => {
    // assignAbVariants is a deterministic FNV-1a hash of the contact id, so a
    // resumed populate must not reshuffle the test slice.
    const variantsOfLastWrite = (world) => {
      const rows = world.writes[world.writes.length - 1].rows
      return new Map(rows.map(r => [r.contact_id, r.ab_variant]))
    }

    audienceOf(20)
    const firstRun = makeWorld()
    const passOne = makeDb(firstRun.route)
    await tickCampaignSend(passOne.db, abCampaign({ send_started_at: null }))
    const before = variantsOfLastWrite(firstRun.world)

    // Second pass over the SAME audience with the rows already on disk.
    audienceOf(20)
    const secondRun = makeWorld({ seed: [...firstRun.world.rows.values()] })
    const passTwo = makeDb(secondRun.route)
    await tickCampaignSend(passTwo.db, abCampaign({ send_started_at: null }))
    const after = variantsOfLastWrite(secondRun.world)

    expect([...before.values()].filter(Boolean)).not.toHaveLength(0)  // a slice exists
    expect(after).toEqual(before)
    // And the stored rows were never rewritten by the second pass.
    for (const [contactId, variant] of before) {
      expect(secondRun.world.rows.get(contactId).ab_variant).toBe(variant)
    }
  })
})

// ── COMMSFIX.C.1 — email_sends must exist before the webhook arrives ────────
//
// Prod evidence (campaign f66d6576): delivered 48/1000 while ~950 really
// delivered. Postmark's Delivery webhook lands within a second or two of the
// batch response; the email_sends rows were written only AFTER a sequential
// per-recipient UPDATE loop over the whole 500-row chunk, so the early
// webhooks found no row, silently no-opped, and recalculate_campaign_stats
// then baked the loss in. The insert must be the FIRST write after sendBatch,
// and its error must be checked — it was thrown away entirely.
describe('tickCampaignSend — email_sends insert ordering + error handling (COMMSFIX.C.1)', () => {
  const indexOfInsert = (statements) =>
    statements.findIndex(s => s.table === 'email_sends' && s.ops[0]?.method === 'insert')
  const indexOfSentUpdate = (statements) =>
    statements.findIndex(s =>
      s.table === 'campaign_recipients' &&
      s.ops[0]?.method === 'update' &&
      s.ops[0].args[0]?.status === 'sent')

  it('inserts the email_sends rows BEFORE the per-recipient status-update loop', async () => {
    const { db, statements } = makeDb(routeFor({
      candidates: [makeRecipient('r1', 0), makeRecipient('r2', 0)],
    }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-1' },
      { ErrorCode: 0, MessageID: 'pm-2' },
    ])

    await tickCampaignSend(db, campaign)

    const insertIdx = indexOfInsert(statements)
    const sentIdx = indexOfSentUpdate(statements)
    expect(insertIdx).toBeGreaterThan(-1)
    expect(sentIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeLessThan(sentIdx)
    // Both successful sends are in that single insert.
    expect(statements[insertIdx].ops[0].args[0].map(r => r.postmark_message_id))
      .toEqual(['pm-1', 'pm-2'])
  })

  it('retries the email_sends insert once when it fails, and stays quiet if the retry works', async () => {
    let attempts = 0
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db, statements } = makeDb((state) => {
      if (state.table === 'email_sends' && state.ops[0]?.method === 'insert') {
        attempts++
        return attempts === 1 ? { error: { message: 'deadlock detected' } } : { error: null }
      }
      return base(state)
    })
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    expect(attempts).toBe(2)
    const stamped = statements.filter(s =>
      s.table === 'campaigns' && s.ops[0]?.method === 'update' && 'last_error' in (s.ops[0].args[0] || {}))
    expect(stamped).toHaveLength(0)
  })

  it('records the failure loudly on the campaign when both insert attempts fail', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = routeFor({ candidates: [makeRecipient('r1', 0)] })
    const { db, statements } = makeDb((state) => {
      if (state.table === 'email_sends' && state.ops[0]?.method === 'insert') {
        return { error: { message: 'permission denied for table email_sends' } }
      }
      return base(state)
    })
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const inserts = statements.filter(s => s.table === 'email_sends' && s.ops[0]?.method === 'insert')
    expect(inserts).toHaveLength(2)
    const stamped = statements.find(s =>
      s.table === 'campaigns' && s.ops[0]?.method === 'update' && 'last_error' in (s.ops[0].args[0] || {}))
    expect(stamped).toBeTruthy()
    expect(stamped.ops[0].args[0].last_error).toMatch(/email_sends/)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

// COMMSFIX.C.4 — the unsubscribe link a campaign sends must say WHICH campaign.
describe('tickCampaignSend — unsubscribe URL carries the campaign id (COMMSFIX.C.4)', () => {
  it('passes the campaign id into the broadcast unsubscribe URL', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const batch = sendBatch.mock.calls[0][0]
    expect(batch[0].unsubscribeUrl).toContain('c=camp-1')
    expect(batch[0].unsubscribeUrl).toContain('l=loc-1')
  })

  it('sends no unsubscribe URL at all on the utility stream', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    expect(sendBatch.mock.calls[0][0][0].unsubscribeUrl).toBeNull()
  })
})

// ── UNSUBTOKEN.2 — a marketing email with no working opt-out never ships
//
// buildUnsubscribeUrl used to fall back to contact.id when the contact had no
// contact_preferences row. /api/unsubscribe/[token] resolves the token column
// and nothing else, so that link 404s — and so does the List-Unsubscribe
// header built from it. Mig 532 backfilled every contact, so nothing today is
// in this state; this closes the door on the next one (a half-merge, a direct
// INSERT into contacts, a restore).
//
// The recipient is FAILED, not cancelled: 'cancelled' is the consent-suppression
// outcome and is a normal, expected result an operator should ignore. This is a
// data fault that needs fixing, so it takes the visible path — a terminal row
// with last_error, plus campaigns.last_error, which the campaign UI renders.
describe('tickCampaignSend — refuses a broadcast with no unsubscribe token (UNSUBTOKEN.2)', () => {
  const tokenless = (id) => {
    const r = makeRecipient(id, 0)
    r.contact.contact_preferences = []
    return r
  }

  it('does not send, and marks the recipient failed with a last_error', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [tokenless('r1')] }))
    sendBatch.mockResolvedValue([])

    const result = await tickCampaignSend(db, campaign)

    expect(sendBatch).not.toHaveBeenCalled()
    const updates = recipientUpdates(statements, 'r1')
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'failed',
      last_error: expect.stringMatching(/unsubscribe token/i),
    }))
    expect(result.sent).toBe(0)
  })

  it('stamps campaigns.last_error so the fault is visible in the UI, not just the log', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [tokenless('r1')] }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, campaign)

    const campaignErrs = statements.filter(s =>
      s.table === 'campaigns' && s.ops[0]?.method === 'update' && s.ops[0].args[0]?.last_error,
    ).map(s => s.ops[0].args[0].last_error)
    expect(campaignErrs.some(m => /unsubscribe[ _]token/i.test(m))).toBe(true)
    // and it names the contact, so the operator can go and look at the row
    expect(campaignErrs.some(m => m.includes('contact-r1'))).toBe(true)
  })

  it('still sends the recipients that DO have a token — one bad row is not a chunk failure', async () => {
    const { db, statements } = makeDb(routeFor({ candidates: [tokenless('r1'), makeRecipient('r2', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-2' }])

    await tickCampaignSend(db, campaign)

    expect(sendBatch).toHaveBeenCalledTimes(1)
    const batch = sendBatch.mock.calls[0][0]
    expect(batch).toHaveLength(1)
    expect(batch[0].to).toBe('r2@x.ie')
    expect(recipientUpdates(statements, 'r1'))
      .toContainEqual(expect.objectContaining({ status: 'failed' }))
  })

  it('does NOT refuse a utility/outbound send — that stream carries no unsubscribe chrome by design', async () => {
    const { db } = makeDb(routeFor({ candidates: [tokenless('r1')] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    expect(sendBatch).toHaveBeenCalledTimes(1)
    expect(sendBatch.mock.calls[0][0][0].unsubscribeUrl).toBeNull()
  })

  it('never mints a /preferences/<contact-id> URL either — that endpoint is token-only too', async () => {
    // Same defect, same file: the preference-centre API resolves
    // contact_preferences.unsubscribe_token and nothing else.
    const { db } = makeDb(routeFor({ candidates: [tokenless('r1')] }))
    sendBatch.mockResolvedValue([])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    const body = sendBatch.mock.calls[0]?.[0]?.[0]?.htmlBody ?? ''
    expect(body).not.toContain('/preferences/contact-r1')
  })
})

// ── COMMSFIX.D.4b — subject-line merge tags get the same extras the body does
//
// The editor's merge-tag panel says "Use these in your subject line or email
// body" and lists {{location_name}}, {{unsubscribe_url}}, {{preference_url}} —
// but the subject was merged with applyMergeTags(rawSubject, contact) and NO
// extras, so applyMergeTags resolved all three to '' fallbacks. A subject of
// 'News from {{location_name}}' shipped as 'News from ' to the whole audience,
// while the identical tag in the body worked. Audit 2026-08-09 composer-ux.
describe('tickCampaignSend — subject merge tags resolve the location (COMMSFIX.D.4b)', () => {
  it('renders {{location_name}} in the subject, not an empty string', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, subject: 'Your week at {{location_name}}' })

    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Your week at Stillorgan')
  })

  it('still merges contact fields in the subject (no regression)', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, subject: 'Hi {{first_name}}, news from {{location_name}}' })

    expect(sendBatch.mock.calls[0][0][0].subject).toBe('Hi Alice, news from Stillorgan')
  })

  it('resolves the preference url in a subject too', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, subject: 'See {{preference_url}}' })

    expect(sendBatch.mock.calls[0][0][0].subject).toContain('https://crm.test/preferences/')
  })
})

// WEBVIEW.1 — the view-in-browser link has to actually reach the wire, at the
// top of the body, or it does not solve the problem it exists for (Gmail
// clipping the bottom of the message together with the unsubscribe footer).
describe('tickCampaignSend — view in browser (WEBVIEW.1)', () => {
  const ORIGINAL_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY
  beforeEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-secret' })
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SECRET
  })

  it('puts a /view-email/ link in the html of a broadcast', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const { htmlBody } = sendBatch.mock.calls[0][0][0]
    expect(htmlBody).toContain('https://crm.test/view-email/')
  })

  it('places it ABOVE the unsubscribe footer — a footer link would be clipped too', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, campaign)

    const { htmlBody } = sendBatch.mock.calls[0][0][0]
    expect(htmlBody.indexOf('/view-email/')).toBeLessThan(htmlBody.indexOf('/unsubscribe/'))
  })

  it('carries no contact id — the same URL for every recipient on the send', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0), makeRecipient('r2', 0)] }))
    sendBatch.mockResolvedValue([
      { ErrorCode: 0, MessageID: 'pm-1' },
      { ErrorCode: 0, MessageID: 'pm-2' },
    ])

    await tickCampaignSend(db, campaign)

    const urls = sendBatch.mock.calls[0][0].map(
      e => e.htmlBody.match(/https:\/\/crm\.test\/view-email\/[A-Za-z0-9_.-]+/)[0],
    )
    expect(urls[0]).toBe(urls[1])
  })

  it('adds nothing to a utility (outbound) email', async () => {
    const { db } = makeDb(routeFor({ candidates: [makeRecipient('r1', 0)] }))
    sendBatch.mockResolvedValue([{ ErrorCode: 0, MessageID: 'pm-1' }])

    await tickCampaignSend(db, { ...campaign, postmark_stream: 'outbound' })

    expect(sendBatch.mock.calls[0][0][0].htmlBody).not.toContain('/view-email/')
  })
})
