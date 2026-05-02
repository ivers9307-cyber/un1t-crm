// validateCustomResponses — Calendly tier 2 server-side guard.

import { describe, it, expect } from 'vitest'
import { validateCustomResponses } from './booking-validation'

describe('validateCustomResponses', () => {
  it('returns null when no custom_fields are defined', () => {
    expect(validateCustomResponses(null, { foo: 'bar' })).toBeNull()
    expect(validateCustomResponses([], { foo: 'bar' })).toBeNull()
  })

  it('flags a missing required field', () => {
    const fields = [{ id: 'reason', label: 'Reason', type: 'text', required: true }]
    const err = validateCustomResponses(fields, {})
    expect(err).toMatch(/Required field missing.*Reason/)
  })

  it('treats empty string as missing for required fields', () => {
    const fields = [{ id: 'reason', label: 'Reason', type: 'text', required: true }]
    expect(validateCustomResponses(fields, { reason: '' })).toMatch(/Required/)
  })

  it('treats empty array as missing for required fields', () => {
    const fields = [{ id: 'topics', label: 'Topics', type: 'text', required: true }]
    expect(validateCustomResponses(fields, { topics: [] })).toMatch(/Required/)
  })

  it('passes when an optional field is empty', () => {
    const fields = [{ id: 'note', label: 'Note', type: 'text' }]
    expect(validateCustomResponses(fields, {})).toBeNull()
  })

  it('passes when a required field has a value', () => {
    const fields = [{ id: 'reason', label: 'Reason', type: 'text', required: true }]
    expect(validateCustomResponses(fields, { reason: 'health' })).toBeNull()
  })

  it('flags a dropdown value that is not in options', () => {
    const fields = [
      { id: 'goal', label: 'Goal', type: 'dropdown', options: ['fat-loss', 'strength', 'mobility'] },
    ]
    const err = validateCustomResponses(fields, { goal: 'something_else' })
    expect(err).toMatch(/Invalid choice.*Goal/)
  })

  it('passes when a dropdown value is in options', () => {
    const fields = [
      { id: 'goal', label: 'Goal', type: 'dropdown', options: ['fat-loss', 'strength'] },
    ]
    expect(validateCustomResponses(fields, { goal: 'strength' })).toBeNull()
  })

  it('flags a radio value not in options (same path as dropdown)', () => {
    const fields = [
      { id: 'pref', label: 'Preference', type: 'radio', options: ['A', 'B'] },
    ]
    expect(validateCustomResponses(fields, { pref: 'C' })).toMatch(/Invalid choice/)
  })

  it('accepts boolean for checkbox', () => {
    const fields = [{ id: 'agree', label: 'Agree', type: 'checkbox' }]
    expect(validateCustomResponses(fields, { agree: true })).toBeNull()
    expect(validateCustomResponses(fields, { agree: false })).toBeNull()
  })

  it('accepts "true"/"false" string for checkbox (HTML form serialisation)', () => {
    const fields = [{ id: 'agree', label: 'Agree', type: 'checkbox' }]
    expect(validateCustomResponses(fields, { agree: 'true' })).toBeNull()
    expect(validateCustomResponses(fields, { agree: 'false' })).toBeNull()
  })

  it('flags non-boolean checkbox value', () => {
    const fields = [{ id: 'agree', label: 'Agree', type: 'checkbox' }]
    expect(validateCustomResponses(fields, { agree: 'maybe' })).toMatch(/expected true\/false/)
    expect(validateCustomResponses(fields, { agree: 1 })).toMatch(/expected true\/false/)
  })

  it('flags non-string text value', () => {
    const fields = [{ id: 'note', label: 'Note', type: 'text' }]
    expect(validateCustomResponses(fields, { note: 123 })).toMatch(/expected text/)
  })

  it('tolerates unknown keys in responses (mid-flight schema change)', () => {
    const fields = [{ id: 'reason', label: 'Reason', type: 'text' }]
    // 'old_field' isn't in custom_fields any more — should not error.
    expect(validateCustomResponses(fields, { old_field: 'stale' })).toBeNull()
  })

  it('falls back to field.id in the error message when label is missing', () => {
    const fields = [{ id: 'foo_id', type: 'text', required: true }]
    expect(validateCustomResponses(fields, {})).toMatch(/foo_id/)
  })

  it('returns the FIRST error, not all of them', () => {
    const fields = [
      { id: 'a', label: 'A', type: 'text', required: true },
      { id: 'b', label: 'B', type: 'dropdown', options: ['x'], required: true },
    ]
    const err = validateCustomResponses(fields, {})
    // Should be about A (the first one), not B.
    expect(err).toMatch(/A/)
    expect(err).not.toMatch(/B/)
  })
})
