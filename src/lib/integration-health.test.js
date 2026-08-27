import { describe, it, expect } from 'vitest'
import { cronStatus, emailInboundStatus, waNumberStatus, backlogStatus, worstStatus, registryHealth, emailSendStatus, paymentStatus, zoomSyncStatus, ZOOM_RUN_GRACE_MS, getIntegrationHealth } from './integration-health.js'

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

// EMAIL-MONITOR.1 (2026-08-08 audit, production-readiness P1): "is mail still
// ARRIVING?" — the question nothing answered for the fourteen months the
// inbound webhook 500'd on every delivery. Graded per mailbox so one busy
// address cannot mask a dead one, thresholds scaled to observed volume so a
// quiet-by-nature mailbox doesn't cry wolf, and rehost_failed folded in
// because a spike there is exactly how the shim's storage bug hid (#1268).
describe('emailInboundStatus', () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-08-08T12:00:00Z')
  const MB = { id: 'mb-1', address: 'accounts@hatchstreetfitness.com' }
  const MB2 = { id: 'mb-2', address: 'studio@hatchstreetfitness.com' }
  // n arrivals for a mailbox, newest `quietDays` ago, spread daily before that.
  const arrivals = (mailboxId, n, quietDays) =>
    Array.from({ length: n }, (_, i) => ({
      mailboxId,
      createdAt: new Date(NOW - (quietDays + i) * DAY).toISOString(),
    }))

  it('a busy mailbox heard from recently is ok, and reports the last arrival', () => {
    const s = emailInboundStatus({ mailboxes: [MB], inbound: arrivals('mb-1', 10, 0.1), now: NOW })
    expect(s.status).toBe('ok')
    expect(s.detail).toMatch(/last inbound/i)
    expect(s.lastInboundAt).toBe(new Date(NOW - 0.1 * DAY).toISOString())
  })

  it('a busy mailbox quiet for 8 days is warn, naming the address and the gap', () => {
    const s = emailInboundStatus({ mailboxes: [MB], inbound: arrivals('mb-1', 10, 8), now: NOW })
    expect(s.status).toBe('warn')
    expect(s.detail).toContain(MB.address)
    expect(s.detail).toMatch(/8d/)
  })

  it('a busy mailbox quiet for 15 days is down', () => {
    const s = emailInboundStatus({ mailboxes: [MB], inbound: arrivals('mb-1', 10, 15), now: NOW })
    expect(s.status).toBe('down')
  })

  it('an occasional mailbox gets looser thresholds — 15d quiet is only warn, 29d is down', () => {
    expect(emailInboundStatus({ mailboxes: [MB], inbound: arrivals('mb-1', 3, 15), now: NOW }).status).toBe('warn')
    expect(emailInboundStatus({ mailboxes: [MB], inbound: arrivals('mb-1', 3, 29), now: NOW }).status).toBe('down')
  })

  it('a mailbox with NO inbound in the window is unknown, not red — it may be new or quiet by nature', () => {
    const s = emailInboundStatus({ mailboxes: [MB], inbound: [], now: NOW })
    expect(s.status).toBe('unknown')
    expect(s.detail).toMatch(/no inbound/i)
  })

  it('one healthy mailbox cannot mask a dead one — worst status wins, only the offender is named', () => {
    const s = emailInboundStatus({
      mailboxes: [MB, MB2],
      inbound: [...arrivals('mb-1', 10, 15), ...arrivals('mb-2', 10, 0.2)],
      now: NOW,
    })
    expect(s.status).toBe('down')
    expect(s.detail).toContain(MB.address)
    expect(s.detail).not.toContain(MB2.address)
  })

  it('rehost failures escalate a healthy row — a spike is how the shim bug hid (#1268)', () => {
    const healthy = { mailboxes: [MB], inbound: arrivals('mb-1', 10, 0.1), now: NOW }
    expect(emailInboundStatus({ ...healthy, rehostFailed24h: 3 }).status).toBe('warn')
    expect(emailInboundStatus({ ...healthy, rehostFailed24h: 3 }).detail).toMatch(/re-?host/i)
    expect(emailInboundStatus({ ...healthy, rehostFailed24h: 12 }).status).toBe('down')
  })

  it('tolerates empty input', () => {
    expect(emailInboundStatus({ now: NOW }).status).toBe('unknown')
  })

  // MAILBOX-UNREACHABLE.1 — the branch that separates "quiet" from "cannot
  // possibly receive". Everything above this comment must keep behaving
  // exactly as it did, which is why every case here passes `reachability`
  // explicitly and none of the ones above do.
  describe('an address whose domain does not deliver here', () => {
    const DEAD = { id: 'mb-dead', address: 'stillorgan@un1t.com', is_default: true }
    const DEAD_SPARE = { id: 'mb-dead', address: 'old@un1t.com', is_default: false }
    const unreachable = { 'mb-dead': { state: 'unreachable' } }

    it('is DOWN when it is the studio default — members are told to reply there', () => {
      const s = emailInboundStatus({ mailboxes: [DEAD], inbound: [], reachability: unreachable, now: NOW })
      expect(s.status).toBe('down')
      expect(s.detail).toContain('stillorgan@un1t.com')
      expect(s.detail).toMatch(/cannot receive/)
      expect(s.detail).toMatch(/studio default/)
    })

    it('is WARN when nobody is pointed at it — a configuration gap, not a broken channel', () => {
      const s = emailInboundStatus({ mailboxes: [DEAD_SPARE], inbound: [], reachability: unreachable, now: NOW })
      expect(s.status).toBe('warn')
      expect(s.detail).not.toMatch(/studio default/)
    })

    it('says the CAUSE, never "quiet Nd" — that would send someone hunting an outage', () => {
      const s = emailInboundStatus({ mailboxes: [DEAD], inbound: [], reachability: unreachable, now: NOW })
      expect(s.detail).not.toMatch(/quiet/)
    })

    it('cannot be masked by a healthy sibling', () => {
      const s = emailInboundStatus({
        mailboxes: [MB, DEAD],
        inbound: arrivals('mb-1', 10, 0.1),
        reachability: unreachable,
        now: NOW,
      })
      expect(s.status).toBe('down')
    })

    // 🔴 THE ANTI-CRY-WOLF PROPERTY. A reachable mailbox with no mail at all
    // must stay 'unknown' — grey, not red. If this ever flips, the row stops
    // being read and the case above stops mattering.
    it('leaves a REACHABLE mailbox with zero arrivals exactly as it was', () => {
      const s = emailInboundStatus({
        mailboxes: [MB], inbound: [], reachability: { 'mb-1': { state: 'ok' } }, now: NOW,
      })
      expect(s.status).toBe('unknown')
    })

    it('an unreadable DNS answer changes nothing', () => {
      const s = emailInboundStatus({
        mailboxes: [MB], inbound: [], reachability: { 'mb-1': { state: 'unknown' } }, now: NOW,
      })
      expect(s.status).toBe('unknown')
    })

    it('an indirect (forwarded) mailbox is graded on arrivals like any other', () => {
      const s = emailInboundStatus({
        mailboxes: [MB], inbound: arrivals('mb-1', 10, 0.1),
        reachability: { 'mb-1': { state: 'indirect' } }, now: NOW,
      })
      expect(s.status).toBe('ok')
    })
  })
})

// ── getIntegrationHealth — the webhook dead-letter block (DEADLETTER-LOC.1) ──
//
// Aggregator-level, with a minimal chainable fake: the property under test is
// the QUERY SHAPE — NULL-location rows (unroutable inbound mail, events whose
// send can't be found) must be counted at every location, because a strict
// .eq() filter made them invisible in the one pane operators check. Every
// other block degrades to 'unknown' against this fake, which is fine — only
// the webhooks row is asserted.

function makeHealthDb(results = {}, calls = []) {
  return {
    from(table) {
      const res = results[table] ?? { data: null, count: null, error: null }
      const b = {}
      for (const m of ['select', 'eq', 'is', 'or', 'not', 'gte', 'order', 'limit', 'in']) {
        b[m] = (...args) => { calls.push([table, m, ...args]); return b }
      }
      b.maybeSingle = () => Promise.resolve(res)
      b.single = () => Promise.resolve(res)
      b.then = (resolve, reject) => Promise.resolve(res).then(resolve, reject)
      return b
    },
  }
}

describe('getIntegrationHealth — webhook dead-letter count', () => {
  it('counts NULL-location rows alongside the location’s own, unresolved only', async () => {
    const calls = []
    const db = makeHealthDb({ webhook_dead_letter: { count: 3, error: null } }, calls)

    const rows = await getIntegrationHealth(db, 'loc-1')
    const wh = rows.find((r) => r.key === 'webhooks')

    expect(wh.status).toBe('warn')
    expect(wh.detail).toBe('3 unresolved')
    const orCall = calls.find((c) => c[0] === 'webhook_dead_letter' && c[1] === 'or')
    expect(orCall?.[2]).toBe('location_id.eq.loc-1,location_id.is.null')
    expect(calls.some((c) => c[0] === 'webhook_dead_letter' && c[1] === 'is' && c[2] === 'resolved_at' && c[3] === null)).toBe(true)
  })

  it('attaches the dead-letter page as the runbook when degraded', async () => {
    const db = makeHealthDb({ webhook_dead_letter: { count: 12, error: null } })
    const rows = await getIntegrationHealth(db, 'loc-1')
    const wh = rows.find((r) => r.key === 'webhooks')
    expect(wh.status).toBe('down')
    expect(wh.href).toBe('/admin/webhook-dead-letter')
    expect(wh.remedy).toBeTruthy()
  })

  it('degrades to unknown — never a green lie — when the count query errors', async () => {
    // A failed count used to read back as `count: null` → 0 → 'ok'.
    const db = makeHealthDb({ webhook_dead_letter: { count: null, error: { message: 'boom' } } })
    const rows = await getIntegrationHealth(db, 'loc-1')
    const wh = rows.find((r) => r.key === 'webhooks')
    expect(wh.status).toBe('unknown')
    expect(wh.detail).toBe('Unavailable')
  })
})
