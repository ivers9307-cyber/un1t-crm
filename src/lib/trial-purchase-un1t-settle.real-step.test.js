// Final review F2 follow-up — the settle sweep with the REAL set-password step
// (runSetPasswordStep), so the wiring the unit test mocks away is exercised:
// the step takes its sender only from deps, and without it the trial buyer's
// explanation email silently never goes. The un1t.online reset op, the email
// module and the ledger reads are stubbed; nothing leaves the process.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(), forgot: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ sendWebsiteConversion: vi.fn(async () => ({ sent: true })) }))
vi.mock('@/lib/un1t-online-settings', async (orig) => ({ ...(await orig()), readUn1tWriteSettings: vi.fn(async () => ({ settings: { writesEnabled: true, sendsWelcome: false, welcomeSetsLogin: false } })) }))
vi.mock('@/lib/trial-studios', () => ({ readPaidTrialAccountEmailCopy: vi.fn(async () => ({ subject: 'S {product_name}', body: 'B {product_name}' })) }))
vi.mock('@/lib/un1t-online-funnel-emails', () => ({ sendUn1tAccountEmail: mocks.send }))
vi.mock('@/lib/un1t-online-write-ops', async (orig) => ({ ...(await orig()), forgotPassword: mocks.forgot }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { settleUn1tTrialPurchases } from './trial-purchase-un1t-settle'

const T0 = Date.parse('2026-10-24T10:00:00.000Z')
const ROW = {
  id: 'tp1', location_id: 'loc2', contact_id: 'c1', created_at: new Date(T0).toISOString(), un1t_user_id: 'u1', un1t_product_id: 'prodP',
  product_name: 'The UN1T Trial', amount_cents: 3900, currency: 'EUR', customer_email: 'ava@example.com', customer_phone: '+353851234567',
  first_name: 'Ava', last_name: 'Byrne', attribution: {},
}
const TX = { un1t_id: 'tx1', product_id: 'prodP', type: 'purchase', amount_cents: 3900, remote_created_at: new Date(T0 + 60_000).toISOString() }
const CONTACT = { id: 'c1', email: 'ava@example.com', first_name: 'Ava', last_name: 'Byrne', name: 'Ava Byrne' }

// Every read answers per table (and, for the ledger, per op); updates match one row.
function makeDb() {
  return {
    from: (table) => {
      const f = []
      let kind = 'select'
      const answer = () => {
        if (kind === 'update') return { data: [{ id: 'tp1' }], error: null }
        if (table === 'trial_purchases') return { data: f.some((x) => x[0] === 'not') ? [] : [ROW], error: null }
        if (table === 'un1t_transactions') return { data: [TX], error: null }
        if (table === 'contacts') return { data: CONTACT, error: null }
        if (table === 'un1t_write_events') {
          const op = f.find((x) => x[0] === 'eq' && x[1] === 'op')?.[2]
          return { data: op === 'create_client' ? [{ id: 'w-create' }] : [], error: null }
        }
        throw new Error(`unexpected table ${table}`)
      }
      const b = {
        select: () => b, order: () => b, range: () => b, limit: () => b,
        update: () => { kind = 'update'; return b },
        maybeSingle: async () => answer(),
        then: (res, rej) => Promise.resolve(answer()).then(res, rej),
      }
      for (const op of ['eq', 'gte', 'in', 'not']) b[op] = (...a) => { f.push([op, ...a]); return b }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.send.mockResolvedValue({ sent: true, channel: 'email' })
  // un1t.online's reset: runs our beforeSend (the explanation email), then sends.
  mocks.forgot.mockImplementation(async (db, args) => {
    if (args.beforeSend) await args.beforeSend()
    return { verdict: 'done' }
  })
})

describe('settle sweep → the real set-password step', () => {
  it("sends the trial buyer's explanation email (kind trial_purchase, the studio copy, the product) before the reset", async () => {
    const r = await settleUn1tTrialPurchases(makeDb(), { now: () => T0 + 10 * 60_000 })
    expect(r).toMatchObject({ settled: 1, errors: 0, passwordPending: 0 })
    expect(mocks.forgot).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      locationId: 'loc2', contact: CONTACT, kind: 'trial_purchase', productName: 'The UN1T Trial',
      copy: { subject: 'S {product_name}', body: 'B {product_name}' },
    }))
  })
})
