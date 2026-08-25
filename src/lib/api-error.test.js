// EMPTY-STRING-FIELDS.1 — describeApiError contract.
import { describe, it, expect } from 'vitest'
import { describeApiError } from './api-error.js'

describe('describeApiError', () => {
  it('surfaces the field detail the UI used to throw away', () => {
    // The exact envelope the Tesco receipt produced.
    const body = {
      success: false,
      error: 'Invalid request body',
      issues: [{ path: 'invoice_date', message: 'invoice_date must be YYYY-MM-DD' }],
    }
    expect(describeApiError(body, 'Save failed'))
      .toBe('Invalid request body — invoice_date must be YYYY-MM-DD')
  })

  it('prefixes the path when the message does not already name it', () => {
    const body = { error: 'Invalid request body', issues: [{ path: 'total', message: 'Required' }] }
    expect(describeApiError(body)).toBe('Invalid request body — total: Required')
  })

  it('does not stutter when the message already names the field', () => {
    const body = { error: 'Invalid request body', issues: [{ path: 'due_date', message: 'due_date must be YYYY-MM-DD' }] }
    expect(describeApiError(body)).toBe('Invalid request body — due_date must be YYYY-MM-DD')
  })

  it('joins several issues', () => {
    const body = {
      error: 'Invalid request body',
      issues: [{ path: 'supplier_name', message: 'Required' }, { path: 'total', message: 'Expected number' }],
    }
    expect(describeApiError(body)).toBe('Invalid request body — supplier_name: Required; total: Expected number')
  })

  it('does not treat a SUBSTRING as the field name (total vs Subtotal)', () => {
    const body = { error: 'Invalid request body', issues: [{ path: 'total', message: 'Subtotal is required' }] }
    // 'total' appears inside 'Subtotal', but not as a word — so the path is
    // still prefixed and the operator can tell which box is wrong.
    expect(describeApiError(body)).toBe('Invalid request body — total: Subtotal is required')
  })

  it('judges a dotted path on its named leaf', () => {
    const body = { error: 'Invalid request body', issues: [{ path: 'line_items.0.description', message: 'description must not be empty' }] }
    expect(describeApiError(body)).toBe('Invalid request body — description must not be empty')
  })

  it('caps a wall of issues rather than filling the toast', () => {
    const issues = ['one', 'two', 'three', 'four', 'five'].map((p) => ({ path: p, message: 'Required' }))
    expect(describeApiError({ error: 'Invalid request body', issues }))
      .toBe('Invalid request body — one: Required; two: Required; three: Required (+2 more)')
  })

  it('falls back cleanly when there are no issues', () => {
    expect(describeApiError({ success: false, error: 'Not found' }, 'Save failed')).toBe('Not found')
    expect(describeApiError({ success: false }, 'Save failed')).toBe('Save failed')
    expect(describeApiError(null, 'Save failed')).toBe('Save failed')
    expect(describeApiError(undefined)).toBe('Request failed')
  })

  it('survives a malformed issues array without throwing', () => {
    const body = { error: 'Invalid request body', issues: [null, {}, { message: '  ' }, { path: 'x' }] }
    expect(describeApiError(body)).toBe('Invalid request body — x')
  })

  it('ignores a non-array issues value', () => {
    expect(describeApiError({ error: 'Invalid request body', issues: 'nope' })).toBe('Invalid request body')
  })
})
