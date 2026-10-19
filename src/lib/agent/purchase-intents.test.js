// MIAHATCH.6 (Task 19) — the purchase options, the purchase intents and the
// hosted payment link at a un1t.online studio (Hatch Street). un1t.online is
// never called: D's createCheckoutLink is a fake (fakeUn1tWrite), the customer
// host and the live entitlement read are stubs, and the tables are a recording
// fake db that enforces mia_purchase_intents_one_live like Postgres does
// (23505). Fictional ids only (the repo is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({ checkout: null, grantTrial: null, book: null, elig: null, readsFor: null, send: null, refund: null, settings: null, settingsResult: null }))

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  const { vi: v } = await import('vitest')
  h.checkout = v.fn()
  h.grantTrial = v.fn()
  h.book = v.fn()
  return fakeUn1tWrite({ createCheckoutLink: h.checkout, grantTrial: h.grantTrial, book: h.book })['@/lib/un1t-online-write-ops']()
})
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  openUn1tMemberReader: vi.fn(async () => ({ ok: false, reason: 'read_failed' })),
  fetchLiveEntitlement: vi.fn(async () => ({ ok: true, balance: 0, unlimited: false, liveSubscriptionIds: [] })),
}))
// MIAHATCH.6 (Task 20) — A's trialEligibility, reached through the reads seam.
vi.mock('@/lib/membership/reads', async (importOriginal) => {
  const { vi: v } = await import('vitest')
  h.elig = v.fn()
  h.readsFor = v.fn(async () => ({ state: 'configured', reads: { trialEligibility: h.elig } }))
  return { ...(await importOriginal()), membershipReadsFor: h.readsFor }
})
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
// MIAHATCH.6 (Task 21) — the in-thread confirmation, D's record-only refund
// card and the studio's resolved Mia settings (settle runs with no turn).
vi.mock('./notify', async (importOriginal) => {
  const { vi: v } = await import('vitest')
  h.send = v.fn()
  return { ...(await importOriginal()), sendAgentThreadMessage: h.send }
})
vi.mock('@/lib/un1t-online-approval', async (importOriginal) => {
  const { vi: v } = await import('vitest')
  h.refund = v.fn()
  return { ...(await importOriginal()), fileRefundCard: h.refund }
})
vi.mock('./settings-resolve', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveAgentSettings: async () => h.settingsResult ?? { ok: true, settings: h.settings },
}))
// The refusal table is empty until the MIA TEST run fills it (D's PR 6); a
// fictional table classifies class_full and no_credits the way it will.
vi.mock('@/lib/un1t-online-write-judge', async (importOriginal) => {
  const actual = await importOriginal()
  const TABLE = Object.freeze({ TEST_CLASS_FULL: 'class_full', TEST_NO_CREDITS: 'no_credits' })
  return { ...actual, classifyRefusal: (r) => actual.classifyRefusal(r, TABLE) }
})

import { logWarn, logError, logInfo } from '@/lib/log'
import { Un1tWriteRefused, Un1tWriteUnknown, UN1T_WRITE_CODES as C } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { fetchLiveEntitlement } from './un1t-member-read'
import { renderMiaCopy } from './mia-copy'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { DEFAULT_PURCHASE_LINK_OPEN_TEXT } from './default-copy'
import { formatClassTime } from './dublin-format'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn } from './tool-capability'
import {
  formatPriceLabel, listPurchaseOptions, mintPayDoneToken, hashPayDoneToken, sendPurchaseLink,
  executePurchaseTool, PURCHASE_INTENT_TTL_MS, trialAvailable, offersForBooking,
} from './purchase-intents'
import { paidSinceSnapshot, settlePurchaseIntent, checkMyPurchase, expireStaleIntents, markStuckPaidIntent } from './purchase-settle'
import { notifyAgentApprovalRequest } from './approval-notify'
import { un1tBookClass } from './un1t-booking'
import { DEFAULT_TRIAL_USED_TEXT } from './default-copy'

// Fictional ids.
const ORG = 'b2000000-0000-0000-0000-000000000001'
const HATCH = 'a1000000-0000-0000-0000-000000000002'
const OTHER = 'a1000000-0000-0000-0000-000000000009'
const HATCH_CONTACT = 'c1000000-0000-0000-0000-000000000002'
const USER = 'u-test-1'
const ZONE = 'Europe/Dublin'
const NOW = Date.parse('2026-10-20T09:00:00Z')
const EVENT = 'e0000000-0000-4000-8000-000000000001'
const STARTS = '2026-10-23T18:30:00Z'
const LABEL = formatClassTime(Date.parse(STARTS) / 1000, ZONE)

const PRODUCT = {
  pack10: { id: 'f0000000-0000-4000-8000-000000000010', location_id: HATCH, un1t_id: 'prod-pack-10', title: '10 Class Pack', status: 'active', visibility: 'public', price_cents: 12500, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 10 },
  monthly: { id: 'f0000000-0000-4000-8000-000000000011', location_id: HATCH, un1t_id: 'prod-monthly', title: 'Monthly Foundation', status: 'active', visibility: 'private', price_cents: 18900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1, credits_per_period: null },
  old: { id: 'f0000000-0000-4000-8000-000000000012', location_id: HATCH, un1t_id: 'prod-old', title: 'Old Pack', status: 'archived', visibility: 'public', price_cents: 9000, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 5 },
  free: { id: 'f0000000-0000-4000-8000-000000000013', location_id: HATCH, un1t_id: 'prod-free', title: 'Free Trial', status: 'active', visibility: 'public', price_cents: 0, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 1 },
  foreign: { id: 'f0000000-0000-4000-8000-000000000014', location_id: OTHER, un1t_id: 'prod-foreign', title: 'Elsewhere', status: 'active', visibility: 'public', price_cents: 5000, currency: 'eur', billing_interval: null, billing_interval_count: null, credits_per_period: 4 },
}
const OFFER = {
  pack10: { id: 'd0000000-0000-4000-8000-000000000001', location_id: HATCH, un1t_product_row_id: PRODUCT.pack10.id, sort_order: 1, blurb: 'Use within three months' },
  monthly: { id: 'd0000000-0000-4000-8000-000000000002', location_id: HATCH, un1t_product_row_id: PRODUCT.monthly.id, sort_order: 0, blurb: null },
  old: { id: 'd0000000-0000-4000-8000-000000000003', location_id: HATCH, un1t_product_row_id: PRODUCT.old.id, sort_order: 2, blurb: null },
  free: { id: 'd0000000-0000-4000-8000-000000000004', location_id: HATCH, un1t_product_row_id: PRODUCT.free.id, sort_order: 3, blurb: null },
  foreign: { id: 'd0000000-0000-4000-8000-000000000005', location_id: HATCH, un1t_product_row_id: PRODUCT.foreign.id, sort_order: 4, blurb: null },
}

const isUuid = (v) => /^[0-9a-f-]{36}$/.test(v)

// A recording fake db. .eq/.in/.lte filter, .order sorts (several keys),
// inserts get a uuid, and mia_purchase_intents enforces its partial unique
// index (location_id, un1t_user_id) WHERE status = 'link_sent' with a 23505.
// `onInsert(table, row, data)` runs before an insert is judged (a concurrent
// turn landing its row first).
function fakeDb(tables = {}, { fail = {}, onInsert = null, throwOn = {}, afterSelect = null } = {}) {
  const data = {
    locations: [{ id: HATCH, organization_id: ORG }],
    mia_purchase_offers: [], un1t_products: Object.values(PRODUCT), un1t_events: [], mia_purchase_intents: [],
    ...tables,
  }
  const calls = []
  let next = 1
  const from = (table) => {
    if (throwOn[table]) throw new TypeError('fictional thrown builder')
    const st = { op: 'select', cols: null, filters: [], orders: [], limit: null, single: false, row: null, patch: null, returning: false }
    const pick = (rows) => rows.filter((r) => st.filters.every((f) => f(r)))
    const finish = () => {
      calls.push({ table, op: st.op, row: st.row, patch: st.patch })
      if (fail[table]?.[st.op]) return { data: null, error: { message: 'fictional failure', code: 'XX000' } }
      if (st.op === 'insert') {
        onInsert?.(table, st.row, data)
        if (table === 'mia_purchase_intents' && st.row.status === 'link_sent'
          && data[table].some((r) => r.status === 'link_sent' && r.location_id === st.row.location_id && r.un1t_user_id === st.row.un1t_user_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "mia_purchase_intents_one_live"' } }
        }
        const id = `90000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
        data[table] = [...(data[table] || []), { id, ...st.row }]
        return { data: st.single ? { id } : [{ id }], error: null }
      }
      if (st.op === 'update') {
        const hit = pick(data[table] || [])
        for (const r of hit) Object.assign(r, st.patch)
        return { data: st.returning ? hit.map((r) => ({ id: r.id })) : null, error: null }
      }
      let rows = pick(data[table] || [])
      for (const [col, asc] of [...st.orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
      }
      if (st.limit != null) rows = rows.slice(0, st.limit)
      const out = { data: st.single ? (rows[0] ?? null) : rows, error: null }
      afterSelect?.(table, data)
      return out
    }
    const b = {
      select: (cols) => { if (st.op === 'select') st.cols = cols; else st.returning = true; return b },
      insert: (row) => { st.op = 'insert'; st.row = row; return b },
      update: (patch) => { st.op = 'update'; st.patch = patch; return b },
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      gte: (c, v) => { st.filters.push((r) => r[c] >= v); return b },
      gt: (c, v) => { st.filters.push((r) => r[c] > v); return b },
      lt: (c, v) => { st.filters.push((r) => r[c] < v); return b },
      lte: (c, v) => { st.filters.push((r) => r[c] <= v); return b },
      contains: (c, obj) => { st.filters.push((r) => Object.entries(obj).every(([k, v]) => r[c]?.[k] === v)); return b },
      order: (c, { ascending = true } = {}) => { st.orders.push([c, ascending]); return b },
      range: (a, z) => { st.limit = z - a + 1; return b },
      limit: (n) => { st.limit = n; return b },
      maybeSingle: () => { st.single = true; return b },
      single: () => { st.single = true; return b },
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    }
    return b
  }
  return { db: { from }, data, calls }
}

const hatch = (extra = {}) => ({
  locationId: HATCH, name: 'UN1T Hatch Street', providerKey: 'un1t_online',
  active: true, answerable: true, contactIds: [HATCH_CONTACT], un1tUserId: USER, ...extra,
})
const FULL_TURN = { block: 'un1t_full', channel: 'whatsapp', un1tWrites: true, answerable: [hatch()] }
function ctxFor(db, { settings = { booking_mode: 'auto' }, verifiedContactId = HATCH_CONTACT, turn = FULL_TURN } = {}) {
  return {
    db, locationId: HATCH, zone: ZONE, verifiedContactId, contactId: verifiedContactId,
    channel: 'whatsapp', conversationId: 'conv-1', settings,
    actionStudio: vi.fn(async (loc) => (loc === HATCH ? settings : null)), turn,
  }
}
const deps = { now: () => NOW }
const urlFor = (key) => `https://pay.example.test/s/${key}`
const liveIntent = (over = {}) => ({
  id: '80000000-0000-4000-8000-000000000001', location_id: HATCH, organization_id: ORG, un1t_user_id: USER,
  un1t_product_id: PRODUCT.pack10.un1t_id, product_title: PRODUCT.pack10.title, price_cents: 12500, status: 'link_sent',
  checkout_url: urlFor('80000000-0000-4000-8000-000000000001'), success_token_hash: 'a'.repeat(64),
  created_at: new Date(NOW - 3600_000).toISOString(), expires_at: new Date(NOW + 3600_000).toISOString(), ...over,
})
const allLogText = () => JSON.stringify([logWarn, logError, logInfo].flatMap((fn) => fn.mock.calls))

beforeEach(() => {
  vi.clearAllMocks()
  h.checkout.mockImplementation(async (_db, args) => ({ checkoutUrl: urlFor(args.idempotencyKey), free: false }))
  h.grantTrial.mockReset()
  h.grantTrial.mockResolvedValue({ outcome: 'granted', method: 'charge', ledgerId: 'led-trial-1' })
  h.book.mockReset()
  h.book.mockResolvedValue({ verdict: 'done', sent: true, id: 'bk-new', code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-book-1' })
  h.elig.mockReset()
  h.elig.mockResolvedValue({ success: true, data: { eligible: true, reasons: [] } })
  h.readsFor.mockImplementation(async () => ({ state: 'configured', reads: { trialEligibility: h.elig } }))
  h.send.mockReset()
  h.send.mockResolvedValue({ sent: true })
  h.refund.mockReset()
  h.refund.mockResolvedValue({ approvalId: 'appr-double-1' })
  h.settings = { booking_mode: 'auto' }
  h.settingsResult = null
  fetchLiveEntitlement.mockImplementation(async () => ({ ok: true, balance: 0, unlimited: false, liveSubscriptionIds: [] }))
})

describe('formatPriceLabel', () => {
  it('one-off, monthly, cents and a multi-period interval', () => {
    expect(formatPriceLabel({ priceCents: 12500 })).toBe('€125')
    expect(formatPriceLabel({ priceCents: 18900, interval: 'month' })).toBe('€189 a month')
    expect(formatPriceLabel({ priceCents: 1250, currency: 'EUR' })).toBe('€12.50')
    expect(formatPriceLabel({ priceCents: 50000, interval: 'month', intervalCount: 3 })).toBe('€500 every 3 months')
    expect(formatPriceLabel({ priceCents: null })).toBeNull()
  })
})

describe('listPurchaseOptions', () => {
  it('offers ordered, private allowed, inactive skipped', async () => {
    const { db } = fakeDb({ mia_purchase_offers: Object.values(OFFER) })
    const out = await listPurchaseOptions(db, HATCH)
    expect(out.offers).toEqual([
      { offer_id: OFFER.monthly.id, title: 'Monthly Foundation', price_label: '€189 a month', credits: null, blurb: null },
      { offer_id: OFFER.pack10.id, title: '10 Class Pack', price_label: '€125', credits: 10, blurb: 'Use within three months' },
    ])
    // archived, free and another studio's product are skipped and counted.
    expect(out.skipped).toBe(3)
  })

  it('ties on sort_order fall back to the offer id', async () => {
    const a = { ...OFFER.pack10, id: 'd0000000-0000-4000-8000-00000000000b', sort_order: 0 }
    const b = { ...OFFER.monthly, id: 'd0000000-0000-4000-8000-00000000000a', sort_order: 0 }
    const { db } = fakeDb({ mia_purchase_offers: [a, b] })
    expect((await listPurchaseOptions(db, HATCH)).offers.map((o) => o.offer_id)).toEqual([b.id, a.id])
  })

  it('no offers: an empty list, no product read', async () => {
    const { db, calls } = fakeDb()
    expect(await listPurchaseOptions(db, HATCH)).toEqual({ offers: [], skipped: 0 })
    expect(calls.some((c) => c.table === 'un1t_products')).toBe(false)
  })

  it('a failed read throws (never an empty list)', async () => {
    for (const fail of [{ mia_purchase_offers: { select: true } }, { un1t_products: { select: true } }]) {
      const { db } = fakeDb({ mia_purchase_offers: [OFFER.pack10] }, { fail })
      await expect(listPurchaseOptions(db, HATCH)).rejects.toThrow()
    }
  })
})

describe('pay-done token', () => {
  it('32 random bytes base64url; only the sha256 hex hash is kept', () => {
    const a = mintPayDoneToken()
    const b = mintPayDoneToken()
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32)
    expect(a.hash).toBe(createHash('sha256').update(a.token).digest('hex'))
    expect(hashPayDoneToken(a.token)).toBe(a.hash)
    expect(a.token).not.toBe(b.token)
  })
})

describe('sendPurchaseLink', () => {
  const offers = () => ({ mia_purchase_offers: [OFFER.pack10, OFFER.monthly] })

  it('createCheckoutLink called with userId (un1t user id), not a contact id, and idempotencyKey = intent id', async () => {
    const { db, data } = fakeDb(offers())
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)

    expect(h.checkout).toHaveBeenCalledTimes(1)
    const [, args] = h.checkout.mock.calls[0]
    const intent = data.mia_purchase_intents[0]
    expect(args).toMatchObject({ locationId: HATCH, userId: USER, productId: 'prod-pack-10', idempotencyKey: intent.id, origin: 'mia', originRef: intent.id })
    expect(args.userId).not.toBe(HATCH_CONTACT)
    expect(intent).toMatchObject({
      location_id: HATCH, organization_id: ORG, contact_id: HATCH_CONTACT, conversation_id: 'conv-1', channel: 'whatsapp',
      un1t_user_id: USER, un1t_product_id: 'prod-pack-10', product_title: '10 Class Pack', price_cents: 12500,
      status: 'link_sent', checkout_url: urlFor(intent.id), event_un1t_id: null,
      entitlement_snapshot: { ok: true, balance: 0, unlimited: false, live_subscription_ids: [] },
    })
    expect(Date.parse(intent.expires_at) - Date.parse(intent.created_at)).toBe(PURCHASE_INTENT_TTL_MS)
    expect(PURCHASE_INTENT_TTL_MS).toBe(23 * 3600_000)
    expect(intent.updated_at).toBeTruthy()
    expect(fetchLiveEntitlement).toHaveBeenCalledWith(db, { locationId: HATCH, un1tUserId: USER })
    expect(out).toEqual({
      link_sent: true,
      url: urlFor(intent.id),
      product: '10 Class Pack',
      price_label: '€125',
      wording: "Here's your secure payment link for 10 Class Pack. I'll let you know when it's done.",
      intent_id: intent.id,
      message: expect.stringMatching(/end your message with the url/i),
    })
  })

  it('URLs on resolveCustomerBaseUrl host, https; the token in them hashes to the stored hash', async () => {
    const { db, data } = fakeDb(offers())
    await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(resolveCustomerBaseUrl).toHaveBeenCalledWith(db, HATCH)
    const [, { successUrl, cancelUrl }] = h.checkout.mock.calls[0]
    const s = new URL(successUrl)
    const c = new URL(cancelUrl)
    expect(s.protocol).toBe('https:')
    expect(s.host).toBe('hatch.example.test')
    expect(c.host).toBe('hatch.example.test')
    const token = s.pathname.replace('/pay-done/', '')
    expect(s.pathname).toMatch(/^\/pay-done\/[A-Za-z0-9_-]{43}$/)
    expect(cancelUrl).toBe(`${successUrl}?c=1`)
    expect(data.mia_purchase_intents[0].success_token_hash).toBe(hashPayDoneToken(token))
    expect(JSON.stringify(data.mia_purchase_intents[0])).not.toContain(token)
  })

  it('with a class: the class from the mirror, in the studio zone; the wording names it', async () => {
    const { db, data } = fakeDb({
      ...offers(),
      un1t_events: [{ location_id: HATCH, un1t_id: EVENT, title: 'Fictional Hatch HIIT', starts_at: STARTS, status: 'scheduled' }],
    })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id, event_id: `un1t:${EVENT}`, class_name: 'HIIT', class_time: 'Fri', starts_at: LABEL }, hatch(), deps)
    expect(data.mia_purchase_intents[0]).toMatchObject({
      event_un1t_id: EVENT, class_name: 'Fictional Hatch HIIT', class_time: LABEL, starts_at: new Date(STARTS).toISOString(),
    })
    expect(out.wording).toBe(`Here's your secure payment link for 10 Class Pack. Once it goes through I'll book you into Fictional Hatch HIIT, ${LABEL}.`)
  })

  // Ruling 30 — a stored link is resent as it is: no call to D at all.
  it('same product with a stored link: that link resent, no D call, nothing written', async () => {
    const live = liveIntent({ checkout_url: 'https://pay.example.test/s/stored', class_name: 'Fictional Hatch HIIT', class_time: LABEL })
    const { db, data, calls } = fakeDb({ ...offers(), mia_purchase_intents: [live] })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(h.checkout).not.toHaveBeenCalled()
    expect(resolveCustomerBaseUrl).not.toHaveBeenCalled()
    expect(out).toEqual({
      link_sent: true, url: 'https://pay.example.test/s/stored', product: '10 Class Pack', price_label: '€125',
      wording: `Here's your secure payment link for 10 Class Pack. Once it goes through I'll book you into Fictional Hatch HIIT, ${LABEL}.`,
      intent_id: live.id, message: expect.any(String),
    })
    expect(data.mia_purchase_intents).toHaveLength(1)
    expect(data.mia_purchase_intents[0].success_token_hash).toBe('a'.repeat(64))
    expect(calls.some((c) => c.op !== 'select')).toBe(false)
    expect(fetchLiveEntitlement).not.toHaveBeenCalled()
  })

  describe('same product with no stored link (an earlier store failed): D again with the intent key', () => {
    it('D returns a link: resent, and stored with the hash of the token minted for this call', async () => {
      const live = liveIntent({ checkout_url: null })
      const { db, data } = fakeDb({ ...offers(), mia_purchase_intents: [live] })
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      expect(h.checkout).toHaveBeenCalledTimes(1)
      const [, args] = h.checkout.mock.calls[0]
      expect(args).toMatchObject({ idempotencyKey: live.id, originRef: live.id, userId: USER, productId: 'prod-pack-10' })
      expect(out).toMatchObject({ link_sent: true, url: urlFor(live.id), intent_id: live.id })
      const token = new URL(args.successUrl).pathname.replace('/pay-done/', '')
      expect(data.mia_purchase_intents).toHaveLength(1)
      expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'link_sent', checkout_url: urlFor(live.id), success_token_hash: hashPayDoneToken(token) })
      expect(data.mia_purchase_intents[0].updated_at).toBeTruthy()
    })

    it('D unknown or refused: nothing was ever delivered, so the intent is refused and the team takes over', async () => {
      for (const err of [new Un1tWriteUnknown('outcome_unknown', 'unclear'), new Un1tWriteRefused('product_not_sellable', 'no')]) {
        vi.clearAllMocks()
        h.checkout.mockRejectedValueOnce(err)
        const { db, data } = fakeDb({ ...offers(), mia_purchase_intents: [liveIntent({ checkout_url: null })] })
        const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
        expect(out).toMatchObject({ link_sent: false, handoff: true })
        expect(out.url).toBeUndefined()
        expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'refused', outcome: { stage: 'checkout', code: err.code } })
      }
    })
  })

  it('different product -> purchase_link_open_text, no second call', async () => {
    const live = liveIntent()
    const { db, data } = fakeDb({ ...offers(), mia_purchase_intents: [live] })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.monthly.id }, hatch(), deps)
    expect(h.checkout).not.toHaveBeenCalled()
    expect(out).toEqual({
      link_sent: false, link_open: true, product: '10 Class Pack',
      text: DEFAULT_PURCHASE_LINK_OPEN_TEXT.replace('{product}', '10 Class Pack'), intent_id: live.id,
      message: expect.any(String),
    })
    expect(data.mia_purchase_intents).toHaveLength(1)
    expect(data.mia_purchase_intents[0].status).toBe('link_sent')
  })

  it('an operator purchase_link_open_text wins', async () => {
    const { db } = fakeDb({ ...offers(), mia_purchase_intents: [liveIntent()] })
    const out = await sendPurchaseLink(ctxFor(db, { settings: { purchase_link_open_text: 'Your {product} link is still open.' } }), { offer_id: OFFER.monthly.id }, hatch(), deps)
    expect(out.text).toBe('Your 10 Class Pack link is still open.')
  })

  describe('concurrent insert 23505 -> treated as live intent, no tool error (Review Focus 1)', () => {
    it('the other turn wins with the same product: resend its link with its key, no second intent', async () => {
      const other = liveIntent({ id: '80000000-0000-4000-8000-0000000000aa', checkout_url: null })
      const { db, data } = fakeDb(offers(), {
        onInsert: (table, _row, d) => { if (table === 'mia_purchase_intents' && d[table].length === 0) d[table].push(other) },
      })
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      expect(out).toMatchObject({ link_sent: true, url: urlFor(other.id), intent_id: other.id })
      expect(out.error).toBeUndefined()
      expect(h.checkout).toHaveBeenCalledTimes(1)
      expect(h.checkout.mock.calls[0][1].idempotencyKey).toBe(other.id)
      expect(data.mia_purchase_intents).toHaveLength(1)
      expect(data.mia_purchase_intents[0].checkout_url).toBe(urlFor(other.id))
    })

    it('the other turn wins with a different product: the open text, no link at all', async () => {
      const other = liveIntent({ id: '80000000-0000-4000-8000-0000000000bb', un1t_product_id: 'prod-monthly', product_title: 'Monthly Foundation' })
      const { db, data } = fakeDb(offers(), {
        onInsert: (table, _row, d) => { if (table === 'mia_purchase_intents' && d[table].length === 0) d[table].push(other) },
      })
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      expect(out).toMatchObject({ link_sent: false, link_open: true, product: 'Monthly Foundation' })
      expect(h.checkout).not.toHaveBeenCalled()
      expect(data.mia_purchase_intents).toHaveLength(1)
    })

    it('two turns at once: one live intent, both answered with the same link, one checkout key', async () => {
      const { db, data } = fakeDb(offers())
      const [a, b] = await Promise.all([
        sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps),
        sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps),
      ])
      expect(data.mia_purchase_intents).toHaveLength(1)
      const id = data.mia_purchase_intents[0].id
      expect(a).toMatchObject({ link_sent: true, url: urlFor(id) })
      expect(b).toMatchObject({ link_sent: true, url: urlFor(id) })
      expect(new Set(h.checkout.mock.calls.map(([, args]) => args.idempotencyKey))).toEqual(new Set([id]))
    })
  })

  it('refusal -> intent refused + handoff text', async () => {
    for (const err of [
      new Un1tWriteRefused(C.WRITES_OFF, 'writes are off', { ledgerId: null }),
      new Un1tWriteRefused('product_not_sellable', 'not sellable'),
      Object.assign(new Un1tWriteUnknown('outcome_unknown', 'unclear'), { ledgerId: '70000000-0000-4000-8000-000000000001' }),
      new Un1tSettingsReadError('switch unreadable', { code: 'customer_url_unreadable' }),
    ]) {
      vi.clearAllMocks()
      h.checkout.mockRejectedValueOnce(err)
      const { db, data } = fakeDb(offers())
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      const intent = data.mia_purchase_intents[0]
      expect(intent.status, err.name).toBe('refused')
      expect(intent.outcome).toMatchObject({ stage: 'checkout', code: err.code })
      expect(intent.checkout_url ?? null).toBeNull()
      expect(intent.updated_at).toBeTruthy()
      if (err instanceof Un1tWriteUnknown) expect(intent.un1t_write_id).toBe('70000000-0000-4000-8000-000000000001')
      expect(out).toMatchObject({ link_sent: false, handoff: true })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(out.url).toBeUndefined()
      expect(logWarn.mock.calls.concat(logError.mock.calls).some(([mod, , meta]) => mod === 'mia-un1t' && meta?.code === err.code)).toBe(true)
    }
  })

  it('a relayed starts_at that does not name the class (or none): no link, no intent, no D call', async () => {
    const tables = () => ({ ...offers(), un1t_events: [{ location_id: HATCH, un1t_id: EVENT, title: 'Fictional Hatch HIIT', starts_at: STARTS, status: 'scheduled' }] })
    const other = formatClassTime(Date.parse(STARTS) / 1000 + 3600, ZONE)
    for (const starts_at of [other, undefined, '2026-10-23T18:30', 'Saturday 7am']) {
      const { db, data } = fakeDb(tables())
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id, event_id: `un1t:${EVENT}`, starts_at }, hatch(), deps)
      expect(out, String(starts_at)).toMatchObject({ link_sent: false, error: 'class_time_mismatch' })
      expect(data.mia_purchase_intents).toHaveLength(0)
    }
    expect(h.checkout).not.toHaveBeenCalled()
    // An ISO instant with an offset that names it matches.
    const { db } = fakeDb(tables())
    expect(await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id, event_id: `un1t:${EVENT}`, starts_at: STARTS }, hatch(), deps)).toMatchObject({ link_sent: true })
  })

  it('an operator booking_issue_handoff_text is the handoff', async () => {
    h.checkout.mockRejectedValueOnce(new Un1tWriteRefused(C.WRITES_OFF, 'off'))
    const { db } = fakeDb(offers())
    const out = await sendPurchaseLink(ctxFor(db, { settings: { booking_issue_handoff_text: 'The team will sort your payment.' } }), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(out.message).toContain('The team will sort your payment.')
  })

  it('resend hit a retryable refusal (another turn mid-send): try again, the intent is untouched', async () => {
    h.checkout.mockRejectedValueOnce(new Un1tWriteRefused(C.ATTEMPT_IN_FLIGHT, 'in flight'))
    const live = liveIntent({ checkout_url: null })
    const { db, data } = fakeDb({ ...offers(), mia_purchase_intents: [live] })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(out).toMatchObject({ link_sent: false, try_again: true })
    expect(data.mia_purchase_intents[0].status).toBe('link_sent')
  })

  // MIAHATCH.6 (Task 21, Task 19 carry 1) — free: true is settled at once
  // through settlePurchaseIntent: no row stays in the non-terminal 'paid'.
  it('free: true settles at once through settle: no class -> no_class + purchase_paid_no_class_text, no link sent', async () => {
    h.checkout.mockResolvedValueOnce({ checkoutUrl: urlFor('free'), free: true })
    const { db, data } = fakeDb(offers())
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    const intent = data.mia_purchase_intents[0]
    expect(intent).toMatchObject({ status: 'no_class', detected_by: 'tool', paid_detected_at: new Date(NOW).toISOString() })
    expect(intent.outcome).toMatchObject({ free: true, result: 'paid_no_class' })
    expect(intent.checkout_url ?? null).toBeNull()
    expect(h.book).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_no_class_text', h.settings))
    expect(out).toMatchObject({ link_sent: false, paid: true, outcome: 'paid_no_class', product: '10 Class Pack' })
    expect(out.url).toBeUndefined()
    expect(data.mia_purchase_intents.some((r) => r.status === 'paid')).toBe(false)
  })

  it('checkout URL never in a log call', async () => {
    // Every path that holds a URL: new, resend, store failure, free.
    const { db } = fakeDb(offers(), { fail: { mia_purchase_intents: { update: true } } })
    await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    const live = fakeDb({ ...offers(), mia_purchase_intents: [liveIntent()] })
    await sendPurchaseLink(ctxFor(live.db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    h.checkout.mockResolvedValueOnce({ checkoutUrl: urlFor('free'), free: true })
    await sendPurchaseLink(ctxFor(fakeDb(offers()).db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(logWarn.mock.calls.length + logError.mock.calls.length).toBeGreaterThan(0)
    expect(allLogText()).not.toContain('pay.example.test')
    expect(allLogText()).not.toContain('/pay-done/')
  })

  it('a link that could not be stored is still sent (the member can pay; detection does not need it)', async () => {
    const { db } = fakeDb(offers(), { fail: { mia_purchase_intents: { update: true } } })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(out.link_sent).toBe(true)
    expect(logError).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ op: 'purchase_store_link' }))
  })

  it('an expired live intent is marked expired and a new one made', async () => {
    const old = liveIntent({ expires_at: new Date(NOW - 1000).toISOString() })
    const { db, data } = fakeDb({ ...offers(), mia_purchase_intents: [old] })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    expect(data.mia_purchase_intents).toHaveLength(2)
    expect(data.mia_purchase_intents[0].status).toBe('expired')
    expect(data.mia_purchase_intents[1].status).toBe('link_sent')
    expect(h.checkout.mock.calls[0][1].idempotencyKey).toBe(data.mia_purchase_intents[1].id)
    expect(out.link_sent).toBe(true)
  })

  it('an unknown, inactive or free offer is not available; no intent', async () => {
    const { db, data } = fakeDb({ mia_purchase_offers: [OFFER.old, OFFER.free] })
    for (const offer_id of ['not-an-id', 'd0000000-0000-4000-8000-0000000000ff', OFFER.old.id, OFFER.free.id]) {
      expect(await sendPurchaseLink(ctxFor(db), { offer_id }, hatch(), deps)).toMatchObject({ link_sent: false, error: 'offer_not_available' })
    }
    expect(data.mia_purchase_intents).toHaveLength(0)
    expect(h.checkout).not.toHaveBeenCalled()
  })

  it('unverified, or no account at the studio: nothing read', async () => {
    const { db, calls } = fakeDb(offers())
    expect(await sendPurchaseLink(ctxFor(db, { verifiedContactId: null }), { offer_id: OFFER.pack10.id }, hatch(), deps)).toMatchObject({ error: 'not_verified' })
    expect(await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch({ un1tUserId: null }), deps)).toMatchObject({ link_sent: false, not_linked: true })
    expect(calls).toHaveLength(0)
  })

  it('a failed intent read or insert is try again, never a link', async () => {
    for (const fail of [{ mia_purchase_intents: { select: true } }, { mia_purchase_intents: { insert: true } }, { locations: { select: true } }]) {
      const { db } = fakeDb(offers(), { fail })
      expect(await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)).toMatchObject({ link_sent: false, try_again: true })
    }
    expect(h.checkout).not.toHaveBeenCalled()
  })
})

describe('executePurchaseTool', () => {
  it('purchase tools refused outside un1t_full (invented-tool test), before any read', async () => {
    const db = { from: vi.fn(() => { throw new Error('no read may happen') }) }
    for (const block of ['glofox', 'no_booking', 'un1t_read', 'un1t_read_dual']) {
      const turn = { block, channel: 'whatsapp', un1tWrites: false, answerable: [hatch()] }
      for (const name of ['list_purchase_options', 'send_purchase_link', 'check_my_purchase']) {
        expect(refuseToolForTurn(name, { turn })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
        expect(await executePurchaseTool(name, { offer_id: OFFER.pack10.id }, ctxFor(db, { turn }))).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      }
    }
    // Instagram, or writes off, refuses in un1t_full too; no turn at all refuses.
    for (const turn of [{ ...FULL_TURN, channel: 'instagram' }, { ...FULL_TURN, un1tWrites: false }]) {
      expect(refuseToolForTurn('send_purchase_link', { turn })).toEqual(TOOL_NOT_AT_THIS_STUDIO)
      expect(await executePurchaseTool('send_purchase_link', {}, ctxFor(db, { turn }))).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    }
    expect(await executePurchaseTool('send_purchase_link', {}, ctxFor(db, { turn: null }))).toEqual(TOOL_NOT_AT_THIS_STUDIO)
    expect(db.from).not.toHaveBeenCalled()
    // Offered in un1t_full on WhatsApp with writes.
    expect(refuseToolForTurn('send_purchase_link', { turn: FULL_TURN })).toBeNull()
  })

  it('list_purchase_options: the offers and the intro wording; unreadable is a neutral handoff', async () => {
    const { db } = fakeDb({ mia_purchase_offers: [OFFER.pack10] })
    const out = await executePurchaseTool('list_purchase_options', {}, ctxFor(db))
    expect(out).toMatchObject({ offers: [{ offer_id: OFFER.pack10.id, price_label: '€125' }], trial_available: false })
    expect(out.wording).toMatch(/keep training/)
    const none = await executePurchaseTool('list_purchase_options', {}, ctxFor(fakeDb().db))
    expect(none).toMatchObject({ offers: [] })
    expect(none.message).toMatch(/hand off/i)
    const broken = await executePurchaseTool('list_purchase_options', {}, ctxFor(fakeDb({}, { fail: { mia_purchase_offers: { select: true } } }).db))
    expect(broken).toMatchObject({ error: 'offers_unreadable' })
  })

  it('send_purchase_link runs at the answerable un1t.online studio', async () => {
    const { db } = fakeDb({ mia_purchase_offers: [OFFER.pack10] })
    const out = await executePurchaseTool('send_purchase_link', { offer_id: OFFER.pack10.id }, ctxFor(db))
    expect(out.link_sent).toBe(true)
    expect(h.checkout.mock.calls[0][1].locationId).toBe(HATCH)
  })

  it('check_my_purchase: nothing paid yet is neutral (an open intent, or none); never says paid', async () => {
    const open = await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb({ mia_purchase_intents: [liveIntent()] }).db))
    expect(open).toMatchObject({ paid: false, open_intent: true, product: '10 Class Pack' })
    expect(open.message).toMatch(/not showing yet/)
    expect(JSON.stringify(open)).not.toContain('pay.example.test')
    const none = await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb().db))
    expect(none).toMatchObject({ paid: false, open_intent: false })
    const broken = await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb({}, { fail: { mia_purchase_intents: { select: true } } }).db))
    expect(broken).toMatchObject({ paid: false, error: 'purchase_unreadable' })
    expect(await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb().db, { verifiedContactId: null }))).toMatchObject({ error: 'not_verified' })
  })

  it('model-facing text has no em or en dashes', async () => {
    const { db } = fakeDb({ mia_purchase_offers: [OFFER.pack10], mia_purchase_intents: [liveIntent()] })
    const outs = [
      await executePurchaseTool('list_purchase_options', {}, ctxFor(db)),
      await executePurchaseTool('send_purchase_link', { offer_id: 'trial' }, ctxFor(db)),
      await executePurchaseTool('check_my_purchase', {}, ctxFor(db)),
    ]
    for (const o of outs) expect(JSON.stringify(o)).not.toMatch(/[—–]/)
    expect(isUuid(OFFER.pack10.id)).toBe(true)
  })
})

// MIAHATCH.6 (Task 20, spec R1) — the free trial first, only to eligible
// members, through D's grantTrial. A's trialEligibility (h.elig) is reached
// through the reads seam; grantTrial (h.grantTrial) and book (h.book) are
// fakes; the trial never goes through createCheckoutLink.
describe('the free trial (Task 20)', () => {
  const TRIAL_LOC = { id: HATCH, organization_id: ORG, settings: { un1t_online: { trial_product_id: 'prod-trial-1' } } }
  const NO_TRIAL_LOC = { id: HATCH, organization_id: ORG, settings: { un1t_online: {} } }
  const EVENT_ROW = { location_id: HATCH, un1t_id: EVENT, title: 'Fictional Hatch HIIT', starts_at: STARTS, status: 'scheduled', synced_at: '2026-10-20T08:55:00Z' }
  const withTrial = (over = {}) => fakeDb({ locations: [TRIAL_LOC], mia_purchase_offers: [OFFER.pack10], un1t_events: [EVENT_ROW], agent_membership_requests: [], ...over })
  const classInput = (over = {}) => ({ offer_id: 'trial', event_id: `un1t:${EVENT}`, class_name: 'Fictional Hatch HIIT', class_time: LABEL, starts_at: LABEL, ...over })
  const requestInserts = (calls) => calls.filter((c) => c.table === 'agent_membership_requests' && c.op === 'insert')
  const pendingCards = (data) => (data.agent_membership_requests || []).filter((r) => r.status === 'pending')
  const PACK_OFFER = { offer_id: OFFER.pack10.id, title: '10 Class Pack', price_label: '€125', credits: 10, blurb: 'Use within three months' }

  describe('trialAvailable', () => {
    it('reads A\'s trialEligibility with { un1tUserId, contactId } and is available only on eligible === true', async () => {
      const { db } = withTrial()
      expect(await trialAvailable(db, { locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT })).toEqual({ available: true, reasons: [] })
      expect(h.readsFor).toHaveBeenCalledWith(db, HATCH)
      expect(h.elig).toHaveBeenCalledWith(db, HATCH, { un1tUserId: USER, contactId: HATCH_CONTACT })
    })

    it('success true but data.eligible missing (or not exactly true): not available, fail closed', async () => {
      for (const data of [{ reasons: [] }, { eligible: 'yes', reasons: [] }, null]) {
        h.elig.mockResolvedValueOnce({ success: true, data })
        const out = await trialAvailable(withTrial().db, { locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT })
        expect(out.available).toBe(false)
        expect(out.readFailed).toBeUndefined()
      }
    })

    it('not eligible: the reasons as A gives them', async () => {
      h.elig.mockResolvedValueOnce({ success: true, data: { eligible: false, reasons: ['trial_used', 'paid_pack'] } })
      expect(await trialAvailable(withTrial().db, { locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT }))
        .toEqual({ available: false, reasons: ['trial_used', 'paid_pack'] })
    })

    it('no trial_product_id: not available, no reasons, A is never asked', async () => {
      expect(await trialAvailable(fakeDb({ locations: [NO_TRIAL_LOC] }).db, { locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT }))
        .toEqual({ available: false, reasons: [] })
      expect(h.elig).not.toHaveBeenCalled()
    })

    it('a failed read (A says success false, A throws, no adapter, settings unreadable) is readFailed, never available', async () => {
      const ask = (db) => trialAvailable(db, { locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT })
      h.elig.mockResolvedValueOnce({ success: false, error: 'fictional' })
      expect(await ask(withTrial().db)).toEqual({ available: false, reasons: [], readFailed: true })
      h.elig.mockRejectedValueOnce(new Error('fictional'))
      expect(await ask(withTrial().db)).toEqual({ available: false, reasons: [], readFailed: true })
      h.readsFor.mockResolvedValueOnce({ state: 'unconfigured', reads: null })
      expect(await ask(withTrial().db)).toEqual({ available: false, reasons: [], readFailed: true })
      expect(await ask(fakeDb({ locations: [TRIAL_LOC] }, { fail: { locations: { select: true } } }).db)).toEqual({ available: false, reasons: [], readFailed: true })
    })
  })

  describe('offered before anything else', () => {
    it('list_purchase_options asks A before the trial is offered: trial_available true, with the offers', async () => {
      const out = await executePurchaseTool('list_purchase_options', {}, ctxFor(withTrial().db))
      expect(h.elig).toHaveBeenCalledWith(expect.anything(), HATCH, { un1tUserId: USER, contactId: HATCH_CONTACT })
      expect(out).toMatchObject({ offers: [PACK_OFFER], trial_available: true })
      expect(out.message).toMatch(/free trial[^\n]*first/i)
      expect(out.message).toMatch(/offer_id "trial"/)
    })

    it('book_class needs_purchase carries trial_available from A (default offersFor)', async () => {
      const ok = await un1tBookClass(ctxFor(withTrial().db), classInput(), hatch(), deps)
      expect(ok).toMatchObject({ booked: false, needs_purchase: true, trial_available: true, offers: [PACK_OFFER] })
      expect(ok.message).toMatch(/free trial: offer it first/)
      h.elig.mockResolvedValueOnce({ success: true, data: { eligible: false, reasons: ['trial_used'] } })
      const used = await un1tBookClass(ctxFor(withTrial().db), classInput(), hatch(), deps)
      expect(used).toMatchObject({ needs_purchase: true, trial_available: false })
      expect(used.message).toBeUndefined()
      expect(h.book).not.toHaveBeenCalled()
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('book_class with no paid offers but the trial: needs_purchase with the trial alone, no card', async () => {
      const { db, data } = withTrial({ mia_purchase_offers: [] })
      expect(await un1tBookClass(ctxFor(db), classInput(), hatch(), deps)).toMatchObject({ needs_purchase: true, trial_available: true, offers: [] })
      expect(pendingCards(data)).toEqual([])
    })

    it('offersForBooking: offers + trial_available, and trial_check_failed on a failed read', async () => {
      const ctx = ctxFor(withTrial().db)
      expect(await offersForBooking(ctx, hatch())).toEqual({ offers: [PACK_OFFER], trial_available: true })
      h.elig.mockResolvedValueOnce({ success: false, error: 'fictional' })
      expect(await offersForBooking(ctx, hatch())).toEqual({ offers: [PACK_OFFER], trial_available: false, trial_check_failed: true })
    })

    it('no trial_product_id: offers only (list_purchase_options and book_class), A never asked', async () => {
      const db = fakeDb({ locations: [NO_TRIAL_LOC], mia_purchase_offers: [OFFER.pack10], un1t_events: [EVENT_ROW] }).db
      expect(await executePurchaseTool('list_purchase_options', {}, ctxFor(db))).toMatchObject({ offers: [PACK_OFFER], trial_available: false })
      expect(await un1tBookClass(ctxFor(db), classInput(), hatch(), deps)).toMatchObject({ needs_purchase: true, trial_available: false })
      expect(h.elig).not.toHaveBeenCalled()
    })
  })

  describe('a failed eligibility read before the offer', () => {
    it('list_purchase_options: no trial offered, ONE class_booking card un1t_trial_check_failed + booking_issue_handoff_text', async () => {
      h.elig.mockResolvedValue({ success: false, error: 'fictional' })
      const { db, data } = withTrial()
      const out = await executePurchaseTool('list_purchase_options', {}, ctxFor(db))
      expect(out).toMatchObject({ handoff: true, reason: 'un1t_trial_check_failed' })
      expect(out.trial_available).not.toBe(true)
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      const cards = pendingCards(data)
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({ kind: 'class_booking', location_id: HATCH, contact_id: HATCH_CONTACT })
      expect(cards[0].details).toMatchObject({ provider: 'un1t_online', origin: 'mia', reason: 'un1t_trial_check_failed', un1t_user_id: USER, executing_contact_id: HATCH_CONTACT })
      // A second ask reuses the card.
      await executePurchaseTool('list_purchase_options', {}, ctxFor(db))
      expect(pendingCards(data)).toHaveLength(1)
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('book_class: one card carrying the class keys Task 16 uses + handoff, nothing booked or granted', async () => {
      h.elig.mockResolvedValue({ success: false, error: 'fictional' })
      const { db, data } = withTrial()
      const out = await un1tBookClass(ctxFor(db), classInput(), hatch(), deps)
      expect(out).toMatchObject({ booked: false, handoff: true, reason: 'un1t_trial_check_failed' })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(out.offers).toBeUndefined()
      const cards = pendingCards(data)
      expect(cards).toHaveLength(1)
      expect(cards[0].details).toMatchObject({
        provider: 'un1t_online', origin: 'mia', reason: 'un1t_trial_check_failed', event_id: EVENT, un1t_user_id: USER,
        executing_contact_id: HATCH_CONTACT, starts_at: new Date(STARTS).toISOString(), class_name: 'Fictional Hatch HIIT', class_time: LABEL,
      })
      expect(h.book).not.toHaveBeenCalled()
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('send_purchase_link trial: card (with the class keys when named) + handoff, no grant', async () => {
      h.elig.mockResolvedValue({ success: false, error: 'fictional' })
      const named = withTrial()
      const out = await sendPurchaseLink(ctxFor(named.db), classInput(), hatch(), deps)
      expect(out).toMatchObject({ handoff: true, reason: 'un1t_trial_check_failed' })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(pendingCards(named.data)).toHaveLength(1)
      expect(pendingCards(named.data)[0].details).toMatchObject({ reason: 'un1t_trial_check_failed', event_id: EVENT, class_name: 'Fictional Hatch HIIT' })
      const bare = withTrial()
      await sendPurchaseLink(ctxFor(bare.db), { offer_id: 'trial' }, hatch(), deps)
      expect(pendingCards(bare.data)).toHaveLength(1)
      expect(pendingCards(bare.data)[0].details.event_id).toBeUndefined()
      expect(h.grantTrial).not.toHaveBeenCalled()
    })
  })

  describe('send_purchase_link({ offer_id: "trial" })', () => {
    it('each not-eligible reason, and two at once: trial_used_text + offers, grantTrial never called', async () => {
      for (const reasons of [['trial_used'], ['membership_history'], ['paid_pack'], ['trial_used', 'paid_pack']]) {
        h.elig.mockResolvedValueOnce({ success: true, data: { eligible: false, reasons } })
        const { db, data } = withTrial()
        const out = await sendPurchaseLink(ctxFor(db), { offer_id: 'trial' }, hatch(), deps)
        expect(out).toMatchObject({ link_sent: false, trial_used: true, text: DEFAULT_TRIAL_USED_TEXT, offers: [PACK_OFFER] })
        expect(data.agent_membership_requests).toEqual([])
      }
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('eligible missing (fail closed) or no trial_product_id: not given, offers only, never trial_used_text', async () => {
      h.elig.mockResolvedValueOnce({ success: true, data: { reasons: [] } })
      const missing = await sendPurchaseLink(ctxFor(withTrial().db), { offer_id: 'trial' }, hatch(), deps)
      const unset = await sendPurchaseLink(ctxFor(fakeDb({ locations: [NO_TRIAL_LOC], mia_purchase_offers: [OFFER.pack10] }).db), { offer_id: 'trial' }, hatch(), deps)
      for (const out of [missing, unset]) {
        expect(out).toMatchObject({ link_sent: false, trial_available: false, offers: [PACK_OFFER] })
        expect(out.trial_used).toBeUndefined()
        expect(JSON.stringify(out)).not.toContain(DEFAULT_TRIAL_USED_TEXT)
      }
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('granted with a class: the write-ahead class_booking row (stage trial) first, its id the originRef, then Task 16\'s book -> booked', async () => {
      const { db, data, calls } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
      expect(out).toMatchObject({ trial_granted: true, booked: true, class_name: 'Fictional Hatch HIIT', class_time: LABEL })
      const inserted = requestInserts(calls)
      expect(inserted).toHaveLength(1)
      expect(inserted[0].row).toMatchObject({ kind: 'class_booking', status: 'pending', contact_id: HATCH_CONTACT })
      expect(inserted[0].row.details).toMatchObject({ provider: 'un1t_online', origin: 'mia', stage: 'trial', event_id: EVENT, un1t_user_id: USER })
      const rowId = data.agent_membership_requests[0].id
      expect(h.grantTrial).toHaveBeenCalledTimes(1)
      expect(h.grantTrial.mock.calls[0][1]).toEqual({ locationId: HATCH, un1tUserId: USER, contactId: HATCH_CONTACT, origin: 'mia', originRef: rowId, actor: null })
      expect(h.book).toHaveBeenCalledTimes(1)
      expect(h.book.mock.calls[0][1]).toMatchObject({ locationId: HATCH, un1tUserId: USER, eventId: EVENT, origin: 'mia', originRef: rowId, actor: null })
      // The grant came first.
      expect(h.grantTrial.mock.invocationCallOrder[0]).toBeLessThan(h.book.mock.invocationCallOrder[0])
      expect(data.agent_membership_requests[0]).toMatchObject({ status: 'actioned' })
      expect(data.agent_membership_requests[0].details.trial).toMatchObject({ outcome: 'granted', method: 'charge', ledger_id: 'led-trial-1' })
    })

    // Fix round 1: after D granted the trial, every booking outcome keeps the
    // trial (the model hears it is on their account, any retry is book_class)
    // and nothing is ever sold on top of it.
    const bookResult = (over) => ({ verdict: 'refused', sent: false, id: null, code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-book-2', ...over })
    const keepsTheTrial = (out) => {
      expect(out.trial_granted).toBe(true)
      expect(out.booked).not.toBe(true)
      expect(out.message).toMatch(/^The free trial is on their account now: tell them so\./)
      expect(out.message).toMatch(/use book_class/)
      expect(out.needs_purchase).toBeUndefined()
      expect(out.offers).toBeUndefined()
      expect(out.trial_used).toBeUndefined()
    }

    it('granted, then book unknown: Task 16\'s un1t_outcome_unknown card + handoff, the trial kept', async () => {
      h.book.mockResolvedValueOnce(bookResult({ verdict: 'unknown', sent: true }))
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
      keepsTheTrial(out)
      expect(out).toMatchObject({ handoff: true, reason: 'un1t_outcome_unknown' })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(pendingCards(data)).toHaveLength(1)
      expect(pendingCards(data)[0].details).toMatchObject({ reason: 'un1t_outcome_unknown', trial: { outcome: 'granted' } })
    })

    it('granted, then class full: relayed, the trial kept, no card', async () => {
      h.book.mockResolvedValueOnce(bookResult({ code: 'TEST_CLASS_FULL', message: 'Class is full' }))
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
      keepsTheTrial(out)
      expect(out).toMatchObject({ reason: 'class_full' })
      expect(out.message).toMatch(/That class is full/)
      expect(data.agent_membership_requests[0]).toMatchObject({ status: 'failed' })
      expect(data.agent_membership_requests[0].details).toMatchObject({ reason: 'class_full', trial: { outcome: 'granted' } })
      expect(pendingCards(data)).toEqual([])
    })

    it('granted, then book retry: try again with book_class; a repeat trial call gives nothing more and offers nothing', async () => {
      h.book.mockResolvedValueOnce(bookResult({ code: C.RATE_BUDGET, retryable: true }))
      const { db, data } = withTrial()
      const ctx = ctxFor(db)
      const out = await sendPurchaseLink(ctx, classInput(), hatch(), deps)
      keepsTheTrial(out)
      expect(out).toMatchObject({ try_again: true })
      expect(pendingCards(data)).toEqual([])
      // The model's natural next call: the trial again. No grant, no eligibility read, no upsell.
      h.elig.mockClear()
      const again = await sendPurchaseLink(ctx, classInput(), hatch(), deps)
      expect(again).toMatchObject({ link_sent: false, trial_granted: true, already_granted: true })
      expect(again.message).toMatch(/already on their account/)
      expect(again.message).toMatch(/book_class/)
      expect(again.trial_used).toBeUndefined()
      expect(again.offers).toBeUndefined()
      expect(JSON.stringify(again)).not.toContain(DEFAULT_TRIAL_USED_TEXT)
      expect(h.grantTrial).toHaveBeenCalledTimes(1)
      expect(h.elig).not.toHaveBeenCalled()
      expect(data.agent_membership_requests).toHaveLength(1)
    })

    it('granted, then book no_credits: a staff card un1t_trial_granted_no_credits + handoff, never needs_purchase', async () => {
      h.book.mockResolvedValueOnce(bookResult({ code: 'TEST_NO_CREDITS', message: 'No credits left' }))
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
      keepsTheTrial(out)
      expect(out).toMatchObject({ handoff: true, reason: 'un1t_trial_granted_no_credits' })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      // The write-ahead row is the one card, the trial recorded on it.
      expect(data.agent_membership_requests).toHaveLength(1)
      expect(pendingCards(data)).toHaveLength(1)
      expect(pendingCards(data)[0].details).toMatchObject({
        provider: 'un1t_online', origin: 'mia', reason: 'un1t_trial_granted_no_credits', event_id: EVENT,
        trial: { outcome: 'granted', method: 'charge', ledger_id: 'led-trial-1' },
      })
      // No offer list was read for an upsell.
      expect(h.elig).toHaveBeenCalledTimes(1)
    })

    it('granted with no class, then the trial asked for again in the turn: nothing more given', async () => {
      const ctx = ctxFor(withTrial().db)
      expect(await sendPurchaseLink(ctx, { offer_id: 'trial' }, hatch(), deps)).toMatchObject({ trial_granted: true })
      expect(await sendPurchaseLink(ctx, classInput(), hatch(), deps)).toMatchObject({ already_granted: true })
      expect(h.grantTrial).toHaveBeenCalledTimes(1)
      expect(h.book).not.toHaveBeenCalled()
    })

    it('granted with no class: originRef mia-trial:<conversation>, no row, told the trial is on their account', async () => {
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: 'trial' }, hatch(), deps)
      expect(out).toMatchObject({ link_sent: false, trial_granted: true })
      expect(out.booked).toBeUndefined()
      expect(out.message).toMatch(/on their account/)
      expect(h.grantTrial.mock.calls[0][1]).toMatchObject({ originRef: 'mia-trial:conv-1', origin: 'mia', actor: null })
      expect(data.agent_membership_requests).toEqual([])
      expect(h.book).not.toHaveBeenCalled()
      // No conversation: a non-null ref no other filer uses.
      const ctx = { ...ctxFor(withTrial().db), conversationId: null }
      await sendPurchaseLink(ctx, { offer_id: 'trial' }, hatch(), deps)
      expect(h.grantTrial.mock.calls[1][1].originRef).toBe(`mia-trial-noconv:${HATCH_CONTACT}`)
    })

    it('grantTrial ineligible: trial_used_text + offers, and never grantTrial again in that turn', async () => {
      h.grantTrial.mockResolvedValue({ outcome: 'ineligible', reason: 'membership_history' })
      const { db, data } = withTrial()
      const ctx = ctxFor(db)
      const out = await sendPurchaseLink(ctx, classInput(), hatch(), deps)
      expect(out).toMatchObject({ link_sent: false, trial_used: true, text: DEFAULT_TRIAL_USED_TEXT, offers: [PACK_OFFER] })
      expect(out.booked).not.toBe(true)
      expect(data.agent_membership_requests[0]).toMatchObject({ status: 'failed' })
      expect(pendingCards(data)).toEqual([])
      const again = await sendPurchaseLink(ctx, { offer_id: 'trial' }, hatch(), deps)
      expect(again).toMatchObject({ trial_used: true, text: DEFAULT_TRIAL_USED_TEXT })
      expect(h.grantTrial).toHaveBeenCalledTimes(1)
      expect(h.book).not.toHaveBeenCalled()
    })

    it('needs_staff: exactly ONE class_booking card with needs_staff.reason + handoff text, never booked', async () => {
      h.grantTrial.mockResolvedValue({ outcome: 'needs_staff', reason: 'un1t_trial_unverified', ledgerId: 'led-trial-9' })
      const named = withTrial()
      const out = await sendPurchaseLink(ctxFor(named.db), classInput(), hatch(), deps)
      expect(out).toMatchObject({ handoff: true, reason: 'un1t_trial_unverified' })
      expect(out.booked).not.toBe(true)
      expect(out.trial_granted).not.toBe(true)
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      // The write-ahead row IS the card: one row in all.
      expect(named.data.agent_membership_requests).toHaveLength(1)
      expect(pendingCards(named.data)[0].details).toMatchObject({
        provider: 'un1t_online', origin: 'mia', reason: 'un1t_trial_unverified', event_id: EVENT, class_name: 'Fictional Hatch HIIT',
      })
      expect(pendingCards(named.data)[0].details.stage).toBeUndefined()
      expect(h.book).not.toHaveBeenCalled()

      const bare = withTrial()
      const out2 = await sendPurchaseLink(ctxFor(bare.db), { offer_id: 'trial' }, hatch(), deps)
      expect(out2).toMatchObject({ handoff: true, reason: 'un1t_trial_unverified' })
      expect(bare.data.agent_membership_requests).toHaveLength(1)
      expect(pendingCards(bare.data)[0].details).toMatchObject({ provider: 'un1t_online', origin: 'mia', reason: 'un1t_trial_unverified', un1t_user_id: USER })
    })

    it('needs_staff un1t_trial_failed:<code> (an unmapped trial refusal): card, never trial_used_text; trial_not_configured too', async () => {
      for (const reason of ['un1t_trial_failed:SOME_FICTIONAL_CODE', 'trial_not_configured']) {
        h.grantTrial.mockResolvedValueOnce({ outcome: 'needs_staff', reason, message: 'fictional words' })
        const { db, data } = withTrial()
        const out = await sendPurchaseLink(ctxFor(db), { offer_id: 'trial' }, hatch(), deps)
        expect(out).toMatchObject({ handoff: true, reason })
        expect(out.trial_used).toBeUndefined()
        expect(JSON.stringify(out)).not.toContain(DEFAULT_TRIAL_USED_TEXT)
        expect(pendingCards(data)).toHaveLength(1)
        expect(pendingCards(data)[0].details.reason).toBe(reason)
      }
    })

    it('retry: no card, try-again wording; a SECOND retry in the same turn is booking_issue_handoff_text', async () => {
      h.grantTrial.mockResolvedValue({ outcome: 'retry', code: 'UN1T_RATE_BUDGET' })
      const { db, data } = withTrial()
      const ctx = ctxFor(db)
      const first = await sendPurchaseLink(ctx, classInput(), hatch(), deps)
      expect(first).toMatchObject({ link_sent: false, try_again: true })
      expect(first.message).toMatch(/try again in a few minutes/)
      expect(first.handoff).toBeUndefined()
      expect(pendingCards(data)).toEqual([])
      expect(data.agent_membership_requests[0]).toMatchObject({ status: 'failed' })
      const second = await sendPurchaseLink(ctx, classInput(), hatch(), deps)
      expect(second).toMatchObject({ handoff: true })
      expect(second.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(pendingCards(data)).toEqual([])
      expect(h.book).not.toHaveBeenCalled()
      // A new turn starts counting again.
      const fresh = await sendPurchaseLink(ctxFor(db), { offer_id: 'trial' }, hatch(), deps)
      expect(fresh).toMatchObject({ try_again: true })
    })

    it('grantTrial rejects (nothing sent): the row is closed, handoff, no card', async () => {
      h.grantTrial.mockRejectedValueOnce(new Un1tSettingsReadError('fictional'))
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
      expect(out).toMatchObject({ handoff: true })
      expect(out.message).toContain(DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT)
      expect(pendingCards(data)).toEqual([])
    })

    it('the trial never goes through createCheckoutLink and never makes a purchase intent', async () => {
      for (const grant of [
        { outcome: 'granted', method: 'free_checkout', ledgerId: 'led-t' }, { outcome: 'ineligible', reason: 'trial_used' },
        { outcome: 'needs_staff', reason: 'un1t_trial_failed:X' }, { outcome: 'retry', code: 'UN1T_RATE_LIMITED' },
      ]) {
        h.grantTrial.mockResolvedValueOnce(grant)
        const { db, data, calls } = withTrial()
        await sendPurchaseLink(ctxFor(db), classInput(), hatch(), deps)
        expect(data.mia_purchase_intents).toEqual([])
        expect(calls.some((c) => c.table === 'mia_purchase_intents')).toBe(false)
      }
      expect(h.checkout).not.toHaveBeenCalled()
    })

    it('a class that does not match (or is gone): nothing granted, no row', async () => {
      const { db, data } = withTrial()
      expect(await sendPurchaseLink(ctxFor(db), classInput({ starts_at: 'Sat 24 Oct, 09:00' }), hatch(), deps))
        .toMatchObject({ error: 'class_unavailable', reason: 'starts_at_mismatch' })
      expect(h.grantTrial).not.toHaveBeenCalled()
      expect(data.agent_membership_requests).toEqual([])
    })

    it('draft booking_mode: the trial is given, the class becomes one draft card for the team', async () => {
      const { db, data } = withTrial()
      const out = await sendPurchaseLink(ctxFor(db, { settings: { booking_mode: 'draft' } }), classInput(), hatch(), deps)
      expect(out).toMatchObject({ trial_granted: true, booked: false, pending_approval: true })
      expect(h.book).not.toHaveBeenCalled()
      expect(pendingCards(data)).toHaveLength(1)
      expect(pendingCards(data)[0].details).toMatchObject({ reason: 'mia_booking', mode: 'draft', event_id: EVENT })
      expect(pendingCards(data)[0].details.stage).toBeUndefined()
    })

    it('logs carry no personal keys or ids beyond codes; no em or en dash in any answer', async () => {
      const outs = []
      for (const grant of [
        { outcome: 'granted', method: 'charge', ledgerId: 'l' }, { outcome: 'ineligible', reason: 'trial_used' },
        { outcome: 'needs_staff', reason: 'un1t_trial_failed:X' }, { outcome: 'retry', code: 'UN1T_RATE_LIMITED' },
      ]) {
        h.grantTrial.mockResolvedValueOnce(grant)
        outs.push(await sendPurchaseLink(ctxFor(withTrial().db), { offer_id: 'trial' }, hatch(), deps))
      }
      h.elig.mockResolvedValueOnce({ success: false, error: 'fictional' })
      outs.push(await executePurchaseTool('list_purchase_options', {}, ctxFor(withTrial().db)))
      outs.push(await executePurchaseTool('list_purchase_options', {}, ctxFor(withTrial().db)))
      for (const o of outs) expect(JSON.stringify(o)).not.toMatch(/[—–]/)
      const logs = allLogText()
      expect(logs).not.toMatch(/conv-1|Fictional Member|@|\+353/)
      for (const fn of [logWarn, logError, logInfo]) for (const call of fn.mock.calls) expect(call[0]).toBe('mia-un1t')
    })
  })
})

// MIAHATCH.6 (Task 21) — settling a paid intent exactly once and booking its
// class. D's book (h.book), the thread send (h.send) and D's refund card filer
// (h.refund) are fakes; the live entitlement is the stub above; the mirror is
// the fake db. Nothing reaches un1t.online.
describe('settlePurchaseIntent (Task 21)', () => {
  const now = () => NOW
  const SNAP0 = Object.freeze({ ok: true, balance: 0, unlimited: false, live_subscription_ids: [] })
  const EVENT_ROW = { location_id: HATCH, un1t_id: EVENT, title: 'Fictional Hatch HIIT', starts_at: STARTS, status: 'scheduled', synced_at: '2026-10-20T08:55:00Z' }
  const CLASS = `Fictional Hatch HIIT, ${LABEL}`
  const paidIntent = (over = {}) => liveIntent({
    contact_id: HATCH_CONTACT, conversation_id: 'conv-1', channel: 'whatsapp', entitlement_snapshot: SNAP0,
    event_un1t_id: EVENT, class_name: 'Fictional Hatch HIIT', class_time: LABEL, starts_at: STARTS, outcome: null, ...over,
  })
  const settleDb = (over = {}, opts) => fakeDb({
    un1t_events: [EVENT_ROW], agent_membership_requests: [], un1t_clients: [], un1t_subscriptions: [], un1t_transactions: [],
    mia_purchase_intents: [paidIntent()], ...over,
  }, opts)
  const paidLive = () => fetchLiveEntitlement.mockImplementation(async () => ({ ok: true, balance: 10, unlimited: false, liveSubscriptionIds: [] }))
  const tx = (over = {}) => ({
    location_id: HATCH, un1t_id: 'tx-1', un1t_user_id: USER, product_id: PRODUCT.pack10.un1t_id, product_title: '10 Class Pack',
    type: 'one_time', product_type: 'pack', amount_cents: 12500, currency: 'eur', refunded: false,
    remote_created_at: new Date(NOW - 600_000).toISOString(), ...over,
  })
  const bookResult = (over) => ({ verdict: 'refused', sent: false, id: null, code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-book-9', ...over })
  const ID = '80000000-0000-4000-8000-000000000001'
  const settle = (db, opts = {}) => settlePurchaseIntent(db, ID, { detectedBy: 'tool', source: 'live', now, ...opts })
  const cards = (data) => data.agent_membership_requests.filter((r) => r.status === 'pending')

  describe('paidSinceSnapshot', () => {
    it('balance up, unlimited on, or a new live subscription id; anything else (or an unusable snapshot) is not paid', () => {
      const now0 = { balance: 0, unlimited: false, liveSubscriptionIds: [] }
      expect(paidSinceSnapshot(SNAP0, { ...now0, balance: 1 })).toBe(true)
      expect(paidSinceSnapshot(SNAP0, { ...now0, unlimited: true })).toBe(true)
      expect(paidSinceSnapshot(SNAP0, { ...now0, liveSubscriptionIds: ['sub-new'] })).toBe(true)
      expect(paidSinceSnapshot(SNAP0, now0)).toBe(false)
      expect(paidSinceSnapshot({ ...SNAP0, balance: 3 }, { ...now0, balance: 2 })).toBe(false)
      expect(paidSinceSnapshot({ ...SNAP0, unlimited: true }, { ...now0, unlimited: true })).toBe(false)
      expect(paidSinceSnapshot({ ...SNAP0, live_subscription_ids: ['sub-a'] }, { ...now0, liveSubscriptionIds: ['sub-a'] })).toBe(false)
      expect(paidSinceSnapshot({ ok: false, reason: 'read_failed' }, { ...now0, balance: 10 })).toBe(false)
      expect(paidSinceSnapshot(null, { ...now0, balance: 10 })).toBe(false)
      expect(paidSinceSnapshot(SNAP0, null)).toBe(false)
      expect(paidSinceSnapshot({ ...SNAP0, balance: null }, { ...now0, balance: 4 })).toBe(false)
    })
  })

  it('three detectors racing settle once (Promise.all of pay_done, tool, watcher -> exactly one book() and one send)', async () => {
    paidLive()
    const { db, data } = settleDb({
      un1t_clients: [{ location_id: HATCH, un1t_user_id: USER, credit_balance: 10, credit_unlimited: false, synced_at: new Date(NOW - 60_000).toISOString() }],
    })
    const outs = await Promise.all([
      settle(db, { detectedBy: 'pay_done', source: 'live' }),
      settle(db, { detectedBy: 'tool', source: 'live' }),
      settle(db, { detectedBy: 'watcher', source: 'mirror' }),
    ])
    expect(outs.map((o) => o.outcome).sort()).toEqual(['already_settled', 'already_settled', 'paid_booked'])
    expect(outs.filter((o) => o.sent)).toHaveLength(1)
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1]).toEqual({ channel: 'whatsapp', conversationId: 'conv-1', text: renderMiaCopy('purchase_paid_booked_text', h.settings, { class: CLASS }) })
    const intent = data.mia_purchase_intents[0]
    expect(intent).toMatchObject({ status: 'booked', paid_detected_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() })
    expect(['pay_done', 'tool', 'watcher']).toContain(intent.detected_by)
    // Task 16's execute step: one write-ahead row, its id the originRef.
    expect(data.agent_membership_requests).toHaveLength(1)
    const row = data.agent_membership_requests[0]
    expect(row).toMatchObject({ kind: 'class_booking', status: 'actioned', contact_id: HATCH_CONTACT })
    expect(row.details).toMatchObject({ provider: 'un1t_online', origin: 'mia', event_id: EVENT, purchase_intent_id: ID })
    expect(h.book.mock.calls[0][1]).toMatchObject({ locationId: HATCH, un1tUserId: USER, eventId: EVENT, origin: 'mia', originRef: row.id, actor: null })
    expect(intent.outcome).toMatchObject({ result: 'paid_booked', confirmation: { sent: true } })
    // A later detector finds it settled and does nothing.
    expect(await settle(db, { detectedBy: 'watcher', source: 'mirror' })).toEqual({ outcome: 'already_settled', sent: false })
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('not paid: nothing written, booked or sent (a failed live read falls back to the mirror)', async () => {
    const { db, data } = settleDb()
    expect(await settle(db)).toEqual({ outcome: 'not_paid', sent: false })
    fetchLiveEntitlement.mockImplementationOnce(async () => ({ ok: false, reason: 'read_failed' }))
    expect(await settle(db)).toEqual({ outcome: 'not_paid', sent: false })
    // A mirror client row from before the link says nothing about a payment since.
    const stale = settleDb({ un1t_clients: [{ location_id: HATCH, un1t_user_id: USER, credit_balance: 8, credit_unlimited: false, synced_at: new Date(NOW - 7200_000).toISOString() }] })
    expect(await settle(stale.db, { detectedBy: 'watcher', source: 'mirror' })).toEqual({ outcome: 'not_paid', sent: false })
    expect(data.mia_purchase_intents[0].status).toBe('link_sent')
    expect(stale.data.mia_purchase_intents[0].status).toBe('link_sent')
    expect(h.book).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('any purchase of the member\'s dated inside the window (any product) proves payment, whatever the snapshot', async () => {
    for (const snapshot of [{ ok: false, reason: 'read_failed' }, { ok: true, balance: null, unlimited: false, live_subscription_ids: [] }, null, SNAP0]) {
      const none = settleDb({ mia_purchase_intents: [paidIntent({ entitlement_snapshot: snapshot })] })
      expect(await settle(none.db)).toEqual({ outcome: 'not_paid', sent: false })
      for (const product of [PRODUCT.pack10, PRODUCT.monthly]) {
        const bought = settleDb({ mia_purchase_intents: [paidIntent({ entitlement_snapshot: snapshot })], un1t_transactions: [tx({ product_id: product.un1t_id })] })
        expect(await settle(bought.db)).toMatchObject({ outcome: 'paid_booked', sent: true })
      }
    }
    // A purchase alone is proof: the live entitlement is not even read.
    fetchLiveEntitlement.mockClear()
    await settle(settleDb({ un1t_transactions: [tx()] }).db)
    expect(fetchLiveEntitlement).not.toHaveBeenCalled()
  })

  it('the mirror source makes no un1t.online call: a new live subscription in the mirror is paid', async () => {
    const { db, data } = settleDb({ un1t_subscriptions: [{ location_id: HATCH, un1t_user_id: USER, un1t_id: 'sub-new', status: 'active' }] })
    const out = await settle(db, { detectedBy: 'watcher', source: 'mirror' })
    expect(out).toMatchObject({ outcome: 'paid_booked', sent: true })
    expect(fetchLiveEntitlement).not.toHaveBeenCalled()
    expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'booked', detected_by: 'watcher' })
  })

  describe('class full / passed / booking failed messages', () => {
    it('class full: purchase_paid_class_gone_text, status book_failed, no card', async () => {
      paidLive()
      h.book.mockResolvedValueOnce(bookResult({ code: 'TEST_CLASS_FULL' }))
      const { db, data } = settleDb()
      expect(await settle(db)).toMatchObject({ outcome: 'paid_class_gone', sent: true })
      expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_class_gone_text', h.settings, { class: CLASS }))
      expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'book_failed' })
      expect(data.mia_purchase_intents[0].outcome).toMatchObject({ result: 'paid_class_gone', booking: { reason: 'class_full' } })
      expect(cards(data)).toHaveLength(0)
    })

    it('class passed or gone from the timetable: class gone, D\'s book never called, no card', async () => {
      for (const ev of [
        { ...EVENT_ROW, starts_at: new Date(NOW - 3600_000).toISOString() },
        { ...EVENT_ROW, status: 'cancelled' },
      ]) {
        paidLive()
        const { db, data } = settleDb({ un1t_events: [ev], mia_purchase_intents: [paidIntent({ starts_at: ev.starts_at })] })
        expect(await settle(db)).toMatchObject({ outcome: 'paid_class_gone', sent: true })
        expect(data.mia_purchase_intents[0].status).toBe('book_failed')
        expect(data.agent_membership_requests).toHaveLength(0)
      }
      expect(h.book).not.toHaveBeenCalled()
      expect(h.send).toHaveBeenCalledTimes(2)
      expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_class_gone_text', h.settings, { class: CLASS }))
    })

    it('booking refused, unknown, no credits, retry, writes off or not sent: the write-ahead row is ONE class_booking card reason paid_booking_failed + purchase_paid_booking_failed_text, never an upsell', async () => {
      const cases = [
        () => h.book.mockResolvedValueOnce(bookResult({ code: 'SOMETHING_ELSE', message: 'Fictional refusal' })),
        () => h.book.mockResolvedValueOnce(bookResult({ verdict: 'unknown', sent: true })),
        () => h.book.mockResolvedValueOnce(bookResult({ code: 'TEST_NO_CREDITS' })),
        () => h.book.mockResolvedValueOnce(bookResult({ code: C.RATE_LIMITED, retryable: true })),
        () => h.book.mockResolvedValueOnce(bookResult({ code: C.WRITES_OFF })),
        () => h.book.mockRejectedValueOnce(Object.assign(new Error('fictional'), { code: 'settings_unreadable' })),
      ]
      for (const arrange of cases) {
        paidLive()
        arrange()
        h.send.mockClear()
        const { db, data } = settleDb({ mia_purchase_offers: [OFFER.pack10] })
        expect(await settle(db)).toMatchObject({ outcome: 'paid_booking_failed', sent: true })
        expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_booking_failed_text', h.settings, { class: CLASS }))
        expect(data.agent_membership_requests).toHaveLength(1)
        expect(cards(data)).toHaveLength(1)
        expect(cards(data)[0]).toMatchObject({ kind: 'class_booking' })
        expect(cards(data)[0].details).toMatchObject({ provider: 'un1t_online', origin: 'mia', reason: 'paid_booking_failed', event_id: EVENT, purchase_intent_id: ID })
        expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'book_failed' })
        expect(data.mia_purchase_intents[0].outcome).toMatchObject({ result: 'paid_booking_failed', booking: { request_id: cards(data)[0].id } })
      }
      expect(h.checkout).not.toHaveBeenCalled()
      expect(h.grantTrial).not.toHaveBeenCalled()
    })

    it('draft booking_mode: the class is one draft card for the team, the member told the team will confirm', async () => {
      paidLive()
      h.settings = { booking_mode: 'draft' }
      const { db, data } = settleDb()
      expect(await settle(db)).toMatchObject({ outcome: 'paid_booking_failed', sent: true })
      expect(h.book).not.toHaveBeenCalled()
      expect(cards(data)).toHaveLength(1)
      expect(cards(data)[0].details).toMatchObject({ event_id: EVENT, purchase_intent_id: ID, mode: 'draft' })
      expect(data.mia_purchase_intents[0].status).toBe('book_failed')
    })
  })

  it('no class -> purchase_paid_no_class_text, status no_class, nothing booked', async () => {
    paidLive()
    const { db, data } = settleDb({ mia_purchase_intents: [paidIntent({ event_un1t_id: null, class_name: null, class_time: null, starts_at: null })] })
    expect(await settle(db)).toMatchObject({ outcome: 'paid_no_class', sent: true })
    expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_no_class_text', h.settings))
    expect(data.mia_purchase_intents[0].status).toBe('no_class')
    expect(h.book).not.toHaveBeenCalled()
    expect(data.agent_membership_requests).toHaveLength(0)
  })

  it('free: true with a class: settled and booked at once (detected_by tool, outcome.free), never left in paid', async () => {
    h.checkout.mockResolvedValueOnce({ checkoutUrl: urlFor('free'), free: true })
    const { db, data } = fakeDb({ mia_purchase_offers: [OFFER.pack10], un1t_events: [EVENT_ROW], agent_membership_requests: [], un1t_transactions: [] })
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id, event_id: `un1t:${EVENT}`, starts_at: LABEL }, hatch(), deps)
    expect(out).toMatchObject({ link_sent: false, paid: true, outcome: 'paid_booked' })
    expect(out.url).toBeUndefined()
    const intent = data.mia_purchase_intents[0]
    expect(intent).toMatchObject({ status: 'booked', detected_by: 'tool' })
    expect(intent.outcome).toMatchObject({ free: true, result: 'paid_booked' })
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(data.mia_purchase_intents.some((r) => r.status === 'paid')).toBe(false)
  })

  describe('payment after expiry (Review Focus 3)', () => {
    it('payment after expiry books nothing, sends nothing', async () => {
      // An intent the sweep already expired, then paid: nothing at all.
      paidLive()
      const swept = settleDb({ mia_purchase_intents: [paidIntent({ status: 'expired' })], un1t_transactions: [tx()] })
      expect(await settle(swept.db)).toEqual({ outcome: 'expired', sent: false })
      expect(swept.data.mia_purchase_intents[0].status).toBe('expired')
      // Still link_sent but past expires_at, paid after it: expired, nothing filed.
      const lapsed = paidIntent({ expires_at: new Date(NOW - 3600_000).toISOString(), created_at: new Date(NOW - 7200_000).toISOString() })
      const late = settleDb({ mia_purchase_intents: [lapsed], un1t_transactions: [tx({ remote_created_at: new Date(NOW - 600_000).toISOString() })] })
      for (const source of ['live', 'mirror']) {
        const out = await settle(late.db, { source, detectedBy: source === 'live' ? 'pay_done' : 'watcher' })
        expect(out).toMatchObject({ outcome: 'expired', sent: false })
      }
      expect(late.data.mia_purchase_intents[0].status).toBe('link_sent')
      expect(h.book).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
      expect(h.refund).not.toHaveBeenCalled()
      expect(late.data.agent_membership_requests).toHaveLength(0)
      expect(swept.data.agent_membership_requests).toHaveLength(0)
    })

    it('a payment made inside the window but seen after expiry is settled (the mirror dates it)', async () => {
      const lapsed = paidIntent({ expires_at: new Date(NOW - 600_000).toISOString(), created_at: new Date(NOW - 7200_000).toISOString() })
      const { db, data } = settleDb({ mia_purchase_intents: [lapsed], un1t_transactions: [tx({ remote_created_at: new Date(NOW - 1200_000).toISOString() })] })
      expect(await settle(db, { detectedBy: 'watcher', source: 'mirror' })).toMatchObject({ outcome: 'paid_booked', sent: true })
      expect(data.mia_purchase_intents[0].status).toBe('booked')
      expect(h.book).toHaveBeenCalledTimes(1)
    })
  })

  it('different product counts as paid, product recorded', async () => {
    paidLive()
    const { db, data } = settleDb({ un1t_transactions: [tx({ un1t_id: 'tx-other', product_id: PRODUCT.monthly.un1t_id, product_title: 'Monthly Foundation', type: 'sub_initial' })] })
    expect(await settle(db)).toMatchObject({ outcome: 'paid_booked', sent: true })
    expect(data.mia_purchase_intents[0].outcome.product).toEqual({
      transaction_id: 'tx-other', product_id: PRODUCT.monthly.un1t_id, product_title: 'Monthly Foundation', matches_intent: false,
    })
    // The same product is recorded as a match.
    const same = settleDb({ un1t_transactions: [tx()] })
    await settle(same.db)
    expect(same.data.mia_purchase_intents[0].outcome.product).toMatchObject({ product_id: PRODUCT.pack10.un1t_id, matches_intent: true })
  })

  it('double payment files one refund_request card and no un1t call', async () => {
    paidLive()
    const { db, data } = settleDb({ un1t_transactions: [tx({ un1t_id: 'tx-1' }), tx({ un1t_id: 'tx-2', remote_created_at: new Date(NOW - 300_000).toISOString() })] })
    expect(await settle(db)).toMatchObject({ outcome: 'paid_booked', sent: true })
    expect(h.refund).toHaveBeenCalledTimes(1)
    expect(h.refund.mock.calls[0][1]).toEqual({
      locationId: HATCH, contactId: HATCH_CONTACT, un1tUserId: USER, reason: 'double_payment', transactionIds: ['tx-1', 'tx-2'],
      origin: 'mia', originRef: ID, channel: 'whatsapp', conversationId: 'conv-1',
    })
    expect(data.mia_purchase_intents[0].outcome.double_payment).toEqual({ transaction_ids: ['tx-1', 'tx-2'], approval_id: 'appr-double-1' })
    // No refund or charge call anywhere; the member hears no amount.
    expect(h.checkout).not.toHaveBeenCalled()
    expect(h.grantTrial).not.toHaveBeenCalled()
    expect(h.book).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1].text).not.toMatch(/€|125|refund/i)
    // A losing detector afterwards files nothing more.
    await settle(db, { detectedBy: 'watcher', source: 'mirror' })
    expect(h.refund).toHaveBeenCalledTimes(1)
  })

  it('one payment of the product (or a renewal, or a €0 row) is no double payment', async () => {
    paidLive()
    const { db } = settleDb({ un1t_transactions: [tx(), tx({ un1t_id: 'tx-r', type: 'sub_renewal' }), tx({ un1t_id: 'tx-0', amount_cents: 0 })] })
    await settle(db)
    expect(h.refund).not.toHaveBeenCalled()
  })

  it('window_closed recorded: no retry, the booking stands, the card carries it', async () => {
    paidLive()
    h.send.mockResolvedValue({ sent: false, reason: 'window_closed' })
    const { db, data } = settleDb()
    expect(await settle(db)).toMatchObject({ outcome: 'paid_booked', sent: false })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'booked' })
    expect(data.mia_purchase_intents[0].outcome.confirmation).toEqual({ sent: false, reason: 'window_closed' })
    // With a card (the booking failed), the card carries it too.
    h.book.mockResolvedValueOnce(bookResult({ verdict: 'unknown', sent: true }))
    const failed = settleDb()
    expect(await settle(failed.db)).toMatchObject({ outcome: 'paid_booking_failed', sent: false })
    expect(cards(failed.data)[0].details).toMatchObject({ reason: 'paid_booking_failed', confirmation: { sent: false, reason: 'window_closed' } })
    expect(failed.data.mia_purchase_intents[0].outcome.confirmation).toEqual({ sent: false, reason: 'window_closed' })
  })

  it('a send that throws never changes the booking result', async () => {
    paidLive()
    h.send.mockRejectedValueOnce(new Error('fictional network'))
    const { db, data } = settleDb()
    expect(await settle(db)).toMatchObject({ outcome: 'paid_booked', sent: false })
    expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'booked' })
    expect(data.mia_purchase_intents[0].outcome.confirmation).toEqual({ sent: false, reason: 'send_error' })
  })

  it('an unreadable or missing intent settles nothing', async () => {
    paidLive()
    const broken = settleDb({}, { fail: { mia_purchase_intents: { select: true } } })
    expect(await settle(broken.db)).toEqual({ outcome: 'error', sent: false })
    expect(await settle(settleDb({ mia_purchase_intents: [] }).db)).toEqual({ outcome: 'not_found', sent: false })
    const casFails = settleDb({}, { fail: { mia_purchase_intents: { update: true } } })
    expect(await settle(casFails.db)).toEqual({ outcome: 'error', sent: false })
    expect(h.book).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('logs: module mia-un1t, codes and ids only: no checkout URL, amount, conversation or token', async () => {
    paidLive()
    h.book.mockResolvedValueOnce(bookResult({ verdict: 'unknown', sent: true }))
    h.send.mockResolvedValue({ sent: false, reason: 'window_closed' })
    const { db } = settleDb({ un1t_transactions: [tx({ un1t_id: 'tx-1' }), tx({ un1t_id: 'tx-2' })] })
    await settle(db)
    await settle(settleDb({}, { fail: { mia_purchase_intents: { select: true } } }).db)
    const logs = allLogText()
    expect(logs).not.toMatch(/pay\.example\.test|pay-done|12500|€|conv-1|a{64}/)
    for (const fn of [logWarn, logError, logInfo]) for (const call of fn.mock.calls) expect(call[0]).toBe('mia-un1t')
  })

  describe('review fixes (round 1)', () => {
    it('a throw after the winning CAS: closed book_failed with the code, ONE paid_booking_failed card, the member told, never rethrown', async () => {
      paidLive()
      // The class read throws (a thrown builder, not a resolved error).
      const { db, data } = settleDb({}, { throwOn: { un1t_events: true } })
      const out = await settle(db)
      expect(out).toMatchObject({ outcome: 'paid_booking_failed', sent: true, error: 'TypeError' })
      const intent = data.mia_purchase_intents[0]
      expect(intent.status).toBe('book_failed')
      expect(intent.updated_at).toBe(new Date(NOW).toISOString())
      expect(intent.outcome).toMatchObject({ result: 'paid_booking_failed', error: { code: 'TypeError' }, confirmation: { sent: true } })
      expect(cards(data)).toHaveLength(1)
      expect(cards(data)[0].details).toMatchObject({ reason: 'paid_booking_failed', paid_outcome: 'TypeError', purchase_intent_id: ID, event_id: EVENT })
      expect(intent.outcome.booking.request_id).toBe(cards(data)[0].id)
      expect(h.book).not.toHaveBeenCalled()
      expect(h.send).toHaveBeenCalledTimes(1)
      expect(h.send.mock.calls[0][1].text).toBe(renderMiaCopy('purchase_paid_booking_failed_text', h.settings, { class: CLASS }))
      expect(logError).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ op: 'settle_threw', code: 'TypeError' }))
    })

    it('a failed team alert never aborts the card: the paid class still becomes one card and the intent is closed', async () => {
      paidLive()
      notifyAgentApprovalRequest.mockRejectedValueOnce(new Error('fictional push outage'))
      h.book.mockResolvedValueOnce(bookResult({ verdict: 'unknown', sent: true }))
      const { db, data } = settleDb()
      expect(await settle(db)).toMatchObject({ outcome: 'paid_booking_failed', sent: true })
      expect(cards(data)).toHaveLength(1)
      expect(cards(data)[0].details).toMatchObject({ reason: 'paid_booking_failed' })
      expect(data.mia_purchase_intents[0].status).toBe('book_failed')
      expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ op: 'book_alert' }))
    })

    it('markStuckPaidIntent (for the watcher): a paid intent is closed book_failed with one card; nothing booked or sent; a no-op otherwise', async () => {
      const stuck = paidIntent({ status: 'paid', outcome: { source: 'live', confirmation: { sent: true } } })
      const { db, data } = settleDb({ mia_purchase_intents: [stuck] })
      expect(await markStuckPaidIntent(db, ID, { code: 'stuck_paid', now: NOW })).toMatchObject({ marked: true })
      expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'book_failed', updated_at: new Date(NOW).toISOString() })
      expect(data.mia_purchase_intents[0].outcome).toMatchObject({ source: 'live', result: 'paid_booking_failed', error: { code: 'stuck_paid' }, confirmation: { sent: true } })
      expect(cards(data)).toHaveLength(1)
      expect(cards(data)[0].details).toMatchObject({ reason: 'paid_booking_failed', paid_outcome: 'stuck_paid', purchase_intent_id: ID })
      // Again: no longer paid, nothing more.
      expect(await markStuckPaidIntent(db, ID, { now: NOW })).toEqual({ marked: false })
      for (const status of ['link_sent', 'booked', 'expired']) {
        const other = settleDb({ mia_purchase_intents: [paidIntent({ status })] })
        expect(await markStuckPaidIntent(other.db, ID, { now: NOW })).toEqual({ marked: false })
        expect(other.data.agent_membership_requests).toHaveLength(0)
      }
      expect(h.book).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
    })

    it('a refused intent is its own outcome, never paid; check_my_purchase never says paid for it', async () => {
      paidLive()
      const { db } = settleDb({ mia_purchase_intents: [paidIntent({ status: 'refused' })], un1t_transactions: [tx()] })
      expect(await settle(db)).toEqual({ outcome: 'refused', sent: false })
      // Read as live, refused by the time it is settled (another turn's checkout failed).
      let flipped = false
      const race = settleDb({ un1t_transactions: [tx()] }, {
        afterSelect: (table, data) => {
          if (table === 'mia_purchase_intents' && !flipped) { flipped = true; data.mia_purchase_intents[0].status = 'refused' }
        },
      })
      const out = await checkMyPurchase(ctxFor(race.db), hatch(), { now })
      expect(out).toMatchObject({ paid: false, open_intent: false })
      expect(out.message).toMatch(/Never say a payment has gone through/)
      expect(h.book).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
    })

    it('unreadable Mia settings are logged (code) and still fall back to the draft card', async () => {
      paidLive()
      h.settingsResult = { ok: false, reason: 'read_failed' }
      const { db, data } = settleDb()
      expect(await settle(db)).toMatchObject({ outcome: 'paid_booking_failed', sent: true })
      expect(h.book).not.toHaveBeenCalled()
      expect(cards(data)[0].details).toMatchObject({ mode: 'draft', purchase_intent_id: ID })
      expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ op: 'settle_settings', code: 'read_failed' }))
    })

    it('expireStaleIntents never throws: a thrown builder is { expired, error: true }', async () => {
      const { db } = fakeDb({}, { throwOn: { mia_purchase_intents: true } })
      expect(await expireStaleIntents(db, { now: NOW })).toEqual({ expired: 0, error: true })
    })
  })

  describe('checkMyPurchase', () => {
    it('paid: settles on the live intent (tool, live) and answers with what was sent; not paid: not showing yet; none: open_intent false', async () => {
      paidLive()
      const { db, data } = settleDb()
      const out = await checkMyPurchase(ctxFor(db), hatch(), { now })
      expect(out).toMatchObject({ paid: true, outcome: 'paid_booked', told: true })
      expect(out.text).toBe(renderMiaCopy('purchase_paid_booked_text', h.settings, { class: CLASS }))
      expect(out.message).toMatch(/do not repeat/i)
      expect(data.mia_purchase_intents[0]).toMatchObject({ status: 'booked', detected_by: 'tool' })
      fetchLiveEntitlement.mockImplementation(async () => ({ ok: true, balance: 0, unlimited: false, liveSubscriptionIds: [] }))
      const open = await checkMyPurchase(ctxFor(settleDb().db), hatch(), { now })
      expect(open).toMatchObject({ paid: false, open_intent: true })
      expect(open.message).toMatch(/not showing yet/)
      expect(await checkMyPurchase(ctxFor(settleDb({ mia_purchase_intents: [] }).db), hatch(), { now })).toMatchObject({ open_intent: false, paid: false })
      for (const o of [out, open]) expect(JSON.stringify(o)).not.toMatch(/[—–]/)
    })

    it('a closed window: the model relays the text itself', async () => {
      paidLive()
      h.send.mockResolvedValue({ sent: false, reason: 'window_closed' })
      const out = await checkMyPurchase(ctxFor(settleDb().db), hatch(), { now })
      expect(out).toMatchObject({ paid: true, told: false })
      expect(out.message).toContain(out.text)
    })
  })

  describe('expireStaleIntents', () => {
    it('expiry silent: CAS link_sent -> expired past expires_at, paginated under the cap, counts only', async () => {
      const past = (i) => liveIntent({ id: `80000000-0000-4000-8000-00000000010${i}`, un1t_user_id: `u-test-${i}`, expires_at: new Date(NOW - 1000 * (i + 1)).toISOString() })
      const rows = [0, 1, 2, 3, 4].map(past)
      const fresh = liveIntent({ id: '80000000-0000-4000-8000-000000000200', un1t_user_id: 'u-test-fresh' })
      const paidOld = liveIntent({ id: '80000000-0000-4000-8000-000000000201', un1t_user_id: 'u-test-paid', status: 'booked', expires_at: new Date(NOW - 5000).toISOString() })
      const { db, data } = fakeDb({ mia_purchase_intents: [...rows, fresh, paidOld] })
      expect(await expireStaleIntents(db, { now: NOW, pageSize: 2 })).toEqual({ expired: 5 })
      for (const r of data.mia_purchase_intents.slice(0, 5)) expect(r).toMatchObject({ status: 'expired', updated_at: new Date(NOW).toISOString() })
      expect(data.mia_purchase_intents[5].status).toBe('link_sent')
      expect(data.mia_purchase_intents[6].status).toBe('booked')
      expect(h.send).not.toHaveBeenCalled()
      expect(h.book).not.toHaveBeenCalled()
      expect(await expireStaleIntents(db, { now: NOW })).toEqual({ expired: 0 })
    })

    it('a failed read or write stops the sweep with what it did so far', async () => {
      const { db } = fakeDb({ mia_purchase_intents: [liveIntent({ expires_at: new Date(NOW - 1000).toISOString() })] }, { fail: { mia_purchase_intents: { update: true } } })
      expect(await expireStaleIntents(db, { now: NOW })).toEqual({ expired: 0, error: true })
    })
  })

  describe('sendPurchaseLink on a lapsed intent settles first (Task 19 carry 2)', () => {
    it('paid at 22h50, asks again at 23h05: settled and booked, no second link', async () => {
      const lapsed = paidIntent({ expires_at: new Date(NOW - 300_000).toISOString(), created_at: new Date(NOW - PURCHASE_INTENT_TTL_MS - 300_000).toISOString() })
      const { db, data } = settleDb({ mia_purchase_offers: [OFFER.pack10], mia_purchase_intents: [lapsed], un1t_transactions: [tx({ remote_created_at: new Date(NOW - 900_000).toISOString() })] })
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      expect(out).toMatchObject({ link_sent: false, paid: true, outcome: 'paid_booked' })
      expect(data.mia_purchase_intents).toHaveLength(1)
      expect(data.mia_purchase_intents[0].status).toBe('booked')
      expect(h.checkout).not.toHaveBeenCalled()
      expect(h.send).toHaveBeenCalledTimes(1)
    })

    it('a payment shows but cannot be dated inside the window yet: no second link, the intent left for the sweep', async () => {
      paidLive()
      const lapsed = paidIntent({ expires_at: new Date(NOW - 300_000).toISOString() })
      const { db, data } = settleDb({ mia_purchase_offers: [OFFER.pack10], mia_purchase_intents: [lapsed] })
      const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
      expect(out).toMatchObject({ link_sent: false, payment_pending: true })
      expect(data.mia_purchase_intents).toHaveLength(1)
      expect(data.mia_purchase_intents[0].status).toBe('link_sent')
      expect(h.checkout).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
      expect(JSON.stringify(out)).not.toMatch(/[—–]/)
    })
  })
})
