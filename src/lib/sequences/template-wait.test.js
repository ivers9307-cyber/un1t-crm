import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  templateWaitDecision, withoutTemplateWait, templateStamp,
  TEMPLATE_WAIT_RETRY_MS, TEMPLATE_WAIT_MAX_MS, onTemplateApproved,
} from './template-wait.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const { logError, logWarn } = await import('@/lib/log')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { CLAIM_LEASE_MS } = await import('./claim-lease.js')

const now = new Date('2026-11-06T12:00:00.000Z')

describe('templateWaitDecision', () => {
  it('startsWaitOnFirstDeferral', () => {
    const d = templateWaitDecision({ metadata: null, stepOrder: 2, templateId: 't1', now })
    expect(d.action).toBe('defer')
    expect(d.nextAt).toBe(new Date(now.getTime() + TEMPLATE_WAIT_RETRY_MS).toISOString())
    expect(d.metadata.template_wait).toEqual({ template_id: 't1', step_order: 2, since: now.toISOString() })
  })
  it('keepsSinceOnLaterDeferral', () => {
    const since = new Date(now.getTime() - 5 * 3_600_000).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 't1', step_order: 2, since } }, stepOrder: 2, templateId: 't1', now,
    })
    expect(d.action).toBe('defer')
    expect(d.metadata.template_wait.since).toBe(since)
  })
  it('exitsAt48Hours', () => {
    const since = new Date(now.getTime() - TEMPLATE_WAIT_MAX_MS).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 't1', step_order: 2, since } }, stepOrder: 2, templateId: 't1', now,
    })
    expect(d).toEqual({ action: 'exit' })
  })
  it('waitRecordResetsWhenTemplateChanges', () => {
    const since = new Date(now.getTime() - 60 * 3_600_000).toISOString()
    const d = templateWaitDecision({
      metadata: { template_wait: { template_id: 'A', step_order: 2, since } }, stepOrder: 2, templateId: 'B', now,
    })
    expect(d.action).toBe('defer')
    expect(d.metadata.template_wait).toEqual({ template_id: 'B', step_order: 2, since: now.toISOString() })
  })
  it('preservesOtherMetadataKeys', () => {
    const d = templateWaitDecision({ metadata: { test: true }, stepOrder: 1, templateId: 't1', now })
    expect(d.metadata.test).toBe(true)
  })
})

describe('helpers', () => {
  it('stampFormat', () => {
    expect(templateStamp('abc')).toBe('[wa_tpl:abc] ')
  })
  it('withoutTemplateWait strips the record, or returns null when nothing changes', () => {
    expect(withoutTemplateWait({ test: true, template_wait: { a: 1 } })).toEqual({ test: true })
    expect(withoutTemplateWait({ test: true })).toBeNull()
    expect(withoutTemplateWait(null)).toBeNull()
  })
})

// Minimal chainable fake: records every call, resolves reads/updates from `script`.
function fakeDb({
  sequences = [{ id: 's1', send_window: null }], paused = [], woke = [{ id: 'e1' }], readError = null,
  timezone = 'Europe/Dublin', zoneError = null, quiet = null, quietError = null,
} = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const q = { table, ops: [], filters: [] }
      calls.push(q)
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (res, rej) => Promise.resolve(resolve(q)).then(res, rej)
          }
          return (...args) => { q.ops.push([prop, ...args]); return chain }
        },
      })
      return chain
    },
  }
  function resolve(q) {
    if (readError) return { data: null, error: { message: readError } }
    if (q.table === 'locations') {
      return zoneError ? { data: null, error: { message: zoneError } } : { data: { id: 'loc1', timezone }, error: null }
    }
    if (q.table === 'company_settings') {
      return quietError ? { data: null, error: { message: quietError } } : { data: quiet ? [quiet] : [], error: null }
    }
    const isUpdate = q.ops.some((o) => o[0] === 'update')
    if (q.table === 'email_sequences') return { data: sequences, error: null }
    if (isUpdate) {
      const patch = q.ops.find((o) => o[0] === 'update')[1]
      return { data: patch.status === 'active' ? paused.filter((p) => p.recent).map((p) => ({ id: p.id })) : woke, error: null }
    }
    return { data: paused, error: null }
  }
  return db
}

describe('onTemplateApproved', () => {
  const tpl = { id: 't1', location_id: 'loc1' }
  beforeEach(() => { resetLocationZoneCache(); vi.clearAllMocks() })
  const wakeOf = (db) => db.calls.find((c) => c.table === 'sequence_enrollments'
    && c.ops.some((o) => o[0] === 'update' && !('status' in o[1])))
  const resumeOf = (db) => db.calls.find((c) => c.ops.some((o) => o[0] === 'update' && o[1].status === 'active'))
  it('wakesWaitingEnrolments', async () => {
    const db = fakeDb()
    const r = await onTemplateApproved(db, tpl, now)
    expect(r.woken).toBe(1)
    const wake = db.calls.find((c) => c.table === 'sequence_enrollments' && c.ops.some((o) => o[0] === 'update'))
    expect(wake.ops).toContainEqual(['update', { next_step_at: now.toISOString() }])
    expect(wake.ops).toContainEqual(['eq', 'status', 'active'])
    expect(wake.ops).toContainEqual(['eq', 'metadata->template_wait->>template_id', 't1'])
  })
  it('wakeNeverMatchesARowInsideAClaimLease', async () => {
    const db = fakeDb()
    await onTemplateApproved(db, tpl, now)
    expect(wakeOf(db).ops).toContainEqual(['gt', 'next_step_at', new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()])
  })
  it('approvalInQuietHoursWakesAndResumesAtTheEndOfQuietHours', async () => {
    // 22:30 Dublin (GMT in November), default quiet hours 21:00-08:00.
    const late = new Date('2026-11-06T22:30:00.000Z')
    const recentAt = new Date(late.getTime() - 3_600_000).toISOString()
    const db = fakeDb({ paused: [{ id: 'p1', last_processed_at: recentAt, recent: true }] })
    const r = await onTemplateApproved(db, tpl, late)
    expect(r.woken).toBe(1)
    expect(r.resumed).toBe(1)
    const next0800 = '2026-11-07T08:00:00.000Z'
    expect(wakeOf(db).ops).toContainEqual(['update', { next_step_at: next0800 }])
    // The lease floor is still now + lease, not the wake time.
    expect(wakeOf(db).ops).toContainEqual(['gt', 'next_step_at', new Date(late.getTime() + CLAIM_LEASE_MS).toISOString()])
    expect(resumeOf(db).ops.find((o) => o[0] === 'update')[1].next_step_at).toBe(next0800)
  })
  it('approvalInQuietHoursUsesTheStudioZoneAndItsOwnQuietHours', async () => {
    // 02:30 UTC = 21:30 New York (EST), studio quiet hours 20:00-07:00 →
    // 07:00 New York next morning = 12:00 UTC.
    const at = new Date('2026-11-07T02:30:00.000Z')
    const db = fakeDb({
      timezone: 'America/New_York',
      quiet: { send_quiet_hours_enabled: true, send_quiet_hours_start: 20, send_quiet_hours_end: 7 },
    })
    await onTemplateApproved(db, tpl, at)
    expect(wakeOf(db).ops).toContainEqual(['update', { next_step_at: '2026-11-07T12:00:00.000Z' }])
  })
  it('approvalInTheDayWakesNow', async () => {
    const day = new Date('2026-11-06T10:00:00.000Z')
    const db = fakeDb()
    await onTemplateApproved(db, tpl, day)
    expect(wakeOf(db).ops).toContainEqual(['update', { next_step_at: day.toISOString() }])
  })
  it('unreadableZoneWakesAndResumesNothing', async () => {
    const recentAt = new Date(now.getTime() - 3_600_000).toISOString()
    const db = fakeDb({ zoneError: 'boom', paused: [{ id: 'p1', last_processed_at: recentAt, recent: true }] })
    const r = await onTemplateApproved(db, tpl, now)
    expect(r).toEqual({ woken: 0, resumed: 0, leftPaused: 0, skippedWindowed: 0 })
    expect(db.calls.some((c) => c.ops.some((o) => o[0] === 'update'))).toBe(false)
    expect(logWarn).toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })
  it('unreadableQuietHoursWakesAndResumesNothing', async () => {
    const db = fakeDb({ quietError: 'boom' })
    const r = await onTemplateApproved(db, tpl, now)
    expect(r.woken).toBe(0)
    expect(db.calls.some((c) => c.ops.some((o) => o[0] === 'update'))).toBe(false)
    expect(logWarn).toHaveBeenCalled()
  })
  it('sequencesWithTheirOwnSendWindowAreLeftToTheScheduler', async () => {
    const db = fakeDb({ sequences: [
      { id: 'sW', send_window: { start_hour: 9, end_hour: 18 } },
      { id: 'sQ', send_window: {} },
    ] })
    const r = await onTemplateApproved(db, tpl, now)
    expect(r.skippedWindowed).toBe(1)
    for (const c of db.calls.filter((c) => c.table === 'sequence_enrollments' && c.ops.some((o) => o[0] === 'in' && o[1] === 'sequence_id'))) {
      expect(c.ops).toContainEqual(['in', 'sequence_id', ['sQ']])
    }
  })
  it('onlyWindowedSequencesTouchesNothing', async () => {
    const db = fakeDb({ sequences: [{ id: 'sW', send_window: { skip_days: [0] } }] })
    const r = await onTemplateApproved(db, tpl, now)
    expect(r).toEqual({ woken: 0, resumed: 0, leftPaused: 0, skippedWindowed: 1 })
    expect(db.calls.some((c) => c.table === 'sequence_enrollments')).toBe(false)
  })
  it('resumesRecentPausedOnly', async () => {
    const recentAt = new Date(now.getTime() - 2 * 3_600_000).toISOString()
    const oldAt = new Date(now.getTime() - 3 * 86_400_000).toISOString()
    const db = fakeDb({ woke: [], paused: [
      { id: 'p1', last_processed_at: recentAt, recent: true },
      { id: 'p2', last_processed_at: oldAt },
    ] })
    const r = await onTemplateApproved(db, tpl, now)
    expect(r).toEqual({ woken: 0, resumed: 1, leftPaused: 1, skippedWindowed: 0 })
    const resumes = db.calls.filter((c) => c.ops.some((o) => o[0] === 'update' && o[1].status === 'active'))
    expect(resumes).toHaveLength(1)
    expect(resumes[0].ops).toContainEqual(['in', 'id', ['p1']])
    expect(resumes[0].ops).toContainEqual(['eq', 'status', 'paused'])
    // The resume re-checks the stamp, not just the status.
    expect(resumes[0].ops).toContainEqual(['like', 'last_error', '[wa\\_tpl:t1] %'])
    const q = db.calls.find((c) => c.ops.some((o) => o[0] === 'like'))
    expect(q.ops).toContainEqual(['like', 'last_error', '[wa\\_tpl:t1] %'])
  })
  it('resumesOnlyAtTemplateStudio', async () => {
    const db = fakeDb({ sequences: [{ id: 'sA', send_window: null }, { id: 'sB', send_window: null }] })
    await onTemplateApproved(db, tpl, now)
    const seqQ = db.calls.find((c) => c.table === 'email_sequences')
    expect(seqQ.ops).toContainEqual(['eq', 'location_id', 'loc1'])
    for (const c of db.calls.filter((c) => c.table === 'sequence_enrollments' && c.ops.some((o) => o[0] === 'in' && o[1] === 'sequence_id'))) {
      expect(c.ops).toContainEqual(['in', 'sequence_id', ['sA', 'sB']])
    }
  })
  it('neverThrowsOnReadError', async () => {
    const r = await onTemplateApproved(fakeDb({ readError: 'boom' }), tpl, now)
    expect(r).toEqual({ woken: 0, resumed: 0, leftPaused: 0, skippedWindowed: 0 })
    expect(logError).toHaveBeenCalled()
  })
})
