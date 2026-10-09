// EVENT-MOVE.5 — createGapPayment: a payment for a moved entry's price
// difference. Pins the preconditions, the reuse of a pending link, the
// provider call (no booking fee, its own idempotency key), the row it writes
// (kind move_gap, the move id, no roster counts) and what it never touches
// (active_payment_id, RACE_REGISTERED).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createPayment = vi.fn()
const getPayment = vi.fn()
vi.mock('./payments', () => ({ paymentsFor: vi.fn(() => ({ createPayment, getPayment })) }))
vi.mock('./race-confirmations', () => ({ sendGapPaidEmail: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })) }))
vi.mock('./event-hosts', async (importOriginal) => ({ ...(await importOriginal()), resolveEventHost: vi.fn(async () => null) }))
vi.mock('./orders', () => ({ syncOrderFromRacePayment: vi.fn(async () => {}) }))
vi.mock('./contact-events', async (importOriginal) => ({ ...(await importOriginal()), emitEvent: vi.fn(async () => {}), applyTagRules: vi.fn() }))
vi.mock('./app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./sequences', () => ({ triggerSequencesForOrderStatus: vi.fn(async () => {}) }))
vi.mock('./host-contact-list', () => ({ addEventAttendeesToHostList: vi.fn(async () => {}) }))

const { paymentsFor } = await import('./payments')
const { resolveEventHost } = await import('./event-hosts')
const { syncOrderFromRacePayment } = await import('./orders')
const { emitEvent, applyTagRules, EVENT_TYPES } = await import('./contact-events')
const { logError } = await import('./log')
const { createGapPayment } = await import('./race-gap-payment.js')
const { markRacePaymentStatus, refreshRacePaymentFromProvider } = await import('./race-payments.js')
const { sendGapPaidEmail } = await import('./race-confirmations')
const { triggerSequencesForOrderStatus } = await import('./sequences')
const { addEventAttendeesToHostList } = await import('./host-contact-list')

const RACE = { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100', location_id: 'L1', host_id: null, payment_currency: 'EUR' }
const REG = {
  id: 'r1', race_event_id: 'e2', contact_id: 'c1',
  contact: { id: 'c1', first_name: 'Aoife', last_name: 'Byrne', email: 'aoife@x.ie' },
  teams: { id: 't1', name: 'The Crushers', size: 2, team_members: [
    { id: 'm1', name: 'Aoife Byrne', role: 'captain', email: 'cap@x.ie' },
    { id: 'm2', name: 'Dan Walsh', role: 'member', email: null },
  ] },
}
const MOVE = { id: 'mv1', registration_id: 'r1', to_event_id: 'e2', price_gap_cents: 1000, gap_settled_at: null }
const ENTRY_PAY = { id: 'p1', kind: 'entry', status: 'completed', registration_move_id: null, contact_email: 'pay@x.ie', contact_phone: '+3531', contact_name: 'Aoife B', created_at: '2026-10-01T00:00:00Z' }

function fakeDb({ payments = { data: [ENTRY_PAY], error: null }, insert = { error: null }, settle = { data: [{ id: 'mv1' }], error: null } } = {}) {
  const queries = []
  const inserts = []
  const updates = []
  return {
    queries, inserts, updates,
    from(table) {
      const q = { table, ops: [] }
      queries.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit', 'is']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.insert = (row) => { inserts.push({ table, row }); q.ops.push(['insert', row]); return b }
      b.update = (patch) => { updates.push({ table, patch }); q.ops.push(['update', patch]); return b }
      const answer = () => {
        if (q.ops.some((o) => o[0] === 'insert')) return insert.error ? { data: null, error: insert.error } : { data: { id: 'gp1', ...inserts[inserts.length - 1].row }, error: null }
        if (table === 'registration_moves') return settle
        if (table === 'race_payments' && !q.ops.some((o) => o[0] === 'update')) return payments
        return { data: null, error: null }
      }
      b.single = async () => answer()
      b.maybeSingle = async () => answer()
      b.then = (res, rej) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  }
}

const args = (over = {}) => ({ db: fakeDb(), move: MOVE, registration: REG, race: RACE, returnUrl: 'https://crm.test/event/hatch-oct25-1100/confirmed?registration=r1', cancelUrl: 'https://crm.test/event/hatch-oct25-1100', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  resolveEventHost.mockResolvedValue(null)
  createPayment.mockResolvedValue({ providerRef: 'ord-1', checkoutToken: 'tok', checkoutUrl: 'https://rev/1', state: 'pending', amountCents: 1000 })
})

describe('createGapPayment — preconditions', () => {
  it.each([
    ['a move of another entry', { move: { ...MOVE, registration_id: 'r9' } }, 'not_this_entry'],
    ['a move into another event than the one the entry is on', { move: { ...MOVE, to_event_id: 'e9' } }, 'not_current_move'],
    ['no positive gap', { move: { ...MOVE, price_gap_cents: 0 } }, 'no_gap'],
    ['a cheaper target', { move: { ...MOVE, price_gap_cents: -500 } }, 'no_gap'],
    ['a settled move', { move: { ...MOVE, gap_settled_at: '2026-10-09T10:00:00Z' } }, 'already_settled'],
  ])('refuses %s without a provider call or a write', async (_w, over, error) => {
    const a = args(over)
    expect(await createGapPayment(a)).toEqual({ ok: false, error })
    expect(createPayment).not.toHaveBeenCalled()
    expect(a.db.inserts).toEqual([])
  })
  it('refuses load_failed when the payments read fails, and logs it', async () => {
    const a = args({ db: fakeDb({ payments: { data: null, error: { message: 'boom' } } }) })
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'load_failed' })
    expect(createPayment).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })
  it('refuses host_not_ready for a Stripe host that cannot take payments', async () => {
    resolveEventHost.mockResolvedValue({ id: 'h1', payment_provider: 'stripe_connect', charges_enabled: false, stripe_connected_account_id: 'acct_1' })
    const a = args({ race: { ...RACE, host_id: 'h1' } })
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'host_not_ready' })
    expect(createPayment).not.toHaveBeenCalled()
  })
  it('refuses no_email when nobody on the entry has an address', async () => {
    const reg = { ...REG, contact: { id: 'c1' }, teams: { ...REG.teams, team_members: REG.teams.team_members.map((m) => ({ ...m, email: null })) } }
    const a = args({ registration: reg, db: fakeDb({ payments: { data: [], error: null } }) })
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'no_email' })
    expect(createPayment).not.toHaveBeenCalled()
  })
})

describe('createGapPayment — a new link', () => {
  it('creates a Revolut order for the gap with no booking fee and an attempt-scoped idempotency key', async () => {
    const a = args()
    const r = await createGapPayment(a)
    expect(r.ok).toBe(true)
    expect(r.reused).toBe(false)
    expect(paymentsFor).toHaveBeenCalledWith('revolut')
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 1000,
      currency: 'EUR',
      description: 'Hatch Oct 25 — price difference',
      returnUrl: a.returnUrl,
      cancelUrl: a.cancelUrl,
      metadata: { race_event_id: 'e2', race_registration_id: 'r1', registration_move_id: 'mv1', domain: 'un1t_race_gap' },
      idempotencyKey: 'move:mv1:0',
      connectedAccountId: null,
      applicationFeeCents: 0,
    }))
  })
  it('a second link after an abandoned one uses a fresh idempotency key (Revolut would hand back the dead order)', async () => {
    const dead = { id: 'gp0', kind: 'move_gap', status: 'abandoned', registration_move_id: 'mv1', contact_email: 'aoife@x.ie', created_at: '2026-10-08T00:00:00Z' }
    await createGapPayment(args({ db: fakeDb({ payments: { data: [dead, ENTRY_PAY], error: null } }) }))
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'move:mv1:1' }))
  })
  it('writes a move_gap row for the move: the gap, the lead contact, no roster counts, provider fields, pending', async () => {
    const a = args()
    const r = await createGapPayment(a)
    const ins = a.db.inserts.filter((i) => i.table === 'race_payments')
    expect(ins).toHaveLength(1)
    const row = ins[0].row
    expect(row).toEqual(expect.objectContaining({
      kind: 'move_gap',
      registration_move_id: 'mv1',
      race_event_id: 'e2',
      race_registration_id: 'r1',
      contact_id: 'c1',
      contact_email: 'aoife@x.ie',
      contact_phone: '+3531',
      contact_name: 'Aoife Byrne',
      amount_cents: 1000,
      currency: 'EUR',
      member_fee_cents: null,
      non_member_fee_cents: null,
      status: 'pending',
      payment_provider: 'revolut',
      payment_provider_ref: 'ord-1',
      payment_checkout_token: 'tok',
      payment_checkout_url: 'https://rev/1',
      application_fee_cents: null,
    }))
    // NOT NULL DEFAULT 0 on disk: left to the default, never written NULL.
    expect('member_count' in row).toBe(false)
    expect('non_member_count' in row).toBe(false)
    expect(r.payment.id).toBe('gp1')
    expect(r.checkoutUrl).toBe('https://crm.test/event-pay/gp1')
  })
  it('never touches the registration (active_payment_id stays the entry payment)', async () => {
    const a = args()
    await createGapPayment(a)
    expect(a.db.updates).toEqual([])
    expect(a.db.queries.some((q) => q.table === 'race_registrations')).toBe(false)
  })
  it('projects the order and emits ORDER_CREATED, never RACE_REGISTERED, and applies no tag rules', async () => {
    await createGapPayment(args())
    expect(syncOrderFromRacePayment).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ id: 'gp1', kind: 'move_gap' }) }))
    const types = emitEvent.mock.calls.map(([e]) => e.eventType)
    expect(types).toEqual([EVENT_TYPES.ORDER_CREATED])
    expect(emitEvent.mock.calls[0][0]).toEqual(expect.objectContaining({ sourceType: 'race_registration', sourceId: 'gp1', locationId: 'L1', metadata: expect.objectContaining({ kind: 'move_gap', amount_cents: 1000 }) }))
    expect(applyTagRules).not.toHaveBeenCalled()
  })
  it('a Stripe host: direct charge on the connected account, still no booking fee, net to host = the gap', async () => {
    resolveEventHost.mockResolvedValue({ id: 'h1', payment_provider: 'stripe_connect', charges_enabled: true, stripe_connected_account_id: 'acct_1', booking_fee_cents: 150 })
    createPayment.mockResolvedValue({ providerRef: 'cs_1', checkoutToken: 'secret', checkoutUrl: null, state: 'pending', amountCents: 1000 })
    const a = args({ race: { ...RACE, host_id: 'h1' } })
    await createGapPayment(a)
    expect(paymentsFor).toHaveBeenCalledWith('stripe_connect')
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000, connectedAccountId: 'acct_1', applicationFeeCents: 0 }))
    expect(a.db.inserts[0].row).toEqual(expect.objectContaining({ payment_provider: 'stripe_connect', connected_account_id: 'acct_1', net_to_host_cents: 1000, application_fee_cents: null }))
  })
  it('a provider failure answers provider_failed and writes nothing', async () => {
    createPayment.mockRejectedValue(new Error('revolut down'))
    const a = args()
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'provider_failed' })
    expect(a.db.inserts).toEqual([])
    expect(logError).toHaveBeenCalled()
  })
  it('a failed insert answers write_failed and logs the orphan provider ref', async () => {
    const a = args({ db: fakeDb({ insert: { error: { message: 'nope' } } }) })
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'write_failed' })
    expect(logError).toHaveBeenCalledWith('race-gap-payment', expect.any(String), expect.objectContaining({ providerRef: 'ord-1' }))
  })
  it('the event currency carries through', async () => {
    await createGapPayment(args({ race: { ...RACE, payment_currency: 'GBP' } }))
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ currency: 'GBP' }))
  })
})

describe('createGapPayment — reuse', () => {
  it('returns the pending move_gap payment for this move instead of minting another', async () => {
    const pending = { id: 'gp0', kind: 'move_gap', status: 'pending', registration_move_id: 'mv1', amount_cents: 1000, contact_email: 'aoife@x.ie', created_at: '2026-10-08T00:00:00Z' }
    const a = args({ db: fakeDb({ payments: { data: [pending, ENTRY_PAY], error: null } }) })
    const r = await createGapPayment(a)
    expect(r).toEqual({ ok: true, payment: pending, checkoutUrl: 'https://crm.test/event-pay/gp0', reused: true })
    expect(createPayment).not.toHaveBeenCalled()
    expect(a.db.inserts).toEqual([])
    expect(emitEvent).not.toHaveBeenCalled()
  })
  it('a pending gap payment of an EARLIER move is not reused', async () => {
    const other = { id: 'gpX', kind: 'move_gap', status: 'pending', registration_move_id: 'mv0', created_at: '2026-10-07T00:00:00Z' }
    const r = await createGapPayment(args({ db: fakeDb({ payments: { data: [other, ENTRY_PAY], error: null } }) }))
    expect(r.reused).toBe(false)
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'move:mv1:0' }))
  })
  it('reads the entry\'s payments by registration, newest first', async () => {
    const a = args()
    await createGapPayment(a)
    const q = a.db.queries.find((x) => x.table === 'race_payments' && x.ops.some((o) => o[0] === 'select') && !x.ops.some((o) => o[0] === 'insert'))
    expect(q.ops).toContainEqual(['eq', 'race_registration_id', 'r1'])
    expect(q.ops).toContainEqual(['order', 'created_at', { ascending: false }])
  })
})

describe('markRacePaymentStatus — a completed move_gap payment', () => {
  const GAP = { id: 'gp1', kind: 'move_gap', registration_move_id: 'mv1', status: 'pending', amount_cents: 1000, currency: 'EUR',
    race_registration_id: 'r1', race_event_id: 'e2', contact_id: 'c1', contact_email: 'aoife@x.ie', race: { location_id: 'L1' } }
  const complete = (db, payment = GAP) => markRacePaymentStatus({ db, payment, revolutState: 'completed', revolutAmount: 1000 })

  it('writes status + completed_at and answers applied with kind move_gap', async () => {
    const db = fakeDb()
    const r = await complete(db)
    expect(r.state_changed).toBe(true)
    expect(r.applied).toEqual(expect.objectContaining({ status: 'completed', completed_at: expect.any(String), kind: 'move_gap' }))
    expect(db.updates.find((u) => u.table === 'race_payments').patch).toEqual(expect.objectContaining({ status: 'completed', completed_at: expect.any(String) }))
  })
  it('settles the move: collected, by "Customer (paid online)", a compare-and-set on gap_settled_at IS NULL', async () => {
    const db = fakeDb()
    await complete(db)
    const q = db.queries.find((x) => x.table === 'registration_moves')
    expect(q.ops).toContainEqual(['update', { gap_settled_at: expect.any(String), gap_settled_how: 'collected', gap_settled_by_name: 'Customer (paid online)' }])
    expect(q.ops).toContainEqual(['eq', 'id', 'mv1'])
    expect(q.ops).toContainEqual(['is', 'gap_settled_at', null])
    expect(q.ops.some((o) => o[0] === 'select')).toBe(true)
    expect(logError).not.toHaveBeenCalled()
  })
  it('projects the order and emits ORDER_COMPLETED with kind move_gap', async () => {
    await complete(fakeDb())
    expect(syncOrderFromRacePayment).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ id: 'gp1', status: 'completed' }) }))
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent.mock.calls[0][0]).toEqual(expect.objectContaining({ eventType: EVENT_TYPES.ORDER_COMPLETED, sourceId: 'gp1', metadata: expect.objectContaining({ kind: 'move_gap' }) }))
  })
  it('does NOT touch the registration status', async () => {
    const db = fakeDb()
    await complete(db)
    expect(db.queries.some((q) => q.table === 'race_registrations')).toBe(false)
  })
  it('does NOT sync the host contact list', async () => {
    await complete(fakeDb())
    expect(addEventAttendeesToHostList).not.toHaveBeenCalled()
  })
  it('does NOT apply tag rules', async () => {
    await complete(fakeDb())
    expect(applyTagRules).not.toHaveBeenCalled()
  })
  it('does NOT trigger order_completed sequences', async () => {
    await complete(fakeDb())
    expect(triggerSequencesForOrderStatus).not.toHaveBeenCalled()
  })
  it('a move staff already settled keeps their answer, and the late payment is logged for a refund check', async () => {
    const db = fakeDb({ settle: { data: [], error: null } })
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(logError).toHaveBeenCalledWith('race-payments', expect.stringContaining('already settled'), expect.objectContaining({ moveId: 'mv1' }))
  })
  it('a failed settle write is logged, never thrown', async () => {
    const db = fakeDb({ settle: { data: null, error: { message: 'down' } } })
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(logError).toHaveBeenCalledWith('race-payments', expect.stringContaining('NOT marked collected'), expect.objectContaining({ moveId: 'mv1' }))
  })
  it('an already-completed gap payment does nothing (idempotent retry)', async () => {
    const db = fakeDb()
    const r = await complete(db, { ...GAP, status: 'completed', completed_at: '2026-10-09T10:00:00Z' })
    expect(r).toEqual({ applied: null, state_changed: false })
    expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(false)
  })
  it('an entry payment (no kind, or kind entry) still confirms the registration', async () => {
    for (const payment of [{ ...GAP, kind: undefined, registration_move_id: null }, { ...GAP, kind: 'entry', registration_move_id: null }]) {
      const db = fakeDb()
      await complete(db, payment)
      expect(db.queries.some((q) => q.table === 'race_registrations')).toBe(true)
      expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(false)
    }
  })
  it('an abandoned gap payment takes the generic path and settles nothing', async () => {
    const db = fakeDb()
    const r = await markRacePaymentStatus({ db, payment: GAP, revolutState: 'cancelled', revolutAmount: null })
    expect(r.applied.status).toBe('abandoned')
    expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(false)
    expect(db.queries.some((q) => q.table === 'race_registrations')).toBe(false)
  })
})

describe('markRacePaymentStatus — tag rules and sequences never run for a move_gap payment', () => {
  const GAP = { id: 'gp1', kind: 'move_gap', registration_move_id: 'mv1', status: 'pending', amount_cents: 1000, currency: 'EUR',
    race_registration_id: 'r1', race_event_id: 'e2', contact_id: 'c1', contact_email: 'aoife@x.ie', race: { location_id: 'L1' } }
  it.each([['failed', 'failed'], ['cancelled', 'abandoned'], ['completed', 'completed']])('provider %s → %s: order synced, no tag rules, no sequences', async (state, status) => {
    const r = await markRacePaymentStatus({ db: fakeDb(), payment: GAP, revolutState: state, revolutAmount: null })
    expect(r.applied.status).toBe(status)
    expect(syncOrderFromRacePayment).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ id: 'gp1', status }) }))
    expect(applyTagRules).not.toHaveBeenCalled()
    expect(triggerSequencesForOrderStatus).not.toHaveBeenCalled()
  })
  it('an entry payment that fails still applies tag rules and fires its sequence', async () => {
    await markRacePaymentStatus({ db: fakeDb(), payment: { ...GAP, kind: 'entry', registration_move_id: null }, revolutState: 'failed', revolutAmount: null })
    expect(applyTagRules).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1' }))
    expect(triggerSequencesForOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })
})

describe('refreshRacePaymentFromProvider — a move_gap payment completed by the refresh sends its receipt', () => {
  const GAP = { id: 'gp1', kind: 'move_gap', registration_move_id: 'mv1', status: 'pending', amount_cents: 1000, currency: 'EUR',
    payment_provider: 'revolut', payment_provider_ref: 'ord-1', race_registration_id: 'r1', contact_id: 'c1', contact_email: 'aoife@x.ie' }
  it('a fresh completion sends sendGapPaidEmail', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const db = fakeDb()
    await refreshRacePaymentFromProvider(db, GAP)
    expect(sendGapPaidEmail).toHaveBeenCalledTimes(1)
    expect(sendGapPaidEmail).toHaveBeenCalledWith({ db, paymentId: 'gp1' })
    expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(true)
  })
  it('still pending: no receipt', async () => {
    getPayment.mockResolvedValue({ state: 'pending', amountCents: 1000 })
    await refreshRacePaymentFromProvider(fakeDb(), GAP)
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('already completed (the webhook won): no second receipt from here', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    await refreshRacePaymentFromProvider(fakeDb(), { ...GAP, status: 'completed', completed_at: '2026-10-09T10:00:00Z' })
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('an entry payment completed by the refresh sends nothing here (unchanged)', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    await refreshRacePaymentFromProvider(fakeDb(), { ...GAP, kind: 'entry', registration_move_id: null })
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('a thrown receipt is logged and the refresh still answers the row', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    sendGapPaidEmail.mockRejectedValueOnce(new Error('postmark down'))
    const out = await refreshRacePaymentFromProvider(fakeDb(), GAP)
    expect(out).toBeTruthy()
    expect(logError).toHaveBeenCalledWith('race-payments', expect.stringContaining('gap receipt'), expect.objectContaining({ paymentId: 'gp1' }))
  })
})

