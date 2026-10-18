// WAORGNUMBER.4 (spec R7) — a scheduled blast at a studio inside its blast
// sign-off window, scheduled before anyone signed it off: sendBroadcast
// refuses it with BlastSignoffRequiredError before any status flip, so the
// cron's refused-start path keeps it a draft and pushes the studio's
// managers with the sign-off copy. Harness copied from route.drip-start.test.js.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BlastSignoffRequiredError } from '@/lib/whatsapp-blast-signoff'

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
const blast = (over = {}) => ({
  id: 'b1', name: 'Hatch launch', location_id: A, status: 'scheduled', delivery_mode: 'blast',
  scheduled_at: ago(5 * 60 * 1000), paused_at: null, updated_at: '2026-01-01T00:00:00.000Z', ...over,
})
const row = () => tables.whatsapp_broadcasts[0]
const COPY = 'Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2026.'

beforeEach(() => {
  vi.clearAllMocks()
  tables = { locations: [{ id: A, features: { whatsapp: true } }], whatsapp_broadcasts: [blast()] }
})

describe('run-whatsapp-broadcasts and blast sign-off (WAORGNUMBER.4)', () => {
  it('cron leaves an unsigned scheduled blast draft and pushes managers', async () => {
    sendBroadcast.mockRejectedValue(new BlastSignoffRequiredError(COPY))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = await (await run()).json()
    expect(row().status).toBe('draft')
    expect(body.stats.refused).toBe(1)
    expect(sendPushToRolesAtLocation).toHaveBeenCalledTimes(1)
    const [loc, roles, msg] = sendPushToRolesAtLocation.mock.calls[0]
    expect(loc).toBe(A)
    expect(roles).toEqual(expect.arrayContaining(['owner', 'manager']))
    expect(msg.body).toContain(COPY)
    expect(msg.data).toEqual({ type: 'broadcast_schedule_failed', broadcast_id: 'b1' })
  })

  // The engine's own sign-off check is covered in whatsapp-blast-signoff-engine.test.js;
  // this pins only that the cron does not push or refuse when the start succeeds.
  it('a scheduled blast the engine accepts is sent as usual, no push', async () => {
    sendBroadcast.mockResolvedValue({ status: 'sent', sent: 4, failed: 0 })
    const body = await (await run()).json()
    expect(body.stats).toMatchObject({ promoted: 1, sent: 4, refused: 0 })
    expect(sendPushToRolesAtLocation).not.toHaveBeenCalled()
  })
})
