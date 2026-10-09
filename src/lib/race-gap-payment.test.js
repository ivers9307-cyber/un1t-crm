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
// EVENT-MOVE.6 — a customer's dearer move lands when its difference is paid.
vi.mock('./registration-move', () => ({ moveRegistration: vi.fn() }))
vi.mock('./error-events', () => ({ recordErrorEvent: vi.fn(async () => {}) }))

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
const { moveRegistration } = await import('./registration-move')
const { recordErrorEvent } = await import('./error-events')

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

function fakeDb({ payments = { data: [ENTRY_PAY], error: null }, insert = { error: null }, settle = { data: [{ id: 'mv1' }], error: null },
  statusWrite = { data: [{ id: 'gp1' }], error: null }, winner = { data: null, error: null }, row = { data: null, error: null } } = {}) {
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
        const has = (col) => q.ops.some((o) => o[0] === 'eq' && o[1] === col)
        if (table === 'race_payments' && q.ops.some((o) => o[0] === 'update')) return statusWrite
        if (table === 'race_payments' && has('registration_move_id')) return winner
        if (table === 'race_payments' && has('id')) return Array.isArray(row) ? (row.length > 1 ? row.shift() : row[0]) : row
        if (table === 'race_payments') return payments
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
  const pending = { id: 'gp0', kind: 'move_gap', status: 'pending', registration_move_id: 'mv1', amount_cents: 1000, contact_email: 'aoife@x.ie',
    payment_provider: 'revolut', payment_provider_ref: 'ord-0', created_at: '2026-10-08T00:00:00Z' }
  it('returns the pending move_gap payment for this move (still pending at the provider) instead of minting another', async () => {
    getPayment.mockResolvedValue({ state: 'pending', amountCents: 1000 })
    const a = args({ db: fakeDb({ payments: { data: [pending, ENTRY_PAY], error: null }, row: { data: pending, error: null } }) })
    const r = await createGapPayment(a)
    expect(r).toEqual({ ok: true, payment: pending, checkoutUrl: 'https://crm.test/event-pay/gp0', reused: true })
    expect(getPayment).toHaveBeenCalledWith('ord-0', expect.anything())
    expect(createPayment).not.toHaveBeenCalled()
    expect(a.db.inserts).toEqual([])
    expect(emitEvent).not.toHaveBeenCalled()
  })
  it('an EXPIRED pending link (the provider says cancelled) is marked abandoned and a new one is minted', async () => {
    getPayment.mockResolvedValue({ state: 'cancelled', amountCents: null })
    const abandoned = { ...pending, status: 'abandoned' }
    const a = args({ db: fakeDb({ payments: { data: [pending, ENTRY_PAY], error: null }, row: [{ data: pending, error: null }, { data: abandoned, error: null }] }) })
    const r = await createGapPayment(a)
    expect(r.ok).toBe(true)
    expect(r.reused).toBe(false)
    expect(a.db.updates.find((u) => u.table === 'race_payments').patch).toEqual(expect.objectContaining({ status: 'abandoned' }))
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'move:mv1:1' }))
  })
  it('a pending link the customer actually PAID answers already_settled and mints nothing', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const paid = { ...pending, status: 'completed' }
    const a = args({ db: fakeDb({ payments: { data: [pending, ENTRY_PAY], error: null }, row: [{ data: pending, error: null }, { data: paid, error: null }] }) })
    expect(await createGapPayment(a)).toEqual({ ok: false, error: 'already_settled' })
    expect(createPayment).not.toHaveBeenCalled()
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
    expect(logError).toHaveBeenCalledWith('race-gap-payment', expect.stringContaining('already settled'), expect.objectContaining({ moveId: 'mv1' }))
  })
  it('a failed settle write is logged, never thrown', async () => {
    const db = fakeDb({ settle: { data: null, error: { message: 'down' } } })
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(logError).toHaveBeenCalledWith('race-gap-payment', expect.stringContaining('NOT marked collected'), expect.objectContaining({ moveId: 'mv1' }))
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
    payment_provider: 'revolut', payment_provider_ref: 'ord-1', race_registration_id: 'r1', race_event_id: 'e2', contact_id: 'c1', contact_email: 'aoife@x.ie',
    contact_name: 'Aoife Byrne', race: { location_id: 'L1' } }
  const dbWith = (row = GAP) => fakeDb({ row: { data: row, error: null } })
  it('a fresh completion sends sendGapPaidEmail', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const db = dbWith()
    await refreshRacePaymentFromProvider(db, GAP)
    expect(sendGapPaidEmail).toHaveBeenCalledTimes(1)
    expect(sendGapPaidEmail).toHaveBeenCalledWith({ db, paymentId: 'gp1' })
    expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(true)
  })
  it('still pending: no receipt', async () => {
    getPayment.mockResolvedValue({ state: 'pending', amountCents: 1000 })
    await refreshRacePaymentFromProvider(dbWith(), GAP)
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('already completed (the webhook won): no second receipt from here', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const done = { ...GAP, status: 'completed', completed_at: '2026-10-09T10:00:00Z' }
    await refreshRacePaymentFromProvider(dbWith(done), done)
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('lost the status CAS to the webhook: no receipt from here', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    await refreshRacePaymentFromProvider(fakeDb({ row: { data: GAP, error: null }, statusWrite: { data: [], error: null } }), GAP)
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('an entry payment completed by the refresh sends nothing here (unchanged)', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const entry = { ...GAP, kind: 'entry', registration_move_id: null }
    await refreshRacePaymentFromProvider(dbWith(entry), entry)
    expect(sendGapPaidEmail).not.toHaveBeenCalled()
  })
  it('a thrown receipt is logged and the refresh still answers the row', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    sendGapPaidEmail.mockRejectedValueOnce(new Error('postmark down'))
    const out = await refreshRacePaymentFromProvider(dbWith(), GAP)
    expect(out).toBeTruthy()
    expect(logError).toHaveBeenCalledWith('race-payments', expect.stringContaining('gap receipt'), expect.objectContaining({ paymentId: 'gp1' }))
  })
})

describe('refreshRacePaymentFromProvider — reads the full row before applying (EVENT-MOVE.5)', () => {
  // The public GET's select: no contact fields, an embedded race without location_id.
  const PARTIAL = { id: 'gp1', status: 'pending', amount_cents: 1000, currency: 'EUR', kind: 'move_gap', payment_provider: 'revolut',
    payment_provider_ref: 'ord-1', race: { id: 'e2', name: 'Hatch Oct 25', slug: 'hatch-oct25-1100' } }
  const FULL = { ...PARTIAL, registration_move_id: 'mv1', race_registration_id: 'r1', race_event_id: 'e2', contact_id: 'c1',
    contact_email: 'aoife@x.ie', contact_name: 'Aoife Byrne', contact_phone: '+3531', race: { location_id: 'L1' } }

  it('re-reads the payment by id with * and the race studio, and the order sync gets the contact fields', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const db = fakeDb({ row: { data: FULL, error: null } })
    await refreshRacePaymentFromProvider(db, PARTIAL)
    const read = db.queries.find((q) => q.table === 'race_payments' && q.ops.some((o) => o[0] === 'maybeSingle' || o[0] === 'select'))
    expect(read.ops).toContainEqual(['eq', 'id', 'gp1'])
    expect(read.ops.find((o) => o[0] === 'select')[1].replace(/\s+/g, ' ')).toBe('*, race:race_event_id ( location_id )')
    expect(syncOrderFromRacePayment).toHaveBeenCalledWith(expect.objectContaining({
      payment: expect.objectContaining({ id: 'gp1', status: 'completed', contact_email: 'aoife@x.ie', contact_id: 'c1', contact_name: 'Aoife Byrne' }),
    }))
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'L1', contactEmail: 'aoife@x.ie' }))
  })
  it('an unreadable row applies nothing, is logged, and answers the input', async () => {
    getPayment.mockResolvedValue({ state: 'completed', amountCents: 1000 })
    const db = fakeDb({ row: { data: null, error: { message: 'down' } } })
    const out = await refreshRacePaymentFromProvider(db, PARTIAL)
    expect(out).toBe(PARTIAL)
    expect(db.updates).toEqual([])
    expect(getPayment).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('race-payments', expect.stringContaining('refresh'), expect.objectContaining({ paymentId: 'gp1' }))
  })
})

describe('createGapPayment — two clicks at once (the unique pending index)', () => {
  it('a 23505 on insert hands back the winner as reused', async () => {
    const winnerRow = { id: 'gpW', kind: 'move_gap', status: 'pending', registration_move_id: 'mv1', amount_cents: 1000 }
    const db = fakeDb({ insert: { error: { code: '23505', message: 'duplicate key' } }, winner: { data: winnerRow, error: null } })
    const r = await createGapPayment(args({ db }))
    expect(r).toEqual({ ok: true, payment: winnerRow, checkoutUrl: 'https://crm.test/event-pay/gpW', reused: true })
    const q = db.queries.find((x) => x.table === 'race_payments' && x.ops.some((o) => o[0] === 'eq' && o[1] === 'registration_move_id'))
    expect(q.ops).toContainEqual(['eq', 'kind', 'move_gap'])
    expect(q.ops).toContainEqual(['eq', 'status', 'pending'])
    expect(emitEvent).not.toHaveBeenCalled()
  })
  it('a 23505 whose winner cannot be read is write_failed', async () => {
    const db = fakeDb({ insert: { error: { code: '23505', message: 'duplicate key' } }, winner: { data: null, error: { message: 'down' } } })
    expect(await createGapPayment(args({ db }))).toEqual({ ok: false, error: 'write_failed' })
  })
})

// ─── EVENT-MOVE.6 — a customer's own move to a dearer date ───────────────
// The difference is paid FIRST: the payment carries metadata.pending_move
// and no move yet; completing it runs the move, links the payment to the new
// move row and settles it collected. A move refused after the money landed
// leaves the payment completed and is loud.

const PM = { target_event_id: 'e2', target_wave_id: 'w9', expected_source_event_id: 'e1', actor: { type: 'customer', id: 'c1', name: 'Aoife Byrne' } }
const SRC_RACE = { ...RACE, id: 'e1', name: 'Hatch Oct 18', slug: 'hatch-oct18-1100' }
const SRC_REG = { ...REG, race_event_id: 'e1' }
const pmArgs = (over = {}) => ({
  db: fakeDb(), registration: SRC_REG, race: SRC_RACE, pendingMove: PM, amountCents: 1000,
  returnUrl: 'https://crm.test/event/entry/TOKEN', cancelUrl: 'https://crm.test/event/entry/TOKEN', ...over,
})

describe('createGapPayment — a pending move (customer, EVENT-MOVE.6)', () => {
  it('refuses when the entry is no longer on the event the move was judged from, or there is no positive difference', async () => {
    expect(await createGapPayment(pmArgs({ pendingMove: { ...PM, expected_source_event_id: 'e9' } }))).toEqual({ ok: false, error: 'not_current_move' })
    expect(await createGapPayment(pmArgs({ amountCents: 0 }))).toEqual({ ok: false, error: 'no_gap' })
    expect(await createGapPayment(pmArgs({ amountCents: -500 }))).toEqual({ ok: false, error: 'no_gap' })
    expect(createPayment).not.toHaveBeenCalled()
  })
  it('mints a move_gap row with NO move yet and the pending move in metadata, on the entry\'s current event', async () => {
    const a = pmArgs()
    const r = await createGapPayment(a)
    expect(r).toMatchObject({ ok: true, reused: false, checkoutUrl: 'https://crm.test/event-pay/gp1' })
    const row = a.db.inserts.find((i) => i.table === 'race_payments').row
    expect(row).toEqual(expect.objectContaining({
      kind: 'move_gap', registration_move_id: null, race_event_id: 'e1', race_registration_id: 'r1', amount_cents: 1000, status: 'pending',
      metadata: { pending_move: PM },
    }))
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: 1000, applicationFeeCents: 0, idempotencyKey: 'pending-move:r1:0',
      returnUrl: 'https://crm.test/event/entry/TOKEN',
      metadata: { race_event_id: 'e1', race_registration_id: 'r1', pending_move_target_event_id: 'e2', domain: 'un1t_race_gap' },
    }))
  })
  it('stores only the four pending-move fields, whatever else the caller passed', async () => {
    const a = pmArgs({ pendingMove: { ...PM, force: true, price_gap_cents: 1 } })
    await createGapPayment(a)
    expect(a.db.inserts[0].row.metadata).toEqual({ pending_move: PM })
  })
  it('reuses a pending link for the same date, time and amount', async () => {
    getPayment.mockResolvedValue({ state: 'pending', amountCents: 1000 })
    const live = { id: 'gp0', kind: 'move_gap', status: 'pending', registration_move_id: null, amount_cents: 1000, metadata: { pending_move: PM },
      payment_provider: 'revolut', payment_provider_ref: 'ord-0', created_at: '2026-10-09T00:00:00Z' }
    const a = pmArgs({ db: fakeDb({ payments: { data: [live, ENTRY_PAY], error: null }, row: { data: live, error: null } }) })
    expect(await createGapPayment(a)).toEqual({ ok: true, payment: live, checkoutUrl: 'https://crm.test/event-pay/gp0', reused: true })
    expect(createPayment).not.toHaveBeenCalled()
  })
  it('closes a pending link for ANOTHER time (so two changes cannot both be paid) and mints a fresh key', async () => {
    const stale = { id: 'gp0', kind: 'move_gap', status: 'pending', registration_move_id: null, amount_cents: 1000,
      metadata: { pending_move: { ...PM, target_wave_id: 'w8' } }, created_at: '2026-10-09T00:00:00Z' }
    const a = pmArgs({ db: fakeDb({ payments: { data: [stale, ENTRY_PAY], error: null } }) })
    const r = await createGapPayment(a)
    expect(r.reused).toBe(false)
    const close = a.db.queries.find((q) => q.table === 'race_payments' && q.ops.some((o) => o[0] === 'update'))
    expect(close.ops).toContainEqual(['update', expect.objectContaining({ status: 'abandoned', abandoned_at: expect.any(String) })])
    expect(close.ops).toContainEqual(['in', 'id', ['gp0']])
    expect(close.ops).toContainEqual(['eq', 'status', 'pending'])
    expect(createPayment).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'pending-move:r1:1' }))
  })
  it('never reuses a staff move\'s gap link for a customer move', async () => {
    const staffLink = { id: 'gpS', kind: 'move_gap', status: 'pending', registration_move_id: 'mv0', amount_cents: 1000, created_at: '2026-10-09T00:00:00Z' }
    const a = pmArgs({ db: fakeDb({ payments: { data: [staffLink, ENTRY_PAY], error: null } }) })
    const r = await createGapPayment(a)
    expect(r.reused).toBe(false)
    expect(a.db.updates).toEqual([])
  })
})

describe('markRacePaymentStatus — a paid pending move lands the move', () => {
  const GAP_PM = { id: 'gp1', kind: 'move_gap', registration_move_id: null, status: 'pending', amount_cents: 1000, currency: 'EUR',
    race_registration_id: 'r1', race_event_id: 'e1', contact_id: 'c1', contact_email: 'aoife@x.ie', race: { location_id: 'L1' },
    metadata: { pending_move: PM, note: 'kept' } }
  const complete = (db, payment = GAP_PM) => markRacePaymentStatus({ db, payment, revolutState: 'completed', revolutAmount: 1000 })

  it('runs the move as the customer (notify, no force, from the judged event), links the payment to it and settles it collected', async () => {
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mvNew' }, registration: { id: 'r1' }, notified: true })
    const db = fakeDb()
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(moveRegistration).toHaveBeenCalledWith(db, {
      registrationId: 'r1', targetEventId: 'e2', targetWaveId: 'w9', actor: PM.actor,
      notify: true, force: false, expectedSourceEventId: 'e1',
    })
    const link = db.queries.find((q) => q.table === 'race_payments' && q.ops.some((o) => o[0] === 'update' && o[1].registration_move_id))
    expect(link.ops).toContainEqual(['update', { registration_move_id: 'mvNew' }])
    expect(link.ops).toContainEqual(['eq', 'id', 'gp1'])
    const settle = db.queries.find((q) => q.table === 'registration_moves')
    expect(settle.ops).toContainEqual(['eq', 'id', 'mvNew'])
    expect(settle.ops).toContainEqual(['update', expect.objectContaining({ gap_settled_how: 'collected', gap_settled_by_name: 'Customer (paid online)' })])
    expect(recordErrorEvent).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })
  it('a move refused after payment (the time filled): payment stays completed, failure recorded in metadata, logged and paged', async () => {
    moveRegistration.mockResolvedValue({ ok: false, error: 'wave_full', spots_left: 0 })
    const db = fakeDb()
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(r.pending_move_failed).toBe('wave_full')
    const patches = db.updates.filter((u) => u.table === 'race_payments').map((u) => u.patch)
    expect(patches.some((p) => p.status && p.status !== 'completed')).toBe(false)
    expect(patches).toContainEqual({ metadata: { pending_move: PM, note: 'kept', pending_move_failed: { error: 'wave_full', at: expect.any(String) } } })
    expect(db.queries.some((q) => q.table === 'registration_moves')).toBe(false)
    expect(logError).toHaveBeenCalledWith('race-gap-payment', expect.stringContaining('refused'), expect.objectContaining({ paymentId: 'gp1', error: 'wave_full' }))
    expect(recordErrorEvent).toHaveBeenCalledWith(expect.objectContaining({ route_type: 'move_gap', name: 'pending_move_failed' }))
    expect(recordErrorEvent.mock.calls[0][0].message).toContain('gp1')
  })
  it('a move that throws is a failure too, never an unhandled error', async () => {
    moveRegistration.mockRejectedValue(new Error('db down'))
    const db = fakeDb()
    const r = await complete(db)
    expect(r.applied.status).toBe('completed')
    expect(r.pending_move_failed).toBe('move_threw')
    expect(recordErrorEvent).toHaveBeenCalled()
  })
  it('a payment already linked to its move never runs the move again', async () => {
    const db = fakeDb()
    await complete(db, { ...GAP_PM, registration_move_id: 'mv1' })
    expect(moveRegistration).not.toHaveBeenCalled()
    expect(db.queries.find((q) => q.table === 'registration_moves').ops).toContainEqual(['eq', 'id', 'mv1'])
  })
  it('a lost link write is logged loudly and the move is still settled', async () => {
    moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mvNew' }, registration: { id: 'r1' }, notified: true })
    let n = 0
    const db = fakeDb()
    const orig = db.from.bind(db)
    db.from = (table) => {
      const b = orig(table)
      if (table !== 'race_payments') return b
      const update = b.update
      b.update = (patch) => {
        const r = update(patch)
        if (patch.registration_move_id) { n++; r.then = (res, rej) => Promise.resolve({ data: null, error: { message: 'down' } }).then(res, rej) }
        return r
      }
      return b
    }
    await complete(db)
    expect(n).toBe(1)
    expect(logError).toHaveBeenCalledWith('race-gap-payment', expect.stringContaining('NOT linked'), expect.objectContaining({ moveId: 'mvNew' }))
    expect(db.queries.find((q) => q.table === 'registration_moves').ops).toContainEqual(['eq', 'id', 'mvNew'])
  })
})
