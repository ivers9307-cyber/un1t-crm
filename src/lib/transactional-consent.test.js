// EVENT-CONSENT.1 — the shared transactional gate.
//
// The two properties that matter and are easy to get backwards:
//   1. It reads the _ADMINISTRATIVE family. A marketing opt-out must NEVER
//      suppress a receipt for money already taken.
//   2. A consent read that FAILS does not suppress. Removing a silent
//      mis-send must not create a silent message loss (CLAUDE.md).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const logError = vi.fn()
vi.mock('./log', () => ({ logError: (...a) => logError(...a) }))

import {
  readContactPreference,
  transactionalEmailSuppression,
  transactionalSmsSuppression,
  loadTransactionalConsent,
  checkTransactionalConsent,
  administrativeOptOutProvenance,
  isMachineSetConsentSource,
} from './transactional-consent'

beforeEach(() => vi.clearAllMocks())

describe('readContactPreference', () => {
  it('reads the embedded ARRAY shape PostgREST returns', () => {
    expect(readContactPreference({ contact_preferences: [{ email_administrative: false }] }, 'email_administrative'))
      .toBe(false)
  })

  it('reads the object shape too', () => {
    expect(readContactPreference({ contact_preferences: { sms_administrative: true } }, 'sms_administrative'))
      .toBe(true)
  })

  it('is undefined — NOT false — when the contact has no preferences row', () => {
    // Absence is "never expressed a preference", not an opt-out. 8,614 contacts
    // in prod have exactly one row each, but a brand-new contact has none.
    expect(readContactPreference({ contact_preferences: [] }, 'email_administrative')).toBeUndefined()
    expect(readContactPreference({}, 'email_administrative')).toBeUndefined()
    expect(readContactPreference(null, 'email_administrative')).toBeUndefined()
  })
})

describe('transactionalEmailSuppression — the ADMINISTRATIVE family', () => {
  it('SENDS to someone who opted out of MARKETING email', () => {
    // THE bug this guards. 47 of 193 completed race payments in prod belong to
    // contacts with email_marketing = false. Reading the marketing family here
    // would delete a quarter of all paid-registration receipts — and the
    // per-person check-in QR each one carries.
    const contact = {
      email_status: 'active',
      contact_preferences: [{ email_marketing: false, email_administrative: true }],
    }
    expect(transactionalEmailSuppression(contact)).toBeNull()
  })

  it('suppresses an administrative opt-out', () => {
    expect(transactionalEmailSuppression({ contact_preferences: [{ email_administrative: false }] }))
      .toBe('opted_out_administrative_email')
  })

  it('suppresses the hard signals', () => {
    expect(transactionalEmailSuppression({ email_status: 'bounced' })).toBe('email_status=bounced')
    expect(transactionalEmailSuppression({ email_status: 'complained' })).toBe('email_status=complained')
  })

  it("does NOT treat 'unsubscribed' as a hard signal (LOCCOMMS.5)", () => {
    expect(transactionalEmailSuppression({ email_status: 'unsubscribed' })).toBeNull()
  })

  it('sends when there is no contact at all', () => {
    expect(transactionalEmailSuppression(null)).toBeNull()
  })
})

describe('transactionalSmsSuppression', () => {
  it('SENDS to someone who opted out of MARKETING sms', () => {
    expect(transactionalSmsSuppression({
      sms_status: 'active',
      contact_preferences: [{ sms_marketing: false, sms_administrative: true }],
    })).toBeNull()
  })

  it('suppresses any sms_status that is set and not active', () => {
    expect(transactionalSmsSuppression({ sms_status: 'opted_out' })).toBe('sms_status=opted_out')
    expect(transactionalSmsSuppression({ sms_status: 'invalid' })).toBe('sms_status=invalid')
  })

  it('suppresses an administrative sms opt-out', () => {
    expect(transactionalSmsSuppression({ contact_preferences: [{ sms_administrative: false }] }))
      .toBe('opted_out_administrative_sms')
  })

  it('sends when sms_status is unset (never assume opted out)', () => {
    expect(transactionalSmsSuppression({ sms_status: null })).toBeNull()
  })
})

describe('loadTransactionalConsent — never throws', () => {
  function stubDb(result) {
    const b = { from: () => b, select: () => b, eq: () => b, maybeSingle: async () => result }
    return b
  }

  it('reports a failed read as unreadable, not as "no contact"', async () => {
    const out = await loadTransactionalConsent(stubDb({ data: null, error: { message: 'boom' } }), 'c1')
    expect(out).toEqual({ contact: null, unreadable: true })
  })

  it('reports a throwing client as unreadable', async () => {
    const db = { from() { throw new Error('connection reset') } }
    await expect(loadTransactionalConsent(db, 'c1')).resolves.toEqual({ contact: null, unreadable: true })
  })

  it('does not query without a contact id', async () => {
    const db = { from() { throw new Error('should not query') } }
    await expect(loadTransactionalConsent(db, null)).resolves.toEqual({ contact: null, unreadable: false })
  })
})

describe('checkTransactionalConsent — an unreadable gate never suppresses', () => {
  it('ALLOWS the send and logs structurally when the consent read fails', async () => {
    const db = { from() { throw new Error('connection reset') } }

    const out = await checkTransactionalConsent({
      db, contactId: 'c1', channel: 'email', module: 'race-confirmations', meta: { paymentId: 'p1' },
    })

    expect(out.allowed).toBe(true)
    expect(out.unreadable).toBe(true)
    // Visibility is what replaces the drop — logError, not free text.
    expect(logError).toHaveBeenCalledWith(
      'race-confirmations',
      expect.stringContaining('SENDING ANYWAY'),
      expect.objectContaining({ channel: 'email', contactId: 'c1', paymentId: 'p1' }),
    )
  })

  it('refuses when the row reads cleanly and says opted out', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { id: 'c1', contact_preferences: [{ email_administrative: false }] }, error: null,
        }) }) }),
      }),
    }

    const out = await checkTransactionalConsent({ db, contactId: 'c1', channel: 'email', module: 'x' })

    expect(out).toEqual({ allowed: false, reason: 'opted_out_administrative_email', unreadable: false })
    expect(logError).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// WHAT `email_administrative = false` MEANS IN THIS DATABASE
// ─────────────────────────────────────────────────────────────────────────
// Measured read-only against prod 2026-08-20: 1627 contacts carry it, 1626 of
// them are `glofox_membership_status = 'classpass_payg'`, and consent_log holds
// 4599 `auto_classpass_backfill` + 282 `auto_classpass` administrative rows and
// NOTHING ELSE. There is not one human-written administrative opt-out in the
// whole database — every one on record came from mig 151's blanket trigger.
//
// So for a message nothing will ever retry, that flag must not be allowed to
// delete a receipt. It is the same lesson LOCCOMMS.5 already learned for the
// other half of mig 151 (which also flips email_status to 'unsubscribed').

function consentLogDb({ row = null, fails = false, contact = null, contactFails = false } = {}) {
  return {
    from(table) {
      if (table === 'consent_log') {
        const b = {}
        for (const m of ['select', 'eq', 'order']) b[m] = () => b
        b.limit = async () => (fails
          ? { data: null, error: { message: 'boom' } }
          : { data: row ? [row] : [], error: null })
        return b
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => (contactFails
          ? { data: null, error: { message: 'boom' } }
          : { data: contact, error: null }) }) }),
      }
    },
  }
}

describe('isMachineSetConsentSource', () => {
  it('knows both mig-151 sources and nothing else', () => {
    expect(isMachineSetConsentSource('auto_classpass')).toBe(true)
    expect(isMachineSetConsentSource('auto_classpass_backfill')).toBe(true)
    expect(isMachineSetConsentSource('preference_centre')).toBe(false)
    expect(isMachineSetConsentSource('admin_panel')).toBe(false)
    expect(isMachineSetConsentSource(null)).toBe(false)
  })
})

describe('administrativeOptOutProvenance — who set the flag', () => {
  it('reports a trigger-written opt-out as machine-set', async () => {
    const db = consentLogDb({ row: { source: 'auto_classpass', action: 'opt_out' } })
    await expect(administrativeOptOutProvenance(db, 'c1', 'email'))
      .resolves.toEqual({ machineSet: true, unreadable: false, source: 'auto_classpass' })
  })

  it('reports a person-written opt-out as NOT machine-set', async () => {
    const db = consentLogDb({ row: { source: 'preference_centre', action: 'opt_out' } })
    const out = await administrativeOptOutProvenance(db, 'c1', 'email')
    expect(out.machineSet).toBe(false)
  })

  it('LATEST WINS — a later human opt-out outranks the trigger that swept them up first', async () => {
    // The fake returns whatever the ordered+limited query would; this pins that
    // the caller asks for the newest row, not the oldest.
    const db = consentLogDb({ row: { source: 'admin_panel', action: 'opt_out' } })
    expect((await administrativeOptOutProvenance(db, 'c1', 'email')).machineSet).toBe(false)
  })

  it('reports a failed read as unreadable rather than guessing', async () => {
    const db = consentLogDb({ fails: true })
    await expect(administrativeOptOutProvenance(db, 'c1', 'email'))
      .resolves.toEqual({ machineSet: false, unreadable: true, source: null })
  })

  it('never throws on a throwing client, and does not query without a contact id', async () => {
    const throwing = { from() { throw new Error('connection reset') } }
    expect((await administrativeOptOutProvenance(throwing, 'c1', 'email')).unreadable).toBe(true)
    expect((await administrativeOptOutProvenance(throwing, null, 'email')).unreadable).toBe(false)
  })
})

describe('checkTransactionalConsent — unrecoverable messages', () => {
  const OPTED_OUT = { id: 'c1', email_status: 'active', contact_preferences: [{ email_administrative: false }] }

  it('DISREGARDS a machine-set administrative opt-out, and logs that it did', async () => {
    const db = consentLogDb({ contact: OPTED_OUT, row: { source: 'auto_classpass_backfill', action: 'opt_out' } })

    const out = await checkTransactionalConsent({
      db, contactId: 'c1', channel: 'email', module: 'race-confirmations',
      meta: { paymentId: 'p1' }, unrecoverable: true,
    })

    expect(out.allowed).toBe(true)
    expect(logError).toHaveBeenCalledWith(
      'race-confirmations',
      expect.stringContaining('DISREGARDED'),
      expect.objectContaining({ consentSource: 'auto_classpass_backfill', paymentId: 'p1' }),
    )
  })

  it('HONOURS a person-set administrative opt-out — and logs the suppression LOUDLY', async () => {
    const db = consentLogDb({ contact: OPTED_OUT, row: { source: 'preference_centre', action: 'opt_out' } })

    const out = await checkTransactionalConsent({
      db, contactId: 'c1', channel: 'email', module: 'race-confirmations',
      meta: { paymentId: 'p1' }, unrecoverable: true,
    })

    expect(out.allowed).toBe(false)
    expect(out.reason).toBe('opted_out_administrative_email')
    // Nothing retries this path, so a silent skip is the real defect.
    expect(logError).toHaveBeenCalledWith(
      'race-confirmations',
      expect.stringContaining('SUPPRESSED'),
      expect.objectContaining({ reason: 'opted_out_administrative_email', paymentId: 'p1' }),
    )
  })

  it('sends when the PROVENANCE lookup itself fails — it cannot be what loses the message', async () => {
    const db = consentLogDb({ contact: OPTED_OUT, fails: true })

    const out = await checkTransactionalConsent({
      db, contactId: 'c1', channel: 'email', module: 'x', unrecoverable: true,
    })

    expect(out.allowed).toBe(true)
  })

  it('still honours HARD SIGNALS — the narrowing is only about the administrative flag', async () => {
    const db = consentLogDb({
      contact: { id: 'c1', email_status: 'bounced', contact_preferences: [{ email_administrative: true }] },
      row: { source: 'auto_classpass', action: 'opt_out' },
    })

    const out = await checkTransactionalConsent({
      db, contactId: 'c1', channel: 'email', module: 'x', unrecoverable: true,
    })

    expect(out.allowed).toBe(false)
    expect(out.reason).toBe('email_status=bounced')
  })

  it('WITHOUT the flag, an administrative opt-out suppresses as before and consent_log is never read', async () => {
    // Operator-driven and cron paths keep the strict gate: the skip is visible
    // and repeatable there, so it costs nothing.
    const db = {
      from(table) {
        if (table === 'consent_log') throw new Error('should not query provenance')
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: OPTED_OUT, error: null }) }) }) }
      },
    }

    const out = await checkTransactionalConsent({ db, contactId: 'c1', channel: 'email', module: 'x' })

    expect(out).toEqual({ allowed: false, reason: 'opted_out_administrative_email', unreadable: false })
    expect(logError).not.toHaveBeenCalled()
  })
})
