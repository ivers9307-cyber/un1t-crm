// HOST-CONSENT.1 — every host consent write goes through this module.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import {
  HOST_CONSENT_CHANNEL,
  grantHostConsent,
  grantHostConsentBulk,
  revokeHostConsent,
  resubscribeHost,
} from './host-consent.js'

// Chainable thenable recorder (host-campaign-queue.test.js idiom).
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? { data: null, error: null })
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}
const op = (s, m) => s.ops.find((o) => o.method === m)
const hasEq = (s, col, val) => s.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

const H = 'h-1', C = 'c-1'

beforeEach(() => vi.clearAllMocks())

describe('grantHostConsent', () => {
  it('flips consent on the membership row and logs opt_in with host_id', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'mailing_list_form', ipAddress: '1.2.3.4' })
    expect(r).toEqual({ ok: true, changed: true })

    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'update').args[0]).toMatchObject({ marketing_consent: true, marketing_consent_source: 'mailing_list_form' })
    expect(typeof op(upd, 'update').args[0].marketing_consented_at).toBe('string')
    expect(hasEq(upd, 'host_id', H) && hasEq(upd, 'contact_id', C) && hasEq(upd, 'marketing_consent', false)).toBe(true)

    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0]).toEqual([{
      contact_id: C, channel: HOST_CONSENT_CHANNEL, action: 'opt_in',
      source: 'mailing_list_form', ip_address: '1.2.3.4', host_id: H, location_id: null,
    }])
  })

  it('is a no-op (no log row) when consent was already true', async () => {
    const { db, statements } = makeDb(() => ({ data: [], error: null }))
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'event_form' })
    expect(r).toEqual({ ok: true, changed: false })
    expect(statements.some((s) => s.table === 'consent_log')).toBe(false)
  })

  it('reports a failed write instead of swallowing it', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'event_form' })
    expect(r).toEqual({ ok: false, changed: false, error: 'boom', code: null })
  })
})

describe('grantHostConsentBulk', () => {
  it('updates only rows still false and logs one row per contact actually flipped', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_contacts') return { data: [{ contact_id: 'c-2' }], error: null }
      return { data: null, error: null }
    })
    const r = await grantHostConsentBulk(db, { hostId: H, contactIds: ['c-1', 'c-2', 'c-1', null], source: 'event_form' })
    expect(r).toEqual({ ok: true, changed: 1 })
    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'in').args).toEqual(['contact_id', ['c-1', 'c-2']])
    expect(hasEq(upd, 'host_id', H)).toBe(true)
    expect(hasEq(upd, 'marketing_consent', false)).toBe(true)
    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0]).toHaveLength(1)
    expect(op(log, 'insert').args[0][0]).toMatchObject({ contact_id: 'c-2', action: 'opt_in', host_id: H })
  })
  it('returns changed 0 with no writes for an empty list', async () => {
    const { db, statements } = makeDb(() => ({}))
    expect(await grantHostConsentBulk(db, { hostId: H, contactIds: [], source: 'event_form' })).toEqual({ ok: true, changed: 0 })
    expect(statements).toHaveLength(0)
  })
})

describe('revokeHostConsent', () => {
  it('upserts the suppression row (insert-once), flips consent false, and logs opt_out', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page', ipAddress: '9.9.9.9' })
    expect(r).toEqual({ ok: true, changed: true })
    const sup = statements.find((s) => s.table === 'host_email_suppressions')
    expect(op(sup, 'upsert').args).toEqual([
      { host_id: H, contact_id: C },
      { onConflict: 'host_id,contact_id', ignoreDuplicates: true },
    ])
    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'update').args[0]).toEqual({ marketing_consent: false })
    expect(hasEq(upd, 'host_id', H) && hasEq(upd, 'contact_id', C) && hasEq(upd, 'marketing_consent', true)).toBe(true)
    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0][0]).toMatchObject({ contact_id: C, channel: HOST_CONSENT_CHANNEL, action: 'opt_out', source: 'host_unsubscribe_page', host_id: H })
  })
  it('already suppressed → ok, changed false, no log row', async () => {
    const { db, statements } = makeDb(() => ({ data: [], error: null }))
    expect(await revokeHostConsent(db, { hostId: H, contactId: C, source: 'postmark_one_click_unsubscribe' })).toEqual({ ok: true, changed: false })
    expect(statements.some((s) => s.table === 'consent_log')).toBe(false)
  })
  it('already suppressed but consent still true (legacy) → flips consent, changed true, one opt_out row', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [], error: null }
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page' })
    expect(r).toEqual({ ok: true, changed: true })
    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0]).toHaveLength(1)
  })
  it('a failed consent flip is reported', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      if (s.table === 'host_contacts') return { data: null, error: { message: 'boom' } }
      return { data: null, error: null }
    })
    const r = await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page' })
    expect(r).toEqual({ ok: false, changed: true, error: 'boom', code: null })
    expect(statements.some((s) => s.table === 'consent_log')).toBe(false)
  })
  it('never touches contacts.email_marketing', async () => {
    const { db, statements } = makeDb(() => ({ data: [{ id: 's-1' }], error: null }))
    await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page' })
    expect(statements.some((s) => s.table === 'contacts' || s.table === 'contact_preferences')).toBe(false)
  })
  it('reports a failed suppression write instead of claiming success', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect(await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page' })).toEqual({ ok: false, changed: false, error: 'boom', code: null })
  })
  it('a suppression FK violation (contact erased) surfaces its Postgres code', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'fk', code: '23503' } }))
    expect(await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_one_click_unsubscribe' })).toEqual({ ok: false, changed: false, error: 'fk', code: '23503' })
  })
})

describe('resubscribeHost', () => {
  it('deletes the suppression row, then grants with source host_resubscribe', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await resubscribeHost(db, { hostId: H, contactId: C, ipAddress: '1.1.1.1' })
    expect(r).toEqual({ ok: true, unsuppressed: true, changed: true })
    const del = statements.find((s) => s.table === 'host_email_suppressions')
    expect(op(del, 'delete')).toBeTruthy()
    expect(hasEq(del, 'host_id', H) && hasEq(del, 'contact_id', C)).toBe(true)
    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'update').args[0]).toMatchObject({ marketing_consent_source: 'host_resubscribe' })
  })
  it('a failed delete is reported and nothing is granted', async () => {
    const { db, statements } = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    expect(await resubscribeHost(db, { hostId: H, contactId: C })).toEqual({ ok: false, unsuppressed: false, changed: false, error: 'boom', code: null })
    expect(statements.some((s) => s.table === 'host_contacts')).toBe(false)
  })
  it('a failed grant after a successful delete is reported with unsuppressed:true (not mailable: consent still false)', async () => {
    const { db } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      if (s.table === 'host_contacts') return { data: null, error: { message: 'boom' } }
      return { data: null, error: null }
    })
    expect(await resubscribeHost(db, { hostId: H, contactId: C })).toEqual({ ok: false, unsuppressed: true, changed: false, error: 'boom' })
  })
})
