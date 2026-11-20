// RAFFLE.3 — online raffle orders: when sales are open, the public block,
// the compare-and-set mark, and the paid effects (tickets once, email once,
// never a contact).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendRaffleTicketsEmail = vi.fn(async () => ({ status: 'sent' }))
vi.mock('@/lib/raffle-email', () => ({ sendRaffleTicketsEmail: (...a) => sendRaffleTicketsEmail(...a) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T' })) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => null }))

const { onlineSalesState, publicRaffleBlock, markRaffleOrderPaymentStatus, runPaidRaffleOrderEffects, raffleOrderDescription } = await import('./raffle-online.js')

const NOW = Date.parse('2026-11-21T10:00:00Z')
const RAFFLE = {
  id: 'r1', name: 'Charity Raffle', currency: 'EUR', ticket_price_cents: 500, sales_open: true,
  ticket_options: [{ tickets: 3, price_cents: 1000 }, { tickets: 100, price_cents: 15000 }],
  online_enabled: true, online_closes_at: '2026-11-23T13:30:00Z',
}

// A chainable stand-in that records calls and answers per (table, op).
function makeDb(answers = {}) {
  const calls = []
  const db = {
    calls,
    rpc: vi.fn(async (name, args) => { calls.push({ rpc: name, args }); return answers.rpc ? answers.rpc(name, args) : { data: null, error: null } }),
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
          if (prop === 'update' || prop === 'insert') return (payload) => { call.op = prop; call.payload = payload; return b }
          return (...args) => { call.filters.push([prop, ...args]); return b }
        },
      })
      return b
    },
  }
  return db
}

describe('onlineSalesState and the public block', () => {
  it('is open before the closing time and closed after it', () => {
    expect(onlineSalesState(RAFFLE, NOW)).toEqual({ open: true, reason: null })
    expect(onlineSalesState(RAFFLE, Date.parse('2026-11-23T13:30:00Z'))).toEqual({ open: false, reason: 'closed' })
  })
  it('is off when switched off or when the raffle is closed', () => {
    expect(onlineSalesState({ ...RAFFLE, online_enabled: false }, NOW).reason).toBe('off')
    expect(onlineSalesState({ ...RAFFLE, sales_open: false }, NOW).reason).toBe('off')
  })
  it('the block shows prices and the Dublin closing time, and hides options over 50', () => {
    const b = publicRaffleBlock(RAFFLE, 'Europe/Dublin', NOW)
    expect(b).toMatchObject({ name: 'Charity Raffle', open: true, ticket_price_cents: 500, max_tickets: 50 })
    expect(b.ticket_options).toEqual([{ tickets: 3, price_cents: 1000 }])
    expect(b.closes_label).toMatch(/^Monday, 23 November at 1:30\s?pm$/i)
    expect(JSON.stringify(b)).not.toMatch(/buyer|email|sale/)
    expect(publicRaffleBlock({ ...RAFFLE, online_enabled: false }, 'Europe/Dublin', NOW)).toBeNull()
  })
  it('names the payment on the statement', () => {
    expect(raffleOrderDescription('UN1T Stillorgan', 3)).toBe('UN1T Stillorgan: Raffle tickets (3)')
    expect(raffleOrderDescription('', 1)).toBe('Raffle ticket (1)')
  })
})

describe('markRaffleOrderPaymentStatus', () => {
  const order = { id: 'o1', status: 'awaiting_payment', amount_cents: 1000 }
  it('marks a completed order paid, compare-and-set on its status', async () => {
    const db = makeDb({ 'raffle_orders.update': { data: [{ id: 'o1' }], error: null } })
    const r = await markRaffleOrderPaymentStatus({ db, order, providerState: 'COMPLETED', now: () => 'NOW' })
    expect(r).toEqual({ status: 'paid', changed: true })
    const upd = db.calls.find((c) => c.op === 'update')
    expect(upd.payload).toEqual({ status: 'paid', paid_at: 'NOW' })
    expect(upd.filters).toContainEqual(['eq', 'status', 'awaiting_payment'])
  })
  it('never moves a paid order', async () => {
    const db = makeDb()
    expect(await markRaffleOrderPaymentStatus({ db, order: { ...order, status: 'paid' }, providerState: 'failed' })).toEqual({ status: 'paid', changed: false })
    expect(db.calls).toHaveLength(0)
  })
  it('a cancelled payment is expired; a lost race reports the winner', async () => {
    const db = makeDb({ 'raffle_orders.update': { data: [], error: null }, 'raffle_orders.select': { data: { status: 'paid' }, error: null } })
    expect(await markRaffleOrderPaymentStatus({ db, order, providerState: 'cancelled' })).toEqual({ status: 'paid', changed: false })
  })
})

describe('runPaidRaffleOrderEffects', () => {
  const PAID = { id: 'o1', status: 'paid', raffle_id: 'r1', race_event_id: 'e1' }
  const SALE = { id: 's1', first_ticket: 12, last_ticket: 14 }
  beforeEach(() => sendRaffleTicketsEmail.mockClear())

  it('issues the tickets, wins the email claim and sends once; never touches contacts', async () => {
    const db = makeDb({
      rpc: () => ({ data: SALE, error: null }),
      'raffle_orders.update': { data: [{ id: 'o1' }], error: null },
      'raffles.select': { data: RAFFLE, error: null },
      'race_events.select': { data: { id: 'e1', name: 'Charity Day' }, error: null },
    })
    const r = await runPaidRaffleOrderEffects({ db, order: PAID })
    expect(r).toMatchObject({ tickets: 'issued', email: 'sent', sale: SALE })
    expect(db.calls[0]).toEqual({ rpc: 'issue_raffle_order_tickets', args: { p_order_id: 'o1' } })
    const claim = db.calls.find((c) => c.op === 'update')
    expect(claim.filters).toContainEqual(['is', 'email_claimed_at', null])
    expect(sendRaffleTicketsEmail).toHaveBeenCalledTimes(1)
    expect(db.calls.some((c) => ['contacts', 'contact_tags', 'notes', 'consent_log'].includes(c.table))).toBe(false)
  })
  it('a second observer that loses the claim sends nothing', async () => {
    const db = makeDb({ rpc: () => ({ data: SALE, error: null }), 'raffle_orders.update': { data: [], error: null } })
    const r = await runPaidRaffleOrderEffects({ db, order: PAID })
    expect(r.email).toBe('already_claimed')
    expect(sendRaffleTicketsEmail).not.toHaveBeenCalled()
  })
  it('a ticket failure stops before the email, for a retry', async () => {
    const db = makeDb({ rpc: () => ({ data: null, error: { message: 'boom' } }) })
    const r = await runPaidRaffleOrderEffects({ db, order: PAID })
    expect(r.tickets).toBe('failed')
    expect(sendRaffleTicketsEmail).not.toHaveBeenCalled()
  })
  it('does nothing for an unpaid order', async () => {
    const db = makeDb()
    expect((await runPaidRaffleOrderEffects({ db, order: { ...PAID, status: 'awaiting_payment' } })).tickets).toBe('skipped')
    expect(db.calls).toHaveLength(0)
  })
})
