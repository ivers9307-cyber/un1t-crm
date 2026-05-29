import { describe, it, expect } from 'vitest'
import { flattenXeroValidationErrors } from './client.js'

describe('flattenXeroValidationErrors', () => {
  it('pulls nested element validation messages', () => {
    const json = {
      Message: 'A validation exception occurred',
      Elements: [
        { ValidationErrors: [{ Message: 'Currency GBP is not added to your organisation' }] },
      ],
    }
    expect(flattenXeroValidationErrors(json)).toEqual([
      'Currency GBP is not added to your organisation',
    ])
  })
  it('flattens across multiple elements and dedupes', () => {
    const json = {
      Elements: [
        { ValidationErrors: [{ Message: 'A' }, { Message: 'B' }] },
        { ValidationErrors: [{ Message: 'B' }] },
      ],
    }
    expect(flattenXeroValidationErrors(json)).toEqual(['A', 'B'])
  })
  it('returns [] when there are no Elements', () => {
    expect(flattenXeroValidationErrors({ Message: 'x' })).toEqual([])
    expect(flattenXeroValidationErrors(null)).toEqual([])
  })
})
