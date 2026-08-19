// Tests for the webhook dead-letter replay registry + driver.
// Pure unit tests — no DB. The Supabase client is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock inbody-webhook so parseInbodyNotification is predictable.
vi.mock('@/lib/inbody-webhook', () => ({
  parseInbodyNotification: vi.fn((body) => ({
    account:      body?.Account ?? null,
    telHp:        body?.TelHP   ?? null,
    userId:       body?.UserID  ?? null,
    testDatetime: body?.TestDatetimes ?? null,
    equip:        body?.Equip   ?? null,
    equipSerial:  body?.EquipSerial ?? null,
    isTempData:   body?.IsTempData ?? null,
  })),
}))

import {
  isReplayable,
  replayDeadLetter,
  replayInbody,
  replayPostmark,
  REPLAYABLE_PROVIDERS,
} from './webhook-replay.js'
import { parseInbodyNotification } from '@/lib/inbody-webhook'

// ── db mock factory ────────────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase mock.
 *
 * upsertResult / insertResult: what the terminal call resolves to.
 * updateResult: { error? } for the webhook_dead_letter update.
 */
function makeDb({
  upsertResult  = { error: null },
  insertResult  = { error: null },
  updateResult  = { error: null },
  fetchResult   = { data: null, error: { message: 'not found' } },
} = {}) {
  const upsertMock = vi.fn().mockResolvedValue(upsertResult)
  const insertMock = vi.fn().mockResolvedValue(insertResult)
  const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue(updateResult) })
  const singleMock = vi.fn().mockResolvedValue(fetchResult)
  const selectEqMock = vi.fn().mockReturnValue({ single: singleMock })

  const fromMock = vi.fn((table) => {
    if (table === 'inbody_webhook_events') {
      return { upsert: upsertMock }
    }
    if (table === 'postmark_webhook_queue') {
      return { insert: insertMock }
    }
    if (table === 'webhook_dead_letter') {
      return {
        update: updateMock,
        select: vi.fn().mockReturnValue({ eq: selectEqMock }),
      }
    }
    return {}
  })

  return {
    from: fromMock,
    _upsertMock: upsertMock,
    _insertMock: insertMock,
    _updateMock: updateMock,
  }
}

// ── isReplayable ──────────────────────────────────────────────────────────────

describe('isReplayable', () => {
  it('returns true for inbody', () => expect(isReplayable('inbody')).toBe(true))
  it('returns true for postmark', () => expect(isReplayable('postmark')).toBe(true))
  it('returns false for glofox', () => expect(isReplayable('glofox')).toBe(false))
  it('returns false for unknown provider', () => expect(isReplayable('stripe')).toBe(false))
  // ZOOMSYNC.4 — deliberate, like postmark_queue: a replay would re-send the
  // identical write to Zoom and collect the identical 400. These rows are
  // fixed by correcting the contact's phone number, then resolving the row.
  it('returns false for zoom_contact_sync', () => expect(isReplayable('zoom_contact_sync')).toBe(false))
  it('returns false for empty string', () => expect(isReplayable('')).toBe(false))
  it('returns false for prototype properties', () => expect(isReplayable('toString')).toBe(false))

  it('REPLAYABLE_PROVIDERS mirrors the registry keys (single source of truth)', () => {
    expect(REPLAYABLE_PROVIDERS).toEqual(['inbody', 'postmark'])
    expect(REPLAYABLE_PROVIDERS.every(isReplayable)).toBe(true)
  })
})

// ── replayInbody re-driver ────────────────────────────────────────────────────

describe('replayInbody', () => {
  beforeEach(() => vi.clearAllMocks())

  const samplePayload = {
    Account:       'stillorganun1t',
    TelHP:         '0861234567',
    UserID:        '999',
    TestDatetimes: '20240101120000',
    Equip:         'InBody770',
    EquipSerial:   'CC71700163',
    IsTempData:    'false',
  }

  it('upserts into inbody_webhook_events with the correct shape', async () => {
    const db = makeDb()
    await replayInbody(db, samplePayload)

    expect(db.from).toHaveBeenCalledWith('inbody_webhook_events')
    const [row, opts] = db._upsertMock.mock.calls[0]

    expect(row.account).toBe('stillorganun1t')
    expect(row.tel_hp).toBe('0861234567')
    expect(row.user_id).toBe('999')
    expect(row.test_datetime).toBe('20240101120000')
    expect(row.equip).toBe('InBody770')
    expect(row.equip_serial).toBe('CC71700163')
    expect(row.is_temp_data).toBe('false')
    expect(row.payload).toEqual(samplePayload)
    expect(row.processed).toBe(false)

    expect(opts).toEqual({ onConflict: 'account,user_id,test_datetime', ignoreDuplicates: true })
  })

  it('is idempotent — safe to call twice (duplicate upsert succeeds)', async () => {
    const db = makeDb({ upsertResult: { error: null } })

    await replayInbody(db, samplePayload)
    await replayInbody(db, samplePayload)

    // Both calls should succeed without throwing.
    expect(db._upsertMock).toHaveBeenCalledTimes(2)
    // ignoreDuplicates: true means the second call is a no-op at the DB level.
    const [, opts1] = db._upsertMock.mock.calls[0]
    const [, opts2] = db._upsertMock.mock.calls[1]
    expect(opts1.ignoreDuplicates).toBe(true)
    expect(opts2.ignoreDuplicates).toBe(true)
  })

  it('throws when the upsert returns an error', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'DB write failed' } } })
    await expect(replayInbody(db, samplePayload)).rejects.toThrow('DB write failed')
  })

  it('parses the payload via parseInbodyNotification', async () => {
    const db = makeDb()
    await replayInbody(db, samplePayload)
    expect(parseInbodyNotification).toHaveBeenCalledWith(samplePayload)
  })
})

// ── replayPostmark re-driver ──────────────────────────────────────────────────

describe('replayPostmark', () => {
  beforeEach(() => vi.clearAllMocks())

  const samplePayload = {
    RecordType: 'Delivery',
    MessageID:  'msg-abc-123',
    Recipient:  'test@example.com',
  }

  it('inserts into postmark_webhook_queue with the payload', async () => {
    const db = makeDb()
    await replayPostmark(db, samplePayload)

    expect(db.from).toHaveBeenCalledWith('postmark_webhook_queue')
    const [row] = db._insertMock.mock.calls[0]
    expect(row).toEqual({ payload: samplePayload })
  })

  it('throws when the insert returns an error', async () => {
    const db = makeDb({ insertResult: { error: { message: 'queue unavailable' } } })
    await expect(replayPostmark(db, samplePayload)).rejects.toThrow('queue unavailable')
  })
})

// ── replayDeadLetter ─────────────────────────────────────────────────────────

describe('replayDeadLetter', () => {
  beforeEach(() => vi.clearAllMocks())

  const pendingInbodyRow = {
    id:       'dead-1',
    provider: 'inbody',
    payload:  { Account: 'test', UserID: '1', TestDatetimes: '20240101120000' },
    status:   'pending',
    attempts: 1,
  }

  const pendingPostmarkRow = {
    id:       'dead-2',
    provider: 'postmark',
    payload:  { RecordType: 'Delivery', MessageID: 'msg-1' },
    status:   'pending',
    attempts: 2,
  }

  it('returns { ok: true, status: "resolved" } on success', async () => {
    const db = makeDb()
    const result = await replayDeadLetter(db, pendingInbodyRow)
    expect(result).toEqual({ ok: true, status: 'resolved' })
  })

  it('marks the row resolved with resolved_at + attempts++ on success', async () => {
    const db = makeDb()
    await replayDeadLetter(db, pendingInbodyRow)

    expect(db._updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status:   'resolved',
        attempts: 2, // was 1, bumped to 2
      })
    )
    const [patch] = db._updateMock.mock.calls[0]
    expect(typeof patch.resolved_at).toBe('string')
    expect(typeof patch.last_attempt_at).toBe('string')
  })

  it('returns { ok: false, status: "pending", error } when replayer fails below maxAttempts', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'transient error' } } })
    const result = await replayDeadLetter(db, pendingInbodyRow, { maxAttempts: 5 })
    // error surfaced (QSTASH.3) so the queue lib / worker 500 body is diagnosable.
    expect(result).toEqual({ ok: false, status: 'pending', error: 'transient error' })
  })

  it('promotes to "failed" when attempts >= maxAttempts', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'persistent error' } } })
    // row.attempts=1, newAttempts=2, maxAttempts=2 → "failed"
    const result = await replayDeadLetter(db, pendingInbodyRow, { maxAttempts: 2 })
    expect(result).toEqual({ ok: false, status: 'failed', error: 'persistent error' })

    expect(db._updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', attempts: 2 })
    )
  })

  it('bumps attempts on failure and records the error', async () => {
    const db = makeDb({ upsertResult: { error: { message: 'boom' } } })
    await replayDeadLetter(db, pendingInbodyRow, { maxAttempts: 10 })

    const [patch] = db._updateMock.mock.calls[0]
    expect(patch.attempts).toBe(2)
    expect(patch.error).toContain('boom')
    expect(typeof patch.last_attempt_at).toBe('string')
  })

  it('returns { ok: false } for an unknown (non-replayable) provider', async () => {
    const db = makeDb()
    const row = { ...pendingInbodyRow, provider: 'glofox' }
    const result = await replayDeadLetter(db, row)
    expect(result.ok).toBe(false)
    // No DB write attempted for the replay itself.
    expect(db._upsertMock).not.toHaveBeenCalled()
    expect(db._insertMock).not.toHaveBeenCalled()
  })

  it('works for postmark rows', async () => {
    const db = makeDb()
    const result = await replayDeadLetter(db, pendingPostmarkRow)
    expect(result).toEqual({ ok: true, status: 'resolved' })
    expect(db._insertMock).toHaveBeenCalledWith({ payload: pendingPostmarkRow.payload })
  })

  it('handles attempts=0 safely (floors to 1 then increments)', async () => {
    const db = makeDb()
    const row = { ...pendingInbodyRow, attempts: 0 }
    const result = await replayDeadLetter(db, row)
    expect(result.ok).toBe(true)
    const [patch] = db._updateMock.mock.calls[0]
    // (0 || 1) + 1 = 2 — attempts=0 is treated as 1 before incrementing.
    expect(patch.attempts).toBe(2)
  })
})
