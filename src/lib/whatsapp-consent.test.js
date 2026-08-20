// COMMS-AUDIT 2026-07-10 — STOP keyword partial opt-out.
//
// applyWhatsappConsentKeyword used `.update()` on contact_preferences:
// a contact with NO preferences row matched zero rows, so the
// whatsapp_marketing flag never flipped — only contacts.wa_status got
// set. The marketing audience gate (buildWhatsAppAudience) reads the
// preferences flag, so the contact stayed in marketing audiences after
// replying STOP. The fix upserts by contact_id (same convention as
// marketing-consent.js) so the row is created when missing and updated
// when present. These tests pin the upsert + the unchanged behaviour of
// the denormalised contacts.wa_status write and the consent_log audit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyWhatsappConsentKeyword, applyMetaUserPreference } from './whatsapp-consent.js'

vi.mock('./whatsapp', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.ack' }),
}))

import { sendTextMessage } from './whatsapp'

// Chainable stub that records every write. `upsert` resolves directly
// (the code awaits the builder); `update` supports the .eq(...) /
// .eq().eq() chains used across the module.
//
// `failOn` is a { table: message } map — a resolved `{ error }`, which is what
// supabase-js actually does. It never throws, on purpose: the writes here used
// to sit in a try/catch that could not fire, which is exactly how a failed
// opt-out kept returning `applied: true`.
function stubDb({ writes, failOn = {} }) {
  const resultFor = (table) =>
    failOn[table] ? { error: { message: failOn[table] } } : { error: null }
  return {
    from(table) {
      return {
        upsert: (row, opts) => {
          writes.push({ table, op: 'upsert', row, opts })
          return Promise.resolve(resultFor(table))
        },
        update: (patch) => {
          const record = (filters) => {
            writes.push({ table, op: 'update', patch, filters })
            return Promise.resolve(resultFor(table))
          }
          const chain = (filters) => ({
            eq: (col, val) => chain({ ...filters, [col]: val }),
            then: (resolve, reject) => record(filters).then(resolve, reject),
          })
          return chain({})
        },
        insert: (row) => {
          writes.push({ table, op: 'insert', row })
          return Promise.resolve(resultFor(table))
        },
        select: () => ({
          or: () => ({ limit: () => Promise.resolve({ data: [{ id: 'c1' }] }) }),
        }),
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyWhatsappConsentKeyword — STOP', () => {
  it('UPSERTS contact_preferences by contact_id so a contact with no row still opts out', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db,
      contact: { id: 'c1' },
      waPhone: '353871234567',
      locationId: 'loc1',
      conversationId: 'conv1',
      keyword: 'stop',
    })
    expect(r).toMatchObject({ applied: true, action: 'opt_out' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(prefWrite.row.updated_at).toBeTruthy()
    expect(prefWrite.opts).toMatchObject({ onConflict: 'contact_id' })
  })

  it('still sets contacts.wa_status and writes the consent_log audit row', async () => {
    const writes = []
    const db = stubDb({ writes })
    await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
    })

    const contactWrite = writes.find(w => w.table === 'contacts')
    expect(contactWrite?.patch).toEqual({ wa_status: 'opted_out' })
    expect(contactWrite?.filters).toEqual({ id: 'c1' })

    const logWrite = writes.find(w => w.table === 'consent_log' && w.op === 'insert')
    expect(logWrite?.row).toMatchObject({
      contact_id: 'c1',
      channel: 'whatsapp_marketing',
      // GAPS-P6: the consent_log vocabulary is opt_out / opt_in. The
      // wa_status assertion two lines up still says 'opted_out' — that is
      // the point: two adjacent columns, two different vocabularies.
      action: 'opt_out',
      source: 'whatsapp_keyword',
    })

    // The ack still goes out (their keyword opened the 24h window).
    expect(sendTextMessage).toHaveBeenCalledWith(
      '353871234567',
      expect.stringContaining('unsubscribed'),
      expect.objectContaining({ locationId: 'loc1' }),
    )
  })

  it('START re-opts in via the same upsert', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'start',
    })
    expect(r).toMatchObject({ applied: true, action: 'opt_in' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: true })
    const contactWrite = writes.find(w => w.table === 'contacts')
    expect(contactWrite?.patch).toEqual({ wa_status: 'active' })
  })

  it('bails without writes on a missing contact or unknown keyword', async () => {
    const writes = []
    const db = stubDb({ writes })
    expect((await applyWhatsappConsentKeyword({ db, contact: null, keyword: 'stop' })).applied).toBe(false)
    expect((await applyWhatsappConsentKeyword({ db, contact: { id: 'c1' }, keyword: 'maybe' })).applied).toBe(false)
    expect(writes).toEqual([])
  })
})

// ── BAREWRITE.4 — A FAILED WRITE MUST NEVER BLOCK ANOTHER SUPPRESSION WRITE ──
//
// Three shapes have now been tried here, and the middle one was the worst:
//
//  main         all three writes bare `await`s inside a try/catch that could
//               not fire for a supabase result. Both suppression writes were
//               ATTEMPTED, but the function returned `applied: true`
//               unconditionally and told the customer "You've been
//               unsubscribed" even when nothing landed.
//  BAREWRITE.1  fixed the false acknowledgement by RETURNING EARLY on the first
//               failed write — so a failed contact_preferences upsert now also
//               skipped the contacts.wa_status write. A half-failing STOP left
//               ZERO suppression where main left ONE. Strictly worse.
//  BAREWRITE.4  attempt every write, collect the failures, then judge.
//
// The property these tests pin is the one that matters: FAILING ONE WRITE MUST
// NEVER COST THE OTHER. Each write is failed independently and the resulting
// suppression state is asserted to be no weaker than main's.
describe('BAREWRITE.4 — one failed consent write never suppresses the others', () => {
  // The two authoritative suppression gates, in the order the function writes
  // them. Each is failed on its own; the OTHER must still be attempted.
  const SUPPRESSION_WRITES = [
    { failing: 'contact_preferences', other: 'contacts' },
    { failing: 'contacts', other: 'contact_preferences' },
  ]

  for (const { failing, other } of SUPPRESSION_WRITES) {
    it(`STOP: a failed ${failing} write still writes ${other} (main's floor, never below it)`, async () => {
      const writes = []
      const db = stubDb({ writes, failOn: { [failing]: 'connection reset' } })
      const r = await applyWhatsappConsentKeyword({
        db, contact: { id: 'c1' }, waPhone: '353871234567',
        locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
      })

      // THE REGRESSION. Under BAREWRITE.1 this write never happened when the
      // first leg failed, leaving the contact suppressed on nothing at all.
      const surviving = writes.find(w => w.table === other)
      expect(surviving, `${other} must still be written when ${failing} fails`).toBeDefined()
      if (other === 'contacts') expect(surviving.patch).toEqual({ wa_status: 'opted_out' })
      else expect(surviving.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })

      // The audit row is attempted too — losing a log line is not a reason to
      // skip the audit trail for the half that DID land.
      expect(writes.find(w => w.table === 'consent_log')).toBeDefined()

      // One gate landed, so the opt-out took effect: acknowledge it, but say
      // loudly that it was only partial.
      expect(r.applied).toBe(true)
      expect(r.partial).toBe(true)
      expect(r.failures.join(' ')).toContain(failing)
      expect(sendTextMessage).toHaveBeenCalled()
    })
  }

  it('STOP: only when BOTH suppression writes fail is nothing acknowledged', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { contact_preferences: 'down', contacts: 'down' } })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
    })

    // Both were still ATTEMPTED — that is the whole point.
    expect(writes.find(w => w.table === 'contact_preferences')).toBeDefined()
    expect(writes.find(w => w.table === 'contacts')).toBeDefined()
    // …and only now, with zero suppression anywhere, is the ack withheld.
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
    expect(r.failures).toHaveLength(2)
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('START: a partial opt-in is NOT acknowledged (the failure direction reverses)', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { contacts: 'deadlock detected' } })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'start',
    })

    // Still attempted both — the flag flipped even though wa_status did not.
    expect(writes.find(w => w.table === 'contact_preferences').row).toMatchObject({ whatsapp_marketing: true })
    expect(writes.find(w => w.table === 'contacts')).toBeDefined()
    // But the contact is still 'opted_out' on the hard gate, so nothing will
    // actually reach them: promising "You're opted back in" would be a lie,
    // and under-claiming is the safe error for an opt-IN.
    expect(r).toMatchObject({ applied: false, reason: 'opt_in_incomplete' })
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('still applies and acknowledges when only the audit row is lost', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { consent_log: 'table locked' } })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
    })

    // Both suppression gates landed — refusing here would leave the customer
    // un-answered on a change that DID take effect.
    expect(r).toMatchObject({ applied: true, action: 'opt_out', partial: true })
    expect(sendTextMessage).toHaveBeenCalled()
  })
})

describe('applyMetaUserPreference — same upsert semantics', () => {
  it('stop upserts the preferences row (contact may have none)', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyMetaUserPreference(db, {
      wa_id: '353871234567', category: 'marketing_messages', value: 'stop',
    })
    expect(r).toMatchObject({ applied: true, action: 'opt_out' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(prefWrite.opts).toMatchObject({ onConflict: 'contact_id' })
  })

  // Same BAREWRITE.4 property as the keyword path — and it holds here for the
  // structural reason that both paths now share ONE helper, so they cannot
  // drift apart again (they already did once: the keyword path grew an upsert
  // while this one kept an update).
  it('a failed wa_status write still writes the preference flag, and reports partial', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { contacts: 'connection reset' } })
    const r = await applyMetaUserPreference(db, {
      wa_id: '353871234567', category: 'marketing_messages', value: 'stop',
    })
    expect(writes.find(w => w.table === 'contact_preferences').row).toMatchObject({ whatsapp_marketing: false })
    expect(writes.find(w => w.table === 'consent_log')).toBeDefined()
    expect(r).toMatchObject({ applied: true, partial: true, contactId: 'c1' })
    expect(r.failures.join(' ')).toContain('contacts.wa_status')
  })

  it('reports applied:false only when NO suppression signal landed', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { contacts: 'down', contact_preferences: 'down' } })
    const r = await applyMetaUserPreference(db, {
      wa_id: '353871234567', category: 'marketing_messages', value: 'stop',
    })
    expect(writes.find(w => w.table === 'contact_preferences')).toBeDefined()
    expect(writes.find(w => w.table === 'contacts')).toBeDefined()
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
  })
})
