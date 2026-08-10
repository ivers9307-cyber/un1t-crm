import { describe, it, expect } from 'vitest'
import { formatMetaError } from './whatsapp-meta-error.js'

// The live 2026-08-10 template-submit failure, verbatim off the Graph API.
const BUTTON_ERROR = {
  message: 'Invalid parameter',
  type: 'OAuthException',
  code: 100,
  error_subcode: 2388060,
  is_transient: false,
  error_user_title: 'Button format is incorrect',
  error_user_msg: "Buttons can't have any variables, newlines, emojis or formatting characters.",
  fbtrace_id: 'A7hBlPgtiMLDFk5np2s6r58',
}

describe('formatMetaError', () => {
  it('leads with the user-facing title and message, not the generic "Invalid parameter"', () => {
    const out = formatMetaError(BUTTON_ERROR)
    expect(out).toContain('Button format is incorrect')
    expect(out).toContain("Buttons can't have any variables")
    expect(out).not.toContain('Invalid parameter')
  })

  it('appends the code/subcode so a rejection can be looked up', () => {
    expect(formatMetaError(BUTTON_ERROR)).toContain('(Meta 100/2388060)')
  })

  it('falls back to error_data.details when Meta sends no user-facing copy', () => {
    const out = formatMetaError({
      message: '(#131009) Parameter value is not valid',
      code: 131009,
      error_data: { details: 'The phone number is malformed: Please use the format: +1234567890.' },
    })
    expect(out).toContain('Parameter value is not valid')
    expect(out).toContain('phone number is malformed')
    expect(out).toContain('(Meta 131009)')
  })

  it('keeps the generic message when that is all there is', () => {
    expect(formatMetaError({ message: 'Invalid parameter', code: 100 })).toBe('Invalid parameter (Meta 100)')
  })

  it('omits the code suffix when Meta sends no code', () => {
    expect(formatMetaError({ message: 'Something broke' })).toBe('Something broke')
  })

  it('uses the caller fallback for a missing/garbage error object', () => {
    expect(formatMetaError(null, 'Failed to create template')).toBe('Failed to create template')
    expect(formatMetaError('nope', 'Failed to create template')).toBe('Failed to create template')
    expect(formatMetaError({}, 'Failed to create template')).toBe('Failed to create template')
  })
})
