// C120 GATES-3 (e) — a DRIP starts through /send like a blast.
//
// POST /api/whatsapp/broadcasts used to create an unscheduled drip straight
// into 'sending', which the cron then sent with none of /send's entry checks.
// It now creates a draft and the composer calls /send. sendBroadcast runs the
// same checks for a drip (template approved, URL button value, own number,
// quality preflight with `force`, wallet), then the draft→sending CAS, and
// RETURNS: nothing is sent here, the cron paces it inside its window. A drip
// already 'sending' is never blasted (it used to send the whole remainder).

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let updates = []
let touched = []
let casError = null
const fakeDb = {
  from: (table) => {
    touched.push(table)
    const rows = tables[table] ?? []
    const state = { op: 'select', head: false }
    const b = {}
    for (const m of ['eq', 'neq', 'in', 'gte', 'lt', 'gt', 'or', 'is', 'not', 'order', 'limit']) b[m] = () => b
    b.select = (_cols, opts) => {
      if (state.op === 'update') return b
      if (opts?.head) state.head = true
      return b
    }
    b.range = () => Promise.resolve({ data: rows, error: null })
    b.update = (patch) => { state.op = 'update'; state.patch = patch; return b }
    b.single = () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } })
    b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    b.then = (resolve, reject) => {
      if (state.op === 'update') {
        if (casError) return Promise.resolve({ data: null, error: casError }).then(resolve, reject)
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
vi.mock('./wallet-enforcement.js', () => ({ checkSpend: vi.fn(async () => ({ allow: true, reason: 'unpinned' })) }))

import { sendBroadcast } from './whatsapp.js'
import { getWhatsAppConfig } from './whatsapp-config'
import { checkSpend } from './wallet-enforcement.js'

const TEMPLATE = { id: 'tmpl-1', name: 'promo', language: 'en', status: 'APPROVED', components: [] }
const drip = (overrides = {}) => ({
  id: 'bc-d', location_id: 'loc-1', status: 'draft', delivery_mode: 'drip',
  paused_at: null, daily_cap: 50, audience_filter: null, variable_mapping: {},
  whatsapp_templates: TEMPLATE, ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  tables = {}
  updates = []
  touched = []
  casError = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendBroadcast — a drip starts, it is never blasted (GATES-3 e)', () => {
  it('a draft drip: the CAS flips it to sending and nothing is sent (no audience read)', async () => {
    tables = { whatsapp_broadcasts: [drip()] }
    const result = await sendBroadcast('bc-d')
    expect(result).toEqual({ status: 'sending', mode: 'drip', sent: 0, failed: 0, total: 0 })
    expect(updates).toEqual([{ table: 'whatsapp_broadcasts', patch: { status: 'sending', paused_at: null } }])
    expect(touched).not.toContain('contacts')
    expect(touched).not.toContain('whatsapp_broadcast_recipients')
  })

  it('a drip already sending is left to the cron: no write, no send', async () => {
    tables = { whatsapp_broadcasts: [drip({ status: 'sending' })] }
    const result = await sendBroadcast('bc-d')
    expect(result).toMatchObject({ status: 'sending', mode: 'drip', sent: 0, skipped: 'already-sending' })
    expect(updates).toEqual([])
    expect(touched).not.toContain('contacts')
  })

  it('the entry checks run first: an unapproved template refuses, the drip stays a draft', async () => {
    tables = { whatsapp_broadcasts: [drip({ whatsapp_templates: { ...TEMPLATE, status: 'PENDING' } })] }
    await expect(sendBroadcast('bc-d')).rejects.toThrow(/not approved/)
    expect(updates).toEqual([])
  })

  it('the quality preflight refuses a RED number (force overrides it)', async () => {
    tables = { whatsapp_broadcasts: [drip()] }
    const red = { phoneNumberId: 'pn-1', token: 't', qualityRating: 'RED', messagingLimitTier: null }
    getWhatsAppConfig.mockResolvedValueOnce(red).mockResolvedValueOnce(red)
    await expect(sendBroadcast('bc-d')).rejects.toThrow(/quality/i)
    expect(updates).toEqual([])
    const forced = await sendBroadcast('bc-d', { force: true })
    expect(forced).toMatchObject({ status: 'sending', mode: 'drip' })
  })

  it('the wallet gate refuses an empty wallet, the drip stays a draft', async () => {
    tables = { whatsapp_broadcasts: [drip()] }
    checkSpend.mockResolvedValueOnce({ allow: false, reason: 'wallet_empty' })
    await expect(sendBroadcast('bc-d')).rejects.toThrow(/wallet is empty/i)
    expect(updates).toEqual([])
  })

  it('a failed start flip throws (it was read as "already sending")', async () => {
    tables = { whatsapp_broadcasts: [drip()] }
    casError = { code: '57014', message: 'timeout' }
    await expect(sendBroadcast('bc-d')).rejects.toThrow(/could not start/i)
  })
})
