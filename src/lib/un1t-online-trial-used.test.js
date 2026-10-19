// MIAHATCH.6 (Task 25) — the seam spec D left for E, filled: a trial-used
// funnel request that came through the WhatsApp Flow is handed to Mia's
// upsell on the thread; every other one gets D's email, which lists the
// studio's offers. The tables are a small recording fake db; the studio's
// resolved Mia settings, the thread send and the decision log are fakes.
// Fictional ids and phones only (the repo is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ settingsResult: null, send: vi.fn(), record: vi.fn(async () => {}) }))

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/agent/settings-resolve', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAgentSettings: vi.fn(async () => {
    if (h.settingsResult instanceof Error) throw h.settingsResult
    return h.settingsResult
  }),
}))
vi.mock('@/lib/agent/notify', async (importOriginal) => ({ ...(await importOriginal()), sendAgentThreadMessage: h.send }))
vi.mock('@/lib/agent/decision-log', async (importOriginal) => ({ ...(await importOriginal()), recordAgentDecision: h.record }))

import { logWarn } from '@/lib/log'
import { DEFAULT_TRIAL_USED_TEXT } from '@/lib/agent/default-copy'
import { FLOW_SUBMISSION_BODY } from '@/lib/whatsapp-flow/booking-notice'
import { compactDecisionMeta } from '@/lib/agent/decision-log'
import { trialUsedHandoff, trialUsedOptionsText, latestTrialUsedClass, TRIAL_USED_CLASS_TTL_MS } from './un1t-online-trial-used'

// Fictional ids.
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const OTHER = 'a1000000-0000-0000-0000-000000000009'
const CONTACT = 'c1000000-0000-0000-0000-000000000002'
const CONV = 'c2000000-0000-4000-8000-000000000001'
const PHONE = '+353870000001'
const OTHER_PHONE = '+353870000099'
const EVENT = 'un1t:e0000000-0000-4000-8000-000000000001'
const STARTS = '2026-10-23T18:30:00Z'
const CREATED = '2026-10-20T09:00:00Z'

const PRODUCT = {
  pack10: { id: 'f0000000-0000-4000-8000-000000000010', location_id: HATCH, un1t_id: 'prod-pack-10', title: '10 Class Pack', type: 'one_time', status: 'active', visibility: 'public', price_cents: 12500, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 10 },
  monthly: { id: 'f0000000-0000-4000-8000-000000000011', location_id: HATCH, un1t_id: 'prod-monthly', title: 'Monthly Foundation', type: 'recurring', status: 'active', visibility: 'private', price_cents: 18900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1, credits_per_period: null },
  old: { id: 'f0000000-0000-4000-8000-000000000012', location_id: HATCH, un1t_id: 'prod-old', title: 'Old Pack', type: 'one_time', status: 'archived', visibility: 'public', price_cents: 9000, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 5 },
  free: { id: 'f0000000-0000-4000-8000-000000000013', location_id: HATCH, un1t_id: 'prod-free', title: 'Free Trial', type: 'one_time', status: 'active', visibility: 'public', price_cents: 0, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 1 },
}
const OFFERS = [
  { id: 'd0000000-0000-4000-8000-000000000001', location_id: HATCH, un1t_product_row_id: PRODUCT.pack10.id, sort_order: 1, blurb: 'Use within three months' },
  { id: 'd0000000-0000-4000-8000-000000000002', location_id: HATCH, un1t_product_row_id: PRODUCT.monthly.id, sort_order: 0, blurb: null },
  { id: 'd0000000-0000-4000-8000-000000000003', location_id: HATCH, un1t_product_row_id: PRODUCT.old.id, sort_order: 2, blurb: null },
  { id: 'd0000000-0000-4000-8000-000000000004', location_id: HATCH, un1t_product_row_id: PRODUCT.free.id, sort_order: 3, blurb: null },
]
const LINES = 'Monthly Foundation, €189 a month\n10 Class Pack, €125'

const futureIso = () => new Date(Date.now() + 3600_000).toISOString()
const pastIso = () => new Date(Date.now() - 3600_000).toISOString()

// A recording fake db: .eq/.in filter, .order sorts, `fail[table]` answers
// { error }, `throwOn[table]` throws from .from().
function fakeDb(tables = {}, { fail = {}, throwOn = {} } = {}) {
  const data = {
    mia_purchase_offers: OFFERS,
    un1t_products: Object.values(PRODUCT),
    whatsapp_messages: [{
      conversation_id: CONV, contact_id: CONTACT, location_id: HATCH, direction: 'inbound',
      message_type: 'interactive', body: FLOW_SUBMISSION_BODY, created_at: '2026-10-20T08:59:58Z',
    }],
    whatsapp_conversations: [{
      id: CONV, location_id: HATCH, contact_id: CONTACT, wa_phone: PHONE, window_expires_at: futureIso(),
      agent_active: true, agent_paused_at: null, contacts: { id: CONTACT, wa_phone: PHONE },
    }],
    ...tables,
  }
  const reads = []
  const from = (table) => {
    if (throwOn[table]) throw new TypeError('fictional thrown builder')
    const st = { filters: [], orders: [], limit: null, single: false }
    const finish = () => {
      reads.push(table)
      if (fail[table]) return { data: null, error: { message: 'fictional failure', code: 'XX000' } }
      let rows = (data[table] || []).filter((r) => st.filters.every((f) => f(r)))
      for (const [col, asc] of [...st.orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (st.limit != null) rows = rows.slice(0, st.limit)
      return { data: st.single ? (rows[0] ?? null) : rows, error: null }
    }
    const b = {
      select: () => b,
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      gte: (c, v) => { st.filters.push((r) => r[c] >= v); return b },
      order: (c, { ascending = true } = {}) => { st.orders.push([c, ascending]); return b },
      limit: (n) => { st.limit = n; return b },
      maybeSingle: () => { st.single = true; return b },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { db: { from }, reads }
}

const settingsOk = (over = {}, { writes = true } = {}) => ({
  ok: true,
  settings: { enabled: true, test_mode: false, test_phones: [], un1t_chat_actions_enabled: true, ...over },
  location: { id: HATCH, timezone: 'Europe/Dublin', membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: writes, funnel_enabled: true } } },
})
const request = (over = {}) => ({
  id: 'r0000000-0000-4000-8000-000000000001', contact_id: CONTACT, location_id: HATCH,
  glofox_event_id: EVENT, class_name: 'Strength', starts_at: STARTS, created_at: CREATED, ...over,
})
const contact = { id: CONTACT, email: 'person@example.test', phone: PHONE }
const handoff = (db, over = {}) => trialUsedHandoff(db, { request: request(over), contact, locationId: HATCH })

beforeEach(() => {
  vi.clearAllMocks()
  h.settingsResult = settingsOk()
  h.send.mockReset()
  h.send.mockResolvedValue({ sent: true })
})

describe('trialUsedOptionsText', () => {
  it('options text lists active offers in order, title and price only', async () => {
    const { db } = fakeDb()
    const text = await trialUsedOptionsText(db, HATCH)
    expect(text).toBe(LINES)
    // The archived and the €0 product are skipped as Mia skips them; never
    // a blurb, a credit count, capacity or a link.
    expect(text).not.toMatch(/Old Pack|Free Trial|three months|10 credits|http|space|left/i)
  })

  it('empty or unreadable list -> null', async () => {
    expect(await trialUsedOptionsText(fakeDb({ mia_purchase_offers: [] }).db, HATCH)).toBeNull()
    // Only unsellable offers: empty too.
    expect(await trialUsedOptionsText(fakeDb({ mia_purchase_offers: [OFFERS[2], OFFERS[3]] }).db, HATCH)).toBeNull()
    expect(await trialUsedOptionsText(fakeDb({}, { fail: { mia_purchase_offers: true } }).db, HATCH)).toBeNull()
    expect(await trialUsedOptionsText(fakeDb({}, { fail: { un1t_products: true } }).db, HATCH)).toBeNull()
    expect(await trialUsedOptionsText(fakeDb({}, { throwOn: { mia_purchase_offers: true } }).db, HATCH)).toBeNull()
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ locationId: HATCH }))
  })

  it('an unreadable list is logged once (by listPurchaseOptions), a thrown client once (here)', async () => {
    await trialUsedOptionsText(fakeDb({}, { fail: { mia_purchase_offers: true } }).db, HATCH)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][2]).toMatchObject({ op: 'purchase_offers' })
    logWarn.mockClear()
    await trialUsedOptionsText(fakeDb({}, { throwOn: { mia_purchase_offers: true } }).db, HATCH)
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][2]).toMatchObject({ op: 'trial_used_options', errClass: 'TypeError' })
    logWarn.mockClear()
    expect(await handoff(fakeDb({}, { fail: { un1t_products: true } }).db)).toEqual({ handled: false })
    expect(logWarn).toHaveBeenCalledTimes(1)
    expect(logWarn.mock.calls[0][2]).toMatchObject({ op: 'purchase_offer_products' })
  })
})

describe('trialUsedHandoff', () => {
  it('handoff handled only for a Flow request with an open window, Mia on, writes on and offers', async () => {
    const { db } = fakeDb()
    expect(await handoff(db)).toEqual({ handled: true })
    expect(h.send).toHaveBeenCalledTimes(1)
    const [, args] = h.send.mock.calls[0]
    expect(args).toEqual({ channel: 'whatsapp', conversationId: CONV, text: `${DEFAULT_TRIAL_USED_TEXT}\n${LINES}` })
    // The requested class goes on the conversation's decision log, ids only.
    expect(h.record).toHaveBeenCalledTimes(1)
    const [, row] = h.record.mock.calls[0]
    expect(row).toMatchObject({ channel: 'whatsapp', conversationId: CONV, contactId: CONTACT, locationId: HATCH, decision: 'reply', reason: 'trial_used_handoff' })
    const tool = row.meta.tools[0]
    expect(tool.name).toBe('trial_used_handoff')
    expect(JSON.parse(tool.input)).toEqual({ event_id: EVENT, starts_at: STARTS, class_name: 'Strength' })
    expect(JSON.stringify(row)).not.toMatch(/person@example|353870000001/)
  })

  it("uses the operator's trial_used_text", async () => {
    h.settingsResult = settingsOk({ trial_used_text: 'You have had your trial, here is what we offer:' })
    expect(await handoff(fakeDb().db)).toEqual({ handled: true })
    expect(h.send.mock.calls[0][1].text).toBe(`You have had your trial, here is what we offer:\n${LINES}`)
  })

  it('website request -> handled false', async () => {
    const { db } = fakeDb({ whatsapp_messages: [] })
    expect(await handoff(db)).toEqual({ handled: false })
    // A Flow submission from long before this request is not this request's.
    const stale = fakeDb({ whatsapp_messages: [{ conversation_id: CONV, contact_id: CONTACT, location_id: HATCH, direction: 'inbound', message_type: 'interactive', body: FLOW_SUBMISSION_BODY, created_at: '2026-10-20T07:00:00Z' }] })
    expect(await handoff(stale.db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })

  it('Mia off or test mode with another phone -> handled false', async () => {
    h.settingsResult = settingsOk({ enabled: false, test_mode: false })
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    h.settingsResult = settingsOk({ enabled: false, test_mode: true, test_phones: [OTHER_PHONE] })
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
    // The sender on the allowlist: handed off.
    h.settingsResult = settingsOk({ enabled: false, test_mode: true, test_phones: [PHONE] })
    expect(await handoff(fakeDb().db)).toEqual({ handled: true })
  })

  it('enabled + test_mode is live for everyone', async () => {
    h.settingsResult = settingsOk({ enabled: true, test_mode: true, test_phones: [OTHER_PHONE] })
    expect(await handoff(fakeDb().db)).toEqual({ handled: true })
  })

  it("the studio's Mia switch off (the default) -> handled false with everything else on, nothing else read", async () => {
    h.settingsResult = settingsOk({ un1t_chat_actions_enabled: false })
    const { db, reads } = fakeDb()
    expect(await handoff(db)).toEqual({ handled: false })
    h.settingsResult = settingsOk({ un1t_chat_actions_enabled: undefined })
    expect(await handoff(db)).toEqual({ handled: false })
    expect(reads).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
  })

  it('writes_enabled off -> handled false', async () => {
    h.settingsResult = settingsOk({}, { writes: false })
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a Flow request at a studio with no offers -> handled false', async () => {
    expect(await handoff(fakeDb({ mia_purchase_offers: [] }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({ mia_purchase_offers: [OFFERS[2], OFFERS[3]] }).db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('window_closed -> handled false', async () => {
    // The thread's 24h window already closed: nothing is sent.
    const closed = fakeDb({ whatsapp_conversations: [{ id: CONV, location_id: HATCH, contact_id: CONTACT, wa_phone: PHONE, window_expires_at: pastIso(), agent_active: true, agent_paused_at: null }] })
    expect(await handoff(closed.db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
    // It closed between the read and the send.
    h.send.mockResolvedValueOnce({ sent: false, reason: 'window_closed' })
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    expect(h.record).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ reason: 'window_closed', conversationId: CONV }))
  })

  it('a paused thread, or one at another studio or for another contact -> handled false', async () => {
    const conv = { id: CONV, location_id: HATCH, contact_id: CONTACT, wa_phone: PHONE, window_expires_at: futureIso(), agent_active: true, agent_paused_at: null }
    expect(await handoff(fakeDb({ whatsapp_conversations: [{ ...conv, agent_paused_at: pastIso() }] }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({ whatsapp_conversations: [{ ...conv, agent_active: false }] }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({ whatsapp_conversations: [{ ...conv, location_id: OTHER }] }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({ whatsapp_conversations: [{ ...conv, contact_id: 'c1000000-0000-0000-0000-000000000099' }] }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({ whatsapp_conversations: [] }).db)).toEqual({ handled: false })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a throwing read -> handled false, no throw', async () => {
    expect(await handoff(fakeDb({}, { throwOn: { whatsapp_conversations: true } }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({}, { fail: { whatsapp_conversations: true } }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({}, { throwOn: { whatsapp_messages: true } }).db)).toEqual({ handled: false })
    expect(await handoff(fakeDb({}, { fail: { mia_purchase_offers: true } }).db)).toEqual({ handled: false })
    h.settingsResult = { ok: false, reason: 'read_failed' }
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    h.settingsResult = new TypeError('fictional settings throw')
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    h.settingsResult = settingsOk()
    h.send.mockRejectedValueOnce(new Error('fictional send throw'))
    expect(await handoff(fakeDb().db)).toEqual({ handled: false })
    expect(h.send).toHaveBeenCalledTimes(1)
    // Missing arguments: nothing to hand off.
    expect(await trialUsedHandoff(fakeDb().db, {})).toEqual({ handled: false })
    expect(await trialUsedHandoff(fakeDb().db)).toEqual({ handled: false })
  })

  it('a sent upsell is handled even when its decision row cannot be written (never a second message by email)', async () => {
    h.record.mockRejectedValueOnce(new Error('fictional log throw'))
    expect(await handoff(fakeDb().db)).toEqual({ handled: true })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.stringMatching(/not recorded/), expect.objectContaining({ conversationId: CONV }))
  })

  it('no em/en dash in the sent text', async () => {
    h.settingsResult = settingsOk({ trial_used_text: 'You have had your trial — here are the options:' })
    const products = [{ ...PRODUCT.pack10, title: 'Class Pack – 10' }, PRODUCT.monthly]
    expect(await handoff(fakeDb({ un1t_products: products }).db)).toEqual({ handled: true })
    const { text } = h.send.mock.calls[0][1]
    expect(text).not.toMatch(/[–—]/)
    expect(text).toContain('Class Pack - 10, €125')
    expect(await trialUsedOptionsText(fakeDb({ un1t_products: products }).db, HATCH)).not.toMatch(/[–—]/)
  })
})

// MIAHATCH.6 fix round 1 — the hand-off's class read back for the un1t_full
// turn's prompt.
describe('latestTrialUsedClass', () => {
  const NOW = Date.parse('2026-10-20T10:00:00Z')
  const decisionRow = (over = {}, input = { event_id: EVENT, starts_at: STARTS, class_name: 'Strength' }) => ({
    conversation_id: CONV, channel: 'whatsapp', reason: 'trial_used_handoff', location_id: HATCH,
    created_at: '2026-10-20T09:00:00Z',
    meta: compactDecisionMeta({ tools: [{ name: 'trial_used_handoff', input }] }),
    ...over,
  })
  const read = (rows, opts) => latestTrialUsedClass(fakeDb({ agent_decisions: rows }, opts).db, { conversationId: CONV, nowMs: NOW })

  it('reads the latest fresh hand-off on the thread', async () => {
    expect(await read([decisionRow()])).toEqual({ locationId: HATCH, eventId: EVENT, startsAtMs: Date.parse(STARTS), className: 'Strength' })
    // Newest first.
    const later = decisionRow({ created_at: '2026-10-20T09:30:00Z' }, { event_id: 'un1t:e0000000-0000-4000-8000-000000000002', starts_at: STARTS, class_name: 'Yoga' })
    expect((await read([decisionRow(), later])).className).toBe('Yoga')
  })

  it('round-trips what the hand-off writes, a long class name included', async () => {
    const { db } = fakeDb()
    await trialUsedHandoff(db, { request: request({ class_name: 'A very long class name '.repeat(8) }), contact, locationId: HATCH })
    const [, row] = h.record.mock.calls[0]
    const found = await read([decisionRow({ meta: row.meta })])
    expect(found).toMatchObject({ eventId: EVENT, startsAtMs: Date.parse(STARTS) })
    expect(found.className.length).toBeLessThanOrEqual(60)
  })

  it('nothing when stale (over 23h), started, at another reason or unparseable', async () => {
    const stale = new Date(NOW - TRIAL_USED_CLASS_TTL_MS - 60_000).toISOString()
    expect(await read([decisionRow({ created_at: stale })])).toBeNull()
    expect(await read([decisionRow({}, { event_id: EVENT, starts_at: '2026-10-20T09:30:00Z', class_name: 'Strength' })])).toBeNull()
    expect(await read([decisionRow({ reason: 'replied' })])).toBeNull()
    expect(await read([decisionRow({ meta: { tools: [{ name: 'trial_used_handoff', input: '{"event_id":"un1t:e0…' }] } })])).toBeNull()
    expect(await read([decisionRow({}, { event_id: '64aa00000000000000000001', starts_at: STARTS, class_name: 'Strength' })])).toBeNull()
    expect(await read([])).toBeNull()
  })

  it('a failed read is nothing, logged; never throws', async () => {
    expect(await read([decisionRow()], { fail: { agent_decisions: true } })).toBeNull()
    expect(await read([decisionRow()], { throwOn: { agent_decisions: true } })).toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(2)
    expect(await latestTrialUsedClass(fakeDb().db, {})).toBeNull()
  })
})
