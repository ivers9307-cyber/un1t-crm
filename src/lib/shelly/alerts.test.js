import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  planShellyAlerts, runShellyAlerts, readCooledBoxIds, boxIdsFromOfflineKey,
  ALERT_ROLES, OFFLINE_AFTER_MS, OFFLINE_ALERT_WINDOW_MS, MAX_NEW_SENDS, MAX_ATTEMPTS, OFFLINE_COOLDOWN_MS,
} from './alerts'
import { logWarn } from '@/lib/log'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/push-dedup', () => ({ sendPushOnce: vi.fn() }))
vi.mock('@/lib/push', () => ({ readRoleRecipientIds: vi.fn() }))

beforeEach(() => { vi.clearAllMocks() })

// Monday 6 July 2026, 15:00 in Dublin (IST = UTC+1).
const NOW = Date.parse('2026-07-06T14:00:00Z')
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()

const conn = (over = {}) => ({ id: 'c1', location_id: 'loc-A', status: 'connected', last_ok_at: '2026-07-06T13:59:00.000Z', last_error_at: null, ...over })
const online = (over = {}) => ({ online: true, output: true, apower: 10, aenergy_wh: 1, temperature_c: 30, source: 'x', at: iso(NOW), ...over })
const offline = (over = {}) => ({ ...online(), online: false, ...over })
const dev = (over = {}) => ({
  id: 'd1', location_id: 'loc-A', device_id: 'aabbcc000001', channel: 0, name: 'Sauna', enabled: true,
  last_state: online(), last_seen_at: iso(NOW), ...over,
})
// A dark box `id` last seen `minsAgo` minutes ago.
const darkBox = (id, minsAgo, name = `Plug ${id}`) => dev({ id, device_id: `mac-${id}`, name, last_state: offline(), last_seen_at: iso(NOW - minsAgo * MIN) })

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

  // Review item 4 — no read landed: only the key alert.
  it('deviceAlerts:false plans the key alert only, never offline or fault', () => {
    const devices = [darkBox('a', 30), dev({ id: 'f', device_id: 'mac-f', last_state: online({ errors: ['overpower'] }) })]
    expect(planShellyAlerts(input({ devices, deviceAlerts: false })).map((a) => a.kind)).toEqual([])
    expect(planShellyAlerts(input({ devices, deviceAlerts: false, keyRejected: true })).map((a) => a.kind)).toEqual(['key_rejected'])
    expect(planShellyAlerts(input({ devices })).map((a) => a.kind)).toEqual(['offline', 'fault'])
  })

  // Review item 6 — enabled is not a filter.
  it('a disabled (grouped) device alerts like any other', () => {
    const [a] = planShellyAlerts(input({ devices: [dev({ enabled: false, last_state: online({ errors: ['overpower'] }) })] }))
    expect(a.kind).toBe('fault')
  })

  it('offline: one box past 15 minutes is the per-box push, in the studio’s clock', () => {
    const seen = iso(NOW - 20 * MIN) // 14:40 Dublin
    const [a, ...rest] = planShellyAlerts(input({ devices: [dev({ last_state: offline(), last_seen_at: seen })] }))
    expect(rest).toEqual([])
    expect(a.kind).toBe('offline')
    expect(a.eventKey).toBe(`shelly_offline:loc-A:${seen}:d1`)
    expect(a.payload.body).toBe('Sauna has been offline since 14:40.')
    expect(a.payload.data).toEqual({ type: 'shelly_alert', kind: 'offline', location_id: 'loc-A', device_id: 'd1' })
    expect(a.payload.category).toBe('shelly_alert')
  })

  it('offline: the same instant reads in a New York studio’s clock', () => {
    const [a] = planShellyAlerts(input({ tz: 'America/New_York', devices: [darkBox('a', 20, 'Sauna')] }))
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

  it('offline: a box’s rows are one box, named for its rows', () => {
    const seen = iso(NOW - 30 * MIN)
    const rows = [0, 1, 2, 3].map((ch) => dev({ id: `r${ch}`, channel: ch, name: `Light ${ch + 1}`, last_state: offline(), last_seen_at: seen }))
    const alerts = planShellyAlerts(input({ devices: rows }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].eventKey).toBe(`shelly_offline:loc-A:${seen}:r0`)
    expect(alerts[0].payload.body).toBe('Light 1 and 3 more has been offline since 14:30.')
  })

  it('offline: a box with one row still talking is not offline', () => {
    const seen = iso(NOW - 30 * MIN)
    const rows = [dev({ id: 'r0', last_state: offline(), last_seen_at: seen }), dev({ id: 'r1', channel: 1, last_state: online(), last_seen_at: iso(NOW) })]
    expect(planShellyAlerts(input({ devices: rows }))).toEqual([])
  })

  // Review item 3 — a power cut is ONE push.
  it('offline: a power cut across 8 boxes is one push, keyed on the studio and the earliest sighting', () => {
    const boxes = Array.from({ length: 8 }, (_, i) => darkBox(`b${i}`, 30 - (i % 3), `Plug ${i + 1}`))
    const alerts = planShellyAlerts(input({ devices: boxes, studioName: 'Hatch Street' }))
    expect(alerts).toHaveLength(1)
    const [a] = alerts
    const earliest = iso(NOW - 30 * MIN)
    expect(a.eventKey).toBe(`shelly_offline:loc-A:${earliest}:b0,b1,b2,b3,b4,b5,b6,b7`)
    expect(a.payload.title).toBe('Smart plugs offline at Hatch Street')
    expect(a.payload.body).toBe('8 smart plugs offline at Hatch Street since 14:30: Plug 1, Plug 2 and 6 more.')
    expect(a.payload.data).toEqual({ type: 'shelly_alert', kind: 'offline', location_id: 'loc-A' })
  })

  it('offline: two or three boxes are named in full', () => {
    expect(planShellyAlerts(input({ devices: [darkBox('a', 20, 'Fan'), darkBox('b', 20, 'TV')] }))[0].payload.body)
      .toBe('2 smart plugs offline since 14:40: Fan and TV.')
    expect(planShellyAlerts(input({ devices: [darkBox('a', 20, 'Fan'), darkBox('b', 20, 'TV'), darkBox('c', 20, 'Sauna')] }))[0].payload.body)
      .toBe('3 smart plugs offline since 14:40: Fan, TV and Sauna.')
  })

  it('offline: a box that dropped 2 hours after the others is its own push', () => {
    const cut = [darkBox('a', 150), darkBox('b', 148)]
    const later = darkBox('c', 25)
    const alerts = planShellyAlerts(input({ devices: [...cut, later] }))
    expect(alerts.map((a) => a.eventKey)).toEqual([
      `shelly_offline:loc-A:${iso(NOW - 150 * MIN)}:a,b`,
      `shelly_offline:loc-A:${iso(NOW - 25 * MIN)}:c`,
    ])
  })

  it('offline: a cluster is due once its EARLIEST sighting is 15 minutes old', () => {
    // a dropped 16 min ago, b 5 min ago: one cluster, due now, both named.
    const alerts = planShellyAlerts(input({ devices: [darkBox('a', 16, 'A'), darkBox('b', 5, 'B')] }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].payload.body).toBe('2 smart plugs offline since 14:44: A and B.')
    expect(planShellyAlerts(input({ devices: [darkBox('a', 14), darkBox('b', 5)] }))).toEqual([])
  })

  // Review item 5 — per-box cool-down.
  it('offline: a cooled box is left out; the rest of its outage is still pushed', () => {
    expect(planShellyAlerts(input({ devices: [darkBox('a', 30)], cooledBoxIds: new Set(['a']) }))).toEqual([])
    const [a] = planShellyAlerts(input({ devices: [darkBox('a', 30), darkBox('b', 30, 'TV')], cooledBoxIds: new Set(['a']) }))
    expect(a.eventKey).toBe(`shelly_offline:loc-A:${iso(NOW - 30 * MIN)}:b`)
    expect(a.payload.body).toBe('TV has been offline since 14:30.')
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

describe('boxIdsFromOfflineKey', () => {
  it('reads the trailing ids past the ISO timestamp’s colons', () => {
    expect(boxIdsFromOfflineKey('shelly_offline:loc-A:2026-07-06T13:30:00.000Z:a,b')).toEqual(['a', 'b'])
    expect(boxIdsFromOfflineKey('shelly_fault:x:y')).toEqual([])
    expect(boxIdsFromOfflineKey(null)).toEqual([])
  })
})

describe('readCooledBoxIds', () => {
  const ledger = (result) => {
    const calls = []
    const chain = { calls }
    for (const m of ['select', 'gte', 'like', 'limit']) chain[m] = (...a) => { calls.push([m, a]); return m === 'limit' ? Promise.resolve(result) : chain }
    return { from: (t) => { calls.push(['from', [t]]); return chain }, calls }
  }

  it('one read of the last 2 hours of this studio’s offline keys, ids unioned', async () => {
    const db = ledger({ data: [
      { event_key: 'shelly_offline:loc-A:2026-07-06T13:30:00.000Z:a,b' },
      { event_key: 'shelly_offline:loc-A:2026-07-06T13:30:00.000Z:a,b' },
      { event_key: 'shelly_offline:loc-A:2026-07-06T12:30:00.000Z:c' },
    ], error: null })
    const ids = await readCooledBoxIds(db, 'loc-A', NOW)
    expect([...ids].sort()).toEqual(['a', 'b', 'c'])
    expect(db.calls).toEqual([
      ['from', ['push_event_sends']],
      ['select', ['event_key']],
      ['gte', ['sent_at', iso(NOW - OFFLINE_COOLDOWN_MS)]],
      ['like', ['event_key', 'shelly_offline:loc-A:%']],
      ['limit', [500]],
    ])
  })

  it('a failed read is logged and means no cool-down (a repeat beats a loss)', async () => {
    const ids = await readCooledBoxIds(ledger({ data: null, error: { message: 'pg down' } }), 'loc-A', NOW)
    expect(ids.size).toBe(0)
    expect(logWarn).toHaveBeenCalledWith('shelly-alerts', 'offline cool-down read failed; no cool-down this tick', { locationId: 'loc-A', error: 'pg down' })
  })
})

describe('runShellyAlerts', () => {
  const faulty = () => input({ keyRejected: true, devices: [dev({ last_state: online({ errors: ['overpower'] }) })] })
  const recipients = (ids = ['o1', 'm1']) => vi.fn().mockResolvedValue({ ids, error: null })
  const noCool = () => vi.fn().mockResolvedValue(new Set())

  it('reads the owners and managers ONCE and sends each alert scoped to the studio', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 2, failed: 0, deduped: 0 })
    const readRecipients = recipients()
    const db = {}
    const r = await runShellyAlerts(db, faulty(), { send, readRecipients, readCooled: noCool() })
    expect(r).toMatchObject({ alerts: 2, sent: 2, failed: 0, attempted: 2, deferred: 0 })
    expect(ALERT_ROLES).toEqual(['owner', 'manager'])
    expect(readRecipients).toHaveBeenCalledTimes(1)
    expect(readRecipients).toHaveBeenCalledWith(db, 'loc-A', ['owner', 'manager'])
    expect(send).toHaveBeenCalledWith(db, 'shelly_key:c1:2026-07-06T13:59:00.000Z', ['o1', 'm1'], expect.objectContaining({ category: 'shelly_alert' }), { locationId: 'loc-A' })
    expect(send).toHaveBeenCalledWith(db, 'shelly_fault:d1:overpower:2026-07-06', ['o1', 'm1'], expect.objectContaining({ category: 'shelly_alert' }), { locationId: 'loc-A' })
  })

  it('once per key: the ledger says deduped on a second tick, and that is not a failure', async () => {
    const seen = new Set()
    const send = vi.fn(async (_db, key, ids) => (seen.has(key) ? { sent: 0, deduped: ids.length } : (seen.add(key), { sent: 2, deduped: 0 })))
    const deps = { send, readRecipients: recipients(), readCooled: noCool() }
    const first = await runShellyAlerts({}, faulty(), deps)
    const second = await runShellyAlerts({}, faulty(), deps)
    expect(first.sent).toBe(2)
    expect(second).toMatchObject({ alerts: 2, sent: 0, failed: 0 })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('healthy: no recipients read, no cool-down read, nothing sent', async () => {
    const send = vi.fn()
    const readRecipients = recipients()
    const readCooled = noCool()
    expect(await runShellyAlerts({}, input(), { send, readRecipients, readCooled })).toMatchObject({ alerts: 0, sent: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(readRecipients).not.toHaveBeenCalled()
    expect(readCooled).not.toHaveBeenCalled()
  })

  // Review item 2 — bounded.
  it(`at most ${MAX_NEW_SENDS} alerts that claim somebody per pass; the rest wait for the next tick`, async () => {
    const devices = Array.from({ length: 6 }, (_, i) => dev({ id: `f${i}`, device_id: `mac-f${i}`, last_state: online({ errors: ['overpower'] }) }))
    const send = vi.fn().mockResolvedValue({ sent: 2, deduped: 0 })
    const r = await runShellyAlerts({}, input({ devices }), { send, readRecipients: recipients(), readCooled: noCool() })
    expect(send).toHaveBeenCalledTimes(MAX_NEW_SENDS)
    expect(r).toMatchObject({ alerts: 6, attempted: 3, deferred: 3 })
  })

  it('fully deduped alerts do not use the allowance (a standing alert cannot starve a new one); attempts are still capped', async () => {
    const devices = Array.from({ length: 12 }, (_, i) => dev({ id: `f${i}`, device_id: `mac-f${i}`, last_state: online({ errors: ['overpower'] }) }))
    const send = vi.fn(async (_db, key, ids) => (key.includes(':f11:') ? { sent: 2, deduped: 0 } : { sent: 0, deduped: ids.length }))
    const r = await runShellyAlerts({}, input({ devices }), { send, readRecipients: recipients(), readCooled: noCool() })
    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(r).toMatchObject({ attempted: MAX_ATTEMPTS, deferred: 2 })
  })

  it('a failed recipients read claims nothing and sends nothing', async () => {
    const send = vi.fn()
    const r = await runShellyAlerts({}, faulty(), { send, readRecipients: vi.fn().mockResolvedValue({ ids: [], error: { message: 'down' } }), readCooled: noCool() })
    expect(send).not.toHaveBeenCalled()
    expect(r.recipients_failed).toBe(1)
    expect(logWarn).toHaveBeenCalledWith('shelly-alerts', 'alert recipients read failed; nothing claimed, nobody told this tick', { locationId: 'loc-A', error: 'down' })
  })

  it('nobody holds the roles: nothing sent, nothing logged', async () => {
    const send = vi.fn()
    await runShellyAlerts({}, faulty(), { send, readRecipients: recipients([]), readCooled: noCool() })
    expect(send).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('the cool-down read runs only when a box is dark, and its answer is applied', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 2, deduped: 0 })
    const readCooled = vi.fn().mockResolvedValue(new Set(['a']))
    await runShellyAlerts({}, input({ devices: [darkBox('a', 30), darkBox('b', 30, 'TV')] }), { send, readRecipients: recipients(), readCooled })
    expect(readCooled).toHaveBeenCalledWith({}, 'loc-A', NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toBe(`shelly_offline:loc-A:${iso(NOW - 30 * MIN)}:b`)
  })

  it('deviceAlerts:false skips the cool-down read and every device alert', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 2, deduped: 0 })
    const readCooled = noCool()
    await runShellyAlerts({}, input({ keyRejected: true, deviceAlerts: false, devices: [darkBox('a', 30)] }), { send, readRecipients: recipients(), readCooled })
    expect(readCooled).not.toHaveBeenCalled()
    expect(send.mock.calls.map((c) => c[1])).toEqual(['shelly_key:c1:2026-07-06T13:59:00.000Z'])
  })

  it('a push that throws is logged with ids only and swallowed; the next alert still goes', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('expo down')).mockResolvedValueOnce({ sent: 1, deduped: 0 })
    const r = await runShellyAlerts({}, faulty(), { send, readRecipients: recipients(), readCooled: noCool() })
    expect(r).toMatchObject({ alerts: 2, sent: 1, failed: 1 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(logWarn).toHaveBeenCalledWith('shelly-alerts', 'alert push failed', { locationId: 'loc-A', kind: 'key_rejected', deviceId: null, err: 'expo down' })
  })

  it('an undelivered push is counted and logged', async () => {
    const send = vi.fn().mockResolvedValue({ sent: 0, failed: 2, deduped: 0 })
    const r = await runShellyAlerts({}, faulty(), { send, readRecipients: recipients(), readCooled: noCool() })
    expect(r.failed).toBe(2)
    expect(logWarn).toHaveBeenCalledTimes(2)
  })

  it('a bad clock or unplannable input sends nothing and never throws', async () => {
    const send = vi.fn()
    const deps = { send, readRecipients: recipients(), readCooled: noCool() }
    expect(await runShellyAlerts({}, { ...faulty(), nowMs: NaN }, deps)).toMatchObject({ alerts: 0, sent: 0 })
    expect(await runShellyAlerts({}, { ...faulty(), devices: [{ get last_state() { throw new Error('boom') } }] }, deps)).toMatchObject({ sent: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('defaults to sendPushOnce and readRoleRecipientIds', async () => {
    const { sendPushOnce } = await import('@/lib/push-dedup')
    const { readRoleRecipientIds } = await import('@/lib/push')
    readRoleRecipientIds.mockResolvedValue({ ids: ['o1'], error: null })
    sendPushOnce.mockResolvedValue({ sent: 1, deduped: 0 })
    await runShellyAlerts({}, input({ keyRejected: true }))
    expect(readRoleRecipientIds).toHaveBeenCalledTimes(1)
    expect(sendPushOnce).toHaveBeenCalledWith({}, 'shelly_key:c1:2026-07-06T13:59:00.000Z', ['o1'], expect.any(Object), { locationId: 'loc-A' })
  })
})
