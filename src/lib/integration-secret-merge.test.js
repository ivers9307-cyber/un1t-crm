// Unit tests for the Phase-2 write-only secret merge + the Glofox
// null-collapse guard. This is the SECURITY/CORRECTNESS pin for the whole
// feature: a naive port of the old Glofox save would wipe Stillorgan's live
// connection on a blank no-op save. These tests fail loudly if that
// regression is ever reintroduced.

import { describe, it, expect } from 'vitest'
import {
  isFreshSecret,
  maskSecret,
  mergeSecretSlice,
  sliceHasValue,
} from './integration-secret-merge.js'

const GLOFOX_SECRETS = ['api_key', 'api_token', 'webhook_secret']

// A fully-configured Glofox slice = Stillorgan's LIVE connection.
function storedGlofox() {
  return {
    branch_id: 'branch-abc-123',
    api_key: 'LIVE_API_KEY',
    api_token: 'LIVE_API_TOKEN',
    webhook_secret: 'LIVE_WEBHOOK_SECRET',
    namespace: 'untstillorgan',
    trial_membership_id: 'mem-1',
    trial_plan_code: 'plan-1',
    hidden_class_keywords: ['EL1TES'],
  }
}

describe('isFreshSecret', () => {
  it('is false for blank / whitespace / null / undefined', () => {
    expect(isFreshSecret('')).toBe(false)
    expect(isFreshSecret('   ')).toBe(false)
    expect(isFreshSecret(null)).toBe(false)
    expect(isFreshSecret(undefined)).toBe(false)
  })
  it('is false for the masked echo (starts with the bullet run)', () => {
    expect(isFreshSecret('••••••')).toBe(false)
    expect(isFreshSecret('••••••3210')).toBe(false)
  })
  it('is true for a real value', () => {
    expect(isFreshSecret('sk_live_123')).toBe(true)
  })
})

describe('maskSecret', () => {
  it('returns null for empty input', () => {
    expect(maskSecret('')).toBeNull()
    expect(maskSecret(null)).toBeNull()
  })
  it('keeps the last few chars and never returns the raw secret', () => {
    expect(maskSecret('abcdef1234')).toBe('••••••1234')
    expect(maskSecret('abcdef1234')).not.toContain('abcdef')
  })
  it('fully masks short secrets', () => {
    expect(maskSecret('abc')).toBe('••••••')
  })
})

describe('mergeSecretSlice — Glofox null-collapse guard', () => {
  // (a) stored present + BLANK save → slice UNCHANGED (the wipe this prevents)
  it('(a) blank/masked save on a live connection preserves every stored secret', () => {
    const stored = storedGlofox()
    const merged = mergeSecretSlice({
      stored,
      // The drawer's masked/empty secret fields on a no-op save: secrets
      // blank/masked, non-secrets echoed back at their prefilled values.
      patch: {
        branch_id: 'branch-abc-123',
        namespace: 'untstillorgan',
        api_key: '',
        api_token: '••••••',
        webhook_secret: '',
      },
      secretFields: GLOFOX_SECRETS,
    })
    expect(merged.api_key).toBe('LIVE_API_KEY')
    expect(merged.api_token).toBe('LIVE_API_TOKEN')
    expect(merged.webhook_secret).toBe('LIVE_WEBHOOK_SECRET')
    // Non-exposed fields survive untouched.
    expect(merged.trial_membership_id).toBe('mem-1')
    expect(merged.hidden_class_keywords).toEqual(['EL1TES'])
    // The whole slice is still meaningful → the route will NOT collapse it.
    expect(sliceHasValue(merged)).toBe(true)
  })

  // (b) fresh api_key → ONLY that field changes, the others are preserved
  it('(b) a fresh api_key overwrites only api_key; other secrets kept', () => {
    const merged = mergeSecretSlice({
      stored: storedGlofox(),
      patch: {
        branch_id: 'branch-abc-123',
        api_key: 'ROTATED_KEY',
        api_token: '',
        webhook_secret: '••••••',
      },
      secretFields: GLOFOX_SECRETS,
    })
    expect(merged.api_key).toBe('ROTATED_KEY')
    expect(merged.api_token).toBe('LIVE_API_TOKEN')
    expect(merged.webhook_secret).toBe('LIVE_WEBHOOK_SECRET')
  })

  // (c) masked-echo is treated as blank/keep
  it('(c) a masked-echo secret is treated as keep, never persisted as the mask', () => {
    const merged = mergeSecretSlice({
      stored: storedGlofox(),
      patch: { api_key: '••••••_KEY', api_token: '••••••', webhook_secret: '••••••' },
      secretFields: GLOFOX_SECRETS,
    })
    expect(merged.api_key).toBe('LIVE_API_KEY')
    expect(merged.api_token).toBe('LIVE_API_TOKEN')
    expect(merged.webhook_secret).toBe('LIVE_WEBHOOK_SECRET')
    // The persisted value is never a bullet string.
    expect(merged.api_key.startsWith('••')).toBe(false)
  })

  it('a cleared NON-secret field (branch_id blank) is set to null (explicit edit)', () => {
    const merged = mergeSecretSlice({
      stored: storedGlofox(),
      patch: { branch_id: '' },
      secretFields: GLOFOX_SECRETS,
    })
    expect(merged.branch_id).toBeNull()
    // Secrets still kept — clearing a visible non-secret is not a disconnect.
    expect(merged.api_key).toBe('LIVE_API_KEY')
  })

  it('a fresh connect from an empty slice writes the fresh secrets', () => {
    const merged = mergeSecretSlice({
      stored: {},
      patch: {
        branch_id: 'new-branch',
        api_key: 'NEW_KEY',
        api_token: 'NEW_TOKEN',
        webhook_secret: 'NEW_SECRET',
      },
      secretFields: GLOFOX_SECRETS,
    })
    expect(merged).toMatchObject({
      branch_id: 'new-branch',
      api_key: 'NEW_KEY',
      api_token: 'NEW_TOKEN',
      webhook_secret: 'NEW_SECRET',
    })
    expect(sliceHasValue(merged)).toBe(true)
  })

  it('an all-blank save on an EMPTY slice yields no meaningful value (collapses to null upstream)', () => {
    const merged = mergeSecretSlice({
      stored: {},
      patch: { branch_id: '', namespace: '', api_key: '', api_token: '', webhook_secret: '' },
      secretFields: GLOFOX_SECRETS,
    })
    // Every field empty and nothing stored → the route persists null.
    expect(sliceHasValue(merged)).toBe(false)
  })

  it('does not mutate the stored slice in place', () => {
    const stored = storedGlofox()
    const snapshot = JSON.stringify(stored)
    mergeSecretSlice({ stored, patch: { api_key: 'ROTATED' }, secretFields: GLOFOX_SECRETS })
    expect(JSON.stringify(stored)).toBe(snapshot)
  })
})

describe('mergeSecretSlice — UniFi / AC preservation', () => {
  it('UniFi: blank token keeps the stored token, host edit applies', () => {
    const merged = mergeSecretSlice({
      stored: { host: 'https://old:12445', api_token: 'UNIFI_TOKEN', staff_policy_id: 's1', allow_self_signed: false },
      patch: { host: 'https://new:12445', api_token: '', staff_policy_id: 's1', manager_policy_id: '', allow_self_signed: false },
      secretFields: ['api_token'],
    })
    expect(merged.api_token).toBe('UNIFI_TOKEN')
    expect(merged.host).toBe('https://new:12445')
    expect(merged.manager_policy_id).toBeNull()
  })

  it('AC: blank sensibo/thinq secrets keep stored, non-secret client_id/country apply', () => {
    const merged = mergeSecretSlice({
      stored: { sensibo_api_key: 'SENSIBO', thinq_pat: 'PAT', thinq_client_id: 'cid', thinq_country_code: 'IE' },
      patch: { sensibo_api_key: '', thinq_pat: '••••••', thinq_client_id: 'cid', thinq_country_code: 'GB' },
      secretFields: ['sensibo_api_key', 'thinq_pat'],
    })
    expect(merged.sensibo_api_key).toBe('SENSIBO')
    expect(merged.thinq_pat).toBe('PAT')
    expect(merged.thinq_country_code).toBe('GB')
  })
})

describe('sliceHasValue', () => {
  it('true when any field carries a meaningful value', () => {
    expect(sliceHasValue({ api_key: 'x' })).toBe(true)
    expect(sliceHasValue({ n: 5 })).toBe(true)
    expect(sliceHasValue({ flag: true })).toBe(true)
  })
  it('false for an all-empty / falsey slice', () => {
    expect(sliceHasValue({})).toBe(false)
    expect(sliceHasValue(null)).toBe(false)
    expect(sliceHasValue({ a: '', b: null, c: false, d: [] })).toBe(false)
  })
  it('honours the ignore list', () => {
    expect(sliceHasValue({ allow_self_signed: true }, { ignore: ['allow_self_signed'] })).toBe(false)
  })
})
