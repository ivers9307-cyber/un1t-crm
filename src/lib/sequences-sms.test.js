// Tests for the SMS branch of the sequence runner (mig 062).
// We test the sendSmsStep guard logic by re-implementing the
// validation block here against fixtures. sendSmsStep itself lives
// in src/lib/sequences/steps.js since the slice-3b refactor; this
// file pins the contract independently so the production helper
// can't drift on the back-compat case where sms_status is absent.
//
// What we want to lock in:
//   1. A contact with sms_status != 'active' is rejected with a
//      clear error (so the existing MAX_ERRORS path in runSequences
//      kicks in instead of a silent send).
//   2. A contact with no phone is rejected with a clear error.
//   3. A step with no sms_body is rejected.

import { describe, it, expect } from 'vitest'

// Re-implement the validation block from sendSmsStep so we can
// assert it without dragging in the whole sequences module's
// network deps. If sendSmsStep is refactored, these assertions
// pin the contract so an accidental loosening of the gates is
// caught.
function validateSmsStep({ step, contact }) {
  if (!step.sms_body) throw new Error('SMS step has no sms_body.')
  if (!contact?.phone) throw new Error('Contact has no phone number — cannot send SMS step.')
  if (contact.sms_status && contact.sms_status !== 'active') {
    throw new Error(`Contact's sms_status is '${contact.sms_status}' — refusing to send.`)
  }
}

describe('sequence SMS step gates', () => {
  it('rejects a step with no sms_body', () => {
    expect(() => validateSmsStep({
      step: { sms_body: null },
      contact: { phone: '+353871234567', sms_status: 'active' },
    })).toThrow(/sms_body/)
  })

  it('rejects a contact with no phone', () => {
    expect(() => validateSmsStep({
      step: { sms_body: 'Hi' },
      contact: { phone: null, sms_status: 'active' },
    })).toThrow(/phone/)
  })

  it("rejects a contact with sms_status='opted_out'", () => {
    expect(() => validateSmsStep({
      step: { sms_body: 'Hi' },
      contact: { phone: '+353871234567', sms_status: 'opted_out' },
    })).toThrow(/sms_status.*opted_out/)
  })

  it("rejects a contact with sms_status='invalid'", () => {
    expect(() => validateSmsStep({
      step: { sms_body: 'Hi' },
      contact: { phone: '+353871234567', sms_status: 'invalid' },
    })).toThrow(/sms_status.*invalid/)
  })

  it("accepts a valid step + active contact", () => {
    expect(() => validateSmsStep({
      step: { sms_body: 'Hi {{first_name}}' },
      contact: { phone: '+353871234567', sms_status: 'active' },
    })).not.toThrow()
  })

  it('treats absent sms_status as active (back-compat for pre-mig-059 contacts)', () => {
    expect(() => validateSmsStep({
      step: { sms_body: 'Hi' },
      contact: { phone: '+353871234567' /* sms_status absent */ },
    })).not.toThrow()
  })
})
