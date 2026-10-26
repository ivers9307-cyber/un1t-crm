import { describe, it, expect } from 'vitest'
import { createUsageTracker, MAX_PENDING_BATCHES } from './usage-tracker.js'

const T0 = Date.UTC(2026, 9, 26, 9, 0, 0)
const iso = (ms) => new Date(ms).toISOString()

function tracker(opts = {}) {
  let n = 0
  return createUsageTracker({ platform: 'web', newId: () => `id-${++n}`, ...opts })
}

describe('createUsageTracker', () => {
  it('splits visits at a feature change and ends the open visit at now', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.screen('inbox', T0 + 60_000)
    const batch = t.drain(T0 + 90_000)
    expect(batch.session).toMatchObject({ platform: 'web', started_at: iso(T0), ended_at: iso(T0 + 90_000) })
    expect(batch.visits.map((v) => [v.feature, v.started_at, v.ended_at])).toEqual([
      ['contacts', iso(T0), iso(T0 + 60_000)],
      ['inbox', iso(T0 + 60_000), iso(T0 + 90_000)],
    ])
  })

  it('re-sends the open visit with the same id and a later end', () => {
    const t = tracker()
    t.screen('contacts', T0)
    const first = t.drain(T0 + 60_000)
    const second = t.drain(T0 + 120_000)
    expect(second.session.id).toBe(first.session.id)
    expect(second.visits).toHaveLength(1)
    expect(second.visits[0].id).toBe(first.visits[0].id)
    expect(second.visits[0].ended_at).toBe(iso(T0 + 120_000))
  })

  it('does not re-send a closed visit after it was drained', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.screen('inbox', T0 + 60_000)
    t.drain(T0 + 70_000)
    const next = t.drain(T0 + 80_000)
    expect(next.visits.map((v) => v.feature)).toEqual(['inbox'])
  })

  it('merges consecutive screens of the same feature', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.screen('contacts', T0 + 5_000)
    expect(t.drain(T0 + 10_000).visits).toHaveLength(1)
  })

  it('drops a visit shorter than 2 s and carries on across a bounce', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.screen('inbox', T0 + 10_000)
    t.screen('contacts', T0 + 11_000)
    const visits = t.drain(T0 + 30_000).visits
    expect(visits.map((v) => [v.feature, v.started_at, v.ended_at])).toEqual([
      ['contacts', iso(T0), iso(T0 + 30_000)],
    ])
  })

  it('drops a short visit with nothing to carry on', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.screen('inbox', T0 + 1_000)
    t.screen('email', T0 + 20_000)
    expect(t.drain(T0 + 30_000).visits.map((v) => v.feature)).toEqual(['inbox', 'email'])
  })

  it('caps a visit at 4 h', () => {
    const t = tracker()
    t.screen('contacts', T0)
    const v = t.drain(T0 + 6 * 3600_000).visits[0]
    expect(Date.parse(v.ended_at) - Date.parse(v.started_at)).toBe(4 * 3600_000)
  })

  it('ignores an unknown feature by filing it under other', () => {
    const t = tracker()
    t.screen('made-up', T0)
    expect(t.drain(T0 + 10_000).visits[0].feature).toBe('other')
  })

  it('pause ends the session onto the queue and resume starts a new one', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.pause(T0 + 60_000)
    expect(t.drain(T0 + 300_000)).toBeNull()
    const [closed] = t.takePending()
    expect(closed.session.ended_at).toBe(iso(T0 + 60_000))
    expect(closed.visits[0].ended_at).toBe(iso(T0 + 60_000))
    t.screen('inbox', T0 + 400_000) // navigated while hidden: remembered, not timed
    t.resume(T0 + 500_000)
    const reopened = t.drain(T0 + 560_000)
    expect(reopened.session.id).not.toBe(closed.session.id)
    expect(reopened.session.started_at).toBe(iso(T0 + 500_000))
    expect(reopened.visits).toHaveLength(1)
    expect(reopened.visits[0]).toMatchObject({ feature: 'inbox', started_at: iso(T0 + 500_000) })
  })

  it('pause and resume twice are no-ops', () => {
    const t = tracker()
    t.screen('contacts', T0)
    t.pause(T0 + 10_000)
    t.pause(T0 + 20_000)
    expect(t.takePending()).toHaveLength(1)
    t.resume(T0 + 30_000)
    const id = t.drain(T0 + 40_000).session.id
    t.resume(T0 + 50_000)
    expect(t.drain(T0 + 60_000).session.id).toBe(id)
  })

  it('returns null before any screen', () => {
    expect(tracker().drain(T0)).toBeNull()
  })

  it('keeps at most 10 unsent batches, dropping the oldest', () => {
    const t = tracker()
    for (let i = 0; i < MAX_PENDING_BATCHES + 2; i++) t.requeue({ session: { id: `s${i}` }, visits: [] })
    const pending = t.pending()
    expect(pending).toHaveLength(MAX_PENDING_BATCHES)
    expect(pending[0].session.id).toBe('s2')
  })

  it('takePending empties the queue', () => {
    const t = tracker()
    t.requeue({ session: { id: 'a' }, visits: [] })
    expect(t.takePending()).toHaveLength(1)
    expect(t.pending()).toHaveLength(0)
  })

  it('carries app_version on the session', () => {
    const t = tracker({ platform: 'phone', appVersion: '2.3.4' })
    t.screen('home', T0)
    expect(t.drain(T0 + 5_000).session).toMatchObject({ platform: 'phone', app_version: '2.3.4' })
  })
})
