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
        eq: () => {
          // K8 — the send lookup is `.maybeSingle()` now (0 rows is the normal
          // case for a Postmark event about mail this system never recorded);
          // `.single()` stays modelled so the fake keeps working if a caller
          // uses it. Both resolve the same way: this fake's `send: null` IS the
          // no-row case, which `.maybeSingle()` reports as data null, no error.
          const settle = () => Promise.resolve({ data: table === 'email_sends' ? send : null, error: null })
          return { single: settle, maybeSingle: settle }
        },
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
        eq: () => {
          // K8 — see stubDb: the send lookup uses `.maybeSingle()`.
          const settle = () => Promise.resolve({
            data: table === 'email_sends' ? send : null,
            error: null,
          })
          return { single: settle, maybeSingle: settle }
        },
      }),
      update: (values) => {
        const filters = []
        const chain = {
          eq: (col, val) => { filters.push(['eq', col, val]); return chain },
          in: (col, val) => { filters.push(['in', col, val]); return chain },
          not: (col, op, val) => { filters.push(['not', col, op, val]); return chain },
          // COMMSFIX.F.2 — the Click handler stamps clicked_at with an
          // .is('clicked_at', null) guard (first click only). The fake tracks
          // the client: without this the whole handler throws here and the
          // hygiene assertion below fails for a reason that has nothing to do
          // with hygiene.
          is: (col, val) => { filters.push(['is', col, val]); return chain },
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

  // COMMSFIX.C.7 changed what a re-subscribe DOES — it now clears our mirror of
  // Postmark's suppression (see the reactivation block below) rather than being
  // ignored outright. What must NOT change, and is the reason this test exists,
  // is that it applies no consent write and moves no campaign counter.
  it('a re-subscribe (SuppressSending=false) applies no consent change and no counter', async () => {
    const db = stubReactivationDb({ send: { contact_id: 'c1', campaign_id: 'camp1' } })

    const r = await processPostmarkEvent(db, { ...EVENT, SuppressSending: false })
    expect(r.ok).toBe(true)
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
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
    // COMMSFIX.C.7 — the SubscriptionChange reactivation branch resolves a
    // contact by Recipient with .ilike(escapeLikePattern(...)); without this
    // the handler throws and the test reads as a behaviour failure.
    b.ilike = (col, val) => { b._filters.push(['ilike', col, val]); return b }
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
function stubDeliveryTransitionDb({ updatedRows = [], recipientRows = [], existingSendCount = 1 } = {}) {
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
      // head:true count probe — "does ANY email_sends row exist for this id"
      if (b._count && table === 'email_sends') {
        return Promise.resolve({ data: null, count: existingSendCount, error: null })
      }
      return Promise.resolve({ data: shape === 'single' ? null : [], error: null })
    }
    b.select = (_cols, opts) => {
      if (opts?.head) b._count = true
      return b._op === 'update' ? settle('list') : b
    }
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
    // POSTMARK-RACE.2 split the write: the TIMESTAMP carries the transition
    // guard (it is what makes the counter increment exactly once), and the
    // status promotion is a separate monotonic write.
    const stamp = db.sendUpdates.find(u => 'delivered_at' in (u.values || {}))
    expect(stamp.filters).toContainEqual(['is', 'delivered_at', null])
  })

  // ── POSTMARK-RACE.2 — status is a lattice; delivered_at is a transition ──
  //
  // Pre-fix a raced Delivery was processed once, immediately, so it could never
  // come back after an Open. Now it is deferred and re-run a minute later, and
  // an Open landing in that window is processed normally in between (its row
  // committed within 13.2s). One UPDATE writing both fields under a
  // delivered_at-only guard would then rewrite status 'opened' → 'delivered' —
  // exactly the regression the recovery backfill's `CASE WHEN es.status =
  // 'sent'` exists to prevent. 1,205 of the 3,231 recoverable prod rows are
  // already opened/clicked.
  it('promotes status only from sent — a Delivery retried after an Open must not regress it', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [{ id: 's1', campaign_id: 'camp1' }] })

    await processPostmarkEvent(db, DELIVERY)

    const promote = db.sendUpdates.find(u => u.values?.status === 'delivered')
    expect(promote).toBeTruthy()
    expect(promote.values).toEqual({ status: 'delivered' })
    expect(promote.filters).toContainEqual(['eq', 'status', 'sent'])
  })

  it('still records delivered_at unconditionally — the status guard must not cost the timestamp', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [{ id: 's1', campaign_id: 'camp1' }] })

    await processPostmarkEvent(db, DELIVERY)

    // The thing that was being lost is the timestamp. Its UPDATE carries only
    // the transition guard, so an already-opened row (status no longer 'sent')
    // still gets stamped — filtering the single update on status would have
    // matched zero rows and lost it again.
    const stamp = db.sendUpdates.find(u => 'delivered_at' in (u.values || {}))
    expect(stamp.values).toEqual({ delivered_at: DELIVERY.DeliveredAt })
    expect(stamp.filters).not.toContainEqual(['eq', 'status', 'sent'])
  })

  it('skips the status promotion entirely when the transition matched nothing', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 1 })

    await processPostmarkEvent(db, DELIVERY)

    expect(db.sendUpdates.filter(u => u.values?.status === 'delivered')).toEqual([])
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

  // COMMSFIX.C.1b — email_sends is now inserted BEFORE the per-recipient
  // update loop stamps postmark_message_id, so a Delivery webhook that beats
  // that loop finds the send row but NO recipient row keyed by message id.
  // Without a fallback the recipient-level delivery stamp is silently lost —
  // the same class of loss C.1 just fixed on the campaign counter, moved one
  // table over. campaign_recipients is UNIQUE (campaign_id, contact_id), so
  // resolving through the send row addresses exactly one row.
  it('falls back to (campaign_id, contact_id) when no recipient row carries the message id yet', async () => {
    const db = stubDeliveryTransitionDb({
      updatedRows: [{ id: 's1', campaign_id: 'camp1', contact_id: 'c1' }],
      recipientRows: [],
    })

    await processPostmarkEvent(db, DELIVERY)

    expect(db.recipientUpdates).toHaveLength(2)
    const fallback = db.recipientUpdates[1]
    expect(fallback.values.status).toBe('delivered')
    expect(fallback.filters).toContainEqual(['eq', 'campaign_id', 'camp1'])
    expect(fallback.filters).toContainEqual(['eq', 'contact_id', 'c1'])
  })

  // COMMSFIX.C.1c — the residual window C.1 leaves is small (one INSERT) but
  // real, and a Delivery lost in it is lost FOREVER: the webhook dedup key
  // rejects Postmark's retry at the door, and nothing else ever sets
  // delivered_at. Silence is precisely how this defect hid for months, so the
  // one case that means data loss — no email_sends row exists AT ALL for the
  // message — has to be loud. A replay of an already-delivered message also
  // returns zero updated rows and must stay quiet.
  // POSTMARK-RACE.1 moved this line from console.error to console.warn AND
  // narrowed what it means. It now fires only for an UNMARKED message — mail
  // this system never records — because the marked case is no longer merely
  // logged, it is retried (see the raced-send-row suite below). Keeping ~31
  // ignorable events a day at error level is what let the real defect hide in
  // the Vercel error feed for months.
  it('names the message when a Delivery arrives for one with no email_sends row', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await processPostmarkEvent(db, DELIVERY)

    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls.flat().join(' ')).toMatch(/pm-d1/)
    spy.mockRestore()
  })

  it('stays quiet for a replayed Delivery whose send row is already delivered', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 1 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await processPostmarkEvent(db, DELIVERY)

    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('does NOT run the fallback when the message-id match already stamped a row', async () => {
    const db = stubDeliveryTransitionDb({
      updatedRows: [{ id: 's1', campaign_id: 'camp1', contact_id: 'c1' }],
      recipientRows: [{ id: 'r1' }],
    })

    await processPostmarkEvent(db, DELIVERY)

    expect(db.recipientUpdates).toHaveLength(1)
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

// ── COMMSFIX.C.7 — events that vanished without a trace ─────────────────────
//
// Two prod-silent holes in the same switch:
//   • The default case logged unknown RecordTypes only when NODE_ENV !==
//     'production', then returned ok:true. In prod the queue row was marked
//     processed with ZERO trace — no log line, no counter, no dead-letter. If
//     Postmark adds a record type, every event of it "succeeds" while doing
//     nothing, and there is no artefact to ever discover it from.
//   • SubscriptionChange with SuppressSending=false — an operator REACTIVATING
//     a suppressed address in Postmark — was explicitly ignored, so our own
//     mirror of that suppression (contacts.email_status reputation +
//     email_suppressed_at hygiene stamp) stayed stuck on forever.
//
// Consent is deliberately NOT touched by a reactivation: Postmark's suppression
// is a delivery block, and flipping email_marketing back on would be opting
// somebody in without their say-so.
function stubReactivationDb({ send = null, contact = null } = {}) {
  const contactUpdates = []
  const contactLookups = []

  function builder(table) {
    const b = { _op: 'select', _values: null, _filters: [] }
    const settle = (shape) => {
      if (b._op === 'update') {
        if (table === 'contacts') contactUpdates.push({ values: b._values, filters: b._filters })
        return Promise.resolve({ data: [], error: null })
      }
      if (table === 'contacts') {
        contactLookups.push({ filters: b._filters })
        return Promise.resolve({ data: shape === 'single' ? contact : (contact ? [contact] : []), error: null })
      }
      const row = table === 'email_sends' ? send : null
      return Promise.resolve({ data: shape === 'single' ? row : [], error: null })
    }
    b.select = () => (b._op === 'update' ? settle('list') : b)
    b.update = (values) => { b._op = 'update'; b._values = values; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    b.is = (col, val) => { b._filters.push(['is', col, val]); return b }
    b.not = (col, op, val) => { b._filters.push(['not', col, op, val]); return b }
    b.ilike = (col, val) => { b._filters.push(['ilike', col, val]); return b }
    b.limit = () => b
    b.or = (expr) => { b._filters.push(['or', expr]); return b }
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }

  return { contactUpdates, contactLookups, from: builder, rpc: () => Promise.resolve({ error: null }) }
}

describe('processPostmarkEvent — unhandled record types are visible in prod (COMMSFIX.C.7)', () => {
  it('console.errors an unknown RecordType in production', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const db = stubReactivationDb()
      const r = await processPostmarkEvent(db, { RecordType: 'SomethingPostmarkAdded', MessageID: 'pm-1' })
      // Still ok — the webhook contract is 200 for unrecognised events, so a
      // provider never auto-disables the hook over one.
      expect(r.ok).toBe(true)
      expect(err.mock.calls.flat().join(' ')).toContain('SomethingPostmarkAdded')
    } finally {
      err.mockRestore()
      process.env.NODE_ENV = prev
    }
  })
})

describe('processPostmarkEvent — SubscriptionChange reactivation (COMMSFIX.C.7)', () => {
  const REACTIVATE = { RecordType: 'SubscriptionChange', MessageID: 'pm-1', SuppressSending: false, Recipient: 'a@x.ie' }

  it('clears our suppression mirror for the contact behind the message', async () => {
    const db = stubReactivationDb({ send: { contact_id: 'c1', campaign_id: 'camp1' } })

    const r = await processPostmarkEvent(db, REACTIVATE)

    expect(r.ok).toBe(true)
    const hygiene = db.contactUpdates.find(u => 'email_suppressed_at' in u.values)
    expect(hygiene).toBeTruthy()
    expect(hygiene.filters).toContainEqual(['eq', 'id', 'c1'])
    expect(hygiene.filters).toContainEqual(['not', 'email_suppressed_at', 'is', null])

    const reputation = db.contactUpdates.find(u => u.values?.email_status === 'active')
    expect(reputation).toBeTruthy()
    // Only a bounced/complained address is being reinstated — never a blanket write.
    expect(reputation.filters).toContainEqual(['in', 'email_status', ['bounced', 'complained']])
  })

  it('NEVER re-opts anyone into marketing — a delivery block is not consent', async () => {
    const db = stubReactivationDb({ send: { contact_id: 'c1', campaign_id: 'camp1' } })

    await processPostmarkEvent(db, REACTIVATE)

    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
    expect(db.contactUpdates.some(u => 'email_marketing' in (u.values || {}))).toBe(false)
  })

  it('falls back to the Recipient address when the event carries the zero GUID', async () => {
    // A Postmark-side reactivation is not tied to a delivered message, so it
    // arrives with MessageID 00000000-... and matches no email_sends row.
    const db = stubReactivationDb({ send: null, contact: { id: 'c9' } })

    const r = await processPostmarkEvent(db, {
      ...REACTIVATE,
      MessageID: '00000000-0000-0000-0000-000000000000',
    })

    expect(r.ok).toBe(true)
    // CLAUDE.md: .ilike is a PATTERN match — the value must be escaped, and
    // .eq is wrong because contacts are stored mixed-case.
    const lookup = db.contactLookups.find(l => l.filters.some(([kind, col]) => kind === 'ilike' && col === 'email'))
    expect(lookup).toBeTruthy()
    expect(db.contactUpdates.length).toBeGreaterThan(0)
  })

  it('is a clean no-op when neither the message nor the recipient resolves', async () => {
    const db = stubReactivationDb({ send: null, contact: null })

    const r = await processPostmarkEvent(db, { ...REACTIVATE, Recipient: undefined })

    expect(r.ok).toBe(true)
    expect(db.contactUpdates).toEqual([])
  })
})

// ─── COMMSFIX.F.2 — Click writes rows, never arrays ──────────────────
//
// The old handler did select clicked_links → push → update. That is a
// lost-update race; it never lost anything only because the webhook dedup key
// collapsed every repeat Click on a message into one event, so the processor
// saw at most one Click per message. COMMSFIX.C narrows that key and repeats
// start flowing — at which point two concurrent Clicks each read the array,
// append, and overwrite each other.
//
// These tests are written against the NEW model: one campaign_link_clicks row
// per click event, and two BLIND writes to the recipient row (clicked_at
// guarded to the first click, status unguarded). The load-bearing property is
// negative — the handler must never SELECT campaign_recipients — so the fake
// records reads as well as writes, and a reinstated read-modify-write fails
// the test rather than passing it quietly.
function stubClickDb({ send, insertError = null } = {}) {
  const inserts = []
  const recipientUpdates = []
  const recipientSelects = []

  function builder(table) {
    const b = { _op: 'select', _values: null, _filters: [] }
    const settle = (shape) => {
      if (b._op === 'insert') {
        inserts.push({ table, values: b._values })
        return Promise.resolve({ data: null, error: insertError })
      }
      if (b._op === 'update') {
        if (table === 'campaign_recipients') {
          recipientUpdates.push({ values: b._values, filters: b._filters })
        }
        return Promise.resolve({ data: null, error: null })
      }
      if (table === 'campaign_recipients') recipientSelects.push({ filters: b._filters })
      // campaign_recipients resolves to a REAL row so the old read-modify-write
      // would actually execute against this fake — otherwise the
      // "never writes clicked_links" assertion would pass on the old code too,
      // for the wrong reason (its `if (recipient)` guard falling through).
      const row = table === 'email_sends'
        ? send
        : table === 'campaign_recipients'
          ? { clicked_links: [], clicked_at: null }
          : null
      return Promise.resolve({ data: shape === 'single' ? row : [], error: null })
    }
    b.select = () => b
    b.insert = (values) => { b._op = 'insert'; b._values = values; return b }
    b.update = (values) => { b._op = 'update'; b._values = values; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.is = (col, val) => { b._filters.push(['is', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    b.not = (col, op, val) => { b._filters.push(['not', col, op, val]); return b }
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }

  return { inserts, recipientUpdates, recipientSelects, from: builder, rpc: () => Promise.resolve({ error: null }) }
}

const CAMPAIGN_SEND = { id: 's1', contact_id: 'c1', campaign_id: 'camp1', location_id: 'loc1' }
const clickEvent = (url) => ({ RecordType: 'Click', MessageID: 'pm-click', OriginalLink: url })

describe('processPostmarkEvent — Click (COMMSFIX.F.2)', () => {
  it('inserts one campaign_link_clicks row carrying campaign, contact, location, url and message id', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    const r = await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    expect(r.ok).toBe(true)
    const clicks = db.inserts.filter((i) => i.table === 'campaign_link_clicks')
    expect(clicks).toHaveLength(1)
    expect(clicks[0].values).toEqual(expect.objectContaining({
      campaign_id: 'camp1',
      contact_id: 'c1',
      location_id: 'loc1',
      url: 'https://un1t.ie/offers',
      postmark_message_id: 'pm-click',
    }))
    expect(typeof clicks[0].values.clicked_at).toBe('string')
  })

  it('TWO clicks on one message produce TWO rows — the case the array model lost', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))
    await processPostmarkEvent(db, clickEvent('https://un1t.ie/timetable'))

    const clicks = db.inserts.filter((i) => i.table === 'campaign_link_clicks')
    expect(clicks).toHaveLength(2)
    expect(clicks.map((c) => c.values.url)).toEqual([
      'https://un1t.ie/offers',
      'https://un1t.ie/timetable',
    ])
  })

  it('never SELECTs campaign_recipients — no read-modify-write anywhere on the click path', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    expect(db.recipientSelects).toEqual([])
  })

  it('stamps clicked_at blind and guarded to the FIRST click only', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    const stamp = db.recipientUpdates.find((u) => 'clicked_at' in u.values)
    expect(stamp).toBeTruthy()
    expect(stamp.filters).toContainEqual(['eq', 'postmark_message_id', 'pm-click'])
    // The guard IS the "second click does not move clicked_at" behaviour:
    // a row whose clicked_at is already set is filtered out server-side.
    expect(stamp.filters).toContainEqual(['is', 'clicked_at', null])
    expect(stamp.values).not.toHaveProperty('status')
  })

  it('stamps status=clicked unguarded, in its own write', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    const status = db.recipientUpdates.find((u) => u.values.status === 'clicked')
    expect(status).toBeTruthy()
    expect(status.filters).toContainEqual(['eq', 'postmark_message_id', 'pm-click'])
    expect(status.filters).not.toContainEqual(['is', 'clicked_at', null])
  })

  it('never writes clicked_links (DEPRECATED, mig 510)', async () => {
    const db = stubClickDb({ send: CAMPAIGN_SEND })

    await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    for (const u of db.recipientUpdates) expect(u.values).not.toHaveProperty('clicked_links')
    for (const i of db.inserts) expect(i.values).not.toHaveProperty('clicked_links')
  })

  it('logs a failed insert instead of swallowing it — silence is the failure mode', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubClickDb({
      send: CAMPAIGN_SEND,
      insertError: { message: 'null value in column "location_id" violates not-null constraint' },
    })

    const r = await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    // Logged, but the event still succeeds — a click row is not worth
    // dead-lettering the whole webhook event over.
    expect(r.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('campaign_link_clicks'),
      expect.stringContaining('not-null constraint'),
    )
    spy.mockRestore()
  })

  it('inserts nothing for a transactional (non-campaign) send, and does not log it as an error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubClickDb({ send: { id: 's2', contact_id: 'c1', campaign_id: null, location_id: 'loc1' } })

    const r = await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    expect(r.ok).toBe(true)
    expect(db.inserts.filter((i) => i.table === 'campaign_link_clicks')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('logs a campaign send that has no location_id rather than firing a doomed insert', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubClickDb({ send: { id: 's3', contact_id: 'c1', campaign_id: 'camp1', location_id: null } })

    const r = await processPostmarkEvent(db, clickEvent('https://un1t.ie/offers'))

    expect(r.ok).toBe(true)
    expect(db.inserts.filter((i) => i.table === 'campaign_link_clicks')).toEqual([])
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('location_id'),
      expect.objectContaining({ campaignId: 'camp1' }),
    )
    spy.mockRestore()
  })
})

// ── GAPS-P1.2 — contacts.last_email_open_at / last_email_click_at ──────────
//
// mig 511 makes both columns real and backfills them as max(opened_at) /
// max(clicked_at) per contact off email_sends. The webhook has to maintain
// EXACTLY that quantity or the two drift apart silently:
//
//   • it stamps with the SAME timestamp it writes to email_sends.opened_at /
//     clicked_at — not a second `new Date()`, not body.ReceivedAt;
//   • it stamps on EVERY Open, not just FirstOpen. email_sends.opened_at is
//     rewritten on every Open event, so a FirstOpen gate here (which is right
//     for increment_contact_opens, a UNIQUE-open counter) would freeze the
//     contact stamp at the first open while email_sends kept moving;
//   • it never writes the columns through a bare contacts.update. The
//     never-move-backwards guard lives inside the RPC (mig 511:
//     `last_email_open_at is null or last_email_open_at < p_at`), where it is
//     atomic against a concurrent worker and cannot be lost to a later edit
//     here. A read-modify-write in JS would reintroduce exactly the lost-update
//     race COMMSFIX.F.2 removed from clicked_links.
function stubStampDb({ send, rpcError = null } = {}) {
  const rpcCalls = []
  const updates = []

  function builder(table) {
    const b = { _op: 'select', _values: null, _filters: [] }
    const settle = (shape) => {
      if (b._op === 'insert') return Promise.resolve({ data: null, error: null })
      if (b._op === 'update') {
        updates.push({ table, values: b._values, filters: b._filters })
        return Promise.resolve({ data: [], error: null })
      }
      const row = table === 'email_sends' ? send : null
      return Promise.resolve({ data: shape === 'single' ? row : [], error: null })
    }
    b.select = () => b
    b.insert = (values) => { b._op = 'insert'; b._values = values; return b }
    b.update = (values) => { b._op = 'update'; b._values = values; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.is = (col, val) => { b._filters.push(['is', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    b.not = (col, op, val) => { b._filters.push(['not', col, op, val]); return b }
    b.single = () => settle('single')
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }

  return {
    rpcCalls,
    updates,
    from: builder,
    rpc: (fn, args) => {
      rpcCalls.push([fn, args])
      const isStamp = fn === 'stamp_contact_email_open' || fn === 'stamp_contact_email_click'
      return Promise.resolve({ error: isStamp ? rpcError : null })
    },
  }
}

const stampCalls = (db, fn) => db.rpcCalls.filter(([name]) => name === fn)
const sendUpdate = (db, key) => db.updates.find((u) => u.table === 'email_sends' && key in (u.values || {}))

describe('processPostmarkEvent — engagement recency stamps (GAPS-P1.2)', () => {
  it('Open stamps last_email_open_at with the same timestamp email_sends.opened_at got', async () => {
    const db = stubStampDb({ send: { id: 's1', contact_id: 'c1', campaign_id: 'camp1' } })

    const r = await processPostmarkEvent(db, { RecordType: 'Open', MessageID: 'pm-o', FirstOpen: true })

    expect(r.ok).toBe(true)
    const calls = stampCalls(db, 'stamp_contact_email_open')
    expect(calls).toHaveLength(1)
    // Same quantity as the backfill's max(opened_at): the contact stamp and
    // the send row must carry an identical instant, not two clock reads.
    expect(calls[0][1]).toEqual({ p_contact_id: 'c1', p_at: sendUpdate(db, 'opened_at').values.opened_at })
  })

  it('Open stamps on a REPEAT open too (not FirstOpen-gated, unlike the unique-open counter)', async () => {
    const db = stubStampDb({ send: { id: 's1', contact_id: 'c1', campaign_id: 'camp1' } })

    const r = await processPostmarkEvent(db, { RecordType: 'Open', MessageID: 'pm-o', FirstOpen: false })

    expect(r.ok).toBe(true)
    expect(stampCalls(db, 'stamp_contact_email_open')).toHaveLength(1)
    // …while the unique-open counter stays gated, as mig 508 specifies.
    expect(stampCalls(db, 'increment_contact_opens')).toHaveLength(0)
  })

  it('Click stamps last_email_click_at with the same timestamp email_sends.clicked_at got', async () => {
    const db = stubStampDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null, location_id: 'loc1' } })

    const r = await processPostmarkEvent(db, { RecordType: 'Click', MessageID: 'pm-c', OriginalLink: 'https://un1t.ie/x' })

    expect(r.ok).toBe(true)
    const calls = stampCalls(db, 'stamp_contact_email_click')
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toEqual({ p_contact_id: 'c1', p_at: sendUpdate(db, 'clicked_at').values.clicked_at })
  })

  // THE NEVER-MOVE-BACKWARDS GUARD, JS side. The SQL predicate itself is
  // pinned by tests/migration-511-contact-email-engagement-stamps.test.js
  // ("guards each stamp so it can only move forwards"); this asserts the
  // processor actually routes through it instead of writing the column raw.
  it.each(['Open', 'Click'])('%s never writes the stamp columns through a bare contacts.update', async (recordType) => {
    const db = stubStampDb({ send: { id: 's1', contact_id: 'c1', campaign_id: null, location_id: 'loc1' } })

    await processPostmarkEvent(db, { RecordType: recordType, MessageID: 'pm-x', FirstOpen: true, OriginalLink: 'https://un1t.ie/x' })

    const raw = db.updates.filter((u) => u.table === 'contacts'
      && ('last_email_open_at' in (u.values || {}) || 'last_email_click_at' in (u.values || {})))
    expect(raw).toEqual([])
  })

  it.each([
    ['Open', 'stamp_contact_email_open'],
    ['Click', 'stamp_contact_email_click'],
  ])('%s: a failing stamp is LOGGED and never fails the event (reportRpc pattern)', async (recordType, fn) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = stubStampDb({
      send: { id: 's1', contact_id: 'c1', campaign_id: null, location_id: 'loc1' },
      rpcError: { message: 'function does not exist' },
    })

    const r = await processPostmarkEvent(db, { RecordType: recordType, MessageID: 'pm-x', FirstOpen: true, OriginalLink: 'https://un1t.ie/x' })

    expect(r.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(fn),
      expect.stringContaining('does not exist'),
    )
    spy.mockRestore()
  })

  it.each(['Open', 'Click'])('%s with no matching email_sends row stamps nothing', async (recordType) => {
    const db = stubStampDb({ send: null })

    const r = await processPostmarkEvent(db, { RecordType: recordType, MessageID: 'pm-x', FirstOpen: true, OriginalLink: 'https://un1t.ie/x' })

    expect(r.ok).toBe(true)
    expect(stampCalls(db, 'stamp_contact_email_open')).toEqual([])
    expect(stampCalls(db, 'stamp_contact_email_click')).toEqual([])
  })
})

// ── POSTMARK-RACE.1 — an event that arrived before its send row committed ────
//
// The defect: `postmark_message_id` is minted by Postmark and only known once
// the send API returns, so no send path can write its email_sends row before
// Postmark starts delivering — and the campaign path sends a batch of up to
// 500 before it inserts. Prod, 21 days: 3,231 of 10,191 Delivery events were
// processed BEFORE their row committed, and every one of them lost its
// delivery (delivered_at NULL on 3,231/3,231, set on 6,960/6,960 of the rest).
// The loss was PERMANENT because the processor returned ok, which let
// claimAndProcessQueueRow stamp the queue row processed; Postmark's own retry
// was already deduped at ingest, so nothing ever looked at the event again.
//
// The fix cannot be "retry every miss" — 655 events over the same window are
// for mail this system never records (ops-alert crons, host campaigns, test
// sends), and 277 of those carry Metadata, so absence and Metadata-presence
// are both useless as the test. The crm_send marker makes it explicit.
import { SEND_ROW_NOT_YET_COMMITTED, withSendMarker } from './postmark-send-marker.js'

// POSTMARK-RACE.2 — the marker carries the send instant, so it must be minted
// per assertion rather than once at module load: a suite that takes longer than
// the race window would otherwise start reading its own fixture as stale.
const MARKED = () => withSendMarker({ campaign_id: 'camp1', contact_id: 'c1' })
// A marker from a send that is long finished — the erased-contact / failed-
// insert population, which must NOT be deferred.
const STALE = () => withSendMarker({ campaign_id: 'camp1', contact_id: 'c1' }, Date.now() - 3600_000)

describe('processPostmarkEvent — raced send row (POSTMARK-RACE.1)', () => {
  it('leaves a MARKED Delivery unprocessed when no email_sends row exists yet', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })

    const r = await processPostmarkEvent(db, { ...DELIVERY, Metadata: MARKED() })

    // Not ok — this is the whole fix. An ok here is what stamped the queue row
    // processed and destroyed the event.
    expect(r).toEqual({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })
  })

  it('DROPS an unmarked Delivery with no send row — genuine noise never loops', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A real (b)-population payload: an ops alert cron, tagged, no marker.
    const r = await processPostmarkEvent(db, {
      ...DELIVERY, Tag: 'cron.health-check', Metadata: {},
    })

    expect(r).toEqual({ ok: true })
    // Ignored noise is no longer reported as an error — ~31/day of it is what
    // buried the real defect in the Vercel error feed.
    expect(errSpy).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/not ours to record/)
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  // ── POSTMARK-RACE.2 — a marker means "a row WAS written", not "is coming" ──
  //
  // email_sends.contact_id is ON DELETE CASCADE (verified on prod), and
  // deleting a contact is the estate's routine GDPR-erasure action
  // (/api/contacts/bulk-delete, /api/contacts/[id], the import rollback).
  // Open/Click webhooks arrive p50 1.9h, p95 6.8 days, max 44.4 days after the
  // send (n=5,189 / 60 days). So "marked send → contact erased → a late Open
  // lands" is reachable, and the timeless marker could not tell it from a
  // 13-second race: five retries, then a webhook_dead_letter row under the
  // deliberately NON-replayable `postmark_queue` provider (it stays pending
  // until a human deals with it) saying `send_row_not_yet_committed` — a false
  // statement about an event that is correctly unrecordable.
  it('DROPS a STALE-marked Delivery — an erased contact is not a race', async () => {
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = await processPostmarkEvent(db, { ...DELIVERY, Metadata: STALE() })

    expect(r).toEqual({ ok: true })
    expect(errSpy).not.toHaveBeenCalled()
    // …but it does NOT masquerade as unmarked noise: the log says the marker
    // was there and how old it was, which is what makes a genuinely failed
    // email_sends insert diagnosable.
    const said = warnSpy.mock.calls.flat().join(' ')
    expect(said).toMatch(/crm_send marker/)
    expect(said).toMatch(/deleted or was never written/)
    expect(said).not.toMatch(/not ours to record/)
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it.each([
    ['Open', { RecordType: 'Open', MessageID: 'pm-r', FirstOpen: true }],
    ['Click', { RecordType: 'Click', MessageID: 'pm-r', OriginalLink: 'https://un1t.ie/x' }],
  ])('%s: a STALE-marked event is dropped, not looped round the retry budget', async (_l, base) => {
    const db = stubEngagementDb({ send: null })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await processPostmarkEvent(db, { ...base, Metadata: STALE() })).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
    warnSpy.mockRestore()
  })

  it.each([
    ['Bounce', { RecordType: 'Bounce', MessageID: 'pm-r', Type: 'HardBounce' }],
    ['SpamComplaint', { RecordType: 'SpamComplaint', MessageID: 'pm-r' }],
    ['SubscriptionChange', { RecordType: 'SubscriptionChange', MessageID: 'pm-r', SuppressSending: true }],
  ])('%s: a STALE-marked consent event is dropped rather than dead-lettered under a false reason', async (_l, base) => {
    const db = stubDeliveryDb({ send: null })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: [] })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await processPostmarkEvent(db, { ...base, Metadata: STALE() })).toEqual({ ok: true })
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('records the delivery on the retry, once the row has landed', async () => {
    // Attempt 1: nothing there.
    const first = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })
    expect(await processPostmarkEvent(first, { ...DELIVERY, Metadata: MARKED() }))
      .toEqual({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })
    expect(first.rpcCalls).toEqual([])

    // Attempt 2 (a later sweeper tick): the insert has committed.
    const second = stubDeliveryTransitionDb({
      updatedRows: [{ id: 's1', campaign_id: 'camp1', contact_id: 'c1' }],
    })
    expect(await processPostmarkEvent(second, { ...DELIVERY, Metadata: MARKED() })).toEqual({ ok: true })

    const stamp = second.sendUpdates.find(u => 'delivered_at' in (u.values || {}))
    expect(stamp.values.delivered_at).toBe(DELIVERY.DeliveredAt)
    // The transition guard is still in place, so a third delivery of the same
    // event increments nothing.
    expect(stamp.filters).toContainEqual(['is', 'delivered_at', null])
    expect(second.rpcCalls).toContainEqual([
      'increment_campaign_metric', { p_campaign_id: 'camp1', p_field: 'total_delivered' },
    ])
  })

  it('counts the delivery EXACTLY once across the failed attempt and the retry', async () => {
    const attempt1 = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 0 })
    await processPostmarkEvent(attempt1, { ...DELIVERY, Metadata: MARKED() })
    const attempt2 = stubDeliveryTransitionDb({ updatedRows: [{ id: 's1', campaign_id: 'camp1' }] })
    await processPostmarkEvent(attempt2, { ...DELIVERY, Metadata: MARKED() })
    // A third delivery of the same message finds delivered_at already set, so
    // the guarded UPDATE returns zero rows and nothing increments.
    const attempt3 = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 1 })
    await processPostmarkEvent(attempt3, { ...DELIVERY, Metadata: MARKED() })

    const increments = [...attempt1.rpcCalls, ...attempt2.rpcCalls, ...attempt3.rpcCalls]
      .filter(([fn, args]) => fn === 'increment_campaign_metric' && args.p_field === 'total_delivered')
    expect(increments).toHaveLength(1)
  })

  it('a replayed Delivery whose row is already delivered is NOT retried, even when marked', async () => {
    // existingSendCount 1 = the row is there and already stamped. Zero updated
    // rows here means "already recorded", not "missing" — retrying it would
    // spin a fully-processed event round the queue for no reason.
    const db = stubDeliveryTransitionDb({ updatedRows: [], existingSendCount: 1 })

    expect(await processPostmarkEvent(db, { ...DELIVERY, Metadata: MARKED() })).toEqual({ ok: true })
  })

  it.each([
    ['Open', { RecordType: 'Open', MessageID: 'pm-r', FirstOpen: true }],
    ['Click', { RecordType: 'Click', MessageID: 'pm-r', OriginalLink: 'https://un1t.ie/x' }],
  ])('%s: a marked event with no send row is retried rather than silently dropped', async (_l, base) => {
    const db = stubEngagementDb({ send: null })

    expect(await processPostmarkEvent(db, { ...base, Metadata: MARKED() }))
      .toEqual({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })
    // Nothing was written on the failed attempt, so the retry is clean.
    expect(db.contactUpdates).toEqual([])
  })

  it.each([
    ['Open', { RecordType: 'Open', MessageID: 'pm-r', FirstOpen: true }],
    ['Click', { RecordType: 'Click', MessageID: 'pm-r', OriginalLink: 'https://un1t.ie/x' }],
  ])('%s: an UNMARKED event with no send row still succeeds (unchanged)', async (_l, base) => {
    const db = stubEngagementDb({ send: null })
    expect(await processPostmarkEvent(db, base)).toEqual({ ok: true })
  })
})

// ── The consent-critical record types ────────────────────────────────────────
//
// A lost Delivery skews a stat. A lost Bounce / SpamComplaint / one-click
// unsubscribe means we keep mailing someone who rejected us — 17 Bounces over
// the measured 21 days were processed before their row existed, and each one
// silently skipped the contact marking AND the auto-unsubscribe.
describe('processPostmarkEvent — raced consent events (POSTMARK-RACE.1)', () => {
  const cases = [
    ['Bounce (hard)', { RecordType: 'Bounce', MessageID: 'pm-c', Type: 'HardBounce' }],
    ['Bounce (soft)', { RecordType: 'Bounce', MessageID: 'pm-c', Type: 'SoftBounce' }],
    ['SpamComplaint', { RecordType: 'SpamComplaint', MessageID: 'pm-c' }],
    ['SubscriptionChange (one-click unsubscribe)', {
      RecordType: 'SubscriptionChange', MessageID: 'pm-c', SuppressSending: true,
    }],
  ]

  it.each(cases)('%s: marked with no send row → retried, and NOTHING is unsubscribed yet', async (_l, base) => {
    const db = stubDeliveryDb({ send: null })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: [] })

    const r = await processPostmarkEvent(db, { ...base, Metadata: MARKED() })

    expect(r).toEqual({ ok: false, error: SEND_ROW_NOT_YET_COMMITTED })
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
  })

  it.each(cases)('%s: unmarked with no send row → dropped as before, no loop', async (_l, base) => {
    const db = stubDeliveryDb({ send: null })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: [] })

    expect(await processPostmarkEvent(db, base)).toEqual({ ok: true })
  })

  it('applies the hard-bounce suppression on the retry, once the row is there', async () => {
    const db = stubDeliveryDb({ send: { contact_id: 'c1', campaign_id: 'camp1', location_id: 'loc1' } })
    applyMarketingPreferencesBulk.mockResolvedValue({ ok: true, changed: ['email_marketing'] })

    const r = await processPostmarkEvent(db, {
      RecordType: 'Bounce', MessageID: 'pm-c', Type: 'HardBounce', Metadata: MARKED(),
    })

    expect(r).toEqual({ ok: true })
    expect(applyMarketingPreferencesBulk).toHaveBeenCalledWith(db, expect.objectContaining({
      contactId: 'c1', source: 'postmark_hard_bounce', locationId: 'loc1',
    }))
  })

  // The reactivation branch resolves by Recipient when the message lookup
  // misses — that IS its normal path (Postmark-side suppression clears carry
  // the zero GUID and match no send row). "No send row" is therefore not
  // evidence of a race there, and retrying would burn the budget on honest
  // events until they dead-lettered.
  it('never retries a SubscriptionChange REACTIVATION, marked or not', async () => {
    const db = stubDeliveryDb({ send: null })

    const r = await processPostmarkEvent(db, {
      RecordType: 'SubscriptionChange',
      MessageID: '00000000-0000-0000-0000-000000000000',
      SuppressSending: false,
      Recipient: 'nobody@example.com',
      Metadata: MARKED(),
    })

    expect(r).toEqual({ ok: true })
  })
})
