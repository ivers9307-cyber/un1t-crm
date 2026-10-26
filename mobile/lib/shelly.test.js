// SHELLY-MOB.1 — the judgements behind the mobile Smart plugs screen.
//
// These are the four places the screen could tell an operator something untrue
// about a relay, so each is pinned branch by branch:
//
//   • plugStateLabel  — `output: null` is UNKNOWN, never 'Off'.
//   • plugTone        — `connected === false` beats every staleness reading,
//                       and an uncertain connection never reaches red.
//   • isQueued /      — a saved-but-not-yet-applied command must not be
//     toggleResultText   reported as done, NOR as failed (the 429 arm).
//   • errorText       — the routes fold their reassurance into `error`.
//
// No mocks and no imports beyond the module itself: shelly.js is deliberately
// RN-free so it runs under vitest's Node environment as-is.

import { describe, it, expect } from 'vitest'
import {
  plugStateLabel, plugTone, isQueued, toggleResultText, errorText, plugDisplayName,
  groupTone, groupReasonLine, lightStateLabel, memberPowerText, overrideUntilLabel,
  PLUG_FRESH_MS, PLUG_STALE_MS, PLUG_TONE_TEXT, PLUG_TONE_DOT, HOLDS_TEXT,
} from './shelly'

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const seenAgo = (ms) => new Date(NOW - ms).toISOString()

describe('plugStateLabel', () => {
  it('renders the relay word for each of the three states', () => {
    expect(plugStateLabel({ last_state: { output: true } })).toBe('On')
    expect(plugStateLabel({ last_state: { output: false } })).toBe('Off')
  })

  it('output: null is Unknown — NEVER Off', () => {
    // The whole point of mig 562's seven-field shape. An offline plug reports
    // nothing about its relay; "Off" would say a heater is safe when nobody knows.
    expect(plugStateLabel({ last_state: { output: null } })).toBe('Unknown')
  })

  it('a missing last_state, a missing output and a missing device are all Unknown', () => {
    expect(plugStateLabel({ last_state: {} })).toBe('Unknown')
    expect(plugStateLabel({})).toBe('Unknown')
    expect(plugStateLabel(null)).toBe('Unknown')
  })

  it('output is compared strictly — a truthy non-boolean is not On', () => {
    expect(plugStateLabel({ last_state: { output: 1 } })).toBe('Unknown')
    expect(plugStateLabel({ last_state: { output: 'on' } })).toBe('Unknown')
  })

  it('appends the wattage when apower is a finite number, rounded', () => {
    expect(plugStateLabel({ last_state: { output: true, apower: 41.6 } })).toBe('On · 42 W')
    // Zero watts is a real reading and must be shown, not swallowed as falsy.
    expect(plugStateLabel({ last_state: { output: false, apower: 0 } })).toBe('Off · 0 W')
  })

  it('a non-number apower renders no wattage at all — absent is not zero', () => {
    // The toggle route NULLS the measurements on a switch it applied: a
    // set/switch measures nothing, so the old watts under a fresh timestamp
    // would read as a live measurement of a relay we just moved.
    expect(plugStateLabel({ last_state: { output: true, apower: null } })).toBe('On')
    expect(plugStateLabel({ last_state: { output: true } })).toBe('On')
    expect(plugStateLabel({ last_state: { output: true, apower: '42' } })).toBe('On')
    expect(plugStateLabel({ last_state: { output: true, apower: NaN } })).toBe('On')
    expect(plugStateLabel({ last_state: { output: true, apower: Infinity } })).toBe('On')
  })
})

describe('plugTone — ordering', () => {
  it('connected:false wins over a perfectly fresh reading', () => {
    const fresh = { last_seen_at: seenAgo(1000), last_state: { online: true } }
    expect(plugTone(fresh, false, NOW)).toEqual({
      tone: 'grey', label: 'Not connected', reason: 'not_connected',
    })
  })

  it('connected:false wins over a STALE reading — dormant, not broken', () => {
    // After a deliberate Disconnect the rows stay adopted and last_seen_at
    // simply stops advancing. Red here would point the operator at a connection
    // they removed on purpose.
    const ancient = { last_seen_at: seenAgo(6 * 60 * 60_000), last_state: { online: true } }
    expect(plugTone(ancient, false, NOW).reason).toBe('not_connected')
    expect(plugTone(ancient, false, NOW).tone).toBe('grey')
  })

  it('connected:false wins over an offline reading and over a never-seen row', () => {
    expect(plugTone({ last_seen_at: seenAgo(1000), last_state: { online: false } }, false, NOW).reason)
      .toBe('not_connected')
    expect(plugTone({ last_seen_at: null }, false, NOW).reason).toBe('not_connected')
  })

  it('an offline reading outranks the age — an overnight plug is not a fault', () => {
    const offlineButFresh = { last_seen_at: seenAgo(1000), last_state: { online: false } }
    expect(plugTone(offlineButFresh, true, NOW)).toEqual({
      tone: 'grey', label: 'Offline', reason: 'offline',
    })
    // Even when the age alone would have been red.
    const offlineAndOld = { last_seen_at: seenAgo(60 * 60_000), last_state: { online: false } }
    expect(plugTone(offlineAndOld, true, NOW).reason).toBe('offline')
  })

  it('online:true and online:null both fall through to the age', () => {
    // Only an explicit false is evidence of unreachability.
    expect(plugTone({ last_seen_at: seenAgo(1000), last_state: { online: true } }, true, NOW).tone).toBe('green')
    expect(plugTone({ last_seen_at: seenAgo(1000), last_state: { online: null } }, true, NOW).tone).toBe('green')
    expect(plugTone({ last_seen_at: seenAgo(1000), last_state: {} }, true, NOW).tone).toBe('green')
  })
})

describe('plugTone — never seen', () => {
  it('no last_seen_at with a good connection is "waiting"', () => {
    expect(plugTone({ last_seen_at: null }, true, NOW)).toEqual({
      tone: 'grey', label: 'Waiting for first status', reason: 'never_seen',
    })
    expect(plugTone({}, true, NOW).reason).toBe('never_seen')
    expect(plugTone({ last_seen_at: 'not a date' }, true, NOW).reason).toBe('never_seen')
  })

  it('no last_seen_at AND an unreadable connection blames neither side', () => {
    // "Waiting for its first status" would blame the plug for a read that
    // failed on ours.
    expect(plugTone({ last_seen_at: null }, null, NOW)).toEqual({
      tone: 'grey', label: 'Connection unknown', reason: 'connection_unknown',
    })
    expect(plugTone({ last_seen_at: null }, undefined, NOW).reason).toBe('connection_unknown')
  })
})

describe('plugTone — freshness windows', () => {
  const online = (ms) => ({ last_seen_at: seenAgo(ms), last_state: { online: true } })

  it('inside the fresh window (the engine write floor + one missed sweep) is green', () => {
    expect(plugTone(online(0), true, NOW)).toEqual({ tone: 'green', label: 'Online', reason: 'fresh' })
    expect(plugTone(online(PLUG_FRESH_MS), true, NOW).tone).toBe('green')
    // The boundary is INCLUSIVE — an idle plug rewritten exactly on its
    // refresh floor is healthy, and this is the flicker SHELLY-UI.9b removed.
    expect(PLUG_FRESH_MS).toBe(6 * 60_000)
  })

  it('past the fresh window and inside the stale one is amber, with a never-zero age', () => {
    expect(plugTone(online(PLUG_FRESH_MS + 1), true, NOW)).toEqual({
      tone: 'amber', label: 'Last seen 6 min ago', reason: 'lagging',
    })
    expect(plugTone(online(PLUG_STALE_MS), true, NOW)).toEqual({
      tone: 'amber', label: 'Last seen 15 min ago', reason: 'lagging',
    })
  })

  it('past the stale window with a known-good connection is red', () => {
    expect(plugTone(online(PLUG_STALE_MS + 1), true, NOW)).toEqual({
      tone: 'red', label: 'Stale — check the Shelly connection', reason: 'stale',
    })
    expect(plugTone(online(60 * 60_000), true, NOW).tone).toBe('red')
  })

  it('an UNCERTAIN connection caps at amber however old the reading is', () => {
    // connection_status:'unknown' is OUR database read failing, not the
    // studio's hardware. Red would invent a fault in their kit.
    for (const connected of [null, undefined]) {
      const verdict = plugTone(online(6 * 60 * 60_000), connected, NOW)
      expect(verdict.tone).toBe('amber')
      expect(verdict.reason).toBe('lagging_unverified')
      expect(verdict.label).toBe('Last seen 360 min ago')
    }
  })

  it('an uncertain connection still reports green and plain amber normally', () => {
    expect(plugTone(online(1000), null, NOW).reason).toBe('fresh')
    expect(plugTone(online(PLUG_FRESH_MS + 1), null, NOW).reason).toBe('lagging')
  })

  it('defaults nowMs to the real clock when none is given', () => {
    const justNow = { last_seen_at: new Date().toISOString(), last_state: { online: true } }
    expect(plugTone(justNow, true).tone).toBe('green')
  })

  it('every tone a verdict can carry has a text class and a dot colour', () => {
    for (const tone of ['grey', 'green', 'amber', 'red']) {
      expect(PLUG_TONE_TEXT[tone]).toBeTruthy()
      expect(PLUG_TONE_DOT[tone]).toBeTruthy()
    }
  })
})

describe('isQueued', () => {
  it('is true for the route\'s own pending flag', () => {
    expect(isQueued({ success: true, applied: false, pending: true, code: 'pending' })).toBe(true)
  })

  it('is true for the 429 pending body, which api() now passes through intact', () => {
    // POST .../toggle answers HTTP 429 with success:true + pending:true; since
    // SHELLY-MOB.1 api() passes a body carrying our envelope through unchanged,
    // so the judgement reads the route's own `pending` field.
    expect(isQueued({ success: true, applied: false, pending: true, code: 'rate_limited' })).toBe(true)
  })

  it('is FALSE for any 429 WITHOUT our envelope — an edge page is not a queued command', () => {
    // api() synthesises these (status rides along); the override state is
    // unknown, so claiming "queued" would be a promise nothing keeps.
    expect(isQueued({ success: false, status: 429, error: 'HTTP 429' })).toBe(false)
    expect(isQueued({ success: false, status: 429, transport: true, error: 'Non-JSON response (429)' })).toBe(false)
  })

  it('is false for every ordinary answer', () => {
    expect(isQueued(null)).toBe(false)
    expect(isQueued(undefined)).toBe(false)
    expect(isQueued({ success: true, applied: true })).toBe(false)
    expect(isQueued({ success: false, error: 'Not found' })).toBe(false)
    expect(isQueued({ success: false, status: 500, error: 'HTTP 500' })).toBe(false)
    // pending is read strictly — a truthy non-boolean is not the route's flag.
    expect(isQueued({ success: true, pending: 'yes' })).toBe(false)
  })
})

describe('toggleResultText', () => {
  it('prefers the route\'s own sentence on a pending body', () => {
    // It is written against the exact failure the route saw; ours is the
    // fallback for a body that carried none.
    expect(toggleResultText({
      pending: true, code: 'key_rejected',
      message: 'Saved. Shelly rejected the stored key — re-paste it from the Shelly app and the plug will follow.',
    })).toMatch(/^Saved\. Shelly rejected the stored key/)
  })

  it('falls back to our copy per code', () => {
    expect(toggleResultText({ pending: true, code: 'key_rejected' })).toMatch(/re-paste the Shelly key on the web CRM/)
    expect(toggleResultText({ pending: true, code: 'rate_limited' })).toMatch(/Shelly is busy right now/)
    expect(toggleResultText({ pending: true, code: 'bad_host' })).toMatch(/fix the Shelly server on the web CRM/)
    expect(toggleResultText({ pending: true, code: 'pending' })).toMatch(/back online/)
  })

  it('an absent or unrecognised code falls back to the offline-queued copy', () => {
    expect(toggleResultText({ pending: true })).toBe(toggleResultText({ pending: true, code: 'pending' }))
    expect(toggleResultText({ pending: true, code: 'something_new' }))
      .toBe(toggleResultText({ pending: true, code: 'pending' }))
  })

  it('the passed-through 429 pending body gets the rate-limited copy', () => {
    expect(toggleResultText({ success: true, applied: false, pending: true, code: 'rate_limited' }))
      .toMatch(/Shelly is busy right now/)
  })

  it('carries the holds notice alongside a queued sentence', () => {
    const text = toggleResultText({ pending: true, code: 'pending', holds_until_changed: true })
    expect(text).toMatch(/back online/)
    expect(text).toContain(HOLDS_TEXT)
  })

  it('a plain success on an unmanaged device is just the holds notice', () => {
    expect(toggleResultText({ success: true, applied: true, holds_until_changed: true })).toBe(HOLDS_TEXT)
  })

  it('a plain success on a MANAGED device has nothing extra to say', () => {
    expect(toggleResultText({ success: true, applied: true, holds_until_changed: false })).toBeNull()
    expect(toggleResultText({ success: true, applied: true })).toBeNull()
  })

  it('a real failure is null — the caller renders errorText instead', () => {
    expect(toggleResultText({ success: false, error: 'Could not save that override — nothing was switched' })).toBeNull()
    // Including one that happens to carry the flag (the `auto` failure bodies
    // do not, but a null here can only ever under-claim).
    expect(toggleResultText({ success: false, error: 'boom', holds_until_changed: true })).toBeNull()
    expect(toggleResultText(null)).toBeNull()
  })
})

describe('errorText', () => {
  it('prefers a validation issue over the generic error', () => {
    expect(errorText(
      { success: false, error: 'Invalid request', issues: [{ message: 'That time has already passed' }] },
      'fallback',
    )).toBe('That time has already passed')
  })

  it('then message, then error, then the fallback', () => {
    expect(errorText({ message: 'm', error: 'e' }, 'f')).toBe('m')
    expect(errorText({ error: 'e' }, 'f')).toBe('e')
    expect(errorText({}, 'f')).toBe('f')
    expect(errorText(null, 'f')).toBe('f')
  })
})

describe('plugDisplayName', () => {
  it('uses the stored name when there is one', () => {
    expect(plugDisplayName({ name: 'Heater', model: 'S3SW-001X8EU', device_id: 'abc123de' })).toBe('Heater')
  })

  it('composes model + last four of the device id when there is not', () => {
    // Composed at render time, never stored — a synthesised name on the row
    // would be indistinguishable from one a human chose.
    expect(plugDisplayName({ name: null, model: 'S3SW-001X8EU', device_id: 'abc123de' }))
      .toBe('S3SW-001X8EU · 23de')
    expect(plugDisplayName({ device_id: 'abc123de' })).toBe('Shelly · 23de')
    expect(plugDisplayName({})).toBe('Shelly · ')
    expect(plugDisplayName(null)).toBe('Shelly · ')
  })
})

// ── SHELLYGROUPS.9 — the group card's judgements ─────────────────────────────
// Re-typed from the web's ShellyGroupCard / ShellyDeviceCard. Every clock below
// is Dublin SUMMER time (UTC+1) on purpose, so a helper that formatted in UTC or
// in the runner's zone prints the wrong hour and fails.

const G_NOW = Date.parse('2026-08-24T12:00:00.000Z') // Mon 13:00 in Dublin
const DUB = 'Europe/Dublin'
const DUB_MIDNIGHT = '2026-08-24T23:00:00.000Z' // Tue 00:00 in Dublin
const group = (over = {}, now = {}) => ({
  id: 'g1', name: 'Studio lights', enabled: true, schedule_mode: 'glofox', fixed_windows: [],
  device_ids: ['d1', 'd2'],
  ...over,
  now: { on_count: 0, member_count: 2, mode: 'idle', until: null, next_on: null, ...now },
})

describe('groupTone', () => {
  it('mixed when SOME but not all members read on — the "1 of 2 on" state (Review Focus 2, phone half)', () => {
    // One member offline during a group press: the route answers `partial` and
    // the next list shows on_count 1 of 2. That is amber, never green.
    expect(groupTone(group({}, { on_count: 1, member_count: 2 }))).toBe('mixed')
    expect(groupTone(group({}, { on_count: 2, member_count: 3 }))).toBe('mixed')
  })

  it('on when every member reads on, off when none does', () => {
    expect(groupTone(group({}, { on_count: 2, member_count: 2 }))).toBe('on')
    expect(groupTone(group({}, { on_count: 0, member_count: 2 }))).toBe('off')
  })

  it('an empty group (or a missing `now`) is off — nothing is on', () => {
    expect(groupTone(group({ device_ids: [] }, { on_count: 0, member_count: 0 }))).toBe('off')
    expect(groupTone({})).toBe('off')
    expect(groupTone(null)).toBe('off')
  })

  it('offline when every member the device list holds reads online:false — it beats a stale "on"', () => {
    const devices = [
      { id: 'd1', last_state: { online: false, output: true } },
      { id: 'd2', last_state: { online: false, output: true } },
      { id: 'other', last_state: { online: true, output: true } },
    ]
    expect(groupTone(group({}, { on_count: 2, member_count: 2 }), devices)).toBe('offline')
  })

  it('one member online is NOT offline — the counts decide', () => {
    const devices = [
      { id: 'd1', last_state: { online: false, output: null } },
      { id: 'd2', last_state: { online: true, output: true } },
    ]
    expect(groupTone(group({}, { on_count: 1, member_count: 2 }), devices)).toBe('mixed')
  })

  it('an unknown online flag is not offline (absent is not a verdict)', () => {
    const devices = [{ id: 'd1', last_state: {} }, { id: 'd2', last_state: { online: null } }]
    expect(groupTone(group({}, { on_count: 0, member_count: 2 }), devices)).toBe('off')
  })
})

describe('groupReasonLine', () => {
  it('"Follows classes · on until 19:10" — the studio clock, not UTC', () => {
    const g = group({}, { mode: 'window', until: '2026-08-24T18:10:00.000Z' })
    expect(groupReasonLine(g, DUB, G_NOW)).toBe('Follows classes · on until 19:10')
  })

  it('a New York studio reads its own clock', () => {
    const g = group({}, { mode: 'window', until: '2026-08-24T23:10:00.000Z' })
    expect(groupReasonLine(g, 'America/New_York', G_NOW)).toBe('Follows classes · on until 19:10')
  })

  it('follows classes: next on, none left, and an unreadable timetable', () => {
    expect(groupReasonLine(group({}, { mode: 'idle', next_on: '2026-08-24T16:30:00.000Z' }), DUB, G_NOW))
      .toBe('Follows classes · next on at 17:30')
    expect(groupReasonLine(group(), DUB, G_NOW)).toBe('Follows classes · no more classes today')
    // windows_unread: say so, never invent a time.
    expect(groupReasonLine(group({}, { mode: 'idle', windows_unread: true, next_on: '2026-08-24T16:30:00.000Z' }), DUB, G_NOW))
      .toBe("Follows classes · couldn't read today's classes")
  })

  it('"Fixed hours · 06:00–21:00" — today\'s windows by the studio weekday', () => {
    const g = group({
      schedule_mode: 'fixed',
      fixed_windows: [
        { days: [1, 2, 3, 4, 5], on: '06:00', off: '21:00' },
        { days: [6, 7], on: '08:00', off: '14:00' },
      ],
    })
    expect(groupReasonLine(g, DUB, G_NOW)).toBe('Fixed hours · 06:00–21:00')
  })

  it('fixed hours: several windows joined, none today, and an overnight window still open', () => {
    const several = group({
      schedule_mode: 'fixed',
      fixed_windows: [{ days: [1], on: '17:00', off: '21:00' }, { days: [1], on: '06:00', off: '09:00' }],
    })
    expect(groupReasonLine(several, DUB, G_NOW)).toBe('Fixed hours · 06:00–09:00, 17:00–21:00')
    const weekend = group({ schedule_mode: 'fixed', fixed_windows: [{ days: [6, 7], on: '08:00', off: '14:00' }] })
    expect(groupReasonLine(weekend, DUB, G_NOW)).toBe('Fixed hours · off today')
    const overnight = group(
      { schedule_mode: 'fixed', fixed_windows: [{ days: [7], on: '22:00', off: '02:00' }] },
      { mode: 'window', until: '2026-08-24T13:30:00.000Z' },
    )
    expect(groupReasonLine(overnight, DUB, G_NOW)).toBe('Fixed hours · on until 14:30')
  })

  it('"1 of 2 on · manual until midnight" — mixed prefixes the reason, lower-cased', () => {
    const g = group({ schedule_mode: 'fixed' }, { mode: 'override', until: DUB_MIDNIGHT, on_count: 1, member_count: 2 })
    expect(groupReasonLine(g, DUB, G_NOW)).toBe('1 of 2 on · manual until midnight')
  })

  it('a manual override that is not midnight names its end, with a day when it is not today', () => {
    expect(groupReasonLine(group({}, { mode: 'override', until: '2026-08-24T15:00:00.000Z' }), DUB, G_NOW))
      .toBe('Manual until 16:00')
    expect(groupReasonLine(group({}, { mode: 'override', until: '2026-08-25T15:00:00.000Z' }), DUB, G_NOW))
      .toBe('Manual until 16:00 tomorrow')
  })

  it('an override on an unmanaged group stays until changed — no countdown nobody keeps', () => {
    const g = group({ enabled: false }, { mode: 'override', until: DUB_MIDNIGHT })
    expect(groupReasonLine(g, DUB, G_NOW)).toBe('Manual · stays until changed')
  })

  it('"Never automatic" — a switched-off group, or mode none', () => {
    expect(groupReasonLine(group({ enabled: false }), DUB, G_NOW)).toBe('Never automatic')
    expect(groupReasonLine(group({ schedule_mode: 'none' }), DUB, G_NOW)).toBe('Never automatic')
    expect(groupReasonLine(group({}, { mode: 'none' }), DUB, G_NOW)).toBe('Never automatic')
  })

  it('an unusable zone falls back to the default zone rather than throwing', () => {
    const g = group({}, { mode: 'window', until: '2026-08-24T18:10:00.000Z' })
    expect(groupReasonLine(g, 'Not/AZone', G_NOW)).toBe('Follows classes · on until 19:10')
  })
})

describe('overrideUntilLabel', () => {
  it('today, tomorrow, later in the week, and junk', () => {
    expect(overrideUntilLabel('2026-08-24T15:00:00.000Z', G_NOW, DUB)).toBe('16:00')
    expect(overrideUntilLabel('2026-08-25T15:00:00.000Z', G_NOW, DUB)).toBe('16:00 tomorrow')
    expect(overrideUntilLabel('2026-08-27T15:00:00.000Z', G_NOW, DUB)).toBe('Thu 16:00')
    expect(overrideUntilLabel(null, G_NOW, DUB)).toBe('')
    expect(overrideUntilLabel('nope', G_NOW, DUB)).toBe('')
  })
})

describe('lightStateLabel', () => {
  it('"On · 55%" for a light that is on, rounded', () => {
    expect(lightStateLabel({ kind: 'light', last_state: { output: true, brightness: 55 } })).toBe('On · 55%')
    expect(lightStateLabel({ kind: 'light', last_state: { output: true, brightness: 54.6 } })).toBe('On · 55%')
  })

  it('a light with no brightness reading is plain On; off and unknown are the relay words', () => {
    expect(lightStateLabel({ kind: 'light', last_state: { output: true } })).toBe('On')
    expect(lightStateLabel({ kind: 'light', last_state: { output: false, brightness: 55 } })).toBe('Off')
    expect(lightStateLabel({ kind: 'light', last_state: { output: null } })).toBe('Unknown')
    expect(lightStateLabel(null)).toBe('Unknown')
  })

  it('a switch never shows a brightness, even if a stray key rode in', () => {
    expect(lightStateLabel({ kind: 'switch', last_state: { output: true, brightness: 55 } })).toBe('On')
    expect(lightStateLabel({ last_state: { output: true, brightness: 55 } })).toBe('On')
  })
})

describe('memberPowerText', () => {
  it('watts when measured, "Doesn’t report power" only for an ONLINE reading with both absent', () => {
    expect(memberPowerText({ last_state: { online: true, apower: 41.6 } })).toBe('42 W')
    expect(memberPowerText({ last_state: { online: true, apower: null, aenergy_wh: null } })).toBe('Doesn’t report power')
    // Offline or unknown: we do not know the hardware meters nothing.
    expect(memberPowerText({ last_state: { online: false } })).toBe('—')
    expect(memberPowerText({ last_state: { online: true, aenergy_wh: 12 } })).toBe('—')
    expect(memberPowerText(null)).toBe('—')
  })
})
