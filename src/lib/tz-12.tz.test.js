// tz-12.tz.test.js — TZ.12. The studio TV and live boards tell their own
// studio's time (locations.timezone) instead of a hard-coded Europe/Dublin:
// the overnight poll back-off (and fleet-health's `quiet`, which reuses it),
// the TV's current-class label, the intro-card preview label and the coach
// board's Detected-tab visit times.
//
//   • Europe/Dublin: TZ.12 proved it byte-identical to a frozen copy of the
//     pre-change bodies (every half-hour of 2026, every quarter-hour of the
//     weeks around both EU DST changes); that sweep was retired in TZ.18b.
//     Dublin is now pinned by fixed values around both 2026 EU DST changes;
//     zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
//   • America/New_York: follows New York across both 2026 US DST changes.
//
// The board CLOCKS (host-zone getters before TZ.12) are pinned by
// tz-12.clocks.tz.test.js, which runs on a Dublin host clock.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test: proves nothing reads the host clock
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bridge-samples', () => ({
  isBridgeOnline: () => true,
  latestBridgeSeenMs: () => 0,
  maskStrapLabel: (k) => k,
  deriveBridgeStatus: () => 'online',
}))
vi.mock('@/lib/live-class', () => ({ getAvailableStraps: vi.fn(() => Promise.resolve([])) }))
vi.mock('@/lib/class-occurrences', () => ({ resolveCurrentClassForTv: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { isOvernight, nextPollDelay, ACTIVE_POLL_MS, IDLE_POLL_MS } = await import('./live-poll.js')
const { demoIntroClass } = await import('./tv-class-intro.js')
const { visitTimeLabel } = await import('./tv-board-time.js')
const { buildLiveBoardPayload } = await import('./live-board.js')
const { boardZoneForLocation } = await import('./tv-board-zone.js')
const { gradeDevice } = await import('./fleet-health.js')
const { resetLocationZoneCache } = await import('./location-time.js')
const { resolveCurrentClassForTv } = await import('@/lib/class-occurrences')
const { logWarn } = await import('@/lib/log')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.

const IDLE = { sessions: [], available_straps: [], timer: null, current_class: null, occurrence: null }

// ── Europe/Dublin pinned values ─────────────────────────────────────────────

describe('TZ.12 Europe/Dublin pinned values', () => {
  // [instant, overnight (22:00-06:00 Dublin), Dublin wall clock HH:MM, Detected-tab label]
  const PINS = [
    ['2026-01-15T05:59:00Z', true, '05:59', 'Thu, 15 Jan, 05:59'], // winter (GMT)
    ['2026-01-15T06:00:00Z', false, '06:00', 'Thu, 15 Jan, 06:00'],
    ['2026-01-15T22:00:00Z', true, '22:00', 'Thu, 15 Jan, 22:00'],
    ['2026-07-01T04:59:00Z', true, '05:59', 'Wed, 1 Jul, 05:59'], // summer (IST)
    ['2026-07-01T05:00:00Z', false, '06:00', 'Wed, 1 Jul, 06:00'],
    ['2026-07-01T21:00:00Z', true, '22:00', 'Wed, 1 Jul, 22:00'],
    ['2026-03-29T00:59:00Z', true, '00:59', 'Sun, 29 Mar, 00:59'], // spring-forward
    ['2026-03-29T01:00:00Z', true, '02:00', 'Sun, 29 Mar, 02:00'],
    ['2026-03-29T05:00:00Z', false, '06:00', 'Sun, 29 Mar, 06:00'],
    ['2026-10-25T00:59:00Z', true, '01:59', 'Sun, 25 Oct, 01:59'], // fall-back
    ['2026-10-25T01:00:00Z', true, '01:00', 'Sun, 25 Oct, 01:00'],
    ['2026-10-25T05:59:00Z', true, '05:59', 'Sun, 25 Oct, 05:59'],
    ['2026-10-25T06:00:00Z', false, '06:00', 'Sun, 25 Oct, 06:00'],
  ]

  it.each(PINS)('%s: isOvernight + nextPollDelay, explicit zone and default', (iso, overnight) => {
    const now = new Date(iso)
    expect(isOvernight(now, D)).toBe(overnight)
    expect(isOvernight(now)).toBe(overnight)
    expect(nextPollDelay(IDLE, now, D)).toBe(overnight ? IDLE_POLL_MS : ACTIVE_POLL_MS)
    expect(nextPollDelay(IDLE, now)).toBe(overnight ? IDLE_POLL_MS : ACTIVE_POLL_MS)
    expect(nextPollDelay({ sessions: [{ id: 's' }] }, now, D)).toBe(ACTIVE_POLL_MS) // an active board never backs off
    expect(nextPollDelay(null, now, D)).toBe(ACTIVE_POLL_MS) // no payload yet counts as active
  })

  it.each(PINS)('%s: demoIntroClass and visitTimeLabel, explicit zone and default', (iso, _overnight, hhmm, visit) => {
    const ms = Date.parse(iso)
    for (const v of [demoIntroClass(ms, D), demoIntroClass(ms)]) {
      expect(v).toStrictEqual({ glofox_event_id: 'preview', starts_at: new Date(ms).toISOString(), class_name: 'STRENGTH', starts_at_label: hhmm, program: 'Preview' })
    }
    expect(visitTimeLabel(iso, D)).toBe(visit)
    expect(visitTimeLabel(iso)).toBe(visit)
  })

  it('visitTimeLabel: empty values are blank, an unparseable value is shown raw', () => {
    for (const v of [null, undefined, '']) expect(visitTimeLabel(v, D)).toBe('')
    expect(visitTimeLabel('not-a-date', D)).toBe('not-a-date')
  })

  it('the TV current-class label, through buildLiveBoardPayload', async () => {
    for (const [startsAt, label] of [
      ['2026-01-15T18:00:00Z', '18:00'], ['2026-07-03T17:00:00Z', '18:00'],
      ['2026-03-29T01:00:00Z', '02:00'], ['2026-10-25T00:59:00Z', '01:59'], ['2026-10-25T01:00:00Z', '01:00'],
      ['2026-06-30T23:00:00Z', '00:00'],
    ]) {
      resolveCurrentClassForTv.mockResolvedValueOnce({ class_name: 'WOD', program: 'HIIT', starts_at: startsAt, glofox_event_id: 'e1' })
      const body = await buildLiveBoardPayload(boardDb(), { location: { id: 'loc-1', name: 'Studio', timezone: D }, nowMs: Date.parse(startsAt) })
      expect(body.current_class.starts_at_label).toBe(label)
      expect(body.timezone).toBe(D)
    }
  })

  it('a location row with a NULL or missing timezone is Dublin (UN1T before mig 719)', async () => {
    const startsAt = '2026-07-03T17:00:00Z'
    for (const location of [{ id: 'loc-1', name: 'Studio', timezone: null }, { id: 'loc-1', name: 'Studio' }]) {
      resolveCurrentClassForTv.mockResolvedValueOnce({ class_name: 'WOD', program: 'HIIT', starts_at: startsAt, glofox_event_id: 'e1' })
      const body = await buildLiveBoardPayload(boardDb(), { location, nowMs: Date.parse(startsAt) })
      expect(body.current_class.starts_at_label).toBe('18:00')
      expect(body.timezone).toBe(D)
    }
  })
})

// ── America/New_York follows New York ───────────────────────────────────────

describe('TZ.12 America/New_York follows New York across DST', () => {
  it('overnight is 22:00-06:00 New York wall clock, not Dublin', () => {
    // 22:30Z on 8 Mar: Dublin 22:30 (overnight), New York 18:30 EDT (open).
    const eveningDublin = new Date('2026-03-08T22:30:00Z')
    expect(isOvernight(eveningDublin, D)).toBe(true)
    expect(isOvernight(eveningDublin, NY)).toBe(false)
    expect(nextPollDelay(IDLE, eveningDublin, NY)).toBe(ACTIVE_POLL_MS)
    // 03:00Z on 9 Mar: Dublin 03:00, New York 23:00 EDT; both overnight.
    expect(isOvernight(new Date('2026-03-09T03:00:00Z'), NY)).toBe(true)
    expect(nextPollDelay(IDLE, new Date('2026-03-09T03:00:00Z'), NY)).toBe(IDLE_POLL_MS)
  })

  it('the night ends at 06:00 New York on both sides of the November fall-back', () => {
    // 1 Nov 2026 (EST from 06:00Z): 10:59Z = 05:59 EST (overnight), 11:00Z = 06:00 EST (open).
    expect(isOvernight(new Date('2026-11-01T10:59:00Z'), NY)).toBe(true)
    expect(isOvernight(new Date('2026-11-01T11:00:00Z'), NY)).toBe(false)
    // 31 Oct (EDT): 09:59Z = 05:59 EDT, 10:00Z = 06:00 EDT.
    expect(isOvernight(new Date('2026-10-31T09:59:00Z'), NY)).toBe(true)
    expect(isOvernight(new Date('2026-10-31T10:00:00Z'), NY)).toBe(false)
    // Dublin at 10:59Z on 1 Nov is mid-morning: an NY board must not idle on Dublin's clock.
    expect(isOvernight(new Date('2026-11-01T10:59:00Z'), D)).toBe(false)
  })

  it('the class-intro preview clock reads 03:00 just after the March spring-forward', () => {
    expect(demoIntroClass(Date.parse('2026-03-08T07:00:00Z'), NY).starts_at_label).toBe('03:00')
    expect(demoIntroClass(Date.parse('2026-03-08T06:59:00Z'), NY).starts_at_label).toBe('01:59')
    expect(demoIntroClass(Date.parse('2026-03-08T07:00:00Z'), D).starts_at_label).toBe('07:00')
  })

  it('the TV current-class label and payload zone are New York (09:00 local = 13:00Z summer, 14:00Z winter)', async () => {
    for (const [startsAt, label] of [['2026-07-01T13:00:00Z', '09:00'], ['2026-12-01T14:00:00Z', '09:00'], ['2026-11-01T05:30:00Z', '01:30'], ['2026-11-01T06:30:00Z', '01:30']]) {
      resolveCurrentClassForTv.mockResolvedValueOnce({ class_name: 'WOD', program: 'HIIT', starts_at: startsAt, glofox_event_id: 'e1' })
      const body = await buildLiveBoardPayload(boardDb(), { location: { id: 'loc-ny', name: 'NY', timezone: NY }, nowMs: Date.parse(startsAt) })
      expect(body.current_class.starts_at_label).toBe(label)
      expect(body.timezone).toBe(NY)
    }
  })

  it('the Detected-tab visit time is the New York day and clock', () => {
    // 02:30Z on Mon 9 Mar is still Sunday 8 Mar 22:30 EDT in New York.
    expect(visitTimeLabel('2026-03-09T02:30:00Z', NY)).toBe(visitTimeLabel('2026-03-08T22:30:00Z', D))
    expect(visitTimeLabel('2026-03-09T02:30:00Z', NY)).toBe('Sun, 8 Mar, 22:30')
  })

  it('fleet-health: a dark kiosk is quiet on its STUDIO night', () => {
    const nowMs = Date.parse('2026-03-08T22:30:00Z') // Dublin 22:30, New York 18:30 EDT
    const device = { name: 'kiosk-1.tailnet', hostname: 'kiosk-1', connectedToControl: true, tags: ['tag:un1t-pi'] }
    const fleetRow = { role: 'kiosk', last_render_at: new Date(nowMs - 60 * 60_000).toISOString() }
    const dublin = gradeDevice(device, null, nowMs, fleetRow, null, D)
    const ny = gradeDevice(device, null, nowMs, fleetRow, null, NY)
    expect(dublin.state).toBe('service_down')
    expect(ny.state).toBe('service_down')
    expect(dublin.quiet).toBe(true)
    expect(ny.quiet).toBe(false)
    // The default (no zone) is the pre-TZ.12 Dublin night: 22:30 Dublin is quiet.
    expect(gradeDevice(device, null, nowMs, fleetRow, null).quiet).toBe(true)
  })
})

// ── The cast board's zone read (display-only) ───────────────────────────────

describe('TZ.12 boardZoneForLocation: a display read never blanks a board', () => {
  beforeEach(() => { resetLocationZoneCache(); logWarn.mockClear() })

  it("returns the location's zone", async () => {
    await expect(boardZoneForLocation(zoneDb({ data: { id: 'loc-ny', timezone: NY }, error: null }), 'loc-ny')).resolves.toBe(NY)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('a failed read falls back to Europe/Dublin with a logged warning', async () => {
    await expect(boardZoneForLocation(zoneDb({ data: null, error: { message: 'boom' } }), 'loc-x')).resolves.toBe(D)
    expect(logWarn).toHaveBeenCalledWith('tv', expect.stringContaining('unreadable'), expect.objectContaining({ locationId: 'loc-x' }))
  })

  it('no location id is Dublin, silently', async () => {
    await expect(boardZoneForLocation(zoneDb({ data: null, error: null }), null)).resolves.toBe(D)
    expect(logWarn).not.toHaveBeenCalled()
  })
})

// ── mocks ───────────────────────────────────────────────────────────────────

// buildLiveBoardPayload's reads with no open session: the early-return payload.
function boardDb() {
  return {
    from: (table) => {
      if (table === 'ble_bridges') return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
      if (table === 'heart_rate_sessions') {
        return { select: () => ({ eq: () => ({ is: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) }
      }
      if (table === 'class_timer_runs') {
        return { select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
}

function zoneDb(result) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }
}
