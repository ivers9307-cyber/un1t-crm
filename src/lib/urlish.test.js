import { describe, it, expect } from 'vitest'
import { normalizeUrlish } from './urlish.js'

describe('normalizeUrlish', () => {
  it('prefixes https:// on bare domains and paths', () => {
    expect(normalizeUrlish('un1tdublin.com/start')).toBe('https://un1tdublin.com/start')
    expect(normalizeUrlish('un1tdublin.com')).toBe('https://un1tdublin.com')
  })
  it('leaves schemed URLs untouched (including http and non-http)', () => {
    expect(normalizeUrlish('https://x.ie/a')).toBe('https://x.ie/a')
    expect(normalizeUrlish('http://x.ie')).toBe('http://x.ie')
    expect(normalizeUrlish('ftp://files.x.ie')).toBe('ftp://files.x.ie') // still fails .url()-for-http checks downstream where enforced
  })
  it('trims whitespace; empty stays empty', () => {
    expect(normalizeUrlish('  un1t.ie  ')).toBe('https://un1t.ie')
    expect(normalizeUrlish('')).toBe('')
    expect(normalizeUrlish(null)).toBe('')
  })
})
