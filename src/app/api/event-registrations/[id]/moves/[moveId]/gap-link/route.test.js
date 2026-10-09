// EVENT-MOVE.5 — POST /api/event-registrations/[id]/moves/[moveId]/gap-link.
// Pins the gate (the settle route's: the entry's CURRENT event studio), the
// move checks, 409 already_settled, the createGapPayment call (URLs from the
// event slug), reuse, the optional email and how each refusal maps to a status.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => {
  const make = () => {
    const ops = []
    globalThis.__ops.push(ops)
    const b = {
      select: (...a) => { ops.push(['select', ...a]); return b },
      eq: (...a) => { ops.push(['eq', ...a]); return b },
      maybeSingle: async () => globalThis.__move,
    }
    return b
  }
  return { createServerClient: vi.fn(() => ({ from: (t) => { globalThis.__tables.push(t); return make() } })) }
})
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({ ...(await importOriginal()), readRegistrationForMove: vi.fn() }))
vi.mock('@/lib/race-gap-payment', () => ({ createGapPayment: vi.fn() }))
vi.mock('@/lib/race-confirmations', () => ({ sendGapLinkEmail: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { readRegistrationForMove } = await import('@/lib/registration-move')
const { createGapPayment } = await import('@/lib/race-gap-payment')
const { sendGapLinkEmail } = await import('@/lib/race-confirmations')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const R1 = 'c0000000-0000-0000-0000-000000000001'
const R2 = 'c0000000-0000-0000-0000-000000000002'
const MV = 'd0000000-0000-0000-0000-000000000001'
const manager = (locs, role = 'manager', races = true) => ({
  id: 'u1', full_name: 'Richard', email: 'r@x.ie', role, profileRole: role,
  activeLocation: { id: locs[0] },
  rolesByLocation: Object.fromEntries(locs.map((l) => [l, role])),
  assignmentsByLocation: Object.fromEntries(locs.map((l) => [l, { role, permissions: { races } }])),
  locations: locs.map((id) => ({ id, role, features: { races: true } })),
})
const props = (id = R1, moveId = MV) => ({ params: Promise.resolve({ id, moveId }) })
const post = (body) => new Request(`http://localhost/api/event-registrations/${R1}/moves/${MV}/gap-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const MOVE = { id: MV, registration_id: R1, to_event_id: E1, price_gap_cents: 1000, gap_settled_at: null, gap_settled_how: null, gap_settled_by_name: null }
const RACE = { id: E1, slug: 'hatch-oct25-1100', name: 'Hatch Oct 25', location_id: L1 }
const REG = { id: R1, status: 'confirmed', race_event_id: E1, race: RACE }
const URL_ = 'https://crm.test/event-pay/gp1'

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.__ops = []
  globalThis.__tables = []
  globalThis.__move = { data: { ...MOVE }, error: null }
  readRegistrationForMove.mockResolvedValue({ registration: REG, error: null })
  createGapPayment.mockResolvedValue({ ok: true, payment: { id: 'gp1' }, checkoutUrl: URL_, reused: false })
  sendGapLinkEmail.mockResolvedValue({ sent: ['email'], skipped: [], failed: [] })
})

describe('POST /api/event-registrations/[id]/moves/[moveId]/gap-link — the gate', () => {
  it('401 without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(post({ email: true }), props())).status).toBe(401)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('403 for a caller holding races nowhere, without a read', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'manager', false))
    expect((await POST(post({ email: true }), props())).status).toBe(403)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it.each([['entry', 'nope', MV], ['move', R1, 'nope']])('404 for a %s id that is not uuid-shaped', async (_w, id, moveId) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post({ email: true }), props(id, moveId))).status).toBe(404)
    expect(readRegistrationForMove).not.toHaveBeenCalled()
  })
  it('404 when the entry does not exist', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: null })
    expect((await POST(post({ email: true }), props())).status).toBe(404)
  })
  it('500 load_failed when the entry read fails', async () => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    readRegistrationForMove.mockResolvedValue({ registration: null, error: { message: 'boom' } })
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'load_failed' })
  })
  it('404 when the entry\'s CURRENT event studio is not the caller\'s', async () => {
    getCurrentUser.mockResolvedValue(manager([L2]))
    expect((await POST(post({ email: true }), props())).status).toBe(404)
    expect(globalThis.__tables).toEqual([])
  })
  it('403 for a non-manager at the studio', async () => {
    getCurrentUser.mockResolvedValue(manager([L1], 'staff'))
    expect((await POST(post({ email: true }), props())).status).toBe(403)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('403 for a manager without races at the studio', async () => {
    const u = manager([L1, L2])
    u.assignmentsByLocation[L1].permissions.races = false
    getCurrentUser.mockResolvedValue(u)
    expect((await POST(post({ email: true }), props())).status).toBe(403)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it.each([[{ email: 'yes' }], [{ email: 1 }]])('400 on a bad body %j', async (body) => {
    getCurrentUser.mockResolvedValue(manager([L1]))
    expect((await POST(post(body), props())).status).toBe(400)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
})

describe('POST …/gap-link — the entry must be confirmed', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(manager([L1])))
  it.each(['cancelled', 'pending_payment'])('400 not_active for a %s entry, minting nothing', async (status) => {
    readRegistrationForMove.mockResolvedValue({ registration: { ...REG, status }, error: null })
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'not_active', message: expect.any(String) })
    expect(createGapPayment).not.toHaveBeenCalled()
  })
})

describe('POST …/gap-link — the move', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(manager([L1])))
  it('404 when the move does not exist', async () => {
    globalThis.__move = { data: null, error: null }
    expect((await POST(post({ email: true }), props())).status).toBe(404)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('404 when the move belongs to another entry', async () => {
    globalThis.__move = { data: { ...MOVE, registration_id: R2 }, error: null }
    expect((await POST(post({ email: true }), props())).status).toBe(404)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('404 when the move is not INTO the entry\'s current event', async () => {
    globalThis.__move = { data: { ...MOVE, to_event_id: E2 }, error: null }
    expect((await POST(post({ email: true }), props())).status).toBe(404)
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('500 load_failed when the move read fails, logged', async () => {
    globalThis.__move = { data: null, error: { message: 'boom' } }
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'load_failed' })
    expect(logError).toHaveBeenCalled()
  })
  it.each([0, -500])('400 no_gap when the gap is %i', async (gap) => {
    globalThis.__move = { data: { ...MOVE, price_gap_cents: gap }, error: null }
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'no_gap', message: expect.any(String) })
    expect(createGapPayment).not.toHaveBeenCalled()
  })
  it('409 already_settled when the move is settled, minting nothing', async () => {
    globalThis.__move = { data: { ...MOVE, gap_settled_at: '2026-10-09T10:00:00Z', gap_settled_how: 'waived', gap_settled_by_name: 'Colm' }, error: null }
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: 'already_settled', message: expect.stringContaining('waived') })
    expect(createGapPayment).not.toHaveBeenCalled()
  })
})

describe('POST …/gap-link — the link', () => {
  beforeEach(() => getCurrentUser.mockResolvedValue(manager([L1])))
  it('mints the link with the confirmed-page return URL and the event cancel URL', async () => {
    const res = await POST(post({ email: false }), props())
    expect(res.status).toBe(200)
    expect(createGapPayment).toHaveBeenCalledWith(expect.objectContaining({
      move: expect.objectContaining({ id: MV }),
      registration: REG,
      race: RACE,
      returnUrl: `https://crm.test/event/hatch-oct25-1100/confirmed?registration=${R1}`,
      cancelUrl: 'https://crm.test/event/hatch-oct25-1100',
    }))
    expect(await res.json()).toEqual({ success: true, data: { payment_id: 'gp1', url: URL_, reused: false, emailed: false } })
    expect(sendGapLinkEmail).not.toHaveBeenCalled()
  })
  it('an omitted body field sends no email', async () => {
    await POST(post({}), props())
    expect(sendGapLinkEmail).not.toHaveBeenCalled()
  })
  it('email: true sends the link email for that payment and says so', async () => {
    const res = await POST(post({ email: true }), props())
    expect(sendGapLinkEmail).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'gp1', payUrl: URL_ }))
    expect((await res.json()).data).toEqual({ payment_id: 'gp1', url: URL_, reused: false, emailed: true })
  })
  it('an email that did not go still answers 200 with the URL and emailed: false', async () => {
    sendGapLinkEmail.mockResolvedValue({ sent: [], skipped: ['email:bounced'], failed: [] })
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ payment_id: 'gp1', url: URL_, reused: false, emailed: false })
  })
  it('a thrown email still answers 200 with the URL, logged', async () => {
    sendGapLinkEmail.mockRejectedValue(new Error('postmark down'))
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(200)
    expect((await res.json()).data.emailed).toBe(false)
    expect(logError).toHaveBeenCalled()
  })
  it('a reused link says reused: true', async () => {
    createGapPayment.mockResolvedValue({ ok: true, payment: { id: 'gp0' }, checkoutUrl: 'https://crm.test/event-pay/gp0', reused: true })
    const res = await POST(post({ email: false }), props())
    expect((await res.json()).data).toEqual({ payment_id: 'gp0', url: 'https://crm.test/event-pay/gp0', reused: true, emailed: false })
  })
  it.each([
    ['already_settled', 409],
    ['no_gap', 400],
    ['no_email', 400],
    ['host_not_ready', 409],
    ['provider_failed', 502],
    ['load_failed', 500],
    ['write_failed', 500],
  ])('a %s refusal answers %i with a message, and sends no email', async (error, status) => {
    createGapPayment.mockResolvedValue({ ok: false, error })
    const res = await POST(post({ email: true }), props())
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ success: false, error, message: expect.any(String) })
    expect(sendGapLinkEmail).not.toHaveBeenCalled()
  })
})
