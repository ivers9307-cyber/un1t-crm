// Tests for the webhook dead-letter capture helper.
// Pure unit tests — no DB. The Supabase client is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import { deadLetterWebhook } from './webhook-dead-letter.js'
import { logWarn } from '@/lib/log'

// ── db mock factory ────────────────────────────────────────────────────────────

function makeDb({ insertError = null, insertThrows = false } = {}) {
  const insertMock = vi.fn()
  if (insertThrows) {
    insertMock.mockRejectedValue(new Error('DB exploded'))
  } else {
    insertMock.mockResolvedValue({ error: insertError })
  }
  return {
    from: vi.fn().mockReturnValue({ insert: insertMock }),
    _insertMock: insertMock,
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
