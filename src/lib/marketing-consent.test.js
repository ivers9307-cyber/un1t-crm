import { describe, it, expect } from 'vitest'
import { applyFormMarketingConsent } from './marketing-consent'

// LOCCOMMS.2 — applyFormMarketingConsent must record consent at the location
// the FORM belongs to, which is frequently NOT the location the contact is
// filed under. A Stillorgan member joining the Hatch Street waitlist needs a
// row at Hatch; the mig 489 sync triggers deliberately never create that,
// because a global preference change is not evidence of joining a list.

function makeDb({ contact, prefs = null }) {
  const calls = { prefUpserts: [], locUpserts: [], consentLog: [], contactUpdates: [] }

  const table = (name) => {
    const api = {
      select() { return api },
      eq() { return api },
      maybeSingle: async () => {
        if (name === 'contacts') return { data: contact, error: null }
        if (name === 'contact_preferences') return { data: prefs, error: null }
        return { data: null, error: null }
      },
      upsert(row) {
        if (name === 'contact_preferences') calls.prefUpserts.push(row)
        if (name === 'contact_location_preferences') calls.locUpserts.push(row)
        return Promise.resolve({ error: null })
      },
      insert(rows) {
        if (name === 'consent_log') calls.consentLog.push(...[].concat(rows))
        return Promise.resolve({ error: null })
      },
      update(row) {
        if (name === 'contacts') calls.contactUpdates.push(row)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
    return api
  }

  return { db: { from: table }, calls }
}

const STILLORGAN = 'loc-stillorgan'
const HATCH = 'loc-hatch'

describe('applyFormMarketingConsent — per-location capture (LOCCOMMS.2)', () => {
  it('records consent at the FORM location, not the contact location', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c1', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    await applyFormMarketingConsent(db, {
      contactId: 'c1', consent: true, source: 'waitlist_form', locationId: HATCH,
    })

    expect(calls.locUpserts).toHaveLength(1)
    expect(calls.locUpserts[0]).toMatchObject({
      contact_id: 'c1', location_id: HATCH,
      email_marketing: true, sms_marketing: true, whatsapp_marketing: true,
    })
    // Must NOT have written a row at the contact's own location.
    expect(calls.locUpserts.some((r) => r.location_id === STILLORGAN)).toBe(false)
  })

  it('writes the location row even when global preferences are ALREADY correct', async () => {
    // THE regression this test exists for. Someone already opted in globally
    // joins a new location's list: `changed` is empty, so the function's early
    // return fires. If the location write sits after that return, the person
    // joins the list and nothing records it — the row never exists, and
    // row-absent means that location may never send to them.
    const { db, calls } = makeDb({
      contact: { id: 'c2', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    const res = await applyFormMarketingConsent(db, {
      contactId: 'c2', consent: true, source: 'waitlist_form', locationId: HATCH,
    })

    expect(res.ok).toBe(true)
    expect(calls.prefUpserts).toHaveLength(0)   // nothing to change globally
    expect(calls.locUpserts).toHaveLength(1)    // but the join MUST be recorded
    expect(calls.locUpserts[0]).toMatchObject({ location_id: HATCH, email_marketing: true })
  })

  it('records an opt-OUT at the form location too', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c3', location_id: HATCH, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    await applyFormMarketingConsent(db, {
      contactId: 'c3', consent: false, source: 'event_form', locationId: HATCH,
    })

    expect(calls.locUpserts[0]).toMatchObject({
      location_id: HATCH,
      email_marketing: false, sms_marketing: false, whatsapp_marketing: false,
    })
  })

  it('is unchanged when no locationId is supplied', async () => {
    // Back-compat: callers that have not been updated keep working and write
    // only the global row.
    const { db, calls } = makeDb({
      contact: { id: 'c4', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    const res = await applyFormMarketingConsent(db, {
      contactId: 'c4', consent: true, source: 'booking_form',
    })

    expect(res.ok).toBe(true)
    expect(calls.locUpserts).toHaveLength(0)
    expect(calls.prefUpserts).toHaveLength(1)
  })

  it('still short-circuits ClassPass contacts without writing a location row', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c5', location_id: HATCH, email_status: 'active', glofox_membership_status: 'classpass_payg' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    const res = await applyFormMarketingConsent(db, {
      contactId: 'c5', consent: true, source: 'waitlist_form', locationId: HATCH,
    })

    expect(res.skipped).toBe('classpass')
    expect(calls.locUpserts).toHaveLength(0)
    expect(calls.prefUpserts).toHaveLength(0)
  })
})
