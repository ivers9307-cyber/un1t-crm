import { describe, it, expect } from 'vitest'
import {
  classifyFingerprintClash,
  publicConnectionView,
  probeConnection,
  findFingerprintRows,
  loadConnectionWithKey,
  loadPublicConnection,
  FINGERPRINT_ROW_CAP,
} from './connections'

const row = (location_id, organization_id, name) => ({ location_id, locations: { organization_id, name } })

describe('classifyFingerprintClash', () => {
  it('no rows → ok', () => expect(classifyFingerprintClash([], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: [] }))
  it('no list at all → ok (nothing holds the key)', () => expect(classifyFingerprintClash(undefined, 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: [] }))
  it('own location (re-paste) → ok', () => expect(classifyFingerprintClash([row('loc-1', 'org-A', 'Mine')], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: [] }))
  it('same org, other location → ok and named', () => {
    expect(classifyFingerprintClash([row('loc-2', 'org-A', 'Hatch Street')], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: ['Hatch Street'] })
  })
  it('another organisation → refused, without naming it', () => {
    const r = classifyFingerprintClash([row('loc-9', 'org-B', 'Rival Gym')], 'org-A', 'loc-1')
    expect(r).toEqual({ ok: false, reason: 'other_org' })
    expect(JSON.stringify(r)).not.toContain('Rival')
  })

  // One foreign holder outvotes any number of legitimate same-org ones, and
  // the names collected before it are discarded along with everything else.
  it('same-org AND other-org holders → refused, and neither name leaks', () => {
    const rows = [row('loc-2', 'org-A', 'Hatch Street'), row('loc-9', 'org-B', 'Rival Gym')]
    const r = classifyFingerprintClash(rows, 'org-A', 'loc-1')
    expect(r).toEqual({ ok: false, reason: 'other_org' })
    expect(JSON.stringify(r)).not.toContain('Rival')
    expect(JSON.stringify(r)).not.toContain('Hatch')
  })

  it('a holder whose location embed is missing → refused (an unknown org is not our org)', () => {
    expect(classifyFingerprintClash([{ location_id: 'loc-9' }], 'org-A', 'loc-1')).toEqual({ ok: false, reason: 'other_org' })
    expect(classifyFingerprintClash([null], 'org-A', 'loc-1')).toEqual({ ok: false, reason: 'other_org' })
  })

  // The caller-side silent failure: a route that forgot to carry the org id
  // would otherwise match undefined against undefined and wave every foreign
  // key through.
  it('a blank organizationId can never match, even against a blank holder org', () => {
    expect(classifyFingerprintClash([row('loc-9', null, 'Ghost')], null, 'loc-1')).toEqual({ ok: false, reason: 'other_org' })
    expect(classifyFingerprintClash([row('loc-9', undefined, 'Ghost')], undefined, 'loc-1')).toEqual({ ok: false, reason: 'other_org' })
  })

  // A blank locationId means no row can be recognised as ours, so every row
  // is judged on its organisation — a foreign holder is still refused, never
  // skipped as a "re-paste" because two blanks compared equal.
  it('a blank locationId never lets a holder pass as our own row', () => {
    expect(classifyFingerprintClash([row(null, 'org-B', 'Rival Gym')], 'org-A', null)).toEqual({ ok: false, reason: 'other_org' })
    expect(classifyFingerprintClash([row(null, 'org-A', 'Mine')], 'org-A', null)).toEqual({ ok: true, shared_with: ['Mine'] })
  })

  it('a same-org holder with no name is still counted, unnamed', () => {
    expect(classifyFingerprintClash([row('loc-2', 'org-A', null)], 'org-A', 'loc-1')).toEqual({ ok: true, shared_with: ['another location'] })
  })
})

describe('publicConnectionView', () => {
  it('never includes the key or fingerprint', () => {
    const v = publicConnectionView({ id: 'c1', host: 'shelly-1-eu.shelly.cloud', auth_key: 'SECRET', auth_key_fingerprint: 'f'.repeat(64), key_hint: 'CRET', status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null })
    expect(v).toEqual({ host: 'shelly-1-eu.shelly.cloud', key_hint: 'CRET', has_auth_key: true, status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null })
    expect(JSON.stringify(v)).not.toContain('SECRET')
    expect(JSON.stringify(v)).not.toContain('f'.repeat(64))
  })

  // An allowlist, not a filter: a column added to the table later must not
  // start appearing in a route response because the view spread the row.
  it('drops every column it does not name, including ones added later', () => {
    const v = publicConnectionView({
      host: 'shelly-1-eu.shelly.cloud', key_hint: 'CRET', status: 'connected',
      auth_key: 'SECRET', auth_key_fingerprint: 'f'.repeat(64), linked_by: 'user-1',
      id: 'c1', location_id: 'loc-1', created_at: 'T', updated_at: 'T', some_future_secret: 'nope',
    })
    expect(Object.keys(v).sort()).toEqual(['has_auth_key', 'host', 'key_hint', 'last_error', 'last_error_at', 'last_ok_at', 'status'])
    expect(JSON.stringify(v)).not.toContain('nope')
    expect(JSON.stringify(v)).not.toContain('user-1')
  })

  it('has_auth_key follows the hint rather than claiming true for a partial row', () => {
    expect(publicConnectionView({}).has_auth_key).toBe(false)
    expect(publicConnectionView({ key_hint: '' }).has_auth_key).toBe(false)
    expect(publicConnectionView({ key_hint: 'CRET' }).has_auth_key).toBe(true)
  })

  it('a partial row yields nulls, never missing keys', () => {
    expect(publicConnectionView({})).toEqual({ host: null, key_hint: null, has_auth_key: false, status: null, last_ok_at: null, last_error: null, last_error_at: null })
  })
})

describe('probeConnection', () => {
  const mk = (res) => ({ makeClient: () => ({ allStatus: async () => res }) })

  it('maps auth, network and ok (with a device count)', async () => {
    expect(await probeConnection({}, mk({ ok: false, kind: 'auth', statusCode: 401 }))).toEqual({ ok: false, kind: 'auth', statusCode: 401 })
    expect(await probeConnection({}, mk({ ok: false, kind: 'network', statusCode: 0 }))).toEqual({ ok: false, kind: 'network', statusCode: 0 })
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200, body: { isok: true, data: { devices_status: { a: {}, b: {} } } } }))).toEqual({ ok: true, deviceCount: 2 })
  })

  // 'config' means the client refused the pasted host and made NO request. The
  // tag has to survive, because the operator's fix is "correct the host", not
  // "check your key".
  it('passes a config failure (bad host, no request made) straight through', async () => {
    expect(await probeConnection({ host: 'evil.example' }, mk({ ok: false, kind: 'config', statusCode: 0 }))).toEqual({ ok: false, kind: 'config', statusCode: 0 })
  })

  it('passes rate_limited through rather than reading it as a bad key', async () => {
    expect(await probeConnection({}, mk({ ok: false, kind: 'rate_limited', statusCode: 429 }))).toEqual({ ok: false, kind: 'rate_limited', statusCode: 429 })
  })

  it('counts 0 devices for any body that is not the keyed devices_status object', async () => {
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200, body: { isok: true, data: { devices_status: [{}, {}] } } }))).toEqual({ ok: true, deviceCount: 0 })
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200, body: { isok: true, data: { devices_status: null } } }))).toEqual({ ok: true, deviceCount: 0 })
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200, body: null }))).toEqual({ ok: true, deviceCount: 0 })
    expect(await probeConnection({}, mk({ ok: true, statusCode: 200 }))).toEqual({ ok: true, deviceCount: 0 })
  })

  it('an ok probe carries nothing but the verdict and the count', async () => {
    const r = await probeConnection({ host: 'shelly-1-eu.shelly.cloud', auth_key: 'SECRET' }, mk({ ok: true, statusCode: 200, body: { isok: true, data: { devices_status: { a: {} } } } }))
    expect(Object.keys(r).sort()).toEqual(['deviceCount', 'ok'])
    expect(JSON.stringify(r)).not.toContain('SECRET')
  })
})

describe('db loaders', () => {
  // The plan pinned n: 50; the query now asks for CAP + 1 so that a full page
  // and a truncated read are distinguishable (SHELLY.7b). Everything else in
  // this assertion is the plan's, unchanged.
  it('findFingerprintRows selects only location + org/name and filters on the fingerprint', async () => {
    const calls = []
    const db = { from: (t) => ({ select: (cols) => ({ eq: (c, v) => ({ limit: async (n) => { calls.push({ t, cols, c, v, n }); return { data: [], error: null } } }) }) }) }
    expect(await findFingerprintRows(db, 'abc')).toEqual({ ok: true, rows: [] })
    expect(calls[0]).toMatchObject({ t: 'shelly_connections', c: 'auth_key_fingerprint', v: 'abc', n: 51 })
    expect(calls[0].cols).not.toContain('auth_key,')
    // The embed is what classifyFingerprintClash judges on — without it every
    // holder reads as an unknown org and every link is refused.
    expect(calls[0].cols).toContain('locations(organization_id, name)')
  })

  it('findFingerprintRows never selects the key or its fingerprint', async () => {
    let cols = null
    const db = { from: () => ({ select: (c) => { cols = c; return { eq: () => ({ limit: async () => ({ data: [], error: null }) }) } } }) }
    await findFingerprintRows(db, 'abc')
    expect(cols).not.toContain('auth_key')
    expect(cols).not.toContain('*')
  })

  it('findFingerprintRows reports a db error rather than an empty holder list', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }
    expect(await findFingerprintRows(db, 'abc')).toEqual({ ok: false, reason: 'db_error', error: 'boom' })
  })

  // A blank fingerprint would filter on '' — no rows, which is the answer that
  // ALLOWS the link. It must be refused before the query, not after it.
  it('findFingerprintRows refuses a blank or non-string fingerprint without querying', async () => {
    const db = { from: () => { throw new Error('must not query') } }
    for (const bad of ['', null, undefined, 123, {}]) {
      expect(await findFingerprintRows(db, bad)).toEqual({ ok: false, reason: 'blank_fingerprint' })
    }
  })

  // A holder we could not read may be the foreign one, so a truncated read is
  // a refusal the caller's !ok branch handles — never a flag on an ok result.
  it('findFingerprintRows refuses a truncated read, and accepts a full page', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => row(`loc-${i}`, 'org-A', `L${i}`))
    const db = (data) => ({ from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data, error: null }) }) }) }) })
    expect(await findFingerprintRows(db(rows(FINGERPRINT_ROW_CAP + 1)), 'abc')).toEqual({ ok: false, reason: 'fingerprint_rows_capped' })
    expect(await findFingerprintRows(db(rows(FINGERPRINT_ROW_CAP)), 'abc')).toEqual({ ok: true, rows: rows(FINGERPRINT_ROW_CAP) })
    expect(await findFingerprintRows(db(rows(3)), 'abc')).toEqual({ ok: true, rows: rows(3) })
  })

  it('loadConnectionWithKey returns not_connected on no row and db_error on error', async () => {
    const mk = (data, error) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) })
    expect(await loadConnectionWithKey(mk(null, null), 'loc')).toEqual({ ok: false, reason: 'not_connected' })
    expect(await loadConnectionWithKey(mk(null, { message: 'boom' }), 'loc')).toEqual({ ok: false, reason: 'db_error', error: 'boom' })
    expect(await loadConnectionWithKey(mk({ id: 'c1' }, null), 'loc')).toEqual({ ok: true, connection: { id: 'c1' } })
  })

  it('loadConnectionWithKey filters on location_id and hands back the whole row, key included', async () => {
    const calls = []
    const db = { from: (t) => ({ select: (cols) => ({ eq: (c, v) => { calls.push({ t, cols, c, v }); return { maybeSingle: async () => ({ data: { id: 'c1', auth_key: 'SECRET' }, error: null }) } } }) }) }
    expect(await loadConnectionWithKey(db, 'loc-1')).toEqual({ ok: true, connection: { id: 'c1', auth_key: 'SECRET' } })
    expect(calls[0]).toEqual({ t: 'shelly_connections', cols: '*', c: 'location_id', v: 'loc-1' })
  })

  it('loadPublicConnection filters on location_id, selects no secret column, and returns the public view', async () => {
    const calls = []
    const db = (data, error) => ({ from: (t) => ({ select: (cols) => ({ eq: (c, v) => { calls.push({ t, cols, c, v }); return { maybeSingle: async () => ({ data, error }) } } }) }) })
    const stored = { id: 'c1', location_id: 'loc-1', host: 'shelly-1-eu.shelly.cloud', key_hint: 'CRET', status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null, linked_by: 'user-1' }
    const res = await loadPublicConnection(db(stored, null), 'loc-1')
    expect(res).toEqual({ ok: true, connection: { host: 'shelly-1-eu.shelly.cloud', key_hint: 'CRET', has_auth_key: true, status: 'connected', last_ok_at: 'T', last_error: null, last_error_at: null } })
    expect(calls[0]).toMatchObject({ t: 'shelly_connections', c: 'location_id', v: 'loc-1' })
    // The select and the view are ONE allowlist: exactly the columns
    // publicConnectionView projects, so nothing is fetched to be discarded.
    expect(calls[0].cols.split(',').map((s) => s.trim()).sort()).toEqual(['host', 'key_hint', 'last_error', 'last_error_at', 'last_ok_at', 'status'])
    expect(await loadPublicConnection(db(null, null), 'loc-1')).toEqual({ ok: false, reason: 'not_connected' })
    expect(await loadPublicConnection(db(null, { message: 'boom' }), 'loc-1')).toEqual({ ok: false, reason: 'db_error', error: 'boom' })
  })
})
