import { describe, it, expect } from 'vitest'
import { defaultWinbackMessage } from './churn-winback.js'

describe('defaultWinbackMessage', () => {
  it('uses the brand name', () => {
    expect(defaultWinbackMessage('Sam', 'CCF Autos')).toContain("team at CCF Autos")
  })

  it('W1.B1 — with no brand it says "the studio", never a literal gym', () => {
    expect(defaultWinbackMessage('Sam', '')).toContain('team at the studio')
    expect(defaultWinbackMessage('Sam', null)).not.toMatch(/UN1T/)
  })

  it('greets the member by first name', () => {
    expect(defaultWinbackMessage('Sam', 'UN1T')).toContain('Hi Sam,')
  })
})
