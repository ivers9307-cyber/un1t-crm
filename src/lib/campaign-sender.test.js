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
} = {}) {
  return (state) => {
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
    buildAudienceQueryAsync.mockResolvedValue({
      query: { range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })) },
    })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, campaign)

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'insert')
    expect(insert).toBeTruthy()
    for (const row of insert.ops[0].args[0]) {
      expect(row).not.toHaveProperty('ab_variant')
    }
  })
})

describe('tickCampaignSend — A/B populate (slice assignment at populate time)', () => {
  it('assigns ab_variant to ~pct% of recipients, half a / half b, remainder null', async () => {
    const contacts = Array.from({ length: 10 }, (_, i) => makeContact(`c${i + 1}`))
    buildAudienceQueryAsync.mockResolvedValue({
      query: { range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })) },
    })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, abCampaign()) // pct 20 of 10 → slice of 2

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'insert')
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
    buildAudienceQueryAsync.mockResolvedValue({
      query: { range: vi.fn(async (from) => ({ data: from === 0 ? contacts : [], error: null })) },
    })
    const { db, statements } = makeDb(abRouteFor({ count: 0 }))

    await tickCampaignSend(db, abCampaign())

    const insert = statements.find(s => s.table === 'campaign_recipients' && s.ops[0].method === 'insert')
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

  it('ties (and zero-open data) go to A', async () => {
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
