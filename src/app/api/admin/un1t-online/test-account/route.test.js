// UN1TWRITE.13 — POST /api/admin/un1t-online/test-account: a master drives
// the write primitives against the MIA TEST contact only, for the live
// verification run. The primitives are mocked; this pins the gates and what
// the answer may carry.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => ({ ...(await vi.importActual('@/lib/auth')), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/un1t-online-write-ops', () => ({
  createClient: vi.fn(), forgotPassword: vi.fn(), grantTrial: vi.fn(), book: vi.fn(), cancel: vi.fn(), createCheckoutLink: vi.fn(),
}))

import { POST, maxDuration } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logWarn, logError } from '@/lib/log'
import { createClient, forgotPassword, grantTrial, book, cancel, createCheckoutLink } from '@/lib/un1t-online-write-ops'

const LOC = '11111111-1111-4111-8111-111111111111'
const CONTACT = '22222222-2222-4222-8222-222222222222'
const ORG = 'org-1'
const master = { id: 'u-m', email: 'm@example.test', role: 'master', profileRole: 'master', isMaster: true, locations: [{ id: LOC }], rolesByLocation: { [LOC]: 'owner' } }
const owner = { ...master, id: 'u-o', role: 'owner', profileRole: 'owner', isMaster: false }

let contactRow
let locationRow
function makeDb() {
  return {
    from(table) {
      const b = {
        select: () => b, eq: () => b, limit: () => b,
        maybeSingle: async () => (table === 'contacts' ? { data: contactRow, error: null }
          : table === 'locations' ? { data: locationRow, error: null } : { data: null, error: null }),
      }
      return b
    },
  }
}
const post = (body) => POST(new Request('http://x/api/admin/un1t-online/test-account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location_id: LOC, contact_id: CONTACT, ...body }) }))
const done = (over = {}) => ({ verdict: 'done', sent: true, id: 'x-1', code: null, message: null, alreadyBooked: false, recovered: null, retryable: false, data: null, ledgerId: 'led-1', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
  getCurrentUser.mockResolvedValue(master)
  contactRow = { id: CONTACT, organization_id: ORG, name: 'MIA TEST', email: 'mia.test@example.test', first_name: 'MIA', last_name: 'TEST', phone: null, un1t_user_id: 'usr-1' }
  locationRow = { id: LOC, organization_id: ORG }
})

describe('POST /api/admin/un1t-online/test-account', () => {
  it('has room for a write and its check read (maxDuration 120)', () => {
    expect(maxDuration).toBe(120)
  })

  it('refuses a non-master 403 and calls nothing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    expect((await post({ op: 'book', event_id: 'ev-1' })).status).toBe(403)
    expect(book).not.toHaveBeenCalled()
  })

  it("refuses a contact named anything but MIA TEST (case-insensitive): 'MIA TEST 2', 'Mia Tester'", async () => {
    for (const name of ['MIA TEST 2', 'Mia Tester', 'Someone', null]) {
      contactRow = { ...contactRow, name }
      expect((await post({ op: 'book', event_id: 'ev-1' })).status, String(name)).toBe(403)
    }
    expect(book).not.toHaveBeenCalled()
  })

  it("accepts 'mia test'", async () => {
    contactRow = { ...contactRow, name: 'mia test' }
    book.mockResolvedValue(done({ id: 'bk-1' }))
    const res = await post({ op: 'book', event_id: 'ev-1' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ verdict: 'done', booking_id: 'bk-1', ledger_id: 'led-1' })
    expect(book).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: LOC, contactId: CONTACT, un1tUserId: 'usr-1', eventId: 'ev-1', origin: 'test_account', actor: { id: 'u-m' } }))
  })

  it('refuses a contact in another organisation 404, and an unknown one 404', async () => {
    contactRow = { ...contactRow, organization_id: 'org-2' }
    expect((await post({ op: 'book', event_id: 'ev-1' })).status).toBe(404)
    contactRow = null
    expect((await post({ op: 'book', event_id: 'ev-1' })).status).toBe(404)
    expect(book).not.toHaveBeenCalled()
  })

  it('create without terms_confirmed is 400 and sends nothing', async () => {
    expect((await post({ op: 'create' })).status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('create records terms_source test_account; the answer is the id only, never a password or the create body', async () => {
    createClient.mockResolvedValue({ ...done({ id: 'usr-new' }), conflict: null })
    const res = await post({ op: 'create', terms_confirmed: true })
    const j = await res.json()
    expect(j.data).toEqual({ verdict: 'done', code: null, message: null, un1t_user_id: 'usr-new', ledger_id: 'led-1', conflict: null })
    const args = createClient.mock.calls[0][1]
    expect(args.terms).toMatchObject({ source: 'test_account' })
    expect(Number.isFinite(Date.parse(args.terms.acceptedAt))).toBe(true)
    expect(args.origin).toBe('test_account')
    expect(JSON.stringify(j)).not.toMatch(/password|reset_password_token/i)
  })

  it('trial_skip_eligibility calls grantTrial with skipEligibility true; trial does not', async () => {
    grantTrial.mockResolvedValue({ outcome: 'granted', method: 'charge', ledgerId: 'led-2' })
    await post({ op: 'trial' })
    await post({ op: 'trial_skip_eligibility' })
    expect(grantTrial.mock.calls[0][1]).toMatchObject({ skipEligibility: false, origin: 'test_account', un1tUserId: 'usr-1' })
    expect(grantTrial.mock.calls[1][1]).toMatchObject({ skipEligibility: true, origin: 'test_account' })
    const j = await (await post({ op: 'trial' })).json()
    expect(j.data).toMatchObject({ outcome: 'granted', ledger_id: 'led-2' })
  })

  it('forgot_password and cancel go to their primitives with the contact\'s account', async () => {
    forgotPassword.mockResolvedValue(done({ id: null }))
    cancel.mockResolvedValue(done({ id: 'bk-1' }))
    await post({ op: 'forgot_password' })
    await post({ op: 'cancel', booking_id: 'bk-1' })
    expect(forgotPassword.mock.calls[0][1]).toMatchObject({ un1tUserId: 'usr-1', email: 'mia.test@example.test', origin: 'test_account' })
    expect(cancel.mock.calls[0][1]).toMatchObject({ un1tUserId: 'usr-1', bookingId: 'bk-1', origin: 'test_account' })
  })

  it('an op that needs an account refuses a contact with none (400), nothing sent', async () => {
    contactRow = { ...contactRow, un1t_user_id: null }
    expect((await post({ op: 'book', event_id: 'ev-1' })).status).toBe(400)
    expect(book).not.toHaveBeenCalled()
  })

  it('checkout returns the URL to the master and nothing logs it', async () => {
    const url = 'https://pay.example.test/session/secret-abc'
    createCheckoutLink.mockResolvedValue({ checkoutUrl: url, free: false })
    const res = await post({ op: 'checkout', product_id: 'p-1', success_url: 'https://s.example.test/ok', cancel_url: 'https://s.example.test/no', idempotency_key: 'k-1' })
    expect((await res.json()).data).toMatchObject({ checkout_url: url, free: false })
    const logs = JSON.stringify([...logInfo.mock.calls, ...logWarn.mock.calls, ...logError.mock.calls])
    expect(logs).not.toContain('secret-abc')
    // The typed key is namespaced to this route, studio and contact.
    expect(createCheckoutLink.mock.calls[0][1]).toMatchObject({ userId: 'usr-1', productId: 'p-1', idempotencyKey: `test_account:${LOC}:${CONTACT}:k-1`, origin: 'test_account' })
  })

  it('a programming error inside a primitive is a logged 500, never a 400 with its message', async () => {
    book.mockRejectedValue(new TypeError("Cannot read properties of null (reading 'x')"))
    const res = await post({ op: 'book', event_id: 'ev-1' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('Cannot read')
    expect(logError).toHaveBeenCalled()
  })

  it('a checkout refusal is a 409 with un1t.online\'s words', async () => {
    const { Un1tWriteRefused } = await import('@/lib/un1t-online-write')
    createCheckoutLink.mockRejectedValue(new Un1tWriteRefused('product_not_sellable', 'Not on sale.', null))
    const res = await post({ op: 'checkout', product_id: 'p-1', success_url: 'https://s.example.test/ok', cancel_url: 'https://s.example.test/no', idempotency_key: 'k-1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'product_not_sellable', error: 'Not on sale.' })
  })
})
