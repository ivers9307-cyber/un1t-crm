// WABLASTCOUNTERS.1 — the blast engine's per-broadcast counters and its
// claim lease, reproduced from the 2026-10-31 Stillorgan blast (342 recipients,
// a Vercel 504 after 308 sends, a resume, then Meta refusing the tail with
// 131042 "Business eligibility payment issue").
//
// Three defects, three tests that failed on main:
//   1. A recount that could not be read wrote total_sent = 0 / total_failed = 0
//      over the stored figures (`const { count } = await …` with the error
//      discarded, then `count || 0`).
//   2. A recipient claimed just before the process died stayed 'pending' for
//      ever: fetchDripDoneContactIds re-opened it after STUCK_CLAIM_MINUTES, but
//      the blast's bare INSERT then hit the unique key and skipped it. The drip
//      has had a re-claim since BAREWRITE.5; the blast now shares the rule.
//   3. A pass that finished while another pass's claim was still inside its
//      lease flipped the broadcast to 'sent', after which nothing re-opens the
//      claim (the send route admits draft/sending only). It now parks the row at
//      'sending' with the open claim counted as `remaining`.
// The negative total_sent itself came from the status webhook (a delta against
// a counter the pass had not written yet) — src/app/api/webhooks/whatsapp/
// route.broadcast-counters.test.js pins that half.
//
// Fictional ids only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let db
const CONFIG = { id: 'wn-1', phoneNumberId: 'pn-1', token: 'tok', businessAccountId: 'waba-1', qualityRating: 'GREEN', messagingLimitTier: null }

vi.mock('./supabase', () => ({ createServerClient: () => db }))
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.test/v21.0',
  getWhatsAppConfig: vi.fn(async () => CONFIG),
  getLocationWhatsAppNumberConfig: vi.fn(async () => CONFIG),
  getLocationNumberForWaba: vi.fn(async () => CONFIG),
  getConversationReplyConfig: vi.fn(async () => CONFIG),
}))
vi.mock('./wallet-enforcement.js', () => ({ checkSpend: vi.fn(async () => ({ allow: true, reason: 'unpinned' })) }))
vi.mock('./whatsapp-budget.js', () => ({
  getSendBudget: vi.fn(async () => null),
  blastBudgetBlockError: () => null,
  effectiveTickHeadroom: () => 1000,
}))
vi.mock('./frequency-cap.js', () => ({
  getLocationFrequencyCap: vi.fn(async () => ({ enabled: false })),
  isFrequencyCapped: () => false,
  stampMarketingTouch: vi.fn(async () => {}),
}))
vi.mock('./location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T', locationName: 'Stillorgan' })) }))
vi.mock('./push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => {}) }))
vi.mock('./audience-filter', () => ({
  applyAudienceFilter: (q) => q,
  applyAudienceFilterAsync: async ({ query }) => ({ query }),
}))

import { sendBroadcast, STUCK_CLAIM_MINUTES } from './whatsapp.js'

const TEMPLATE = { id: 'tmpl-1', name: 'promo', language: 'en', status: 'APPROVED', components: [], business_account_id: null }
const blast = (overrides = {}) => ({
  id: 'bc-1', location_id: 'loc-1', status: 'draft', delivery_mode: 'blast', signed_off_by: 'u-1',
  paused_at: null, audience_filter: null, variable_mapping: {}, header_media_url: null,
  total_sent: 0, total_failed: 0,
  whatsapp_templates: TEMPLATE, ...overrides,
})
const contact = (n) => ({ id: `c${n}`, wa_phone: `35387000000${n}`, first_name: `C${n}` })

// A fake supabase with a REAL whatsapp_broadcast_recipients table (unique
// (broadcast_id, contact_id) as mig 331 enforces; head counts and the lease's
// `lt` evaluated against the rows) and a recording whatsapp_broadcasts row.
// Every other table answers an empty success.
function makeDb({ broadcasts, audience = [], recipients = [], countsFail = false }) {
  const rec = recipients.map((r) => ({ ...r }))
  const bcs = broadcasts.map((r) => ({ ...r }))
  const broadcastPatches = []
  const messageInserts = []
  const key = (b, c) => `${b}|${c}`

  const predsOf = (ops) => ops.flatMap(([m, col, val]) => {
    if (m === 'eq') return [(r) => r[col] === val]
    if (m === 'neq') return [(r) => r[col] !== val]
    if (m === 'in') return [(r) => val.includes(r[col])]
    if (m === 'lt') return [(r) => r[col] != null && String(r[col]) < String(val)]
    if (m === 'is') return [(r) => (val === null ? r[col] == null : r[col] === val)]
    if (m === 'not' && ops.length) return [(r) => !(val === 'is' ? r[col] == null : r[col] === val)]
    return []
  })

  function evaluate(table, ops, terminal) {
    const sel = ops.find(([m]) => m === 'select')
    const head = !!sel?.[2]?.head
    const write = ops.find(([m]) => ['insert', 'update', 'upsert', 'delete'].includes(m))
    const preds = predsOf(ops)
    const match = (rows) => rows.filter((r) => preds.every((p) => p(r)))

    if (table === 'whatsapp_broadcast_recipients') {
      if (write?.[0] === 'insert') {
        const row = write[1]
        if (rec.some((r) => key(r.broadcast_id, r.contact_id) === key(row.broadcast_id, row.contact_id))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "whatsapp_broadcast_recipients_broadcast_id_contact_id_key"' } }
        }
        rec.push({ created_at: new Date().toISOString(), ...row })
        return { data: null, error: null }
      }
      if (write?.[0] === 'update') {
        const matched = match(rec)
        for (const r of matched) Object.assign(r, write[1])
        return { data: matched.map((r) => ({ id: key(r.broadcast_id, r.contact_id) })), error: null }
      }
      if (head) {
        if (countsFail) return { count: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
        return { count: match(rec).length, error: null }
      }
      if (terminal === 'range') {
        const [, start, end] = ops.find(([m]) => m === 'range')
        const sorted = [...match(rec)].sort((a, b) => (a.contact_id < b.contact_id ? -1 : 1))
        return { data: sorted.slice(start, end + 1), error: null }
      }
      if (terminal === 'maybeSingle') return { data: match(rec)[0] ?? null, error: null }
      return { data: match(rec), error: null }
    }

    if (table === 'whatsapp_broadcasts') {
      if (write?.[0] === 'update') {
        const matched = match(bcs)
        for (const r of matched) Object.assign(r, write[1])
        broadcastPatches.push(write[1])
        return { data: matched.map((r) => ({ id: r.id })), error: null }
      }
      const row = match(bcs)[0] ?? null
      return { data: row, error: row ? null : { message: 'not found' } }
    }

    if (table === 'contact_location_audience') {
      if (head) return { count: audience.length, error: null }
      if (terminal === 'range') {
        const [, start, end] = ops.find(([m]) => m === 'range')
        return { data: audience.slice(start, end + 1), error: null }
      }
      return { data: audience, error: null }
    }

    if (table === 'whatsapp_messages' && write?.[0] === 'insert') {
      messageInserts.push(write[1])
      return { data: { id: `m-${messageInserts.length}` }, error: null }
    }
    if (write?.[0] === 'insert') return { data: { id: `${table}-1` }, error: null }
    if (write) return { data: [], error: null }
    if (head) return { count: 0, error: null }
    if (terminal === 'single' || terminal === 'maybeSingle') return { data: null, error: null }
    return { data: [], error: null }
  }

  const from = (table) => {
    const ops = []
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'gt', 'lt', 'lte', 'or', 'is', 'not', 'order', 'limit', 'insert', 'update', 'upsert', 'delete', 'match']) {
      b[m] = (...a) => { ops.push([m, ...a]); return b }
    }
    b.single = () => Promise.resolve(evaluate(table, ops, 'single'))
    b.maybeSingle = () => Promise.resolve(evaluate(table, ops, 'maybeSingle'))
    b.range = (s, e) => { ops.push(['range', s, e]); return Promise.resolve(evaluate(table, ops, 'range')) }
    b.then = (res, rej) => Promise.resolve(evaluate(table, ops, 'await')).then(res, rej)
    return b
  }
  const rpc = vi.fn(async () => ({ data: null, error: null }))
  return { from, rpc, recipients: rec, broadcasts: bcs, broadcastPatches, messageInserts }
}

// Meta: refuse the numbers in `refuse` synchronously (the 131042 wording),
// accept everyone else with a message id. Records who was attempted.
function fakeMeta(refuse = []) {
  const attempted = []
  const f = vi.fn(async (_url, init) => {
    const to = JSON.parse(init.body).to
    attempted.push(to)
    if (refuse.includes(to)) {
      return { json: async () => ({ error: { message: 'Business eligibility payment issue', code: 131042 } }) }
    }
    return { json: async () => ({ messages: [{ id: `wamid.${to}` }] }) }
  })
  f.attempted = attempted
  return f
}

const byContact = (rows) => Object.fromEntries(rows.map((r) => [r.contact_id, r.status]))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete global.fetch
})

describe('sendBroadcast — counters are the recipient rows (WABLASTCOUNTERS.1)', () => {
  it('a mix of accepted sends and Meta refusals: total_sent / total_failed are row counts and the answer matches them', async () => {
    const audience = [1, 2, 3, 4, 5].map(contact)
    global.fetch = fakeMeta([audience[1].wa_phone, audience[3].wa_phone])
    db = makeDb({ broadcasts: [blast()], audience })

    const result = await sendBroadcast('bc-1')

    expect(byContact(db.recipients)).toEqual({ c1: 'sent', c2: 'failed', c3: 'sent', c4: 'failed', c5: 'sent' })
    expect(result).toMatchObject({ status: 'sent', sent: 3, failed: 2, total: 5 })
    const final = db.broadcastPatches.at(-1)
    expect(final).toMatchObject({ status: 'sent', total_sent: 3, total_failed: 2, total_recipients: 5 })
    // The template counter is this pass's sends; the broadcast counters are
    // never bumped by a delta from this engine.
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenCalledWith('increment_whatsapp_template_sent', { p_template_id: 'tmpl-1', p_delta: 3 })
    expect(global.fetch.attempted).toHaveLength(5)
  })

  it('a recount that cannot be read leaves the stored counters alone and answers with this pass\'s tallies', async () => {
    const audience = [1, 2, 3].map(contact)
    global.fetch = fakeMeta([audience[2].wa_phone])
    // A resumed pass: 10 / 1 already on the row from an earlier pass.
    db = makeDb({ broadcasts: [blast({ status: 'sending', total_sent: 10, total_failed: 1 })], audience, countsFail: true })

    const result = await sendBroadcast('bc-1')

    const final = db.broadcastPatches.at(-1)
    expect(final.status).toBe('sent')
    // Before: `total_sent: 0, total_failed: 0` — the unreadable count was
    // written over the real figures.
    expect(final).not.toHaveProperty('total_sent')
    expect(final).not.toHaveProperty('total_failed')
    expect(db.broadcasts[0]).toMatchObject({ total_sent: 10, total_failed: 1 })
    expect(result).toMatchObject({ status: 'sent', sent: 2, failed: 1, counters_unread: true })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('counters'), expect.anything())
  })
})

describe('sendBroadcast — a claim the killed pass left behind (the blast claim lease)', () => {
  const STALE = new Date(Date.now() - (STUCK_CLAIM_MINUTES + 5) * 60_000).toISOString()
  const FRESH = new Date(Date.now() - 2 * 60_000).toISOString()

  it('re-claims and sends an abandoned pending claim on resume; one still inside its lease is left alone and holds the blast at sending', async () => {
    const audience = [1, 2, 3, 4].map(contact)
    global.fetch = fakeMeta()
    db = makeDb({
      broadcasts: [blast({ status: 'sending' })],
      audience,
      recipients: [
        { broadcast_id: 'bc-1', contact_id: 'c1', status: 'sent', created_at: STALE, wa_message_id: 'wamid.old' },
        // Claimed right before the 504. Nothing was sent (or the promote was lost).
        { broadcast_id: 'bc-1', contact_id: 'c2', status: 'pending', created_at: STALE },
        // A pass genuinely in flight right now. Never re-sent, never 'done'.
        { broadcast_id: 'bc-1', contact_id: 'c3', status: 'pending', created_at: FRESH },
      ],
    })

    const result = await sendBroadcast('bc-1')

    // c1 is done, c3 belongs to someone else: only c2 (re-claimed) and c4 go out.
    expect(global.fetch.attempted.sort()).toEqual([audience[1].wa_phone, audience[3].wa_phone].sort())
    expect(byContact(db.recipients)).toEqual({ c1: 'sent', c2: 'sent', c3: 'pending', c4: 'sent' })
    expect(db.recipients).toHaveLength(4)
    // The re-claim re-stamps the lease; the live claim keeps its own stamp.
    expect(db.recipients.find((r) => r.contact_id === 'c3').created_at).toBe(FRESH)
    // Not 'sent': c3's claim is still owed an outcome, so the row stays
    // resumable (the cron for a scheduled blast, Send again for an operator one).
    expect(result).toMatchObject({ status: 'sending', sent: 3, failed: 0, total: 4, remaining: 1, awaiting: 'claim_lease' })
    const final = db.broadcastPatches.at(-1)
    expect(final).toMatchObject({ status: 'sending', total_sent: 3, total_failed: 0 })
    expect(final).not.toHaveProperty('sent_at')
  })

  it('with no open claim left the completed pass goes sent (the lease adds no new hold)', async () => {
    const audience = [1, 2].map(contact)
    global.fetch = fakeMeta()
    db = makeDb({
      broadcasts: [blast({ status: 'sending' })],
      audience,
      recipients: [{ broadcast_id: 'bc-1', contact_id: 'c1', status: 'pending', created_at: STALE }],
    })
    const result = await sendBroadcast('bc-1')
    expect(byContact(db.recipients)).toEqual({ c1: 'sent', c2: 'sent' })
    expect(result).toMatchObject({ status: 'sent', sent: 2, failed: 0 })
    expect(db.broadcastPatches.at(-1)).toMatchObject({ status: 'sent', total_sent: 2, total_failed: 0 })
  })

  it('a capped row is never re-claimed by a blast (attempted at most once per blast, WA-QUALITY.4)', async () => {
    const audience = [1, 2].map(contact)
    global.fetch = fakeMeta()
    const OLD = new Date(Date.now() - 30 * 3600_000).toISOString()
    db = makeDb({
      broadcasts: [blast({ status: 'sending' })],
      audience,
      recipients: [{ broadcast_id: 'bc-1', contact_id: 'c1', status: 'capped', failed_at: OLD, created_at: OLD }],
    })
    const result = await sendBroadcast('bc-1')
    expect(global.fetch.attempted).toEqual([audience[1].wa_phone])
    expect(byContact(db.recipients)).toEqual({ c1: 'capped', c2: 'sent' })
    expect(result).toMatchObject({ status: 'sent', sent: 1, failed: 0 })
  })
})
