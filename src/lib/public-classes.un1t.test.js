// UN1TWRITE.16 — the public class list at a un1t.online studio.
//
// HATCHSTART.1 (2026-10-18) already lists un1t_events at every un1t.online
// studio, with event_id 'un1t:' + the un1t.online id, whatever funnel_enabled
// says (public-classes.test.js pins the filters: scheduled, open, minimum
// notice, not full, the deny-list, PUBLIC_CLASS_KEYS, the error codes). What
// plan D Task 16 adds on top is only that the switch never changes the list:
// one id form for both paths, so a request filed before the switch flips
// still names a class the processor can find, and the write primitives get
// the bare id from un1tEventIdOf (Task 22).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: null, apiKey: null, apiToken: null, readError: null })),
  missingGlofoxCredentialsForLocation: vi.fn(() => ['Branch ID', 'API Key', 'API Token']),
  fetchUpcomingEvents: vi.fn(),
}))
vi.mock('@/lib/location-time', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocationZone: vi.fn(async () => 'Europe/Dublin'),
}))

import { readPublicClasses, PUBLIC_CLASS_KEYS } from './public-classes'
import { un1tEventIdOf } from './manual-timetable'
import { fetchUpcomingEvents } from '@/lib/glofox'

const HOUR = 3_600_000
const START = new Date(Date.now() + 24 * HOUR).toISOString()

function db(settings) {
  const events = { data: [{ un1t_id: 'u-1', title: 'RALLY', starts_at: START, capacity: 0, bookings_count: 0 }], error: null }
  return {
    from(table) {
      const b = {
        select: () => b, eq: () => b, gt: () => b, lt: () => b, order: () => b,
        limit: () => Promise.resolve(events),
        maybeSingle: async () => (table === 'locations'
          ? { data: { membership_source: 'un1t_online', settings }, error: null }
          : { data: { blocks: [{ type: 'class_funnel', min_notice_hours: 1 }] }, error: null }),
      }
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('UN1TWRITE.16 — the un1t.online listing does not depend on the funnel switch', () => {
  it('funnel on, funnel off and writes off list the same classes with the same un1t: ids', async () => {
    const off = await readPublicClasses(db({}), 'HATCH', 7)
    const writesOnly = await readPublicClasses(db({ un1t_online: { writes_enabled: true } }), 'HATCH', 7)
    const on = await readPublicClasses(db({ un1t_online: { writes_enabled: true, funnel_enabled: true } }), 'HATCH', 7)
    expect(on.error).toBeNull()
    expect(on.classes.map((c) => c.event_id)).toEqual(['un1t:u-1'])
    expect(off.classes).toEqual(on.classes)
    expect(writesOnly.classes).toEqual(on.classes)
    expect(Object.keys(on.classes[0]).sort()).toEqual([...PUBLIC_CLASS_KEYS].sort())
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })
})

describe('un1tEventIdOf', () => {
  it('strips the un1t: prefix and refuses anything else', () => {
    expect(un1tEventIdOf('un1t:7f3a-1')).toBe('7f3a-1')
    expect(un1tEventIdOf('un1t:')).toBeNull()
    expect(un1tEventIdOf('manual-20261020-0615-strength')).toBeNull()
    expect(un1tEventIdOf('7f3a-1')).toBeNull()
    expect(un1tEventIdOf(null)).toBeNull()
  })
})
