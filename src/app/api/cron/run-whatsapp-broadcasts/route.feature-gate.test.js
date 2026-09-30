// C122 WABROADCASTKILL.1 — switching WhatsApp off at a studio must stop its
// broadcasts in the cron. On main all three arms (scheduled promotion, blast
// resume, in-flight drips) ignored the location's `whatsapp` feature, so a
// running drip kept sending and nobody could open the page to pause it.
// Now: rows at a studio where the feature is off are SKIPPED (not sent, not
// flipped, not marked), so they resume when it is switched back on; a
// `locations` read that fails sends nothing (fail closed). Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const A = 'a0000000-0000-4000-8000-00000000000a' // WhatsApp on
const B = 'b0000000-0000-4000-8000-00000000000b' // WhatsApp off
const PAST = '2026-01-01T09:00:00.000Z'

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

function seed(features = { [A]: { whatsapp: true }, [B]: { whatsapp: false } }) {
  tables = {
    locations: Object.entries(features).map(([id, f]) => ({ id, features: f })),
    whatsapp_broadcasts: [
      bc('sched-a', A, { status: 'scheduled', delivery_mode: 'drip', scheduled_at: PAST }),
      bc('sched-b', B, { status: 'scheduled', delivery_mode: 'drip', scheduled_at: PAST }),
      bc('resume-a', A, { status: 'sending', delivery_mode: 'blast', scheduled_at: PAST }),
      bc('resume-b', B, { status: 'sending', delivery_mode: 'blast', scheduled_at: PAST }),
      bc('drip-a', A, { status: 'sending', delivery_mode: 'drip', scheduled_at: null }),
      bc('drip-b', B, { status: 'sending', delivery_mode: 'drip', scheduled_at: null }),
    ],
  }
}
const row = (id) => tables.whatsapp_broadcasts.find((r) => r.id === id)
const sentIds = () => [
  ...sendDripChunk.mock.calls.map((c) => c[0]),
  ...sendBroadcast.mock.calls.map((c) => c[0]),
]

beforeEach(() => {
  vi.clearAllMocks()
  failTable = null
})

describe('run-whatsapp-broadcasts honours the studio WhatsApp feature (C122)', () => {
  it('sends at the studio with WhatsApp on and skips every arm at the studio with it off', async () => {
    seed()
    const res = await run()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(sentIds().sort()).toEqual(['drip-a', 'resume-a', 'sched-a'])
    // main: sched-b flipped to 'sending' and all three -b rows were sent.
    expect(row('sched-b').status).toBe('scheduled')
    expect(row('resume-b').status).toBe('sending')
    expect(row('drip-b').status).toBe('sending')
    expect(row('drip-b').updated_at).toBe(PAST)
    expect(body.stats.skipped_whatsapp_off).toBe(3)
    expect(stampHeartbeat).toHaveBeenCalledWith('run-whatsapp-broadcasts')
  })

  it('both owning bundles off is WhatsApp off', async () => {
    seed({ [A]: { whatsapp: true }, [B]: { bundle_messaging: false, bundle_marketing: false } })
    await run()
    expect(sentIds()).not.toContain('drip-b')
    expect(row('sched-b').status).toBe('scheduled')
  })

  it('switched back on, the skipped rows run on the next tick (resumable)', async () => {
    seed()
    await run()
    tables.locations.find((l) => l.id === B).features = { whatsapp: true }
    vi.clearAllMocks()
    const body = await (await run()).json()
    expect(sentIds()).toEqual(expect.arrayContaining(['sched-b', 'resume-b', 'drip-b']))
    expect(body.stats.skipped_whatsapp_off).toBe(0)
  })

  it('a skipped studio does not take the slots: every studio off but one still sends', async () => {
    seed()
    // More off-studio drips than the drip arm's per-tick limit (20).
    for (let i = 0; i < 25; i++) {
      tables.whatsapp_broadcasts.unshift(bc(`drip-b-${i}`, B, { status: 'sending', delivery_mode: 'drip', scheduled_at: null }))
    }
    await run()
    expect(sentIds()).toContain('drip-a')
  })

  it('an unreadable feature flag sends nothing (fail closed) and does not stamp the heartbeat', async () => {
    seed()
    failTable = 'locations'
    const res = await run()
    expect(res.status).toBe(500)
    expect(sentIds()).toEqual([])
    expect(row('sched-a').status).toBe('scheduled')
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a broadcast with no studio, or at a studio missing from the read, is not sent', async () => {
    seed({ [A]: { whatsapp: true } })
    tables.whatsapp_broadcasts.push(bc('drip-none', null, { status: 'sending', delivery_mode: 'drip', scheduled_at: null }))
    const body = await (await run()).json()
    expect(sentIds()).not.toContain('drip-b')
    expect(sentIds()).not.toContain('drip-none')
    expect(body.stats.skipped_whatsapp_off).toBe(4)
  })

  it('WhatsApp off everywhere: nothing is sent and every due row is counted', async () => {
    seed({ [A]: { whatsapp: false }, [B]: { whatsapp: false } })
    const body = await (await run()).json()
    expect(sentIds()).toEqual([])
    expect(body.stats.skipped_whatsapp_off).toBe(6)
  })
})
