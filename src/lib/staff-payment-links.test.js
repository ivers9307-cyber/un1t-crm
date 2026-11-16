import { describe, it, expect } from 'vitest'
import {
  LIVE_STATUSES, STAFF_PAYMENT_LINK_TTL_MS, BUY_PATH, mintPaymentToken, hashPaymentToken, buildBuyUrl,
  issueStaffPaymentLink, revokeStaffPaymentLink, resolveStaffPaymentLink, markOpened,
  isPaymentForLink, productLabel, paymentLinkCopy, fillCopy,
} from './staff-payment-links'

// A recording chain: every filter call is logged; awaiting resolves to the
// next scripted result for that table+op.
function makeDb(script = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const rec = { table, op: null, payload: null, filters: [] }
      calls.push(rec)
      const chain = {}
      for (const m of ['select', 'insert', 'update', 'eq', 'in', 'is', 'gte', 'order', 'limit']) {
        chain[m] = (...args) => {
          if (['insert', 'update'].includes(m)) { rec.op = m; rec.payload = args[0] } else if (m === 'select' && !rec.op) rec.op = 'select'
          else rec.filters.push([m, ...args])
          return chain
        }
      }
      const result = () => {
        const q = script[`${table}.${rec.op}`]
        const r = Array.isArray(q) ? q.shift() : q
        return r || { data: null, error: null }
      }
      chain.maybeSingle = async () => result()
      chain.single = async () => result()
      chain.then = (res, rej) => Promise.resolve(result()).then(res, rej)
      return chain
    },
  }
  return db
}

const PRODUCT = { un1t_id: 'p1', title: '10 Class Pack', price_cents: 12500 }
const ARGS = { locationId: 'L', organizationId: 'O', contactId: 'C', product: PRODUCT, createdBy: 'U', now: Date.parse('2026-11-15T10:00:00Z') }

describe('tokens', () => {
  it('mints a token whose hash matches hashPaymentToken', () => {
    const { token, hash } = mintPaymentToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).toBe(hashPaymentToken(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('builds the buy url', () => {
    expect(BUY_PATH).toBe('/buy/')
    expect(buildBuyUrl('https://crm.example.com/', 'tok')).toBe('https://crm.example.com/buy/tok')
  })
  it('exports the ttl and a frozen live list', () => {
    expect(STAFF_PAYMENT_LINK_TTL_MS).toBe(7 * 24 * 60 * 60_000)
    expect(Object.isFrozen(LIVE_STATUSES)).toBe(true)
    expect([...LIVE_STATUSES]).toEqual(['sent', 'opened', 'checkout_started'])
  })
})

describe('issueStaffPaymentLink', () => {
  it('revokes the previous live link before inserting', async () => {
    const db = makeDb({ 'staff_payment_links.insert': { data: { id: 'new' }, error: null } })
    const r = await issueStaffPaymentLink(db, ARGS)
    expect(r.ok).toBe(true)
    expect(r.linkId).toBe('new')
    expect(r.expiresAt).toBe(new Date(ARGS.now + STAFF_PAYMENT_LINK_TTL_MS).toISOString())
    const [revoke, insert] = db.calls
    expect(revoke.op).toBe('update')
    expect(revoke.payload.status).toBe('revoked')
    expect(revoke.filters).toContainEqual(['eq', 'location_id', 'L'])
    expect(revoke.filters).toContainEqual(['eq', 'contact_id', 'C'])
    expect(revoke.filters).toContainEqual(['in', 'status', LIVE_STATUSES])
    expect(insert.op).toBe('insert')
    expect(insert.payload.token_hash).toBe(hashPaymentToken(r.token))
    expect(insert.payload.status).toBe('sent')
    expect(JSON.stringify(insert.payload)).not.toContain(r.token)
  })
  it('retries the revoke once on a 23505 and then succeeds', async () => {
    const db = makeDb({ 'staff_payment_links.insert': [
      { data: null, error: { code: '23505', message: 'dup' } },
      { data: { id: 'new' }, error: null },
    ] })
    const r = await issueStaffPaymentLink(db, ARGS)
    expect(r.ok).toBe(true)
    expect(db.calls.map((c) => c.op)).toEqual(['update', 'insert', 'update', 'insert'])
  })
  it('fails when the revoke fails', async () => {
    const db = makeDb({ 'staff_payment_links.update': { data: null, error: { code: 'XX', message: 'boom with row data' } } })
    const r = await issueStaffPaymentLink(db, ARGS)
    expect(r).toEqual({ ok: false, error: 'revoke_failed', code: 'XX' })
    expect(db.calls.some((c) => c.op === 'insert')).toBe(false)
  })
})

describe('revokeStaffPaymentLink', () => {
  it('sets revoked with the reason', async () => {
    const db = makeDb()
    await revokeStaffPaymentLink(db, 'abc', 'send failed')
    expect(db.calls[0].payload).toMatchObject({ status: 'revoked', last_error: 'send failed' })
    expect(db.calls[0].filters).toContainEqual(['eq', 'id', 'abc'])
  })
})

describe('resolveStaffPaymentLink', () => {
  it('refuses a malformed token without a query', async () => {
    const db = makeDb()
    expect(await resolveStaffPaymentLink(db, 'short')).toEqual({ kind: 'not_found' })
    expect(await resolveStaffPaymentLink(db, 'x'.repeat(40) + '!')).toEqual({ kind: 'not_found' })
    expect(await resolveStaffPaymentLink(db, undefined)).toEqual({ kind: 'not_found' })
    expect(db.calls).toHaveLength(0)
  })
  const tok = 'a'.repeat(43)
  it('not_found when no row', async () => {
    const db = makeDb({ 'staff_payment_links.select': { data: null, error: null } })
    expect(await resolveStaffPaymentLink(db, tok)).toEqual({ kind: 'not_found' })
    expect(db.calls[0].filters).toContainEqual(['eq', 'token_hash', hashPaymentToken(tok)])
  })
  it('reads a live row past expires_at as expired, without a write', async () => {
    const row = { id: 'l', status: 'opened', expires_at: '2026-11-01T00:00:00Z' }
    const db = makeDb({ 'staff_payment_links.select': { data: row, error: null } })
    const r = await resolveStaffPaymentLink(db, tok, { now: Date.parse('2026-11-15T00:00:00Z') })
    expect(r).toEqual({ kind: 'link', link: row, state: 'expired' })
    expect(db.calls.every((c) => c.op === 'select')).toBe(true)
  })
  it('maps live, paid, revoked', async () => {
    const now = Date.parse('2026-11-15T00:00:00Z')
    for (const [status, state] of [['sent', 'live'], ['checkout_started', 'live'], ['paid', 'paid'], ['revoked', 'revoked'], ['expired', 'expired']]) {
      const row = { id: 'l', status, expires_at: '2026-11-20T00:00:00Z' }
      const db = makeDb({ 'staff_payment_links.select': { data: row, error: null } })
      expect((await resolveStaffPaymentLink(db, tok, { now })).state).toBe(state)
    }
  })
  it('throws on a read error rather than saying not found', async () => {
    const db = makeDb({ 'staff_payment_links.select': { data: null, error: { message: 'x' } } })
    await expect(resolveStaffPaymentLink(db, tok)).rejects.toThrow()
  })
})

describe('markOpened', () => {
  it('CASes sent to opened', async () => {
    const db = makeDb()
    await markOpened(db, 'l', '2026-11-15T10:00:00Z')
    const c = db.calls[0]
    expect(c.payload).toMatchObject({ status: 'opened', opened_at: '2026-11-15T10:00:00Z' })
    expect(c.filters).toContainEqual(['eq', 'id', 'l'])
    expect(c.filters).toContainEqual(['eq', 'status', 'sent'])
  })
})

describe('isPaymentForLink', () => {
  const link = { un1t_user_id: 'u1', un1t_product_id: 'p1', created_at: '2026-11-15T10:00:00Z' }
  const good = { un1t_user_id: 'u1', product_id: 'p1', remote_created_at: '2026-11-15T11:00:00Z', amount_cents: 12500, type: 'purchase', refunded: false }
  it.each([
    ['matching', {}, true],
    ['null refunded', { refunded: null }, true],
    ['other product', { product_id: 'p2' }, false],
    ['no product', { product_id: null }, false],
    ['zero euro', { amount_cents: 0 }, false],
    ['null amount', { amount_cents: null }, false],
    ['sub_renewal', { type: 'sub_renewal' }, false],
    ['refunded', { refunded: true }, false],
    ['before created_at', { remote_created_at: '2026-11-15T09:59:59Z' }, false],
    ['no date', { remote_created_at: null }, false],
    ['other user', { un1t_user_id: 'u2' }, false],
  ])('%s', (_n, patch, want) => {
    expect(isPaymentForLink(link, { ...good, ...patch })).toBe(want)
  })
  it('false when the link has no user yet', () => {
    expect(isPaymentForLink({ ...link, un1t_user_id: null }, good)).toBe(false)
  })
})

describe('productLabel', () => {
  it('joins title and price', () => {
    expect(productLabel({ title: '10 Class Pack', price_cents: 12500 })).toBe('10 Class Pack, €125')
  })
  it('says a month only for recurring', () => {
    expect(productLabel({ title: 'Unlimited', price_cents: 18900, type: 'recurring', billing_interval: 'month', billing_interval_count: 1 })).toBe('Unlimited, €189 a month')
    expect(productLabel({ title: 'Pack', price_cents: 5000, type: 'one_time', billing_interval: 'month' })).toBe('Pack, €50')
  })
  it('falls back to the title with no price', () => {
    expect(productLabel({ title: 'Pack' })).toBe('Pack')
  })
})

describe('paymentLinkCopy', () => {
  it('defaults', () => {
    const c = paymentLinkCopy(null)
    expect(c.template_name).toBeNull()
    expect(c.button_text).toBe('Pay now')
    expect(c.page_title_new).toBe('Complete your purchase')
    expect(c.page_title_existing).toBe('Complete your purchase')
    expect(c.whatsapp_text).toBe("Hi {first_name}, it's {studio}. Here's the link for the {product} we talked about on the phone. Tap below to pay securely on un1t.online.")
    expect(c.paid_text).toBe("You're all paid up. See you in class!")
    expect(c.expired_text).toBe("This link has expired. Reply to us on WhatsApp and we'll send you a new one.")
    expect(c.unavailable_text).toBe("We couldn't reach the payment system just now. Please try again in a minute.")
    expect(c.help_text).toBe("We couldn't set up your account automatically. Reply to us on WhatsApp and we'll sort it out.")
  })
  it('falls back per key on empty or non-string values and honours overrides', () => {
    const c = paymentLinkCopy({ template_name: 'pay_link', button_text: '   ', paid_text: 5, expired_text: 'Gone', whatsapp_text: '' })
    expect(c.template_name).toBe('pay_link')
    expect(c.button_text).toBe('Pay now')
    expect(c.paid_text).toBe("You're all paid up. See you in class!")
    expect(c.expired_text).toBe('Gone')
    expect(c.whatsapp_text).toMatch(/^Hi \{first_name\}/)
  })
  it('carries the set-password email copy with a {studio} placeholder, overridable', () => {
    const d = paymentLinkCopy(null)
    expect(d.set_password_email_subject).toBe('Your {studio} account')
    expect(d.set_password_email_body).toContain('{studio}')
    expect(fillCopy(d.set_password_email_subject, { studio: 'UN1T Hatch Street' })).toBe('Your UN1T Hatch Street account')
    expect(paymentLinkCopy({ set_password_email_subject: 'Hi from {studio}' }).set_password_email_subject).toBe('Hi from {studio}')
  })
  it('fillCopy keeps unknown placeholders and reads $& literally', () => {
    expect(fillCopy('{studio} {other}', { studio: '$& Co' })).toBe('$& Co {other}')
  })
})
