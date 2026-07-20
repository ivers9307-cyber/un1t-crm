// INTEG-C3 — per-location wallet gate on the WhatsApp bulk marketing
// paths (blast preflight + drip tick), composing with the existing
// quality gate, per-broadcast daily_cap and Meta tier budget.
//
// Contract pinned here:
//   (a) UNPINNED location (the real checkSpend against a stub db with
//       no active tier pinning) — blast/drip behave byte-identically
//       to before enforcement existed.
//   (b) Pinned + allowance exhausted + wallet empty — the blast
//       REFUSES TO START (entry state untouched: the gate runs before
//       the draft→sending CAS, the quality-gate posture) and the drip
//       PARKS THE TICK ('sending' + skipped:'wallet_empty', no
//       audience read — a later tick re-checks after a top-up).
//   (c) A thrown wallet check FAILS OPEN on both paths.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let updates = []
let touched = []
const fakeDb = {
  from: (table) => {
    touched.push(table)
    const rows = tables[table] ?? []
    const state = { op: 'select', head: false }
    const b = {}
    for (const m of ['eq', 'neq', 'in', 'gte', 'lt', 'gt', 'or', 'is', 'not', 'order', 'limit']) b[m] = () => b
    b.select = (_cols, opts) => {
      if (state.op === 'update') return b // .update().eq().select('id') CAS shape
      if (opts?.head) state.head = true
      return b
    }
    b.range = () => Promise.resolve({ data: rows, error: null })
    b.update = (patch) => { state.op = 'update'; state.patch = patch; return b }
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } })
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    b.then = (resolve, reject) => {
      if (state.op === 'update') {
        updates.push({ table, patch: state.patch })
        return Promise.resolve({ data: [{ id: 'row-1' }], error: null }).then(resolve, reject)
      }
      const out = state.head ? { count: 0, error: null } : { data: rows, error: null }
      return Promise.resolve(out).then(resolve, reject)
    }
    return b
  },
}

vi.mock('./supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('./whatsapp-config', () => ({
  META_API_URL: 'https://graph.facebook.com/v21.0',
  getWhatsAppConfig: vi.fn(async () => ({
    phoneNumberId: 'pn-1', token: 'tok', businessAccountId: 'waba-1',
    qualityRating: null, messagingLimitTier: null,
  })),
}))
vi.mock('./wallet-enforcement.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, checkSpend: vi.fn(actual.checkSpend) }
})

import { sendBroadcast, sendDripChunk } from './whatsapp.js'
import { checkSpend, clearBillingStateCache } from './wallet-enforcement.js'

const TEMPLATE = { id: 'tmpl-1', name: 'promo', language: 'en', status: 'APPROVED', components: [] }

function blastRow(overrides = {}) {
  return {
    id: 'bc-1', location_id: 'loc-1', status: 'draft', delivery_mode: 'blast',
    audience_filter: null, variable_mapping: {}, header_media_url: null,
    whatsapp_templates: TEMPLATE,
    ...overrides,
  }
}

function dripRow(overrides = {}) {
  return {
    id: 'bc-2', location_id: 'loc-1', status: 'sending', delivery_mode: 'drip',
    paused_at: null, daily_cap: 50, per_tick_max: null, audience_filter: null,
    whatsapp_templates: TEMPLATE,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBillingStateCache()
  tables = {}
  updates = []
  touched = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendBroadcast — INTEG-C3 wallet gate (blast preflight)', () => {
  it('(b) pinned + empty wallet: refuses BEFORE the status flip — entry state untouched', async () => {
    tables = { whatsapp_broadcasts: [blastRow()] }
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })

    await expect(sendBroadcast('bc-1')).rejects.toThrow(/prepaid wallet is empty/i)

    expect(checkSpend).toHaveBeenCalledWith(fakeDb, 'loc-1', 'wa_template_send', 'marketing')
    // No draft→sending CAS, no recipient claims, no audience read.
    expect(updates).toEqual([])
    expect(touched).not.toContain('contacts')
  })

  it('(a) unpinned location: the REAL checkSpend passes and the empty-audience blast completes as before', async () => {
    tables = {
      whatsapp_broadcasts: [blastRow()],
      location_plans: [],   // no active tier pinning — unpinned
      contacts: [],         // empty audience → clean legacy 'sent' path
      whatsapp_broadcast_recipients: [],
    }

    const result = await sendBroadcast('bc-1')

    await expect(checkSpend.mock.results[0].value).resolves.toEqual({ allow: true, reason: 'unpinned' })
    expect(result).toMatchObject({ status: 'sent', sent: 0 })
    // The legacy state machine ran: draft→sending CAS, then the
    // empty-audience completion update.
    expect(updates[0]).toMatchObject({ table: 'whatsapp_broadcasts', patch: expect.objectContaining({ status: 'sending' }) })
    expect(updates.at(-1)).toMatchObject({ table: 'whatsapp_broadcasts', patch: expect.objectContaining({ status: 'sent' }) })
  })

  it('(c) a thrown wallet check FAILS OPEN — the blast proceeds', async () => {
    tables = {
      whatsapp_broadcasts: [blastRow()],
      contacts: [],
      whatsapp_broadcast_recipients: [],
    }
    checkSpend.mockRejectedValueOnce(new Error('billing infra down'))

    const result = await sendBroadcast('bc-1')
    expect(result).toMatchObject({ status: 'sent', sent: 0 })
  })
})

describe('sendDripChunk — INTEG-C3 wallet gate (tick parking)', () => {
  it('(b) pinned + empty wallet: parks the tick without reading the audience; drip stays open', async () => {
    tables = { whatsapp_broadcasts: [dripRow()], whatsapp_broadcast_recipients: [] }
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })

    const result = await sendDripChunk('bc-2')

    expect(result).toEqual({ status: 'sending', skipped: 'wallet_empty', sent: 0, failed: 0 })
    // No pause stamp, no status change — the next tick re-checks.
    expect(updates).toEqual([])
    expect(touched).not.toContain('contacts')
  })

  it('(a) unpinned location: the REAL checkSpend passes and the empty-audience drip completes as before', async () => {
    tables = {
      whatsapp_broadcasts: [dripRow()],
      location_plans: [],
      whatsapp_broadcast_recipients: [],
      contacts: [],
    }

    const result = await sendDripChunk('bc-2')

    await expect(checkSpend.mock.results[0].value).resolves.toEqual({ allow: true, reason: 'unpinned' })
    // Legacy empty-audience completion: the drip closes out as 'sent'.
    expect(result).toMatchObject({ status: 'sent', sent: 0 })
  })

  it('(c) a thrown wallet check FAILS OPEN — the tick proceeds', async () => {
    tables = {
      whatsapp_broadcasts: [dripRow()],
      whatsapp_broadcast_recipients: [],
      contacts: [],
    }
    checkSpend.mockRejectedValueOnce(new Error('billing infra down'))

    const result = await sendDripChunk('bc-2')
    expect(result).toMatchObject({ status: 'sent', sent: 0 })
  })
})
