// ACDEVLOC.1 — the locations row as the settings page passes it in its `location` prop (the `user` prop is masked by C35 SECFIX.3a; this prop's settings credentials are SECFIX.3b).
import { describe, it, expect } from 'vitest'
import { toClientLocation, LOCATION_SECRET_COLUMNS } from './location-client-shape.js'
import { LOCATION_SECRET_MASK } from './location-secrets.js'

describe('toClientLocation', () => {
  it('drops the Sensibo key and ThinQ PAT and says whether each is set', () => {
    const row = { id: 'loc-1', name: 'Studio', sensibo_api_key: 'sk-synthetic', thinq_pat: 'pat-synthetic', thinq_client_id: 'cid' }
    const out = toClientLocation(row)
    expect(out).toEqual({ id: 'loc-1', name: 'Studio', thinq_client_id: 'cid', has_sensibo_key: true, has_thinq_pat: true })
    expect(JSON.stringify(out)).not.toContain('synthetic')
    expect(row.sensibo_api_key).toBe('sk-synthetic') // input untouched
  })

  it('empty or missing secrets read as not set', () => {
    expect(toClientLocation({ id: 'x', sensibo_api_key: '', thinq_pat: null })).toEqual({ id: 'x', has_sensibo_key: false, has_thinq_pat: false })
    expect(toClientLocation({ id: 'x' })).toEqual({ id: 'x', has_sensibo_key: false, has_thinq_pat: false })
  })

  it('passes a missing row through', () => {
    expect(toClientLocation(null)).toBeNull()
  })

  it('names exactly the two AC credentials', () => {
    expect(LOCATION_SECRET_COLUMNS).toEqual(['sensibo_api_key', 'thinq_pat'])
  })

  it('SECFIX.3b: masks the Glofox and UniFi credentials inside settings, keeps the rest', () => {
    const out = toClientLocation({
      id: 'x', sensibo_api_key: 'SYNTH-S', thinq_pat: null,
      settings: { glofox: { branch_id: 'b', api_key: 'SYNTH-G' }, unifi: { api_token: 'SYNTH-U' }, payments: { provider: 'stripe_connect' } },
    })
    expect(out.settings.glofox).toEqual({ branch_id: 'b', api_key: LOCATION_SECRET_MASK })
    expect(out.settings.unifi.api_token).toBe(LOCATION_SECRET_MASK)
    expect(out.settings.payments).toEqual({ provider: 'stripe_connect' })
    expect(out).not.toHaveProperty('sensibo_api_key')
    expect(out.has_sensibo_key).toBe(true)
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-/)
  })

  it('SECFIX.3b: masks any other secret-named key inside settings too', () => {
    const out = toClientLocation({ id: 'x', settings: { some_new_integration: { access_token: 'SYNTH-NEW', region: 'eu' } } })
    expect(out.settings.some_new_integration).toEqual({ access_token: LOCATION_SECRET_MASK, region: 'eu' })
  })

  it('SECFIX.3b: keeps bca_config whole (no credential; the BCA tab prefills from it and its status reads send_from)', () => {
    const bca = { send_from: 'cars@example.test', send_to: 'bca@example.test', documents: [{ slug: 'doc_01', label: 'V5' }] }
    const out = toClientLocation({ id: 'x', bca_config: bca, settings: { glofox: { api_key: 'SYNTH-G' } } })
    expect(out.bca_config).toEqual(bca)
    expect(toClientLocation({ id: 'x' })).not.toHaveProperty('bca_config')
  })
})
