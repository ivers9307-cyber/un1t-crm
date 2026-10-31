// WABLASTCOUNTERS.1 — the status webhook and whatsapp_broadcasts.total_sent /
// total_failed.
//
// On 2026-10-31 a 342-recipient blast read total_sent = -1, -10, -24, -31
// while it was still sending. Meta had ACCEPTED those sends (a message id came
// back, the recipient row went 'sent') and then refused them a second or two
// later by status webhook with 131042 "Business eligibility payment issue".
// This handler answered each one with `increment_whatsapp_broadcast_metric
// (total_failed, +1)` and `(total_sent, -1)` — deltas against a counter the
// blast pass writes only at its END, from row counts. So every async failure
// during the pass drove a zero downwards, and the pass's final write then
// replaced whatever the deltas had made of it.
//
// The rule now: total_sent and total_failed are COUNTS of the recipient rows,
// wherever they are written. On a genuine transition to 'failed' the webhook
// recounts the two from whatsapp_broadcast_recipients and writes them, never a
// delta. total_delivered / total_read keep their per-transition bump (nothing
// else writes them). Fictional ids only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  refreshWindow: vi.fn(),
  parseConsentKeyword: vi.fn(() => null),
  pickInboundContact: vi.fn(() => null),
  markUndeliverableIfPermanent: vi.fn(async () => ({ flagged: false })),
}))
vi.mock('@/lib/whatsapp-consent', () => ({ applyWhatsappConsentKeyword: vi.fn(), applyMetaUserPreference: vi.fn() }))
vi.mock('@/lib/whatsapp-flow/completion.js', () => ({ handleFlowCompletion: vi.fn() }))
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
}))
vi.mock('@/lib/webhook-auth', () => ({ verifyMetaSignature: vi.fn(() => ({ ok: true })), safeEqual: vi.fn(() => true) }))
vi.mock('@/lib/push', () => ({ sendPush: vi.fn(), sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/schemas', () => ({ MANAGER_ROLES: ['owner', 'manager', 'head_coach'] }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { WHATSAPP: 'whatsapp' },
}))
vi.mock('@/lib/agent/auto-reply', () => ({ maybeAutoReply: vi.fn(async () => ({ handled: false })) }))
vi.mock('@/lib/agent/welcome-greeting', () => ({ maybeSendWelcomeGreeting: vi.fn() }))
vi.mock('@/lib/whatsapp-template-events', () => ({ applyTemplateEvent: vi.fn(async () => ({ template: null, notify: null })) }))
vi.mock('@/lib/whatsapp-number-events', () => ({ NUMBER_EVENT_FIELDS: new Set(), applyNumberEvent: vi.fn() }))
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn() }))
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn(), extractInboundBsuid: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-coexistence', () => ({
  parseEchoMessages: vi.fn(() => []),
  parseSyncContacts: vi.fn(() => []),
  parseHistoryMessages: vi.fn(() => []),
  nextHistorySyncState: vi.fn(),
}))
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { resolveWhatsAppNumberByPhoneNumberId } from '@/lib/whatsapp-config'

const PNI = '1230000000000001'
const OWNER = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', organizationId: 'org-1', phoneNumberId: PNI, token: 'tok' }

// The recipient rows of broadcast bc-1 AFTER this status lands: what a recount
// must read. `prev` is the row's status before it.
function makeDb({ prev = 'sent', rows = { dispatched: 288, failed: 53 }, countsFail = false } = {}) {
  const updates = []
  const rpc = vi.fn(async () => ({ data: null, error: null }))
  const from = (table) => {
    const ops = []
    const finish = () => {
      const upd = ops.find(([m]) => m === 'update')
      if (upd) { updates.push({ table, payload: upd[1], ops }); return { data: null, error: null } }
      if (table === 'whatsapp_messages') return { data: { broadcast_id: 'bc-1', contact_id: 'c-1' }, error: null }
      if (table === 'whatsapp_broadcast_recipients') {
        const sel = ops.find(([m]) => m === 'select')
        if (sel?.[2]?.head) {
          if (countsFail) return { count: null, error: { code: '57014', message: 'statement timeout' } }
          const inStatus = ops.find(([m]) => m === 'in')
          const eqStatus = ops.find(([m, col]) => m === 'eq' && col === 'status')
          if (inStatus) return { count: rows.dispatched, error: null }
          if (eqStatus?.[2] === 'failed') return { count: rows.failed, error: null }
          return { count: 0, error: null }
        }
        return { data: { status: prev }, error: null }
      }
      return { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish()
    b.maybeSingle = async () => finish()
    b.then = (res, rej) => Promise.resolve(finish()).then(res, rej)
    return b
  }
  return { from, rpc, updates }
}

const statusEnvelope = (status, extra = {}) => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PNI },
  statuses: [{ id: 'wamid.out1', status, timestamp: '1770000000', ...extra }],
} }] }] })
const reqFor = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } })
const FAILED_131042 = { errors: [{ code: 131042, title: 'Business eligibility payment issue' }] }

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(OWNER)
})
afterEach(() => { vi.restoreAllMocks() })

const counterWrites = () => db.updates.filter((u) => u.table === 'whatsapp_broadcasts')

describe('status webhook — an accepted send that Meta then refuses (131042) is recounted, never decremented', () => {
  it('sent → failed: no delta RPC on total_sent or total_failed; both are rewritten from the recipient rows', async () => {
    db = makeDb({ prev: 'sent' })
    createServerClient.mockReturnValue(db)

    const res = await POST(reqFor(statusEnvelope('failed', FAILED_131042)))
    expect(res.status).toBe(200)

    // The recipient row is failed first, then the counts are read.
    const recip = db.updates.find((u) => u.table === 'whatsapp_broadcast_recipients')
    expect(recip.payload).toMatchObject({ status: 'failed', error_message: 'Business eligibility payment issue' })

    // Before: rpc(total_failed, +1) and rpc(total_sent, -1) — the -1 is what
    // read -31 on a broadcast whose pass had not written total_sent yet.
    const deltas = db.rpc.mock.calls.filter(([fn]) => fn === 'increment_whatsapp_broadcast_metric')
    expect(deltas.map(([, args]) => args.p_metric)).not.toContain('total_sent')
    expect(deltas.map(([, args]) => args.p_metric)).not.toContain('total_failed')
    expect(deltas.some(([, args]) => (args.p_delta ?? 1) < 0)).toBe(false)

    expect(counterWrites()).toHaveLength(1)
    expect(counterWrites()[0].payload).toEqual({ total_sent: 288, total_failed: 53 })
    expect(counterWrites()[0].ops).toContainEqual(['eq', 'id', 'bc-1'])
  })

  it('a redelivered failed status (row already failed) writes nothing to the counters', async () => {
    db = makeDb({ prev: 'failed' })
    createServerClient.mockReturnValue(db)
    await POST(reqFor(statusEnvelope('failed', FAILED_131042)))
    expect(counterWrites()).toEqual([])
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('delivered and read keep their per-transition bump (nothing else writes those two)', async () => {
    db = makeDb({ prev: 'sent' })
    createServerClient.mockReturnValue(db)
    await POST(reqFor(statusEnvelope('delivered')))
    expect(db.rpc).toHaveBeenCalledWith('increment_whatsapp_broadcast_metric', { p_broadcast_id: 'bc-1', p_metric: 'total_delivered' })
    expect(counterWrites()).toEqual([])
  })

  it('an unreadable recount is logged and the stored counters are left as they were (never written as zero)', async () => {
    db = makeDb({ prev: 'sent', countsFail: true })
    createServerClient.mockReturnValue(db)
    const res = await POST(reqFor(statusEnvelope('failed', FAILED_131042)))
    expect(res.status).toBe(200)
    expect(counterWrites()).toEqual([])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('recount'), expect.anything())
  })
})
