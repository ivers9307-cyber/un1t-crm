// SECFIX.3a — the location-row redaction every browser-bound path uses.
import { describe, it, expect } from 'vitest'
import {
  LOCATION_SECRET_MASK, USER_LOCATION_COLUMNS, CLIENT_LOCATION_COLUMNS,
  redactLocationSecrets, redactLinkedLocations, redactProfileLocations,
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

  it('passes non-objects and odd shapes through', () => {
    expect(redactLocationSecrets(null)).toBeNull()
    expect(redactLocationSecrets(undefined)).toBeUndefined()
    const odd = { id: 'x', settings: { glofox: 'not-an-object', unifi: ['arr'] } }
    expect(redactLocationSecrets(odd)).toBe(odd)
  })
})

describe('USER_LOCATION_COLUMNS', () => {
  it('names the identity the user object\'s readers use, plus settings, and no credential column', () => {
    const cols = USER_LOCATION_COLUMNS.split(',').map((s) => s.trim())
    for (const needed of ['id', 'name', 'organization_id', 'features', 'active', 'is_host_anchor', 'slug', 'country', 'timezone', 'settings']) {
      expect(cols).toContain(needed)
    }
    expect(cols).not.toContain('*')
    expect(cols).not.toContain('sensibo_api_key')
    expect(cols).not.toContain('thinq_pat')
    expect(cols).toEqual([...CLIENT_LOCATION_COLUMNS, 'settings'])
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
