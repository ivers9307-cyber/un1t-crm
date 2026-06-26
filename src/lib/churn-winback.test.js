import { describe, it, expect } from 'vitest'
import { defaultWinbackMessage } from './churn-winback.js'

describe('defaultWinbackMessage', () => {
  it('uses the brand name', () => {
    expect(defaultWinbackMessage('Sam', 'CCF Autos')).toContain("team at CCF Autos")
  })

  it('falls back to UN1T when brand is blank', () => {
    expect(defaultWinbackMessage('Sam', '')).toContain('team at UN1T')
  })

  it('greets the member by first name', () => {
    expect(defaultWinbackMessage('Sam', 'UN1T')).toContain('Hi Sam,')
  })
})
