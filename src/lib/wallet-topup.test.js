// INTEG-C2b — wallet top-up tests: VAT math + denominations,
// createTopup gates (pinning, whitelist) and session wiring, fulfil
// idempotency (double webhook = ONE wallet credit — the status-guarded
// claim is pinned here), expiry guard, and the invoice email renderer.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stripe: capture sessions.create calls without touching the SDK.
const sessionsCreate = vi.fn()
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ checkout: { sessions: { create: sessionsCreate } } }),
}))

// Pinning gate: swap between pinned/unpinned per test.
const getLocationPlan = vi.fn()
vi.mock('@/lib/plans', () => ({ getLocationPlan: (...a) => getLocationPlan(...a) }))

// wallet_apply leg: count credits (the money assertion).
const applyWalletEntry = vi.fn()
vi.mock('@/lib/wallet', () => ({ applyWalletEntry: (...a) => applyWalletEntry(...a) }))

// Email leg: never hit Postmark from tests.
const sendEmail = vi.fn().mockResolvedValue({ messageId: 'pm-1' })
vi.mock('@/lib/postmark', () => ({ sendEmail: (...a) => sendEmail(...a) }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T', logoUrl: null, faviconUrl: null }),
}))

import {
  TOPUP_DENOMINATIONS_CENTS,
  TOPUP_VAT_RATE_PERCENT,
  isTopupDenomination,
  topupVatCents,
  topupTotalCents,
  createTopup,
  fulfillTopup,
  markTopupSessionExpired,
  renderTopupInvoiceEmail,
  SELLING_ENTITY_NAME,
} from './wallet-topup'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://crm.example.com'
  sessionsCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1' })
  getLocationPlan.mockResolvedValue({ tier: { plan: { slug: 'starter' } } })
  applyWalletEntry.mockResolvedValue(2500)
})

// ── Pure: denominations + VAT math ──────────────────────────────────

describe('denominations', () => {
  it('are exactly €25 / €50 / €100 / €250', () => {
    expect(TOPUP_DENOMINATIONS_CENTS).toEqual([2500, 5000, 10000, 25000])
  })
  it('whitelist accepts each denomination and nothing else', () => {
    for (const d of TOPUP_DENOMINATIONS_CENTS) expect(isTopupDenomination(d)).toBe(true)
    expect(isTopupDenomination(2000)).toBe(false)
    expect(isTopupDenomination(0)).toBe(false)
    expect(isTopupDenomination(-2500)).toBe(false)
    expect(isTopupDenomination('2500')).toBe(false) // string never sneaks past
  })
})

describe('VAT math (23% on top of the credit)', () => {
  it('is exact for every fixed denomination', () => {
    expect(topupVatCents(2500)).toBe(575)
    expect(topupVatCents(5000)).toBe(1150)
    expect(topupVatCents(10000)).toBe(2300)
    expect(topupVatCents(25000)).toBe(5750)
  })
  it('total = credit + VAT (pay X * 1.23, wallet credited X)', () => {
    expect(topupTotalCents(2500)).toBe(3075)
    expect(topupTotalCents(5000)).toBe(6150)
    expect(topupTotalCents(10000)).toBe(12300)
    expect(topupTotalCents(25000)).toBe(30750)
  })
  it('rounds half-up on non-denomination integers (defence in depth)', () => {
    expect(topupVatCents(101)).toBe(23) // 23.23 → 23
    expect(topupVatCents(150)).toBe(35) // 34.5 → 35
  })
  it('rejects non-positive / non-integer input', () => {
    expect(() => topupVatCents(0)).toThrow()
    expect(() => topupVatCents(-100)).toThrow()
    expect(() => topupVatCents(25.5)).toThrow()
  })
  it('rate constant is the Irish standard rate', () => {
    expect(TOPUP_VAT_RATE_PERCENT).toBe(23)
  })
})

// ── DB stub — table-keyed chainable builder (the wallet-enforcement
//    stubDb pattern, extended with insert/update capture). ───────────

function stubDb(tables = {}) {
  const calls = { inserts: [], updates: [] }
  const db = {
    from: (table) => {
      const rows = tables[table] || []
      const state = { op: 'select', payload: null, filters: {} }
      const b = {}
      for (const m of ['in', 'gte', 'order', 'limit']) b[m] = () => b
      b.eq = (col, val) => { state.filters[col] = val; return b }
      b.select = () => b
      b.insert = (payload) => { state.op = 'insert'; state.payload = payload; return b }
      b.update = (payload) => { state.op = 'update'; state.payload = payload; return b }
      const resolveRows = () => {
        if (state.op === 'insert') {
          calls.inserts.push({ table, payload: state.payload })
          const row = tables[`${table}:insertResult`] ?? { id: 'inv-1', number: 'TU-00001', ...state.payload }
          return [row]
        }
        if (state.op === 'update') {
          calls.updates.push({ table, payload: state.payload, filters: { ...state.filters } })
          // Guarded claim semantics: honour a status filter against the
          // stubbed row's CURRENT status.
          const matched = rows.filter((r) =>
            Object.entries(state.filters).every(([col, val]) => r[col] === val)
          )
          matched.forEach((r) => Object.assign(r, state.payload))
          return matched
        }
        return rows.filter((r) =>
          Object.entries(state.filters).every(([col, val]) => r[col] === val)
        )
      }
      b.maybeSingle = () => Promise.resolve({ data: resolveRows()[0] ?? null, error: null })
      b.single = () => {
        const r = resolveRows()
        return Promise.resolve(r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no row' } })
      }
      b.then = (resolve, reject) =>
        Promise.resolve({ data: resolveRows(), error: null }).then(resolve, reject)
      return b
    },
  }
  return { db, calls }
}

// ── createTopup ─────────────────────────────────────────────────────

describe('createTopup', () => {
  const LOC = { id: 'loc-1', name: 'Stillorgan' }

  it('rejects a non-whitelist amount with code invalid_denomination (before any IO)', async () => {
    const { db } = stubDb()
    await expect(createTopup(db, { locationId: 'loc-1', amountCents: 2600, userId: 'u1' }))
      .rejects.toMatchObject({ code: 'invalid_denomination' })
    expect(getLocationPlan).not.toHaveBeenCalled()
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('rejects an unpinned location with code not_pinned and creates NOTHING', async () => {
    getLocationPlan.mockResolvedValue(null)
    const { db, calls } = stubDb({ locations: [LOC] })
    await expect(createTopup(db, { locationId: 'loc-1', amountCents: 2500, userId: 'u1' }))
      .rejects.toMatchObject({ code: 'not_pinned' })
    expect(calls.inserts).toHaveLength(0)
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('inserts a pending invoice with exact VAT split and creates a hosted platform Checkout', async () => {
    const { db, calls } = stubDb({ locations: [LOC] })
    const out = await createTopup(db, { locationId: 'loc-1', amountCents: 2500, userId: 'u1' })

    expect(calls.inserts).toHaveLength(1)
    expect(calls.inserts[0]).toMatchObject({
      table: 'wallet_topup_invoices',
      payload: {
        location_id: 'loc-1',
        amount_cents: 2500,
        vat_cents: 575,
        total_cents: 3075,
        currency: 'EUR',
        status: 'pending',
        created_by: 'u1',
      },
    })

    expect(sessionsCreate).toHaveBeenCalledTimes(1)
    const [params, opts] = sessionsCreate.mock.calls[0]
    expect(params.mode).toBe('payment')
    expect(params.line_items).toHaveLength(1)
    expect(params.line_items[0].price_data.unit_amount).toBe(3075) // VAT-inclusive
    expect(params.line_items[0].price_data.product_data.name).toBe('Wallet top-up — Stillorgan')
    expect(params.line_items[0].price_data.product_data.description).toContain('VAT (23%)')
    expect(params.metadata).toEqual({ invoice_id: 'inv-1', location_id: 'loc-1' })
    expect(params.success_url).toBe('https://crm.example.com/settings/billing?topup=success')
    expect(params.cancel_url).toBe('https://crm.example.com/settings/billing?topup=cancelled')
    expect(params.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // PLAIN platform charge: no ui_mode (hosted), and — the C2b/events
    // boundary — NO connected-account request options at all.
    expect(params.ui_mode).toBeUndefined()
    expect(params.payment_intent_data).toBeUndefined()
    expect(opts).toBeUndefined()

    // Session id stamped back onto the invoice; caller gets the URL.
    expect(calls.updates).toContainEqual(expect.objectContaining({
      table: 'wallet_topup_invoices',
      payload: { stripe_checkout_session_id: 'cs_test_1' },
    }))
    expect(out).toEqual({
      checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_1',
      invoiceId: 'inv-1',
      number: 'TU-00001',
    })
  })

  it('marks the invoice failed and rethrows when Stripe session creation fails', async () => {
    sessionsCreate.mockRejectedValue(new Error('stripe down'))
    const { db, calls } = stubDb({ locations: [LOC] })
    await expect(createTopup(db, { locationId: 'loc-1', amountCents: 5000, userId: 'u1' }))
      .rejects.toThrow('stripe down')
    expect(calls.updates).toContainEqual(expect.objectContaining({
      table: 'wallet_topup_invoices',
      payload: { status: 'failed' },
    }))
  })
})

// ── fulfillTopup — idempotency is the whole point ───────────────────

function pendingInvoice(over = {}) {
  return {
    id: 'inv-1',
    number: 'TU-00001',
    location_id: 'loc-1',
    amount_cents: 2500,
    vat_cents: 575,
    total_cents: 3075,
    status: 'pending',
    stripe_checkout_session_id: 'cs_test_1',
    created_by: 'u1',
    ...over,
  }
}

const PAID_SESSION = {
  id: 'cs_test_1',
  payment_status: 'paid',
  payment_intent: 'pi_1',
  metadata: { invoice_id: 'inv-1', location_id: 'loc-1' },
}

describe('fulfillTopup', () => {
  it('claims pending→paid, credits the wallet ONCE via wallet_apply, and emails the invoice', async () => {
    const inv = pendingInvoice()
    const { db, calls } = stubDb({
      wallet_topup_invoices: [inv],
      profiles: [{ id: 'u1', email: 'owner@example.com', full_name: 'Owner One' }],
      locations: [{ id: 'loc-1', name: 'Stillorgan' }],
    })
    const out = await fulfillTopup(db, PAID_SESSION)

    expect(out).toMatchObject({ applied: true, invoiceId: 'inv-1', newBalanceCents: 2500 })
    // The claim carries the status guard (idempotency lock) + intent stamp.
    const claim = calls.updates.find((u) => u.payload?.status === 'paid')
    expect(claim.filters).toMatchObject({ id: 'inv-1', status: 'pending' })
    expect(claim.payload.stripe_payment_intent_id).toBe('pi_1')

    expect(applyWalletEntry).toHaveBeenCalledTimes(1)
    expect(applyWalletEntry).toHaveBeenCalledWith(db, {
      locationId: 'loc-1',
      kind: 'topup',
      amountCents: 2500, // the EX-VAT credit, never the total
      invoiceRef: 'TU-00001',
      note: 'Stripe top-up',
      createdBy: 'u1',
    })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.com',
      stream: 'outbound',
      tag: 'wallet-topup-invoice',
    })
  })

  it('a REPLAYED webhook is a no-op: double delivery = exactly one wallet credit', async () => {
    const inv = pendingInvoice()
    const { db } = stubDb({
      wallet_topup_invoices: [inv],
      profiles: [{ id: 'u1', email: 'owner@example.com' }],
      locations: [{ id: 'loc-1', name: 'Stillorgan' }],
    })
    const first = await fulfillTopup(db, PAID_SESSION)
    const second = await fulfillTopup(db, PAID_SESSION) // replay — inv is now status 'paid'

    expect(first.applied).toBe(true)
    expect(second).toMatchObject({ applied: false, reason: 'already_paid' })
    expect(applyWalletEntry).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('never credits on a completed-but-unpaid session (async payment methods)', async () => {
    const { db } = stubDb({ wallet_topup_invoices: [pendingInvoice()] })
    const out = await fulfillTopup(db, { ...PAID_SESSION, payment_status: 'unpaid' })
    expect(out).toMatchObject({ applied: false, reason: 'not_paid' })
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('unknown session → no_invoice, nothing credited', async () => {
    const { db } = stubDb({ wallet_topup_invoices: [] })
    const out = await fulfillTopup(db, { ...PAID_SESSION, id: 'cs_other', metadata: {} })
    expect(out).toMatchObject({ applied: false, reason: 'no_invoice' })
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('falls back to metadata.invoice_id when the session id was never stamped', async () => {
    const inv = pendingInvoice({ stripe_checkout_session_id: null })
    const { db } = stubDb({
      wallet_topup_invoices: [inv],
      profiles: [{ id: 'u1', email: 'owner@example.com' }],
      locations: [{ id: 'loc-1', name: 'Stillorgan' }],
    })
    const out = await fulfillTopup(db, PAID_SESSION)
    expect(out.applied).toBe(true)
    expect(applyWalletEntry).toHaveBeenCalledTimes(1)
  })

  it('refuses the metadata fallback when the invoice is bound to a DIFFERENT session', async () => {
    const inv = pendingInvoice({ stripe_checkout_session_id: 'cs_other' })
    const { db } = stubDb({ wallet_topup_invoices: [inv] })
    const out = await fulfillTopup(db, { ...PAID_SESSION, id: 'cs_test_999' })
    expect(out).toMatchObject({ applied: false, reason: 'no_invoice' })
    expect(applyWalletEntry).not.toHaveBeenCalled()
  })

  it('keeps the invoice PAID (no revert) and reports credit_failed when wallet_apply throws', async () => {
    applyWalletEntry.mockRejectedValue(new Error('grace floor breached'))
    const inv = pendingInvoice()
    const { db } = stubDb({ wallet_topup_invoices: [inv] })
    const out = await fulfillTopup(db, PAID_SESSION)
    expect(out).toMatchObject({ applied: false, reason: 'credit_failed' })
    expect(inv.status).toBe('paid') // loud queryable state, never a double-credit risk
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('fulfilment survives an email failure (fire-and-forget)', async () => {
    sendEmail.mockRejectedValue(new Error('postmark down'))
    const { db } = stubDb({
      wallet_topup_invoices: [pendingInvoice()],
      profiles: [{ id: 'u1', email: 'owner@example.com' }],
      locations: [{ id: 'loc-1', name: 'Stillorgan' }],
    })
    const out = await fulfillTopup(db, PAID_SESSION)
    expect(out.applied).toBe(true)
    expect(applyWalletEntry).toHaveBeenCalledTimes(1)
  })
})

// ── markTopupSessionExpired ─────────────────────────────────────────

describe('markTopupSessionExpired', () => {
  it('marks a pending invoice expired', async () => {
    const inv = pendingInvoice()
    const { db } = stubDb({ wallet_topup_invoices: [inv] })
    const out = await markTopupSessionExpired(db, { id: 'cs_test_1', metadata: {} })
    expect(out).toEqual({ expired: true })
    expect(inv.status).toBe('expired')
  })

  it('NEVER regresses a paid invoice (expiry racing completion)', async () => {
    const inv = pendingInvoice({ status: 'paid' })
    const { db } = stubDb({ wallet_topup_invoices: [inv] })
    const out = await markTopupSessionExpired(db, { id: 'cs_test_1', metadata: {} })
    expect(out).toEqual({ expired: false })
    expect(inv.status).toBe('paid')
  })

  it('unknown session is a quiet no-op', async () => {
    const { db } = stubDb({ wallet_topup_invoices: [] })
    expect(await markTopupSessionExpired(db, { id: 'cs_zzz', metadata: {} })).toEqual({ expired: false })
  })
})

// ── VAT invoice email renderer ──────────────────────────────────────

describe('renderTopupInvoiceEmail', () => {
  const rendered = () => renderTopupInvoiceEmail({
    invoice: pendingInvoice({ status: 'paid', paid_at: '2026-07-20T10:00:00Z' }),
    locationName: 'Stillorgan',
    branding: { companyName: 'UN1T', logoUrl: null },
    recipientName: 'Owner One',
  })

  it('carries number, date, location and the net/VAT/total breakdown', () => {
    const { subject, htmlBody, textBody } = rendered()
    expect(subject).toContain('TU-00001')
    expect(htmlBody).toContain('TU-00001')
    expect(htmlBody).toContain('Stillorgan')
    expect(htmlBody).toContain('20 July 2026')
    expect(htmlBody).toContain('€25.00')  // net credit
    expect(htmlBody).toContain('€5.75')   // VAT
    expect(htmlBody).toContain('€30.75')  // total
    expect(htmlBody).toContain('VAT (23%)')
    expect(textBody).toContain('Total paid: €30.75')
  })

  it('names the decided selling entity the way the legal pages do', () => {
    const { htmlBody, textBody } = rendered()
    expect(SELLING_ENTITY_NAME).toBe('Champ Fitness Ltd')
    expect(htmlBody).toContain('Champ Fitness Ltd')
    expect(htmlBody).toContain('(trading as UN1T Dublin)')
    expect(textBody).toContain('Champ Fitness Ltd')
  })

  it('escapes HTML in interpolated names', () => {
    const { htmlBody } = renderTopupInvoiceEmail({
      invoice: pendingInvoice(),
      locationName: '<script>x</script>',
      branding: { companyName: 'UN1T', logoUrl: null },
      recipientName: 'A & B',
    })
    expect(htmlBody).not.toContain('<script>x</script>')
    expect(htmlBody).toContain('&lt;script&gt;')
    expect(htmlBody).toContain('A &amp; B')
  })
})
