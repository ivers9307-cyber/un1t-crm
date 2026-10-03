// WACONFIGFALLBACK.1 — a broadcast at a location with no WhatsApp number of
// its own (it used to go out on the global env number):
//   - a BLAST refuses before the draft→sending flip (entry state untouched),
//     so the send route answers 409 and the scheduling cron pushes managers;
//   - a DRIP tick PAUSES the broadcast (like an unapproved template) instead
//     of throwing, which would error-loop every cron tick.
// Fake DB harness copied from whatsapp-wallet-gate.test.js.

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
  getWhatsAppConfig: vi.fn(),
}))

import { sendBroadcast, sendDripChunk } from './whatsapp.js'
import { getWhatsAppConfig } from './whatsapp-config'
import { WhatsAppNumberMissingError } from './whatsapp-number-missing.js'

const TEMPLATE = { id: 'tmpl-1', name: 'promo', language: 'en', status: 'APPROVED', components: [] }
const blastRow = () => ({ id: 'bc-1', location_id: 'loc-1', status: 'draft', delivery_mode: 'blast', audience_filter: null, variable_mapping: {}, whatsapp_templates: TEMPLATE })
const dripRow = () => ({ id: 'bc-2', location_id: 'loc-1', status: 'sending', delivery_mode: 'drip', paused_at: null, daily_cap: 50, audience_filter: null, variable_mapping: {}, whatsapp_templates: TEMPLATE })

beforeEach(() => {
  vi.clearAllMocks()
  tables = {}
  updates = []
  touched = []
  getWhatsAppConfig.mockRejectedValue(new WhatsAppNumberMissingError('loc-1'))
})

describe('blast at a location with no number', () => {
  it('refuses with the typed error BEFORE the status flip; no audience read', async () => {
    tables = { whatsapp_broadcasts: [blastRow()] }
    const err = await sendBroadcast('bc-1').catch((e) => e)
    expect(err).toBeInstanceOf(WhatsAppNumberMissingError)
    expect(err.message).toBe('No WhatsApp number is connected at this location.')
    expect(updates).toEqual([])
    expect(touched).not.toContain('contacts')
  })
})

describe('drip tick at a location with no number', () => {
  it('pauses the drip and returns a skip (no throw, no audience read)', async () => {
    tables = { whatsapp_broadcasts: [dripRow()] }
    const r = await sendDripChunk('bc-2')
    expect(r).toEqual({ status: 'sending', skipped: 'no_whatsapp_number', paused: true, sent: 0, failed: 0 })
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('whatsapp_broadcasts')
    expect(updates[0].patch.paused_at).toEqual(expect.any(String))
    expect(touched).not.toContain('contacts')
  })

  it('a failed lookup (not a missing number) still throws, the drip is NOT paused (next tick retries)', async () => {
    getWhatsAppConfig.mockRejectedValue(new Error('Failed to load WhatsApp config for location loc-1: db down'))
    tables = { whatsapp_broadcasts: [dripRow()] }
    await expect(sendDripChunk('bc-2')).rejects.toThrow(/db down/)
    expect(updates).toEqual([])
  })
})
