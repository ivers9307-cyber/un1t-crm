// STUDIOROUTINE.1 — Open studio / Close studio: lights, music and air con,
// never doors, each family on its own.
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { stripCommentsOfFile } from '../../tests/helpers/js-code.js'
import { runStudioRoutine, routineSummary } from './studio-routine.js'

const LOC = 'loc-1'
const ALL = { lights: true, music: true, ac: true }

function fakeApi(over = {}) {
  return {
    listShellyGroups: vi.fn(async () => ({ success: true, groups: [{ id: 'g1' }, { id: 'g2' }] })),
    toggleShellyGroup: vi.fn(async () => ({ success: true, applied: 'all' })),
    getSonosHousehold: vi.fn(async () => ({ success: true, connected: true, groups: [{ id: 's1' }] })),
    sendSonosAction: vi.fn(async () => ({ success: true })),
    listAcDevices: vi.fn(async () => ({ success: true, data: [{ id: 'a1' }, { id: 'a2' }] })),
    turnOnAcDevice: vi.fn(async () => ({ success: true })),
    turnOffAcDevice: vi.fn(async () => ({ success: true })),
    ...over,
  }
}

describe('runStudioRoutine', () => {
  it('Open: light groups on (no until: studio midnight), music plays, every unit on', async () => {
    const api = fakeApi()
    const out = await runStudioRoutine('open', { locationId: LOC, can: ALL, api })
    expect(out.map((r) => [r.family, r.status, r.switched, r.total])).toEqual([
      ['lights', 'done', 2, 2], ['music', 'done', 1, 1], ['ac', 'done', 2, 2],
    ])
    expect(api.toggleShellyGroup).toHaveBeenCalledWith('g1', { state: 'on' }, LOC)
    expect(api.sendSonosAction).toHaveBeenCalledWith({ groupId: 's1' }, 'play', undefined, LOC)
    expect(api.turnOnAcDevice).toHaveBeenCalledWith('a1', LOC)
    expect(api.turnOffAcDevice).not.toHaveBeenCalled()
  })

  it('Close: lights off, music paused, every unit off', async () => {
    const api = fakeApi()
    await runStudioRoutine('close', { locationId: LOC, can: ALL, api })
    expect(api.toggleShellyGroup).toHaveBeenCalledWith('g2', { state: 'off' }, LOC)
    expect(api.sendSonosAction).toHaveBeenCalledWith({ groupId: 's1' }, 'pause', undefined, LOC)
    expect(api.turnOffAcDevice).toHaveBeenCalledWith('a2', LOC)
    expect(api.turnOnAcDevice).not.toHaveBeenCalled()
  })

  it('a unit already running counts as switched on Open', async () => {
    const api = fakeApi({ turnOnAcDevice: vi.fn(async (id) => (id === 'a1' ? { success: false, code: 'already_running' } : { success: true })) })
    const [, , ac] = await runStudioRoutine('open', { locationId: LOC, can: ALL, api })
    expect(ac).toMatchObject({ status: 'done', switched: 2, total: 2 })
  })

  it('one family failing never stops the next; a partial group is not counted', async () => {
    const api = fakeApi({
      toggleShellyGroup: vi.fn(async (id) => (id === 'g1' ? { success: true, applied: 'partial' } : { success: true, applied: 'all' })),
      getSonosHousehold: vi.fn(async () => { throw new Error('boom') }),
      turnOffAcDevice: vi.fn(async (id) => (id === 'a1' ? { success: false, error: 'nope' } : { success: true })),
    })
    const out = await runStudioRoutine('close', { locationId: LOC, can: ALL, api })
    expect(out.map((r) => [r.family, r.status, r.switched])).toEqual([
      ['lights', 'partial', 1], ['music', 'failed', 0], ['ac', 'partial', 1],
    ])
  })

  it('a family the person may not use is skipped and never called', async () => {
    const api = fakeApi()
    const out = await runStudioRoutine('open', { locationId: LOC, can: { lights: true, music: true, ac: false }, api })
    expect(out[2]).toEqual({ family: 'ac', status: 'skipped', switched: 0, total: 0 })
    expect(api.listAcDevices).not.toHaveBeenCalled()
  })

  it('nothing set up, or Sonos not connected, says so', async () => {
    const api = fakeApi({
      listShellyGroups: vi.fn(async () => ({ success: true, groups: [] })),
      getSonosHousehold: vi.fn(async () => ({ success: true, connected: false })),
    })
    const out = await runStudioRoutine('open', { locationId: LOC, can: ALL, api })
    expect(out[0].status).toBe('none')
    expect(out[1]).toMatchObject({ status: 'failed', note: 'Sonos is not connected' })
    expect(routineSummary(out)).toEqual(['Lights: nothing set up here', 'Music: Sonos is not connected', 'Air con: 2 of 2 units'])
  })

  it('refuses an unknown mode or a missing studio', async () => {
    await expect(runStudioRoutine('unlock', { locationId: LOC, can: ALL, api: fakeApi() })).rejects.toThrow()
    await expect(runStudioRoutine('open', { locationId: null, can: ALL, api: fakeApi() })).rejects.toThrow()
  })
})

describe('never doors', () => {
  it('the routine module makes no door call', () => {
    // comments blanked by the shared stripper, then any door / unlock / UniFi reference
    const code = stripCommentsOfFile(path.resolve(import.meta.dirname, 'studio-routine.js'))
    expect(code).not.toMatch(/door|unlock|unifi/i)
  })
})
