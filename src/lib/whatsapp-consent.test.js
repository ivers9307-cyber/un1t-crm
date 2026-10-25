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
vi.mock('./log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
import { logError } from './log'
import { applyWhatsappConsentKeyword, applyMetaUserPreference, consentAckText } from './whatsapp-consent.js'

vi.mock('./whatsapp', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.ack' }),
}))

import { sendTextMessage } from './whatsapp'

// Chainable stub that records every write. Every builder resolves when
// awaited (the code awaits the builder), after any .select/.eq/.or/.limit.
//
// `failOn` is a { table | 'table.op': message } map — a resolved `{ error }`,
// which is what supabase-js actually does. It never throws, on purpose: the
// writes here used to sit in a try/catch that could not fire, which is exactly
// how a failed opt-out kept returning `applied: true`.
//
// contact_location_preferences is modelled as a set of `contact|location` keys:
// an ignoreDuplicates upsert returns the row only when it CREATED it, and an
// update returns the rows it matched (a zero-row UPDATE is not an error).
// An update filtered `.in('contact_id', ids)` (WAORGNUMBER.3b's same-number
// close) returns the listed rows that exist and are not in `closedRows`.
// `orgLocations` answers the organisation read (`.eq('organization_id', …)`).
function stubDb({ writes, failOn = {}, studioRows = [], closedRows = [], location = null, locationError = null, orgLocations = [], inScopes = [], contacts = [{ id: 'c1' }] }) {
  const rowsAt = new Set(studioRows)
  const closed = new Set(closedRows)
  const errorFor = (table, op) => {
    const msg = failOn[`${table}.${op}`] ?? failOn[table]
    return msg ? { message: msg } : null
  }
  return {
    from(table) {
      const q = { op: 'select', filters: {} }
      const run = () => {
        if (q.op === 'select') {
          if (table === 'locations' && q.filters.organization_id) return { data: orgLocations.filter((id) => id !== q.filters.id).map((id) => ({ id })), error: null }
          if (table === 'locations') return { data: locationError ? null : location, error: locationError }
          if (table === 'contacts') return failOn['contacts.select'] ? { data: null, error: { message: failOn['contacts.select'] } } : { data: q.range ? contacts.slice(q.range[0], q.range[1] + 1) : contacts, error: null }
          return { data: [{ id: 'c1' }], error: null }
        }
        const entry = { table, op: q.op, filters: q.filters }
        if (q.row) entry.row = q.row
        if (q.opts) entry.opts = q.opts
        if (q.patch) entry.patch = q.patch
        writes.push(entry)
        const error = errorFor(table, q.op)
        if (error) return { data: null, error }
        if (table === 'contact_location_preferences') {
          if (q.op === 'upsert') {
            const key = `${q.row.contact_id}|${q.row.location_id}`
            if (rowsAt.has(key)) return { data: [], error: null }
            rowsAt.add(key)
            return { data: [{ contact_id: q.row.contact_id }], error: null }
          }
          if (q.op === 'update' && Array.isArray(q.filters.contact_id)) {
            const hit = q.filters.contact_id.filter((id) => rowsAt.has(`${id}|${q.filters.location_id}`) && !closed.has(`${id}|${q.filters.location_id}`))
            for (const id of hit) closed.add(`${id}|${q.filters.location_id}`)
            return { data: hit.map((id) => ({ contact_id: id })), error: null }
          }
          if (q.op === 'update') {
            const key = `${q.filters.contact_id}|${q.filters.location_id}`
            return { data: rowsAt.has(key) ? [{ contact_id: q.filters.contact_id }] : [], error: null }
          }
        }
        return { data: null, error: null }
      }
      Object.assign(q, {
        upsert(row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return q },
        insert(row) { q.op = 'insert'; q.row = row; return q },
        update(patch) { q.op = 'update'; q.patch = patch; return q },
        select() { return q },
        eq(col, val) { q.filters = { ...q.filters, [col]: val }; return q },
        or() { return q },
        in(col, ids) { inScopes.push([table, col, ids]); q.filters = { ...q.filters, [col]: ids }; return q },
        neq(col, val) { if (col === 'id') q.filters = { ...q.filters, id: val }; return q },
        order() { return q },
        range(from, to) { q.range = [from, to]; return q },
        limit() { return q },
        maybeSingle() { return Promise.resolve(run()) },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
      })
      return q
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// These pin the CONTACT-WIDE path, which since WAORGNUMBER.3 runs only when
// the keyword arrives with no studio (locationId null; Review Focus 3: exactly
// today's three writes). The studio path is pinned further down.
describe('applyWhatsappConsentKeyword — STOP, no studio (contact-wide)', () => {
  it('UPSERTS contact_preferences by contact_id so a contact with no row still opts out', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db,
      contact: { id: 'c1' },
      waPhone: '353871234567',
      locationId: null,
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
      locationId: null, conversationId: 'conv1', keyword: 'stop',
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
      expect.objectContaining({ locationId: null, replyInConversation: 'conv1' }),
    )
  })

  it('START re-opts in via the same upsert', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: null, conversationId: 'conv1', keyword: 'start',
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
        locationId: null, conversationId: 'conv1', keyword: 'stop',
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
      locationId: null, conversationId: 'conv1', keyword: 'stop',
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
      locationId: null, conversationId: 'conv1', keyword: 'start',
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
      locationId: null, conversationId: 'conv1', keyword: 'stop',
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
    }, 'loc1')
    expect(r).toMatchObject({ applied: true, action: 'opt_out' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(prefWrite.opts).toMatchObject({ onConflict: 'contact_id' })
  })

  // Same BAREWRITE.4 property as the keyword path, and it holds here because
  // both paths run the one `applyConsentWrites` helper. Note the two paths had
  // NOT previously drifted — 85afb1c0 moved both to `.upsert` in one commit —
  // so the helper is not a repair, it is insurance on a judgement (STOP needs
  // EITHER gate, START needs BOTH) that is too easy to get wrong twice.
  it('a failed wa_status write still writes the preference flag, and reports partial', async () => {
    const writes = []
    const db = stubDb({ writes, failOn: { contacts: 'connection reset' } })
    const r = await applyMetaUserPreference(db, {
      wa_id: '353871234567', category: 'marketing_messages', value: 'stop',
    }, 'loc1')
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
    }, 'loc1')
    expect(writes.find(w => w.table === 'contact_preferences')).toBeDefined()
    expect(writes.find(w => w.table === 'contacts')).toBeDefined()
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
  })

  // WAORGNUMBER.3 (R6) — the lookup is bounded to the receiving number's organisation.
  it('looks the contact up ONLY within the receiving studio\'s organisation (never estate-wide)', async () => {
    const inScopes = []
    const db = stubDb({ writes: [], inScopes })
    await applyMetaUserPreference(db, { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(inScopes).toEqual([['contacts', 'location_id', ['loc1']]])
  })

  it('an opt-OUT reaches EVERY matching contact in the organisation, not the first', async () => {
    const writes = []
    const db = stubDb({ writes, contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(r).toMatchObject({ applied: true, action: 'opt_out', contactIds: ['c1', 'c2', 'c3'] })
    expect(writes.filter((w) => w.table === 'contact_preferences').map((w) => w.row.contact_id)).toEqual(['c1', 'c2', 'c3'])
    expect(writes.filter((w) => w.table === 'contact_location_preferences').map((w) => w.filters.contact_id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('paginates past the 1,000-row cap', async () => {
    const writes = []
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}` }))
    const r = await applyMetaUserPreference(stubDb({ writes, contacts: many }), { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(r.contactIds).toHaveLength(1001)
    expect(writes.filter((w) => w.table === 'contact_preferences')).toHaveLength(1001)
  })

  it('one contact failing entirely does not drop the others: applied, partial, failures named', async () => {
    const writes = []
    // 'contacts' + 'contact_preferences' down for every contact => nothing lands anywhere
    const none = await applyMetaUserPreference(stubDb({ writes: [], failOn: { contacts: 'down', contact_preferences: 'down' }, contacts: [{ id: 'c1' }, { id: 'c2' }] }), { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(none).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
    const some = await applyMetaUserPreference(stubDb({ writes, failOn: { contacts: 'blip' }, contacts: [{ id: 'c1' }, { id: 'c2' }] }), { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(some).toMatchObject({ applied: true, partial: true, contactIds: ['c1', 'c2'] })
  })

  it('a failed contact read applies nothing and says so (never "no contact")', async () => {
    const writes = []
    const r = await applyMetaUserPreference(stubDb({ writes, failOn: { 'contacts.select': 'timeout' } }), { wa_id: '353871234567', value: 'stop' }, 'loc1')
    expect(r).toMatchObject({ applied: false, reason: 'contact_read_failed' })
    expect(writes).toEqual([])
  })

  it('an opt-OUT with an UNRESOLVED studio is applied to every contact with the number (unscoped) and logged', async () => {
    const writes = []
    const inScopes = []
    const db = stubDb({ writes, inScopes, contacts: [{ id: 'c1' }, { id: 'other-org' }] })
    const r = await applyMetaUserPreference(db, { wa_id: '353871234567', value: 'stop' })
    expect(r).toMatchObject({ applied: true, action: 'opt_out', contactIds: ['c1', 'other-org'] })
    expect(inScopes).toEqual([]) // no location filter at all
    expect(writes.filter((w) => w.table === 'contact_preferences')).toHaveLength(2)
    expect(logError).toHaveBeenCalledWith('wa-consent', expect.stringContaining('unresolved receiving studio'), expect.objectContaining({ waId: '353871234567' }))
  })

  it('an opt-IN with an unresolved studio is NOT applied: nothing read, nothing written', async () => {
    const writes = []
    const inScopes = []
    const r = await applyMetaUserPreference(stubDb({ writes, inScopes }), { wa_id: '353871234567', value: 'resume' })
    expect(r).toMatchObject({ applied: false, reason: 'no_receiving_studio' })
    expect(writes).toEqual([])
    expect(inScopes).toEqual([])
  })
})

// WACONFIGFALLBACK.1 — the STOP acknowledgement at a location whose number has
// gone (the keyword arrived on it, then it was removed). The ack used to go out
// on the global env number; the resolver now refuses. The opt-out itself MUST
// still land in full (the louder-failure rule: losing the suppression would be
// far worse than losing the ack), and the ack is simply skipped and logged.
describe('WACONFIGFALLBACK.1 — STOP ack refused for a missing number', () => {
  it('opt-out still applied in full; no ack row recorded; never throws', async () => {
    const { WhatsAppNumberMissingError } = await import('./whatsapp-number-missing.js')
    sendTextMessage.mockRejectedValueOnce(new WhatsAppNumberMissingError('loc1'))
    const writes = []
    const r = await applyWhatsappConsentKeyword({
      db: stubDb({ writes }), contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
    })
    expect(r).toMatchObject({ applied: true, action: 'opt_out' })
    expect(writes.some((w) => w.table === 'contact_location_preferences')).toBe(true)
    expect(writes.some((w) => w.table === 'whatsapp_messages')).toBe(false)
  })
})

// ── WAORGNUMBER.3 (R6) — STOP and START act at the studio whose thread they ──
// arrive in. One number can be switched on at two studios: STOP in a Hatch
// Street thread stops Hatch Street, not Stillorgan. Nothing contact-wide is
// written, because the mig 489/543 trigger fans a contact-wide false out to
// every studio's row.
describe('WAORGNUMBER.3 — the keyword writes the thread studio\'s row', () => {
  const HATCH = 'loc-hatch'
  const hatch = { name: 'UN1T Hatch Street', settings: {} }
  const keywordAt = (db, keyword, locationId = HATCH) => applyWhatsappConsentKeyword({
    db, contact: { id: 'c1' }, waPhone: '353871234567', locationId, conversationId: 'conv1', keyword,
  })

  it('STOP at Hatch writes only Hatch\'s row and a located log row', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, studioRows: ['c1|loc-hatch'], location: hatch }), 'stop')
    expect(r).toEqual({ applied: true, action: 'opt_out' })

    // Nothing contact-wide: no contact_preferences write (it would fan out to
    // every studio) and no contacts.wa_status.
    expect(writes.some((w) => w.table === 'contact_preferences')).toBe(false)
    expect(writes.some((w) => w.table === 'contacts')).toBe(false)

    const studio = writes.filter((w) => w.table === 'contact_location_preferences')
    // The row exists, so the create-if-missing is a no-op and the update flips
    // ONLY WhatsApp, at Hatch only.
    expect(studio[0]).toMatchObject({ op: 'upsert', opts: { onConflict: 'contact_id,location_id', ignoreDuplicates: true } })
    expect(studio[1]).toMatchObject({ op: 'update', filters: { contact_id: 'c1', location_id: HATCH } })
    expect(Object.keys(studio[1].patch).sort()).toEqual(['updated_at', 'whatsapp_marketing'])
    expect(studio[1].patch.whatsapp_marketing).toBe(false)

    const log = writes.find((w) => w.table === 'consent_log')
    expect(log.row).toEqual({
      contact_id: 'c1', channel: 'whatsapp_marketing', action: 'opt_out', source: 'whatsapp_keyword', location_id: HATCH,
    })
  })

  it('STOP at a studio with no row creates it with WhatsApp, email and SMS all OFF', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, location: hatch }), 'stop')
    expect(r).toEqual({ applied: true, action: 'opt_out' })
    const created = writes.find((w) => w.table === 'contact_location_preferences' && w.op === 'upsert')
    // The table's channels default TRUE (creating the row is the opt-in act),
    // so a row naming only WhatsApp would OPEN email and SMS here.
    expect(created.row).toMatchObject({
      contact_id: 'c1', location_id: HATCH,
      whatsapp_marketing: false, email_marketing: false, sms_marketing: false,
      source: 'whatsapp_keyword',
    })
    expect(created.row.unsubscribed_at).toBeTruthy()
    // Created, so no second write.
    expect(writes.filter((w) => w.table === 'contact_location_preferences')).toHaveLength(1)
  })

  it('START at Hatch upserts the row to true', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, location: hatch }), 'start')
    expect(r).toEqual({ applied: true, action: 'opt_in' })
    const created = writes.find((w) => w.table === 'contact_location_preferences' && w.op === 'upsert')
    expect(created.row).toMatchObject({
      contact_id: 'c1', location_id: HATCH, whatsapp_marketing: true, source: 'whatsapp_keyword',
      // A WhatsApp START is not consent to email or SMS at the studio.
      email_marketing: false, sms_marketing: false, unsubscribed_at: null,
    })
    expect(created.row.subscribed_at).toBeTruthy()
    expect(writes.some((w) => w.table === 'contact_preferences')).toBe(false)
    expect(writes.find((w) => w.table === 'consent_log').row).toMatchObject({ action: 'opt_in', location_id: HATCH })
  })

  // Ruling on the historic contact-wide STOP: wa_status 'opted_out' blocks every
  // WhatsApp send, so a studio START that left it would be acknowledged and
  // change nothing. The member asked to resume, so the START lifts it.
  it('START at a studio lifts a historic wa_status opted_out, and only opted_out', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, location: hatch }), 'start')
    expect(r).toEqual({ applied: true, action: 'opt_in' })
    const lift = writes.filter((w) => w.table === 'contacts')
    expect(lift).toHaveLength(1)
    expect(lift[0]).toMatchObject({ op: 'update', patch: { wa_status: 'active' } })
    // Guarded on the value: 'blocked' / 'undeliverable' rows match nothing.
    expect(lift[0].filters).toEqual({ id: 'c1', wa_status: 'opted_out' })
  })

  it('STOP at a studio never touches wa_status', async () => {
    const writes = []
    await keywordAt(stubDb({ writes, location: hatch }), 'stop')
    expect(writes.some((w) => w.table === 'contacts')).toBe(false)
  })

  it('a failed lift fails the START (still blocked everywhere): no ack', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, failOn: { contacts: 'deadlock detected' }, location: hatch }), 'start')
    expect(writes.find((w) => w.table === 'contact_location_preferences').row).toMatchObject({ whatsapp_marketing: true })
    expect(r).toMatchObject({ applied: false, reason: 'opt_in_incomplete' })
    expect(r.failures.join(' ')).toContain('contacts.wa_status (lift opted_out)')
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('no lift when the studio row did not land (an opt-in never widens on a failed write)', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, failOn: { contact_location_preferences: 'down' }, location: hatch }), 'start')
    expect(r).toMatchObject({ applied: false, reason: 'opt_in_incomplete' })
    expect(writes.some((w) => w.table === 'contacts')).toBe(false)
  })

  it('START on an existing row flips only WhatsApp back on', async () => {
    const writes = []
    await keywordAt(stubDb({ writes, studioRows: ['c1|loc-hatch'], location: hatch }), 'start')
    const update = writes.find((w) => w.table === 'contact_location_preferences' && w.op === 'update')
    expect(update.patch).toMatchObject({ whatsapp_marketing: true })
    expect(Object.keys(update.patch).sort()).toEqual(['updated_at', 'whatsapp_marketing'])
  })

  it('STOP with no location keeps the contact-wide writes', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes }), 'stop', null)
    expect(r).toEqual({ applied: true, action: 'opt_out' })
    // The three consent writes, then the ack's two thread writes.
    expect(writes.map((w) => `${w.table}.${w.op}`)).toEqual([
      'contact_preferences.upsert', 'contact_location_preferences.update', 'contacts.update', 'consent_log.insert',
      'whatsapp_messages.insert', 'whatsapp_conversations.update',
    ])
    expect(writes[0].row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(writes[0].opts).toEqual({ onConflict: 'contact_id' })
    // R17 — every studio row of the contact is closed too (rows still true only).
    expect(writes[1].patch).toMatchObject({ whatsapp_marketing: false })
    expect(writes[1].filters).toMatchObject({ contact_id: 'c1', whatsapp_marketing: true })
    expect(writes[1].filters).not.toHaveProperty('location_id')
    expect(writes[2].patch).toEqual({ wa_status: 'opted_out' })
    expect(writes[3].row).not.toHaveProperty('location_id')
    expect(sendTextMessage).toHaveBeenCalledWith('353871234567', expect.stringContaining('unsubscribed'), expect.anything())
  })

  it('failed studio upsert → applied:false, no ack', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, failOn: { contact_location_preferences: 'connection reset' }, location: hatch }), 'stop')
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
    expect(r.failures.join(' ')).toContain('contact_location_preferences')
    expect(sendTextMessage).not.toHaveBeenCalled()
    // Still nothing contact-wide: a failure here must not widen the STOP.
    expect(writes.some((w) => w.table === 'contact_preferences' || w.table === 'contacts')).toBe(false)
  })

  it('a failed create still attempts the update; when the update lands the create error is not a failure', async () => {
    const writes = []
    const r = await keywordAt(stubDb({
      writes, studioRows: ['c1|loc-hatch'], failOn: { 'contact_location_preferences.upsert': 'deadlock detected' }, location: hatch,
    }), 'stop')
    expect(writes.find((w) => w.table === 'contact_location_preferences' && w.op === 'update')).toBeDefined()
    // End state is correct (the row is closed): clean apply, no partial, no failure to report.
    expect(r).toEqual({ applied: true, action: 'opt_out' })
    expect(sendTextMessage).toHaveBeenCalled()
  })

  it('a failed create AND a failed update: both are reported and the STOP is refused', async () => {
    const writes = []
    const r = await keywordAt(stubDb({
      writes, failOn: { contact_location_preferences: 'down' }, location: hatch,
    }), 'stop')
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
    expect(r.failures.join(' ')).toContain('(create)')
    expect(r.failures.join(' ')).toContain('contact_location_preferences.whatsapp_marketing')
  })

  it('contact-wide STOP: a failed studio-rows write is counted in failures (partial) but does not refuse the STOP', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, failOn: { 'contact_location_preferences.update': 'timeout' } }), 'stop', null)
    expect(r).toMatchObject({ applied: true, action: 'opt_out', partial: true })
    expect(r.failures.join(' ')).toContain('all studios')
  })

  it('contact-wide START never re-opens a studio row', async () => {
    const writes = []
    await keywordAt(stubDb({ writes }), 'start', null)
    expect(writes.some((w) => w.table === 'contact_location_preferences')).toBe(false)
  })

  it('START whose update touches no row is not acknowledged', async () => {
    // The create reported no row created (a concurrent insert, say) and the
    // update then matched nothing: the opt-in did not land.
    const writes = []
    const db = stubDb({ writes, failOn: { 'contact_location_preferences.upsert': 'timeout' }, location: hatch })
    const r = await keywordAt(db, 'start')
    expect(r).toMatchObject({ applied: false, reason: 'opt_in_incomplete' })
    expect(r.failures.join(' ')).toContain('no row at this studio was changed')
    expect(sendTextMessage).not.toHaveBeenCalled()
  })

  it('a lost audit row still applies and acknowledges', async () => {
    const writes = []
    const r = await keywordAt(stubDb({ writes, failOn: { consent_log: 'table locked' }, location: hatch }), 'stop')
    expect(r).toMatchObject({ applied: true, action: 'opt_out', partial: true })
    expect(sendTextMessage).toHaveBeenCalled()
  })

  it('ack names the studio and honours the operator copy', async () => {
    await keywordAt(stubDb({ writes: [], location: hatch }), 'stop')
    expect(sendTextMessage).toHaveBeenLastCalledWith(
      '353871234567',
      "You won't get WhatsApp marketing from UN1T Hatch Street any more. Reply START to opt back in.",
      expect.objectContaining({ locationId: HATCH, replyInConversation: 'conv1' }),
    )

    await keywordAt(stubDb({ writes: [], location: hatch }), 'start')
    expect(sendTextMessage).toHaveBeenLastCalledWith(
      '353871234567',
      "You're back on WhatsApp messages from UN1T Hatch Street. Reply STOP to opt out.",
      expect.anything(),
    )

    const custom = { name: 'UN1T Hatch Street', settings: { whatsapp_consent_copy: { stop_ack: 'Done. {studio} will not message you. Text START to undo.' } } }
    const writes = []
    await keywordAt(stubDb({ writes, location: custom }), 'stop')
    expect(sendTextMessage).toHaveBeenLastCalledWith('353871234567', 'Done. UN1T Hatch Street will not message you. Text START to undo.', expect.anything())
    // The thread records the text that was actually sent.
    expect(writes.find((w) => w.table === 'whatsapp_messages').row.body).toBe('Done. UN1T Hatch Street will not message you. Text START to undo.')
  })

  it('an unreadable studio still gets the default ack (the change already landed)', async () => {
    await keywordAt(stubDb({ writes: [], locationError: { message: 'boom' } }), 'stop')
    expect(sendTextMessage).toHaveBeenLastCalledWith(
      '353871234567',
      "You won't get WhatsApp marketing from us any more. Reply START to opt back in.",
      expect.anything(),
    )
  })
})

// WAORGNUMBER.3b — live 18 Oct 2026: seven contacts shared one phone. The STOP
// in a Hatch thread was written to a Stillorgan contact sharing the phone while
// the thread's own contact stayed opted in at Hatch. The webhook now passes the
// thread's contact; here, a studio STOP also closes that studio's EXISTING open
// row for every other same-phone contact in the organisation.
describe('WAORGNUMBER.3b — a studio STOP reaches every contact sharing the number', () => {
  const HATCH = 'loc-hatch'
  const STILL = 'loc-still'
  const hatch = { name: 'UN1T Hatch Street', settings: {}, organization_id: 'org-1' }
  const dupes = [{ id: 'c-doe' }, { id: 'c-ivers-1' }, { id: 'c-ivers-2' }, { id: 'c-ivers-3' }]
  const keywordAt = (db, keyword, extra = {}) => applyWhatsappConsentKeyword({
    db, contact: { id: 'c-doe' }, waPhone: '353870000001', locationId: HATCH, conversationId: 'conv-hatch', keyword, ...extra,
  })
  const sameNumberCloses = (writes) => writes.filter((w) => w.table === 'contact_location_preferences' && w.op === 'update' && Array.isArray(w.filters.contact_id))

  it('closes Hatch\'s open row for every other same-phone contact; creates a row only for the thread contact', async () => {
    const writes = []
    const inScopes = []
    const db = stubDb({
      writes, inScopes, location: hatch, orgLocations: [HATCH, STILL], contacts: dupes,
      // Doe has no Hatch row yet; Ivers-1 has an open one, Ivers-2 an already
      // closed one, Ivers-3 none at Hatch (only Stillorgan's).
      studioRows: ['c-ivers-1|loc-hatch', 'c-ivers-2|loc-hatch', 'c-ivers-3|loc-still'],
      closedRows: ['c-ivers-2|loc-hatch'],
    })
    const r = await keywordAt(db, 'stop')
    expect(r).toEqual({ applied: true, action: 'opt_out' })

    // The thread contact's row is created (WhatsApp, email, SMS off); nobody else's.
    const creates = writes.filter((w) => w.table === 'contact_location_preferences' && w.op === 'upsert')
    expect(creates).toHaveLength(1)
    expect(creates[0].row).toMatchObject({ contact_id: 'c-doe', location_id: HATCH, whatsapp_marketing: false })

    // The same-number contacts are read within the organisation, not estate-wide.
    expect(inScopes).toContainEqual(['contacts', 'location_id', [HATCH, STILL]])

    // One update at Hatch for the OTHER contacts, only open rows, WhatsApp only.
    const closes = sameNumberCloses(writes)
    expect(closes).toHaveLength(1)
    expect(closes[0].filters).toMatchObject({ location_id: HATCH, whatsapp_marketing: true })
    expect(closes[0].filters.contact_id.sort()).toEqual(['c-ivers-1', 'c-ivers-2', 'c-ivers-3'])
    expect(Object.keys(closes[0].patch).sort()).toEqual(['updated_at', 'whatsapp_marketing'])
    expect(closes[0].patch.whatsapp_marketing).toBe(false)

    // Audit rows: the thread contact's, plus one per row that actually closed.
    const logs = writes.filter((w) => w.table === 'consent_log').flatMap((w) => [].concat(w.row))
    expect(logs).toEqual([
      { contact_id: 'c-doe', channel: 'whatsapp_marketing', action: 'opt_out', source: 'whatsapp_keyword', location_id: HATCH },
      { contact_id: 'c-ivers-1', channel: 'whatsapp_marketing', action: 'opt_out', source: 'whatsapp_keyword', location_id: HATCH },
    ])

    // Nothing contact-wide, and the ack goes out.
    expect(writes.some((w) => w.table === 'contact_preferences' || w.table === 'contacts')).toBe(false)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })

  it('a failed same-number close never fails the STOP: applied, acknowledged, partial and logged', async () => {
    const writes = []
    const db = stubDb({
      writes, location: hatch, orgLocations: [HATCH, STILL], contacts: dupes,
      // Doe's row is CREATED (an upsert), so only the same-number UPDATE fails.
      failOn: { 'contact_location_preferences.update': 'statement timeout' },
    })
    const r = await keywordAt(db, 'stop')
    expect(r).toMatchObject({ applied: true, action: 'opt_out', partial: true })
    expect(r.failures.join(' ')).toMatch(/same number.*statement timeout/)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('wa-consent', 'consent write(s) failed', expect.objectContaining({ prefOk: true, suppressed: true }))
  })

  it('a failed same-number read never fails the STOP either', async () => {
    const writes = []
    const db = stubDb({ writes, location: hatch, orgLocations: [HATCH, STILL], failOn: { 'contacts.select': 'connection reset' } })
    const r = await keywordAt(db, 'stop')
    expect(r).toMatchObject({ applied: true, partial: true })
    expect(r.failures.join(' ')).toMatch(/contacts \(same number\): connection reset/)
    expect(sameNumberCloses(writes)).toHaveLength(0)
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
  })

  it('the ack is sent only when the THREAD contact\'s row landed, even if the others closed', async () => {
    const writes = []
    const db = stubDb({
      writes, location: hatch, orgLocations: [HATCH, STILL], contacts: dupes,
      // Doe's create fails and Doe has no row to update; Ivers-1's row is open.
      failOn: { 'contact_location_preferences.upsert': 'deadlock detected' },
      studioRows: ['c-ivers-1|loc-hatch'],
    })
    const r = await keywordAt(db, 'stop')
    expect(r).toMatchObject({ applied: false, reason: 'no_suppression_signal_landed' })
    expect(sendTextMessage).not.toHaveBeenCalled()
    // ...but every suppression write was still attempted: Ivers-1 is closed.
    const closes = sameNumberCloses(writes)
    expect(closes).toHaveLength(1)
    const logs = writes.filter((w) => w.table === 'consent_log').flatMap((w) => [].concat(w.row))
    expect(logs.map((l) => l.contact_id)).toContain('c-ivers-1')
  })

  it('START re-opens ONLY the thread contact\'s row: no same-number read, no other row touched', async () => {
    const writes = []
    const inScopes = []
    const db = stubDb({ writes, inScopes, location: hatch, orgLocations: [HATCH, STILL], contacts: dupes, studioRows: ['c-doe|loc-hatch', 'c-ivers-1|loc-hatch'] })
    const r = await keywordAt(db, 'start')
    expect(r).toEqual({ applied: true, action: 'opt_in' })
    expect(sameNumberCloses(writes)).toHaveLength(0)
    expect(inScopes.some(([t]) => t === 'contacts')).toBe(false)
    const studio = writes.filter((w) => w.table === 'contact_location_preferences')
    expect(studio.every((w) => (w.row?.contact_id ?? w.filters.contact_id) === 'c-doe')).toBe(true)
  })

  it('the thread contact itself is never in the same-number close (its row is written as asked)', async () => {
    const writes = []
    const db = stubDb({ writes, location: hatch, orgLocations: [HATCH], contacts: [{ id: 'c-doe' }], studioRows: ['c-doe|loc-hatch'] })
    const r = await keywordAt(db, 'stop')
    expect(r).toEqual({ applied: true, action: 'opt_out' })
    expect(sameNumberCloses(writes)).toHaveLength(0)
  })

  it('closes in chunks of 100 contacts, every chunk checked', async () => {
    const writes = []
    const many = [{ id: 'c-doe' }, ...Array.from({ length: 150 }, (_, i) => ({ id: `c-${i}` }))]
    const db = stubDb({ writes, location: hatch, orgLocations: [HATCH], contacts: many })
    await keywordAt(db, 'stop')
    expect(sameNumberCloses(writes).map((w) => w.filters.contact_id.length)).toEqual([100, 50])
  })

  it('without the sender\'s number nothing else is read; the thread contact\'s STOP stands', async () => {
    const writes = []
    const inScopes = []
    const db = stubDb({ writes, inScopes, location: hatch, orgLocations: [HATCH], contacts: dupes })
    const r = await keywordAt(db, 'stop', { waPhone: null })
    expect(r).toEqual({ applied: true, action: 'opt_out' })
    expect(inScopes.some(([t]) => t === 'contacts')).toBe(false)
    expect(sameNumberCloses(writes)).toHaveLength(0)
  })
})

describe('consentAckText', () => {
  it('uses the defaults, replacing every {studio}', () => {
    expect(consentAckText({ name: 'UN1T Stillorgan', settings: null }, true))
      .toBe("You won't get WhatsApp marketing from UN1T Stillorgan any more. Reply START to opt back in.")
    expect(consentAckText({ name: 'A', settings: { whatsapp_consent_copy: { start_ack: '{studio} {studio}' } } }, false)).toBe('A A')
  })

  it('a blank saved copy falls back to the default', () => {
    expect(consentAckText({ name: 'A', settings: { whatsapp_consent_copy: { stop_ack: '   ' } } }, true))
      .toBe("You won't get WhatsApp marketing from A any more. Reply START to opt back in.")
  })

  it('the defaults carry no em-dash (customer copy rule)', () => {
    expect(consentAckText({ name: 'A' }, true)).not.toMatch(/\u2014/)
    expect(consentAckText({ name: 'A' }, false)).not.toMatch(/\u2014/)
  })
})
