// Tests for stampHeartbeat().
// Pure unit tests — Supabase client mocked, never hits the DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

// Mock supabase before importing the module under test.
const updateMock = vi.fn()
const eqMock = vi.fn()
const selectMock = vi.fn()

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      update: updateMock,
    }),
  })),
}))

// Wire the builder chain so each call returns the next link.
beforeEach(() => {
  vi.clearAllMocks()
  updateMock.mockReturnValue({ eq: eqMock })
  eqMock.mockReturnValue({ select: selectMock })
  selectMock.mockResolvedValue({ data: [{ name: 'test-cron' }], error: null })
})

import { stampHeartbeat } from './cron-heartbeat.js'
import { logWarn } from '@/lib/log'

// ── backward compat: no outcome ────────────────────────────────────────────────

describe('stampHeartbeat (no outcome)', () => {
  it('updates only last_ok_at when no outcome is provided', async () => {
    await stampHeartbeat('test-cron')

    expect(updateMock).toHaveBeenCalledTimes(1)
    const [patch] = updateMock.mock.calls[0]
    expect(patch).toHaveProperty('last_ok_at')
    expect(patch).not.toHaveProperty('last_outcome')
  })

  it('does NOT write last_outcome when outcome is undefined', async () => {
    await stampHeartbeat('test-cron', undefined)
    const [patch] = updateMock.mock.calls[0]
    expect(patch).not.toHaveProperty('last_outcome')
  })

  it('filters by name', async () => {
    await stampHeartbeat('my-cron')
    expect(eqMock).toHaveBeenCalledWith('name', 'my-cron')
  })
})

// ── with outcome ───────────────────────────────────────────────────────────────

describe('stampHeartbeat (with outcome)', () => {
  it('writes last_outcome alongside last_ok_at when outcome is provided', async () => {
    const outcome = { processed: 5, skipped: 2, deadLettered: 1 }
    await stampHeartbeat('my-cron', outcome)

    const [patch] = updateMock.mock.calls[0]
    expect(patch).toHaveProperty('last_ok_at')
    expect(patch.last_outcome).toEqual(outcome)
  })

  it('writes last_outcome when outcome is null (explicit null = "ran, no data")', async () => {
    await stampHeartbeat('my-cron', null)
    const [patch] = updateMock.mock.calls[0]
    expect(patch.last_outcome).toBeNull()
  })

  it('writes last_outcome when outcome is 0 (falsy but defined)', async () => {
    await stampHeartbeat('my-cron', 0)
    const [patch] = updateMock.mock.calls[0]
    expect(patch.last_outcome).toBe(0)
  })
})

// ── guard: invalid name ────────────────────────────────────────────────────────

describe('stampHeartbeat guards', () => {
  it('returns early and warns on empty name', async () => {
    await stampHeartbeat('')
    expect(updateMock).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('cron-heartbeat', 'invalid name', { name: '' })
  })

  it('returns early and warns on non-string name', async () => {
    await stampHeartbeat(42)
    expect(updateMock).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('cron-heartbeat', 'invalid name', { name: 42 })
  })
})

// ── never throws ───────────────────────────────────────────────────────────────

describe('stampHeartbeat never throws', () => {
  it('does NOT throw when the update returns a DB error', async () => {
    selectMock.mockResolvedValueOnce({ data: null, error: { message: 'db error' } })
    await expect(stampHeartbeat('test-cron')).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith('cron-heartbeat', 'stamp failed', expect.any(Object))
  })

  it('does NOT throw when the select rejects', async () => {
    selectMock.mockRejectedValueOnce(new Error('network error'))
    await expect(stampHeartbeat('test-cron', { processed: 1 })).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith('cron-heartbeat', 'stamp threw', expect.any(Object))
  })

  it('warns when update matches 0 rows', async () => {
    selectMock.mockResolvedValueOnce({ data: [], error: null })
    await stampHeartbeat('unregistered-cron')
    expect(logWarn).toHaveBeenCalledWith(
      'cron-heartbeat',
      'stamp matched 0 rows — cron not seeded in cron_heartbeats',
      { name: 'unregistered-cron' }
    )
  })
})
