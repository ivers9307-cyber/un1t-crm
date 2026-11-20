// RAFFLE.1 — the till, the draw and the void. The gate itself is tested in
// src/lib/raffle-access.test.js; here it is stubbed so each route's own rules
// are what the tests exercise.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const EVENT = 'e0000000-0000-4000-8000-0000000000e1'
const SALE_ID = 'a0000000-0000-4000-8000-0000000000a1'
const CONTACT = 'c0000000-0000-4000-8000-0000000000c1'
const REQ = 'b0000000-0000-4000-8000-0000000000b1'
const RACE = { id: EVENT, name: 'Charity Day', location_id: 'L1' }
const RAFFLE = { id: 'r1', name: 'Raffle', sales_open: true, currency: 'EUR', ticket_price_cents: 500 }

let gate
let raffle
let sales
let tickets
let draws
let db
const sendRaffleTicketsEmail = vi.fn(async () => ({ status: 'sent' }))

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'u1' })), userAtLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/raffle-email', () => ({ sendRaffleTicketsEmail: (...a) => sendRaffleTicketsEmail(...a) }))
vi.mock('@/lib/raffle', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveStaffRaffleEvent: vi.fn(async (_u, _id, opts = {}) => {
    if (gate === 'notfound') return { response: new Response('{}', { status: 404 }) }
    if (opts.manager && gate !== 'manager') return { response: new Response('{}', { status: 403 }) }
    return { db, race: RACE, isManager: gate === 'manager' }
  }),
  loadRaffle: vi.fn(async () => ({ data: raffle, error: null })),
  listSales: vi.fn(async () => ({ rows: sales })),
  listTickets: vi.fn(async () => ({ rows: tickets })),
  listDraws: vi.fn(async () => ({ rows: draws })),
}))

// A chainable stand-in: every filter returns the builder; the result for a
// (table, op) comes from `answers`. Every call is recorded.
function makeDb(answers = {}) {
  const calls = []
  const d = {
    calls,
    rpcCalls: [],
    rpc: vi.fn(async (name, args) => { d.rpcCalls.push({ name, args }); return answers.rpc ? answers.rpc(args) : { data: null, error: null } }),
    from(table) {
      const call = { table, op: 'select', filters: [], payload: null }
      calls.push(call)
      const done = () => {
        const a = answers[`${table}.${call.op}`]
        return typeof a === 'function' ? a(call) : (a || { data: null, error: null })
      }
      const b = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (ok, ko) => Promise.resolve(done()).then(ok, ko)
          if (prop === 'insert' || prop === 'update') return (payload) => { call.op = prop; call.payload = payload; return b }
          return (...args) => { call.filters.push([prop, ...args]); return b }
        },
      })
      return b
    },
  }
  return d
}

const req = (body) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const params = (extra = {}) => ({ params: Promise.resolve({ id: EVENT, ...extra }) })

const { POST: SELL } = await import('./sales/route.js')
const { POST: DRAW } = await import('./draws/route.js')
const { POST: VOID } = await import('./sales/[saleId]/void/route.js')

beforeEach(() => {
  gate = 'staff'
  raffle = { ...RAFFLE }
  sales = []
  tickets = []
  draws = []
  sendRaffleTicketsEmail.mockClear()
})

const GUEST = { request_id: REQ, buyer_name: 'Sarah Byrne', buyer_email: 'Sarah@Example.test', quantity: 3, payment_method: 'cash' }

describe('POST sales', () => {
  it('sells to a guest without touching contacts, then emails', async () => {
    db = makeDb({ rpc: (a) => ({ data: { id: 's1', email_status: null, first_ticket: 1, last_ticket: 3, ...a }, error: null }) })
    const res = await SELL(req(GUEST), params())
    expect(res.status).toBe(200)
    expect(db.rpcCalls[0].name).toBe('sell_raffle_tickets')
    expect(db.rpcCalls[0].args).toMatchObject({ p_contact_id: null, p_quantity: 3, p_payment_method: 'cash', p_buyer_email: 'sarah@example.test', p_sold_by: 'u1' })
    expect(db.calls.some((c) => c.table === 'contacts')).toBe(false)
    expect(sendRaffleTicketsEmail).toHaveBeenCalledTimes(1)
  })

  it('a contact from another studio is a 404 and nothing is sold', async () => {
    db = makeDb({ 'studio_contacts.select': { data: null, error: null } })
    const res = await SELL(req({ ...GUEST, contact_id: CONTACT }), params())
    expect(res.status).toBe(404)
    expect(db.rpcCalls).toHaveLength(0)
  })

  it('a contact at the studio is linked by id only', async () => {
    db = makeDb({
      'studio_contacts.select': (call) => {
        expect(call.filters).toContainEqual(['eq', 'studio_location_id', 'L1'])
        return { data: { id: CONTACT }, error: null }
      },
      rpc: (a) => ({ data: { id: 's1', email_status: null, ...a }, error: null }),
    })
    const res = await SELL(req({ ...GUEST, contact_id: CONTACT }), params())
    expect(res.status).toBe(200)
    expect(db.rpcCalls[0].args.p_contact_id).toBe(CONTACT)
    expect(db.calls.some((c) => c.op === 'update' || c.op === 'insert')).toBe(false)
  })

  it('closed sales are a 409', async () => {
    raffle = { ...RAFFLE, sales_open: false }
    db = makeDb()
    expect((await SELL(req(GUEST), params())).status).toBe(409)
  })

  it('a replayed request whose email already went does not email again', async () => {
    db = makeDb({ rpc: () => ({ data: { id: 's1', email_status: 'sent' }, error: null }) })
    const res = await SELL(req(GUEST), params())
    expect(res.status).toBe(200)
    expect(sendRaffleTicketsEmail).not.toHaveBeenCalled()
  })

  it('rejects a zero quantity and an unknown payment method', async () => {
    db = makeDb()
    expect((await SELL(req({ ...GUEST, quantity: 0 }), params())).status).toBe(400)
    expect((await SELL(req({ ...GUEST, payment_method: 'voucher' }), params())).status).toBe(400)
  })
})

describe('POST draws', () => {
  it('never draws a voided or already-drawn ticket', async () => {
    sales = [{ id: 'sA', voided_at: null, buyer_name: 'Ann Kelly' }, { id: 'sB', voided_at: '2026-11-21T10:00:00Z', buyer_name: 'Bo' }]
    tickets = [
      { id: 't1', ticket_number: 1, sale_id: 'sA' },
      { id: 't2', ticket_number: 2, sale_id: 'sA' },
      { id: 't3', ticket_number: 3, sale_id: 'sB' },
    ]
    draws = [{ id: 'd0', ticket_id: 't1' }]
    db = makeDb({ 'raffle_draws.insert': (call) => ({ data: { id: 'd1', ...call.payload }, error: null }) })
    const res = await DRAW(req({ prize_name: 'Hamper' }), params())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.draw.ticket_id).toBe('t2')
    expect(body.data.draw.ticket_number).toBe(2)
    expect(body.data.draw.winner_display).toBe('Ann K.')
    expect(body.data.remaining).toBe(0)
  })

  it('answers 409 when every ticket is drawn or voided', async () => {
    sales = [{ id: 'sA', voided_at: null }]
    tickets = [{ id: 't1', ticket_number: 1, sale_id: 'sA' }]
    draws = [{ id: 'd0', ticket_id: 't1' }]
    db = makeDb()
    const res = await DRAW(req({ prize_name: 'Hamper' }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('No tickets left to draw.')
  })

  it('another studio is a 404', async () => {
    gate = 'notfound'
    db = makeDb()
    expect((await DRAW(req({ prize_name: 'Hamper' }), params())).status).toBe(404)
  })
})

describe('POST void', () => {
  const SALE = { id: SALE_ID, raffle_id: 'r1', voided_at: null }

  it('only managers may void', async () => {
    db = makeDb()
    expect((await VOID(req({ reason: 'typo' }), params({ saleId: SALE_ID }))).status).toBe(403)
  })

  it('a sale with a drawn ticket cannot be voided', async () => {
    gate = 'manager'
    db = makeDb({
      'raffle_sales.select': { data: SALE, error: null },
      'raffle_tickets.select': { data: [{ id: 't1' }], error: null },
      'raffle_draws.select': { data: [{ id: 'd1' }], error: null },
    })
    const res = await VOID(req({ reason: 'typo' }), params({ saleId: SALE_ID }))
    expect(res.status).toBe(409)
    expect(db.calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('voids an undrawn sale, scoped to the event studio', async () => {
    gate = 'manager'
    db = makeDb({
      'raffle_sales.select': { data: SALE, error: null },
      'raffle_tickets.select': { data: [{ id: 't1' }], error: null },
      'raffle_draws.select': { data: [], error: null },
      'raffle_sales.update': (call) => ({ data: [{ ...SALE, ...call.payload }], error: null }),
    })
    const res = await VOID(req({ reason: 'typo' }), params({ saleId: SALE_ID }))
    expect(res.status).toBe(200)
    const upd = db.calls.find((c) => c.op === 'update')
    expect(upd.payload).toMatchObject({ voided_by: 'u1', void_reason: 'typo' })
    expect(upd.filters).toContainEqual(['eq', 'location_id', 'L1'])
  })
})
