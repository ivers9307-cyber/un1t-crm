// WAORGNUMBER.4 (spec R7) — the send engine's blast sign-off gate. The cron
// has no actor, so the gate reads the ROW: while the studio's
// whatsapp_blast_signoff_until is in the future, an unsigned broadcast
//   - (blast) refuses with BlastSignoffRequiredError BEFORE any status flip,
//     so the send route answers 409 and the cron keeps it a draft and pushes
//     the managers (its refused-start path);
//   - (drip) pauses with skipped 'needs_signoff' (a throw would error-loop).
// Fake DB harness copied from whatsapp-no-number-broadcasts.test.js.
// Fictional ids only: the repo is public.

import { describe, it, expect, vi, beforeEach } from 'vitest'

let tables = {}
let updates = []
let touched = []
let faults = {}
const fakeDb = {
  from: (table) => {
    touched.push(table)
    const rows = tables[table] ?? []
    if (faults[table]) {
      const failed = { select: () => failed, eq: () => failed,
        maybeSingle: () => Promise.resolve({ data: null, error: faults[table] }) }
      return failed
    }
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
  getLocationNumberForWaba: vi.fn(),
}))

import { sendBroadcast, sendDripChunk } from './whatsapp.js'
import { getWhatsAppConfig } from './whatsapp-config'
import { WhatsAppNumberMissingError } from './whatsapp-number-missing.js'
import { BlastSignoffRequiredError } from './whatsapp-blast-signoff.js'

const TEMPLATE = { id: 'tmpl-1', name: 'promo', language: 'en', status: 'APPROVED', components: [] }
const blastRow = (extra = {}) => ({ id: 'bc-1', location_id: 'loc-h', status: 'draft', delivery_mode: 'blast', audience_filter: null, variable_mapping: {}, whatsapp_templates: TEMPLATE, signed_off_by: null, ...extra })
const dripRow = (extra = {}) => ({ id: 'bc-2', location_id: 'loc-h', status: 'sending', delivery_mode: 'drip', paused_at: null, daily_cap: 50, audience_filter: null, variable_mapping: {}, whatsapp_templates: TEMPLATE, signed_off_by: null, ...extra })
const hatch = (until) => ({ id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org-1', timezone: 'Europe/Dublin',
  settings: { whatsapp_blast_signoff_until: until } })
const OPEN = '2999-11-16'

beforeEach(() => {
  vi.clearAllMocks()
  tables = {}
  updates = []
  touched = []
  faults = {}
  // Past every gate in this file the engine reaches the resolver: a refusal
  // there proves the sign-off gate let the broadcast through.
  getWhatsAppConfig.mockRejectedValue(new WhatsAppNumberMissingError('loc-h'))
})

describe('blast', () => {
  it('unsigned inside the window: refuses with the copy before any flip; no number resolved', async () => {
    tables = { whatsapp_broadcasts: [blastRow()], locations: [hatch(OPEN)] }
    const err = await sendBroadcast('bc-1').catch((e) => e)
    expect(err).toBeInstanceOf(BlastSignoffRequiredError)
    expect(err.message).toBe('Blasts at UN1T Hatch Street need sign-off from an organisation admin until 16 Nov 2999.')
    expect(updates).toEqual([])
    expect(getWhatsAppConfig).not.toHaveBeenCalled()
  })
  it('admin sign-off on a draft lets it through (the cron can send it)', async () => {
    tables = { whatsapp_broadcasts: [blastRow({ signed_off_by: 'u-a' })], locations: [hatch(OPEN)] }
    const err = await sendBroadcast('bc-1').catch((e) => e)
    expect(err).toBeInstanceOf(WhatsAppNumberMissingError)
    expect(touched).not.toContain('locations')
  })
  it('window past → no gate', async () => {
    tables = { whatsapp_broadcasts: [blastRow()], locations: [hatch('2020-01-01')] }
    expect(await sendBroadcast('bc-1').catch((e) => e)).toBeInstanceOf(WhatsAppNumberMissingError)
  })
  it('a failed studio read refuses (fails closed) before any flip', async () => {
    tables = { whatsapp_broadcasts: [blastRow()] }
    faults = { locations: { message: 'db down' } }
    await expect(sendBroadcast('bc-1')).rejects.toThrow(/sign-off/)
    expect(updates).toEqual([])
  })
})

describe('drip', () => {
  it('unsigned drip pauses (needs_signoff), no throw, no audience read', async () => {
    tables = { whatsapp_broadcasts: [dripRow()], locations: [hatch(OPEN)] }
    const r = await sendDripChunk('bc-2')
    expect(r).toEqual({ status: 'sending', skipped: 'needs_signoff', paused: true, sent: 0, failed: 0 })
    expect(updates).toEqual([{ table: 'whatsapp_broadcasts', patch: { paused_at: expect.any(String) } }])
    expect(touched).not.toContain('contacts')
    expect(getWhatsAppConfig).not.toHaveBeenCalled()
  })
  it('a signed drip is not paused for sign-off', async () => {
    tables = { whatsapp_broadcasts: [dripRow({ signed_off_by: 'u-a' })], locations: [hatch(OPEN)] }
    const r = await sendDripChunk('bc-2')
    expect(r.skipped).toBe('no_whatsapp_number')
  })
  it('window past → no gate', async () => {
    tables = { whatsapp_broadcasts: [dripRow()], locations: [hatch('2020-01-01')] }
    expect((await sendDripChunk('bc-2')).skipped).toBe('no_whatsapp_number')
  })
  it('a failed studio read throws; the drip is not paused (next tick retries)', async () => {
    tables = { whatsapp_broadcasts: [dripRow()] }
    faults = { locations: { message: 'db down' } }
    await expect(sendDripChunk('bc-2')).rejects.toThrow(/sign-off/)
    expect(updates).toEqual([])
  })
})
