import { describe, it, expect } from 'vitest'
import { customerErrorText } from './page-request-errors'

describe('customerErrorText', () => {
  it('keeps the server words and replaces a machine word or nothing with the fallback', () => {
    expect(customerErrorText('That class is gone.', 'F')).toBe('That class is gone.')
    expect(customerErrorText('not_found', 'F')).toBe('F')
    expect(customerErrorText('studio_required', 'F')).toBe('F')
    expect(customerErrorText('', 'F')).toBe('F')
    expect(customerErrorText(undefined, 'F')).toBe('F')
  })
})
