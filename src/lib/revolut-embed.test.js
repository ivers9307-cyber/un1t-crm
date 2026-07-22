import { describe, it, expect, beforeEach } from 'vitest'
import { revolutMode, revolutSdkUrl } from './revolut-embed'

describe('revolut-embed config', () => {
  beforeEach(() => { delete process.env.NEXT_PUBLIC_REVOLUT_MODE })
  it('defaults to sandbox mode', () => {
    expect(revolutMode()).toBe('sandbox')
  })
  it('uses prod mode only when explicitly set', () => {
    process.env.NEXT_PUBLIC_REVOLUT_MODE = 'prod'
    expect(revolutMode()).toBe('prod')
  })
  it('maps mode -> SDK url', () => {
    expect(revolutSdkUrl('prod')).toBe('https://merchant.revolut.com/embed.js')
    expect(revolutSdkUrl('sandbox')).toBe('https://sandbox-merchant.revolut.com/embed.js')
    expect(revolutSdkUrl('anything-else')).toBe('https://sandbox-merchant.revolut.com/embed.js')
  })
})
