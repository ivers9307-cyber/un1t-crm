// STALEWATCH.1 — the in-CRM watchdog: one alert per newly stale job, cleared on
// recovery, acknowledged jobs quiet, one digest a day.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { planWatchdog, runStaleJobWatchdog, newlyStaleMessage, digestMessage, formatAge, alertMasters } = await import('./stale-job-watchdog.js')
const { sendTransactionalEmail } = await import('@/lib/postmark')
const { sendPush } = await import('@/lib/push')

const row = (name, extra = {}) => ({
  name, last_ok_at: '2026-11-10T00:00:00Z', stale_seconds: 3 * 86400, max_allowed_seconds: 3600,
  is_stale: true, is_acknowledged: false, acknowledged_until: null, acknowledged_note: null, stale_alerted_at: null, ...extra,
})

function fakeDb({ rows = [], readError = null, claimWon = true } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const q = { table, ops: [] }
      q.select = (...a) => { q.ops.push(['select', ...a]); return q }
      q.order = async () => (table === 'cron_health' ? { data: rows, error: readError } : { data: [], error: null })
      q.update = (p) => { q.patch = p; return q }
      q.in = async (col, names) => { writes.push({ table, patch: q.patch, names }); return { error: null } }
      q.upsert = (rowsIn) => { writes.push({ table, upsert: rowsIn }); return { select: async () => ({ data: claimWon ? [{ scope: 'none' }] : [], error: null }) } }
      return q
    },
  }
}
// 09:00 Dublin (GMT in November) and 06:00 Dublin.
const NINE = Date.parse('2026-11-16T09:00:00Z')
const SIX = Date.parse('2026-11-16T06:00:00Z')

beforeEach(() => vi.clearAllMocks())

describe('planWatchdog', () => {
  it('a stale, unacknowledged, unalerted job is newly stale', () => {
    expect(planWatchdog([row('a')]).newlyStale.map((r) => r.name)).toEqual(['a'])
  })
  it('an acknowledged job, or one already alerted for this episode, is not', () => {
    const p = planWatchdog([row('a', { is_acknowledged: true }), row('b', { stale_alerted_at: '2026-11-12T00:00:00Z' })])
    expect(p.newlyStale).toEqual([])
    expect(p.stillStale).toHaveLength(2)
  })
  it('an alert older than the last success is a new episode', () => {
    expect(planWatchdog([row('a', { stale_alerted_at: '2026-11-01T00:00:00Z' })]).newlyStale).toHaveLength(1)
  })
  it('a recovered job with an alert on it is cleared', () => {
    expect(planWatchdog([row('a', { is_stale: false, stale_alerted_at: '2026-11-12T00:00:00Z' })]).recovered.map((r) => r.name)).toEqual(['a'])
  })
})

describe('messages', () => {
  it('names the jobs and their age', () => {
    expect(formatAge(3 * 86400)).toBe('3d')
    expect(newlyStaleMessage([row('instagram-feed-sync')]).subject).toBe('Background job stale: instagram-feed-sync')
    const d = digestMessage([row('a', { stale_seconds: 7200 }), row('b', { is_acknowledged: true, acknowledged_until: '2026-11-20T00:00:00Z', acknowledged_note: 'token' })])
    expect(d.subject).toBe('Background jobs: 2 still stale (1 not acknowledged)')
    expect(d.htmlBody).toMatch(/acknowledged until 2026-11-20: token/)
  })
  it('escapes a job name in the email', () => {
    expect(newlyStaleMessage([row('<x>')]).htmlBody).toContain('&lt;x&gt;')
  })
})

describe('runStaleJobWatchdog', () => {
  it('alerts once, records one error event per job, and marks the episode', async () => {
    const db = fakeDb({ rows: [row('a'), row('b')] })
    const alert = vi.fn(async () => true)
    const recordError = vi.fn()
    const r = await runStaleJobWatchdog(db, { nowMs: SIX, alert, recordError })
    expect(r).toMatchObject({ ok: true, newlyStale: ['a', 'b'], alerted: true, digest: 'not_due' })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(recordError).toHaveBeenCalledTimes(2)
    expect(recordError.mock.calls[0][0]).toMatchObject({ route_type: 'cron_stale', route_path: 'cron:a' })
    expect(db.writes).toContainEqual(expect.objectContaining({ table: 'cron_heartbeats', patch: { stale_alerted_at: new Date(SIX).toISOString() }, names: ['a', 'b'] }))
  })

  it('an undelivered alert is not marked, so the next tick tries again', async () => {
    const db = fakeDb({ rows: [row('a')] })
    await runStaleJobWatchdog(db, { nowMs: SIX, alert: async () => false, recordError: vi.fn() })
    expect(db.writes.filter((w) => w.patch?.stale_alerted_at)).toHaveLength(0)
  })

  it('clears a recovered job and never alerts on itself', async () => {
    const db = fakeDb({ rows: [row('a', { is_stale: false, stale_alerted_at: '2026-11-12T00:00:00Z' }), row('stale-job-watchdog')] })
    const alert = vi.fn(async () => true)
    const r = await runStaleJobWatchdog(db, { nowMs: SIX, alert, recordError: vi.fn() })
    expect(r.recovered).toEqual(['a'])
    expect(alert).not.toHaveBeenCalled()
    expect(db.writes).toContainEqual(expect.objectContaining({ patch: { stale_alerted_at: null }, names: ['a'] }))
  })

  it('sends one digest after 08:00 Dublin when something is still stale', async () => {
    const db = fakeDb({ rows: [row('a', { stale_alerted_at: '2026-11-12T00:00:00Z' })] })
    const alert = vi.fn(async () => true)
    const r = await runStaleJobWatchdog(db, { nowMs: NINE, alert, recordError: vi.fn() })
    expect(r.digest).toBe('sent')
    expect(alert.mock.calls[0][1].subject).toMatch(/still stale/)
    expect(db.writes.find((w) => w.upsert)?.upsert[0]).toMatchObject({ cron_name: 'stale-job-watchdog-digest', scope: 'none', slot_day: '2026-11-16' })
  })

  it('a digest already sent today is not sent again; nothing stale sends nothing', async () => {
    const alert = vi.fn(async () => true)
    expect((await runStaleJobWatchdog(fakeDb({ rows: [row('a', { stale_alerted_at: '2026-11-12T00:00:00Z' })], claimWon: false }), { nowMs: NINE, alert, recordError: vi.fn() })).digest).toBe('already_sent')
    expect((await runStaleJobWatchdog(fakeDb({ rows: [row('a', { is_stale: false })] }), { nowMs: NINE, alert, recordError: vi.fn() })).digest).toBe('nothing_stale')
    expect(alert).not.toHaveBeenCalled()
  })

  it('an unreadable cron_health judges nothing', async () => {
    expect(await runStaleJobWatchdog(fakeDb({ readError: { message: 'down' } }), { nowMs: SIX })).toEqual({ ok: false })
  })
})

describe('alertMasters', () => {
  function mastersDb(masters, error = null) {
    const q = {}
    q.from = () => q; q.select = () => q; q.eq = () => q
    q.is = async () => ({ data: masters, error })
    return q
  }
  it('emails and pushes every active master', async () => {
    sendPush.mockResolvedValue({ sent: 1 })
    expect(await alertMasters(mastersDb([{ id: 'm1', email: 'm1@example.test' }]), { subject: 's', htmlBody: 'h', pushBody: 'p' })).toBe(true)
    expect(sendPush).toHaveBeenCalledWith(['m1'], expect.objectContaining({ title: 's' }))
    expect(sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'm1@example.test', tag: 'ops-alert' }))
  })
  it('unreadable masters reach nobody', async () => {
    expect(await alertMasters(mastersDb(null, { message: 'down' }), { subject: 's', htmlBody: 'h' })).toBe(false)
  })
})
