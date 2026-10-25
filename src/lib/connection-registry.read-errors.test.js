// src/lib/connection-registry.read-errors.test.js
// REGISTRYREAD.1a — a registry/legacy read that FAILED is never an empty
// answer. Readers return { value, error } and never log; the old-contract
// wrappers keep their return values and log what they swallow; the
// registry→legacy fallback stays fail-open (legacy is the written source of
// truth during dual-write, and serves the same values).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { logError, logWarn } from './log'
import {
  readActiveConnections,
  fetchActiveConnections,
  readConnection,
  readGlofoxConfig,
  getGlofoxConfig,
  overlayConnectionsMany,
  findGlofoxConfigByBranchId,
  syncConnectionFromLegacy,
} from './connection-registry.js'

const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }

// answers[table] = { data, error } for reads, or 'throw' (transport failure).
// answers['<table>:update'] / ['<table>:insert'] answer writes.
function fakeDb(answers = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (answers[table] === 'throw') throw new Error(`${table} unreachable`)
      const st = { op: 'select', payload: null }
      const settle = () => {
        if (st.op === 'update') {
          writes.push({ table, op: 'update', payload: st.payload })
          return answers[`${table}:update`] ?? { data: null, error: null }
        }
        if (st.op === 'insert') {
          writes.push({ table, op: 'insert', payload: st.payload })
          return answers[`${table}:insert`] ?? { data: null, error: null }
        }
        return answers[table] ?? { data: [], error: null }
      }
      const b = {
        select: () => b, eq: () => b, in: () => b, limit: () => b, filter: () => b,
        update: (p) => { st.op = 'update'; st.payload = p; return b },
        insert: (p) => { st.op = 'insert'; st.payload = p; return b },
        maybeSingle: async () => settle(),
        then: (resolve, reject) => Promise.resolve(settle()).then(resolve, reject),
      }
      return b
    },
  }
}

const GLOFOX_ROW = {
  id: 'row-g', location_id: 'loc-1', platform: 'glofox', status: 'connected', is_active: true,
  label: null, display_name: null, external_account_id: 'b123', access_token: 'k-abc',
  app_secret: 'wh-xyz', config: { api_token: 't-def', namespace: 'untstillorgan' },
  token_expires_at: null, last_error: null, last_ok_at: null,
}
const LEGACY_LOC = { id: 'loc-1', settings: { glofox: { branch_id: 'b123', api_key: 'k-abc', api_token: 't-def', webhook_secret: 'wh-xyz' } } }

beforeEach(() => vi.clearAllMocks())

describe('readActiveConnections', () => {
  it('a failed read is { rows: [], error }, never a bare empty list', async () => {
    const out = await readActiveConnections(fakeDb({ channel_connections: { data: null, error: BOOM } }), 'loc-1', ['glofox'])
    expect(out).toEqual({ rows: [], error: BOOM })
  })
  it('a transport throw is an error too', async () => {
    const out = await readActiveConnections(fakeDb({ channel_connections: 'throw' }), 'loc-1', ['glofox'])
    expect(out.rows).toEqual([])
    expect(out.error).toBeInstanceOf(Error)
  })
  it('rows come back with no error, and nothing is logged by a reader', async () => {
    const out = await readActiveConnections(fakeDb({ channel_connections: { data: [GLOFOX_ROW], error: null } }), 'loc-1', ['glofox'])
    expect(out).toEqual({ rows: [GLOFOX_ROW], error: null })
    expect(logWarn).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('fetchActiveConnections (old contract, fail-open)', () => {
  it('still answers [] on a failed read, and now says so', async () => {
    const rows = await fetchActiveConnections(fakeDb({ channel_connections: { data: null, error: BOOM } }), 'loc-1', ['glofox'])
    expect(rows).toEqual([])
    expect(logWarn).toHaveBeenCalledOnce()
    expect(logWarn.mock.calls[0][0]).toBe('connection-registry')
  })
})

describe('readConnection', () => {
  it('prefers the active registry row and never reads legacy', async () => {
    const db = fakeDb({ channel_connections: { data: [GLOFOX_ROW], error: null }, locations: 'throw' })
    const { conn, error } = await readConnection(db, 'loc-1', 'glofox')
    expect(error).toBeNull()
    expect(conn.source).toBe('registry')
    expect(conn.externalAccountId).toBe('b123')
  })

  it('registry fails, legacy answers → the legacy connection, no error, one warn (fail-open kept)', async () => {
    const db = fakeDb({ channel_connections: { data: null, error: BOOM }, locations: { data: LEGACY_LOC, error: null } })
    const { conn, error } = await readConnection(db, 'loc-1', 'glofox')
    expect(error).toBeNull()
    expect(conn).toMatchObject({ source: 'legacy', status: 'connected', externalAccountId: 'b123', accessToken: 'k-abc' })
    expect(logWarn).toHaveBeenCalledOnce()
  })

  it('no registry row and the legacy read FAILS → { conn: null, error }, never "not connected"', async () => {
    const db = fakeDb({ channel_connections: { data: [], error: null }, locations: { data: null, error: BOOM } })
    const out = await readConnection(db, 'loc-1', 'glofox')
    expect(out).toEqual({ conn: null, error: BOOM })
  })

  it('both reads fail → an error, not a connection', async () => {
    const db = fakeDb({ channel_connections: 'throw', locations: 'throw' })
    const out = await readConnection(db, 'loc-1', 'glofox')
    expect(out.conn).toBeNull()
    expect(out.error).toBeInstanceOf(Error)
  })

  it('a location with genuinely no config is not_connected with no error (a real answer)', async () => {
    const db = fakeDb({ channel_connections: { data: [], error: null }, locations: { data: { id: 'loc-1', settings: {} }, error: null } })
    const { conn, error } = await readConnection(db, 'loc-1', 'glofox')
    expect(error).toBeNull()
    expect(conn.status).toBe('not_connected')
  })

  it('throws on an unknown platform (a programming error)', async () => {
    await expect(readConnection(fakeDb(), 'loc-1', 'whatsapp')).rejects.toThrow(/unknown platform/)
  })
})

describe('readGlofoxConfig / getGlofoxConfig', () => {
  it('readGlofoxConfig: an unanswered read is { cfg: {}, error } — the error is what tells it from "not configured"', async () => {
    const db = fakeDb({ channel_connections: { data: [], error: null }, locations: { data: null, error: BOOM } })
    expect(await readGlofoxConfig(db, 'loc-1')).toEqual({ cfg: {}, error: BOOM })
  })
  it('readGlofoxConfig: an unconfigured studio is { cfg: {}, error: null }', async () => {
    const db = fakeDb({ channel_connections: { data: [], error: null }, locations: { data: { id: 'loc-1', settings: {} }, error: null } })
    expect(await readGlofoxConfig(db, 'loc-1')).toEqual({ cfg: {}, error: null })
  })
  it('getGlofoxConfig keeps answering {} on a failed read, and logs it as an error once', async () => {
    const db = fakeDb({ channel_connections: { data: [], error: null }, locations: { data: null, error: BOOM } })
    expect(await getGlofoxConfig(db, 'loc-1')).toEqual({})
    expect(logError).toHaveBeenCalledOnce()
    expect(logError.mock.calls[0][0]).toBe('connection-registry')
  })
})

describe('overlayConnectionsMany / findGlofoxConfigByBranchId (fail-open, now logged)', () => {
  it('overlayConnectionsMany returns the input unchanged on a failed read and warns', async () => {
    const locs = [{ id: 'loc-1' }]
    const out = await overlayConnectionsMany(fakeDb({ channel_connections: { data: null, error: BOOM } }), locs, ['unifi'])
    expect(out).toEqual(locs)
    expect(logWarn).toHaveBeenCalledOnce()
  })
  it('findGlofoxConfigByBranchId answers null on a failed read (the caller falls back to legacy) and warns', async () => {
    const out = await findGlofoxConfigByBranchId(fakeDb({ channel_connections: { data: null, error: BOOM } }), 'b123')
    expect(out).toBeNull()
    expect(logWarn).toHaveBeenCalledOnce()
  })
})

describe('syncConnectionFromLegacy — a failed read is never "no active row"', () => {
  it('DISCONNECT with a failed read throws and writes nothing (it used to answer noop and leave the old credentials ACTIVE)', async () => {
    const db = fakeDb({ channel_connections: { data: null, error: BOOM } })
    await expect(syncConnectionFromLegacy(db, 'loc-1', 'glofox', { id: 'loc-1', settings: {} }))
      .rejects.toThrow(/registry sync \(glofox\): read failed/)
    expect(db.writes).toEqual([])
  })

  it('SAVE with a failed read throws and never inserts a second active row', async () => {
    const db = fakeDb({ channel_connections: { data: null, error: BOOM } })
    await expect(syncConnectionFromLegacy(db, 'loc-1', 'glofox', LEGACY_LOC))
      .rejects.toThrow(/read failed/)
    expect(db.writes).toEqual([])
  })

  it('a failed deactivate throws (it was a bare UPDATE answering "deactivated")', async () => {
    const db = fakeDb({
      channel_connections: { data: { id: 'row-g' }, error: null },
      'channel_connections:update': { data: null, error: BOOM },
    })
    await expect(syncConnectionFromLegacy(db, 'loc-1', 'glofox', { id: 'loc-1', settings: {} }))
      .rejects.toThrow(/registry sync \(glofox\): deactivate failed/)
  })

  it('happy path unchanged: an active row + cleared legacy → deactivated', async () => {
    const db = fakeDb({ channel_connections: { data: { id: 'row-g' }, error: null } })
    const out = await syncConnectionFromLegacy(db, 'loc-1', 'glofox', { id: 'loc-1', settings: {} })
    expect(out).toEqual({ action: 'deactivated' })
    expect(db.writes).toEqual([{ table: 'channel_connections', op: 'update', payload: expect.objectContaining({ is_active: false }) }])
  })
})
