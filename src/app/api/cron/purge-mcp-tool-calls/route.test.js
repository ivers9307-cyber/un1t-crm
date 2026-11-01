// MCP.1 — the 90-day retention purge of the staff MCP call log
// (public.mcp_tool_calls, mig 801).
//
// WHAT IT MUST DO:
//   • refuse without CRON_SECRET (401, nothing read, nothing stamped);
//   • delete rows older than RETENTION_DAYS in .range() pages, with the
//     cutoff predicate riding along on every delete, and leave younger rows;
//   • stamp the heartbeat on a clean run (an idle run too) and ONLY on a
//     clean run: a delete error answers 500 and does not stamp.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

import { GET, RETENTION_DAYS, PURGE_PAGE_SIZE, retentionCutoff } from './route'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

const NOW = Date.parse('2026-11-01T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString()
const CUTOFF = new Date(NOW - RETENTION_DAYS * DAY).toISOString()

const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/purge-mcp-tool-calls', { headers: { authorization: `Bearer ${secret}` } })

const row = (id, ageDays) => ({ id, created_at: daysAgo(ageDays) })

/**
 * A small fake of the service-role client. It honours lt / in / order / range,
 * because the properties under test ARE those filters, and records every call.
 * Either the scan or the delete can be made to fail.
 */
function makeDb(rows, { failDelete = false, failScan = false } = {}) {
  const state = { rows: [...rows], tables: [], scans: [], deletes: [], ranges: [], orders: [] }
  const db = {
    _state: state,
    from(table) {
      state.tables.push(table)
      const q = { op: 'select', filters: [], order: null, range: null }
      const matching = () => state.rows.filter(r => q.filters.every(([kind, col, v]) => (
        kind === 'lt' ? r[col] < v : v.includes(r[col])
      )))
      const run = () => {
        if (q.op === 'delete') {
          state.deletes.push({ filters: q.filters })
          if (failDelete) return { data: null, error: { message: 'boom' } }
          const gone = matching()
          state.rows = state.rows.filter(r => !gone.includes(r))
          return { data: gone.map(r => ({ id: r.id })), error: null }
        }
        state.scans.push({ filters: q.filters })
        if (failScan) return { data: null, error: { message: 'scan boom' } }
        let found = matching()
        if (q.order) found = [...found].sort((a, c) => (a[q.order[0]] < c[q.order[0]] ? -1 : 1))
        if (q.range) found = found.slice(q.range[0], q.range[1] + 1)
        return { data: found.map(r => ({ id: r.id })), error: null }
      }
      const b = {
        select() { return b },
        delete() { q.op = 'delete'; return b },
        lt(col, v) { q.filters.push(['lt', col, v]); return b },
        in(col, v) { q.filters.push(['in', col, v]); return b },
        order(col, opts) { q.order = [col, opts]; state.orders.push([col, opts]); return b },
        range(a, z) { q.range = [a, z]; state.ranges.push([a, z]); return b },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
      }
      return b
    },
  }
  return db
}

let db
function setupDb(rows, opts) {
  db = makeDb(rows, opts)
  createServerClient.mockImplementation(() => db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

describe('refuses without CRON_SECRET', () => {
  it('401s on a wrong secret and touches nothing', async () => {
    setupDb([row('old', 200)])
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(db._state.tables).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('401s when CRON_SECRET is unset rather than running open', async () => {
    delete process.env.CRON_SECRET
    setupDb([row('old', 200)])
    expect((await GET(req())).status).toBe(401)
    expect(db._state.tables).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('deletes rows older than 90 days in pages and stamps', () => {
  it('RETENTION_DAYS is 90 and the cutoff is that many days before now', () => {
    expect(RETENTION_DAYS).toBe(90)
    expect(retentionCutoff(NOW)).toBe(CUTOFF)
  })

  it('removes only rows past the cutoff, paging with an ordered .range()', async () => {
    const old = Array.from({ length: PURGE_PAGE_SIZE + 5 }, (_, i) => row(`old-${i}`, 100 + (i % 50)))
    setupDb([...old, row('young-1', 89), row('young-2', 1)])

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.deleted).toBe(PURGE_PAGE_SIZE + 5)
    expect(body.data.cutoff).toBe(CUTOFF)

    expect(db._state.rows.map(r => r.id).sort()).toEqual(['young-1', 'young-2'])
    expect(new Set(db._state.tables)).toEqual(new Set(['mcp_tool_calls']))
    // Two pages: one full, one short.
    expect(db._state.deletes).toHaveLength(2)
    // Every read is ranged and explicitly ordered (the 1,000-row cap).
    expect(db._state.ranges).toEqual([[0, PURGE_PAGE_SIZE - 1], [0, PURGE_PAGE_SIZE - 1]])
    for (const [col, opts] of db._state.orders) {
      expect(col).toBe('created_at')
      expect(opts).toEqual({ ascending: true })
    }
    // The cutoff predicate rides along on every delete.
    for (const d of db._state.deletes) {
      expect(d.filters).toContainEqual(['lt', 'created_at', CUTOFF])
      expect(d.filters).toContainEqual(['in', 'id', expect.any(Array)])
    }

    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-mcp-tool-calls', { cutoff: CUTOFF, deleted: PURGE_PAGE_SIZE + 5 })
  })

  it('an idle run (nothing past retention) still stamps', async () => {
    setupDb([row('young', 10)])
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.deleted).toBe(0)
    expect(db._state.deletes).toEqual([])
    expect(stampHeartbeat).toHaveBeenCalledWith('purge-mcp-tool-calls', { cutoff: CUTOFF, deleted: 0 })
  })
})

describe('does not stamp when a delete errors', () => {
  it('answers 500 with the error and leaves the heartbeat alone', async () => {
    setupDb([row('old', 200)], { failDelete: true })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toContain('boom')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed scan does not stamp either', async () => {
    setupDb([row('old', 200)], { failScan: true })
    expect((await GET(req())).status).toBe(500)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})
