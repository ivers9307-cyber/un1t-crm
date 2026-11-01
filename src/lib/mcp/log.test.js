import { describe, it, expect, vi, beforeEach } from 'vitest'

const logError = vi.fn()
vi.mock('@/lib/log', () => ({ logError: (...a) => logError(...a) }))

import { recordToolCall } from './log.js'

function dbWith(result) {
  const insert = vi.fn(async () => result)
  const from = vi.fn(() => ({ insert }))
  return { db: { from }, from, insert }
}

const call = {
  profileId: 'p1', organizationId: 'org-1', locationId: 'loc-1', clientId: 'client-x',
  tool: 'find_contact', ok: true, durationMs: 42,
}

beforeEach(() => logError.mockReset())

describe('recordToolCall', () => {
  it('inserts one row with the named columns and no args', async () => {
    const { db, from, insert } = dbWith({ error: null })
    await recordToolCall(db, { ...call, args: { email: 'secret@example.com' } })
    expect(from).toHaveBeenCalledWith('mcp_tool_calls')
    expect(insert).toHaveBeenCalledTimes(1)
    const row = insert.mock.calls[0][0]
    expect(Object.keys(row).sort()).toEqual([
      'client_id', 'duration_ms', 'error_code', 'location_id', 'ok', 'organization_id', 'profile_id', 'tool',
    ])
    expect(row).toEqual({
      profile_id: 'p1', organization_id: 'org-1', location_id: 'loc-1', client_id: 'client-x',
      tool: 'find_contact', ok: true, error_code: null, duration_ms: 42,
    })
    expect(logError).not.toHaveBeenCalled()
  })

  it('records the error code of a failed call', async () => {
    const { db, insert } = dbWith({ error: null })
    await recordToolCall(db, { ...call, ok: false, errorCode: 'studio_not_found' })
    expect(insert.mock.calls[0][0]).toMatchObject({ ok: false, error_code: 'studio_not_found' })
  })

  it('logs and resolves when the insert errors', async () => {
    const { db } = dbWith({ error: { code: '42501', message: 'denied' } })
    await expect(recordToolCall(db, call)).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBe('mcp')
    expect(logError.mock.calls[0][1]).toBe('tool call not recorded')
  })

  it('logs and resolves when the insert throws', async () => {
    const db = { from: () => ({ insert: async () => { throw new Error('boom') } }) }
    await expect(recordToolCall(db, call)).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
  })
})
