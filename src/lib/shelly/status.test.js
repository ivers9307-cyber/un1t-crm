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
