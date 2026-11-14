// STAFFCONSENT.1 — the one per-studio consent write.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/consent-propagation', () => ({ propagateOptOut: vi.fn(async () => {}) }))
vi.mock('@/lib/postmark-suppressions', () => ({
  suppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [] })),
  unsuppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [], skipped: [] })),
}))
vi.mock('@/lib/postmark-server-for-location', () => ({ serverTokenForLocation: vi.fn(async () => 'srv') }))

import { applyStudioPreferenceChange } from './studio-consent'
import { propagateOptOut } from '@/lib/consent-propagation'
import { suppressAtPostmark, unsuppressAtPostmark } from '@/lib/postmark-suppressions'

const LOC = 'loc-1'
const CONTACT = { id: 'c1', email: 'a@x.com', wa_phone: '353870000000', email_status: null, location_id: LOC }

// A tiny recording fake: every builder records its table, op and filters.
function fakeDb({ locRow = { email_marketing: false, sms_marketing: true, whatsapp_marketing: true }, readError = null, writeError = null, logError = null } = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const call = { table, op: null, payload: null, filters: [] }
      calls.push(call)
      const b = {
        select() { call.op = call.op || 'select'; return b },
        update(p) { call.op = 'update'; call.payload = p; return b },
        insert(p) { call.op = 'insert'; call.payload = p; return Promise.resolve({ error: table === 'consent_log' ? logError : null }) },
        eq(c, v) { call.filters.push([c, v]); return b },
        maybeSingle() { return Promise.resolve({ data: locRow, error: readError }) },
        then(res, rej) {
          const error = call.op === 'update' && table === 'contact_location_preferences' ? writeError : null
          return Promise.resolve({ data: null, error }).then(res, rej)
        },
      }
      return b
    },
  }
  return db
}

const run = (db, extra = {}) => applyStudioPreferenceChange(db, {
  contact: CONTACT, locationId: LOC, changes: { email_marketing: true }, source: 'staff_studio',
  performedBy: 'staff-1', reason: 'email', note: 'asked by email', ...extra,
})

beforeEach(() => { vi.clearAllMocks() })

describe('applyStudioPreferenceChange', () => {
  it('writes the studio row only, never contact_preferences', async () => {
    const db = fakeDb()
    const res = await run(db)
    expect(res).toEqual({ ok: true, changed: ['email_marketing'] })
    expect(db.calls.some((c) => c.table === 'contact_preferences')).toBe(false)
    const write = db.calls.find((c) => c.table === 'contact_location_preferences' && c.op === 'update')
    expect(write.payload.email_marketing).toBe(true)
    expect(write.filters).toEqual([['contact_id', 'c1'], ['location_id', LOC]])
  })

  it('logs the studio, the person, the reason and the note', async () => {
    const db = fakeDb()
    await run(db)
    const log = db.calls.find((c) => c.table === 'consent_log')
    expect(log.payload).toEqual([{
      contact_id: 'c1', channel: 'email_marketing', action: 'opt_in', source: 'staff_studio',
      ip_address: null, location_id: LOC, performed_by: 'staff-1', reason: 'email', note: 'asked by email',
    }])
  })

  it('writes nothing and logs nothing when the studio is already in that state', async () => {
    const db = fakeDb({ locRow: { email_marketing: true } })
    const res = await run(db)
    expect(res).toEqual({ ok: true, changed: [] })
    expect(db.calls.filter((c) => c.op === 'update' || c.op === 'insert')).toEqual([])
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('returns 500 and writes no log row when the studio write fails', async () => {
    const db = fakeDb({ writeError: { message: 'boom' } })
    const res = await run(db)
    expect(res).toMatchObject({ ok: false, status: 500 })
    expect(db.calls.some((c) => c.table === 'consent_log')).toBe(false)
  })

  it('returns 500 when the studio row cannot be read', async () => {
    const res = await run(fakeDb({ readError: { message: 'down' } }))
    expect(res).toMatchObject({ ok: false, status: 500 })
  })

  it('returns 404 when the contact has no row at that studio', async () => {
    const res = await run(fakeDb({ locRow: null }))
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('still succeeds when the log insert fails after the change landed', async () => {
    const res = await run(fakeDb({ logError: { message: 'x' } }))
    expect(res).toEqual({ ok: true, changed: ['email_marketing'] })
  })

  it('an email opt-in lifts a manual Postmark suppression and normalises reputation', async () => {
    const db = fakeDb()
    await run(db)
    expect(unsuppressAtPostmark).toHaveBeenCalledWith('a@x.com', { serverToken: 'srv' })
    const status = db.calls.find((c) => c.table === 'contacts' && c.op === 'update')
    expect(status.payload).toEqual({ email_status: 'active' })
  })

  it('leaves a bounced address bounced on opt-in', async () => {
    const db = fakeDb()
    await run(db, { contact: { ...CONTACT, email_status: 'bounced' } })
    expect(db.calls.some((c) => c.table === 'contacts')).toBe(false)
  })

  it('an opt-out propagates to linked addresses and never suppresses at Postmark', async () => {
    const db = fakeDb({ locRow: { email_marketing: true } })
    const res = await run(db, { changes: { email_marketing: false } })
    expect(res.changed).toEqual(['email_marketing'])
    expect(propagateOptOut).toHaveBeenCalledWith(db, {
      contactId: 'c1', email: 'a@x.com', waPhone: '353870000000', channels: ['email_marketing'], locationId: LOC,
    })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('an opt-in never propagates', async () => {
    await run(fakeDb())
    expect(propagateOptOut).not.toHaveBeenCalled()
  })

  it('leaves the staff fields off a preference-centre row', async () => {
    const db = fakeDb()
    await applyStudioPreferenceChange(db, { contact: CONTACT, locationId: LOC, changes: { email_marketing: true }, source: 'preference_centre', ipAddress: '1.2.3.4' })
    const log = db.calls.find((c) => c.table === 'consent_log')
    expect(log.payload[0]).toEqual({ contact_id: 'c1', channel: 'email_marketing', action: 'opt_in', source: 'preference_centre', ip_address: '1.2.3.4', location_id: LOC })
  })
})
