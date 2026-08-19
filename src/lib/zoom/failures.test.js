import { describe, it, expect, vi } from 'vitest'
import { isPermanentZoomFailure, loadParkedNumbers, ZOOM_SYNC_PROVIDER } from './failures'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

/**
 * Stub of the one builder chain loadParkedNumbers uses:
 *   webhook_dead_letter → .select('payload').eq(provider).eq(status).limit(n)
 * The filters are applied for real so a query that forgets one cannot pass.
 */
function stubDb(rows, { error = null, throws = false } = {}) {
  const calls = []
  return {
    calls,
    from: (table) => {
      calls.push(table)
      const filters = {}
      const chain = {
        select: () => chain,
        eq: (col, value) => { filters[col] = value; return chain },
        limit: (n) => {
          if (throws) throw new Error('boom')
          if (error) return Promise.resolve({ data: null, error })
          const matched = rows.filter((r) =>
            Object.entries(filters).every(([col, value]) => r[col] === value))
          return Promise.resolve({ data: matched.slice(0, n), error: null })
        },
      }
      return chain
    },
  }
}

const parkedRow = (e164, over = {}) => ({
  provider: ZOOM_SYNC_PROVIDER,
  status: 'pending',
  payload: { op: 'create', e164, name: 'Aoife Ryan', contactId: 'c1' },
  ...over,
})

describe('isPermanentZoomFailure', () => {
  it.each([400, 403, 404, 409, 422])('treats %d as a verdict on the payload', (status) => {
    expect(isPermanentZoomFailure(status)).toBe(true)
  })

  it.each([
    [401, 'our token — zoomFetch re-mints, and a rotated credential heals it'],
    [408, 'Zoom timed out reading the request'],
    [429, 'rate limited — the queue retry is exactly right'],
    [500, 'Zoom broke'],
    [503, 'Zoom is down'],
  ])('keeps %d retryable (%s)', (status) => {
    expect(isPermanentZoomFailure(status)).toBe(false)
  })

  it('treats a missing status as transient — never park on a guess', () => {
    expect(isPermanentZoomFailure(undefined)).toBe(false)
    expect(isPermanentZoomFailure(null)).toBe(false)
    expect(isPermanentZoomFailure(NaN)).toBe(false)
    expect(isPermanentZoomFailure('400')).toBe(false)
  })
})

describe('loadParkedNumbers', () => {
  it('returns the E.164 of every pending row for this provider', async () => {
    const db = stubDb([parkedRow('+87654567890'), parkedRow('+800860588525')])
    const parked = await loadParkedNumbers(db)
    expect([...parked].sort()).toEqual(['+800860588525', '+87654567890'])
    expect(db.calls).toContain('webhook_dead_letter')
  })

  it('ignores rows another provider parked', async () => {
    const db = stubDb([
      parkedRow('+353871111111'),
      parkedRow('+353872222222', { provider: 'postmark_queue' }),
    ])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353871111111'])
  })

  it('un-parks a resolved row — that is how an operator retries a fixed number', async () => {
    const db = stubDb([
      parkedRow('+353871111111', { status: 'resolved' }),
      parkedRow('+353872222222', { status: 'discarded' }),
    ])
    expect(await loadParkedNumbers(db)).toEqual(new Set())
  })

  it('skips a row whose payload carries no number', async () => {
    const db = stubDb([
      parkedRow('+353871111111'),
      { provider: ZOOM_SYNC_PROVIDER, status: 'pending', payload: {} },
      { provider: ZOOM_SYNC_PROVIDER, status: 'pending', payload: null },
    ])
    expect([...await loadParkedNumbers(db)]).toEqual(['+353871111111'])
  })

  it('fails OPEN on a read error — a suppression list that cannot be read must not suppress', async () => {
    expect(await loadParkedNumbers(stubDb([], { error: { message: 'nope' } }))).toEqual(new Set())
    expect(await loadParkedNumbers(stubDb([], { throws: true }))).toEqual(new Set())
    expect(await loadParkedNumbers(null)).toEqual(new Set())
  })
})
