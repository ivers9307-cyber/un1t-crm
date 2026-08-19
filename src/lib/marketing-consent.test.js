import { describe, it, expect } from 'vitest'
import { applyFormMarketingConsent, applyMarketingPreferencesBulk } from './marketing-consent'

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

// Mig 492 retired email_status='unsubscribed': the column carries REPUTATION
// ONLY (active | bounced | complained), and consent lives per-location in
// contact_location_preferences. LOCCOMMS.5 swept every sibling path but missed
// the two writers in this file, which kept re-minting the value — and the
// hard suppressors reading it recreated the cross-location over-blocking the
// migration removed. Mig 501 adds a CHECK so the value cannot return; these
// tests pin the writers so the code never tries.
describe('email_status mirror — reputation only, opt-out never writes it (mig 492/501)', () => {
  it('form opt-out leaves contacts.email_status untouched', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c10', location_id: HATCH, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    const res = await applyFormMarketingConsent(db, {
      contactId: 'c10', consent: false, source: 'event_form', locationId: HATCH,
    })

    expect(res.ok).toBe(true)
    expect(res.changed).toContain('email_marketing')
    // The opt-out is recorded in contact_location_preferences + contact_preferences
    // above; email_status is not consent and must not move.
    expect(calls.contactUpdates).toHaveLength(0)
  })

  it('form opt-in normalises a legacy NULL email_status to active', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c11', location_id: HATCH, email_status: null },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    await applyFormMarketingConsent(db, {
      contactId: 'c11', consent: true, source: 'booking_form',
    })

    expect(calls.contactUpdates).toEqual([{ email_status: 'active' }])
  })

  it('form opt-in repairs a re-minted unsubscribed row to active (deploy-gap residue)', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c12', location_id: HATCH, email_status: 'unsubscribed' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    await applyFormMarketingConsent(db, {
      contactId: 'c12', consent: true, source: 'booking_form',
    })

    expect(calls.contactUpdates).toEqual([{ email_status: 'active' }])
  })

  it('form opt-in never clears bounced / complained (reputation guard)', async () => {
    for (const email_status of ['bounced', 'complained']) {
      const { db, calls } = makeDb({
        contact: { id: 'c13', location_id: HATCH, email_status },
        prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
      })

      await applyFormMarketingConsent(db, {
        contactId: 'c13', consent: true, source: 'booking_form',
      })

      expect(calls.contactUpdates).toHaveLength(0)
    }
  })

  it('bulk opt-out leaves contacts.email_status untouched', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c14', location_id: HATCH, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    const res = await applyMarketingPreferencesBulk(db, {
      contactId: 'c14', prefs: { email_marketing: false }, source: 'bulk_import',
    })

    expect(res.ok).toBe(true)
    expect(res.changed).toEqual(['email_marketing'])
    expect(calls.contactUpdates).toHaveLength(0)
  })

  it('bulk opt-in repairs unsubscribed to active but never clears bounced', async () => {
    const optedOutPrefs = { email_marketing: false, sms_marketing: false, whatsapp_marketing: false }

    const remint = makeDb({
      contact: { id: 'c15', location_id: HATCH, email_status: 'unsubscribed' },
      prefs: optedOutPrefs,
    })
    await applyMarketingPreferencesBulk(remint.db, {
      contactId: 'c15', prefs: { email_marketing: true }, source: 'bulk_import',
    })
    expect(remint.calls.contactUpdates).toEqual([{ email_status: 'active' }])

    const bounced = makeDb({
      contact: { id: 'c16', location_id: HATCH, email_status: 'bounced' },
      prefs: optedOutPrefs,
    })
    await applyMarketingPreferencesBulk(bounced.db, {
      contactId: 'c16', prefs: { email_marketing: true }, source: 'bulk_import',
    })
    expect(bounced.calls.contactUpdates).toHaveLength(0)
  })
})

// CONSENTLOC.1 — consent_log.location_id (added by mig 487) was NULL for
// every row these two helpers wrote, which is most of the estate's rows:
// the Postmark webhook unsubscribe/bounce/complaint paths all run through
// applyMarketingPreferencesBulk. Mig 517's reporting RPC had to paper over
// it with coalesce(consent_log.location_id, contacts.location_id) — a guess
// that is wrong for anyone whose consent decision was made at a location
// other than the one they are filed under, which is precisely the case
// LOCCOMMS.2 exists for.
//
// The rule these tests lock in: record the location we KNOW, or record
// nothing. A wrong location on a GDPR evidence row is worse than a missing
// one, so no caller may substitute contacts.location_id as a stand-in.
describe('consent_log.location_id (CONSENTLOC.1)', () => {
  it('stamps the FORM location on the consent_log rows, not the contact location', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c20', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    await applyFormMarketingConsent(db, {
      contactId: 'c20', consent: true, source: 'waitlist_form', locationId: HATCH,
    })

    expect(calls.consentLog).toHaveLength(3)
    for (const row of calls.consentLog) expect(row.location_id).toBe(HATCH)
  })

  it('records NULL rather than guessing when the form has no location', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c21', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: false, sms_marketing: false, whatsapp_marketing: false },
    })

    // host_mailing_list is the real caller that cannot supply one: hosts
    // have their own suppression mechanism and no CRM location.
    await applyFormMarketingConsent(db, {
      contactId: 'c21', consent: true, source: 'host_mailing_list',
    })

    expect(calls.consentLog).toHaveLength(3)
    for (const row of calls.consentLog) expect(row.location_id).toBeNull()
    // Explicitly NOT the contact's own location — that would be a guess.
    expect(calls.consentLog.some((r) => r.location_id === STILLORGAN)).toBe(false)
  })

  it('bulk: stamps the supplied location on every audit row', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c22', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    await applyMarketingPreferencesBulk(db, {
      contactId: 'c22',
      prefs: { email_marketing: false },
      source: 'postmark_one_click_unsubscribe',
      locationId: HATCH,
    })

    expect(calls.consentLog).toHaveLength(1)
    expect(calls.consentLog[0]).toMatchObject({
      channel: 'email_marketing', action: 'opt_out', location_id: HATCH,
    })
  })

  it('bulk: records NULL when the caller has no location', async () => {
    const { db, calls } = makeDb({
      contact: { id: 'c23', location_id: STILLORGAN, email_status: 'active' },
      prefs: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true },
    })

    await applyMarketingPreferencesBulk(db, {
      contactId: 'c23', prefs: { email_marketing: false }, source: 'bulk_import',
    })

    expect(calls.consentLog).toHaveLength(1)
    expect(calls.consentLog[0].location_id).toBeNull()
  })

  it('threading a location changes only what is RECORDED, never who is opted in/out', async () => {
    const base = { email_marketing: true, sms_marketing: true, whatsapp_marketing: true }
    const withLoc = makeDb({ contact: { id: 'c24', location_id: STILLORGAN, email_status: 'active' }, prefs: base })
    const withoutLoc = makeDb({ contact: { id: 'c24', location_id: STILLORGAN, email_status: 'active' }, prefs: base })

    const a = await applyMarketingPreferencesBulk(withLoc.db, {
      contactId: 'c24', prefs: { email_marketing: false }, source: 'postmark_hard_bounce', locationId: HATCH,
    })
    const b = await applyMarketingPreferencesBulk(withoutLoc.db, {
      contactId: 'c24', prefs: { email_marketing: false }, source: 'postmark_hard_bounce',
    })

    // Pin the outcome itself, not just "the two agree" — two identical
    // failures would satisfy a bare a-equals-b, and the invariant being
    // asserted is about WHO ends up opted out.
    expect(a).toEqual({ ok: true, skipped: null, changed: ['email_marketing'] })
    expect(a).toEqual(b)
    expect(withLoc.calls.prefUpserts).toHaveLength(1)
    expect(withoutLoc.calls.prefUpserts).toHaveLength(1)

    // `updated_at` is minted from the wall clock INSIDE each call, so the two
    // sequential invocations disagree by exactly 1ms whenever they straddle a
    // millisecond boundary — measured at ~0.1% of pairs on an idle machine.
    // That is what turned this test red on Actions run 32276263058 with no
    // source change, and green on the next push: the whole diff was one digit
    // in a timestamp, which vitest's print depth hid ("expected [ { contact_id:
    // 'c24', …(2) } ] to deeply equal [ { contact_id: 'c24', …(2) } ]").
    //
    // A per-row update stamp is not consent — two calls at two instants SHOULD
    // carry two stamps — so comparing it asserted nothing about the invariant
    // in this test's name. Pin the consent-bearing columns exactly, and the
    // stamp by shape (same idiom as bounce-escalation.test.js's evaluatedAt).
    const exceptStamp = (rows) => rows.map((r) => ({ ...r, updated_at: null }))
    expect(exceptStamp(withLoc.calls.prefUpserts)).toEqual(exceptStamp(withoutLoc.calls.prefUpserts))
    expect(withLoc.calls.contactUpdates).toEqual(withoutLoc.calls.contactUpdates)

    // Blanking it above must not let a MISSING stamp through: both sides still
    // have to write a real ISO timestamp.
    for (const row of [...withLoc.calls.prefUpserts, ...withoutLoc.calls.prefUpserts]) {
      expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })
})
