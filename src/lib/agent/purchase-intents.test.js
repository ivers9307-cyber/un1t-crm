// MIAHATCH.6 (Task 19) — the purchase options, the purchase intents and the
// hosted payment link at a un1t.online studio (Hatch Street). un1t.online is
// never called: D's createCheckoutLink is a fake (fakeUn1tWrite), the customer
// host and the live entitlement read are stubs, and the tables are a recording
// fake db that enforces mia_purchase_intents_one_live like Postgres does
// (23505). Fictional ids only (the repo is public).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({ checkout: null }))

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', async () => {
  const { fakeUn1tWrite } = await import('./un1t-fakes.test-helpers')
  const { vi: v } = await import('vitest')
  h.checkout = v.fn()
  return fakeUn1tWrite({ createCheckoutLink: h.checkout })['@/lib/un1t-online-write-ops']()
})
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://hatch.example.test') }))
vi.mock('./un1t-member-read', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLiveEntitlement: vi.fn(async () => ({ ok: true, balance: 0, unlimited: false, liveSubscriptionIds: [] })),
}))

import { logWarn, logError, logInfo } from '@/lib/log'
import { Un1tWriteRefused, Un1tWriteUnknown, UN1T_WRITE_CODES as C } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { fetchLiveEntitlement } from './un1t-member-read'
import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'
import { DEFAULT_PURCHASE_LINK_OPEN_TEXT } from './default-copy'
import { formatClassTime } from './dublin-format'
import { TOOL_NOT_AT_THIS_STUDIO, refuseToolForTurn } from './tool-capability'
import {
  formatPriceLabel, listPurchaseOptions, mintPayDoneToken, hashPayDoneToken, sendPurchaseLink,
  executePurchaseTool, PURCHASE_INTENT_TTL_MS,
} from './purchase-intents'

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
function fakeDb(tables = {}, { fail = {}, onInsert = null } = {}) {
  const data = {
    locations: [{ id: HATCH, organization_id: ORG }],
    mia_purchase_offers: [], un1t_products: Object.values(PRODUCT), un1t_events: [], mia_purchase_intents: [],
    ...tables,
  }
  const calls = []
  let next = 1
  const from = (table) => {
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
      return { data: st.single ? (rows[0] ?? null) : rows, error: null }
    }
    const b = {
      select: (cols) => { if (st.op === 'select') st.cols = cols; else st.returning = true; return b },
      insert: (row) => { st.op = 'insert'; st.row = row; return b },
      update: (patch) => { st.op = 'update'; st.patch = patch; return b },
      eq: (c, v) => { st.filters.push((r) => r[c] === v); return b },
      in: (c, vs) => { st.filters.push((r) => vs.includes(r[c])); return b },
      order: (c, { ascending = true } = {}) => { st.orders.push([c, ascending]); return b },
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

  it('free true -> settled at once (status paid, detected_by checkout_free), no link sent', async () => {
    h.checkout.mockResolvedValueOnce({ checkoutUrl: urlFor('free'), free: true })
    const { db, data } = fakeDb(offers())
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: OFFER.pack10.id }, hatch(), deps)
    const intent = data.mia_purchase_intents[0]
    expect(intent).toMatchObject({ status: 'paid', detected_by: 'checkout_free', paid_detected_at: new Date(NOW).toISOString() })
    expect(intent.checkout_url ?? null).toBeNull()
    expect(out).toMatchObject({ link_sent: false, paid: true, product: '10 Class Pack' })
    expect(out.url).toBeUndefined()
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

  it("offer_id 'trial' is reserved: neutral not available, nothing read or written", async () => {
    const { db, calls } = fakeDb(offers())
    const out = await sendPurchaseLink(ctxFor(db), { offer_id: 'trial' }, hatch(), deps)
    expect(out).toMatchObject({ link_sent: false, error: 'offer_not_available' })
    expect(calls).toHaveLength(0)
    expect(h.checkout).not.toHaveBeenCalled()
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

  it('check_my_purchase never says paid: an open link or none, from a read', async () => {
    const open = await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb({ mia_purchase_intents: [liveIntent()] }).db))
    expect(open).toMatchObject({ paid: false, open_link: true, product: '10 Class Pack' })
    expect(JSON.stringify(open)).not.toContain('pay.example.test')
    const none = await executePurchaseTool('check_my_purchase', {}, ctxFor(fakeDb().db))
    expect(none).toMatchObject({ paid: false, open_link: false })
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
