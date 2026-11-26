import { describe, it, expect } from 'vitest'
import { addContactPayload, addContactErrorText } from './add-contact-form'

describe('addContactPayload', () => {
  it('sends a blank email as null, never an empty string', () => {
    expect(addContactPayload({ name: 'Synthetic Person', first_name: 'Synthetic', email: '', add_to_pipeline: false, pipeline_stage: 'new' }))
      .toEqual({ name: 'Synthetic Person', first_name: 'Synthetic', email: null, pipeline_stage: 'new', add_to_pipeline: false })
    expect(addContactPayload({ name: 'A', email: '   ' }).email).toBeNull()
  })
  it('trims what was typed and keeps a real email', () => {
    expect(addContactPayload({ name: '  Synthetic Person ', email: ' person@example.com ', add_to_pipeline: true, pipeline_stage: 'new' }))
      .toEqual({ name: 'Synthetic Person', first_name: 'Synthetic', email: 'person@example.com', pipeline_stage: 'new', add_to_pipeline: true })
  })
  it('add_to_pipeline is true only when ticked', () => {
    expect(addContactPayload({ name: 'A' }).add_to_pipeline).toBe(false)
  })
})

describe('addContactErrorText', () => {
  it('names the email when that is what was refused', () => {
    expect(addContactErrorText({ success: false, error: 'Invalid request body', issues: [{ path: 'email', message: 'Invalid email' }] }))
      .toBe('That email address does not look right. Fix it or leave it empty.')
    expect(addContactErrorText({ success: false, error: 'Invalid request', issues: [{ path: ['email'], message: 'Invalid email' }] }))
      .toBe('That email address does not look right. Fix it or leave it empty.')
  })
  it('falls back to the route\'s line, then to a fixed one', () => {
    expect(addContactErrorText({ success: false, error: 'Could not create the contact.' })).toBe('Could not create the contact.')
    expect(addContactErrorText(null)).toBe('Could not add the contact. Try again.')
    expect(addContactErrorText({})).toBe('Could not add the contact. Try again.')
  })
})
