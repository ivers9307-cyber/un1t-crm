import { describe, it, expect } from 'vitest'
import {
  normaliseGetItems, normaliseAllStatus, stateFromReading, stateChanged, groupId,
  resolveDeviceName, nameShapeDiagnostic, rawItemsOf, rawItemId,
  normaliseDeviceListNames, deviceListShapeDiagnostic,
} from './status'

const plugS = {
  id: 'A8032ABE41FC', code: 'SNPL-00112EU', gen: 2, online: 1,
  settings: { sys: { device: { name: 'Treadmill 1' } } },
  status: { 'switch:0': { id: 0, output: true, apower: 412.3, voltage: 231, current: 1.8, aenergy: { total: 11679.5, by_minute: [1, 2, 3] }, temperature: { tC: 41.2 }, source: 'WS_in' } },
}
const pro4pm = { id: 'f008d1d8b8b8', code: 'SPSW-004PE16EU', gen: 2, online: 1,
  status: { 'switch:0': { output: false, apower: 0 }, 'switch:1': { output: true, apower: 55 }, 'switch:2': { output: false }, 'switch:3': { output: true } } }
const plus1 = { id: 'aaaaaaaaaaaa', code: 'SNSW-001X16EU', gen: 2, online: 1, status: { 'switch:0': { output: true } } }
const em3 = { id: 'bbbbbbbbbbbb', code: 'SPEM-003CEBEU', gen: 2, online: 1, status: { 'em:0': { a_act_power: 1200 } } }
const gen1 = { id: 'cccccccccccc', type: 'SHPLG-S', gen: 1, online: true, status: { relays: [{ ison: true }], meters: [{ power: 30, total: 6000 }] } }
const gen3 = { id: 'dddddddddddd', code: 'S3PL-00112EU', gen: 3, online: 1, status: { 'switch:0': { output: false, apower: 0, aenergy: { total: 5 } } } }
const offline = { id: 'eeeeeeeeeeee', code: 'SNPL-00112EU', gen: 2, online: 0, status: {} }

describe('normaliseGetItems', () => {
  it('normalises a Plug S with every field, lowercasing the id', () => {
    const [d] = normaliseGetItems([plugS])
    expect(d).toMatchObject({ device_id: 'a8032abe41fc', online: true, gen: 2, model: 'SNPL-00112EU', name: 'Treadmill 1', supported: true })
    expect(d.channels).toEqual([{ channel: 0, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in' }])
  })
  it('expands a Pro 4PM into four channels', () => {
    const [d] = normaliseGetItems([pro4pm])
    expect(d.channels.map((c) => c.channel)).toEqual([0, 1, 2, 3])
    expect(d.channels[1]).toMatchObject({ output: true, apower: 55 })
  })
  it('a non-metering Plus 1 has null power/energy, not zero', () => {
    const [d] = normaliseGetItems([plus1])
    expect(d.channels[0]).toMatchObject({ apower: null, aenergy_wh: null })
  })
  it('marks a Pro 3EM (no switch) and a Gen1 device unsupported, with reasons', () => {
    const [a, b] = normaliseGetItems([em3, gen1])
    expect(a).toMatchObject({ supported: false, reason: 'no_switch' })
    expect(b).toMatchObject({ supported: false, reason: 'gen1', online: true })
  })
  it('Gen3 is supported (gen >= 2)', () => {
    expect(normaliseGetItems([gen3])[0].supported).toBe(true)
  })
  it('an offline device with an empty status is supported:null with no channels, not unsupported', () => {
    const [d] = normaliseGetItems([offline])
    expect(d).toMatchObject({ online: false, supported: null, channels: [] })
  })
  it('tolerates wrapped bodies and drops entries without an id', () => {
    expect(normaliseGetItems({ data: [plugS, { gen: 2 }] })).toHaveLength(1)
    expect(normaliseGetItems(null)).toEqual([])
  })
})

describe('normaliseAllStatus (v1 discovery)', () => {
  it('flattens devices_status into per-channel rows and tolerates a missing _dev_info', () => {
    const body = { isok: true, data: { devices_status: {
      a8032abe41fc: { _dev_info: { code: 'SNPL-00112EU', gen: 'G2', online: true }, 'switch:0': { output: true }, sys: { device: { name: 'Fan' } } },
      f008d1d8b8b8: { 'switch:0': { output: false }, 'switch:1': { output: true } },
    } } }
    const rows = normaliseAllStatus(body)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ device_id: 'a8032abe41fc', channel: 0, model: 'SNPL-00112EU', gen: 2, online: true, output: true, name: 'Fan', supported: true })
    expect(rows[2]).toMatchObject({ device_id: 'f008d1d8b8b8', channel: 1, output: true })
  })
  it('marks Gen1 shapes unsupported', () => {
    const body = { isok: true, data: { devices_status: { cccccccccccc: { _dev_info: { code: 'SHPLG-S', gen: 'G1' }, relays: [{ ison: true }] } } } }
    expect(normaliseAllStatus(body)[0]).toMatchObject({ supported: false, reason: 'gen1' })
  })

  // SHELLY-UI.4b — the name is the whole point of the adopt list: without the
  // envelope fallback a v1 account that names its devices only in _dev_info
  // renders as a wall of MACs.
  it('takes the name from the entry first, then from the _dev_info envelope', () => {
    const one = (entry) => normaliseAllStatus({ data: { devices_status: { a8032abe41fc: entry } } })[0]
    // The device's own report wins.
    expect(one({ _dev_info: { gen: 2, online: true, name: 'Envelope name' }, sys: { device: { name: 'Sauna' } }, 'switch:0': {} }).name).toBe('Sauna')
    expect(one({ _dev_info: { gen: 2, online: true, name: 'Envelope name' }, name: 'Entry name', 'switch:0': {} }).name).toBe('Entry name')
    // ...and the envelope is the fallback when it did not report one.
    expect(one({ _dev_info: { gen: 2, online: true, name: 'Ice machine' }, 'switch:0': {} }).name).toBe('Ice machine')
    // A blank envelope name is junk, not a value.
    expect(one({ _dev_info: { gen: 2, online: true, name: '  ' }, 'switch:0': {} }).name).toBeNull()
    // Neither: null, and the card renders its own placeholder.
    expect(one({ _dev_info: { gen: 2, online: true }, 'switch:0': {} }).name).toBeNull()
    // No envelope at all must not throw.
    expect(one({ 'switch:0': {} }).name).toBeNull()
  })
})

describe('stateFromReading / stateChanged', () => {
  const reading = normaliseGetItems([plugS])[0]
  it('builds last_state from a channel reading', () => {
    expect(stateFromReading(null, reading, 0, 'T1')).toEqual({ online: true, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in', at: 'T1' })
  })
  it('offline keeps the previous output/apower and flips online', () => {
    const prev = { online: true, output: true, apower: 412.3, aenergy_wh: 11679.5, temperature_c: 41.2, source: 'WS_in', at: 'T1' }
    const off = normaliseGetItems([offline])[0]
    expect(stateFromReading(prev, off, 0, 'T2')).toEqual({ ...prev, online: false, at: 'T2' })
  })
  it('stateChanged ignores sub-threshold jitter but fires on output, online, 1 Wh, 1 °C, or a 5-minute refresh', () => {
    const base = { online: true, output: true, apower: 100, aenergy_wh: 10, temperature_c: 40, source: 'x', at: '2026-07-06T10:00:00.000Z' }
    expect(stateChanged(base, { ...base, apower: 100.3, at: '2026-07-06T10:01:00.000Z' })).toBe(false)
    expect(stateChanged(base, { ...base, output: false })).toBe(true)
    expect(stateChanged(base, { ...base, aenergy_wh: 11 })).toBe(true)
    expect(stateChanged(base, { ...base, temperature_c: 41 })).toBe(true)
    expect(stateChanged(base, { ...base, at: '2026-07-06T10:06:00.000Z' })).toBe(true)
    expect(stateChanged(null, base)).toBe(true)
  })
  it('groupId is <device_id>_<channel>', () => {
    expect(groupId({ device_id: 'a8032abe41fc', channel: 2 })).toBe('a8032abe41fc_2')
  })
})

// ---------------------------------------------------------------------------
// SHELLY.4b — regression pins. Everything above is the plan's original 13 and
// is untouched. These pin the review fixes and the deliberate deviations from
// the plan's draft module, so a later edit cannot quietly undo them.
// ---------------------------------------------------------------------------

describe('supported is judged on positive component evidence (SHELLY.4b)', () => {
  const v1row = (entry) => normaliseAllStatus({ isok: true, data: { devices_status: { aaaaaaaaaaaa: entry } } })[0]

  it('an offline v1 Plug S carrying only envelope keys stays adoptable (supported:null)', () => {
    const r = v1row({ _dev_info: { code: 'SNPL-00112EU', gen: 'G2', online: false }, cloud: { connected: false } })
    expect(r).toMatchObject({ online: false, supported: null })
    expect(r.reason).toBeUndefined()
  })
  it('an online v2 device reporting only singleton components is unknown, not unsupported', () => {
    const [d] = normaliseGetItems([{ id: 'aaaaaaaaaaaa', code: 'SNPL-00112EU', gen: 2, online: 1, status: { cloud: {}, sys: {}, wifi: {} } }])
    expect(d).toMatchObject({ supported: null, channels: [] })
    expect(d.reason).toBeUndefined()
  })
  it('a Pro 3EM (em:0) is a real verdict on both paths', () => {
    expect(normaliseGetItems([em3])[0]).toMatchObject({ supported: false, reason: 'no_switch' })
    expect(v1row({ _dev_info: { gen: 'G2' }, 'em:0': {}, cloud: {} })).toMatchObject({ supported: false, reason: 'no_switch' })
  })
  it('a Gen3 H&T (temperature:0 / humidity:0) is a real verdict', () => {
    const [d] = normaliseGetItems([{ id: 'ffffffffffff', code: 'S3SN-0U12A', gen: 3, online: 1, status: { 'temperature:0': { tC: 21 }, 'humidity:0': { rh: 50 }, sys: {}, cloud: {} } }])
    expect(d).toMatchObject({ supported: false, reason: 'no_switch' })
  })
})

describe('stateChanged is null-aware (SHELLY.4b)', () => {
  const base = { online: true, output: true, apower: 100, aenergy_wh: 10, temperature_c: 40, source: 'x', at: '2026-07-06T10:00:00.000Z' }

  it('a null -> number transition is a change, not sub-threshold jitter', () => {
    expect(stateChanged({ ...base, apower: null }, { ...base, apower: 0.2 })).toBe(true)
  })
  it('a number -> null transition is a change', () => {
    expect(stateChanged({ ...base, apower: 0.3 }, { ...base, apower: null })).toBe(true)
  })
  it('an unusable stored reading counts as changed, never as "no change"', () => {
    expect(stateChanged({ ...base, apower: 'abc' }, base)).toBe(true)
  })
  it('a 4-minute-old row with nothing moving is still left alone', () => {
    expect(stateChanged(base, { ...base, at: '2026-07-06T10:04:00.000Z' })).toBe(false)
  })
  it('a missing next never silently means "no change"', () => {
    expect(stateChanged(base, null)).toBe(true)
  })
})

describe('groupId refuses anything that is not a device row (SHELLY.4b)', () => {
  it('formats a row', () => {
    expect(groupId({ device_id: 'a8032abe41fc', channel: 0 })).toBe('a8032abe41fc_0')
  })
  it('throws rather than minting a group id that no command could ever match', () => {
    const reading = normaliseGetItems([plugS])[0] // carries `channels`, not `channel`
    for (const bad of [undefined, null, {}, reading, { device_id: 'aa' }, { device_id: 'aa', channel: '0' },
      { device_id: 'aa', channel: 1.5 }, { device_id: 'aa', channel: null }, { device_id: '', channel: 0 }]) {
      expect(() => groupId(bad)).toThrow(TypeError)
    }
  })
})

describe('parser deviations from the plan draft, pinned (SHELLY.4b)', () => {
  const chan0 = (sw) => normaliseGetItems([{ id: 'aaaaaaaaaaaa', gen: 2, online: 1, status: { 'switch:0': sw } }])[0].channels[0]

  it('absent is not zero: null, blank, [], false never become a 0 W reading', () => {
    for (const junk of [null, undefined, '', '   ', [], false, true, {}, NaN, Infinity]) {
      expect(chan0({ output: true, apower: junk })).toMatchObject({ apower: null })
    }
  })
  it('a stringly-typed body still parses', () => {
    expect(chan0({ aenergy: { total: '1234.5' } })).toMatchObject({ aenergy_wh: 1234.5 })
  })
  it("output is boolean-only — 'on' is not true", () => {
    expect(chan0({ output: 'on' })).toMatchObject({ output: null })
  })
  it('switch:00 cannot duplicate channel 0', () => {
    const [d] = normaliseGetItems([{ id: 'aaaaaaaaaaaa', gen: 2, online: 1, status: { 'switch:0': { output: true }, 'switch:00': { output: false }, 'switch:01': { output: false } } }])
    expect(d.channels.map((c) => c.channel)).toEqual([0])
  })
  it('a v1 Gen3 (_dev_info.gen "G3") is supported', () => {
    const rows = normaliseAllStatus({ data: { devices_status: { dddddddddddd: { _dev_info: { code: 'S3PL-00112EU', gen: 'G3', online: true }, 'switch:0': { output: true } } } } })
    expect(rows[0]).toMatchObject({ gen: 3, supported: true, online: true })
  })
  it('drops blank, whitespace and non-string ids on both paths', () => {
    expect(normaliseGetItems([{ id: '', status: {} }, { id: '   ', status: {} }, { id: {}, status: {} }, { id: [], status: {} }])).toEqual([])
    expect(normaliseGetItems([{ id: 12, status: {} }])[0].device_id).toBe('12')
    const rows = normaliseAllStatus({ data: { devices_status: { '   ': { 'switch:0': {} }, ' AA8B ': { 'switch:0': {} } } } })
    expect(rows.map((r) => r.device_id)).toEqual(['aa8b'])
  })
  it('a blank device name is null, not an empty string', () => {
    expect(normaliseGetItems([{ id: 'aa', settings: { sys: { device: { name: '  ' } } }, status: { 'switch:0': {} } }])[0].name).toBeNull()
  })
})

// ——— SHELLY-NAMES.1 ————————————————————————————————————————————————
//
// Six Shelly 1 Mini Gen3 relays adopted at Stillorgan with every card showing
// the `<model> · <last4>` placeholder, the devices plainly named in the Shelly
// app, and no warning out of the adopt route — `settings` came back and the
// label was not where nameFrom looks. These pin the wider net, and pin the
// diagnostic that will tell us which arm the live account actually needs.

describe('resolveDeviceName (SHELLY-NAMES.1)', () => {
  const item = (over) => ({ id: 'aabbccddeeff', gen: 2, online: 1, status: {}, ...over })

  it('reads the documented Gen2+ home first', () => {
    expect(resolveDeviceName(item({ settings: { sys: { device: { name: 'Reception heater' } } } }))).toBe('Reception heater')
  })

  it('falls through settings.device.name, settings.name and the envelope name, in that order', () => {
    expect(resolveDeviceName(item({ settings: { device: { name: 'Shallow' } } }))).toBe('Shallow')
    expect(resolveDeviceName(item({ settings: { name: 'Flat' } }))).toBe('Flat')
    expect(resolveDeviceName(item({ name: 'Envelope', settings: {} }))).toBe('Envelope')
    // Precedence, not merely presence: the deepest source wins when several
    // are populated at once.
    expect(resolveDeviceName(item({
      name: 'Envelope',
      settings: { name: 'Flat', device: { name: 'Shallow' }, sys: { device: { name: 'Deep' } } },
    }))).toBe('Deep')
  })

  it("SHELLY-NAMES.2: the cloud's DeviceInfo label wins over the on-device name", () => {
    // The Stillorgan live gate: six app-named Gen3 Minis, `sys.device.name`
    // present-but-NULL, and the app's label under the cloud-grafted
    // `settings.DeviceInfo`. The app names the ACCOUNT record, not the
    // device, so DeviceInfo outranks sys.device.name…
    expect(resolveDeviceName(item({
      settings: {
        DeviceInfo: { name: 'Reception lights' },
        sys: { device: { name: null } },
      },
    }))).toBe('Reception lights')
    expect(resolveDeviceName(item({
      settings: {
        DeviceInfo: { name: 'Cloud label' },
        sys: { device: { name: 'On-device name' } },
      },
    }))).toBe('Cloud label')
    // …but a MULTI-relay output name still beats it: DeviceInfo names the
    // box, and a 2PM's operator labelled the outputs.
    expect(resolveDeviceName(item({
      settings: {
        DeviceInfo: { name: 'The box' },
        'switch:0': { name: 'Left lamp' },
        'switch:1': { name: 'Right lamp' },
      },
    }), 1)).toBe('Right lamp')
    // A blank or absent DeviceInfo name falls through like every other arm.
    expect(resolveDeviceName(item({
      settings: { DeviceInfo: { name: '  ' }, sys: { device: { name: 'Deep' } } },
    }))).toBe('Deep')
  })

  it('a MULTI-relay device is labelled per OUTPUT — the box name loses', () => {
    // A 4PM is one box and four outputs, and it is the outputs an operator
    // names ("Sauna", "Ice bath"). Taking the box name for every channel would
    // render four identical cards.
    const pro = item({
      settings: {
        sys: { device: { name: 'Plant room 4PM' } },
        'switch:0': { name: 'Sauna' }, 'switch:1': { name: 'Ice bath' },
        'switch:2': {}, 'switch:3': { name: 'Fan' },
      },
      status: { 'switch:0': {}, 'switch:1': {}, 'switch:2': {}, 'switch:3': {} },
    })
    expect(resolveDeviceName(pro, 0)).toBe('Sauna')
    expect(resolveDeviceName(pro, 1)).toBe('Ice bath')
    expect(resolveDeviceName(pro, 3)).toBe('Fan')
    // The channel with no label of its own falls back to the BOX, never to
    // another channel's name.
    expect(resolveDeviceName(pro, 2)).toBe('Plant room 4PM')
  })

  it('…but on a SINGLE-relay device the box name wins over switch:0', () => {
    // There `switch:0.name` is usually absent or a factory label, so it is the
    // last resort rather than the first.
    const one = item({ settings: { sys: { device: { name: 'Sauna' } }, 'switch:0': { name: 'Switch 0' } }, status: { 'switch:0': {} } })
    expect(resolveDeviceName(one, 0)).toBe('Sauna')
    // Still better than the placeholder once every box-level source is empty.
    const bare = item({ settings: { 'switch:0': { name: 'Treadmill' } }, status: { 'switch:0': {} } })
    expect(resolveDeviceName(bare, 0)).toBe('Treadmill')
  })

  it('an OFFLINE multi-relay device is still per-output — settings names the channels when status does not', () => {
    // status is empty for an offline device (rule 2), so counting switch keys
    // there alone would demote a 4PM to the single-relay ordering.
    const offlinePro = item({
      online: 0, status: {},
      settings: { sys: { device: { name: 'Plant room' } }, 'switch:0': { name: 'Sauna' }, 'switch:1': { name: 'Ice bath' } },
    })
    expect(resolveDeviceName(offlinePro, 1)).toBe('Ice bath')
  })

  it('is defensive about status.sys.device.name, and answers null when nothing carries a label', () => {
    expect(resolveDeviceName(item({ status: { sys: { device: { name: 'Odd place' } } } }))).toBe('Odd place')
    expect(resolveDeviceName(item({ settings: {} }))).toBeNull()
    expect(resolveDeviceName(null)).toBeNull()
    expect(resolveDeviceName(undefined, 3)).toBeNull()
  })

  it('never returns a blank name, and never one the operator could not re-save', () => {
    // Blank/whitespace falls THROUGH rather than being stored as a chosen name.
    expect(resolveDeviceName(item({ settings: { sys: { device: { name: '   ' } }, name: 'Real' } }))).toBe('Real')
    expect(resolveDeviceName(item({ settings: { sys: { device: { name: '' } } } }))).toBeNull()
    expect(resolveDeviceName(item({ settings: { name: '  Padded  ' } }))).toBe('Padded')
    // 80 is ShellyAdoptBody/ShellyDevicePatch's cap: a longer name would be
    // storable here and rejected by the PATCH that merely re-saved it.
    expect(resolveDeviceName(item({ settings: { name: 'x'.repeat(200) } }))).toHaveLength(80)
  })

  it('tolerates a junk channel rather than minting a switch:undefined lookup', () => {
    const one = item({ settings: { 'switch:0': { name: 'Treadmill' } }, status: { 'switch:0': {} } })
    for (const bad of [null, undefined, -1, 1.5, 'x', {}]) {
      expect(resolveDeviceName(one, bad)).toBe('Treadmill')
    }
  })
})

describe('nameShapeDiagnostic (SHELLY-NAMES.1) — keys only, never values', () => {
  it('NEVER carries a payload VALUE — not the wifi password, not the name itself', () => {
    // settings carries the device's wifi credentials and its MQTT broker
    // password, which is why this is a shape report and not a payload log.
    const item = {
      id: 'aabbccddeeff', name: 'Envelope',
      settings: {
        wifi: { sta: { ssid: 'UN1T-GUEST', pass: 'SECRET_WIFI' } },
        mqtt: { pass: 'SECRET_MQTT' },
        sys: { device: { name: 'Reception', mac: 'AABBCCDDEEFF' } },
        DeviceInfo: { name: 'Reception', code: 'S3SW-001X8EU' },
        'switch:0': { name: 'Reception', initial_state: 'restore_last' },
      },
      status: { 'switch:0': { output: true } },
    }
    const json = JSON.stringify(nameShapeDiagnostic(item))
    expect(json).not.toContain('SECRET_WIFI')
    expect(json).not.toContain('SECRET_MQTT')
    expect(json).not.toContain('Reception')
    expect(json).not.toContain('UN1T-GUEST')
    expect(json).not.toContain('AABBCCDDEEFF')
    // The cloud-grafted envelope is descended keys-only like everything else.
    expect(nameShapeDiagnostic(item).deviceInfoKeys).toEqual(['code', 'name'])
    // …while still answering the question it exists to answer.
    expect(nameShapeDiagnostic(item)).toMatchObject({
      settingsType: 'object',
      settingsKeys: ['DeviceInfo', 'mqtt', 'switch:0', 'sys', 'wifi'],
      sysKeys: ['device'],
      deviceKeys: ['mac', 'name'],
      switchKeys: ['initial_state', 'name'],
      hasSysDeviceName: 'string',
      statusKeys: ['switch:0'],
    })
    expect(nameShapeDiagnostic(item).itemKeys).toEqual(['id', 'name', 'settings', 'status'])
  })

  it('separates "the key is absent" from "the key is there and is not a string"', () => {
    expect(nameShapeDiagnostic({ settings: { sys: { device: { mac: 'x' } } } }).hasSysDeviceName).toBe('absent')
    expect(nameShapeDiagnostic({ settings: { sys: { device: { name: null } } } }).hasSysDeviceName).toBe('null')
    expect(nameShapeDiagnostic({ settings: { sys: { device: { name: 42 } } } }).hasSysDeviceName).toBe('null')
    expect(nameShapeDiagnostic({ settings: {} }).hasSysDeviceName).toBe('absent')
  })

  it('reports the TYPE of a settings that is not an object at all — the drift we are hunting', () => {
    expect(nameShapeDiagnostic({ settings: 'nope' })).toMatchObject({ settingsType: 'string', settingsKeys: [] })
    expect(nameShapeDiagnostic({ settings: null })).toMatchObject({ settingsType: 'null' })
    expect(nameShapeDiagnostic({ settings: [] })).toMatchObject({ settingsType: 'array' })
    expect(nameShapeDiagnostic({})).toMatchObject({ settingsType: 'undefined' })
    // An absent item is a real answer too: the account never mentioned it.
    expect(nameShapeDiagnostic(undefined)).toMatchObject({ itemKeys: [], settingsType: 'undefined', statusKeys: [] })
  })

  it('falls back to settings.device when sys carries none, and caps a pathological body', () => {
    expect(nameShapeDiagnostic({ settings: { device: { name: 'x', fw: 'y' } } })).toMatchObject({
      sysKeys: [], deviceKeys: ['fw', 'name'], hasSysDeviceName: 'string',
    })
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${String(i).padStart(3, '0')}`, i]))
    const diag = nameShapeDiagnostic({ settings: wide })
    expect(diag.settingsKeys).toHaveLength(40)
    // Sorted, so two devices' shapes are comparable at a glance.
    expect(diag.settingsKeys[0]).toBe('k000')
  })
})

describe('rawItemsOf / rawItemId (SHELLY-NAMES.1)', () => {
  it('detects the same three list shapes normaliseGetItems does', () => {
    const a = { id: 'aa' }
    expect(rawItemsOf([a])).toEqual([a])
    expect(rawItemsOf({ devices: [a] })).toEqual([a])
    expect(rawItemsOf({ data: [a] })).toEqual([a])
    for (const junk of [null, undefined, {}, 'x', 3, { devices: {} }]) expect(rawItemsOf(junk)).toEqual([])
  })

  it('keys raw items exactly as normaliseGetItem keys the rows they become', () => {
    expect(rawItemId({ id: ' AABBCC ' })).toBe('aabbcc')
    expect(rawItemId({ id: 12 })).toBe('12')
    for (const bad of [{ id: '' }, { id: '  ' }, { id: {} }, { id: [] }, { id: null }, {}, null]) {
      expect(rawItemId(bad)).toBeNull()
    }
    // The pairing is the point — a raw item and its normalised row must key
    // identically or the two can never be matched up.
    const raw = { id: ' A8032ABE41FC ', gen: 2, status: {} }
    expect(rawItemId(raw)).toBe(normaliseGetItems([raw])[0].device_id)
  })
})

// ——— SHELLY-NAMES.3 ————————————————————————————————————————————————
//
// The v2 payload proved LABEL-FREE at the live gate: `sys.device.name`
// present-but-null and the cloud-grafted `DeviceInfo.name` null too on six
// app-named plugs. The app labels the ACCOUNT record, which the v2 Cloud
// Control API never returns — `/interface/device/list` is where it lives, and
// its shape is UNVERIFIED, which is what every probe below is for.

describe('normaliseDeviceListNames (SHELLY-NAMES.3)', () => {
  it('reads the ARRAY shape, lowercasing ids exactly as rawItemId does', () => {
    const map = normaliseDeviceListNames({ data: { devices: [
      { id: ' AABBCC112233 ', name: 'Reception heater' },
      { id: 'ddeeff445566', name: 'Ice bath' },
    ] } })
    expect(map.get('aabbcc112233')).toBe('Reception heater')
    expect(map.get('ddeeff445566')).toBe('Ice bath')
    expect(map.size).toBe(2)
  })

  it('reads the OBJECT-KEYED shape, taking the id from the key when the entry has none', () => {
    const map = normaliseDeviceListNames({ data: { devices: {
      AABBCC112233: { name: 'Reception heater' },
      // An entry that names itself wins over its key — same rule as the v2
      // side, where the item's own id is the identity.
      ddeeff445566: { id: '998877FFEEDD', name: 'Ice bath' },
    } } })
    expect(map.get('aabbcc112233')).toBe('Reception heater')
    expect(map.get('998877ffeedd')).toBe('Ice bath')
    expect(map.has('ddeeff445566')).toBe(false)
  })

  it('falls back to body.devices, and to the v1 _dev_info id', () => {
    expect(normaliseDeviceListNames({ devices: [{ id: 'aabbcc', name: 'Sauna' }] }).get('aabbcc')).toBe('Sauna')
    expect(normaliseDeviceListNames({ data: { devices: [{ _dev_info: { id: 'AABBCC' }, name: 'Sauna' }] } }).get('aabbcc')).toBe('Sauna')
  })

  it('accepts the other plausible spellings of the label, in order', () => {
    const one = (over) => normaliseDeviceListNames({ data: { devices: [{ id: 'aa', ...over }] } }).get('aa')
    expect(one({ label: 'Label' })).toBe('Label')
    expect(one({ device_name: 'Device name' })).toBe('Device name')
    expect(one({ alias: 'Alias' })).toBe('Alias')
    expect(one({ title: 'Title' })).toBe('Title')
    expect(one({ name: 'Name', label: 'Label' })).toBe('Name')
  })

  it('SKIPS an entry with no name — absence is not an empty label', () => {
    // An entry in the map is a claim that the account HAS a name for that
    // device; a '' would overwrite a real one on the overwrite branch.
    const map = normaliseDeviceListNames({ data: { devices: [
      { id: 'aa' }, { id: 'bb', name: '   ' }, { id: 'cc', name: 42 }, { id: 'dd', name: 'Real' },
    ] } })
    expect([...map.keys()]).toEqual(['dd'])
  })

  it('drops entries that are not identifiable, and caps a long label at the schema bound', () => {
    const map = normaliseDeviceListNames({ data: { devices: [
      { id: '', name: 'x' }, { id: '   ', name: 'x' }, { id: {}, name: 'x' }, { id: [], name: 'x' },
      'not an object', null, 7,
      { id: 12, name: 'Numeric id' },
      { id: 'long', name: 'N'.repeat(200) },
    ] } })
    expect(map.get('12')).toBe('Numeric id')
    expect(map.get('long')).toHaveLength(80)
    expect(map.size).toBe(2)
  })

  it('never throws on ANY shape — the endpoint is undocumented', () => {
    for (const junk of [null, undefined, 'x', 7, [], {}, { data: 'x' }, { data: { devices: 'x' } },
      { data: { devices: null } }, { devices: 7 }, { data: { devices: [undefined] } }]) {
      expect(normaliseDeviceListNames(junk).size).toBe(0)
    }
  })
})

describe('deviceListShapeDiagnostic (SHELLY-NAMES.3) — keys only, never values', () => {
  it('NEVER carries a payload VALUE — not the name, not a nested one', () => {
    const body = { isok: true, data: { devices: [{ id: 'aabbcc', name: 'Reception', room: { name: 'Studio floor' } }] } }
    const json = JSON.stringify(deviceListShapeDiagnostic(body))
    expect(json).not.toContain('Reception')
    expect(json).not.toContain('Studio floor')
    // …while still answering the question it exists to answer.
    expect(deviceListShapeDiagnostic(body)).toEqual({
      bodyKeys: ['data', 'isok'],
      dataKeys: ['devices'],
      devicesType: 'array',
      entryCount: 1,
      entryKeys: ['id', 'name', 'room'],
      nameProp: 'string',
    })
  })

  it('reports the object-keyed shape without reporting the device ids that key it', () => {
    const diag = deviceListShapeDiagnostic({ data: { devices: { aabbcc112233: { name: 'Reception' } } } })
    expect(diag).toMatchObject({ devicesType: 'object', entryCount: 1, entryKeys: ['name'], nameProp: 'string' })
    expect(JSON.stringify(diag)).not.toContain('aabbcc112233')
  })

  it('separates "no name key" from "a name key that is not a string"', () => {
    const one = (entry) => deviceListShapeDiagnostic({ data: { devices: [entry] } }).nameProp
    expect(one({ id: 'a' })).toBe('absent')
    expect(one({ id: 'a', name: null })).toBe('null')
    expect(one({ id: 'a', name: 42 })).toBe('null')
    expect(one({ id: 'a', name: 'x' })).toBe('string')
  })

  it('reports the TYPE of a body that carries no list at all — the drift we are hunting', () => {
    expect(deviceListShapeDiagnostic({ isok: true, data: { devices: 'nope' } }))
      .toMatchObject({ bodyKeys: ['data', 'isok'], dataKeys: ['devices'], devicesType: 'string', entryCount: 0, entryKeys: [], nameProp: 'absent' })
    expect(deviceListShapeDiagnostic({ isok: true, data: {} })).toMatchObject({ devicesType: 'undefined', entryCount: 0 })
    expect(deviceListShapeDiagnostic(null)).toMatchObject({ bodyKeys: [], dataKeys: [], devicesType: 'undefined', entryCount: 0 })
    expect(deviceListShapeDiagnostic({ data: { devices: [7] } })).toMatchObject({ devicesType: 'array', entryCount: 1, entryKeys: [] })
  })
})
