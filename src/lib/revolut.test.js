// REVPAY.1 — the Revolut Merchant transport: the refund idempotency key
// reaches Revolut, a GET is retried on 429/5xx/no reply, a POST never is, and
// a hung call times out as a recognisable RevolutError.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getOrder, refundOrder, createOrder, RevolutError } from './revolut'
import { refundPayment } from './payments/revolut'

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

// A fetch that never answers until its signal aborts it.
function hangingFetch() {
  return vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  }))
}

let fetchMock
beforeEach(() => {
  vi.stubEnv('REVOLUT_API_KEY', 'sk_test')
  vi.stubEnv('REVOLUT_API_BASE_URL', 'https://rev.test')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('refund idempotency', () => {
  it('refundOrder sends the Idempotency-Key header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'rf_1' }))
    await refundOrder('ord 1', { amount: 1000, currency: 'EUR', idempotencyKey: 'refund:o1:1000' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://rev.test/api/orders/ord%201/refund')
    expect(init.method).toBe('POST')
    expect(init.headers['Idempotency-Key']).toBe('refund:o1:1000')
    expect(JSON.parse(init.body)).toEqual({ amount: 1000, currency: 'EUR' })
  })

  it('the payments adapter threads idempotencyKey through to the header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'rf_2' }))
    const res = await refundPayment('ord_2', { amountCents: 500, currency: 'EUR', description: 'x', idempotencyKey: 'refund:o2:500' })
    expect(res).toEqual({ refundId: 'rf_2' })
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('refund:o2:500')
  })

  it('no key → no header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'rf_3' }))
    await refundOrder('ord_3', { amount: 100 })
    expect('Idempotency-Key' in fetchMock.mock.calls[0][1].headers).toBe(false)
  })
})

describe('GET retry', () => {
  it('a 503 is retried and the second answer returned', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { message: 'busy' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ord_1', state: 'completed' }))
    await expect(getOrder('ord_1')).resolves.toEqual({ id: 'ord_1', state: 'completed' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 429 is retried too', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { message: 'slow down' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ord_1' }))
    await expect(getOrder('ord_1')).resolves.toEqual({ id: 'ord_1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after 2 retries and throws the last status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { message: 'down' }, { 'retry-after': '0' }))
    const err = await getOrder('ord_1').catch((e) => e)
    expect(err).toBeInstanceOf(RevolutError)
    expect(err.status).toBe(503)
    expect(err.message).toBe('down')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a 4xx is an answer, never retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'not found' }))
    const err = await getOrder('ord_1').catch((e) => e)
    expect(err.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a network error on a GET is retried', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ord_1' }))
    await expect(getOrder('ord_1')).resolves.toEqual({ id: 'ord_1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('POST is never blind-retried', () => {
  it('a refund 503 is thrown after ONE attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'down' }, { 'retry-after': '0' }))
    const err = await refundOrder('ord_1', { amount: 100, idempotencyKey: 'k' }).catch((e) => e)
    expect(err).toBeInstanceOf(RevolutError)
    expect(err.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an order-create network error is thrown after ONE attempt, code network', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const err = await createOrder({ amount: 1000 }).catch((e) => e)
    expect(err).toBeInstanceOf(RevolutError)
    expect(err.code).toBe('network')
    expect(err.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('timeout', () => {
  it('a hung refund POST times out as RevolutError code timeout / 504, one attempt', async () => {
    const hang = hangingFetch()
    vi.stubGlobal('fetch', hang)
    const err = await refundOrder('ord_1', { amount: 100, timeoutMs: 20 }).catch((e) => e)
    expect(err).toBeInstanceOf(RevolutError)
    expect(err.code).toBe('timeout')
    expect(err.status).toBe(504)
    expect(hang).toHaveBeenCalledTimes(1)
  })

  it('every call carries an abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'ord_1' }))
    await getOrder('ord_1')
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('a GET that times out is retried, and a timeout on the last attempt is thrown', async () => {
    const hang = hangingFetch()
    vi.stubGlobal('fetch', hang)
    const err = await getOrder('ord_1', { timeoutMs: 20, retries: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(RevolutError)
    expect(err.code).toBe('timeout')
    expect(hang).toHaveBeenCalledTimes(2)
  })
})
