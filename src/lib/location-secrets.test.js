// SECFIX.3a — the location-row redaction every browser-bound path uses.
import { describe, it, expect } from 'vitest'
import {
  LOCATION_SECRET_MASK, USER_LOCATION_COLUMNS, CLIENT_LOCATION_COLUMNS,
  redactLocationSecrets, redactLinkedLocations, redactProfileLocations,
  toUserLocation, toUserLinkedLocations,
} from './location-secrets.js'
import { isFreshSecret } from './integration-secret-merge.js'

const ROW = Object.freeze({
  id: 'loc-1', name: 'Studio', features: { bookings: true },
  sensibo_api_key: 'SYNTH-SENSIBO', thinq_pat: 'SYNTH-THINQ', thinq_client_id: 'client-1',
  settings: {
    glofox: { branch_id: 'b1', api_key: 'SYNTH-GK', api_token: 'SYNTH-GT', webhook_secret: 'SYNTH-GW', namespace: 'ns' },
    unifi: { host: 'https://u.example', api_token: 'SYNTH-UT', staff_policy_id: 'p1' },
    customer_agent: { enabled: true },
  },
})

describe('redactLocationSecrets', () => {
  it('masks all six credential values and nothing else', () => {
    const out = redactLocationSecrets(ROW)
    expect(out.sensibo_api_key).toBe(LOCATION_SECRET_MASK)
    expect(out.thinq_pat).toBe(LOCATION_SECRET_MASK)
    expect(out.settings.glofox).toEqual({ branch_id: 'b1', api_key: LOCATION_SECRET_MASK, api_token: LOCATION_SECRET_MASK, webhook_secret: LOCATION_SECRET_MASK, namespace: 'ns' })
    expect(out.settings.unifi).toEqual({ host: 'https://u.example', api_token: LOCATION_SECRET_MASK, staff_policy_id: 'p1' })
    expect(out.settings.customer_agent).toBe(ROW.settings.customer_agent)
    expect(out.thinq_client_id).toBe('client-1')
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
  })

  it('never mutates its input', () => {
    redactLocationSecrets(ROW)
    expect(ROW.settings.glofox.api_key).toBe('SYNTH-GK')
  })

  it('keeps presence: every masked value is truthy', () => {
    const out = redactLocationSecrets(ROW)
    expect(Boolean(out.settings.glofox.api_key && out.settings.glofox.api_token)).toBe(true)
  })

  it('the mask is never a fresh secret, so echoing it to the masked PUT keeps the stored value', () => {
    expect(isFreshSecret(LOCATION_SECRET_MASK)).toBe(false)
  })

  it('leaves empty / null credentials alone and adds no keys', () => {
    const row = { id: 'x', sensibo_api_key: null, thinq_pat: '', settings: { glofox: { branch_id: 'b', api_key: null } } }
    expect(redactLocationSecrets(row)).toEqual(row)
  })

  it('returns the SAME object when there is nothing to redact (fixture pins stay deep-equal)', () => {
    const row = { id: 'x', name: 'Plain', settings: { customer_agent: { enabled: true } } }
    expect(redactLocationSecrets(row)).toBe(row)
  })

  // S2 (review) — the four named keys are not the only credentials a
  // settings tree can hold: any key mig 647's rule calls a secret is masked,
  // at any depth, presence kept (so glofoxConnected-style checks hold).
  it('masks ANY secret-named key in settings, at any depth, keeping presence', () => {
    const row = {
      id: 'loc-2',
      settings: {
        glofox: { branch_id: 'b2', api_key: 'SYNTH-GK2', trial_plan_code: 'T1' },
        stripe: { account_id: 'acct-1', webhookSigningSecret: 'SYNTH-SS' },
        wa_card_sets: [{ label: 'Cards', access_token: 'SYNTH-WA' }],
        deep: { a: { b: { c: { client_secret: 'SYNTH-CS', note: 'kept' } } } },
        customer_agent: { enabled: true, test_phones: ['+353000000000'] },
        empty: { api_token: '' },
      },
    }
    const out = redactLocationSecrets(row)
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
    expect(out.settings.stripe).toEqual({ account_id: 'acct-1', webhookSigningSecret: LOCATION_SECRET_MASK })
    expect(out.settings.wa_card_sets).toEqual([{ label: 'Cards', access_token: LOCATION_SECRET_MASK }])
    expect(out.settings.deep.a.b.c).toEqual({ client_secret: LOCATION_SECRET_MASK, note: 'kept' })
    expect(out.settings.glofox).toEqual({ branch_id: 'b2', api_key: LOCATION_SECRET_MASK, trial_plan_code: 'T1' })
    expect(out.settings.customer_agent).toBe(row.settings.customer_agent)
    expect(out.settings.empty).toBe(row.settings.empty)
  })

  it('masks a secret-named COLUMN the explicit list does not name (bca_config whole, a future *_api_key)', () => {
    const row = { id: 'loc-3', name: 'S', bca_config: { send_from: 'a@example.com' }, future_api_key: 'SYNTH-FK' }
    const out = redactLocationSecrets(row)
    expect(out).toEqual({ id: 'loc-3', name: 'S', bca_config: LOCATION_SECRET_MASK, future_api_key: LOCATION_SECRET_MASK })
  })

  it('a settings tree deeper than the walk limit is masked whole, never walked into the stack', () => {
    let deep = { api_token: 'SYNTH-DEEP' }
    for (let i = 0; i < 20; i += 1) deep = { n: deep }
    const out = redactLocationSecrets({ id: 'x', settings: deep })
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
  })

  it('passes non-objects and odd shapes through', () => {
    expect(redactLocationSecrets(null)).toBeNull()
    expect(redactLocationSecrets(undefined)).toBeUndefined()
    const odd = { id: 'x', settings: { glofox: 'not-an-object', unifi: ['arr'] } }
    expect(redactLocationSecrets(odd)).toBe(odd)
  })
})

describe('USER_LOCATION_COLUMNS (PROFILESPREAD.1: no settings)', () => {
  it('is exactly the client identity: no settings, no credential column', () => {
    const cols = USER_LOCATION_COLUMNS.split(',').map((s) => s.trim())
    expect(cols).toEqual([...CLIENT_LOCATION_COLUMNS])
    for (const needed of ['id', 'name', 'organization_id', 'features', 'active', 'is_host_anchor', 'slug', 'country', 'timezone']) {
      expect(cols).toContain(needed)
    }
    expect(cols).not.toContain('settings')
    expect(cols).not.toContain('*')
    expect(cols).not.toContain('sensibo_api_key')
    expect(cols).not.toContain('thinq_pat')
  })
})

describe('toUserLocation / toUserLinkedLocations', () => {
  const RAW = { id: 'l1', name: 'A', organization_id: 'o', active: true, settings: { customer_agent: { test_phones: ['+353000000001'] } }, sensibo_api_key: 'SYNTH-S' }

  it('keeps only the client identity columns', () => {
    expect(toUserLocation(RAW)).toEqual({ id: 'l1', name: 'A', organization_id: 'o', active: true })
  })

  it('returns the SAME object when there is nothing to drop', () => {
    const clean = { id: 'l1', name: 'A' }
    expect(toUserLocation(clean)).toBe(clean)
  })

  it('passes a non-object through', () => {
    expect(toUserLocation(null)).toBe(null)
    expect(toUserLocation(undefined)).toBe(undefined)
  })

  it('maps a profile_locations embed', () => {
    expect(toUserLinkedLocations([{ location_id: 'l1', locations: RAW }])).toEqual([{ location_id: 'l1', locations: { id: 'l1', name: 'A', organization_id: 'o', active: true } }])
    expect(toUserLinkedLocations(null)).toBe(null)
  })
})

describe('redactLinkedLocations / redactProfileLocations', () => {
  it('redacts the embedded location of every profile_locations link', () => {
    const links = [{ location_id: 'loc-1', role: 'staff', locations: ROW }, { location_id: 'loc-2', role: 'staff', locations: null }]
    const out = redactLinkedLocations(links)
    expect(out[0].locations.sensibo_api_key).toBe(LOCATION_SECRET_MASK)
    expect(out[0].role).toBe('staff')
    expect(out[1]).toBe(links[1])
    expect(redactLinkedLocations(null)).toBeNull()
  })

  it('redacts a staff row and passes a row without links through', () => {
    const profile = { id: 'p', full_name: 'A', profile_locations: [{ location_id: 'loc-1', locations: ROW }] }
    expect(JSON.stringify(redactProfileLocations(profile))).not.toMatch(/SYNTH-/)
    const bare = { id: 'p' }
    expect(redactProfileLocations(bare)).toBe(bare)
    expect(redactProfileLocations(null)).toBeNull()
  })
})
