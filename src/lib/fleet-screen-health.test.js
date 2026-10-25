import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { runScreenHealth } from './fleet-screen-health.js'
import { logError, logWarn } from '@/lib/log'
import { makeFakeDb } from './tv-admin.test-helpers.js'

const NOW = new Date('2026-10-24T12:00:00.000Z').getTime()
const ago = (ms) => new Date(NOW - ms).toISOString()
const LOC = 'a0000000-0000-4000-8000-0000000000a1'

const screenRow = (n, last_heartbeat_at) => ({ device_name: `hatch-screen${n}`, last_heartbeat_at, location_id: LOC })

function dbWith({ screens = [], priors = [], fleetError = null, priorError = null, upsertError = null } = {}) {
  return makeFakeDb((call) => {
    if (call.table === 'fleet_devices') return { data: fleetError ? null : screens, error: fleetError }
    if (call.table === 'fleet_device_health' && call.op === 'select') return { data: priorError ? null : priors, error: priorError }
    if (call.table === 'fleet_device_health' && call.op === 'upsert') return { data: null, error: upsertError }
    return { data: null, error: null }
  })
}
const upserts = (db) => db.calls.filter((c) => c.table === 'fleet_device_health' && c.op === 'upsert')

describe('runScreenHealth', () => {
  let notify
  beforeEach(() => {
    vi.clearAllMocks()
    notify = vi.fn(async () => true)
  })

  it('reads only claimed screens, and does nothing further when there are none', async () => {
    const db = dbWith({ screens: [] })
    const res = await runScreenHealth(db, { nowMs: NOW, notify })
    expect(res).toEqual({ checked: 0, alerted: 0 })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0]).toMatchObject({ table: 'fleet_devices', columns: 'device_name, last_heartbeat_at, location_id' })
    expect(db.calls[0].filters).toEqual([['eq', 'role', 'screen'], ['not', 'location_id', 'is', null]])
    expect(notify).not.toHaveBeenCalled()
  })

  it('grades every claimed screen, alerts once on a new outage and persists rows', async () => {
    const db = dbWith({
      screens: [screenRow(1, ago(60_000)), screenRow(2, ago(30 * 60_000)), screenRow(3, null)],
    })
    const res = await runScreenHealth(db, { nowMs: NOW, notify })
    expect(res).toEqual({ checked: 3, alerted: 1 })

    const prior = db.calls.find((c) => c.table === 'fleet_device_health' && c.op === 'select')
    expect(prior.columns).toBe('device_name, state, state_since, alerted_at, suppressed_until')
    expect(prior.filters).toEqual([['in', 'device_name', ['hatch-screen1', 'hatch-screen2', 'hatch-screen3']]])

    expect(notify).toHaveBeenCalledTimes(1)
    const [dbArg, alerts] = notify.mock.calls[0]
    expect(dbArg).toBe(db)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      name: 'hatch-screen2', state: 'unreachable', alert: 'down', detail: 'no heartbeat for 30 min',
    })

    const [up] = upserts(db)
    expect(up.options).toEqual({ onConflict: 'device_name' })
    expect(up.payload).toHaveLength(3)
    const byName = Object.fromEntries(up.payload.map((r) => [r.device_name, r]))
    expect(byName['hatch-screen2']).toMatchObject({ state: 'unreachable', alerted_at: new Date(NOW).toISOString() })
    expect(byName['hatch-screen1']).toMatchObject({ state: 'ok', alerted_at: null })
    expect(byName['hatch-screen3']).toMatchObject({ state: 'ok', alerted_at: null })
  })

  it('an outage already alerted on stays quiet', async () => {
    const stamp = ago(60 * 60_000)
    const db = dbWith({
      screens: [screenRow(2, ago(90 * 60_000))],
      priors: [{ device_name: 'hatch-screen2', state: 'unreachable', state_since: stamp, alerted_at: stamp, suppressed_until: null }],
    })
    const res = await runScreenHealth(db, { nowMs: NOW, notify })
    expect(res).toEqual({ checked: 1, alerted: 0 })
    expect(notify).not.toHaveBeenCalled()
    expect(upserts(db)[0].payload[0]).toMatchObject({ alerted_at: stamp, state_since: stamp })
  })

  it('a failed notify rolls alerted_at back so the next tick alerts again', async () => {
    notify.mockResolvedValue(false)
    const db = dbWith({ screens: [screenRow(2, ago(30 * 60_000))] })
    const res = await runScreenHealth(db, { nowMs: NOW, notify })
    expect(res).toEqual({ checked: 1, alerted: 1 })
    expect(upserts(db)[0].payload[0].alerted_at).toBeNull()
  })

  it('a thrown notify is logged and rolls back too', async () => {
    notify.mockRejectedValue(new Error('postmark down'))
    const db = dbWith({ screens: [screenRow(2, ago(30 * 60_000))] })
    await expect(runScreenHealth(db, { nowMs: NOW, notify })).resolves.toEqual({ checked: 1, alerted: 1 })
    expect(logError).toHaveBeenCalled()
    expect(upserts(db)[0].payload[0].alerted_at).toBeNull()
  })

  it('a failed recovery notice restores the prior outage stamp', async () => {
    notify.mockResolvedValue(false)
    const stamp = ago(60 * 60_000)
    const db = dbWith({
      screens: [screenRow(2, ago(60_000))],
      priors: [{ device_name: 'hatch-screen2', state: 'unreachable', state_since: stamp, alerted_at: stamp, suppressed_until: null }],
    })
    await runScreenHealth(db, { nowMs: NOW, notify })
    const [, alerts] = notify.mock.calls[0]
    expect(alerts[0].alert).toBe('recovered')
    expect(upserts(db)[0].payload[0]).toMatchObject({ state: 'ok', alerted_at: stamp })
  })

  it('a delivered recovery clears alerted_at', async () => {
    const stamp = ago(60 * 60_000)
    const db = dbWith({
      screens: [screenRow(2, ago(60_000))],
      priors: [{ device_name: 'hatch-screen2', state: 'unreachable', state_since: stamp, alerted_at: stamp, suppressed_until: null }],
    })
    await runScreenHealth(db, { nowMs: NOW, notify })
    expect(upserts(db)[0].payload[0].alerted_at).toBeNull()
  })

  it('a failed upsert warns but does not throw', async () => {
    const db = dbWith({ screens: [screenRow(1, ago(60_000))], upsertError: { message: 'boom' } })
    await expect(runScreenHealth(db, { nowMs: NOW, notify })).resolves.toEqual({ checked: 1, alerted: 0 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('a fleet_devices read error skips the pass without throwing', async () => {
    const db = dbWith({ fleetError: { message: 'down' } })
    await expect(runScreenHealth(db, { nowMs: NOW, notify })).resolves.toEqual({ checked: 0, alerted: 0 })
    expect(logError).toHaveBeenCalledWith('fleet-health', 'screen pass skipped', expect.anything())
    expect(notify).not.toHaveBeenCalled()
    expect(upserts(db)).toHaveLength(0)
  })

  it('a priors read error skips the pass without grading (an unknown prior must not re-alert)', async () => {
    const db = dbWith({ screens: [screenRow(2, ago(30 * 60_000))], priorError: { message: 'down' } })
    await expect(runScreenHealth(db, { nowMs: NOW, notify })).resolves.toEqual({ checked: 0, alerted: 0 })
    expect(logError).toHaveBeenCalledWith('fleet-health', 'screen pass skipped', expect.anything())
    expect(notify).not.toHaveBeenCalled()
    expect(upserts(db)).toHaveLength(0)
  })

  it('a db that throws outright is swallowed', async () => {
    const db = { from() { throw new Error('socket') } }
    await expect(runScreenHealth(db, { nowMs: NOW, notify })).resolves.toEqual({ checked: 0, alerted: 0 })
    expect(logError).toHaveBeenCalledWith('fleet-health', 'screen pass skipped', expect.anything())
  })
})
