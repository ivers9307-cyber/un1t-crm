// ORGCONTACTS.3 (spec §3.5) — pin: a status webhook (sent / delivered / read /
// failed) routes by the MESSAGE's stored studio. handleStatusUpdate updates
// whatsapp_messages by wa_message_id and the broadcast recipient by
// (broadcast_id, contact_id); it never reads the number's home, the links,
// the locations or the contacts, and never rewrites a location_id. A
// re-route here would move a message out of the thread it was sent from.
// Fictional ids only.
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
import { markUndeliverableIfPermanent } from '@/lib/whatsapp'

const PNI = '1230000000000001'
const OWNER = { source: 'db', id: 'wn-1', locationId: 'loc-still', homeLocationId: 'loc-still', organizationId: 'org-1', phoneNumberId: PNI, token: 'tok' }

// Records every table the handler touches and every update payload.
function makeDb({ message = { broadcast_id: 'bc-1', contact_id: 'c-1' }, prevRecipientStatus = 'sent' } = {}) {
  const tables = []
  const updates = []
  const from = (table) => {
    tables.push(table)
    const ops = []
    const finish = () => {
      const upd = ops.find(([m]) => m === 'update')
      if (upd) { updates.push({ table, payload: upd[1], ops }); return { data: null, error: null } }
      if (table === 'whatsapp_messages') return { data: message, error: null }
      if (table === 'whatsapp_broadcast_recipients') return { data: { status: prevRecipientStatus }, error: null }
      return { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish()
    b.maybeSingle = async () => finish()
    b.then = (res, rej) => Promise.resolve(finish()).then(res, rej)
    return b
  }
  const rpc = vi.fn(async () => ({ data: null, error: null }))
  return { from, rpc, tables, updates }
}

const statusEnvelope = (status, extra = {}) => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PNI },
  statuses: [{ id: 'wamid.out1', status, timestamp: '1770000000', ...extra }],
} }] }] })
const reqFor = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } })

let db
beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(OWNER)
})
afterEach(() => { vi.restoreAllMocks() })

const NEVER = ['whatsapp_numbers', 'location_whatsapp_numbers', 'locations', 'contacts', 'contact_studios', 'whatsapp_conversations']

describe('status webhooks route by the message’s stored studio (ORGCONTACTS.3, spec §3.5)', () => {
  it('a delivery status touches only the message row and its broadcast recipient; never reads the number, links, studios or contacts; never changes location_id', async () => {
    db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(reqFor(statusEnvelope('delivered')))
    expect(res.status).toBe(200)
    expect(new Set(db.tables)).toEqual(new Set(['whatsapp_messages', 'whatsapp_broadcast_recipients']))
    for (const t of NEVER) expect(db.tables).not.toContain(t)
    expect(db.updates.map((u) => u.table).sort()).toEqual(['whatsapp_broadcast_recipients', 'whatsapp_messages'])
    for (const u of db.updates) expect(u.payload).not.toHaveProperty('location_id')
    // The message is addressed by its wa_message_id; the recipient by (broadcast_id, contact_id).
    const msg = db.updates.find((u) => u.table === 'whatsapp_messages')
    expect(msg.ops).toContainEqual(['eq', 'wa_message_id', 'wamid.out1'])
    expect(msg.payload).toMatchObject({ status: 'delivered' })
    const recip = db.updates.find((u) => u.table === 'whatsapp_broadcast_recipients')
    expect(recip.ops).toContainEqual(['eq', 'broadcast_id', 'bc-1'])
    expect(recip.ops).toContainEqual(['eq', 'contact_id', 'c-1'])
    expect(db.rpc).toHaveBeenCalledWith('increment_whatsapp_broadcast_metric', { p_broadcast_id: 'bc-1', p_metric: 'total_delivered' })
  })

  it('a read status on a non-broadcast message touches the message row only', async () => {
    db = makeDb({ message: { broadcast_id: null, contact_id: 'c-1' } })
    createServerClient.mockReturnValue(db)
    await POST(reqFor(statusEnvelope('read')))
    expect(new Set(db.tables)).toEqual(new Set(['whatsapp_messages']))
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].payload).not.toHaveProperty('location_id')
    expect(db.rpc).not.toHaveBeenCalled()
  })

  it('a failed status flags the contact through markUndeliverableIfPermanent only (the one contact touch), still no location_id and no re-route', async () => {
    db = makeDb()
    createServerClient.mockReturnValue(db)
    await POST(reqFor(statusEnvelope('failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] })))
    expect(new Set(db.tables)).toEqual(new Set(['whatsapp_messages', 'whatsapp_broadcast_recipients']))
    expect(markUndeliverableIfPermanent).toHaveBeenCalledWith(db, 'c-1', { code: 131026, message: 'Message undeliverable' })
    for (const u of db.updates) expect(u.payload).not.toHaveProperty('location_id')
    expect(resolveWhatsAppNumberByPhoneNumberId).toHaveBeenCalledTimes(1) // the envelope's owner check, nothing per status
  })
})
