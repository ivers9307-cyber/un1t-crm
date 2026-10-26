// REVPAY.13 — one Revolut customer per email: mapping hit, miss → create →
// insert, the insert race, every failure falling back to details-only, a stale
// id retried once without it, and an unknown-outcome order POST never retried.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOrder, revolutMerchantKey } from './revolut'
import {
  resolveRevolutCustomerId,
  createOrderReusingCustomer,
  isStaleCustomerRefusal,
  CUSTOMER_CREATE_TIMEOUT_MS,
} from './revolut-customers'
import { RevolutError } from './revolut'

vi.mock('./log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const CUST_ID = '6c7e8d4a-1111-4222-8333-944455556666'
const OTHER_ID = '0a0b0c0d-1111-4222-8333-944455556666'

function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A minimal fake of the supabase builder for one table. `rows` is the table;
// knobs force errors. Records every operation for assertions.
function makeDb({ rows = [], readError = null, insertError = null, raceWinner = null, touchError = null, deleteError = null } = {}) {
  const ops = []
  let reads = 0
  const db = {
    ops,
    rows,
    from(table) {
      const state = { table, op: 'select', filters: {}, payload: null }
      const builder = {
        select() { state.op = state.op === 'select' ? 'select' : state.op; return builder },
        eq(col, val) { state.filters[col] = val; return builder },
        update(payload) { state.op = 'update'; state.payload = payload; return builder },
        insert(payload) { state.op = 'insert'; state.payload = payload; return builder },
        delete() { state.op = 'delete'; return builder },
        maybeSingle() { return builder },
        then(resolve, reject) {
          return Promise.resolve(run()).then(resolve, reject)
        },
      }
      const matches = (r) => Object.entries(state.filters).every(([k, v]) => r[k] === v)
      function run() {
        ops.push({ ...state, filters: { ...state.filters } })
        if (state.op === 'select') {
          reads++
          if (readError) return { data: null, error: readError }
          if (raceWinner && reads > 1) return { data: { revolut_customer_id: raceWinner }, error: null }
          const hit = rows.find(matches)
          return { data: hit ? { revolut_customer_id: hit.revolut_customer_id } : null, error: null }
        }
        if (state.op === 'insert') {
          if (insertError) return { data: null, error: insertError }
          rows.push({ ...state.payload })
          return { data: null, error: null }
        }
        if (state.op === 'update') return { data: null, error: touchError }
        if (state.op === 'delete') {
          if (deleteError) return { data: null, error: deleteError }
          for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i])) rows.splice(i, 1)
          return { data: null, error: null }
        }
        return { data: null, error: null }
      }
      return builder
    },
  }
  return db
}

let fetchMock
let merchant
beforeEach(() => {
  vi.stubEnv('REVOLUT_API_KEY', 'sk_test')
  vi.stubEnv('REVOLUT_API_BASE_URL', 'https://rev.test')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  merchant = revolutMerchantKey()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const sent = (i) => ({ url: fetchMock.mock.calls[i][0], init: fetchMock.mock.calls[i][1], body: JSON.parse(fetchMock.mock.calls[i][1].body || 'null') })

describe('revolutMerchantKey', () => {
  it('is the API host plus a fingerprint of the key, never the key', () => {
    expect(merchant).toMatch(/^rev\.test#[0-9a-f]{16}$/)
    expect(merchant).not.toContain('sk_test')
  })
  it('differs per key and per host', () => {
    vi.stubEnv('REVOLUT_API_KEY', 'sk_other')
    expect(revolutMerchantKey()).not.toBe(merchant)
    vi.stubEnv('REVOLUT_API_KEY', 'sk_test')
    vi.stubEnv('REVOLUT_API_BASE_URL', 'https://merchant.revolut.com')
    expect(revolutMerchantKey().startsWith('merchant.revolut.com#')).toBe(true)
  })
})

describe('resolveRevolutCustomerId', () => {
  it('mapping hit: returns the stored id, touches last_used_at, calls no Revolut', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    const id = await resolveRevolutCustomerId(db, { email: '  Ann@X.ie ', fullName: 'Ann' })
    expect(id).toBe(CUST_ID)
    expect(fetchMock).not.toHaveBeenCalled()
    const touch = db.ops.find((o) => o.op === 'update')
    expect(touch.filters).toEqual({ merchant, email_norm: 'ann@x.ie' })
    expect(typeof touch.payload.last_used_at).toBe('string')
  })

  it('a failed touch still returns the id', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }], touchError: { message: 'boom' } })
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBe(CUST_ID)
  })

  it('miss: creates the customer (one POST, short timeout, no idempotency key) and inserts the mapping', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockResolvedValue(jsonResponse(201, { id: CUST_ID, email: 'Ann@X.ie' }))
    const db = makeDb()
    const id = await resolveRevolutCustomerId(db, { email: 'Ann@X.ie', fullName: '  Ann   Lee ' })
    expect(id).toBe(CUST_ID)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init, body } = sent(0)
    expect(url).toBe('https://rev.test/api/customers')
    expect(init.method).toBe('POST')
    expect('Idempotency-Key' in init.headers).toBe(false)
    expect(body).toEqual({ email: 'Ann@X.ie', full_name: 'Ann Lee' })
    expect(timeoutSpy).toHaveBeenCalledWith(CUSTOMER_CREATE_TIMEOUT_MS)
    expect(db.rows).toEqual([{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }])
    timeoutSpy.mockRestore()
  })

  it('insert race: uses the winner\'s id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: CUST_ID }))
    const db = makeDb({ insertError: { code: '23505', message: 'duplicate key' }, raceWinner: OTHER_ID })
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBe(OTHER_ID)
  })

  it('a non-race insert failure still uses the customer just created', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: CUST_ID }))
    const db = makeDb({ insertError: { code: '42501', message: 'denied' } })
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBe(CUST_ID)
  })

  it('a failed mapping read is unknown: no customer is created, null', async () => {
    const db = makeDb({ readError: { message: 'db down' } })
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a 422 refusal', () => fetchMock.mockResolvedValue(jsonResponse(422, { code: 'validation', message: 'bad email' }))],
    ['a 500', () => fetchMock.mockResolvedValue(jsonResponse(500, { code: 'x' }))],
    ['no reply', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['an answer without an id', () => fetchMock.mockResolvedValue(jsonResponse(201, { email: 'a@x.ie' }))],
  ])('Revolut failure (%s) → null, nothing stored, POST sent once', async (_label, arrange) => {
    arrange()
    const db = makeDb()
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.rows).toEqual([])
  })

  it('no API key → null without touching the db', async () => {
    vi.stubEnv('REVOLUT_API_KEY', '')
    const db = makeDb()
    expect(await resolveRevolutCustomerId(db, { email: 'ann@x.ie' })).toBeNull()
    expect(db.ops).toEqual([])
  })

  it('an invalid email is never created', async () => {
    const db = makeDb()
    expect(await resolveRevolutCustomerId(db, { email: 'not-an-email' })).toBeNull()
    expect(db.ops).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createOrder with db (createOrderReusingCustomer)', () => {
  const ORDER = { amount: 1000, currency: 'EUR', idempotencyKey: 'offer-1', customer: { email: 'ann@x.ie', fullName: 'Ann' } }

  it('a known customer: the order carries customer { id } only', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ord_1' }))
    const order = await createOrder({ ...ORDER, db })
    expect(order.id).toBe('ord_1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent(0).url).toBe('https://rev.test/api/orders')
    expect(sent(0).body.customer).toEqual({ id: CUST_ID })
    expect(sent(0).init.headers['Idempotency-Key']).toBe('offer-1')
  })

  it('a new email: customer created, then the order linked to it', async () => {
    const db = makeDb()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: CUST_ID }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'ord_2' }))
    await createOrder({ ...ORDER, db })
    expect(sent(0).url).toBe('https://rev.test/api/customers')
    expect(sent(1).body.customer).toEqual({ id: CUST_ID })
  })

  it('customer creation fails: the order goes out with the details, as before', async () => {
    const db = makeDb()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { code: 'x' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'ord_3' }))
    const order = await createOrder({ ...ORDER, db })
    expect(order.id).toBe('ord_3')
    expect(sent(1).body.customer).toEqual({ email: 'ann@x.ie', full_name: 'Ann' })
  })

  it('a stale id (404): dropped, and the order retried ONCE without it under a derived key', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'Customer not found' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'ord_4' }))
    const order = await createOrder({ ...ORDER, db })
    expect(order.id).toBe('ord_4')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent(1).body.customer).toEqual({ email: 'ann@x.ie', full_name: 'Ann' })
    const retryKey = sent(1).init.headers['Idempotency-Key']
    expect(retryKey).toMatch(/^nocust-[0-9a-f]{32}$/)
    expect(retryKey.length).toBeLessThanOrEqual(50)
    expect(db.rows).toEqual([])
    expect(db.ops.find((o) => o.op === 'delete').filters).toEqual({ merchant, revolut_customer_id: CUST_ID })
  })

  it('a stale id whose retry also fails throws the retry\'s error (no third POST)', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'not_found', message: 'still' }))
    await expect(createOrder({ ...ORDER, db })).rejects.toMatchObject({ status: 404 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a 500', () => jsonResponse(500, { code: 'x', message: 'customer service down' })],
    ['a 422 not about the customer', () => jsonResponse(422, { code: 'validation', message: 'amount invalid' })],
    ['a 401', () => jsonResponse(401, { code: 'unauthenticated', message: 'customer auth' })],
  ])('%s on the order POST is thrown, not retried, and the mapping kept', async (_label, res) => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock.mockResolvedValueOnce(res())
    await expect(createOrder({ ...ORDER, db })).rejects.toBeInstanceOf(RevolutError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.rows).toHaveLength(1)
  })

  it('a timeout on the order POST is outcome-unknown: thrown, never retried', async () => {
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    await expect(createOrder({ ...ORDER, db })).rejects.toMatchObject({ code: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(db.rows).toHaveLength(1)
  })

  it('no email: no customer lookup, details sent as before', async () => {
    const db = makeDb()
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ord_5' }))
    await createOrderReusingCustomer(db, { amount: 500, customer: { fullName: 'Ann' } })
    expect(db.ops).toEqual([])
    expect(sent(0).body.customer).toEqual({ full_name: 'Ann' })
  })

  it('an invalid amount throws before any customer is created', async () => {
    const db = makeDb()
    await expect(createOrder({ ...ORDER, amount: 0, db })).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.ops).toEqual([])
  })
})

describe('payments adapter (createPayment)', () => {
  it('threads db through, so every dispatcher caller reuses the customer', async () => {
    const { createPayment } = await import('./payments/revolut')
    const db = makeDb({ rows: [{ merchant, email_norm: 'ann@x.ie', revolut_customer_id: CUST_ID }] })
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ord_6', token: 't', state: 'PENDING', amount: 700 }))
    const res = await createPayment({ amountCents: 700, currency: 'EUR', customer: { email: 'ann@x.ie' }, db })
    expect(res.providerRef).toBe('ord_6')
    expect(sent(0).body.customer).toEqual({ id: CUST_ID })
  })
})

describe('isStaleCustomerRefusal', () => {
  it('judges only HTTP refusals about the customer', () => {
    expect(isStaleCustomerRefusal(new RevolutError('x', 404))).toBe(true)
    expect(isStaleCustomerRefusal(new RevolutError('Customer does not exist', 400))).toBe(true)
    expect(isStaleCustomerRefusal(new RevolutError('Invalid amount', 400))).toBe(false)
    expect(isStaleCustomerRefusal(new RevolutError('timed out', 504, 'timeout'))).toBe(false)
    expect(isStaleCustomerRefusal(new RevolutError('customer', 500))).toBe(false)
    expect(isStaleCustomerRefusal(new Error('customer'))).toBe(false)
  })
})

describe('forgetRevolutCustomerForContact (contact erasure)', () => {
  function erasureDb({ contact = { email: ' Ann@X.ie ' }, readError = null, deleteError = null } = {}) {
    const deletes = []
    return {
      deletes,
      from(table) {
        const q = { table, filters: [] }
        q.select = () => q
        q.delete = () => { q.op = 'delete'; return q }
        q.eq = (col, val) => { q.filters.push([col, val]); return q }
        q.maybeSingle = async () => ({ data: readError ? null : contact, error: readError })
        q.then = (res) => {
          if (q.op === 'delete') deletes.push({ table, filters: q.filters })
          return res({ data: null, error: q.op === 'delete' ? deleteError : null })
        }
        return q
      },
    }
  }

  it('deletes the mapping for the contact\'s normalised email', async () => {
    const { forgetRevolutCustomerForContact } = await import('./revolut-customers')
    const db = erasureDb()
    await expect(forgetRevolutCustomerForContact(db, 'c1')).resolves.toBe(true)
    expect(db.deletes).toEqual([{ table: 'revolut_customers', filters: [['email_norm', 'ann@x.ie']] }])
  })

  it('a contact with no email deletes nothing and reports nothing left behind', async () => {
    const { forgetRevolutCustomerForContact } = await import('./revolut-customers')
    const db = erasureDb({ contact: { email: null } })
    await expect(forgetRevolutCustomerForContact(db, 'c1')).resolves.toBe(true)
    expect(db.deletes).toHaveLength(0)
  })

  it('a failed read or delete never throws, and reports false', async () => {
    const { forgetRevolutCustomerForContact } = await import('./revolut-customers')
    await expect(forgetRevolutCustomerForContact(erasureDb({ readError: { message: 'down' } }), 'c1')).resolves.toBe(false)
    await expect(forgetRevolutCustomerForContact(erasureDb({ deleteError: { message: 'denied' } }), 'c1')).resolves.toBe(false)
  })
})
