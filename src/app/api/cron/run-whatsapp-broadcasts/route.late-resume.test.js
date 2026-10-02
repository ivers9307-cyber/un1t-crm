// C139 LATERESUME.1 (Richard's C127 decision: never send stale) — the resume
// arm finishes a scheduled blast bigger than one tick's cap. If its last send
// is more than 3 hours old when the arm reaches it (WhatsApp switched off at
// the studio mid-send, so C122 held it; or a cron outage), the rest is NOT sent
// late: the row is parked at draft with paused_at set and its schedule cleared
// (the breaker's parked state: Send delivers only the remainder), and the
// studio's managers are pushed through scheduledStartFailureNotification. The
// last send is the newest recipient claim (inserted right before each send);
// updated_at is no clock for it (delivery and read webhooks bump it). With no
// recipient row yet, scheduled_at stands in. A failed read sends nothing that
// tick. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const A = 'a0000000-0000-4000-8000-00000000000a'
const H = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

let tables
let failRecipients
function makeDb() {
  return {
    from(table) {
      let rows = (tables[table] || []).slice()
      let head = false
      let patch = null
      const b = {}
      const chain = (fn) => (...args) => { fn(...args); return b }
      b.select = chain((_c, opts) => { if (opts?.head) head = true })
      b.order = chain((c, opts) => {
        const dir = opts?.ascending === false ? -1 : 1
        rows = rows.slice().sort((x, y) => (x[c] < y[c] ? -dir : x[c] > y[c] ? dir : 0))
      })
      b.limit = chain((n) => { rows = rows.slice(0, n) })
      b.eq = chain((c, v) => { rows = rows.filter((r) => r[c] === v) })
      b.lte = chain((c, v) => { rows = rows.filter((r) => r[c] != null && r[c] <= v) })
      b.is = chain((c, v) => { rows = rows.filter((r) => (r[c] ?? null) === v) })
      b.in = chain((c, vals) => { rows = rows.filter((r) => vals.includes(r[c])) })
      b.not = chain((c, op, v) => { if (op === 'is' && v === null) rows = rows.filter((r) => r[c] != null) })
      b.or = chain(() => { rows = [] })
      b.update = chain((p) => { patch = p })
      b.then = (resolve, reject) => {
        let out
        if (table === 'whatsapp_broadcast_recipients' && failRecipients) out = { data: null, error: { message: 'boom', code: 'XX000' } }
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
  sendDripChunk: vi.fn(async () => ({ sent: 0, failed: 0, status: 'sending' })),
  sendBroadcast: vi.fn(async () => ({ sent: 500, failed: 0, status: 'sending' })),
}))
vi.mock('@/lib/whatsapp-drip', () => ({ isWithinSendWindow: () => true }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

process.env.CRON_SECRET = 'test-cron-secret'
const { GET } = await import('./route.js')
const { sendBroadcast } = await import('@/lib/whatsapp')
const { sendPushToRolesAtLocation } = await import('@/lib/push')

const run = () => GET(new Request('http://localhost/api/cron/run-whatsapp-broadcasts', {
  headers: { authorization: 'Bearer test-cron-secret' },
}))
const blast = (over = {}) => ({
  id: 'b1', name: 'Spring', location_id: A, status: 'sending', delivery_mode: 'blast',
  scheduled_at: ago(10 * H), paused_at: null, updated_at: ago(60 * 1000), ...over,
})
const claims = (...ages) => ages.map((ms, i) => ({ id: `r${i}`, broadcast_id: 'b1', created_at: ago(ms) }))
const row = () => tables.whatsapp_broadcasts[0]

function seed(bc, recipients) {
  tables = { locations: [{ id: A, features: { whatsapp: true } }], whatsapp_broadcasts: [bc], whatsapp_broadcast_recipients: recipients }
}

beforeEach(() => {
  vi.clearAllMocks()
  failRecipients = false
})

describe('run-whatsapp-broadcasts never resumes a stale part-sent blast (C139)', () => {
  it('last send more than 3 h ago: parked at draft, paused, schedule cleared, nothing sent, managers told', async () => {
    // updated_at is recent (a read receipt): it must not count as a send.
    seed(blast(), claims(5 * H, 4 * H))
    const body = await (await run()).json()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row()).toMatchObject({ status: 'draft', scheduled_at: null })
    expect(row().paused_at).toBeTruthy()
    expect(body.stats.paused_late).toBe(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [loc, roles, msg] = sendPushToRolesAtLocation.mock.calls[0]
    expect(loc).toBe(A)
    expect(roles).toEqual(expect.arrayContaining(['owner', 'manager']))
    expect(msg).toMatchObject({ title: 'Scheduled WhatsApp broadcast paused part-way', category: 'whatsapp' })
    expect(msg.body).toMatch(/more than 3 hours ago/)
    expect(msg.data).toEqual({ type: 'broadcast_schedule_failed', broadcast_id: 'b1' })
  })

  it('last send 15 minutes ago (the previous tick): resumed as before', async () => {
    seed(blast(), claims(5 * H, 15 * 60 * 1000))
    const body = await (await run()).json()
    expect(sendBroadcast).toHaveBeenCalledWith('b1', expect.objectContaining({ maxRecipients: expect.any(Number) }))
    expect(row().status).toBe('sending')
    expect(body.stats.paused_late).toBe(0)
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('no recipient row yet: scheduled_at stands in for the last send', async () => {
    seed(blast({ scheduled_at: ago(4 * H) }), [])
    await run()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row().status).toBe('draft')
    seed(blast({ scheduled_at: ago(30 * 60 * 1000) }), [])
    await run()
    expect(sendBroadcast).toHaveBeenCalledTimes(1)
  })

  it('a failed recipients read sends nothing this tick and parks nothing', async () => {
    seed(blast(), claims(15 * 60 * 1000))
    failRecipients = true
    const body = await (await run()).json()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row().status).toBe('sending')
    expect(body.stats.errors.map((e) => e.broadcast_id)).toContain('b1')
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('the whole story: WhatsApp switched off mid-send, back on 5 hours later, the rest is not sent', async () => {
    seed(blast({ scheduled_at: ago(6 * H) }), claims(5 * H))
    tables.locations[0].features = { whatsapp: false }
    await run()
    expect(row().status).toBe('sending') // C122: held untouched while off
    tables.locations[0].features = { whatsapp: true }
    await run()
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(row().status).toBe('draft')
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
  })
})
