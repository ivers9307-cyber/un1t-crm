// SHELLYGROUPS.10 — the judgements behind the phone Smart plugs redesign.
//
// mobile/ has no React Native screen harness (only mobile/lib vitest in Node),
// so every decision the screen makes lives in mobile/lib/shelly.js and is
// pinned here; mobile/app/(staff)/shelly/index.jsx does IO and layout only.
// One describe block per line of the approved mockup:
//
//   • header           — studio · next class · total watts now
//   • banner           — "N devices on your Shelly account aren't set up here"
//   • group cards      — one switch, members underneath, in the server's order
//   • the group press  — pending/partial copy BEFORE any new state
//   • "Not in a group" — every device no listed group holds, never hidden
//   • members          — lights "On · 55%", "Offline" chip, watts

import { describe, it, expect } from 'vitest'
import {
  arrangeShellyCards, groupSwitchView, groupToggleOutcome, deviceSwitchView, memberMeta,
  totalWattsText, unadoptedBannerText, nextClassWindow, nextClassLabel, screenHeaderLine,
  groupIconName, GROUP_HOLDS_TEXT, GROUP_ICON_NAMES, groupReasonLine,
  showBackToSchedule, autoOutcomeText, groupAutoOutcome,
} from './shelly'

const DUBLIN = 'Europe/Dublin'
const NEW_YORK = 'America/New_York'
// 26 Oct 2026, 15:00 UTC = 15:00 Dublin (GMT, the day after the clocks went
// back) = 11:00 New York (EDT until 1 Nov).
const NOW = Date.parse('2026-10-26T15:00:00.000Z')

const dev = (id, over = {}) => ({ id, name: id, last_state: { online: true, output: false }, ...over })
const grp = (id, device_ids, now = {}, over = {}) => ({
  id, name: id, icon: 'bulb', enabled: true, schedule_mode: 'class', device_ids,
  now: { on_count: 0, member_count: device_ids.length, mode: 'idle', until: null, next_on: null, ...now },
  ...over,
})

// ── group cards + "Not in a group" ─────────────────────────────────────────
describe('arrangeShellyCards', () => {
  it('keeps the server order of groups and lists each group\'s members in its device_ids order', () => {
    const devices = [dev('a'), dev('b'), dev('c')]
    const groups = [grp('g2', ['c', 'a']), grp('g1', ['b'])]
    const r = arrangeShellyCards(devices, groups)
    expect(r.groups.map((x) => x.group.id)).toEqual(['g2', 'g1'])
    expect(r.groups[0].members.map((d) => d.id)).toEqual(['c', 'a'])
    expect(r.groups[1].members.map((d) => d.id)).toEqual(['b'])
    expect(r.ungrouped).toEqual([])
  })

  it('a device no listed group holds lands in "Not in a group", in the device list order', () => {
    const devices = [dev('a'), dev('b'), dev('c')]
    const r = arrangeShellyCards(devices, [grp('g1', ['b'])])
    expect(r.ungrouped.map((d) => d.id)).toEqual(['a', 'c'])
    expect(r.ungroupedTitle).toBe('Not in a group')
  })

  it('falls back to device.group_id when the group\'s device_ids missed it (a member read past a cap)', () => {
    const devices = [dev('a', { group_id: 'g1' }), dev('b')]
    const r = arrangeShellyCards(devices, [grp('g1', [])])
    expect(r.groups[0].members.map((d) => d.id)).toEqual(['a'])
    expect(r.ungrouped.map((d) => d.id)).toEqual(['b'])
  })

  it('a group_id naming a group the list does not hold is NEVER hidden — it is ungrouped', () => {
    const r = arrangeShellyCards([dev('a', { group_id: 'gone' })], [grp('g1', [])])
    expect(r.ungrouped.map((d) => d.id)).toEqual(['a'])
  })

  it('a device in two groups\' device_ids is drawn once, under the first', () => {
    const r = arrangeShellyCards([dev('a')], [grp('g1', ['a']), grp('g2', ['a'])])
    expect(r.groups[0].members.map((d) => d.id)).toEqual(['a'])
    expect(r.groups[1].members).toEqual([])
  })

  it('a member id the device list does not hold is skipped, not drawn as a blank row', () => {
    const r = arrangeShellyCards([dev('a')], [grp('g1', ['a', 'ghost'])])
    expect(r.groups[0].members.map((d) => d.id)).toEqual(['a'])
  })

  it('no groups (or an unread list) → every device in a plain "Devices" card, not "Not in a group"', () => {
    const devices = [dev('a'), dev('b')]
    for (const groups of [[], null, undefined]) {
      const r = arrangeShellyCards(devices, groups)
      expect(r.groups).toEqual([])
      expect(r.ungrouped.map((d) => d.id)).toEqual(['a', 'b'])
      expect(r.ungroupedTitle).toBe('Devices')
    }
  })

  it('no devices → nothing to draw', () => {
    expect(arrangeShellyCards(null, null)).toEqual({ groups: [], ungrouped: [], ungroupedTitle: 'Devices' })
  })
})

// ── the ONE group switch ───────────────────────────────────────────────────
describe('groupSwitchView', () => {
  it('green when every member is on; pressing turns it off', () => {
    const v = groupSwitchView(grp('Gym floor lights', ['a', 'b'], { on_count: 2 }))
    expect(v).toMatchObject({ tone: 'on', checked: true, nextState: 'off', empty: false, countText: null })
    expect(v.accessibilityLabel).toBe('Gym floor lights')
    expect(v.accessibilityValue).toBe(null)
  })

  it('grey when none is; pressing turns it on', () => {
    const v = groupSwitchView(grp('Fans', ['a', 'b']))
    expect(v).toMatchObject({ tone: 'off', checked: false, nextState: 'on' })
    expect(v.accessibilityLabel).toBe('Fans')
  })

  it('amber mixed shows "1 of 2 on", checked "mixed", and pressing brings the rest on', () => {
    const v = groupSwitchView(grp('Gym floor lights', ['a', 'b'], { on_count: 1 }))
    expect(v).toMatchObject({ tone: 'mixed', checked: 'mixed', nextState: 'on', countText: '1 of 2 on' })
    // The name only; the state rides on accessibilityState, the count on the value.
    expect(v.accessibilityLabel).toBe('Gym floor lights')
    expect(v.accessibilityValue).toBe('1 of 2 on')
  })

  it('an empty group says "No devices" and its switch is disabled', () => {
    const v = groupSwitchView(grp('Spare', [], { member_count: 0 }))
    expect(v).toMatchObject({ empty: true, disabled: true, countText: 'No devices' })
    expect(v.accessibilityLabel).toBe('Spare')
    expect(v.accessibilityValue).toBe('no devices')
  })

  it('every member offline → offline tone, still pressable (the press is queued, not lost)', () => {
    const devices = [dev('a', { last_state: { online: false, output: true } })]
    const v = groupSwitchView(grp('Sauna', ['a'], { on_count: 1 }), devices)
    expect(v).toMatchObject({ tone: 'offline', disabled: false, nextState: 'off' })
    expect(v.accessibilityLabel).toBe('Sauna')
    expect(v.accessibilityValue).toBe('offline')
  })

  it('only `connected === false` disables a group with members', () => {
    expect(groupSwitchView(grp('G', ['a']), [], { connected: false }).disabled).toBe(true)
    expect(groupSwitchView(grp('G', ['a']), [], { connected: null }).disabled).toBe(false)
    expect(groupSwitchView(grp('G', ['a']), [], { connected: undefined }).disabled).toBe(false)
  })

  it('a partial press paints amber "N of M on" until the next poll, over the server counts', () => {
    const v = groupSwitchView(grp('Gym floor lights', ['a', 'b']), [], { partial: { on: 1, count: 2 } })
    expect(v).toMatchObject({ tone: 'mixed', checked: 'mixed', countText: '1 of 2 on', nextState: 'on' })
    expect(v.accessibilityValue).toBe('1 of 2 on')
  })
})

// ── item 3: the count is printed once ──────────────────────────────────────
describe('groupReasonLine withCount:false (the phone card prints the count on its own line)', () => {
  it('drops the "1 of 2 on · " prefix that groupSwitchView\'s countText already shows', () => {
    const g = grp('G', ['a', 'b'], { on_count: 1, mode: 'none' }, { enabled: false, schedule_mode: 'none' })
    expect(groupReasonLine(g, DUBLIN, NOW)).toBe('1 of 2 on · never automatic')
    expect(groupReasonLine(g, DUBLIN, NOW, { withCount: false })).toBe('Never automatic')
    expect(groupSwitchView(g).countText).toBe('1 of 2 on')
  })
})

// ── the group press ─────────────────────────────────────────────────────────
describe('groupToggleOutcome', () => {
  it('applied all → "Switched on." and no partial', () => {
    expect(groupToggleOutcome({ success: true, applied: 'all', pending_device_ids: [] }, 'on', 2))
      .toEqual({ tone: 'ok', text: 'Switched on.', partial: null })
    expect(groupToggleOutcome({ success: true, applied: 'all', pending_device_ids: [] }, 'off', 2).text).toBe('Switched off.')
  })

  it('pending is read BEFORE success: a queued body (success:true) is never "Switched on."', () => {
    const json = { success: true, applied: 'none', pending: true, pending_device_ids: ['a', 'b'], message: 'Saved. Shelly cloud is not answering — the group will follow within a minute.' }
    expect(groupToggleOutcome(json, 'on', 2)).toEqual({ tone: 'warn', text: json.message, partial: null })
  })

  it('the 429 pending body (passed through by api()) is a queued answer, not an error', () => {
    const json = { success: true, applied: 'none', pending: true, status: 429, code: 'rate_limited', message: 'Saved. Shelly is busy right now — the group will follow within a minute.' }
    expect(groupToggleOutcome(json, 'on', 2)).toMatchObject({ tone: 'warn', text: json.message })
  })

  it('a queued body with no message still says it is saved', () => {
    expect(groupToggleOutcome({ success: true, pending: true, applied: 'none' }, 'on', 2).text)
      .toBe('Saved — the group will follow as soon as Shelly answers.')
  })

  it('partial → the route\'s message first, and an amber "N of M on" to paint until the next poll', () => {
    const json = { success: true, applied: 'partial', pending: true, pending_device_ids: ['b'], message: '1 of 2 did not answer — it will follow as soon as it is back online.' }
    expect(groupToggleOutcome(json, 'on', 2)).toEqual({ tone: 'warn', text: json.message, partial: { on: 1, count: 2 } })
  })

  it('a partial OFF counts the members that did not move as still on', () => {
    const json = { success: true, applied: 'partial', pending: true, pending_device_ids: ['b'], message: 'm' }
    expect(groupToggleOutcome(json, 'off', 3).partial).toEqual({ on: 1, count: 3 })
  })

  it('an unmanaged group\'s notice rides along (the route\'s own words first)', () => {
    const json = { success: true, applied: 'all', holds_until_changed: true, notice: 'Route words.' }
    expect(groupToggleOutcome(json, 'on', 1).text).toBe('Switched on. Route words.')
    expect(groupToggleOutcome({ ...json, notice: undefined }, 'on', 1).text).toBe(`Switched on. ${GROUP_HOLDS_TEXT}`)
    expect(groupToggleOutcome({ success: true, pending: true, applied: 'none', message: 'Saved.', holds_until_changed: true }, 'on', 1).text)
      .toBe(`Saved. ${GROUP_HOLDS_TEXT}`)
  })

  it('the route\'s full-stop-less GROUP_HOLDS_NOTICE still ends the composed sentence with one', () => {
    const notice = 'No schedule is running this group, so its lights stay as you set them until you change them'
    const json = { success: true, applied: 'all', holds_until_changed: true, notice }
    expect(groupToggleOutcome(json, 'on', 2).text).toBe(`Switched on. ${notice}.`)
    expect(groupToggleOutcome({ success: true, pending: true, applied: 'none', message: 'Saved.', holds_until_changed: true, notice }, 'off', 2).text)
      .toBe(`Saved. ${notice}.`)
  })

  describe('pending members are worded by their own code, named', () => {
    const names = { a: 'Front light', b: 'Back light' }
    const nameOf = (id) => names[id] || 'a device'
    const body = (pending_members, over = {}) => ({
      success: true, applied: 'partial', pending: true, code: 'pending', message: 'Route words.',
      pending_device_ids: pending_members.map((p) => p.device_id), pending_members, ...over,
    })

    it('an offline member will follow when it is back online', () => {
      const json = body([{ device_id: 'b', code: 'device', shelly_code: 'DEVICE_OFFLINE', permanent: false }])
      expect(groupToggleOutcome(json, 'on', 2, nameOf)).toEqual({
        tone: 'warn',
        text: 'Switched on for 1 of 2. Back light did not answer — it will follow when it is back online.',
        partial: { on: 1, count: 2 },
      })
    })

    it('a permanent refusal says Shelly refused it, and never promises it will follow', () => {
      const json = body([{ device_id: 'b', code: 'device', shelly_code: 'BAD_CHANNEL', permanent: true }])
      const { text } = groupToggleOutcome(json, 'off', 2, nameOf)
      expect(text).toBe('Switched off for 1 of 2. Shelly refused Back light — check it in the Shelly app.')
      expect(text).not.toMatch(/back online/)
    })

    it('unverified and bad_device members are "couldn\'t confirm"', () => {
      const json = body([
        { device_id: 'a', code: 'unverified', permanent: false },
        { device_id: 'b', code: 'bad_device', permanent: false },
      ], { applied: 'none' })
      expect(groupToggleOutcome(json, 'on', 2, nameOf).text)
        .toBe("Saved. Nothing has moved yet. Couldn't confirm Front light and Back light.")
    })

    it('a WHOLE-batch failure shows the route\'s message, never "every light offline"', () => {
      // route.js: a failed setGroups gives every member code = res.kind and
      // answers `kind`; its `code` is 'pending' for network/http too.
      const network = body([
        { device_id: 'a', code: 'network', permanent: false },
        { device_id: 'b', code: 'network', permanent: false },
      ], { applied: 'none', code: 'pending', kind: 'network', message: 'Saved. Shelly cloud is not answering — the group will follow within a minute.' })
      expect(groupToggleOutcome(network, 'on', 2, nameOf).text).toBe(network.message)
      for (const [code, kind] of [['key_rejected', 'auth'], ['rate_limited', 'rate_limited'], ['bad_host', 'config'], ['device_refused', 'device']]) {
        const json = { ...network, code, kind, message: `Route says ${code}.` }
        expect(groupToggleOutcome(json, 'on', 2, nameOf).text).toBe(`Route says ${code}.`)
      }
    })

    it('a long list names three, then "and N others"', () => {
      const ids = ['a', 'b', 'c', 'd', 'e']
      const json = body(ids.map((id) => ({ device_id: id, code: 'device', permanent: false })), { applied: 'none' })
      const many = (id) => `Light ${id.toUpperCase()}`
      expect(groupToggleOutcome(json, 'on', 5, many).text)
        .toBe('Saved. Nothing has moved yet. Light A, Light B, Light C and 2 others did not answer — they will follow when they are back online.')
      const four = body(ids.slice(0, 4).map((id) => ({ device_id: id, code: 'device', permanent: false })), { applied: 'none' })
      expect(groupToggleOutcome(four, 'on', 4, many).text).toContain('Light A, Light B, Light C and 1 other did not answer')
    })

    it('the unmanaged notice still rides along', () => {
      const json = body([{ device_id: 'b', code: 'device', permanent: false }], { holds_until_changed: true })
      expect(groupToggleOutcome(json, 'on', 2, nameOf).text).toMatch(new RegExp(`back online\\. ${GROUP_HOLDS_TEXT}$`))
    })

    it('with no name lookup a member is "a device"; with no pending_members the route\'s message stands', () => {
      const json = body([{ device_id: 'b', code: 'device', permanent: false }])
      expect(groupToggleOutcome(json, 'on', 2).text).toContain('a device did not answer')
      expect(groupToggleOutcome({ ...json, pending_members: undefined }, 'on', 2, nameOf).text).toBe('Route words.')
    })
  })

  it('a failure renders the route\'s sentence; a missing answer a human one', () => {
    expect(groupToggleOutcome({ success: false, error: 'Group not found' }, 'on', 2))
      .toEqual({ tone: 'error', text: 'Group not found', partial: null })
    expect(groupToggleOutcome(null, 'on', 2)).toEqual({ tone: 'error', text: 'That did not work — try again', partial: null })
  })
})

// ── a device's own switch (members and "Not in a group") ───────────────────
describe('deviceSwitchView', () => {
  it('on / off read straight off the relay; pressing flips it', () => {
    expect(deviceSwitchView(dev('Fan', { last_state: { output: true } }))).toMatchObject({ checked: true, nextState: 'off', tone: 'on' })
    expect(deviceSwitchView(dev('Fan', { last_state: { output: false } }))).toMatchObject({ checked: false, nextState: 'on', tone: 'off' })
  })

  it('output null is unknown — neither side; the label is the name, the value says unknown', () => {
    const v = deviceSwitchView(dev('Fan', { last_state: { output: null } }))
    expect(v).toMatchObject({ checked: undefined, tone: 'unknown', nextState: 'on' })
    expect(v.accessibilityLabel).toBe('Fan')
    expect(v.accessibilityValue).toBe('state unknown')
  })

  it('an unknown relay the engine last switched ON is pressed OFF; anything else is pressed on', () => {
    const unknown = (last_applied) => dev('Fan', { last_state: { output: null }, last_applied })
    expect(deviceSwitchView(unknown({ action: 'on' })).nextState).toBe('off')
    expect(deviceSwitchView(unknown({ action: 'off' })).nextState).toBe('on')
    expect(deviceSwitchView(unknown(null)).nextState).toBe('on')
    // A known relay ignores last_applied: the reading wins.
    expect(deviceSwitchView(dev('Fan', { last_state: { output: false }, last_applied: { action: 'on' } })).nextState).toBe('on')
  })

  it('a light\'s brightness goes in the value, never the label', () => {
    const v = deviceSwitchView(dev('Bar', { kind: 'light', last_state: { output: true, brightness: 55 } }))
    expect(v.accessibilityLabel).toBe('Bar')
    expect(v.accessibilityValue).toBe('55%')
    expect(deviceSwitchView(dev('Plug', { last_state: { output: true, brightness: 55 } })).accessibilityValue).toBe(null)
  })

  it('only `connected === false` disables it (rule 3)', () => {
    expect(deviceSwitchView(dev('a'), false).disabled).toBe(true)
    expect(deviceSwitchView(dev('a'), null).disabled).toBe(false)
    expect(deviceSwitchView(dev('a'), true).disabled).toBe(false)
  })
})

describe('memberMeta', () => {
  it('an offline member gets the Offline chip and no power figure', () => {
    expect(memberMeta(dev('a', { last_state: { online: false, output: true, apower: 40 } })))
      .toEqual({ offline: true, power: null, state: 'On' })
  })

  it('a light shows "On · 55%" and its watts', () => {
    expect(memberMeta(dev('a', { kind: 'light', last_state: { online: true, output: true, brightness: 55, apower: 12.4 } })))
      .toEqual({ offline: false, power: '12 W', state: 'On · 55%' })
  })

  it('hardware that meters nothing says so; an unknown figure shows nothing', () => {
    expect(memberMeta(dev('a', { last_state: { online: true, output: true } })).power).toBe('Doesn’t report power')
    expect(memberMeta(dev('a', { last_state: { online: true, output: true, aenergy_wh: 3 } })).power).toBe(null)
  })
})

// ── header ──────────────────────────────────────────────────────────────────
describe('totalWattsText', () => {
  it('sums every live reading', () => {
    expect(totalWattsText([
      dev('a', { last_state: { online: true, apower: 400.4 } }),
      dev('b', { last_state: { online: true, apower: 12 } }),
      dev('c', { last_state: { online: true } }),
    ])).toBe('412 W now')
  })

  it('an offline plug\'s last figure is not "now"', () => {
    expect(totalWattsText([
      dev('a', { last_state: { online: false, apower: 400 } }),
      dev('b', { last_state: { online: true, apower: 5 } }),
    ])).toBe('5 W now')
  })

  it('no reading at all → null (absent is not zero), but a real 0 W is shown', () => {
    expect(totalWattsText([dev('a')])).toBe(null)
    expect(totalWattsText([])).toBe(null)
    expect(totalWattsText(null)).toBe(null)
    expect(totalWattsText([dev('a', { last_state: { online: true, apower: 0 } })])).toBe('0 W now')
  })
})

describe('unadoptedBannerText', () => {
  it('above 0 → the banner, singular and plural', () => {
    expect(unadoptedBannerText(3)).toBe('3 devices on your Shelly account aren’t set up here — set them up on the web CRM.')
    expect(unadoptedBannerText(1)).toBe('1 device on your Shelly account isn’t set up here — set it up on the web CRM.')
  })

  it('0 and null (an unread discover list) hide it', () => {
    expect(unadoptedBannerText(0)).toBe(null)
    expect(unadoptedBannerText(null)).toBe(null)
    expect(unadoptedBannerText(undefined)).toBe(null)
  })
})

describe('nextClassWindow', () => {
  it('now until the STUDIO\'s next midnight', () => {
    expect(nextClassWindow(NOW, DUBLIN)).toEqual({
      fromIso: '2026-10-26T15:00:00.000Z',
      toIso: '2026-10-27T00:00:00.000Z',
    })
    // New York's midnight is 04:00 UTC while EDT holds.
    expect(nextClassWindow(NOW, NEW_YORK).toIso).toBe('2026-10-27T04:00:00.000Z')
  })
})

describe('nextClassLabel', () => {
  const occ = (iso, name, over = {}) => ({ starts_at: iso, name, program: null, cancelled_at: null, ...over })

  it('the first class still to start, on the studio clock', () => {
    const list = [occ('2026-10-26T14:00:00Z', 'EARLY'), occ('2026-10-26T18:00:00Z', 'BU1LD'), occ('2026-10-26T19:00:00Z', 'LATE')]
    expect(nextClassLabel(list, NOW, DUBLIN)).toBe('next class 18:00 BU1LD')
    expect(nextClassLabel(list, NOW, NEW_YORK)).toBe('next class 14:00 BU1LD')
  })

  it('takes the soonest whatever order the rows came in, skips cancelled ones', () => {
    const list = [occ('2026-10-26T19:00:00Z', 'LATE'), occ('2026-10-26T18:00:00Z', 'BU1LD', { cancelled_at: 'x' }), occ('2026-10-26T18:30:00Z', 'HYROX')]
    expect(nextClassLabel(list, NOW, DUBLIN)).toBe('next class 18:30 HYROX')
  })

  it('falls back to the program, then to no name', () => {
    expect(nextClassLabel([occ('2026-10-26T18:00:00Z', null, { program: 'Strength' })], NOW, DUBLIN)).toBe('next class 18:00 Strength')
    expect(nextClassLabel([occ('2026-10-26T18:00:00Z', null)], NOW, DUBLIN)).toBe('next class 18:00')
  })

  it('nothing left today, or an unread list → null (the part is omitted)', () => {
    expect(nextClassLabel([occ('2026-10-26T14:00:00Z', 'EARLY')], NOW, DUBLIN)).toBe(null)
    expect(nextClassLabel([], NOW, DUBLIN)).toBe(null)
    expect(nextClassLabel(null, NOW, DUBLIN)).toBe(null)
  })
})

describe('screenHeaderLine', () => {
  it('studio · next class · watts, each part dropped when unknown', () => {
    expect(screenHeaderLine({ studio: 'UN1T Stillorgan', nextClass: 'next class 18:00 BU1LD', watts: '412 W now' }))
      .toBe('UN1T Stillorgan · next class 18:00 BU1LD · 412 W now')
    expect(screenHeaderLine({ studio: 'UN1T Stillorgan', nextClass: null, watts: '412 W now' })).toBe('UN1T Stillorgan · 412 W now')
    expect(screenHeaderLine({ studio: null, nextClass: null, watts: null })).toBe('')
  })
})

describe('groupIconName', () => {
  it('maps each group icon to an Ionicons glyph, and anything else to the plug', () => {
    expect(groupIconName('bulb')).toBe('bulb-outline')
    expect(groupIconName('tv')).toBe('tv-outline')
    expect(groupIconName('droplet')).toBe('water-outline')
    expect(groupIconName('fan')).toBe(GROUP_ICON_NAMES.fan)
    expect(groupIconName('plug')).toBe(GROUP_ICON_NAMES.plug)
    expect(groupIconName('nope')).toBe(GROUP_ICON_NAMES.plug)
    expect(groupIconName(undefined)).toBe(GROUP_ICON_NAMES.plug)
  })
})

// ── item 1: Back to schedule ───────────────────────────────────────────────
describe('showBackToSchedule', () => {
  it('only a managed group on a manual override offers it', () => {
    expect(showBackToSchedule(grp('G', ['a'], { mode: 'override' }))).toBe(true)
    expect(showBackToSchedule(grp('G', ['a'], { mode: 'override' }, { schedule_mode: 'fixed' }))).toBe(true)
    expect(showBackToSchedule(grp('G', ['a'], { mode: 'window' }))).toBe(false)
    expect(showBackToSchedule(grp('G', ['a'], { mode: 'override' }, { enabled: false }))).toBe(false)
    expect(showBackToSchedule(grp('G', ['a'], { mode: 'override' }, { schedule_mode: 'none' }))).toBe(false)
    expect(showBackToSchedule(null)).toBe(false)
  })
})

describe('autoOutcomeText', () => {
  const nameOf = (id) => ({ a: 'Bar', b: 'Fan', c: 'Lamp' }[id] || 'a device')

  it('every member moved → null', () => {
    expect(autoOutcomeText([{ device_id: 'a', applied: 'on' }], nameOf)).toBe(null)
    expect(autoOutcomeText([], nameOf)).toBe(null)
    expect(autoOutcomeText(undefined, nameOf)).toBe(null)
  })

  it('an unreadable timetable switched nothing', () => {
    expect(autoOutcomeText([{ device_id: 'a', applied: null, code: 'occurrences' }], nameOf))
      .toBe("Couldn't read today's classes — nothing was switched. Try again in a minute.")
  })

  it('names who did not answer, who was refused and who was skipped', () => {
    const results = [
      { device_id: 'a', applied: 'on', reason: 'window' },
      { device_id: 'b', applied: null, code: 'offline' },
      { device_id: 'c', applied: null, code: 'x', permanent: true },
    ]
    expect(autoOutcomeText(results, nameOf)).toBe(
      'Back on schedule for 1 of 3. Shelly refused Lamp — check it in the Shelly app. Fan did not answer — it will follow when it is back online.',
    )
    expect(autoOutcomeText([{ device_id: 'a', applied: null, code: 'plan_mismatch' }, { device_id: 'b', applied: null, code: 'plan_mismatch' }], nameOf))
      .toBe('Nothing moved yet. Bar and Fan were not switched.')
  })

  it('an account-wide code is said once, pointing at the web CRM', () => {
    const results = [{ device_id: 'a', applied: null, code: 'rate_limited' }, { device_id: 'b', applied: null, code: 'rate_limited' }]
    expect(autoOutcomeText(results, nameOf)).toBe('Nothing moved yet. Shelly is busy right now — the group will follow within a minute.')
  })
})

describe('groupAutoOutcome', () => {
  const nameOf = () => 'Fan'

  it('applied all → "Back on schedule."', () => {
    expect(groupAutoOutcome({ success: true, applied: 'all', results: [] }, nameOf)).toEqual({ tone: 'ok', text: 'Back on schedule.' })
  })

  it('applied null with a reason → nothing to go back to', () => {
    expect(groupAutoOutcome({ success: true, applied: null, reason: 'no_schedule', results: [] }, nameOf).tone).toBe('warn')
    expect(groupAutoOutcome({ success: true, applied: null, reason: 'disabled', results: [] }, nameOf).text)
      .toMatch(/^This group has no schedule/)
  })

  it('partial / none read results[] (pending BEFORE success); a route message wins', () => {
    const results = [{ device_id: 'a', applied: 'on' }, { device_id: 'b', applied: null, code: 'offline' }]
    expect(groupAutoOutcome({ success: true, applied: 'partial', results }, nameOf)).toEqual({
      tone: 'warn', text: 'Back on schedule for 1 of 2. Fan did not answer — it will follow when it is back online.',
    })
    expect(groupAutoOutcome({ success: true, applied: 'none', results, message: 'Route words.' }, nameOf).text).toBe('Route words.')
    expect(groupAutoOutcome({ success: true, applied: 'none', pending: true, results: [] }, nameOf).tone).toBe('warn')
  })

  it('a failure renders the route\'s sentence; a missing answer a human one', () => {
    expect(groupAutoOutcome({ success: false, error: 'Group not found' }, nameOf)).toEqual({ tone: 'error', text: 'Group not found' })
    expect(groupAutoOutcome(null, nameOf)).toEqual({ tone: 'error', text: 'That did not work — try again' })
  })
})
