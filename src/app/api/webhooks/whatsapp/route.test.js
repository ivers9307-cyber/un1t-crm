// SAAS-2 — inbound tenant-routing contract for the WhatsApp webhook.
//
// Every 'messages' change (inbound messages AND status updates) must
// resolve its metadata phone_number_id to an active whatsapp_numbers row
// before ANY write: unroutable traffic (unknown id, missing id, env-only
// match, resolver failure) is DROPPED with a structured console.error and
// the webhook still 200s (Meta auto-disables hooks on non-2xx). The
// pre-SAAS-2 first-location fallback routed foreign traffic — and the
// contact + Mia reply it spawned — into an arbitrary tenant.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  refreshWindow: vi.fn(),
  parseConsentKeyword: vi.fn(() => null),
  pickInboundContact: vi.fn(() => null),
  markUndeliverableIfPermanent: vi.fn(),
}))
vi.mock('@/lib/whatsapp-consent', () => ({ applyWhatsappConsentKeyword: vi.fn(), applyMetaUserPreference: vi.fn() }))
vi.mock('@/lib/whatsapp-flow/completion.js', () => ({ handleFlowCompletion: vi.fn() }))
// Keep the REAL classifyInboundOwner — the route + classifier pair is the
// contract under test. Only the DB lookup is mocked.
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
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn() }))
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
import { maybeAutoReply } from '@/lib/agent/auto-reply'
import { ingestCoexistenceMessage, syncContactMatchOnly } from '@/lib/whatsapp-coexistence-ingest'

// Recording fake supabase client: chainable builder, thenable (matches
// supabase-js), with per-table response handlers. Every terminal call is
// recorded so tests can assert "zero writes" for dropped traffic.
function makeDb(handlers = {}) {
  const calls = []
  const from = vi.fn((table) => {
    const ops = []
    const finish = (terminal) => {
      calls.push({ table, ops, terminal })
      const h = handlers[table]
      return (typeof h === 'function' ? h(ops, terminal) : h) || { data: null, error: null }
    }
    const b = {}
    for (const m of ['select', 'eq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (...args) => { ops.push([m, ...args]); return b }
    }
    b.single = async () => finish('single')
    b.maybeSingle = async () => finish('maybeSingle')
    b.then = (onFulfilled, onRejected) => Promise.resolve(finish('await')).then(onFulfilled, onRejected)
    return b
  })
  const db = { from, rpc: vi.fn(async () => ({ data: null, error: null })), calls }
  db.writes = () => calls.filter((c) => c.ops.some(([m]) => ['insert', 'update', 'upsert', 'delete'].includes(m)))
  return db
}

const REGISTERED_PNI = '1233588839827698'
// The resolver's config shape for an active whatsapp_numbers row.
const STILLORGAN = { source: 'db', id: 'wn-1', locationId: 'loc-still', phoneNumberId: REGISTERED_PNI, token: 'tok' }

function reqFor(body) {
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

function envelope(value, field = 'messages') {
  return { entry: [{ changes: [{ field, value }] }] }
}

function inboundText(pniOrNull) {
  return envelope({
    metadata: pniOrNull ? { phone_number_id: pniOrNull } : {},
    contacts: [{ wa_id: '353871234567', profile: { name: 'Test Sender' } }],
    messages: [{ id: 'wamid.test1', from: '353871234567', timestamp: '1770000000', type: 'text', text: { body: 'hi' } }],
  })
}

function statusUpdate(pniOrNull) {
  return envelope({
    metadata: pniOrNull ? { phone_number_id: pniOrNull } : {},
    statuses: [{ id: 'wamid.out1', status: 'delivered', timestamp: '1770000000' }],
  })
}

let errSpy
let db

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = makeDb({
    contacts: { data: [], error: null },
    whatsapp_conversations: (ops, terminal) => {
      if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
      if (terminal === 'single') return { data: null, error: null }
      return { data: null, error: null }
    },
    whatsapp_messages: (ops) => {
      if (ops.some(([m]) => m === 'insert')) return { data: { id: 'msg-row-1' }, error: null }
      return { data: null, error: null }
    },
  })
  createServerClient.mockReturnValue(db)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/webhooks/whatsapp — inbound message routing', () => {
  it('routes a message for a registered number to the owning location (unchanged live path)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)

    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)

    const convInsert = db.calls.find((c) => c.table === 'whatsapp_conversations' && c.ops.some(([m]) => m === 'insert'))
    expect(convInsert).toBeTruthy()
    expect(convInsert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still' })

    const msgInsert = db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))
    expect(msgInsert).toBeTruthy()
    expect(msgInsert.ops.find(([m]) => m === 'insert')[1]).toMatchObject({ location_id: 'loc-still', direction: 'inbound' })

    expect(maybeAutoReply).toHaveBeenCalled()
  })

  it('drops a message for an unknown phone_number_id: 200, structured log, zero writes, no agent', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(null)

    const res = await POST(reqFor(inboundText('9999_UNKNOWN')))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    expect(db.writes()).toEqual([])
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('9999_UNKNOWN'))
  })

  it('drops a message with NO phone_number_id in metadata (no first-location fallback)', async () => {
    const res = await POST(reqFor(inboundText(null)))
    expect(res.status).toBe(200)

    expect(resolveWhatsAppNumberByPhoneNumberId).not.toHaveBeenCalled()
    expect(db.writes()).toEqual([])
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('(missing)'))
  })

  it('drops the message when the resolver fails (no first-location fallback), still 200', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockRejectedValue(new Error('whatsapp_numbers lookup failed: boom'))

    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)

    expect(db.writes()).toEqual([])
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(REGISTERED_PNI))
  })

  it('drops an env-only match — an env config carries no tenant to route into', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue({ source: 'env', phoneNumberId: 'env-pni', token: 't' })

    const res = await POST(reqFor(inboundText('env-pni')))
    expect(res.status).toBe(200)

    expect(db.writes()).toEqual([])
    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('env-pni'))
  })
})

// MIA-REVIEW.2 — the inbound-message insert is the agent's only source of
// truth for what it is answering. Both a duplicate delivery and a rejected
// insert must stop the turn (the webhook still 200s either way).
describe('POST /api/webhooks/whatsapp — inbound persistence guards', () => {
  it('skips a wamid already stored inbound (second dedup layer behind webhook_events)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const dupDb = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops, terminal) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
        if (terminal === 'single') return { data: null, error: null }
        return { data: null, error: null }
      },
      // The pre-insert lookup finds the message from Meta's first delivery.
      whatsapp_messages: (ops) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'msg-row-1' }, error: null }
        return { data: { id: 'msg-row-1' }, error: null }
      },
    })
    createServerClient.mockReturnValue(dupDb)

    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)

    expect(dupDb.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'insert'))).toBeFalsy()
    expect(maybeAutoReply).not.toHaveBeenCalled()
  })

  it('does not run the agent when the inbound insert failed (no answering history it cannot see)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)
    const failDb = makeDb({
      contacts: { data: [], error: null },
      whatsapp_conversations: (ops, terminal) => {
        if (ops.some(([m]) => m === 'insert')) return { data: { id: 'conv-1' }, error: null }
        if (terminal === 'single') return { data: null, error: null }
        return { data: null, error: null }
      },
      whatsapp_messages: (ops) => {
        if (ops.some(([m]) => m === 'insert')) return { data: null, error: { message: 'violates check constraint' } }
        return { data: null, error: null }
      },
    })
    createServerClient.mockReturnValue(failDb)

    const res = await POST(reqFor(inboundText(REGISTERED_PNI)))
    expect(res.status).toBe(200)

    expect(maybeAutoReply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('inbound message insert failed'),
      expect.anything(), expect.anything(),
    )
  })
})

describe('POST /api/webhooks/whatsapp — status updates', () => {
  it('still applies a status update for a registered number (unchanged live path)', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(STILLORGAN)

    const res = await POST(reqFor(statusUpdate(REGISTERED_PNI)))
    expect(res.status).toBe(200)

    const msgUpdate = db.calls.find((c) => c.table === 'whatsapp_messages' && c.ops.some(([m]) => m === 'update'))
    expect(msgUpdate).toBeTruthy()
    expect(msgUpdate.ops.find(([m]) => m === 'update')[1]).toMatchObject({ status: 'delivered' })
  })

  it('ignores + logs a status update for an unknown phone_number_id, still 200', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(null)

    const res = await POST(reqFor(statusUpdate('9999_UNKNOWN')))
    expect(res.status).toBe(200)

    expect(db.writes()).toEqual([])
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('9999_UNKNOWN'))
  })
})

describe('POST /api/webhooks/whatsapp — coexistence events', () => {
  it('drops a coexistence event for an unknown phone_number_id', async () => {
    resolveWhatsAppNumberByPhoneNumberId.mockResolvedValue(null)

    const res = await POST(reqFor(envelope({ metadata: { phone_number_id: '9999_UNKNOWN' } }, 'smb_message_echoes')))
    expect(res.status).toBe(200)

    expect(db.writes()).toEqual([])
    expect(ingestCoexistenceMessage).not.toHaveBeenCalled()
    expect(syncContactMatchOnly).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('9999_UNKNOWN'))
  })
})
