import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
// SHELLYEVENTS.3 — the studio's hold setting is its own module (event-hold.test.js);
// here it answers the default unless a test says otherwise.
const loadEventHoldMinutes = vi.fn(async () => ({ ok: true, minutes: 120 }))
vi.mock('@/lib/event-hold', async (importOriginal) => ({
  ...(await importOriginal()),
  loadEventHoldMinutes: (...a) => loadEventHoldMinutes(...a),
}))

import { eventToOccurrence, eventToSessions, holdMinutes, loadDayEvents, loadEventSessionsBetween, DEFAULT_EVENT_MINUTES, MAX_DAY_EVENTS } from './studio-events'
import { resolveDayWindows } from '@/lib/schedule/desired-state'

const TZ = 'Europe/Dublin'

function makeDb({ rows = [], error = null } = {}) {
  const calls = []
  const self = { calls, then: (ok, err) => Promise.resolve({ data: error ? null : rows, error }).then(ok, err) }
  for (const m of ['select', 'eq', 'or', 'gte', 'lte', 'order', 'limit']) self[m] = (...a) => { calls.push([m, a]); return self }
  return { calls, from: (t) => { calls.push(['from', [t]]); return self } }
}

describe('eventToOccurrence', () => {
  it('runs from the first start time to the default length after the last', () => {
    // 14 Nov 2026 is winter time in Dublin: wall clock = UTC.
    const occ = eventToOccurrence({ name: 'PTC', race_date: '2026-11-14', waves: [{ start_time: '12:15:00' }, { start_time: '10:30:00' }] }, TZ)
    expect(occ).toEqual({
      starts_at: '2026-11-14T10:30:00.000Z',
      ends_at: '2026-11-14T14:15:00.000Z',
      cancelled_at: null,
      name: 'PTC',
      kind: 'event',
    })
    expect(DEFAULT_EVENT_MINUTES).toBe(120)
  })

  it('a longer event length wins over the studio hold; the studio wall clock in summer', () => {
    const occ = eventToOccurrence({ race_date: '2026-07-11', duration_minutes: 240, waves: [{ start_time: '10:00:00' }] }, TZ)
    expect(occ.starts_at).toBe('2026-07-11T09:00:00.000Z')
    expect(occ.ends_at).toBe('2026-07-11T13:00:00.000Z')
  })

  it('falls back to the event start time when it has no waves', () => {
    const occ = eventToOccurrence({ race_date: '2026-11-14', start_time: '18:00:00', waves: [] }, TZ)
    expect(occ.starts_at).toBe('2026-11-14T18:00:00.000Z')
  })

  it('gives nothing for an event with no date or no start time', () => {
    expect(eventToOccurrence({ race_date: null, waves: [{ start_time: '10:00:00' }] }, TZ)).toBeNull()
    expect(eventToOccurrence({ race_date: '2026-11-14', start_time: null, waves: [] }, TZ)).toBeNull()
  })

  it('holds a class-mode group on across the event, with its lead and lag', () => {
    const occ = eventToOccurrence({ race_date: '2026-11-14', waves: [{ start_time: '10:30:00' }, { start_time: '12:15:00' }] }, TZ)
    const group = { enabled: true, schedule_mode: 'class', class_rule: { lead_min: 30, lag_min: 45, merge_gap_min: 30 } }
    const windows = resolveDayWindows(group, '2026-11-14', [occ], TZ)
    expect(windows.map((w) => [new Date(w.on_at).toISOString(), new Date(w.off_at).toISOString()])).toEqual([
      ['2026-11-14T10:00:00.000Z', '2026-11-14T15:00:00.000Z'],
    ])
  })
})

describe('loadDayEvents', () => {
  it('asks for published, active events held at the studio that day', async () => {
    const db = makeDb({ rows: [{ id: 'e1', name: 'PTC', race_date: '2026-11-14', waves: [{ start_time: '10:30:00' }] }] })
    const out = await loadDayEvents(db, 'loc-A', TZ, '2026-11-14')
    expect(out.ok).toBe(true)
    expect(out.occurrences).toHaveLength(1)
    expect(db.calls).toContainEqual(['from', ['race_events']])
    expect(db.calls).toContainEqual(['eq', ['race_date', '2026-11-14']])
    expect(db.calls).toContainEqual(['eq', ['active', true]])
    expect(db.calls).toContainEqual(['eq', ['status', 'published']])
    expect(db.calls).toContainEqual(['eq', ['held_offsite', false]])
    expect(db.calls).toContainEqual(['or', ['venue_location_id.eq.loc-A,and(location_id.eq.loc-A,host_id.is.null,venue_location_id.is.null)']])
    expect(db.calls).toContainEqual(['limit', [MAX_DAY_EVENTS + 1]])
  })

  it('reports a failed read as a failure, never as no events', async () => {
    const db = makeDb({ error: { message: 'pg down' } })
    expect(await loadDayEvents(db, 'loc-A', TZ, '2026-11-14')).toEqual({ ok: false, error: 'pg down' })
  })

  it('skips an event with no start time', async () => {
    const db = makeDb({ rows: [{ id: 'e1', race_date: '2026-11-14', start_time: null, waves: [] }] })
    expect(await loadDayEvents(db, 'loc-A', TZ, '2026-11-14')).toEqual({ ok: true, occurrences: [] })
  })
})

describe('holdMinutes — the studio setting, or a longer event (SHELLYEVENTS.3)', () => {
  it('is the studio hold, the default when none is given, and never shorter than the event', () => {
    expect(holdMinutes({}, 180)).toBe(180)
    expect(holdMinutes({ duration_minutes: 45 }, 180)).toBe(180)
    expect(holdMinutes({ duration_minutes: 240 }, 180)).toBe(240)
    expect(holdMinutes({})).toBe(120)
    expect(holdMinutes({ duration_minutes: 45 })).toBe(120)
    expect(holdMinutes({ duration_minutes: -5 }, 0)).toBe(120)
  })

  it('the per-event studio_hold_minutes column is no longer read', () => {
    expect(holdMinutes({ studio_hold_minutes: 600 }, 180)).toBe(180)
  })

  it('loadDayEvents holds for the studio setting', async () => {
    loadEventHoldMinutes.mockResolvedValueOnce({ ok: true, minutes: 180 })
    const db = makeDb({ rows: [{ id: 'e1', name: 'PTC', race_date: '2026-12-05', duration_minutes: null, waves: [{ start_time: '10:30:00' }] }] })
    const out = await loadDayEvents(db, 'loc-A', TZ, '2026-12-05')
    expect(out.occurrences[0].ends_at).toBe('2026-12-05T13:30:00.000Z')
    expect(loadEventHoldMinutes).toHaveBeenCalledWith(db, 'loc-A')
  })

  it('an unreadable setting fails the load, for the timers and for the climate runners', async () => {
    loadEventHoldMinutes.mockResolvedValue({ ok: false, error: 'pg down' })
    const db = makeDb({ rows: [] })
    expect(await loadDayEvents(db, 'loc-A', TZ, '2026-12-05')).toEqual({ ok: false, error: 'event hold setting: pg down' })
    expect(await loadEventSessionsBetween(db, 'loc-A', TZ, 1, 2)).toEqual({ ok: false, error: 'event hold setting: pg down' })
    loadEventHoldMinutes.mockResolvedValue({ ok: true, minutes: 120 })
  })
})

describe('eventToSessions / loadEventSessionsBetween — the climate shape', () => {
  const event = { id: 'e1', name: 'PTC', race_date: '2026-11-14', waves: [{ start_time: '12:15:00' }, { start_time: '10:30:00' }] }

  it('gives one keyed span per session, in time order', () => {
    expect(eventToSessions(event, TZ)).toEqual([
      { glofox_event_id: 'event:e1:10:30', name: 'PTC', starts_at: '2026-11-14T10:30:00.000Z', ends_at: '2026-11-14T12:30:00.000Z', kind: 'event' },
      { glofox_event_id: 'event:e1:12:15', name: 'PTC', starts_at: '2026-11-14T12:15:00.000Z', ends_at: '2026-11-14T14:15:00.000Z', kind: 'event' },
    ])
  })

  it('keeps only the sessions that start inside the window', async () => {
    const db = makeDb({ rows: [event] })
    const out = await loadEventSessionsBetween(db, 'loc-A', TZ, Date.parse('2026-11-14T11:00:00Z'), Date.parse('2026-11-14T17:00:00Z'))
    expect(out.ok).toBe(true)
    expect(out.occurrences.map((o) => o.glofox_event_id)).toEqual(['event:e1:12:15'])
    expect(db.calls).toContainEqual(['gte', ['race_date', '2026-11-14']])
    expect(db.calls).toContainEqual(['lte', ['race_date', '2026-11-14']])
    expect(db.calls).toContainEqual(['eq', ['held_offsite', false]])
  })

  it('reports a failed read as a failure', async () => {
    const db = makeDb({ error: { message: 'pg down' } })
    expect(await loadEventSessionsBetween(db, 'loc-A', TZ, 1, 2)).toEqual({ ok: false, error: 'pg down' })
  })
})
