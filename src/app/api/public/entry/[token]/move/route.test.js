// EVENT-MOVE.6 — POST /api/public/entry/[token]/move: the person who booked
// moves their own entry. The token is the only credential (404 on any bad
// one, never 401/403). Equal or cheaper moves at once as the customer; dearer
// mints a difference payment carrying the pending move and answers its URL.
// The rules themselves are pinned in src/lib/registration-move.test.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() })) }))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date(), retryAfterSec: 1 })),
}))
vi.mock('@/lib/registration-move', async (importOriginal) => ({
  ...(await importOriginal()),
  readRegistrationForMove: vi.fn(),
  checkMove: vi.fn(),
  moveRegistration: vi.fn(),
}))
vi.mock('@/lib/race-gap-payment', () => ({ createGapPayment: vi.fn() }))
vi.mock('@/lib/dublin-time', async (importOriginal) => ({ ...(await importOriginal()), dublinTodayStr: () => '2026-10-09' }))

const { checkRateLimit } = await import('@/lib/rate-limit')
const { readRegistrationForMove, checkMove, moveRegistration } = await import('@/lib/registration-move')
const { createGapPayment } = await import('@/lib/race-gap-payment')
const { signEntryManageToken } = await import('@/lib/entry-manage-tokens')
const { POST } = await import('./route.js')

const SECRET = 'svc-key'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const W9 = 'f0000000-0000-0000-0000-000000000009'
const REG = {
  id: R1, status: 'confirmed', race_event_id: E1, contact_id: 'k1', race_started_at: null, race_finished_at: null,
  contact: { id: 'k1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie' },
  teams: { id: 't1', name: 'Aoife Byrne', size: 1, team_members: [{ id: 'm1', name: 'Aoife Byrne', role: 'captain', email: 'aoife@x.ie' }] },
  race: { id: E1, name: 'Hatch Oct 18', race_date: '2026-10-18', location_id: 'L1', host_id: null, payment_currency: 'EUR' },
}
const tokenFor = (id = R1) => signEntryManageToken({ registrationId: id }, SECRET)
const props = (token = tokenFor()) => ({ params: Promise.resolve({ token }) })
const post = (body) => new Request('http://localhost/api/public/entry/x/move', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body),
})
const BODY = { target_event_id: E2, target_wave_id: W9 }
const checked = (gap) => ({ ok: true, registration: REG, targetEvent: { id: E2 }, targetWave: { id: W9 }, headcount: 1, priceGapCents: gap })
const CUSTOMER = { type: 'customer', id: 'k1', name: 'Aoife Byrne' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
  readRegistrationForMove.mockResolvedValue({ registration: REG, error: null })
  checkMove.mockResolvedValue(checked(0))
  moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: R1, race_event_id: E2, wave_id: W9 }, notified: true })
  createGapPayment.mockResolvedValue({ ok: true, payment: { id: 'gp1' }, checkoutUrl: 'https://crm.test/event-pay/gp1', reused: false })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('POST /api/public/entry/[token]/move — the token', () => {
  it.each([
    ['garbage', 'not-a-token'],
    ['a forged signature', `${tokenFor().split('.')[0]}.AAAA`],
    ['another secret', signEntryManageToken({ registrationId: R1 }, 'other')],
    ['an expired token', signEntryManageToken({ registrationId: R1 }, SECRET, { nowMs: Date.now() - 91 * 24 * 3600 * 1000 })],
  ])('%s is a 404 with no read', async (_w, token) => {
    const res = await POST(post(BODY), props(token))
    expect(res.status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
    expect(moveRegistration).not.toHaveBeenCalled()
  })
  it('an entry that no longer exists is a 404; a failed read is a 500', async () => {
    readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: null })
    expect((await POST(post(BODY), props())).status).toBe(404)
    readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: { message: 'down' } })
    expect((await POST(post(BODY), props())).status).toBe(500)
  })
  it('is rate limited per IP on its own bucket (10 per 15 minutes)', async () => {
    await POST(post(BODY), props())
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), 'entry-move:1.2.3.4', { max: 10, windowMs: 15 * 60_000 })
    checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(), retryAfterSec: 60 })
    expect((await POST(post(BODY), props())).status).toBe(429)
  })
  it('a bad body is a 400', async () => {
    expect((await POST(post({ target_event_id: 'nope' }), props())).status).toBe(400)
    expect(moveRegistration).not.toHaveBeenCalled()
  })
})

describe('POST /api/public/entry/[token]/move — what the holder may not move', () => {
  it.each([
    ['unpaid', { status: 'pending_payment' }, 'pending_payment'],
    ['cancelled', { status: 'cancelled' }, 'not_active'],
    ['past', { race: { ...REG.race, race_date: '2026-10-01' } }, 'event_past'],
  ])('%s: 400 with the customer sentence, nothing checked or written', async (_w, over, code) => {
    readRegistrationForMove.mockResolvedValue({ registration: { ...REG, ...over }, error: null })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe(code)
    expect(body.message).toBeTruthy()
    expect(checkMove).not.toHaveBeenCalled()
    expect(moveRegistration).not.toHaveBeenCalled()
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('checked in (found by the rules): 400', async () => {
    checkMove.mockResolvedValue({ ok: false, error: 'checked_in' })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('checked_in')
  })
  it('a full time is a 409 with no spots and no force offer, even if the body asks to force', async () => {
    checkMove.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const res = await POST(post({ ...BODY, force: true }), props())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).not.toHaveProperty('spots_left')
    expect(JSON.stringify(body)).not.toMatch(/spot|capacity|force/i)
    expect(checkMove).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force: false }))
  })
  it('never answers 401 or 403', async () => {
    for (const error of ['not_found', 'not_active', 'different_payee', 'target_unavailable', 'conflict', 'load_failed', 'write_failed']) {
      checkMove.mockResolvedValueOnce({ ok: false, error })
      const res = await POST(post(BODY), props())
      expect([401, 403]).not.toContain(res.status)
    }
  })
})

describe('POST /api/public/entry/[token]/move — equal or cheaper moves at once', () => {
  it.each([0, -500])('gap %i: moves as the customer, notifying, never forcing, from the event the token holder saw', async (gap) => {
    checkMove.mockResolvedValue(checked(gap))
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { moved: true, registration: { id: R1, race_event_id: E2, wave_id: W9 }, notified: true } })
    expect(checkMove).toHaveBeenCalledWith(expect.anything(), { registrationId: R1, targetEventId: E2, targetWaveId: W9, force: false, expectedSourceEventId: E1 })
    expect(moveRegistration).toHaveBeenCalledWith(expect.anything(), {
      registrationId: R1, targetEventId: E2, targetWaveId: W9, actor: CUSTOMER, notify: true, force: false, expectedSourceEventId: E1,
    })
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('a refusal at the write is mapped (conflict 409, write_failed 500)', async () => {
    moveRegistration.mockResolvedValueOnce({ ok: false, error: 'conflict' })
    expect((await POST(post(BODY), props())).status).toBe(409)
    moveRegistration.mockResolvedValueOnce({ ok: false, error: 'write_failed' })
    expect((await POST(post(BODY), props())).status).toBe(500)
  })
})

describe('POST /api/public/entry/[token]/move — dearer pays first', () => {
  it('mints a difference payment carrying the pending move, returns to this page, and answers the pay URL', async () => {
    checkMove.mockResolvedValue(checked(1000))
    const token = tokenFor()
    const res = await POST(post(BODY), props(token))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { moved: false, pay_url: 'https://crm.test/event-pay/gp1' } })
    expect(moveRegistration).not.toHaveBeenCalled()
    expect(createGapPayment).toHaveBeenCalledWith({
      db: expect.anything(),
      registration: REG,
      race: REG.race,
      pendingMove: { target_event_id: E2, target_wave_id: W9, expected_source_event_id: E1, actor: CUSTOMER },
      amountCents: 1000,
      returnUrl: `https://crm.test/event/entry/${token}`,
      cancelUrl: `https://crm.test/event/entry/${token}`,
    })
  })
  it.each([
    ['no_email', 400], ['host_not_ready', 409], ['provider_failed', 502], ['write_failed', 500], ['already_settled', 409],
  ])('a payment refusal %s answers %i with a customer sentence', async (error, status) => {
    checkMove.mockResolvedValue(checked(1000))
    createGapPayment.mockResolvedValueOnce({ ok: false, error })
    const res = await POST(post(BODY), props())
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body.error).toBe(error)
    expect(body.message).not.toMatch(/—|–/)
  })
})
