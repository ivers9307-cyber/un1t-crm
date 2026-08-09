// COMMS-AUDIT 2026-07-10 — campaigns.total_unsubscribed was never
// incremented anywhere: the SubscriptionChange handler applied the
// opt-out (via applyMarketingPreferencesBulk) but only selected
// contact_id off the email_sends row, never campaign_id, and never
// called increment_campaign_metric — while every other campaign counter
// (delivered/opened/clicked/bounced/complained) does. These tests pin
// the wiring: an unsubscribe that ORIGINATED from a campaign email
// increments that campaign's total_unsubscribed, exactly once (only
// when the flag actually flipped, so replays / already-unsubscribed
// contacts don't inflate it).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./marketing-consent.js', () => ({
  applyMarketingPreferencesBulk: vi.fn(),
}))
vi.mock('./bca-events.js', () => ({
  findBcaSubmissionByMessageId: vi.fn(),
  recordBcaPostmarkEvent: vi.fn(),
}))

import { processPostmarkEvent } from './postmark-webhook-processor.js'
import { applyMarketingPreferencesBulk } from './marketing-consent.js'

function stubDb({ send, rpcCalls }) {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: table === 'email_sends' ? send : null, error: null }),
        }),
      }),
      update: () => ({
        eq: () => ({
          in: () => Promise.resolve({ error: null }),
          then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
        }),
      }),
    }),
    rpc: (fn, args) => {
      rpcCalls.push([fn, args])
      return Promise.resolve({ error: null })
    },
  }
}

const EVENT = {
  RecordType: 'SubscriptionChange',
  MessageID: 'pm-1',
  SuppressSending: true,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// EMAIL-HYGIENE.1 — any Open or Click clears the engagement-hygiene
// suppression stamp (contacts.email_suppressed_at, mig 395). The write
// is guarded with .not('email_suppressed_at','is',null) so the common
// case (not suppressed) is a filtered no-op, not a row write.
function stubEngagementDb({ send }) {
  const contactUpdates = []
  return {
    contactUpdates,
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({
            data: table === 'email_sends' ? send : null,
            error: null,
          }),
        }),
      }),
      update: (values) => {
        const filters = []
        const chain = {
          eq: (col, val) => { filters.push(['eq', col, val]); return chain },
          in: (col, val) => { filters.push(['in', col, val]); return chain },
          not: (col, op, val) => { filters.push(['not', col, op, val]); return chain },
          then: (resolve, reject) => {
            if (table === 'contacts') contactUpdates.push({ values, filters })
            return Promise.resolve({ error: null }).then(resolve, reject)
          },
        }
        return chain
      },
    }),
    rpc: () => Promise.resolve({ error: null }),
  }
}

describe('processPostmarkEvent — Open/Click clear the hygiene suppression stamp (EMAIL-HYGIENE.1)', () => {
  it.each(['Open', 'Click'])('%s clears email_suppressed_at for the contact, guarded to skip already-null rows', async (recordType) => {
    const db = stubEngagementDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null } })
    const r = await processPostmarkEvent(db, { RecordType: recordType, MessageID: 'pm-9', FirstOpen: true })
    expect(r.ok).toBe(true)
    const clear = db.contactUpdates.find((u) => 'email_suppressed_at' in u.values)
    expect(clear).toBeTruthy()
    expect(clear.values).toEqual({ email_suppressed_at: null })
    expect(clear.filters).toContainEqual(['eq', 'id', 'c1'])
    // Guard: no-op when already null (no unconditional contact write).
    expect(clear.filters).toContainEqual(['not', 'email_suppressed_at', 'is', null])
  })

  it.each(['Open', 'Click'])('%s with no matching email_sends row never touches contacts', async (recordType) => {
    const db = stubEngagementDb({ send: null })
    const r = await processPostmarkEvent(db, { RecordType: recordType, MessageID: 'pm-9' })
    expect(r.ok).toBe(true)
    expect(db.contactUpdates).toEqual([])
  })
})

describe('processPostmarkEvent — SubscriptionChange', () => {
  it('increments total_unsubscribed for the source campaign when the opt-out actually flipped', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).toHaveBeenCalledWith(db, expect.objectContaining({
      contactId: 'c1',
      prefs: { email_marketing: false },
      source: 'postmark_one_click_unsubscribe',
    }))
    expect(rpcCalls).toContainEqual([
      'increment_campaign_metric',
      { p_campaign_id: 'camp1', p_field: 'total_unsubscribed' },
    ])
  })

  it('does NOT increment when the contact was already unsubscribed (no flip → replay-safe)', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: [] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(rpcCalls).toEqual([])
  })

  it('applies the opt-out but skips the counter for a non-campaign (transactional) send', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: null }, rpcCalls })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, skipped: null, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, EVENT)
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('ignores a re-subscribe (SuppressSending=false)', async () => {
    const rpcCalls = []
    const db = stubDb({ send: { contact_id: 'c1', campaign_id: 'camp1' }, rpcCalls })

    const r = await processPostmarkEvent(db, { ...EVENT, SuppressSending: false })
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })
})

// EMAIL-DELIVERY.1 — the processor hands Delivery / Bounce / SpamComplaint to
// the ticket-thread stamper, and nothing else to it.
//
// Two properties are load-bearing here and neither is about the stamp itself:
//   • The stamp NEVER fails the event. A queue row that fails is retried and
//     eventually dead-lettered (POSTMARK-DLQ.1) — dead-lettering a real bounce
//     because a display column would not write is the hole this must not
//     reopen from the other side.
//   • The existing SUPPRESSION behaviour is untouched. A hard bounce still
//     marks the contact and auto-unsubscribes, whatever the stamper does.
//
// The fake RECORDS THE FILTERS rather than no-opping them: the correlation
// (postmark_message_id + direction) and the severity lattice (the `or=`) are
// the whole feature, and a permissive fake would pass these with both deleted.
function stubDeliveryDb({ send = null, stampError = null } = {}) {
  const messageUpdates = []

  function builder(table) {
    const b = { _op: 'select', _values: null, _filters: [] }
    const settle = (shape) => {
      if (b._op === 'update' && table === 'email_inbox_messages') {
        messageUpdates.push({ values: b._values, filters: b._filters })
        if (stampError) return Promise.resolve({ data: null, error: stampError })
        return Promise.resolve({ data: [], error: null })
      }
      if (b._op === 'update') return Promise.resolve({ data: null, error: null })
      const row = table === 'email_sends' ? send : null
      return Promise.resolve({ data: shape === 'single' ? row : [], error: null })
    }
    b.select = () => (b._op === 'update' ? settle('list') : b)
    b.update = (values) => { b._op = 'update'; b._values = values; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    // COMMSFIX.C.1 — the Delivery handler now guards on .is('delivered_at', null).
    b.is = (col, val) => { b._filters.push(['is', col, val]); return b }
    b.not = (col, op, val) => { b._filters.push(['not', col, op, val]); return b }
    b.or = (expr) => { b._filters.push(['or', expr]); return b }
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }

  return { messageUpdates, from: builder, rpc: () => Promise.resolve({ error: null }) }
}

describe('processPostmarkEvent — ticket delivery stamping (EMAIL-DELIVERY.1)', () => {
  it.each([
    ['Delivery', 'delivered'],
    ['Bounce', 'bounced'],
    ['SpamComplaint', 'complained'],
  ])('%s stamps the outbound ticket message with %s', async (RecordType, expected) => {
    const db = stubDeliveryDb({ send: { contact_id: 'c1', campaign_id: null } })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: [] })

    const r = await processPostmarkEvent(db, { RecordType, MessageID: 'pm-1', Type: 'HardBounce' })

    expect(r.ok).toBe(true)
    const stamp = db.messageUpdates.find(u => u.values?.delivery_status === expected)
    expect(stamp).toBeTruthy()
    // The correlation, in the filters that actually go on the wire.
    expect(stamp.filters).toContainEqual(['eq', 'postmark_message_id', 'pm-1'])
    expect(stamp.filters).toContainEqual(['eq', 'direction', 'outbound'])
    // The lattice, as a WHERE clause.
    expect(stamp.filters.some(([kind, expr]) => kind === 'or' && String(expr).includes('delivery_status.is.null'))).toBe(true)
  })

  it.each(['Open', 'Click', 'SubscriptionChange'])('%s never touches email_inbox_messages', async (RecordType) => {
    // Open and Click are OUT OF SCOPE by decision, not omission. This pins that
    // the stamper has no opinion about them so no later edit can grow one.
    const db = stubDeliveryDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null } })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: [] })

    const r = await processPostmarkEvent(db, { RecordType, MessageID: 'pm-1', SuppressSending: true })

    expect(r.ok).toBe(true)
    expect(db.messageUpdates).toEqual([])
  })

  it('still processes the event when the stamp fails — a bounce is never dead-lettered over a display column', async () => {
    const db = stubDeliveryDb({
      send: { contact_id: 'c1', campaign_id: null },
      stampError: { message: 'column "delivery_status" does not exist' },
    })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, { RecordType: 'Bounce', MessageID: 'pm-1', Type: 'HardBounce' })

    expect(r.ok).toBe(true)
    // The suppression half ran regardless — that is what a bounce is FOR.
    expect(applyMarketingPreferencesBulk).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      source: 'postmark_hard_bounce',
    }))
  })

  it('an event with no MessageID is refused before anything is stamped', async () => {
    const db = stubDeliveryDb({})
    const r = await processPostmarkEvent(db, { RecordType: 'Delivery' })
    expect(r).toEqual({ ok: false, error: 'missing_message_id' })
    expect(db.messageUpdates).toEqual([])
  })
})

// ── COMMSFIX.C.1 — Delivery is a transition, not an event ──────────────────
//
// Two properties, both prod-driven:
//   • total_delivered may only increment when THIS event is the one that moved
//     delivered_at from NULL to a timestamp. Narrowing the webhook dedup key
//     (COMMSFIX.C.2) lets repeats through, so an unguarded increment would
//     start double-counting the moment that lands.
//   • The recipient stamp must also match rows still in 'sending'. The chunk
//     claim flips queued→sending and the Delivery webhook routinely beats the
//     per-recipient 'sent' update, so a 'sending' row was silently skipped.
function stubDeliveryTransitionDb({ updatedRows = [], recipientRows = [] } = {}) {
  const rpcCalls = []
  const sendUpdates = []
  const recipientUpdates = []

  function builder(table) {
    const b = { _op: 'select', _values: null, _filters: [] }
    const settle = (shape) => {
      if (b._op === 'update' && table === 'email_sends') {
        sendUpdates.push({ values: b._values, filters: b._filters })
        return Promise.resolve({ data: updatedRows, error: null })
      }
      if (b._op === 'update' && table === 'campaign_recipients') {
        recipientUpdates.push({ values: b._values, filters: b._filters })
        return Promise.resolve({ data: recipientRows, error: null })
      }
      if (b._op === 'update') return Promise.resolve({ data: null, error: null })
      return Promise.resolve({ data: shape === 'single' ? null : [], error: null })
    }
    b.select = () => (b._op === 'update' ? settle('list') : b)
    b.update = (values) => { b._op = 'update'; b._values = values; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    b.is = (col, val) => { b._filters.push(['is', col, val]); return b }
    b.not = (col, op, val) => { b._filters.push(['not', col, op, val]); return b }
    b.or = (expr) => { b._filters.push(['or', expr]); return b }
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }

  return {
    rpcCalls, sendUpdates, recipientUpdates,
    from: builder,
    rpc: (fn, args) => { rpcCalls.push([fn, args]); return Promise.resolve({ error: null }) },
  }
}

const DELIVERY = { RecordType: 'Delivery', MessageID: 'pm-d1', DeliveredAt: '2026-08-09T10:00:00Z' }

describe('processPostmarkEvent — Delivery transition guard (COMMSFIX.C.1)', () => {
  it('increments total_delivered when the update actually flipped delivered_at NULL → set', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [{ id: 's1', campaign_id: 'camp1' }] })

    const r = await processPostmarkEvent(db, DELIVERY)

    expect(r.ok).toBe(true)
    expect(db.rpcCalls).toContainEqual([
      'increment_campaign_metric',
      { p_campaign_id: 'camp1', p_field: 'total_delivered' },
    ])
    // The guard has to be on the wire, not in JS — a second worker must lose.
    const stamp = db.sendUpdates.find(u => u.values?.status === 'delivered')
    expect(stamp.filters).toContainEqual(['is', 'delivered_at', null])
  })

  it('does NOT increment when the row was already delivered (replayed event)', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [] })

    const r = await processPostmarkEvent(db, DELIVERY)

    expect(r.ok).toBe(true)
    expect(db.rpcCalls).toEqual([])
  })

  it('stamps campaign_recipients rows still in sending, not just sent/queued', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [{ id: 's1', campaign_id: null }] })

    await processPostmarkEvent(db, DELIVERY)

    const stamp = db.recipientUpdates.find(u => u.values?.status === 'delivered')
    expect(stamp).toBeTruthy()
    const statuses = stamp.filters.find(([kind, col]) => kind === 'in' && col === 'status')[2]
    expect(statuses).toEqual(expect.arrayContaining(['sent', 'queued', 'sending']))
  })
})

// ── COMMSFIX.C.3 — the contact engagement RPCs were failing in total silence ──
//
// increment_contact_opens / increment_contact_clicks were called from here but
// NEVER EXISTED in the database (a live pg_proc check confirmed it; only a
// passing mention in mig 314's comments). Two layers hid it: `try { await } {}`
// swallowed the throw, and supabase-js reports PostgREST errors in the RESULT,
// not by throwing, so even without the catch nothing would have surfaced. The
// columns they feed — contacts.total_emails_opened / total_emails_clicked — are
// live AudienceBuilder fields, so 'Emails Clicked > 0' matched nobody and
// 'Emails Opened = 0' swept in ~1,900 contacts who do open. Mig 508 creates the
// functions; this pins that a future failure is at least LOUD.
function stubRpcFailureDb({ send, failing }) {
  const calls = []
  function builder(table) {
    const b = { _op: 'select' }
    const settle = (shape) => {
      if (b._op === 'update') return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: shape === 'single' ? (table === 'email_sends' ? send : null) : [], error: null })
    }
    b.select = () => (b._op === 'update' ? settle('list') : b)
    b.update = () => { b._op = 'update'; return b }
    b.eq = () => b
    b.in = () => b
    b.is = () => b
    b.not = () => b
    b.or = () => b
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }
  return {
    calls,
    from: builder,
    rpc: (fn) => {
      calls.push(fn)
      return fn === failing
        ? Promise.resolve({ error: { message: `function public.${fn} does not exist` } })
        : Promise.resolve({ error: null })
    },
  }
}

describe('processPostmarkEvent — contact engagement RPC failures are logged (COMMSFIX.C.3)', () => {
  it('logs when increment_contact_opens fails instead of swallowing it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubRpcFailureDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null }, failing: 'increment_contact_opens' })

    const r = await processPostmarkEvent(db, { RecordType: 'Open', MessageID: 'pm-1', FirstOpen: true })

    expect(r.ok).toBe(true)
    expect(db.calls).toContain('increment_contact_opens')
    expect(err.mock.calls.flat().join(' ')).toMatch(/increment_contact_opens/)
    err.mockRestore()
  })

  it('logs when increment_contact_clicks fails instead of swallowing it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubRpcFailureDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null }, failing: 'increment_contact_clicks' })

    const r = await processPostmarkEvent(db, { RecordType: 'Click', MessageID: 'pm-1', OriginalLink: 'https://a' })

    expect(r.ok).toBe(true)
    expect(db.calls).toContain('increment_contact_clicks')
    expect(err.mock.calls.flat().join(' ')).toMatch(/increment_contact_clicks/)
    err.mockRestore()
  })

  it('a working rpc logs nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubRpcFailureDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null }, failing: null })

    await processPostmarkEvent(db, { RecordType: 'Open', MessageID: 'pm-1', FirstOpen: true })

    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
