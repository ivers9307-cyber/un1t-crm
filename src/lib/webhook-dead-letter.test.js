// Tests for the webhook dead-letter capture helper.
// Pure unit tests — no DB. The Supabase client is mocked.
//
// QSTASH.3: capture now also fire-and-forget publishes a replay push to
// QStash for REPLAYABLE providers (dedup id `webhook-replay-<id>` —
// dash-only, QStash 400s on colons; 60s delay so the first replay
// respects the original minimum backoff). The publish must never affect
// the capture's own never-throws contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-test' }),
  WEBHOOK_REPLAY_WORKER_PATH: '/api/webhooks/qstash/webhook-replay',
}))
vi.mock('@/lib/webhook-replay', () => ({
  isReplayable: vi.fn((p) => p === 'inbody' || p === 'postmark'),
}))

import { deadLetterWebhook, resolveEmailSendLocation } from './webhook-dead-letter.js'
import { logWarn } from '@/lib/log'
import { publishQueuePush, WEBHOOK_REPLAY_WORKER_PATH } from '@/lib/qstash'

// ── db mock factory ────────────────────────────────────────────────────────────

/**
 * The capture insert chains .select('id').single() so the new row's id is
 * available for the replay push publish.
 */
function makeDb({ insertError = null, insertThrows = false, insertedId = 101 } = {}) {
  const singleMock = vi.fn()
  if (insertThrows) {
    singleMock.mockRejectedValue(new Error('DB exploded'))
  } else {
    singleMock.mockResolvedValue(
      insertError ? { data: null, error: insertError } : { data: { id: insertedId }, error: null }
    )
  }
  const selectMock = vi.fn().mockReturnValue({ single: singleMock })
  const insertMock = vi.fn().mockReturnValue({ select: selectMock })
  return {
    from: vi.fn().mockReturnValue({ insert: insertMock }),
    _insertMock: insertMock,
    _selectMock: selectMock,
  }
}

// ── happy path ─────────────────────────────────────────────────────────────────

describe('deadLetterWebhook', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts a row with the correct shape', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, {
      provider: 'glofox',
      eventType: 'BOOKING_CREATED',
      payload: { foo: 1 },
      error: new Error('Something went wrong'),
      locationId: 'loc-123',
    })

    expect(db.from).toHaveBeenCalledWith('webhook_dead_letter')
    const [row] = db._insertMock.mock.calls[0]
    expect(row.provider).toBe('glofox')
    expect(row.event_type).toBe('BOOKING_CREATED')
    expect(row.payload).toEqual({ foo: 1 })
    expect(row.error).toBe('Something went wrong')
    expect(row.location_id).toBe('loc-123')
    expect(typeof row.last_attempt_at).toBe('string')
  })

  it('truncates the error string to 2000 chars', async () => {
    const db = makeDb()
    const longMsg = 'x'.repeat(5000)
    await deadLetterWebhook(db, {
      provider: 'postmark',
      payload: {},
      error: new Error(longMsg),
    })
    const [row] = db._insertMock.mock.calls[0]
    expect(row.error.length).toBe(2000)
  })

  it('stores a plain string error', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, {
      provider: 'inbody',
      payload: { scan: true },
      error: 'plain string error',
    })
    const [row] = db._insertMock.mock.calls[0]
    expect(row.error).toBe('plain string error')
  })

  it('stores null error when none provided', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, { provider: 'glofox', payload: {} })
    const [row] = db._insertMock.mock.calls[0]
    expect(row.error).toBeNull()
    expect(row.event_type).toBeNull()
    expect(row.location_id).toBeNull()
  })

  it('defaults payload to {} when null/undefined', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, { provider: 'glofox', payload: null })
    const [row] = db._insertMock.mock.calls[0]
    expect(row.payload).toEqual({})
  })

  // EMAIL-INBOUND-POISON.1 — jsonb rejects \u0000, so a NUL-bearing payload
  // could not even be dead-lettered: the one capture path for a poison webhook
  // failed on exactly the payloads that need it most. Lone surrogates fail the
  // same way (unencodable as UTF-8).
  it('strips NUL bytes and lone surrogates so a poison payload can actually land in jsonb', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, {
      provider: 'postmark_inbound',
      eventType: 'inbound_email',
      payload: {
        MessageID: 'pm-1',
        Subject: 'bad\u0000subject',
        FromFull: { Name: 'Ada\ud800', Email: 'a@b.com' },
        Headers: [{ Name: 'X-Test', Value: 'v\u0000' }],
      },
      error: 'poison\u0000error',
    })
    const [row] = db._insertMock.mock.calls[0]
    expect(row.payload).toEqual({
      MessageID: 'pm-1',
      Subject: 'badsubject',
      FromFull: { Name: 'Ada', Email: 'a@b.com' },
      Headers: [{ Name: 'X-Test', Value: 'v' }],
    })
    expect(row.error).toBe('poisonerror')
  })

  // ── QSTASH.3 replay push ────────────────────────────────────────────────────

  it('publishes a delayed replay push for a replayable provider after a successful insert', async () => {
    const db = makeDb({ insertedId: 42 })
    await deadLetterWebhook(db, { provider: 'postmark', payload: { x: 1 } })

    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: WEBHOOK_REPLAY_WORKER_PATH,
      body: { id: 42 },
      deduplicationId: 'webhook-replay-42',
      delaySeconds: 60,
    })
  })

  it('uses a dash-only dedup id (QStash 400s on colons)', async () => {
    const db = makeDb({ insertedId: 7 })
    await deadLetterWebhook(db, { provider: 'inbody', payload: {} })

    const [{ deduplicationId }] = publishQueuePush.mock.calls[0]
    expect(deduplicationId).toBe('webhook-replay-7')
    expect(deduplicationId).not.toContain(':')
  })

  it('does NOT publish for a non-replayable provider (glofox)', async () => {
    const db = makeDb()
    await deadLetterWebhook(db, { provider: 'glofox', payload: {} })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('does NOT publish when the insert fails', async () => {
    const db = makeDb({ insertError: { message: 'insert failed', code: '23000' } })
    await deadLetterWebhook(db, { provider: 'postmark', payload: {} })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('does NOT throw when the publish rejects (belt-and-braces around a never-throws helper)', async () => {
    publishQueuePush.mockRejectedValueOnce(new Error('qstash exploded'))
    const db = makeDb()
    await expect(
      deadLetterWebhook(db, { provider: 'postmark', payload: {} })
    ).resolves.toBeUndefined()
  })

  // ── never throws ────────────────────────────────────────────────────────────

  it('does NOT throw when the insert returns an error', async () => {
    const db = makeDb({ insertError: { message: 'insert failed', code: '23000' } })
    await expect(
      deadLetterWebhook(db, { provider: 'glofox', payload: {} })
    ).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(
      'webhook-dead-letter', 'capture failed',
      expect.objectContaining({ provider: 'glofox' })
    )
  })

  it('does NOT throw when the insert promise rejects', async () => {
    const db = makeDb({ insertThrows: true })
    await expect(
      deadLetterWebhook(db, { provider: 'glofox', payload: {} })
    ).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(
      'webhook-dead-letter', 'capture threw',
      expect.objectContaining({ provider: 'glofox' })
    )
  })

  it('does NOT throw when db.from itself throws', async () => {
    const db = { from: vi.fn().mockImplementation(() => { throw new Error('from exploded') }) }
    await expect(
      deadLetterWebhook(db, { provider: 'postmark', payload: { x: 1 } })
    ).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(
      'webhook-dead-letter', 'capture threw',
      expect.objectContaining({ provider: 'postmark' })
    )
  })
})

// ── resolveEmailSendLocation (DEADLETTER-LOC.1) ────────────────────────────────

describe('resolveEmailSendLocation', () => {
  beforeEach(() => vi.clearAllMocks())

  function makeSendsDb(result) {
    const limit = vi.fn().mockReturnValue(Promise.resolve(result))
    const eq = vi.fn().mockReturnValue({ limit })
    const select = vi.fn().mockReturnValue({ eq })
    return { from: vi.fn().mockReturnValue({ select }), _eq: eq }
  }

  it('returns the send log row location for a known MessageID', async () => {
    const db = makeSendsDb({ data: [{ location_id: 'loc-hatch' }], error: null })
    await expect(resolveEmailSendLocation(db, 'pm-1')).resolves.toBe('loc-hatch')
    expect(db.from).toHaveBeenCalledWith('email_sends')
    expect(db._eq).toHaveBeenCalledWith('postmark_message_id', 'pm-1')
  })

  it('returns null for an unknown MessageID, a null send location, or no id at all', async () => {
    await expect(resolveEmailSendLocation(makeSendsDb({ data: [], error: null }), 'pm-x')).resolves.toBeNull()
    await expect(resolveEmailSendLocation(makeSendsDb({ data: [{ location_id: null }], error: null }), 'pm-x')).resolves.toBeNull()
    const untouched = makeSendsDb({ data: [], error: null })
    await expect(resolveEmailSendLocation(untouched, null)).resolves.toBeNull()
    expect(untouched.from).not.toHaveBeenCalled()
  })

  it('never throws — a broken lookup degrades to null (the capture must still land)', async () => {
    const db = { from: vi.fn().mockImplementation(() => { throw new Error('db down') }) }
    await expect(resolveEmailSendLocation(db, 'pm-1')).resolves.toBeNull()
  })
})
