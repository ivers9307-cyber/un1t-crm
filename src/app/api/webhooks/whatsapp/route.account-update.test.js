// WA-COEX.7 — `account_update` reaches BOTH handlers.
//
// `account_update` is a SHARED webhook field: Meta rides account bans /
// restrictions / verification on it (the WA-HEALTH number-event path,
// applyNumberEvent → manager push) AND the coexistence link lifecycle
// ACCOUNT_OFFBOARDED / ACCOUNT_RECONNECTED (the WA-COEX.6 path,
// handleAccountUpdateEvent → signup_meta.coex_link + manager push).
//
// From WA-COEX.6 (2026-07-31) to WA-COEX.7 the coexistence branch was
// UNREACHABLE: the change loop tested `NUMBER_EVENT_FIELDS.has(field)` first,
// that set includes 'account_update', and the branch `continue`d — so the
// later `if (change.field === 'account_update')` never ran from a real
// webhook. route.test.js and route.reply-number.test.js missed it because
// they mock `@/lib/whatsapp-number-events` to an EMPTY set, which made the
// dead branch look live. This file therefore uses the REAL set
// (vi.importActual) and the real coexistence helpers, and asserts on the
// coexistence handler's observable effects through the recording fake —
// it is module-private, so there is nothing to spy on.
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
vi.mock('@/lib/whatsapp-config', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveWhatsAppNumberByPhoneNumberId: vi.fn(),
  getLocationWhatsAppNumberConfig: vi.fn(async () => null),
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
// The REAL NUMBER_EVENT_FIELDS — the whole point of this file. applyNumberEvent
// is the real implementation wrapped in a spy so one test can make it throw.
vi.mock('@/lib/whatsapp-number-events', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyNumberEvent: vi.fn(actual.applyNumberEvent) }
})
vi.mock('@/lib/whatsapp-flow-events', () => ({ FLOW_EVENT_FIELDS: new Set(), applyFlowEvent: vi.fn() }))
vi.mock('@/lib/meta-capi', () => ({ recordCtwaTouch: vi.fn() }))
vi.mock('@/lib/whatsapp-pricing', () => ({ pricingColumnsFromStatus: vi.fn(() => null) }))
vi.mock('@/lib/whatsapp-media-server', () => ({ ensureMediaRehosted: vi.fn() }))
vi.mock('@/lib/whatsapp-bsuid', () => ({ captureInboundBsuid: vi.fn() }))
// `@/lib/whatsapp-coexistence` is deliberately NOT mocked: parseAccountUpdateEvent,
// nextCoexistenceLinkState and COEX_LINK_EVENTS are the real pure helpers.
vi.mock('@/lib/whatsapp-coexistence-ingest', () => ({ syncContactMatchOnly: vi.fn(), ingestCoexistenceMessage: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { NUMBER_EVENT_FIELDS, applyNumberEvent } from '@/lib/whatsapp-number-events'

// Recording fake supabase client (same shape as route.test.js): chainable,
// thenable, per-table response handlers, every terminal call recorded.
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
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
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

const WABA = '100000000000001'
// One active coexistence number on the WABA, link state never recorded yet
// (so OFFBOARDED is a transition and the handler pushes).
const COEX_ROW = {
  id: 'wn-coex',
  location_id: 'loc-still',
  label: 'Stillorgan',
  display_phone: '+353 1 234 5678',
  business_account_id: WABA,
  signup_meta: { coex_link: null },
  quality_rating: 'GREEN',
  messaging_limit_tier: 'TIER_1K',
  name_status: 'APPROVED',
}

const isCoexLookup = (ops) => ops.some(([m, col, v]) => m === 'eq' && col === 'source' && v === 'coexistence')

function reqFor(body) {
  return { text: async () => JSON.stringify(body), headers: { get: () => 'sha256=sig' } }
}

function wabaEnvelope(field, value) {
  return { entry: [{ id: WABA, changes: [{ field, value }] }] }
}

let errSpy
let warnSpy
let db

// The coexistence handler's lookup is the one filtered to source='coexistence';
// the number-event path selects every row unfiltered.
const coexLookups = () => db.calls.filter((c) => c.table === 'whatsapp_numbers' && isCoexLookup(c.ops))
const coexLinkWrites = () => db.writes().filter((c) => c.table === 'whatsapp_numbers'
  && c.ops.some(([m, p]) => m === 'update' && p?.signup_meta && 'coex_link' in p.signup_meta))
const pushesOfType = (type) => sendPushToRolesAtLocation.mock.calls.filter(([, , payload]) => payload?.data?.type === type)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_APP_SECRET = 'secret'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  db = makeDb({
    whatsapp_numbers: (ops) => {
      if (ops.some(([m]) => m === 'update')) return { data: null, error: null }
      return { data: [COEX_ROW], error: null }
    },
  })
  createServerClient.mockReturnValue(db)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WA-COEX.7 — the real NUMBER_EVENT_FIELDS claims account_update', () => {
  it('pins the shared-field fact this file exists for', () => {
    expect(NUMBER_EVENT_FIELDS.has('account_update')).toBe(true)
  })
})

describe('POST /api/webhooks/whatsapp — account_update is dispatched to BOTH handlers', () => {
  it('ACCOUNT_OFFBOARDED: the number-event path runs AND the coexistence link state is written + pushed', async () => {
    const res = await POST(reqFor(wabaEnvelope('account_update', { event: 'ACCOUNT_OFFBOARDED' })))
    expect(res.status).toBe(200)

    // Number-event path (WA-HEALTH) — routed by WABA id.
    expect(applyNumberEvent).toHaveBeenCalledWith(db, 'account_update', { event: 'ACCOUNT_OFFBOARDED' }, { wabaId: WABA })

    // Coexistence path (WA-COEX.6) — its lookup is scoped to the WABA's
    // active coexistence numbers...
    expect(coexLookups()).toHaveLength(1)
    expect(coexLookups()[0].ops).toEqual(expect.arrayContaining([
      ['eq', 'business_account_id', WABA],
      ['eq', 'source', 'coexistence'],
      ['eq', 'is_active', true],
    ]))
    // ...it records the offboard on signup_meta.coex_link...
    expect(coexLinkWrites()).toHaveLength(1)
    const [, patch] = coexLinkWrites()[0].ops.find(([m]) => m === 'update')
    expect(patch.signup_meta.coex_link).toMatchObject({ status: 'offboarded', event: 'ACCOUNT_OFFBOARDED', reconnected_at: null })
    expect(patch.signup_meta.coex_link.offboarded_at).toEqual(expect.any(String))
    expect(coexLinkWrites()[0].ops).toContainEqual(['eq', 'id', 'wn-coex'])
    // ...and pages the managers at that number's location on the transition.
    expect(pushesOfType('coex_link')).toHaveLength(1)
    const [locationId, roles, payload] = pushesOfType('coex_link')[0]
    expect(locationId).toBe('loc-still')
    expect(roles).toEqual(['owner', 'manager', 'head_coach'])
    expect(payload).toMatchObject({
      title: 'WhatsApp disconnected',
      category: 'whatsapp',
      data: { type: 'coex_link', event: 'ACCOUNT_OFFBOARDED', number_id: 'wn-coex' },
    })
    // OFFBOARDED is not a number-health notification, so no second push.
    expect(pushesOfType('number_health')).toHaveLength(0)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a SEVERE account event (ACCOUNT_RESTRICTION) still pages via the number-event path, and the coexistence path logs + ignores it', async () => {
    const res = await POST(reqFor(wabaEnvelope('account_update', { event: 'ACCOUNT_RESTRICTION' })))
    expect(res.status).toBe(200)

    expect(pushesOfType('number_health')).toHaveLength(1)
    expect(pushesOfType('number_health')[0][2]).toMatchObject({ title: 'WhatsApp Business account alert', data: { field: 'account_update' } })

    // The coexistence handler saw it (breadcrumb) but a restriction never
    // touches the link state.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('account_update ACCOUNT_RESTRICTION ignored'))
    expect(coexLinkWrites()).toEqual([])
    expect(pushesOfType('coex_link')).toHaveLength(0)
  })

  it('phone_number_quality_update goes ONLY to the number-event path (no coexistence lookup, no link write)', async () => {
    const res = await POST(reqFor(wabaEnvelope('phone_number_quality_update', { event: 'FLAGGED', display_phone_number: '+353 1 234 5678' })))
    expect(res.status).toBe(200)

    expect(applyNumberEvent).toHaveBeenCalledWith(db, 'phone_number_quality_update', expect.objectContaining({ event: 'FLAGGED' }), { wabaId: WABA })
    expect(pushesOfType('number_health')).toHaveLength(1)

    expect(coexLookups()).toEqual([])
    expect(coexLinkWrites()).toEqual([])
    expect(pushesOfType('coex_link')).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('account_update'))
  })

  it('applyNumberEvent throwing does not stop the coexistence handler: link written, push sent, failure logged, 200', async () => {
    applyNumberEvent.mockRejectedValueOnce(new Error('boom'))

    const res = await POST(reqFor(wabaEnvelope('account_update', { event: 'ACCOUNT_RECONNECTED' })))
    expect(res.status).toBe(200)

    expect(errSpy).toHaveBeenCalledWith('[wa-webhook] number event failed:', 'boom')
    expect(coexLinkWrites()).toHaveLength(1)
    const [, patch] = coexLinkWrites()[0].ops.find(([m]) => m === 'update')
    expect(patch.signup_meta.coex_link).toMatchObject({ status: 'connected', event: 'ACCOUNT_RECONNECTED', offboarded_at: null })
    expect(pushesOfType('coex_link')).toHaveLength(1)
    expect(pushesOfType('coex_link')[0][2]).toMatchObject({ title: 'WhatsApp reconnected' })
  })

  it('the coexistence handler throwing is caught at the call site: number-event path already ran, failure logged, 200', async () => {
    db = makeDb({
      whatsapp_numbers: (ops) => {
        if (isCoexLookup(ops)) throw new Error('coex lookup exploded')
        return { data: [COEX_ROW], error: null }
      },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(reqFor(wabaEnvelope('account_update', { event: 'ACCOUNT_OFFBOARDED' })))
    expect(res.status).toBe(200)

    expect(applyNumberEvent).toHaveBeenCalledWith(db, 'account_update', { event: 'ACCOUNT_OFFBOARDED' }, { wabaId: WABA })
    expect(errSpy).toHaveBeenCalledWith('[wa-webhook] account_update failed:', 'coex lookup exploded')
    expect(coexLinkWrites()).toEqual([])
    expect(pushesOfType('coex_link')).toHaveLength(0)
  })
})
