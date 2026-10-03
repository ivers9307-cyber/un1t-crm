// src/lib/labour-month-data.test.js
// LABOUR.1 — the reads behind the owner's labour block: scoped to the
// organisation, pay from profile_compensation, profiles by NAMED columns,
// and a failed read is an error, never a €0.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@shared/studio-kpis', () => ({ fetchMrr: vi.fn() }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { fetchMrr } from '@shared/studio-kpis'
import { logError } from './log'
import { loadLabourMonth } from './labour-month-data'
import { LabourPanel } from '@/components/dashboard/LabourPanel'

const ORG = 'org-un1t'
const STILL = 'loc-still'
const HATCH = 'loc-hatch'
const NOW = Date.UTC(2026, 8, 15, 23, 0) // 00:00 Dublin, 16 Sep 2026: half the month gone
const STUDIOS = [{ id: STILL, name: 'UN1T Stillorgan' }]

function fakeDb(spec) {
  const calls = []
  return {
    calls,
    from(table) {
      const chain = []
      calls.push({ table, chain })
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'range', 'maybeSingle']) {
        b[m] = (...args) => { chain.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => {
        const s = spec[table]
        const out = typeof s === 'function' ? s(chain) : (s ?? { data: [], error: null })
        return Promise.resolve(out).then(resolve, reject)
      }
      return b
    },
  }
}
const has = (chain, m) => chain.some((c) => c[0] === m)
const chainOf = (db, table) => db.calls.find((c) => c.table === table)?.chain

const LOCATIONS = (chain) => (has(chain, 'maybeSingle')
  ? { data: { id: STILL, organization_id: ORG }, error: null }
  : { data: [{ id: HATCH }], error: null })
const BLOCKS = [
  {
    id: 'b1', location_id: STILL, block_date: '2026-09-01', start_time: '09:00:00', end_time: '12:00:00',
    rosters: { status: 'published' }, shift_templates: { start_time: '09:00:00', end_time: '12:00:00', kind: 'class' },
    shift_assignments: [{ id: 'a1', profile_id: 'p-alex', start_time_override: null, end_time_override: null, status: 'scheduled' }],
  },
  {
    id: 'b2', location_id: STILL, block_date: '2026-09-02', start_time: '17:00:00', end_time: '19:00:00',
    rosters: { status: 'published' }, shift_templates: { start_time: '17:00:00', end_time: '19:00:00', kind: 'admin' },
    shift_assignments: [{ id: 'a2', profile_id: 'p-jordan', start_time_override: null, end_time_override: null, status: 'scheduled' }],
  },
]
const LINKS = [{ profile_id: 'p-alex', location_id: STILL }, { profile_id: 'p-jordan', location_id: STILL }]
// Review 1 — the salaried people's links and published shifts in EVERY
// organisation, read by profile id (Alex: Stillorgan only, by default).
const ALL_LINKS = [{ profile_id: 'p-alex', location_id: STILL, locations: { active: true, is_host_anchor: false } }]
const byProfile = (chain) => chain.some((c) => c[0] === 'in' && c[1] === 'profile_id')
const assignmentOf = (block, i = 0) => {
  const { shift_assignments: list, ...b } = block
  return { ...list[i], shift_blocks: b }
}
const ALEX_SHIFTS = [assignmentOf(BLOCKS[0])]
const PROFILES = [
  { id: 'p-alex', full_name: 'Alex Example', active: true, deleted_at: null, employment_type: 'fte' },
  { id: 'p-jordan', full_name: 'Jordan Sample', active: true, deleted_at: null, employment_type: 'contractor' },
]
const COMP = [
  { profile_id: 'p-alex', annual_salary: '36000.00', hourly_rate: null, contracted_hours_per_week: '39.0', annual_leave_entitlement: null, overtime_rate: null },
  { profile_id: 'p-jordan', annual_salary: null, hourly_rate: '30.00', contracted_hours_per_week: null, annual_leave_entitlement: null, overtime_rate: null },
]
const okSpec = (over = {}) => ({
  locations: LOCATIONS,
  shift_blocks: { data: BLOCKS, error: null },
  profile_locations: (chain) => (byProfile(chain) ? { data: ALL_LINKS, error: null } : { data: LINKS, error: null }),
  shift_assignments: { data: ALEX_SHIFTS, error: null },
  profiles: { data: PROFILES, error: null },
  profile_compensation: { data: COMP, error: null },
  ...over,
})

beforeEach(() => {
  vi.mocked(fetchMrr).mockReset()
  vi.mocked(fetchMrr).mockResolvedValue({ success: true, data: { mrrCents: 1_000_000, recurringMembers: 191, yieldCents: 5236 } })
  vi.mocked(logError).mockReset()
})

describe('loadLabourMonth', () => {
  it('computes the month for the studios shown', async () => {
    const db = fakeDb(okSpec())
    const { data, error } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(error).toBeUndefined()
    // Alex: €3,000/month, all of it at Stillorgan; Jordan: 2h × €30 (admin shift).
    expect(data.studios[0]).toMatchObject({
      location_id: STILL,
      forecast: { employees_cents: 300_000, contractors_cents: 6_000, cost_cents: 306_000, hours: 5 },
      actual: { employees_cents: 150_000, contractors_cents: 6_000, cost_cents: 156_000, hours: 5 },
      forecast_pct: 30.6, actual_pct: 31.2,
    })
  })

  it('reads the roster at every studio of the organisation, for the Dublin month, paged', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    const chain = chainOf(db, 'shift_blocks')
    expect(chain).toContainEqual(['in', 'location_id', [STILL, HATCH]])
    expect(chain).toContainEqual(['gte', 'block_date', '2026-09-01'])
    expect(chain).toContainEqual(['lte', 'block_date', '2026-09-30'])
    expect(chain).toContainEqual(['order', 'id', { ascending: true }])
    expect(chain).toContainEqual(['range', 0, 999])
    expect(chainOf(db, 'profile_locations')).toContainEqual(['in', 'location_id', [STILL, HATCH]])
  })

  it('names its profiles columns (no pay from profiles) and reads pay from profile_compensation by id', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    const profiles = chainOf(db, 'profiles')
    expect(profiles[0]).toEqual(['select', 'id, full_name, active, deleted_at, employment_type'])
    expect(profiles).toContainEqual(['in', 'id', ['p-alex', 'p-jordan']])
    expect(chainOf(db, 'profile_compensation')).toContainEqual(['in', 'profile_id', ['p-alex', 'p-jordan']])
  })

  it('asks the scorecard\'s fetchMrr once per studio shown', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(fetchMrr).toHaveBeenCalledTimes(1)
    expect(fetchMrr).toHaveBeenCalledWith(db, STILL)
  })

  it('drops a studio outside the organisation even if it is passed in', async () => {
    const db = fakeDb(okSpec())
    const { data } = await loadLabourMonth(db, {
      activeLocationId: STILL, studios: [...STUDIOS, { id: 'loc-cars', name: 'CCF Autos' }], nowMs: NOW,
    })
    expect(data.studios.map((s) => s.location_id)).toEqual([STILL])
    expect(fetchMrr).toHaveBeenCalledTimes(1)
  })

  it('fetchMrr failing or throwing for a studio: that studio shows "unavailable", the block still renders', async () => {
    vi.mocked(fetchMrr).mockResolvedValueOnce({ success: false, error: 'timeout' })
    const db = fakeDb(okSpec())
    const { data } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(data.studios[0]).toMatchObject({ revenue_status: 'unavailable', forecast_pct: null })

    vi.mocked(fetchMrr).mockRejectedValueOnce(new Error('boom'))
    const again = await loadLabourMonth(fakeDb(okSpec()), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(again.data.studios[0].revenue_status).toBe('unavailable')
  })

  it('a failed roster read is an error, logged, never a €0', async () => {
    const db = fakeDb(okSpec({ shift_blocks: { data: null, error: { message: 'boom' } } }))
    const res = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(res).toEqual({ error: 'Could not read the roster' })
    expect(logError).toHaveBeenCalledWith('labour-month', 'the roster read failed', expect.objectContaining({ location_id: STILL, month: '2026-09' }))
  })

  it('a failed read of the organisation\'s studios is an error', async () => {
    const db = fakeDb(okSpec({ locations: (chain) => (has(chain, 'maybeSingle') ? LOCATIONS(chain) : { data: null, error: { message: 'boom' } }) }))
    const res = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(res).toEqual({ error: "Could not read the organisation's studios" })
  })

  it('a failed profiles or pay read is an error', async () => {
    const p = await loadLabourMonth(fakeDb(okSpec({ profiles: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(p).toEqual({ error: 'Could not read staff' })
    const c = await loadLabourMonth(fakeDb(okSpec({ profile_compensation: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(c).toEqual({ error: 'Could not read pay' })
  })

  it('reads the salaried people\'s studios and published shifts in EVERY organisation, by profile id', async () => {
    const db = fakeDb(okSpec())
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    const links = db.calls.filter((c) => c.table === 'profile_locations').map((c) => c.chain).find(byProfile)
    expect(links[0]).toEqual(['select', 'profile_id, location_id, locations:location_id ( active, is_host_anchor )'])
    expect(links).toContainEqual(['in', 'profile_id', ['p-alex']]) // salaried only: not Jordan
    expect(links.some((c) => c[1] === 'location_id' && c[0] !== 'order')).toBe(false) // no studio filter
    expect(links).toContainEqual(['range', 0, 999])
    const shifts = chainOf(db, 'shift_assignments')
    expect(shifts).toContainEqual(['in', 'profile_id', ['p-alex']])
    expect(shifts).toContainEqual(['gte', 'shift_blocks.block_date', '2026-09-01'])
    expect(shifts).toContainEqual(['lte', 'shift_blocks.block_date', '2026-09-30'])
    expect(shifts).toContainEqual(['order', 'id', { ascending: true }])
    expect(shifts).toContainEqual(['range', 0, 999])
  })

  it('charges this organisation only its share of a salary split with another organisation', async () => {
    const carsBlock = { ...BLOCKS[0], id: 'b-cars', location_id: 'loc-cars', block_date: '2026-09-03' }
    const db = fakeDb(okSpec({
      shift_assignments: { data: [assignmentOf(BLOCKS[0]), assignmentOf(carsBlock)], error: null },
    }))
    const { data } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    // 3h here, 3h at CCF Autos: half of €3,000 is Stillorgan's.
    expect(data.studios[0].forecast.employees_cents).toBe(150_000)
  })

  it('a salaried person with no published shift is split over their studios in every organisation', async () => {
    const db = fakeDb(okSpec({
      shift_blocks: { data: [BLOCKS[1]], error: null }, // Jordan only
      shift_assignments: { data: [], error: null },
      profile_locations: (chain) => (byProfile(chain)
        ? { data: [...ALL_LINKS, { profile_id: 'p-alex', location_id: 'loc-cars', locations: { active: true, is_host_anchor: false } }], error: null }
        : { data: LINKS, error: null }),
    }))
    const { data } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(data.studios[0].forecast.employees_cents).toBe(150_000)
  })

  it('a failed cross-organisation read is an error, never a whole salary charged here', async () => {
    const a = await loadLabourMonth(fakeDb(okSpec({ shift_assignments: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(a).toEqual({ error: "Could not read salaried staff's studios" })
    const b = await loadLabourMonth(fakeDb(okSpec({
      profile_locations: (chain) => (byProfile(chain) ? { data: null, error: { message: 'x' } } : { data: LINKS, error: null }),
    })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(b).toEqual({ error: "Could not read salaried staff's studios" })
  })

  it('no salaried people: no cross-organisation reads', async () => {
    const db = fakeDb(okSpec({ profile_compensation: { data: [COMP[1]], error: null } }))
    await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(chainOf(db, 'shift_assignments')).toBeUndefined()
    expect(db.calls.filter((c) => c.table === 'profile_locations').map((c) => c.chain).find(byProfile)).toBeUndefined()
  })

  it('refuses with no studio', async () => {
    const res = await loadLabourMonth(fakeDb(okSpec()), { activeLocationId: STILL, studios: [], nowMs: NOW })
    expect(res).toEqual({ error: 'No studio to report on' })
  })

  it('a failed memberships read is an error too, logged as memberships (not as the roster)', async () => {
    const res = await loadLabourMonth(fakeDb(okSpec({ profile_locations: { data: null, error: { message: 'x' } } })), { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(res).toEqual({ error: 'Could not read studio memberships' })
    expect(logError).toHaveBeenCalledWith('labour-month', 'studio memberships read failed', expect.objectContaining({ err: 'x' }))
    expect(logError).not.toHaveBeenCalledWith('labour-month', 'the roster read failed', expect.anything())
  })

  it('pages the roster past the 1,000-row cap', async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      id: `f${String(i).padStart(4, '0')}`, location_id: STILL, block_date: '2026-09-10', start_time: '09:00:00', end_time: '10:00:00',
      rosters: null, shift_templates: null, shift_assignments: [],
    }))
    const pages = []
    const db = fakeDb(okSpec({
      shift_blocks: (chain) => {
        const r = chain.find((c) => c[0] === 'range')
        pages.push([r[1], r[2]])
        return { data: r[1] === 0 ? filler : BLOCKS, error: null }
      },
    }))
    const { data } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(pages).toEqual([[0, 999], [1000, 1999]])
    expect(data.studios[0].forecast.cost_cents).toBe(306_000) // the second page's shifts were read
  })
})

// LABOUR.1 — THE LEAK TEST, end to end. Distinctive pay values go in at the
// database; nothing that reaches the page (the view model, and the HTML the
// server renders from it) may carry one, or any pay column name. With one
// person per studio the monthly euro total is derivable by design (owners
// only, D9); the RATES and ANNUAL figures must never appear.
describe('no pay value reaches the rendered block', () => {
  const PAY = [
    { profile_id: 'p-alex', annual_salary: '36012.34', hourly_rate: '19.87', contracted_hours_per_week: '37.25', annual_leave_entitlement: '23.5', overtime_rate: '45.55' },
    { profile_id: 'p-jordan', annual_salary: null, hourly_rate: '31.17', contracted_hours_per_week: '11.75', annual_leave_entitlement: null, overtime_rate: '52.61' },
  ]
  const LEAKS = [
    '36012', '36,012', '19.87', '1987', '37.25', '3725', '23.5', '45.55', '4555',
    '31.17', '3117', '11.75', '1175', '52.61', '5261',
    'annual_salary', 'hourly_rate', 'contracted_hours', 'annual_leave', 'overtime_rate',
  ]

  function keysDeep(v, out = new Set()) {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
    return out
  }

  it('neither the view model nor the HTML rendered from it carries a rate, a salary or a pay column', async () => {
    const db = fakeDb(okSpec({ profile_compensation: { data: PAY, error: null } }))
    const { data, error } = await loadLabourMonth(db, { activeLocationId: STILL, studios: STUDIOS, nowMs: NOW })
    expect(error).toBeUndefined()
    // It did cost them (so the test is not vacuous): Alex's month + Jordan's 2h.
    expect(data.studios[0].forecast.employees_cents).toBe(300_103)
    expect(data.studios[0].forecast.contractors_cents).toBe(6_234)

    const json = JSON.stringify(data)
    const html = renderToStaticMarkup(createElement(LabourPanel, { vm: data }))
    expect(html).toContain('€3,063') // the panel really rendered the costed figures
    for (const leak of LEAKS) {
      expect(json).not.toContain(leak)
      expect(html).not.toContain(leak)
    }
    for (const k of keysDeep(data)) {
      expect(k).not.toMatch(/salary|rate|contracted|leave|overtime/)
    }
  })
})
