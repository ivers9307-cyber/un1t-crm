import { describe, it, expect } from 'vitest'
import {
  USAGE_FEATURES, isUsageFeature, usageFeatureLabel,
  featureForWebPath, featureForPhonePath, _USAGE_PREFIXES,
} from './usage-features.js'

describe('usage feature registry', () => {
  it('has unique keys including other', () => {
    const keys = USAGE_FEATURES.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('other')
  })

  it('every prefix maps to a registered key', () => {
    for (const [, key] of [..._USAGE_PREFIXES.web, ..._USAGE_PREFIXES.phone]) {
      expect(isUsageFeature(key)).toBe(true)
    }
  })

  it('isUsageFeature refuses unknown keys and non-strings', () => {
    expect(isUsageFeature('contacts')).toBe(true)
    expect(isUsageFeature('nope')).toBe(false)
    expect(isUsageFeature(null)).toBe(false)
  })

  it('labels a key and falls back to Other', () => {
    expect(usageFeatureLabel('schedule')).toBe('Rota')
    expect(usageFeatureLabel('nope')).toBe('Other')
  })
})

describe('featureForWebPath', () => {
  it('maps a record page to its feature, never keeping the id', () => {
    expect(featureForWebPath('/contacts/abc-123')).toBe('contacts')
  })
  it('prefers the longest prefix', () => {
    expect(featureForWebPath('/settings/staff')).toBe('staff')
    expect(featureForWebPath('/settings/billing')).toBe('settings')
    expect(featureForWebPath('/communications/inbox')).toBe('inbox')
    expect(featureForWebPath('/communications/send')).toBe('campaigns')
  })
  it('is segment aware and ignores query and trailing slash', () => {
    expect(featureForWebPath('/contactsfoo')).toBe('other')
    expect(featureForWebPath('/contacts/?q=1')).toBe('contacts')
  })
  it('maps / to home and unknown to other', () => {
    expect(featureForWebPath('/')).toBe('home')
    expect(featureForWebPath('/nowhere')).toBe('other')
    expect(featureForWebPath(undefined)).toBe('other')
  })
})

describe('featureForPhonePath', () => {
  it('maps tabs and folders to shared keys', () => {
    expect(featureForPhonePath('/whatsapp')).toBe('inbox')
    expect(featureForPhonePath('/whatsapp/123')).toBe('inbox')
    expect(featureForPhonePath('/contacts/9')).toBe('contacts')
    expect(featureForPhonePath('/shelly')).toBe('controls')
  })
  it('maps / to home and unknown to other', () => {
    expect(featureForPhonePath('/')).toBe('home')
    expect(featureForPhonePath('/mystery')).toBe('other')
  })
})
