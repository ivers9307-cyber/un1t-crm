// MOBILEFUNNEL.1 — the offer forms' consent rule: ticked opts in; unticked
// opts out a contact this request created; unticked leaves an existing one alone.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apply = vi.hoisted(() => vi.fn(async () => ({ ok: true, changed: [] })))
vi.mock('./marketing-consent.js', () => ({ applyFormMarketingConsent: apply }))
vi.mock('./log.js', () => ({ logError: vi.fn() }))

import { applyOfferFormConsent } from './offer-form-consent'

// contact_location_preferences as a PK-keyed store: an upsert with
// ignoreDuplicates inserts only a missing row and returns only what it inserted.
function makeDb({ rows = [], upsertError = null, logError: logErr = null } = {}) {
  const state = { rows: rows.map((r) => ({ ...r })), logged: [], upserts: [] }
  const db = {
    from(table) {
      if (table === 'contact_location_preferences') {
        return {
          upsert(row, opts) {
            state.upserts.push({ row, opts })
            return {
              select: async () => {
                if (upsertError) return { data: null, error: upsertError }
                const exists = state.rows.some((r) => r.contact_id === row.contact_id && r.location_id === row.location_id)
                if (exists && opts?.ignoreDuplicates) return { data: [], error: null }
                state.rows.push({ ...row })
                return { data: [{ contact_id: row.contact_id }], error: null }
              },
            }
          },
        }
      }
      if (table === 'consent_log') return { insert: async (r) => { state.logged.push(...r); return { error: logErr } } }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, state }
}

const args = { contactId: 'c1', source: 'corp_promo', ipAddress: '1.2.3.4', locationId: 'L1' }
beforeEach(() => apply.mockClear())

describe('applyOfferFormConsent', () => {
  it('ticked opts in, new or existing', async () => {
    for (const created of [true, false]) {
      apply.mockClear()
      expect((await applyOfferFormConsent({}, { ...args, created, consent: true })).applied).toBe('opt_in')
      expect(apply).toHaveBeenCalledWith({}, { contactId: 'c1', consent: true, source: 'corp_promo', ipAddress: '1.2.3.4', locationId: 'L1' })
    }
  })
  it('unticked and created by this request opts out', async () => {
    expect((await applyOfferFormConsent({}, { ...args, created: true, consent: false })).applied).toBe('opt_out')
    expect(apply).toHaveBeenCalledWith({}, expect.objectContaining({ contactId: 'c1', consent: false, locationId: 'L1' }))
  })
  it('unticked (or absent), existing contact WITH a row at this studio: the row is untouched, nothing logged', async () => {
    const existing = { contact_id: 'c1', location_id: 'L1', email_marketing: true, sms_marketing: true, whatsapp_marketing: true, source: 'contact_created' }
    for (const consent of [false, undefined]) {
      const { db, state } = makeDb({ rows: [existing] })
      const out = await applyOfferFormConsent(db, { ...args, created: false, consent })
      expect(out.applied).toBeNull()
      expect(out.result.ok).toBe(true)
      expect(state.rows).toEqual([existing])
      expect(state.upserts[0].opts).toEqual({ onConflict: 'contact_id,location_id', ignoreDuplicates: true })
      expect(state.logged).toEqual([])
    }
    expect(apply).not.toHaveBeenCalled() // never the org-wide opt-out
  })
  it('unticked, existing contact with NO row at this studio: a row with marketing off is created and logged', async () => {
    const { db, state } = makeDb({ rows: [{ contact_id: 'c1', location_id: 'HOME' }] })
    const out = await applyOfferFormConsent(db, { ...args, created: false, consent: false })
    expect(out.applied).toBe('studio_row')
    expect(out.result.ok).toBe(true)
    const row = state.rows.find((r) => r.location_id === 'L1')
    expect(row).toMatchObject({ contact_id: 'c1', location_id: 'L1', email_marketing: false, sms_marketing: false, whatsapp_marketing: false, source: 'corp_promo' })
    expect(row.unsubscribed_at).toEqual(expect.any(String))
    expect(state.logged.map((l) => l.channel)).toEqual(['email_marketing', 'sms_marketing', 'whatsapp_marketing'])
    for (const l of state.logged) expect(l).toMatchObject({ contact_id: 'c1', action: 'opt_out', source: 'corp_promo', ip_address: '1.2.3.4', location_id: 'L1' })
    expect(apply).not.toHaveBeenCalled()
  })
  it('a failed studio-row write reports ok false (the caller logs it), never throws', async () => {
    const { db } = makeDb({ upsertError: { code: '42501', message: 'denied' } })
    const out = await applyOfferFormConsent(db, { ...args, created: false, consent: false })
    expect(out.result.ok).toBe(false)
    const logFail = makeDb({ logError: { code: 'x', message: 'nope' } })
    const out2 = await applyOfferFormConsent(logFail.db, { ...args, created: false, consent: false })
    expect(out2.result).toMatchObject({ ok: false, inserted: true })
  })
})
