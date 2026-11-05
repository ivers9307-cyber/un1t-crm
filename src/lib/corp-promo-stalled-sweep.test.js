// NEWSTART.1f — stalled Glofox promo claims go to the team.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ alert: vi.fn() }))
vi.mock('@/lib/ops-alerts', () => ({ sendOpsAlert: mocks.alert }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { sweepStalledGlofoxCorpClaims } from './corp-promo-stalled-sweep.js'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const ago = (min) => new Date(NOW - min * 60_000).toISOString()
const claim = (over = {}) => ({
  id: 'c1', location_id: 'loc-1', promo_key: 'stillorgan-newstart', contact_id: 'ct1', first_name: 'Ann', last_name: 'Byrne',
  customer_email: 'a@x.ie', customer_phone: '0851', created_at: ago(20), grant: null, glofox_member_id: null, status: 'processing', ...over,
})

function fakeDb({ rows = [], readError = null, touch = 1, updateError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      const st = { table, eq: {}, in: {}, lt: {} }
      let patch = null
      const chain = {
        select() { return chain },
        update(p) { patch = p; return chain },
        eq(c, v) { st.eq[c] = v; return chain },
        in(c, v) { st.in[c] = v; return chain },
        lt(c, v) { st.lt[c] = v; return chain },
        order() { return chain },
        limit() { return chain },
        then(res, rej) {
          let out
          if (table === 'locations') out = { data: [{ id: 'loc-1', name: 'UN1T Stillorgan', organization_id: 'org-1' }], error: null }
          else if (patch) {
            updates.push({ patch, eq: st.eq })
            out = updateError ? { data: null, error: updateError } : { data: touch ? [{ id: st.eq.id }] : [], error: null }
          } else if (readError) out = { data: null, error: readError }
          else out = { data: rows.filter((r) => r.status === st.eq.status && st.in.promo_key.includes(r.promo_key) && r.created_at < st.lt.created_at), error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return chain
    },
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('sweepStalledGlofoxCorpClaims', () => {
  it('files a 20-minute-old glofox claim once, reason stalled, and alerts (nothing bought)', async () => {
    const db = fakeDb({ rows: [claim()] })
    const r = await sweepStalledGlofoxCorpClaims(db, { now: NOW })
    expect(r).toEqual({ ok: true, checked: 1, filed: 1, failed: 0 })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].patch).toEqual({ status: 'help_requested', reason: 'stalled' })
    expect(db.updates[0].eq).toMatchObject({ id: 'c1', status: 'processing' })
    expect(mocks.alert).toHaveBeenCalledTimes(1)
    const a = mocks.alert.mock.calls[0][0]
    expect(a.organizationId).toBe('org-1')
    expect(a.htmlBody).toContain('Nothing was bought')
  })

  it('a claim with a purchase marker says it may have gone through', async () => {
    const db = fakeDb({ rows: [claim({ grant: { stage: 'purchasing' } })] })
    await sweepStalledGlofoxCorpClaims(db, { now: NOW })
    const body = mocks.alert.mock.calls[0][0].htmlBody
    expect(body).toContain('may have gone through')
    expect(body).toContain('€0 New Start invoice')
    expect(body).not.toContain('Nothing was bought')
  })

  it('leaves a 5-minute-old claim', async () => {
    const db = fakeDb({ rows: [claim({ created_at: ago(5) })] })
    expect(await sweepStalledGlofoxCorpClaims(db, { now: NOW })).toEqual({ ok: true, checked: 0, filed: 0, failed: 0 })
    expect(db.updates).toHaveLength(0)
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('leaves a un1t.online claim', async () => {
    const db = fakeDb({ rows: [claim({ promo_key: 'hatch-3-free' })] })
    const r = await sweepStalledGlofoxCorpClaims(db, { now: NOW })
    expect(r.checked).toBe(0)
    expect(db.updates).toHaveLength(0)
  })

  it('a CAS that touches 0 rows sends no alert', async () => {
    const db = fakeDb({ rows: [claim()], touch: 0 })
    expect(await sweepStalledGlofoxCorpClaims(db, { now: NOW })).toEqual({ ok: true, checked: 1, filed: 0, failed: 0 })
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('a failed update is counted, not ok, and sends no alert', async () => {
    const db = fakeDb({ rows: [claim()], updateError: { code: '500' } })
    expect(await sweepStalledGlofoxCorpClaims(db, { now: NOW })).toEqual({ ok: false, checked: 1, filed: 0, failed: 1 })
    expect(mocks.alert).not.toHaveBeenCalled()
  })

  it('a read error is ok:false', async () => {
    const db = fakeDb({ readError: { code: '42P01' } })
    expect(await sweepStalledGlofoxCorpClaims(db, { now: NOW })).toEqual({ ok: false, checked: 0, filed: 0, failed: 0 })
  })

  it('an alert that throws does not undo the filing', async () => {
    mocks.alert.mockRejectedValueOnce(new Error('mail down'))
    const r = await sweepStalledGlofoxCorpClaims(fakeDb({ rows: [claim()] }), { now: NOW })
    expect(r).toMatchObject({ ok: true, filed: 1 })
  })
})
