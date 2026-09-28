// STAFFFORMSETTINGS.1 — what the staff editor (StaffForm, a client component)
// may know about each studio: its identity (CLIENT_LOCATION_COLUMNS) and
// whether UniFi is configured there, computed on the server by the SAME rule
// the save path uses. Never `settings`: it carried customer_agent.test_phones
// (staff phone numbers) and every integration's config into the page.
// Fictional values only (public repo).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { collectSchema, parseSelect } from '../../scripts/check-select-columns.mjs'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./connection-registry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  overlayConnectionsMany: vi.fn(async (_db, rows) => rows),
}))

import { loadStaffFormLocations, STAFF_FORM_LOCATION_SELECT } from './staff-form-locations.js'
import { CLIENT_LOCATION_COLUMNS } from './location-secrets.js'
import { overlayConnectionsMany } from './connection-registry.js'
import { logError } from './log.js'

const A = 'a0000000-0000-4000-8000-00000000000a'
const B = 'b0000000-0000-4000-8000-00000000000b'
const C = 'c0000000-0000-4000-8000-00000000000c'

const UNIFI_OK = { host: 'https://unifi.example.test', api_token: 'SYNTH-UT', staff_policy_id: 'p-staff', manager_policy_id: 'p-mgr' }

const row = (id, name, settings = {}) => ({
  id, name, slug: name.toLowerCase(), address: null, phone: null, email: null, timezone: 'Europe/Dublin',
  active: true, created_at: 'T', updated_at: 'T', country: 'IE', features: { pipeline: true },
  organization_id: 'o0000000-0000-4000-8000-000000000001', is_host_anchor: false,
  settings,
  // a column the select does not name, as a widened select or a raw fixture might carry
  sensibo_api_key: 'SYNTH-SENSIBO',
})

function makeDb(result) {
  const calls = { select: null, filters: [], order: null }
  const chain = {
    select: (cols) => { calls.select = cols; return chain },
    eq: (col, val) => { calls.filters.push([col, val]); return chain },
    order: (col) => { calls.order = col; return chain },
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return { db: { from: (t) => { calls.table = t; return chain } }, calls }
}

beforeEach(() => { vi.clearAllMocks() })

describe('loadStaffFormLocations (STAFFFORMSETTINGS.1)', () => {
  it('names its columns (no *): the identity list plus settings, read on the server only', async () => {
    const { db, calls } = makeDb({ data: [], error: null })
    await loadStaffFormLocations(db)
    expect(calls.table).toBe('locations')
    expect(calls.select).toBe(STAFF_FORM_LOCATION_SELECT)
    expect(STAFF_FORM_LOCATION_SELECT).toBe([...CLIENT_LOCATION_COLUMNS, 'settings'].join(', '))
    expect(STAFF_FORM_LOCATION_SELECT).not.toContain('*')
    expect(calls.filters).toEqual([['active', true], ['is_host_anchor', false]])
    expect(calls.order).toBe('name')
  })

  it('each studio is the identity columns + unifi_configured, and nothing else', async () => {
    const { db } = makeDb({ data: [row(A, 'Alpha', { unifi: UNIFI_OK })], error: null })
    const { locations, error } = await loadStaffFormLocations(db)
    expect(error).toBeNull()
    expect(Object.keys(locations[0]).sort()).toEqual([...CLIENT_LOCATION_COLUMNS, 'unifi_configured'].sort())
    expect(locations[0]).toMatchObject({ id: A, name: 'Alpha', slug: 'alpha', features: { pipeline: true } })
  })

  it('no test phone, no setting and no credential reaches the result', async () => {
    const { db } = makeDb({
      data: [row(A, 'Alpha', {
        unifi: UNIFI_OK,
        customer_agent: { enabled: true, test_phones: ['+353000000000'] },
        glofox: { branch_id: 'b1', api_key: 'SYNTH-GK' },
        wati: { api_key: 'SYNTH-WATI' },
      })],
      error: null,
    })
    const { locations } = await loadStaffFormLocations(db)
    const json = JSON.stringify(locations)
    expect(json).not.toMatch(/SYNTH-|\+353000000000|test_phones|customer_agent|settings/)
  })

  it('unifi_configured follows the save path\'s rule (getLocationUnifiConfig)', async () => {
    const { db } = makeDb({
      data: [
        row(A, 'Alpha', { unifi: UNIFI_OK }),
        row(B, 'Bravo', { unifi: { ...UNIFI_OK, manager_policy_id: '' } }),
        row(C, 'Charlie', { unifi: { ...UNIFI_OK, api_token: '   ' } }),
      ],
      error: null,
    })
    const { locations } = await loadStaffFormLocations(db)
    expect(locations.map((l) => [l.name, l.unifi_configured])).toEqual([['Alpha', true], ['Bravo', false], ['Charlie', false]])
  })

  it('a studio configured only in the registry counts (one batched overlay, unifi only)', async () => {
    overlayConnectionsMany.mockImplementationOnce(async (_db, rows) =>
      rows.map((r) => (r.id === B ? { ...r, settings: { ...r.settings, unifi: UNIFI_OK } } : r)))
    const { db } = makeDb({ data: [row(A, 'Alpha'), row(B, 'Bravo')], error: null })
    const { locations } = await loadStaffFormLocations(db)
    expect(overlayConnectionsMany).toHaveBeenCalledTimes(1)
    expect(overlayConnectionsMany.mock.calls[0][2]).toEqual(['unifi'])
    expect(locations.map((l) => l.unifi_configured)).toEqual([false, true])
    expect(JSON.stringify(locations)).not.toContain('SYNTH-UT')
  })

  it('a failed read is logged (code only) and yields no studios, as the page always rendered it', async () => {
    const { db } = makeDb({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const { locations, error } = await loadStaffFormLocations(db)
    expect(locations).toEqual([])
    expect(error).toEqual({ code: '57014' })
    expect(logError).toHaveBeenCalledWith('staff-form-locations', expect.stringMatching(/locations read failed/), { code: '57014' })
    expect(overlayConnectionsMany).not.toHaveBeenCalled()
  })

  it('no rows is no studios, not an error', async () => {
    const { db } = makeDb({ data: [], error: null })
    expect(await loadStaffFormLocations(db)).toEqual({ locations: [], error: null })
  })
})

describe('StaffForm reads no location settings (STAFFFORMSETTINGS.1 D4)', () => {
  it('names .settings nowhere in code', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../components/StaffForm.jsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/\.settings\b/)
    expect(code).toMatch(/unifi_configured/)
  })
})

// CLAUDE.md: a column named in a .select() is a claim about the schema, and no
// mock checks it. check:select-columns skips this one (it reaches .select()
// through a constant), so resolve it against the same migration replay.
describe('STAFF_FORM_LOCATION_SELECT names only real columns (the check:select-columns replay)', () => {
  it('every column exists on locations', () => {
    const { schema } = collectSchema('supabase/migrations')
    const refs = parseSelect(STAFF_FORM_LOCATION_SELECT, 'locations', schema)
    expect(refs.filter((r) => !schema.get(r.table)?.has(r.column))).toEqual([])
    // The replay really read the list (a floor that read nothing proves nothing).
    for (const column of ['features', 'settings', 'is_host_anchor']) {
      expect(refs).toContainEqual({ table: 'locations', column })
    }
  })
})
