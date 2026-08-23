import { describe, it, expect } from 'vitest'
import { normaliseGetItems, normaliseAllStatus, stateFromReading, stateChanged, groupId } from './status'

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
