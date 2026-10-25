// C138 (b) — the cron started a SCHEDULED DRIP by flipping it straight to
// 'sending': none of the start checks a blast gets (template approved, URL
// value, own number, number quality, wallet), and no manager push when a start
// cannot go ahead. Now a due drip is flipped to 'draft' (CAS) and started
// through sendBroadcast, which since GATES-3 (e) runs those checks for a drip
// and CAS-flips draft→sending without sending. A refusal leaves a draft and
// the studio's managers get the same push as a refused blast; a started drip
// sends its first chunk this tick when its window is open. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const A = 'a0000000-0000-4000-8000-00000000000a'
const ago = (ms) => new Date(Date.now() - ms).toISOString()

let tables
function makeDb() {
  return {
    from(table) {
      let rows = (tables[table] || []).slice()
      let head = false
      let patch = null
      const b = {}
      const chain = (fn) => (...args) => { fn(...args); return b }
      b.select = chain((_c, opts) => { if (opts?.head) head = true })
      b.order = chain(() => {})
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
        if (patch) {
          for (const r of rows) Object.assign(r, patch)
          out = { data: rows.map((r) => ({ id: r.id })), error: null }
        } else out = head ? { data: null, error: null, count: rows.length } : { data: rows, error: null }
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}

let inWindow = true
vi.mock('@/lib/supabase', () => ({ createServerClient: () => makeDb() }))
vi.mock('@/lib/whatsapp', () => ({ sendDripChunk: vi.fn(), sendBroadcast: vi.fn() }))
vi.mock('@/lib/whatsapp-drip', () => ({ isWithinSendWindow: () => inWindow }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))

process.env.CRON_SECRET = 'test-cron-secret'
const { GET } = await import('./route.js')
const { sendDripChunk, sendBroadcast } = await import('@/lib/whatsapp')
const { sendPushToRolesAtLocation } = await import('@/lib/push')

const run = () => GET(new Request('http://localhost/api/cron/run-whatsapp-broadcasts', {
  headers: { authorization: 'Bearer test-cron-secret' },
}))
const drip = (over = {}) => ({
  id: 'd1', name: 'Autumn drip', location_id: A, status: 'scheduled', delivery_mode: 'drip',
  scheduled_at: ago(10 * 60 * 1000), paused_at: null, updated_at: '2026-01-01T00:00:00.000Z',
  send_window_start: '09:00', send_window_end: '18:00', send_window_tz: 'Europe/Dublin', ...over,
})
const row = () => tables.whatsapp_broadcasts[0]

// sendBroadcast's drip start, as GATES-3 (e) wrote it: CAS draft→sending, send nothing.
const startsTheDrip = async (id) => {
  const r = tables.whatsapp_broadcasts.find((x) => x.id === id)
  if (r.status === 'draft') r.status = 'sending'
  return { status: 'sending', mode: 'drip', sent: 0, failed: 0, total: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  inWindow = true
  tables = { locations: [{ id: A, features: { whatsapp: true } }], whatsapp_broadcasts: [drip()] }
  sendBroadcast.mockImplementation(startsTheDrip)
  sendDripChunk.mockResolvedValue({ sent: 3, failed: 0, status: 'sending' })
})

describe('run-whatsapp-broadcasts starts a scheduled drip through the start checks (C138 b)', () => {
  it('flips to draft, starts through sendBroadcast, then sends the first chunk in window', async () => {
    const statuses = []
    sendBroadcast.mockImplementation(async (id) => { statuses.push(row().status); return startsTheDrip(id) })
    const body = await (await run()).json()
    expect(statuses).toEqual(['draft']) // the start sees a draft: its checks run before any send
    expect(sendBroadcast).toHaveBeenCalledWith('d1')
    expect(row().status).toBe('sending')
    expect(sendDripChunk).toHaveBeenCalledWith('d1')
    expect(body.stats).toMatchObject({ promoted: 1, sent: 3, refused: 0 })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a refused start (e.g. a flagged number, an empty wallet) stays a draft and the managers are told', async () => {
    sendBroadcast.mockRejectedValue(new Error('This location\'s WhatsApp number quality is RED'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = await (await run()).json()
    expect(row().status).toBe('draft')
    expect(sendDripChunk).not.toHaveBeenCalled()
    expect(body.stats.refused).toBe(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [loc, roles, msg] = sendPushToRolesAtLocation.mock.calls[0]
    expect(loc).toBe(A)
    expect(roles).toEqual(expect.arrayContaining(['owner', 'manager']))
    expect(msg).toMatchObject({ title: 'Scheduled WhatsApp broadcast did not start', category: 'whatsapp' })
    expect(msg.body).toMatch(/quality is RED/)
    expect(msg.data).toEqual({ type: 'broadcast_schedule_failed', broadcast_id: 'd1' })
  })

  it('outside its window: started, no chunk this tick', async () => {
    inWindow = false
    const body = await (await run()).json()
    expect(row().status).toBe('sending')
    expect(sendDripChunk).not.toHaveBeenCalled()
    expect(body.stats.outside_window).toBe(1)
  })

  it('a start that lost the race (someone else started it) sends no chunk here', async () => {
    sendBroadcast.mockResolvedValue({ sent: 0, failed: 0, total: 0, skipped: 'already-sending' })
    await run()
    expect(sendDripChunk).not.toHaveBeenCalled()
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })

  it('a chunk that throws after a good start: no push (the drip arm retries next tick)', async () => {
    sendDripChunk.mockRejectedValue(new Error('meta down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run()
    expect(row().status).toBe('sending')
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })
})
