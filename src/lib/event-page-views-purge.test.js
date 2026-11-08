// HOSTSTATS.1 — the page-view retention arm: rows older than 180 days go,
// delete-as-you-go, with the arm's own heartbeat stamped only on a clean run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { purgeEventPageViews, runEventPageViewsPurgeArm, EVENT_PAGE_VIEWS_RETENTION_DAYS, PURGE_PAGE } = await import('./event-page-views-purge')
const { PURGE_EVENT_PAGE_VIEWS_HEARTBEAT } = await import('@/lib/cron-arm-health')

const NOW = Date.parse('2026-11-08T03:45:00Z')
const DAY = 86_400_000
const ids = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

function dbWith(pages, { deleteError = null, selectError = null } = {}) {
  let reads = 0
  return fakeDb((q) => {
    if (q.table !== 'event_page_views') return { data: null, error: null }
    if (q.action === 'select') {
      if (selectError) return { data: null, error: selectError }
      const page = pages[reads] || []
      reads += 1
      return { data: page, error: null }
    }
    if (q.action === 'delete') return deleteError ? { data: null, error: deleteError } : { data: null, error: null }
    return { data: null, error: null }
  })
}

beforeEach(() => vi.clearAllMocks())

describe('purgeEventPageViews', () => {
  it('cutoff is 180 days before now; deletes page by page and stops on a short page', async () => {
    expect(EVENT_PAGE_VIEWS_RETENTION_DAYS).toBe(180)
    const db = dbWith([ids(PURGE_PAGE, 'a'), ids(3, 'b')])
    const r = await purgeEventPageViews(db, { nowMs: NOW })
    expect(r).toEqual({ ok: true, deleted: PURGE_PAGE + 3, pages: 2, cutoff: new Date(NOW - 180 * DAY).toISOString() })
    const selects = db.queries.filter((q) => q.table === 'event_page_views' && q.action === 'select')
    expect(selects.length).toBe(2)
    expect(selects[0].ops).toEqual(expect.arrayContaining([['lt', 'created_at', r.cutoff], ['order', 'created_at', { ascending: true }], ['range', 0, PURGE_PAGE - 1]]))
    const deletes = db.queries.filter((q) => q.table === 'event_page_views' && q.action === 'delete')
    expect(deletes.length).toBe(2)
    expect(deletes[1].ops).toEqual(expect.arrayContaining([['in', 'id', ['b0', 'b1', 'b2']], ['lt', 'created_at', r.cutoff]]))
  })
  it('nothing to purge → deleted 0, one read, no delete', async () => {
    const db = dbWith([[]])
    const r = await purgeEventPageViews(db, { nowMs: NOW })
    expect(r).toMatchObject({ ok: true, deleted: 0, pages: 0 })
    expect(db.queries.filter((q) => q.action === 'delete').length).toBe(0)
  })
  it('a failed read or delete is ok:false with what was deleted so far', async () => {
    expect(await purgeEventPageViews(dbWith([], { selectError: { message: 'boom' } }), { nowMs: NOW })).toMatchObject({ ok: false, deleted: 0, error: { message: 'boom' } })
    expect(await purgeEventPageViews(dbWith([ids(2, 'a')], { deleteError: { message: 'nope' } }), { nowMs: NOW })).toMatchObject({ ok: false, deleted: 0, error: { message: 'nope' } })
  })
  it('is bounded at 20 pages', async () => {
    const db = dbWith(Array.from({ length: 25 }, (_, i) => ids(PURGE_PAGE, `p${i}-`)))
    const r = await purgeEventPageViews(db, { nowMs: NOW })
    expect(r).toMatchObject({ ok: true, pages: 20, deleted: 20 * PURGE_PAGE, capped: true })
  })
})

describe('runEventPageViewsPurgeArm', () => {
  it('stamps its own row with the outcome on a clean run (an idle one included)', async () => {
    const r = await runEventPageViewsPurgeArm(dbWith([[]]), { nowMs: NOW })
    expect(r.ok).toBe(true)
    expect(stampHeartbeat).toHaveBeenCalledWith(PURGE_EVENT_PAGE_VIEWS_HEARTBEAT, expect.objectContaining({ deleted: 0, pages: 0, cutoff: r.cutoff }))
    expect(PURGE_EVENT_PAGE_VIEWS_HEARTBEAT).toBe('purge-event-page-views')
  })
  it('does not stamp on a failed run, and a failed stamp does not change the result', async () => {
    const bad = await runEventPageViewsPurgeArm(dbWith([], { selectError: { message: 'boom' } }), { nowMs: NOW })
    expect(bad.ok).toBe(false)
    expect(stampHeartbeat).not.toHaveBeenCalled()
    stampHeartbeat.mockRejectedValueOnce(new Error('hb down'))
    const r = await runEventPageViewsPurgeArm(dbWith([[]]), { nowMs: NOW })
    expect(r.ok).toBe(true)
  })
})
