import { describe, it, expect } from 'vitest'
import { normalizeDatasetId, conversionsView, websiteEventToken, mergeConversionsSettings } from './meta-conversions-settings.js'
import { SECRET_MASK, maskSecretKeysDeep } from './secret-keys.js'

// All ids and tokens are synthetic.
const TOKEN = 'SYNTH-DATASET-TOKEN-1'

describe('normalizeDatasetId', () => {
  it('keeps a numeric id and trims it', () => {
    expect(normalizeDatasetId(' 1234567890123456 ')).toBe('1234567890123456')
    expect(normalizeDatasetId(1234567890)).toBe('1234567890')
  })
  it('is blank for anything that is not a plausible id', () => {
    for (const bad of ['', null, undefined, 'act_123456', '12 34', '1234', 'abc', '1'.repeat(26)]) {
      expect(normalizeDatasetId(bad)).toBe('')
    }
  })
})

describe('conversionsView', () => {
  it('answers the dataset id and only WHETHER a token is stored', () => {
    const view = conversionsView({ meta_ads: { dataset_id: '1234567890', capi_access_token: TOKEN } })
    expect(view).toEqual({ dataset_id: '1234567890', has_token: true })
    expect(JSON.stringify(view)).not.toContain(TOKEN)
  })
  it('is empty for a location with nothing configured', () => {
    for (const s of [null, undefined, {}, { meta_ads: null }, { meta_ads: { capi_access_token: '  ' } }]) {
      expect(conversionsView(s)).toEqual({ dataset_id: '', has_token: false })
    }
  })
})

describe('websiteEventToken', () => {
  it('prefers the dataset token over the fallback', () => {
    expect(websiteEventToken({ meta_ads: { capi_access_token: ` ${TOKEN} ` } }, 'WA-TOKEN')).toBe(TOKEN)
  })
  it('uses the fallback when the location stores no token', () => {
    expect(websiteEventToken({ meta_ads: { dataset_id: '1234567890' } }, 'WA-TOKEN')).toBe('WA-TOKEN')
    expect(websiteEventToken(null, 'WA-TOKEN')).toBe('WA-TOKEN')
  })
  it('is null when there is neither', () => {
    expect(websiteEventToken({}, null)).toBeNull()
    expect(websiteEventToken({ meta_ads: { capi_access_token: '' } }, '  ')).toBeNull()
  })
})

describe('mergeConversionsSettings', () => {
  const BASE = {
    glofox: { api_key: 'G', branch_id: 'b' },
    ads: { report_recipients: ['ops@example.test'] },
    meta_ads: { dataset_id: '1111111111', capi_access_token: TOKEN, other: 'kept' },
  }

  it('carries every other settings key, and every other meta_ads key, across', () => {
    const r = mergeConversionsSettings(BASE, { dataset_id: '2222222222' })
    expect(r.ok).toBe(true)
    expect(r.settings.glofox).toEqual(BASE.glofox)
    expect(r.settings.ads).toEqual(BASE.ads)
    expect(r.settings.meta_ads).toEqual({ dataset_id: '2222222222', capi_access_token: TOKEN, other: 'kept' })
  })

  it('a blank or masked token KEEPS the stored one', () => {
    for (const echoed of ['', '   ', undefined, null, SECRET_MASK]) {
      const r = mergeConversionsSettings(BASE, { dataset_id: '1111111111', capi_access_token: echoed })
      expect(r.settings.meta_ads.capi_access_token).toBe(TOKEN)
    }
  })

  it('a real new token replaces the stored one', () => {
    const r = mergeConversionsSettings(BASE, { capi_access_token: ' NEW-SYNTH-TOKEN ' })
    expect(r.settings.meta_ads.capi_access_token).toBe('NEW-SYNTH-TOKEN')
    expect(r.settings.meta_ads.dataset_id).toBe('1111111111')
  })

  it('a blank dataset id clears it (events off) and leaves the token alone', () => {
    const r = mergeConversionsSettings(BASE, { dataset_id: '' })
    expect(r.settings.meta_ads).toEqual({ capi_access_token: TOKEN, other: 'kept' })
  })

  it('refuses a dataset id that is not a number, and changes nothing', () => {
    const r = mergeConversionsSettings(BASE, { dataset_id: 'act_123' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/digits only/)
  })

  it('clear_token removes the token', () => {
    const r = mergeConversionsSettings(BASE, { clear_token: true })
    expect(r.settings.meta_ads).toEqual({ dataset_id: '1111111111', other: 'kept' })
  })

  it('starts from nothing for a location with no settings', () => {
    const r = mergeConversionsSettings(null, { dataset_id: '3333333333', capi_access_token: TOKEN })
    expect(r.settings).toEqual({ meta_ads: { dataset_id: '3333333333', capi_access_token: TOKEN } })
  })

  it('never mutates the settings it was given', () => {
    const before = JSON.stringify(BASE)
    mergeConversionsSettings(BASE, { dataset_id: '', clear_token: true })
    expect(JSON.stringify(BASE)).toBe(before)
  })
})

describe('the stored token is covered by the shared secret rule', () => {
  it('maskSecretKeysDeep hides settings.meta_ads.capi_access_token and keeps the dataset id', () => {
    const masked = maskSecretKeysDeep({ settings: { meta_ads: { dataset_id: '1234567890', capi_access_token: TOKEN } } })
    expect(JSON.stringify(masked)).not.toContain(TOKEN)
    expect(masked.settings.meta_ads.dataset_id).toBe('1234567890')
  })
})
