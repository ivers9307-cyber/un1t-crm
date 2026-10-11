// TZ.6 — the daily-slot gate (D6 = B). The host zone is neither of the zones
// under test, so nothing here can pass by reading the host clock.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { gateDailySlot, dailySlotDue, DAILY_SLOTS, SLOT_CATCHUP_HOURS, LEGACY_UTC_ANCHORED, NO_LOCATION, slotFor, isLegacyAnchored, catchUpHoursFor, slotTickStampable } =
  await import('./cron-daily-slot.js')
const { slotTables } = await import('./cron-daily-slot.test-helpers.js')
const { instantToZonedParts, dayStrIn } = await import('./location-time.js')
const { logError, logWarn } = await import('@/lib/log')

const HOUR = 3600_000
const at = (iso) => Date.parse(iso)
const DUB = { id: 'loc-dub', timezone: 'Europe/Dublin' }
const NY = { id: 'loc-ny', timezone: 'America/New_York' }

// The pre-TZ.6 vercel.json entries, frozen: [minute, UTC hour, cron day-of-week or null].
const LEGACY_SCHEDULE = {
  'equipment-inspection-reminder': [0, 6, null],
  'morning-briefing': [0, 6, 1],
  'ad-report-email': [0, 7, null],
  'churn-radar-digest': [0, 7, 1],
  'run-scheduled-reports': [0, 7, null],
  'contract-reminders': [0, 8, null],
  // The arms of contract-reminders: they ran on its 08:00 UTC tick.
  'roster-runway': [0, 8, null],
  'qualification-digest': [0, 8, null],
  'run-challenge-events': [0, 8, null],
  'receipt-coverage-weekly': 'friday-08-dublin', // 0 7 * * 5 + 0 8 * * 5, Dublin-hour gate
  'event-reminders': [0, 9, null],
  'notify-winback': [0, 10, null],
  'notify-onboarding-pace': [30, 10, null],
  'notify-streak-at-risk': [0, 11, null],
  'equipment-inspection-sweep': [0, 19, null],
}
const minuteOf = (cron) => (Array.isArray(LEGACY_SCHEDULE[cron]) ? LEGACY_SCHEDULE[cron][0] : 0)

/** Every instant the pre-TZ.6 schedule ACTED in 2026 for a Dublin studio. */
function legacyActs(cron) {
  const out = []
  for (let ms = at('2026-01-01T00:00:00Z'); ms < at('2027-01-01T00:00:00Z'); ms += HOUR) {
    const d = new Date(ms)
    const spec = LEGACY_SCHEDULE[cron]
    if (spec === 'friday-08-dublin') {
      // Fired at 07:00 and 08:00 UTC on Fridays; acted on the one whose Dublin hour is 8.
      if (d.getUTCDay() === 5 && (d.getUTCHours() === 7 || d.getUTCHours() === 8) && instantToZonedParts(ms, 'Europe/Dublin').h === 8) out.push(ms)
      continue
    }
    const [m, h, dow] = spec
    if (d.getUTCHours() === h && (dow == null || d.getUTCDay() === dow)) out.push(ms + m * 60_000)
  }
  return out
}

/** Run the gate at every hourly tick of 2026 (at the cron's minute); the ticks where `locationId` acted. */
async function simulateYear(cron, locations, locationId) {
  const t = slotTables({ locations })
  const acted = []
  const days = []
  for (let ms = at('2026-01-01T00:00:00Z') + minuteOf(cron) * 60_000; ms < at('2027-01-01T00:00:00Z'); ms += HOUR) {
    const { slots } = await gateDailySlot({ from: t.from }, cron, { nowMs: ms })
    const s = slotFor(slots, locationId)
    if (s) { acted.push(ms); days.push(s.day) }
  }
  return { acted, days }
}

beforeEach(() => vi.clearAllMocks())

describe('TZ.6 slot table', () => {
  it('covers exactly the D6 list, and every slot (+ a non-Dublin catch-up) stays inside the UTC day Dublin shares', () => {
    expect(Object.keys(DAILY_SLOTS).sort()).toEqual(Object.keys(LEGACY_SCHEDULE).sort())
    for (const slot of Object.values(DAILY_SLOTS)) expect(slot.hour + SLOT_CATCHUP_HOURS).toBeLessThanOrEqual(21)
    expect([...LEGACY_UTC_ANCHORED]).toEqual(['Europe/Dublin'])
  })

  it('vercel.json runs every converted cron hourly at its legacy minute, once', async () => {
    const { readFileSync } = await import('node:fs')
    const crons = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).crons
    for (const [cron, slot] of Object.entries(DAILY_SLOTS)) {
      const entries = crons.filter((c) => c.path === `/api/cron/${slot.rides || cron}`)
      expect(entries.map((e) => e.schedule), cron).toEqual([`${minuteOf(cron)} * * * *`])
    }
  })

  it('an ARM rides a converted cron at the same hour, and has no vercel.json entry of its own', async () => {
    const { readFileSync } = await import('node:fs')
    const crons = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).crons
    const arms = Object.entries(DAILY_SLOTS).filter(([, slot]) => slot.rides)
    expect(arms.map(([cron]) => cron).sort()).toEqual(['qualification-digest', 'roster-runway'])
    for (const [cron, slot] of arms) {
      const host = DAILY_SLOTS[slot.rides]
      expect(host, cron).toBeTruthy()
      expect(host.rides, cron).toBeUndefined()
      expect(slot.hour, cron).toBe(host.hour)
      expect(crons.filter((c) => c.path === `/api/cron/${cron}`), cron).toEqual([])
    }
  })
})

describe('TZ.6 Europe/Dublin is byte-identical: the same UTC instants as the old schedule, all of 2026', () => {
  it.each(Object.keys(DAILY_SLOTS))('%s', async (cron) => {
    const { acted, days } = await simulateYear(cron, [DUB], DUB.id)
    expect(acted.length).toBe(DAILY_SLOTS[cron].weekday ? 52 : 365)
    expect(acted.map((ms) => new Date(ms).toISOString())).toEqual(legacyActs(cron).map((ms) => new Date(ms).toISOString()))
    // The claim day is the Dublin calendar day, which at every legacy instant is also the UTC day.
    expect(days).toEqual(acted.map((ms) => dayStrIn(ms, 'Europe/Dublin')))
    expect(days).toEqual(acted.map((ms) => new Date(ms).toISOString().slice(0, 10)))
  }, 60_000)

  it('pins both sides of Irish DST for a 10:00 UTC slot (11:00 IST in summer, 10:00 GMT in winter)', () => {
    const slot = DAILY_SLOTS['notify-winback']
    for (const iso of ['2026-03-28T10:00:00Z', '2026-03-29T10:00:00Z', '2026-07-01T10:00:00Z', '2026-10-24T10:00:00Z', '2026-10-25T10:00:00Z', '2026-12-01T10:00:00Z']) {
      expect(dailySlotDue('Europe/Dublin', at(iso), slot), iso).toMatchObject({ due: true, lateHours: 0, legacy: true })
    }
    expect(dailySlotDue('Europe/Dublin', at('2026-07-01T09:00:00Z'), slot).due).toBe(false) // 10:00 IST: not the legacy instant
  })
})

describe('TZ.6 America/New_York acts at its LOCAL hour across both 2026 US DST changes', () => {
  it.each(Object.keys(DAILY_SLOTS))('%s', async (cron) => {
    const { acted, days } = await simulateYear(cron, [NY], NY.id)
    const slot = DAILY_SLOTS[cron]
    expect(acted.length).toBeGreaterThan(0)
    for (const ms of acted) {
      const p = instantToZonedParts(ms, 'America/New_York')
      expect(p.h, new Date(ms).toISOString()).toBe(slot.hour)
      if (slot.weekday) expect(p.weekday).toBe(slot.weekday)
    }
    expect(new Set(days).size).toBe(days.length) // at most once per local day
    const expected = slot.weekday ? 52 : 365
    expect(days.length).toBe(expected)
  }, 60_000)

  it('a 10:00 slot is 15:00Z in winter and 14:00Z in summer (8 Mar and 1 Nov edges)', () => {
    const slot = DAILY_SLOTS['notify-winback']
    expect(dailySlotDue('America/New_York', at('2026-03-07T15:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0, day: '2026-03-07' })
    expect(dailySlotDue('America/New_York', at('2026-03-08T14:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0, day: '2026-03-08' })
    expect(dailySlotDue('America/New_York', at('2026-10-31T14:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0, day: '2026-10-31' })
    expect(dailySlotDue('America/New_York', at('2026-11-01T15:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0, day: '2026-11-01' })
    expect(dailySlotDue('America/New_York', at('2026-11-01T14:00:00Z'), slot).due).toBe(false) // 09:00 EST
  })

  it('weekday slots read the LOCAL weekday: Monday 06:00 in Sydney is Sunday 20:00Z', () => {
    const slot = DAILY_SLOTS['morning-briefing']
    expect(dailySlotDue('Australia/Sydney', at('2026-07-05T20:00:00Z'), slot)).toMatchObject({ due: true, day: '2026-07-06', legacy: false })
    expect(dailySlotDue('Europe/Dublin', at('2026-07-05T20:00:00Z'), slot).due).toBe(false)
  })

  it('a local-anchored slot is local for Dublin too (receipt-coverage-weekly: Friday 08:00 wall clock)', () => {
    const slot = DAILY_SLOTS['receipt-coverage-weekly']
    expect(isLegacyAnchored('Europe/Dublin', slot)).toBe(false)
    expect(dailySlotDue('Europe/Dublin', at('2026-07-03T07:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0 })
    expect(dailySlotDue('Europe/Dublin', at('2026-12-04T08:00:00Z'), slot)).toMatchObject({ due: true, lateHours: 0 })
  })
})

describe('TZ.6 the claim: never twice for one location on one local day', () => {
  it('a slot whose local hour repeats on the fall-back day acts once (New York, 01:00, 1 Nov 2026)', async () => {
    const t = slotTables({ locations: [NY] })
    const slot = { hour: 1 }
    const first = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-11-01T05:00:00Z'), slot }) // 01:00 EDT
    const again = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-11-01T06:00:00Z'), slot }) // 01:00 EST
    expect(instantToZonedParts(at('2026-11-01T06:00:00Z'), 'America/New_York').h).toBe(1)
    expect(slotFor(first.slots, NY.id)).toMatchObject({ day: '2026-11-01', lateHours: 0 })
    expect(slotFor(again.slots, NY.id)).toBeUndefined()
    expect(again.summary).toMatchObject({ due: 1, already: 1, claimed: 0 })
  })

  it('a whole fall-back day, hour by hour, acts once per location and once for the no-location scope', async () => {
    const t = slotTables({ locations: [DUB, NY] })
    const acted = []
    for (let ms = at('2026-10-31T00:00:00Z'); ms < at('2026-11-03T00:00:00Z'); ms += HOUR) {
      const { slots } = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: ms, slot: { hour: 1 } })
      for (const [scope, s] of slots) acted.push(`${scope}|${s.day}`)
    }
    expect(new Set(acted).size).toBe(acted.length)
    expect(acted.filter((k) => k.startsWith('loc-ny|')).sort()).toEqual(['loc-ny|2026-10-31', 'loc-ny|2026-11-01', 'loc-ny|2026-11-02'])
  })

  it('a re-run inside the same hour (Vercel double invocation, a manual run) does nothing', async () => {
    const t = slotTables({ locations: [DUB] })
    const nowMs = at('2026-07-01T10:00:00Z')
    expect(slotFor((await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs })).slots, DUB.id)).toBeTruthy()
    expect(slotFor((await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: nowMs + 60_000 })).slots, DUB.id)).toBeUndefined()
  })

  it('an arm claims independently of its host cron and of the other arm (same hour, same location, same day)', async () => {
    const t = slotTables({ locations: [DUB, NY] })
    const nowMs = at('2026-07-01T08:00:00Z')
    for (const cron of ['contract-reminders', 'roster-runway', 'qualification-digest']) {
      expect(slotFor((await gateDailySlot({ from: t.from }, cron, { nowMs })).slots, DUB.id), cron).toBeTruthy()
    }
    // A second invocation of the same hour acts for none of the three.
    for (const cron of ['contract-reminders', 'roster-runway', 'qualification-digest']) {
      expect((await gateDailySlot({ from: t.from }, cron, { nowMs: nowMs + 60_000 })).slots.size, cron).toBe(0)
    }
    expect([...t.claims.keys()].filter((k) => k.includes('|loc-dub|')).sort()).toEqual([
      'contract-reminders|loc-dub|2026-07-01', 'qualification-digest|loc-dub|2026-07-01', 'roster-runway|loc-dub|2026-07-01',
    ])
  })

  it('claims are per cron: one cron claiming a day does not block another', async () => {
    const t = slotTables({ locations: [DUB] })
    const nowMs = at('2026-07-01T07:00:00Z')
    expect(slotFor((await gateDailySlot({ from: t.from }, 'ad-report-email', { nowMs })).slots, DUB.id)).toBeTruthy()
    expect(slotFor((await gateDailySlot({ from: t.from }, 'run-scheduled-reports', { nowMs })).slots, DUB.id)).toBeTruthy()
  })

  it('rows with no location resolve to DEFAULT_TZ (legacy-anchored) under their own scope', async () => {
    const t = slotTables({ locations: [] })
    const { slots } = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(slotFor(slots, null)).toMatchObject({ locationId: null, zone: 'Europe/Dublin', legacy: true, day: '2026-07-01' })
    expect([...t.claims.values()]).toEqual([
      expect.objectContaining({ cron_name: 'notify-winback', scope: NO_LOCATION, slot_day: '2026-07-01', location_id: null, zone: 'Europe/Dublin' }),
    ])
  })

  it('an invalid stored zone resolves to Europe/Dublin (TZ.1 rule), with one warning', async () => {
    const t = slotTables({ locations: [{ id: 'loc-bad', timezone: 'Mars/Olympus' }] })
    const { slots } = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(slotFor(slots, 'loc-bad')).toMatchObject({ zone: 'Europe/Dublin', legacy: true })
  })

  it('claims in batches of 500, so no RETURNING set nears the 1k row cap; locations are paged past 1000', async () => {
    const locations = Array.from({ length: 1203 }, (_, i) => ({ id: `loc-${String(i).padStart(5, '0')}`, timezone: 'Europe/Dublin' }))
    const t = slotTables({ locations })
    const { slots, summary } = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(summary).toMatchObject({ due: 1204, claimed: 1204 })
    expect(slots.size).toBe(1204)
    expect(t.calls.claimUpserts).toBe(3)
    expect(t.calls.locationReads).toBe(2)
  })
})

describe('TZ.6 failure semantics: Dublin is skipped and pages, never late or twice; other zones retry', () => {
  it('Europe/Dublin is due ONLY at the legacy instant (+1h/+2h never), for every anchor', () => {
    for (const [cron, slot] of Object.entries(DAILY_SLOTS)) {
      const base = slot.anchor === 'local'
        ? at('2026-07-03T07:00:00Z') // Friday 08:00 IST
        : Date.UTC(2026, 6, slot.weekday === 1 ? 6 : 1, slot.hour) // a Monday for the Monday crons
      expect(dailySlotDue('Europe/Dublin', base, slot), cron).toMatchObject({ due: true, lateHours: 0 })
      expect(dailySlotDue('Europe/Dublin', base + HOUR, slot).due, cron).toBe(false)
      expect(dailySlotDue('Europe/Dublin', base + 2 * HOUR, slot).due, cron).toBe(false)
    }
    expect(catchUpHoursFor('Europe/Dublin')).toBe(0)
    expect(catchUpHoursFor('America/New_York')).toBe(SLOT_CATCHUP_HOURS)
  })

  it('a failed zone read acts for nobody and is a fault; Dublin is not retried, New York still is', async () => {
    let fail = true
    const t = slotTables({ locations: [DUB, NY], locationsError: () => (fail ? { code: 'XX000', message: 'down' } : null) })
    const down = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T14:00:00Z') }) // 10:00 EDT
    expect(down).toMatchObject({ ok: false, faulted: true })
    expect(down.slots.size).toBe(0)
    expect(slotTickStampable(down)).toBe(false)
    expect(t.calls.claimUpserts).toBe(0)
    expect(logError).toHaveBeenCalledWith('notify-winback', expect.stringContaining('unreadable'), expect.anything())
    fail = false
    const next = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T15:00:00Z') })
    expect(slotFor(next.slots, NY.id)).toMatchObject({ day: '2026-07-01', lateHours: 1 })
    const dub = slotTables({ locations: [DUB], locationsError: () => (fail ? { code: 'XX000', message: 'down' } : null) })
    fail = true
    expect((await gateDailySlot({ from: dub.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })).ok).toBe(false)
    fail = false
    for (const iso of ['2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']) {
      expect((await gateDailySlot({ from: dub.from }, 'notify-winback', { nowMs: at(iso) })).summary.due, iso).toBe(0)
    }
  })

  it('a failed claim write (not the missing-table case) is a fault: nothing acts, nothing may stamp; Dublin is not retried', async () => {
    const errors = [{ code: 'XX000', message: 'down' }]
    const t = slotTables({ locations: [DUB], claimError: () => errors.shift() ?? null })
    const first = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(first).toMatchObject({ ok: true, faulted: true })
    expect(first.slots.size).toBe(0)
    expect(first.summary.claim_failed).toBe(2) // Dublin + no-location
    expect(slotTickStampable(first)).toBe(false)
    for (const iso of ['2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']) {
      const later = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at(iso) })
      expect(later.summary.due, iso).toBe(0)
      expect(later.slots.size).toBe(0)
    }
  })

  it('a failed claim write for New York is retried on the next tick, inside two', async () => {
    const errors = [{ code: 'XX000', message: 'down' }]
    const t = slotTables({ locations: [NY], claimError: () => errors.shift() ?? null })
    expect((await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T14:00:00Z') })).faulted).toBe(true)
    const next = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T15:00:00Z') })
    expect(slotFor(next.slots, NY.id)).toMatchObject({ lateHours: 1 })
    expect(slotTickStampable(next)).toBe(true)
    const t2 = slotTables({ locations: [NY] })
    expect((await gateDailySlot({ from: t2.from }, 'notify-winback', { nowMs: at('2026-07-01T17:00:00Z') })).summary.due).toBe(0) // 3 h late
  })

  it('a quiet tick (nothing due) is not stampable', async () => {
    const t = slotTables({ locations: [DUB] })
    const quiet = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T03:00:00Z') })
    expect(quiet).toMatchObject({ ok: true, faulted: false })
    expect(slotTickStampable(quiet)).toBe(false)
  })

  it('before mig 720 (no claim table) a Dublin studio acts at its exact legacy hour with no claim; others wait; not a fault', async () => {
    const t = slotTables({ locations: [DUB, NY], claimError: () => ({ code: 'PGRST205', message: "Could not find the table 'public.cron_daily_slot_claims'" }) })
    const exact = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(slotFor(exact.slots, DUB.id)).toMatchObject({ lateHours: 0, legacy: true, fallback: true })
    expect(exact).toMatchObject({ faulted: false, summary: { legacy_fallback: 2 } })
    expect(slotTickStampable(exact)).toBe(true)
    expect(logWarn).toHaveBeenCalledWith('notify-winback', expect.stringContaining('mig 720'), expect.anything())
    const lateTick = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T11:00:00Z') })
    expect(lateTick.slots.size).toBe(0)
    const nyTick = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T14:00:00Z') })
    expect(slotFor(nyTick.slots, NY.id)).toBeUndefined()
    expect(nyTick).toMatchObject({ faulted: false, summary: { due: 1, waiting: 1, claim_failed: 0 } })
  })

  it('schema-cache lag: the legacy tick gets PGRST205 and acts on the fallback; the +1h tick finds the table and does NOT act again', async () => {
    const errors = [{ code: 'PGRST205', message: 'schema cache' }]
    const t = slotTables({ locations: [DUB], claimError: () => errors.shift() ?? null })
    const legacy = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at('2026-07-01T10:00:00Z') })
    expect(slotFor(legacy.slots, DUB.id)).toMatchObject({ fallback: true })
    for (const iso of ['2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']) {
      const later = await gateDailySlot({ from: t.from }, 'notify-winback', { nowMs: at(iso) })
      expect(later.slots.size, iso).toBe(0)
    }
    expect(t.claims.size).toBe(0) // the later ticks never even tried: not due
  })

  it('before mig 720 the local-anchored Friday slot also keeps its exact old instant for Dublin', async () => {
    const t = slotTables({ locations: [DUB], claimError: () => ({ code: '42P01', message: 'relation does not exist' }) })
    const fri = await gateDailySlot({ from: t.from }, 'receipt-coverage-weekly', { nowMs: at('2026-07-03T07:00:00Z') }) // 08:00 IST
    expect(slotFor(fri.slots, DUB.id)).toMatchObject({ lateHours: 0, legacy: false, fallback: true })
    const late = await gateDailySlot({ from: t.from }, 'receipt-coverage-weekly', { nowMs: at('2026-07-03T08:00:00Z') })
    expect(late.slots.size).toBe(0)
  })

  it('an unknown cron name is a programming error', async () => {
    await expect(gateDailySlot({ from: () => null }, 'no-such-cron')).rejects.toThrow('no slot')
  })
})
