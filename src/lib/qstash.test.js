// QSTASH.1 — behaviour contract for the QStash integration lib.
//
// Pure unit tests, no network: global fetch is stubbed for the publish
// helper, and signature tokens are hand-crafted HS256 JWTs so the
// verifier is exercised against real crypto (not a mocked verifier).

import { describe, it, expect, vi, afterEach } from 'vitest'
import crypto from 'node:crypto'
import {
  POSTMARK_WORKER_PATH,
  WEBHOOK_REPLAY_WORKER_PATH,
  CONTACT_IMPORTS_WORKER_PATH,
  INVOICE_ANALYSIS_WORKER_PATH,
  INVOICE_ANALYSIS_QUEUE_NAME,
  INVOICE_ANALYSIS_QUEUE_PARALLELISM,
  qstashEnabled,
  publishQueuePush,
  ensureQueue,
  verifyQStashSignature,
} from './qstash.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── helpers ───────────────────────────────────────────────────────────────────

const CURRENT_KEY = 'sig_current_key_aaaaaaaaaaaaaaaa'
const NEXT_KEY = 'sig_next_key_bbbbbbbbbbbbbbbbbbbb'
const WORKER_URL = `https://crm.example.com${POSTMARK_WORKER_PATH}`

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function bodyClaim(rawBody) {
  return crypto.createHash('sha256').update(rawBody).digest('base64url')
}

/** Craft a QStash-shaped HS256 JWT signed with `key`. */
function makeToken({ key, rawBody, nowSec = 1_800_000_000, claims = {} }) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' })
  const payload = b64url({
    iss: 'Upstash',
    sub: WORKER_URL,
    iat: nowSec,
    nbf: nowSec,
    exp: nowSec + 300,
    jti: 'test-jti',
    body: bodyClaim(rawBody),
    ...claims,
  })
  const sig = crypto
    .createHmac('sha256', key)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${sig}`
}

const NOW_MS = 1_800_000_000 * 1000

function stubSigningKeys() {
  vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', CURRENT_KEY)
  vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', NEXT_KEY)
}

// ── qstashEnabled ─────────────────────────────────────────────────────────────

describe('qstashEnabled', () => {
  it('is false when QSTASH_TOKEN is unset', () => {
    vi.stubEnv('QSTASH_TOKEN', '')
    expect(qstashEnabled()).toBe(false)
  })

  it('is true when QSTASH_TOKEN is set', () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    expect(qstashEnabled()).toBe(true)
  })
})

// ── publishQueuePush ──────────────────────────────────────────────────────────

describe('publishQueuePush', () => {
  it('skips without calling fetch when QSTASH_TOKEN is unset', async () => {
    vi.stubEnv('QSTASH_TOKEN', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: POSTMARK_WORKER_PATH,
      body: { id: 'row-1' },
    })

    expect(result).toEqual({ ok: false, skipped: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the JSON body to the QStash publish endpoint for the app URL + path', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: POSTMARK_WORKER_PATH,
      body: { id: 'row-1' },
      deduplicationId: 'postmark:row-1',
    })

    expect(result).toEqual({ ok: true, messageId: 'msg_1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://qstash.upstash.io/v2/publish/${WORKER_URL}`)
    expect(opts.method).toBe('POST')
    expect(opts.headers['Authorization']).toBe('Bearer tok_123')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(opts.headers['Upstash-Deduplication-Id']).toBe('postmark:row-1')
    expect(JSON.parse(opts.body)).toEqual({ id: 'row-1' })
  })

  it('omits the dedup header when no deduplicationId is given', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_2' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    const [, opts] = fetchMock.mock.calls[0]
    expect('Upstash-Deduplication-Id' in opts.headers).toBe(false)
  })

  it('passes an abort signal so a hung QStash cannot hold the webhook lambda', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_3' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns ok:false (never throws) on a non-2xx QStash response', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '' }))

    const result = await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('qstash_429')
  })

  it('logs the QStash error response body so a 4xx is diagnosable from prod logs', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid deduplication id"}',
    }))

    await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('invalid deduplication id')
  })

  it('still reports the status when reading the error body itself fails', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => { throw new Error('stream gone') },
    }))

    const result = await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    expect(result).toEqual({ ok: false, error: 'qstash_400' })
  })

  it('returns ok:false (never throws) when fetch rejects', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))

    const result = await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
  })

  // QSTASH.3 — delaySeconds → Upstash-Delay header. Used by the
  // webhook-replay publish so the first push respects the dead-letter
  // minimum backoff instead of replaying instantly.
  it('exports the webhook-replay worker path', () => {
    expect(WEBHOOK_REPLAY_WORKER_PATH).toBe('/api/webhooks/qstash/webhook-replay')
  })

  // QSTASH.4 — contact-imports worker path (published by the commit
  // route's async path, swept by /api/cron/process-contact-imports).
  it('exports the contact-imports worker path', () => {
    expect(CONTACT_IMPORTS_WORKER_PATH).toBe('/api/webhooks/qstash/contact-imports')
  })

  it('sets the Upstash-Delay header when delaySeconds is given', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_4' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({
      path: WEBHOOK_REPLAY_WORKER_PATH,
      body: { id: 1 },
      delaySeconds: 60,
    })

    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers['Upstash-Delay']).toBe('60s')
  })

  it('omits the Upstash-Delay header when delaySeconds is not given (existing callers unchanged)', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_5' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    const [, opts] = fetchMock.mock.calls[0]
    expect('Upstash-Delay' in opts.headers).toBe(false)
  })

  it.each([0, -5, NaN, 'sixty'])('omits the Upstash-Delay header for invalid delaySeconds %s', async (delaySeconds) => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_6' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({ path: WEBHOOK_REPLAY_WORKER_PATH, body: {}, delaySeconds })

    const [, opts] = fetchMock.mock.calls[0]
    expect('Upstash-Delay' in opts.headers).toBe(false)
  })

  it('returns ok:false (never throws) when NEXT_PUBLIC_APP_URL is unset', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── publishQueuePush with queueName (QSTASH.6) ────────────────────────────────
//
// Bounded-parallelism jobs enqueue onto a named QStash FIFO queue
// (`/v2/enqueue/<queueName>/<destination>`) instead of plain publish.
// The queue is upserted LAZILY: only a 404 (queue missing) triggers a
// `POST /v2/queues` upsert followed by exactly ONE enqueue retry — all
// inside the existing never-throws contract.

describe('publishQueuePush with queueName', () => {
  const INVOICE_WORKER_URL = `https://crm.example.com${INVOICE_ANALYSIS_WORKER_PATH}`

  function stubQstashEnv() {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
  }

  it('exports the invoice-analysis worker path, queue name and parallelism', () => {
    expect(INVOICE_ANALYSIS_WORKER_PATH).toBe('/api/webhooks/qstash/invoice-analysis')
    expect(INVOICE_ANALYSIS_QUEUE_NAME).toBe('invoice-analysis')
    expect(INVOICE_ANALYSIS_QUEUE_PARALLELISM).toBe(2)
  })

  it('POSTs to the enqueue endpoint for the queue + destination', async () => {
    stubQstashEnv()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_q1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id: 'row-1' },
      deduplicationId: 'invoice-analysis-row-1',
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: INVOICE_ANALYSIS_QUEUE_PARALLELISM,
    })

    expect(result).toEqual({ ok: true, messageId: 'msg_q1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://qstash.upstash.io/v2/enqueue/invoice-analysis/${INVOICE_WORKER_URL}`)
    expect(opts.method).toBe('POST')
    expect(opts.headers['Authorization']).toBe('Bearer tok_123')
    expect(opts.headers['Upstash-Deduplication-Id']).toBe('invoice-analysis-row-1')
    expect(JSON.parse(opts.body)).toEqual({ id: 'row-1' })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps the plain publish endpoint when queueName is not given (existing callers unchanged)', async () => {
    stubQstashEnv()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'msg_q2' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await publishQueuePush({ path: POSTMARK_WORKER_PATH, body: {} })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://qstash.upstash.io/v2/publish/${WORKER_URL}`)
  })

  it('on a 404 (queue missing) upserts the queue with the given parallelism then retries the enqueue ONCE', async () => {
    stubQstashEnv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'queue not found' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' }) // upsert
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messageId: 'msg_q3' }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: { id: 'row-2' },
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: 2,
    })

    expect(result).toEqual({ ok: true, messageId: 'msg_q3' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [upsertUrl, upsertOpts] = fetchMock.mock.calls[1]
    expect(upsertUrl).toBe('https://qstash.upstash.io/v2/queues')
    expect(upsertOpts.method).toBe('POST')
    expect(upsertOpts.headers['Authorization']).toBe('Bearer tok_123')
    expect(JSON.parse(upsertOpts.body)).toEqual({ queueName: 'invoice-analysis', parallelism: 2 })
    const [retryUrl] = fetchMock.mock.calls[2]
    expect(retryUrl).toBe(`https://qstash.upstash.io/v2/enqueue/invoice-analysis/${INVOICE_WORKER_URL}`)
  })

  it('retries only ONCE — a second 404 is surfaced as an error, no loop', async () => {
    stubQstashEnv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'queue not found' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' }) // upsert succeeds
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'queue not found' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: {},
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: 2,
    })

    expect(result).toEqual({ ok: false, error: 'qstash_404' })
    // enqueue → upsert → retry-enqueue and STOP: exactly 3 calls, no loop.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not attempt an upsert on a non-404 enqueue failure', async () => {
    stubQstashEnv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: {},
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: 2,
    })

    expect(result).toEqual({ ok: false, error: 'qstash_429' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original 404 when the upsert itself fails (no retry without a queue)', async () => {
    stubQstashEnv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'queue not found' })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upstash sad' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: {},
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: 2,
    })

    expect(result).toEqual({ ok: false, error: 'qstash_404' })
    expect(fetchMock).toHaveBeenCalledTimes(2) // enqueue + failed upsert, no blind retry
  })

  it('never throws when the upsert fetch rejects mid-retry', async () => {
    stubQstashEnv()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'queue not found' })
      .mockRejectedValueOnce(new Error('network gone'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await publishQueuePush({
      path: INVOICE_ANALYSIS_WORKER_PATH,
      body: {},
      queueName: INVOICE_ANALYSIS_QUEUE_NAME,
      queueParallelism: 2,
    })

    expect(result.ok).toBe(false)
  })
})

// ── ensureQueue (QSTASH.6) ────────────────────────────────────────────────────

describe('ensureQueue', () => {
  it('skips without calling fetch when QSTASH_TOKEN is unset', async () => {
    vi.stubEnv('QSTASH_TOKEN', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureQueue('invoice-analysis', 2)

    expect(result).toEqual({ ok: false, skipped: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the queue upsert with name + parallelism and a bearer token', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureQueue('invoice-analysis', 2)

    expect(result).toEqual({ ok: true })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://qstash.upstash.io/v2/queues')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Authorization']).toBe('Bearer tok_123')
    expect(opts.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(opts.body)).toEqual({ queueName: 'invoice-analysis', parallelism: 2 })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns ok:false (never throws) on a non-2xx response', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'sad' }))

    const result = await ensureQueue('invoice-analysis', 2)

    expect(result).toEqual({ ok: false, error: 'qstash_500' })
  })

  it('returns ok:false (never throws) when fetch rejects', async () => {
    vi.stubEnv('QSTASH_TOKEN', 'tok_123')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))

    const result = await ensureQueue('invoice-analysis', 2)

    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

// ── verifyQStashSignature ─────────────────────────────────────────────────────

describe('verifyQStashSignature', () => {
  const rawBody = JSON.stringify({ id: 'row-1' })

  it('rejects with missing_keys when no signing keys are configured', () => {
    vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', '')
    vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', '')
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'missing_keys' })
  })

  it('rejects with missing_signature when the header is absent', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({ signature: null, rawBody, url: WORKER_URL, now: NOW_MS })
    expect(result).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('rejects a malformed token', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({ signature: 'not-a-jwt', rawBody, url: WORKER_URL, now: NOW_MS })
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a token signed with an unknown key', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: 'some-other-key', rawBody }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('accepts a token signed with the current key', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: true, matched: 'current' })
  })

  it('accepts a token signed with the next key (rotation window)', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: NEXT_KEY, rawBody }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: true, matched: 'next' })
  })

  it('rejects an expired token', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody, claims: { exp: 1_800_000_000 - 3600 } }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a token that is not yet valid', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody, claims: { nbf: 1_800_000_000 + 3600 } }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  it('rejects when the body claim does not match the delivered body', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody: '{"id":"tampered"}' }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'body_mismatch' })
  })

  it('accepts a body claim with base64 padding (tolerant compare)', () => {
    stubSigningKeys()
    const padded = crypto.createHash('sha256').update(rawBody).digest('base64')
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody, claims: { body: padded } }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: true, matched: 'current' })
  })

  it('rejects when sub does not match the expected url', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody, claims: { sub: 'https://evil.example.com/x' } }),
      rawBody,
      url: WORKER_URL,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: false, reason: 'url_mismatch' })
  })

  it('skips the url check when no expected url is passed', () => {
    stubSigningKeys()
    const result = verifyQStashSignature({
      signature: makeToken({ key: CURRENT_KEY, rawBody, claims: { sub: 'https://anything.example.com' } }),
      rawBody,
      now: NOW_MS,
    })
    expect(result).toEqual({ ok: true, matched: 'current' })
  })
})
