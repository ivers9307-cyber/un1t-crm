// C127 LATEBLAST.1 (DECIDED by Richard, 30 Sep) — after C122 a SCHEDULED blast
// that fell due while its studio's WhatsApp was off waits, untouched, and is
// promoted on the first tick after the feature is back on. If by then it is
// more than N = 3 hours late it is NOT sent: it returns to draft with its
// schedule cleared, and the studio's managers are told through the existing
// scheduledStartFailureNotification push so they re-schedule. Drips pace
// themselves inside their window and are unchanged. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'b0000000-0000-4000-8000-00000000000b'
const PAST = '2026-01-01T09:00:00.000Z'
const H = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// A filter-aware fake of the supabase-js subset the route uses, including
// .not(), .or() (the skipped-count filter) and head counts.
let tables
let failTable
function makeDb() {
  return {
    from(table) {
      let rows = (tables[table] || []).slice()
      let head = false
      let patch = null
      const b = {}
      const chain = (fn) => (...args) => { fn(...args); return b }
      b.select = chain((_cols, opts) => { if (opts?.head) head = true })
      b.order = chain(() => {})
      b.limit = chain((n) => { rows = rows.slice(0, n) })
      b.eq = chain((c, v) => { rows = rows.filter((r) => r[c] === v) })
      b.lte = chain((c, v) => { rows = rows.filter((r) => r[c] != null && r[c] <= v) })
      b.is = chain((c, v) => { rows = rows.filter((r) => (r[c] ?? null) === v) })
      b.in = chain((c, vals) => { rows = rows.filter((r) => vals.includes(r[c])) })
      b.not = chain((c, op, v) => {
        if (op === 'is' && v === null) rows = rows.filter((r) => r[c] != null)
        else throw new Error(`fake .not(${op}) unsupported`)
      })
      b.or = chain((expr) => {
        const m = /^location_id\.is\.null,location_id\.not\.in\.\((.*)\)$/.exec(expr)
        if (!m) throw new Error(`fake .or(${expr}) unsupported`)
        const ids = m[1].split(',')
        rows = rows.filter((r) => r.location_id == null || !ids.includes(r.location_id))
      })
      b.update = chain((p) => { patch = p })
      b.then = (resolve, reject) => {
        let out
        if (failTable === table) out = { data: null, error: { message: 'boom' }, count: null }
        else if (patch) {
          for (const r of rows) Object.assign(r, patch)
          out = { data: rows.map((r) => ({ id: r.id })), error: null }
        } else out = head ? { data: null, error: null, count: rows.length } : { data: rows, error: null }
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => makeDb() }))
vi.mock('@/lib/whatsapp', () => ({
  sendDripChunk: vi.fn(async () => ({ sent: 1, failed: 0, status: 'sending' })),
  sendBroadcast: vi.fn(async () => ({ sent: 2, failed: 0, status: 'sending' })),
}))
vi.mock('@/lib/whatsapp-drip', () => ({ isWithinSendWindow: () => true }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

process.env.CRON_SECRET = 'test-cron-secret'
const { GET } = await import('./route.js')
const { sendDripChunk, sendBroadcast } = await import('@/lib/whatsapp')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')

const run = () => GET(new Request('http://localhost/api/cron/run-whatsapp-broadcasts', {
  headers: { authorization: 'Bearer test-cron-secret' },
}))

const bc = (id, location_id, over) => ({
  id, name: id, location_id, paused_at: null, updated_at: PAST,
  send_window_start: '00:00', send_window_end: '23:59', send_window_tz: 'Europe/Dublin', ...over,
})

const row = (id) => tables.whatsapp_broadcasts.find((r) => r.id === id)
const { sendPushToRolesAtLocation } = await import('@/lib/push')

function seed(rows) {
  tables = {
    locations: [{ id: A, features: { whatsapp: true } }, { id: B, features: { whatsapp: false } }],
    whatsapp_broadcasts: rows,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  failTable = null
})

describe('run-whatsapp-broadcasts never sends a stale scheduled blast (C127)', () => {
  it('a blast more than 3 hours late returns to draft, schedule cleared, nothing sent, managers told', async () => {
    seed([bc('late', A, { status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(3 * H + 60 * 1000) })])
    const body = await (await run()).json()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row('late')).toMatchObject({ status: 'draft', scheduled_at: null })
    expect(body.stats.returned_late).toBe(1)
    expect(body.stats.promoted).toBe(0)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [loc, roles, msg] = sendPushToRolesAtLocation.mock.calls[0]
    expect(loc).toBe(A)
    expect(roles).toEqual(expect.arrayContaining(['owner', 'manager']))
    expect(msg).toMatchObject({ title: 'Scheduled WhatsApp broadcast did not start', category: 'whatsapp' })
    expect(msg.body).toMatch(/more than 3 hours late/)
    expect(msg.data).toEqual({ type: 'broadcast_schedule_failed', broadcast_id: 'late' })
    expect(stampHeartbeat).toHaveBeenCalledWith('run-whatsapp-broadcasts')
  })

  it('the whole story: due while WhatsApp was off, switched back on 5 hours later, not sent', async () => {
    seed([bc('held', B, { status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(5 * H) })])
    await run()
    expect(row('held').status).toBe('scheduled') // C122: untouched while off
    tables.locations.find((l) => l.id === B).features = { whatsapp: true }
    await run()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row('held')).toMatchObject({ status: 'draft', scheduled_at: null })
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })

  it('a blast within 3 hours still goes out as before', async () => {
    seed([bc('ontime', A, { status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(2 * H) })])
    const body = await (await run()).json()
    expect(sendBroadcast).toHaveBeenCalledWith('ontime', expect.anything())
    expect(body.stats.returned_late).toBe(0)
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a late scheduled DRIP still starts (it paces itself inside its window)', async () => {
    seed([bc('latedrip', A, { status: 'scheduled', delivery_mode: 'drip', scheduled_at: ago(30 * H) })])
    await run()
    expect(row('latedrip').status).toBe('sending')
    expect(sendDripChunk).toHaveBeenCalledWith('latedrip')
  })

  it('a failed push is logged and never stops the tick', async () => {
    sendPushToRolesAtLocation.mockRejectedValueOnce(new Error('push down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seed([
      bc('late', A, { status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(4 * H) }),
      bc('drip-a', A, { status: 'sending', delivery_mode: 'drip', scheduled_at: null }),
    ])
    const res = await run()
    expect(res.status).toBe(200)
    expect(row('late').status).toBe('draft')
    expect(sendDripChunk).toHaveBeenCalledWith('drip-a')
  })
})
