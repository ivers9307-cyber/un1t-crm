// ACDEVLOC.1 — the locations row as it may cross to the browser.
import { describe, it, expect } from 'vitest'
import { toClientLocation, LOCATION_SECRET_COLUMNS } from './location-client-shape.js'

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
})
