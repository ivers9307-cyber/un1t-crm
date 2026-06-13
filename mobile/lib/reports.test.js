import { describe, it, expect } from 'vitest'
import { reportsLanding } from './reports'

describe('reportsLanding', () => {
  it('shows the chooser when the user has both surfaces', () => {
    expect(reportsLanding({ canSubmit: true, canTriage: true })).toBe('chooser')
  })

  it('goes straight to the inbox for a triage-only user', () => {
    expect(reportsLanding({ canSubmit: false, canTriage: true })).toBe('inbox')
  })

  it('goes straight to My reports for a submit-only user (regular staff)', () => {
    expect(reportsLanding({ canSubmit: true, canTriage: false })).toBe('myreports')
  })

  it('defaults to My reports for the degenerate neither case', () => {
    expect(reportsLanding({ canSubmit: false, canTriage: false })).toBe('myreports')
    expect(reportsLanding({})).toBe('myreports')
    expect(reportsLanding()).toBe('myreports')
  })
})
