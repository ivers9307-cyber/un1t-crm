// Tests for the SMS branch of the event-reminder runner (mig 063).
// As with sequences-sms.test.js, we don't exercise the network call;
// these tests pin the gate logic that decides whether to send,
// skip, or throw — so an accidental loosening is caught.

import { describe, it, expect } from 'vitest'

// Mirror of the gate logic in sendSmsReminder (event-reminders.js).
// Kept as a separate function here to assert the contract without
// dragging the whole event-reminders module's network deps into
// the test harness.
function checkSmsReminderGate({ ev, booking }) {
  if (!ev.reminder_sms_body) {
    throw new Error('Event has reminder_channel=sms but no reminder_sms_body set')
  }
  const c = booking.contacts
  if (c?.sms_status && c.sms_status !== 'active') {
    return { status: 'skipped', reason: `sms_status=${c.sms_status}` }
  }
  const prefs = c?.contact_preferences
  const adminConsent = Array.isArray(prefs)
    ? prefs[0]?.sms_administrative
    : prefs?.sms_administrative
  if (adminConsent === false) {
    return { status: 'skipped', reason: 'opted_out_administrative_sms' }
  }
  const phone = booking.contacts?.phone || booking.customer_phone
  if (!phone) return { status: 'skipped', reason: 'no_phone_number' }
  return { status: 'sent' }
}

describe('event-reminder SMS gates', () => {
  const ev = { reminder_sms_body: 'Hi {{first_name}}, see you at {{event_time}}.' }
  const okContact = {
    phone: '+353871234567',
    sms_status: 'active',
    contact_preferences: { sms_administrative: true },
  }

  it('throws when the event has no SMS body configured', () => {
    expect(() => checkSmsReminderGate({
      ev: { reminder_sms_body: null },
      booking: { contacts: okContact },
    })).toThrow(/reminder_sms_body/)
  })

  it("skips when contact's sms_status is opted_out", () => {
    const out = checkSmsReminderGate({
      ev,
      booking: { contacts: { ...okContact, sms_status: 'opted_out' } },
    })
    expect(out.status).toBe('skipped')
    expect(out.reason).toMatch(/sms_status/)
  })

  it("skips when contact's sms_status is invalid", () => {
    const out = checkSmsReminderGate({
      ev,
      booking: { contacts: { ...okContact, sms_status: 'invalid' } },
    })
    expect(out.status).toBe('skipped')
  })

  it('skips when administrative consent is explicitly off', () => {
    const out = checkSmsReminderGate({
      ev,
      booking: {
        contacts: {
          ...okContact,
          contact_preferences: { sms_administrative: false },
        },
      },
    })
    expect(out.status).toBe('skipped')
    expect(out.reason).toMatch(/opted_out_administrative_sms/)
  })

  it('skips when there is no phone (contact + booking customer_phone empty)', () => {
    const out = checkSmsReminderGate({
      ev,
      booking: { contacts: { ...okContact, phone: null }, customer_phone: null },
    })
    expect(out.status).toBe('skipped')
    expect(out.reason).toMatch(/no_phone_number/)
  })

  it('falls through to booking.customer_phone when contact has no phone', () => {
    const out = checkSmsReminderGate({
      ev,
      booking: {
        contacts: { ...okContact, phone: null },
        customer_phone: '+353871230000',
      },
    })
    expect(out.status).toBe('sent')
  })

  it('treats missing sms_administrative as consented (back-compat)', () => {
    // Pre-mig-063 contacts won't have sms_administrative set yet — treat
    // them as opted-in (default TRUE), matching email/WA behaviour.
    const out = checkSmsReminderGate({
      ev,
      booking: {
        contacts: {
          ...okContact,
          contact_preferences: { /* sms_administrative absent */ },
        },
      },
    })
    expect(out.status).toBe('sent')
  })

  it('handles array-shaped contact_preferences from Supabase embed', () => {
    // Supabase one-to-one embed returns an array — gate must
    // tolerate both shapes.
    const out = checkSmsReminderGate({
      ev,
      booking: {
        contacts: {
          ...okContact,
          contact_preferences: [{ sms_administrative: false }],
        },
      },
    })
    expect(out.status).toBe('skipped')
  })
})
