import { describe, it, expect, vi } from 'vitest'
import { runAttributionHealthSweep, isDublinSunday } from './hr-attribution-sweep'

// Minimal chainable query mock: every builder method returns the chain, and
// awaiting it resolves to the canned {data, error} for its table.
function chainFor(result) {
  const chain = {
    then: (resolve) => resolve(result),
  }
  for (const m of ['select', 'eq', 'gte', 'lt', 'limit', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain)
  }
  return chain
}

const mkDb = (byTable) => ({
  from: vi.fn((table) => {
    if (!(table in byTable)) throw new Error(`unexpected table ${table}`)
    return chainFor(byTable[table])
  }),
})

describe('isDublinSunday', () => {
  it('knows 2026-08-16 is a Sunday and 2026-08-14 is not', () => {
    expect(isDublinSunday(Date.parse('2026-08-16T20:45:00Z'))).toBe(true)
    expect(isDublinSunday(Date.parse('2026-08-14T20:45:00Z'))).toBe(false)
  })

  it('a late Dublin-summer evening near UTC midnight is still the Dublin day', () => {
    // 23:30 UTC Saturday = 00:30 Sunday Dublin (IST, UTC+1).
    expect(isDublinSunday(Date.parse('2026-08-15T23:30:00Z'))).toBe(true)
  })
})

describe('runAttributionHealthSweep', () => {
  const NOW = Date.parse('2026-08-14T20:45:00Z') // Friday — daily only

  it('no registrations: clean skip, no reads of visits needed, ok:true', async () => {
    const db = mkDb({ contact_devices: { data: [], error: null } })
    const out = await runAttributionHealthSweep({ db, nowMs: NOW, dry: true })
    expect(out.ok).toBe(true)
    expect(out.daily.skipped).toBe('no-registrations')
    expect(out.weekly).toBeUndefined() // Friday
  })

  it('dry run finds a break but sends nothing (no locations read)', async () => {
    const db = mkDb({
      contact_devices: { data: [{ identifier: 'ant:12511', contact_id: 'c-1' }], error: null },
      hr_detection_visits: {
        data: [{
          device_key: 'ant:12511', location_id: 'loc-1',
          started_at: '2026-08-14T18:05:00Z', last_sample_at: '2026-08-14T18:50:00Z',
          sample_count: 2400, class_name: 'UN1T Class', glofox_event_id: 'ev-1',
        }],
        error: null,
      },
      heart_rate_sessions: { data: [], error: null },
    })
    const out = await runAttributionHealthSweep({ db, nowMs: NOW, dry: true })
    expect(out.ok).toBe(true)
    expect(out.daily.breaks).toHaveLength(1)
    // dry never touches locations/ops-alerts — mkDb would have thrown on
    // an unexpected `locations` read.
  })

  it('a failed read reports ok:false instead of throwing', async () => {
    const db = mkDb({ contact_devices: { data: null, error: { message: 'boom' } } })
    const out = await runAttributionHealthSweep({ db, nowMs: NOW, dry: true })
    expect(out.ok).toBe(false)
    expect(out.daily.error).toMatch(/contact_devices/)
  })

  it('forceWeekly runs the weekly section on a Friday (dry)', async () => {
    const db = mkDb({
      contact_devices: { data: [{ identifier: 'ant:12511', contact_id: 'c-1', added_by_contact: true, created_at: '2026-08-13T10:00:00Z' }], error: null },
      hr_detection_visits: { data: [], error: null },
      heart_rate_sessions: { data: [{ id: 's-1', contact_id: 'c-1' }], error: null },
      hr_samples: { data: null, error: null, count: 1234 },
    })
    const out = await runAttributionHealthSweep({ db, nowMs: NOW, dry: true, forceWeekly: true })
    expect(out.ok).toBe(true)
    expect(out.weekly.current.attributed).toBe(1)
    expect(out.weekly.gate.freezeLifted).toBe(false)
  })
})
