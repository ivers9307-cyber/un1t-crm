import { describe, it, expect } from 'vitest'
import {
  DUAL_READ_PLATFORMS,
  registryRowFromLegacy,
  applyConnectionRow,
  applyConnectionOverlay,
  normalizeConnectionRow,
  normalizeLegacyConnection,
  getConnection,
  getGlofoxConfig,
  overlayConnections,
  overlayConnectionsMany,
} from './connection-registry.js'

// ── fixtures ─────────────────────────────────────────────────

const LOC = {
  id: 'loc-1',
  settings: {
    glofox: {
      branch_id: 'b123',
      api_key: 'k-abc',
      api_token: 't-def',
      webhook_secret: 'wh-xyz',
      namespace: 'untstillorgan',
      trial_membership_id: 'm1',
      trial_plan_code: 'p1',
      hidden_class_keywords: ['private'],
    },
    unifi: {
      host: 'https://door.local:12445',
      api_token: 'unifi-tok',
      staff_policy_id: 'sp1',
      manager_policy_id: 'mp1',
      allow_self_signed: true,
      controller_id: 'ctrl-9',
    },
    inbody: { accounts: [] }, // sibling settings key — must survive overlays
  },
  sensibo_api_key: 'sens-key',
  sensibo_pod_id: 'pod-7',
  thinq_pat: 'thinq-pat',
  thinq_client_id: 'client-1',
  thinq_country_code: 'IE',
  twilio_alpha_sender_id: 'UN1T',
  bca_config: { send_from: 'a@b.ie', send_to: 'c@d.ie' },
  features: { bca_submit: true },
}

function rowFor(platform, fields) {
  return {
    id: `row-${platform}`,
    location_id: 'loc-1',
    platform,
    status: 'connected',
    is_active: true,
    label: null,
    display_name: null,
    external_account_id: null,
    access_token: null,
    app_secret: null,
    config: {},
    token_expires_at: null,
    last_error: null,
    last_ok_at: null,
    ...fields,
  }
}

// A db mock whose channel_connections query resolves to `rows` and
// whose locations query resolves to `location`. Chain shape mirrors
// the calls the accessor makes.
function mockDb({ rows = [], location = null, failRegistry = false } = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      queries.push(table)
      if (table === 'channel_connections') {
        if (failRegistry) throw new Error('registry down')
        // Thenable chain, like the real supabase-js builder.
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }),
          then: (resolve, reject) =>
            Promise.resolve({ data: rows, error: null }).then(resolve, reject),
        }
        return chain
      }
      if (table === 'locations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: location, error: null }),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

// ── registryRowFromLegacy: the mig 412 mapping ───────────────

describe('registryRowFromLegacy', () => {
  it('glofox: branch_id/api_key/webhook_secret map to registry columns, the rest to config', () => {
    const row = registryRowFromLegacy('glofox', LOC)
    expect(row.external_account_id).toBe('b123')
    expect(row.access_token).toBe('k-abc')
    expect(row.app_secret).toBe('wh-xyz')
    expect(row.config).toEqual({
      api_token: 't-def',
      namespace: 'untstillorgan',
      trial_membership_id: 'm1',
      trial_plan_code: 'p1',
      hidden_class_keywords: ['private'],
    })
  })

  it('unifi: api_token maps to access_token, the rest (incl. controller_id) to config', () => {
    const row = registryRowFromLegacy('unifi', LOC)
    expect(row.access_token).toBe('unifi-tok')
    expect(row.config).toEqual({
      host: 'https://door.local:12445',
      staff_policy_id: 'sp1',
      manager_policy_id: 'mp1',
      allow_self_signed: true,
      controller_id: 'ctrl-9',
    })
  })

  it('sensibo / thinq / twilio_sender / bca map their columns', () => {
    expect(registryRowFromLegacy('sensibo', LOC)).toEqual({
      access_token: 'sens-key',
      config: { pod_id: 'pod-7' },
    })
    expect(registryRowFromLegacy('thinq', LOC)).toEqual({
      access_token: 'thinq-pat',
      config: { client_id: 'client-1', country_code: 'IE' },
    })
    expect(registryRowFromLegacy('twilio_sender', LOC)).toEqual({
      config: { sender_id: 'UN1T' },
    })
    expect(registryRowFromLegacy('bca', LOC)).toEqual({
      config: { send_from: 'a@b.ie', send_to: 'c@d.ie' },
    })
  })

  it('returns null when the location has no legacy config for the platform', () => {
    const bare = { id: 'loc-2', settings: {} }
    for (const p of DUAL_READ_PLATFORMS) {
      expect(registryRowFromLegacy(p, bare)).toBeNull()
    }
    // empty object counts as unconfigured (mirrors the mig 412 gate)
    expect(registryRowFromLegacy('glofox', { settings: { glofox: {} } })).toBeNull()
    expect(registryRowFromLegacy('bca', { bca_config: {} })).toBeNull()
  })

  it('thinq is configured when only client_id is set (mirrors mig 412 OR gate)', () => {
    const row = registryRowFromLegacy('thinq', { thinq_client_id: 'c9' })
    expect(row).toEqual({ access_token: null, config: { client_id: 'c9' } })
  })
})

// ── round trip: legacy → row → overlay reproduces legacy ─────

describe('legacy → registry → overlay round trip', () => {
  it('is field-equivalent for every platform', () => {
    let overlaid = { ...LOC }
    for (const platform of DUAL_READ_PLATFORMS) {
      const fields = registryRowFromLegacy(platform, LOC)
      overlaid = applyConnectionRow(overlaid, rowFor(platform, fields))
    }
    expect(overlaid.settings.glofox).toEqual(LOC.settings.glofox)
    expect(overlaid.settings.unifi).toEqual(LOC.settings.unifi)
    expect(overlaid.settings.inbody).toEqual(LOC.settings.inbody) // sibling untouched
    expect(overlaid.sensibo_api_key).toBe(LOC.sensibo_api_key)
    expect(overlaid.sensibo_pod_id).toBe(LOC.sensibo_pod_id)
    expect(overlaid.thinq_pat).toBe(LOC.thinq_pat)
    expect(overlaid.thinq_client_id).toBe(LOC.thinq_client_id)
    expect(overlaid.thinq_country_code).toBe(LOC.thinq_country_code)
    expect(overlaid.twilio_alpha_sender_id).toBe(LOC.twilio_alpha_sender_id)
    expect(overlaid.bca_config).toEqual(LOC.bca_config)
    expect(overlaid.features).toEqual(LOC.features) // never touched
  })
})

// ── overlay behaviour ────────────────────────────────────────

describe('applyConnectionOverlay', () => {
  it('registry values REPLACE legacy values for platforms with a row', () => {
    const row = rowFor('twilio_sender', { config: { sender_id: 'NEWNAME' } })
    const out = applyConnectionOverlay(LOC, [row])
    expect(out.twilio_alpha_sender_id).toBe('NEWNAME')
    // input not mutated
    expect(LOC.twilio_alpha_sender_id).toBe('UN1T')
  })

  it('platforms without a row keep legacy values', () => {
    const row = rowFor('sensibo', { access_token: 'new-sens' })
    const out = applyConnectionOverlay(LOC, [row])
    expect(out.sensibo_api_key).toBe('new-sens')
    expect(out.thinq_pat).toBe('thinq-pat')
    expect(out.settings.glofox.api_key).toBe('k-abc')
  })

  it('unknown platforms are a no-op (whatsapp/instagram rows never leak in)', () => {
    const out = applyConnectionOverlay(LOC, [rowFor('instagram', { access_token: 'ig' })])
    expect(out).toEqual(LOC)
  })

  it('glofox/unifi overlays merge into settings without clobbering siblings', () => {
    const row = rowFor('unifi', {
      access_token: 'rotated-tok',
      config: { host: 'https://new.local', staff_policy_id: 'sp2', manager_policy_id: 'mp2' },
    })
    const out = applyConnectionOverlay(LOC, [row])
    expect(out.settings.unifi).toEqual({
      host: 'https://new.local',
      staff_policy_id: 'sp2',
      manager_policy_id: 'mp2',
      api_token: 'rotated-tok',
    })
    expect(out.settings.glofox).toEqual(LOC.settings.glofox)
    expect(out.settings.inbody).toEqual(LOC.settings.inbody)
  })
})

// ── normalized shapes ────────────────────────────────────────

describe('normalizeConnectionRow / normalizeLegacyConnection', () => {
  it('normalizes a registry row', () => {
    const conn = normalizeConnectionRow(rowFor('glofox', {
      external_account_id: 'b1', access_token: 'k1', app_secret: 's1',
      config: { namespace: 'ns' }, status: 'action_needed',
    }))
    expect(conn).toMatchObject({
      source: 'registry', platform: 'glofox', locationId: 'loc-1',
      status: 'action_needed', isActive: true,
      externalAccountId: 'b1', accessToken: 'k1', appSecret: 's1',
      config: { namespace: 'ns' },
    })
  })

  it('normalizes legacy fields with the SAME mapping', () => {
    const conn = normalizeLegacyConnection('glofox', LOC)
    expect(conn).toMatchObject({
      source: 'legacy', platform: 'glofox', locationId: 'loc-1',
      status: 'connected', isActive: true,
      externalAccountId: 'b123', accessToken: 'k-abc', appSecret: 'wh-xyz',
    })
    expect(conn.config.namespace).toBe('untstillorgan')
  })

  it('legacy-unconfigured → not_connected with empty config', () => {
    const conn = normalizeLegacyConnection('bca', { id: 'loc-2' })
    expect(conn.status).toBe('not_connected')
    expect(conn.isActive).toBe(false)
    expect(conn.config).toEqual({})
  })
})

// ── async accessors ──────────────────────────────────────────

describe('getConnection', () => {
  it('prefers the active registry row', async () => {
    const db = mockDb({ rows: [rowFor('sensibo', { access_token: 'reg-key' })] })
    const conn = await getConnection(db, 'loc-1', 'sensibo')
    expect(conn.source).toBe('registry')
    expect(conn.accessToken).toBe('reg-key')
    expect(db.queries).toEqual(['channel_connections'])
  })

  it('falls back to legacy location fields when no row exists', async () => {
    const db = mockDb({ rows: [], location: { id: 'loc-1', sensibo_api_key: 'leg-key', sensibo_pod_id: 'p1' } })
    const conn = await getConnection(db, 'loc-1', 'sensibo')
    expect(conn.source).toBe('legacy')
    expect(conn.accessToken).toBe('leg-key')
    expect(conn.config).toEqual({ pod_id: 'p1' })
  })

  it('throws on an unknown platform', async () => {
    await expect(getConnection(mockDb(), 'loc-1', 'whatsapp')).rejects.toThrow(/unknown platform/)
  })
})

describe('getGlofoxConfig', () => {
  it('returns the settings.glofox shape from a registry row', async () => {
    const db = mockDb({
      rows: [rowFor('glofox', registryRowFromLegacy('glofox', LOC))],
    })
    const cfg = await getGlofoxConfig(db, 'loc-1')
    expect(cfg).toEqual(LOC.settings.glofox)
  })

  it('returns {} for an unconfigured legacy location', async () => {
    const db = mockDb({ rows: [], location: { id: 'loc-1', settings: {} } })
    expect(await getGlofoxConfig(db, 'loc-1')).toEqual({})
  })
})

describe('overlayConnections (fail-open)', () => {
  it('returns the input unchanged when the registry query fails', async () => {
    const db = mockDb({ failRegistry: true })
    const out = await overlayConnections(db, LOC, ['sensibo'])
    expect(out).toBe(LOC)
  })

  it('returns the input unchanged with no db or no location id', async () => {
    expect(await overlayConnections(null, LOC)).toBe(LOC)
    expect(await overlayConnections(mockDb(), { name: 'no-id' })).toEqual({ name: 'no-id' })
  })

  it('applies rows when present', async () => {
    const db = mockDb({ rows: [rowFor('twilio_sender', { config: { sender_id: 'REGNAME' } })] })
    const out = await overlayConnections(db, LOC, ['twilio_sender'])
    expect(out.twilio_alpha_sender_id).toBe('REGNAME')
  })
})

describe('overlayConnectionsMany', () => {
  it('overlays each location from one batched query', async () => {
    const locA = { id: 'loc-1', settings: { unifi: { host: 'old-a', api_token: 'a' } } }
    const locB = { id: 'loc-2', settings: { unifi: { host: 'old-b', api_token: 'b' } } }
    const rows = [
      { ...rowFor('unifi', { access_token: 'new-a', config: { host: 'new-a-host' } }), location_id: 'loc-1' },
    ]
    const db = mockDb({ rows })
    const out = await overlayConnectionsMany(db, [locA, locB], ['unifi'])
    expect(out[0].settings.unifi).toEqual({ host: 'new-a-host', api_token: 'new-a' })
    expect(out[1]).toBe(locB) // no row → untouched
  })

  it('fail-open on registry error', async () => {
    const db = mockDb({ failRegistry: true })
    const locs = [{ id: 'loc-1' }]
    expect(await overlayConnectionsMany(db, locs, ['unifi'])).toEqual(locs)
  })
})
