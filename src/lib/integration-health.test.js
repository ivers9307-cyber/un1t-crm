import { describe, it, expect } from 'vitest'
import { cronStatus, waNumberStatus, backlogStatus, worstStatus, registryHealth, emailSendStatus, paymentStatus, zoomSyncStatus, ZOOM_RUN_GRACE_MS } from './integration-health.js'

describe('cronStatus', () => {
  it('ok when nothing is stale', () => {
    expect(cronStatus([{ name: 'a', is_stale: false }, { name: 'b', is_stale: false }]).status).toBe('ok')
  })
  it('down with worst lag + names when any is stale', () => {
    const s = cronStatus([{ name: 'a', is_stale: true, stale_seconds: 300 }, { name: 'b', is_stale: false }, { name: 'c', is_stale: true, stale_seconds: 900 }])
    expect(s.status).toBe('down')
    expect(s.staleCount).toBe(2)
    expect(s.worstLag).toBe(900)
    expect(s.staleNames).toEqual(['a', 'c'])
  })
  it('unknown with no rows', () => {
    expect(cronStatus([]).status).toBe('unknown')
    expect(cronStatus(null).status).toBe('unknown')
  })
})

describe('waNumberStatus', () => {
  it('down on invalid token (the silent-send-death case) — even if quality is green', () => {
    expect(waNumberStatus({ token_invalid_at: '2026-01-01', quality_rating: 'GREEN' }).status).toBe('down')
  })
  it('maps quality RED->down, YELLOW->warn, GREEN->ok', () => {
    expect(waNumberStatus({ quality_rating: 'RED' }).status).toBe('down')
    expect(waNumberStatus({ quality_rating: 'YELLOW' }).status).toBe('warn')
    expect(waNumberStatus({ quality_rating: 'GREEN' }).status).toBe('ok')
  })
  it('unknown for a missing number', () => {
    expect(waNumberStatus(null).status).toBe('unknown')
  })
})

describe('backlogStatus', () => {
  it('ok at 0, warn under 10, down at 10+', () => {
    expect(backlogStatus(0).status).toBe('ok')
    expect(backlogStatus(5).status).toBe('warn')
    expect(backlogStatus(25).status).toBe('down')
  })
})

describe('worstStatus', () => {
  it('rolls up to the most severe', () => {
    expect(worstStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'ok' }])).toBe('warn')
    expect(worstStatus([{ status: 'ok' }, { status: 'down' }, { status: 'warn' }])).toBe('down')
    expect(worstStatus([{ status: 'ok' }, { status: 'ok' }])).toBe('ok')
    expect(worstStatus([{ status: 'unknown' }, { status: 'ok' }])).toBe('unknown')
  })
})

describe('registryHealth', () => {
  it('maps the connection-registry vocabulary onto the pane vocabulary', () => {
    expect(registryHealth('connected')).toBe('ok')
    expect(registryHealth('action_needed')).toBe('warn')
    expect(registryHealth('error')).toBe('down')
    expect(registryHealth('not_connected')).toBe('unknown')
    expect(registryHealth(undefined)).toBe('unknown')
  })
})

describe('emailSendStatus', () => {
  it('ok with no traffic (no false alarm)', () => {
    expect(emailSendStatus({ total: 0 }).status).toBe('ok')
    expect(emailSendStatus().status).toBe('ok')
  })
  it('small samples do not grade the ratio — only a real complaint warns', () => {
    // 1 bounce of 3 = 33% but not meaningful → ok
    expect(emailSendStatus({ total: 3, bounced: 1 }).status).toBe('ok')
    expect(emailSendStatus({ total: 3, complained: 1 }).status).toBe('warn')
  })
  it('grades the bounce/complaint ratio above the sample floor', () => {
    expect(emailSendStatus({ total: 100, bounced: 2 }).status).toBe('ok')     // 2%
    expect(emailSendStatus({ total: 100, bounced: 7 }).status).toBe('warn')   // 7%
    expect(emailSendStatus({ total: 100, bounced: 20 }).status).toBe('down')  // 20%
    expect(emailSendStatus({ total: 100, bounced: 10, complained: 6 }).status).toBe('down') // 16%
  })
})

describe('paymentStatus', () => {
  it('ok with no payments (no news is good news)', () => {
    expect(paymentStatus({ total: 0 }).status).toBe('ok')
    expect(paymentStatus().status).toBe('ok')
  })
  it('small sample: only a real failure warns, abandonment is not counted here', () => {
    expect(paymentStatus({ total: 3, failed: 0 }).status).toBe('ok')
    expect(paymentStatus({ total: 3, failed: 1 }).status).toBe('warn')
  })
  it('grades the hard-failure ratio above the sample floor (tight thresholds)', () => {
    expect(paymentStatus({ total: 50, failed: 2 }).status).toBe('ok')    // 4%
    expect(paymentStatus({ total: 50, failed: 5 }).status).toBe('warn')  // 10%
    expect(paymentStatus({ total: 50, failed: 12 }).status).toBe('down') // 24%
  })
})

describe('zoomSyncStatus', () => {
  it('is unknown when the sync has never run', () => {
    expect(zoomSyncStatus(null).status).toBe('unknown')
  })

  it('is down when the last run errored', () => {
    const s = zoomSyncStatus({ error: 'zoom down', finished_at: '2026-08-06T04:30:00Z' })
    expect(s.status).toBe('down')
    expect(s.detail).toContain('zoom down')
  })

  it('is down when a run never finished', () => {
    expect(zoomSyncStatus({ started_at: '2026-08-05T04:30:00Z', finished_at: null }).status).toBe('down')
  })

  it('warns when the deletion guard tripped', () => {
    const s = zoomSyncStatus({ guard_tripped: true, guard_attempted: 400, guard_threshold: 20, finished_at: 'x' })
    expect(s.status).toBe('warn')
    expect(s.detail).toContain('400')
  })

  it('is ok after a clean run', () => {
    const s = zoomSyncStatus({ finished_at: 'x', creates: 12, updates: 1, deletes: 0, owned_in_zoom: 6330 })
    expect(s.status).toBe('ok')
    expect(s.detail).toContain('6330')
  })

  // A run that started 30 seconds ago also has a null finished_at — it is
  // still executing, not crashed. Reporting every in-flight sync as 'down'
  // is a false alarm on the one pane that exists to catch false negatives;
  // the query feeding this always hands zoomSyncStatus the newest non-dry
  // row, so a currently-running manual or cron trigger IS that row for the
  // whole time it executes (up to maxDuration=300s on both routes) — this
  // is not a rare theoretical case, it's the expected shape of "someone
  // checks the health pane right after clicking Run now".
  it('is NOT down for a run that is still in flight', () => {
    const recentlyStarted = new Date(Date.now() - 30_000).toISOString()
    const s = zoomSyncStatus({ started_at: recentlyStarted, finished_at: null })
    expect(s.status).not.toBe('down')
    expect(s.status).toBe('unknown')
  })

  // The boundary: a hair under the grace window still reads as in-flight...
  it('stays unknown just inside the run-grace window', () => {
    const started = new Date(Date.now() - (ZOOM_RUN_GRACE_MS - 5_000)).toISOString()
    expect(zoomSyncStatus({ started_at: started, finished_at: null }).status).toBe('unknown')
  })

  // ...and just past it, the same null finished_at is correctly a crash.
  it('is down once a run without finished_at is older than the grace window', () => {
    const started = new Date(Date.now() - (ZOOM_RUN_GRACE_MS + 5_000)).toISOString()
    expect(zoomSyncStatus({ started_at: started, finished_at: null }).status).toBe('down')
  })

  // No started_at to reason from at all: nothing supports "still running", so
  // this falls back to the original crashed reading rather than staying
  // unknown forever on bad data.
  it('is down when finished_at is null and started_at is missing entirely', () => {
    expect(zoomSyncStatus({ finished_at: null }).status).toBe('down')
  })
})
