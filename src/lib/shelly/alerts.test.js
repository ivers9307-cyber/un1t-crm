import { describe, it, expect, vi, beforeEach } from 'vitest'
import { planShellyAlerts, runShellyAlerts, ALERT_ROLES, OFFLINE_AFTER_MS, OFFLINE_ALERT_WINDOW_MS } from './alerts'
import { logWarn } from '@/lib/log'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/push-dedup', () => ({ sendPushToRolesAtLocationOnce: vi.fn() }))

beforeEach(() => { vi.clearAllMocks() })

// Monday 6 July 2026, 15:00 in Dublin (IST = UTC+1).
const NOW = Date.parse('2026-07-06T14:00:00Z')
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()

const conn = (over = {}) => ({ id: 'c1', location_id: 'loc-A', status: 'connected', last_ok_at: '2026-07-06T13:59:00.000Z', last_error_at: null, ...over })
const online = (over = {}) => ({ online: true, output: true, apower: 10, aenergy_wh: 1, temperature_c: 30, source: 'x', at: iso(NOW), ...over })
const offline = (over = {}) => ({ ...online(), online: false, ...over })
const dev = (over = {}) => ({
  id: 'd1', location_id: 'loc-A', device_id: 'aabbcc000001', channel: 0, name: 'Sauna',
  last_state: online(), last_seen_at: iso(NOW), ...over,
})

const input = (over = {}) => ({ locationId: 'loc-A', conn: conn(), devices: [dev()], nowMs: NOW, tz: 'Europe/Dublin', ...over })

describe('planShellyAlerts', () => {
  it('a healthy studio owes nothing', () => {
    expect(planShellyAlerts(input())).toEqual([])
  })

  it('key rejected: one alert keyed on the outage (last_ok_at), deep-linked to Smart plugs', () => {
    const [a, ...rest] = planShellyAlerts(input({ keyRejected: true, studioName: 'Hatch Street' }))
    expect(rest).toEqual([])
    expect(a.eventKey).toBe('shelly_key:c1:2026-07-06T13:59:00.000Z')
    expect(a.payload).toEqual({
      title: 'Smart plugs need attention at Hatch Street',
      body: "Shelly stopped accepting the studio's key. Re-paste it on the web Smart plugs page.",
      data: { type: 'shelly_alert', kind: 'key_rejected', location_id: 'loc-A' },
      category: 'shelly_alert',
    })
  })

  it('key rejected: the key does not move when the reconcile re-stamps last_error_at', () => {
    const k1 = planShellyAlerts(input({ keyRejected: true, conn: conn({ status: 'action_needed', last_error_at: iso(NOW - 15 * MIN) }) }))[0].eventKey
    const k2 = planShellyAlerts(input({ keyRejected: true, conn: conn({ status: 'action_needed', last_error_at: iso(NOW) }) }))[0].eventKey
    expect(k1).toBe(k2)
    expect(planShellyAlerts(input({ keyRejected: true, conn: conn({ last_ok_at: null }) }))[0].eventKey).toBe('shelly_key:c1:never')
  })

  it('offline: pushes once past 15 minutes, keyed on last_seen_at, in the studio’s clock', () => {
    const seen = iso(NOW - 20 * MIN) // 14:40 Dublin
    const [a] = planShellyAlerts(input({ devices: [dev({ last_state: offline(), last_seen_at: seen })] }))
    expect(a.kind).toBe('offline')
    expect(a.eventKey).toBe(`shelly_offline:d1:${seen}`)
    expect(a.payload.body).toBe('Sauna has been offline since 14:40.')
    expect(a.payload.data).toEqual({ type: 'shelly_alert', kind: 'offline', location_id: 'loc-A', device_id: 'd1' })
    expect(a.payload.category).toBe('shelly_alert')
  })

  it('offline: the same instant reads in a New York studio’s clock', () => {
    const seen = iso(NOW - 20 * MIN)
    const [a] = planShellyAlerts(input({ tz: 'America/New_York', devices: [dev({ last_state: offline(), last_seen_at: seen })] }))
    expect(a.payload.body).toBe('Sauna has been offline since 09:40.')
  })

  it('offline: names the day when the outage began on an earlier local day', () => {
    const seen = '2026-07-05T22:30:00.000Z' // 23:30 Sunday in Dublin
    const [a] = planShellyAlerts(input({ devices: [dev({ last_state: offline(), last_seen_at: seen })] }))
    expect(a.payload.body).toBe('Sauna has been offline since 5 Jul 23:30.')
  })

  it('offline: nothing under 15 minutes, past the 24-hour window, or for a never-seen device', () => {
    for (const d of [
      dev({ last_state: offline(), last_seen_at: iso(NOW - OFFLINE_AFTER_MS + 1) }),
      dev({ last_state: offline(), last_seen_at: iso(NOW - OFFLINE_ALERT_WINDOW_MS - 1) }),
      dev({ last_state: offline(), last_seen_at: null }),
      dev({ last_state: null, last_seen_at: iso(NOW - 60 * MIN) }),
      dev({ last_state: online(), last_seen_at: iso(NOW - 60 * MIN) }),
    ]) expect(planShellyAlerts(input({ devices: [d] }))).toEqual([])
  })

  it('offline: one push per BOX, named for its rows, keyed on its first row', () => {
    const seen = iso(NOW - 30 * MIN)
    const rows = [0, 1, 2, 3].map((ch) => dev({ id: `r${ch}`, channel: ch, name: `Light ${ch + 1}`, last_state: offline(), last_seen_at: seen }))
    const alerts = planShellyAlerts(input({ devices: rows }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].eventKey).toBe(`shelly_offline:r0:${seen}`)
    expect(alerts[0].payload.body).toBe('Light 1 and 3 more has been offline since 14:30.')
  })

  it('offline: a box with one row still talking is not offline', () => {
    const seen = iso(NOW - 30 * MIN)
    const rows = [dev({ id: 'r0', last_state: offline(), last_seen_at: seen }), dev({ id: 'r1', channel: 1, last_state: online(), last_seen_at: iso(NOW) })]
    expect(planShellyAlerts(input({ devices: rows }))).toEqual([])
  })

  it('power fault: words the protections, keyed on sorted faults and the local day', () => {
    const [a] = planShellyAlerts(input({ devices: [dev({ last_state: online({ errors: ['overtemp', 'overpower'] }) })] }))
    expect(a.kind).toBe('fault')
    expect(a.eventKey).toBe('shelly_fault:d1:overpower,overtemp:2026-07-06')
    expect(a.payload.body).toBe('Sauna reported overpower and overheating and may have switched off.')
    expect(a.payload.data).toEqual({ type: 'shelly_alert', kind: 'fault', location_id: 'loc-A', device_id: 'd1' })
  })

  it('power fault: the day is the studio’s, not UTC’s', () => {
    // 23:30 Monday in New York is already Tuesday in UTC.
    const ny = Date.parse('2026-07-07T03:30:00Z')
    const [a] = planShellyAlerts(input({ nowMs: ny, tz: 'America/New_York', devices: [dev({ last_state: online({ errors: ['undervoltage'], at: iso(ny) }), last_seen_at: iso(ny) })] }))
    expect(a.eventKey).toBe('shelly_fault:d1:undervoltage:2026-07-06')
    expect(a.payload.body).toBe('Sauna reported under-voltage and may have switched off.')
  })

  it('power fault: unknown codes and offline devices push nothing', () => {
    expect(planShellyAlerts(input({ devices: [dev({ last_state: online({ errors: ['cal_abort'] }) })] }))).toEqual([])
    expect(planShellyAlerts(input({ devices: [dev({ last_state: offline({ errors: ['overpower'] }), last_seen_at: iso(NOW - 5 * MIN) })] }))).toEqual([])
  })

  it('power fault: a box-wide fault is one push; known faults only in the key', () => {
    const rows = [0, 1].map((ch) => dev({ id: `r${ch}`, channel: ch, name: `Fan ${ch + 1}`, last_state: online({ errors: ['overvoltage', 'cal_abort'] }) }))
    const alerts = planShellyAlerts(input({ devices: rows }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].eventKey).toBe('shelly_fault:r0:overvoltage:2026-07-06')
    expect(alerts[0].payload.body).toBe('Fan 1 and 1 more reported over-voltage and may have switched off.')
  })

  it('an unnamed device still reads as a sentence', () => {
    const [a] = planShellyAlerts(input({ devices: [dev({ name: null, last_state: online({ errors: ['overpower'] }) })] }))
    expect(a.payload.body).toBe('A smart plug reported overpower and may have switched off.')
  })
})

describe('runShellyAlerts', () => {
  const faulty = () => input({ keyRejected: true, devices: [dev({ last_state: online({ errors: ['overpower'] }) })] })

  it('sends each alert to owners and managers at the location', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 2, failed: 0 })
    const db = {}
    const r = await runShellyAlerts(db, faulty(), { send })
    expect(r).toEqual({ alerts: 2, sent: 2, failed: 0 })
    expect(ALERT_ROLES).toEqual(['owner', 'manager'])
    expect(send).toHaveBeenCalledWith(db, 'shelly_key:c1:2026-07-06T13:59:00.000Z', 'loc-A', ['owner', 'manager'], expect.objectContaining({ category: 'shelly_alert' }))
    expect(send).toHaveBeenCalledWith(db, 'shelly_fault:d1:overpower:2026-07-06', 'loc-A', ['owner', 'manager'], expect.objectContaining({ category: 'shelly_alert' }))
  })

  it('once per key: the ledger says deduped on a second tick, and that is not a failure', async () => {
    const seen = new Set()
    const send = vi.fn(async (_db, key) => (seen.has(key) ? { sent: 0, deduped: 2 } : (seen.add(key), { sent: 2 })))
    const first = await runShellyAlerts({}, faulty(), { send })
    const second = await runShellyAlerts({}, faulty(), { send })
    expect(first.sent).toBe(2)
    expect(second).toEqual({ alerts: 2, sent: 0, failed: 0 })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('healthy: nothing is sent', async () => {
    const send = vi.fn()
    expect(await runShellyAlerts({}, input(), { send })).toEqual({ alerts: 0, sent: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('a push that throws is logged with ids only and swallowed; the next alert still goes', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('expo down')).mockResolvedValueOnce({ sent: 1 })
    const r = await runShellyAlerts({}, faulty(), { send })
    expect(r).toEqual({ alerts: 2, sent: 1, failed: 1 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalledWith('shelly-alerts', 'alert push failed', { locationId: 'loc-A', kind: 'key_rejected', deviceId: null, err: 'expo down' })
  })

  it('an undelivered push (failed / unreadable recipients) is counted and logged', async () => {
    const send = vi.fn().mockResolvedValueOnce({ sent: 0, failed: 1 }).mockResolvedValueOnce({ recipients_failed: 1 })
    const r = await runShellyAlerts({}, faulty(), { send })
    expect(r.failed).toBe(2)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('a bad clock or unplannable input sends nothing and never throws', async () => {
    const send = vi.fn()
    expect(await runShellyAlerts({}, { ...faulty(), nowMs: NaN }, { send })).toEqual({ alerts: 0, sent: 0, failed: 0 })
    expect(await runShellyAlerts({}, { ...faulty(), devices: [{ get last_state() { throw new Error('boom') } }] }, { send })).toEqual({ alerts: 0, sent: 0, failed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('defaults to the deduped role fan-out', async () => {
    const { sendPushToRolesAtLocationOnce } = await import('@/lib/push-dedup')
    sendPushToRolesAtLocationOnce.mockResolvedValue({ sent: 1 })
    await runShellyAlerts({}, input({ keyRejected: true }))
    expect(sendPushToRolesAtLocationOnce).toHaveBeenCalledTimes(1)
  })
})
