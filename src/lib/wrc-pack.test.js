// WRCPACK.1 — the WRC inspection pack: the pure aggregation (Sunday counting,
// override-aware hours, weekly overtime against contract, leave days, former
// staff and tombstones kept) and the paged reads, on a fake builder that
// applies eq / in / gte / lte / range the way PostgREST would.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import {
  buildWrcPack, generateWrcPack, wrcStaffCsv, wrcShiftCsv, isSunday, defaultWrcPeriod,
  WRC_STAFF_CSV_HEADER, WRC_SHIFT_CSV_HEADER,
} from './wrc-pack'
import { canDownloadWrcPack } from './wrc-pack-access'

const ORG = 'f1000000-0000-0000-0000-000000000001'
const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const locationsById = { [LOC_A]: { name: 'Stillorgan', zone: 'Europe/Dublin' }, [LOC_B]: { name: 'Hatch Street', zone: 'Europe/Dublin' } }

const FROM = '2025-10-21'
const TO = '2026-10-20'

function shift(over) {
  return {
    assignment_id: 'as-' + Math.random().toString(36).slice(2, 8),
    shift_date: '2026-06-01',
    location_id: LOC_A,
    profile_id: 'p1',
    arrived_at: null,
    start_time_override: null,
    end_time_override: null,
    block_start_time: '09:00:00',
    block_end_time: '17:00:00',
    status: 'scheduled',
    profiles: { full_name: 'Anna', role: 'staff', employment_type: 'fte' },
    shift_templates: { name: 'Day', start_time: '08:00:00', end_time: '16:00:00' },
    ...over,
  }
}

const anna = { id: 'p1', full_name: 'Anna Byrne', email: 'anna@example.com', role: 'staff', deleted_role: null, deleted_at: null, active: true, employment_type: 'fte', annual_salary: 41600, hourly_rate: null, contracted_hours_per_week: 40 }
const ben = { id: 'p2', full_name: 'Ben Cole', email: 'ben@example.com', role: 'staff', deleted_role: null, deleted_at: null, active: true, employment_type: 'contractor', annual_salary: null, hourly_rate: 30, contracted_hours_per_week: null }

describe('isSunday / defaultWrcPeriod', () => {
  it('judges the wall-clock date, zone-free', () => {
    expect(isSunday('2026-06-07')).toBe(true)   // a Sunday
    expect(isSunday('2026-06-08')).toBe(false)
    expect(isSunday(null)).toBe(false)
  })
  it('the default period is the 12 months ending today, inclusive', () => {
    expect(defaultWrcPeriod('2026-10-20')).toEqual({ from: '2025-10-21', to: '2026-10-20' })
    // 29 Feb has no twin a year earlier: the day after 1 Mar, still 365 days.
    expect(defaultWrcPeriod('2028-02-29')).toEqual({ from: '2027-03-02', to: '2028-02-29' })
  })
})

describe('buildWrcPack', () => {
  const base = { memberships: [{ profile_id: 'p1', location_id: LOC_A, role: 'staff' }], timeOff: [], allowances: [], contracts: [], handbook: null, locationsById, from: FROM, to: TO, year: 2026 }

  it('sums override-aware hours and counts Sunday shifts and hours', () => {
    const shifts = [
      shift({ shift_date: '2026-06-01' }),                                               // Mon, block 09-17 = 8h
      shift({ shift_date: '2026-06-07', start_time_override: '10:00:00', end_time_override: '14:00:00' }), // Sun, override 4h
      shift({ shift_date: '2026-06-14', block_start_time: null, block_end_time: null }), // Sun, template 08-16 = 8h
    ]
    const { staff } = buildWrcPack({ ...base, profiles: [anna], shifts })
    expect(staff).toHaveLength(1)
    const row = staff[0]
    expect(row.rostered_shifts).toBe(3)
    expect(row.rostered_hours).toBe(20)
    expect(row.sunday_shifts).toBe(2)
    expect(row.sunday_hours).toBe(12)
    expect(row.first_shift_date).toBe('2026-06-01')
    expect(row.last_shift_date).toBe('2026-06-14')
    expect(row.hourly_rate).toBe(20)          // 41600 / 52 / 40
    expect(row.contracted_hours_per_week).toBe(40)
  })

  it('judges overtime per Mon–Sun week against contracted hours, FTE only', () => {
    // Week of 1 Jun: 5 × 10h = 50h → 10h over. Week of 8 Jun: 3 × 10h = 30h → not over.
    const tenHour = (d) => shift({ shift_date: d, start_time_override: '07:00:00', end_time_override: '17:00:00' })
    const shifts = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10'].map(tenHour)
    const contractorShifts = shifts.map((s) => ({ ...s, profile_id: 'p2', assignment_id: s.assignment_id + 'b' }))
    const { staff } = buildWrcPack({
      ...base,
      memberships: [...base.memberships, { profile_id: 'p2', location_id: LOC_A, role: 'staff' }],
      profiles: [anna, ben], shifts: [...shifts, ...contractorShifts],
    })
    const a = staff.find((r) => r.profile_id === 'p1')
    const b = staff.find((r) => r.profile_id === 'p2')
    expect(a.weeks_over_contract).toBe(1)
    expect(a.overtime_hours).toBe(10)
    expect(a.rostered_hours).toBe(80)
    // A contractor has no contract to be over: blank, never 0 pretending to be a judgement.
    expect(b.weeks_over_contract).toBeNull()
    expect(b.overtime_hours).toBeNull()
    expect(b.contracted_hours_per_week).toBeNull()
    expect(b.hourly_rate).toBe(30)
  })

  it('keeps former staff: a tombstone with shifts is a row with its deleted role, and a cancelled-only person is not', () => {
    const gone = { id: 'p3', full_name: 'Cara Dunne', email: 'deleted-p3@deleted.invalid', role: 'staff', deleted_role: 'manager', deleted_at: '2026-08-01T10:00:00Z', active: false, employment_type: 'fte', annual_salary: null, hourly_rate: null, contracted_hours_per_week: 30 }
    const shifts = [
      shift({ profile_id: 'p3', shift_date: '2026-05-04' }),
      shift({ profile_id: 'p4', shift_date: '2026-05-05', status: 'cancelled' }),
    ]
    const { staff } = buildWrcPack({ ...base, memberships: [], profiles: [gone], shifts })
    expect(staff.map((r) => r.profile_id)).toEqual(['p3'])
    expect(staff[0].role).toBe('manager')
    expect(staff[0].status).toBe('deleted 2026-08-01')
    expect(staff[0].rostered_hours).toBe(8)
  })

  it('a member with no shifts is still a row; membership roles and studios are listed', () => {
    const { staff } = buildWrcPack({
      ...base,
      memberships: [{ profile_id: 'p1', location_id: LOC_A, role: 'manager' }, { profile_id: 'p1', location_id: LOC_B, role: 'staff' }],
      profiles: [anna], shifts: [],
    })
    expect(staff).toHaveLength(1)
    expect(staff[0].role).toBe('manager; staff')
    expect(staff[0].studios).toBe('Hatch Street; Stillorgan')
    expect(staff[0].rostered_shifts).toBe(0)
    expect(staff[0].first_shift_date).toBeNull()
  })

  it('counts approved leave days charged inside the range by type, allowance for the year, contract and handbook', () => {
    const timeOff = [
      { id: 't1', profile_id: 'p1', location_id: LOC_A, type: 'holiday', status: 'approved', start_date: '2026-03-02', end_date: '2026-03-06', total_days: 5 },
      // crosses the range start: 2025-10-20..2025-10-24, only Tue 21 – Fri 24 are inside = 4 working days
      { id: 't2', profile_id: 'p1', location_id: LOC_A, type: 'holiday', status: 'approved', start_date: '2025-10-20', end_date: '2025-10-24', total_days: 5 },
      { id: 't3', profile_id: 'p1', location_id: LOC_A, type: 'sick', status: 'approved', start_date: '2026-04-01', end_date: '2026-04-02', total_days: 2 },
      { id: 't4', profile_id: 'p1', location_id: LOC_A, type: 'unpaid', status: 'approved', start_date: '2026-04-10', end_date: '2026-04-10', total_days: 1 },
      { id: 't5', profile_id: 'p1', location_id: LOC_A, type: 'holiday', status: 'pending', start_date: '2026-05-01', end_date: '2026-05-01', total_days: 1 },
    ]
    const { staff } = buildWrcPack({
      ...base, profiles: [anna], shifts: [], timeOff,
      allowances: [{ profile_id: 'p1', year: 2026, total_days: 22, used_days: 9, carried_over: 2 }, { profile_id: 'p1', year: 2025, total_days: 20, used_days: 20, carried_over: 0 }],
      contracts: [{ profile_id: 'p1', signed_at: '2026-01-05T09:00:00Z' }, { profile_id: 'p1', signed_at: '2025-01-05T09:00:00Z' }],
      handbook: { version: 3, viewedProfileIds: new Set(['p1']) },
    })
    const r = staff[0]
    expect(r.holiday_days).toBe(9)
    expect(r.sick_days).toBe(2)
    expect(r.other_leave_days).toBe(1)
    expect(r.allowance_total_days).toBe(22)
    expect(r.allowance_used_days).toBe(9)
    expect(r.allowance_carried_over).toBe(2)
    expect(r.contract_signed).toBe(true)
    expect(r.contract_signed_at).toBe('2026-01-05T09:00:00Z')
    expect(r.handbook_version).toBe(3)
    expect(r.handbook_viewed).toBe(true)
  })

  it('an edge-crossing holiday skips the studio\'s non-working dates', () => {
    const timeOff = [
      { id: 't2', profile_id: 'p1', location_id: LOC_A, type: 'holiday', status: 'approved', start_date: '2025-10-20', end_date: '2025-10-24', total_days: 5 },
    ]
    const { staff } = buildWrcPack({
      ...base, profiles: [anna], shifts: [], timeOff,
      nonWorkingByLocation: { [LOC_A]: new Set(['2025-10-22']) },
    })
    expect(staff[0].holiday_days).toBe(3)
  })

  it('without a handbook or contract the cells are blank / no, never a false yes', () => {
    const { staff } = buildWrcPack({ ...base, profiles: [anna], shifts: [] })
    expect(staff[0].handbook_version).toBeNull()
    expect(staff[0].handbook_viewed).toBeNull()
    expect(staff[0].contract_signed).toBe(false)
    expect(staff[0].allowance_total_days).toBeNull()
  })

  it('the shift detail lists every assignment, cancelled ones flagged with 0 hours, times from the paid window', () => {
    const shifts = [
      shift({ assignment_id: 'as1', shift_date: '2026-06-07', start_time_override: '10:00:00', arrived_at: '2026-06-07T08:58:00Z' }),
      shift({ assignment_id: 'as2', shift_date: '2026-06-01', status: 'cancelled', location_id: LOC_B }),
    ]
    const { shifts: rows } = buildWrcPack({ ...base, profiles: [anna], shifts })
    expect(rows.map((r) => r.assignment_id)).toEqual(['as2', 'as1'])
    const sun = rows[1]
    expect(sun.sunday).toBe(true)
    expect(sun.weekday).toBe('Sun')
    expect(sun.rostered_start).toBe('09:00')
    expect(sun.adjusted_start).toBe('10:00')
    expect(sun.adjusted_end).toBe('17:00')
    expect(sun.hours).toBe(7)
    expect(sun.arrived_local).toBe('2026-06-07 09:58')   // BST
    expect(sun.studio).toBe('Stillorgan')
    expect(sun.full_name).toBe('Anna Byrne')
    const can = rows[0]
    expect(can.cancelled).toBe(true)
    expect(can.hours).toBe(0)
    expect(can.studio).toBe('Hatch Street')
  })
})

describe('CSV', () => {
  it('staff CSV has the header and one quoted, formula-safe row per person', () => {
    const { staff } = buildWrcPack({
      memberships: [{ profile_id: 'p1', location_id: LOC_A, role: 'staff' }],
      profiles: [{ ...anna, full_name: '=Byrne, Anna' }], shifts: [], timeOff: [], allowances: [], contracts: [], handbook: null,
      locationsById, from: FROM, to: TO, year: 2026,
    })
    const csv = wrcStaffCsv(staff)
    const lines = csv.split('\n')
    expect(lines[0]).toBe(WRC_STAFF_CSV_HEADER.join(','))
    expect(lines).toHaveLength(2)
    expect(lines[1].startsWith(`"'=Byrne, Anna",anna@example.com,active,fte,staff,Stillorgan,,,40,20,0,0,0,0,0,0,0,0,0,2026,,,,no,,,`)).toBe(true)
    expect(lines[1].split(',').length).toBeGreaterThanOrEqual(WRC_STAFF_CSV_HEADER.length)
  })
  it('shift CSV has the header and the cancelled flag', () => {
    const { shifts } = buildWrcPack({
      memberships: [], profiles: [anna], shifts: [shift({ status: 'cancelled', shift_date: '2026-06-07' })],
      timeOff: [], allowances: [], contracts: [], handbook: null, locationsById, from: FROM, to: TO, year: 2026,
    })
    const lines = wrcShiftCsv(shifts).split('\n')
    expect(lines[0]).toBe(WRC_SHIFT_CSV_HEADER.join(','))
    expect(lines[1]).toBe('2026-06-07,Sun,yes,Anna Byrne,anna@example.com,Stillorgan,Day,09:00,17:00,09:00,17:00,0,,cancelled,yes')
  })
})

// ─── reads ───────────────────────────────────────────────────────────────

// A fake PostgREST: table → rows; eq / in / gte / lte / is filters, order
// ignored (rows are served in table order), range sliced, maybeSingle takes
// the first. `fail` makes one table's read return an error.
function fakeDb(tables, { fail = null, pageSize = 1000 } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const preds = []
      let rangeArg = null
      let single = false
      const b = {
        select(cols) { reads.push({ table, cols, ranges: [] }); return b },
        eq(col, v) { preds.push((r) => r[col] === v); return b },
        in(col, vs) { preds.push((r) => vs.includes(r[col])); return b },
        gte(col, v) { preds.push((r) => r[col] >= v); return b },
        lte(col, v) { preds.push((r) => r[col] <= v); return b },
        is(col, v) { preds.push((r) => r[col] === v); return b },
        order() { return b },
        range(a, z) { rangeArg = [a, z]; reads[reads.length - 1].ranges.push([a, z]); return b },
        maybeSingle() { single = true; return b },
        then(onF, onR) {
          if (fail === table) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(onF, onR)
          let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)))
          if (rangeArg) rows = rows.slice(rangeArg[0], Math.min(rangeArg[1] + 1, rangeArg[0] + pageSize))
          const data = single ? (rows[0] ?? null) : rows
          return Promise.resolve({ data, error: null }).then(onF, onR)
        },
      }
      return b
    },
  }
}

const DB_TABLES = () => ({
  locations: [{ id: LOC_A, name: 'Stillorgan', timezone: 'Europe/Dublin', organization_id: ORG }, { id: LOC_B, name: 'Hatch Street', timezone: 'Europe/Dublin', organization_id: ORG }, { id: 'other', name: 'Elsewhere', timezone: 'Europe/Dublin', organization_id: 'org-2' }],
  profile_locations: [{ id: 'm1', profile_id: 'p1', location_id: LOC_A, role: 'staff' }, { id: 'm2', profile_id: 'p9', location_id: 'other', role: 'owner' }],
  shift_assignments: [
    { id: 'as1', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', arrived_at: '2026-06-07T08:58:00Z', profiles: { full_name: 'Anna Byrne', role: 'staff', deleted_role: null, employment_type: 'fte' }, shift_blocks: { block_date: '2026-06-07', start_time: '09:00:00', end_time: '17:00:00', location_id: LOC_A, shift_templates: { name: 'Day', start_time: '09:00:00', end_time: '17:00:00' } }, 'shift_blocks.location_id': LOC_A, 'shift_blocks.block_date': '2026-06-07' },
    { id: 'as2', profile_id: 'p3', start_time_override: null, end_time_override: null, status: 'cancelled', arrived_at: null, profiles: { full_name: 'Cara Dunne', role: 'staff', deleted_role: 'manager', employment_type: 'fte' }, shift_blocks: { block_date: '2026-06-08', start_time: '09:00:00', end_time: '12:00:00', location_id: LOC_B, shift_templates: null }, 'shift_blocks.location_id': LOC_B, 'shift_blocks.block_date': '2026-06-08' },
    { id: 'as3', profile_id: 'p3', start_time_override: null, end_time_override: null, status: 'scheduled', arrived_at: null, profiles: { full_name: 'Cara Dunne', role: 'staff', deleted_role: 'manager', employment_type: 'fte' }, shift_blocks: { block_date: '2026-06-09', start_time: '09:00:00', end_time: '12:00:00', location_id: LOC_B, shift_templates: null }, 'shift_blocks.location_id': LOC_B, 'shift_blocks.block_date': '2026-06-09' },
  ],
  time_off_requests: [
    { id: 't1', profile_id: 'p1', location_id: LOC_A, type: 'sick', status: 'approved', start_date: '2026-04-01', end_date: '2026-04-02', total_days: 2 },
    { id: 't2', profile_id: 'p1', location_id: LOC_A, type: 'holiday', status: 'rejected', start_date: '2026-04-05', end_date: '2026-04-06', total_days: 2 },
  ],
  location_holidays: [],
  profiles: [
    anna,
    { id: 'p3', full_name: 'Cara Dunne', email: 'deleted-p3@deleted.invalid', role: 'staff', deleted_role: 'manager', deleted_at: '2026-08-01T10:00:00Z', active: false, employment_type: 'fte', annual_salary: null, hourly_rate: null, contracted_hours_per_week: 30 },
    { id: 'p9', full_name: 'Other Org', email: 'x@y.z', role: 'owner', deleted_role: null, deleted_at: null, active: true, employment_type: 'fte', annual_salary: null, hourly_rate: null, contracted_hours_per_week: 40 },
  ],
  staff_allowances: [{ id: 'al1', profile_id: 'p1', year: 2026, total_days: 20, used_days: 2, carried_over: 0 }],
  contracts: [{ id: 'c1', profile_id: 'p1', organization_id: ORG, status: 'signed', signed_at: '2026-01-05T09:00:00Z' }, { id: 'c2', profile_id: 'p3', organization_id: ORG, status: 'issued', signed_at: null }],
  policies: [{ id: 'pol1', organization_id: ORG, slug: 'employee-handbook' }],
  policy_versions: [{ id: 'v1', policy_id: 'pol1', is_current: false, version_number: 1 }, { id: 'v2', policy_id: 'pol1', is_current: true, version_number: 2 }],
  policy_views: [{ id: 'pv1', policy_version_id: 'v2', profile_id: 'p3' }, { id: 'pv2', policy_version_id: 'v1', profile_id: 'p1' }],
})

describe('generateWrcPack', () => {
  it('reads every studio of the organisation and builds both row sets, former staff included', async () => {
    const db = fakeDb(DB_TABLES())
    const { pack, locations, error } = await generateWrcPack(db, { organizationId: ORG, from: FROM, to: TO, year: 2026 })
    expect(error).toBeNull()
    expect(locations.map((l) => l.id)).toEqual([LOC_A, LOC_B])
    expect(pack.staff.map((r) => r.profile_id)).toEqual(['p1', 'p3'])    // never p9 (another org)
    const a = pack.staff[0]
    expect(a.rostered_hours).toBe(8)
    expect(a.sunday_shifts).toBe(1)
    expect(a.sick_days).toBe(2)
    expect(a.holiday_days).toBe(0)           // the rejected request is not leave taken
    expect(a.allowance_used_days).toBe(2)
    expect(a.contract_signed).toBe(true)
    expect(a.handbook_version).toBe(2)
    expect(a.handbook_viewed).toBe(false)    // viewed version 1 only
    const c = pack.staff[1]
    expect(c.status).toBe('deleted 2026-08-01')
    expect(c.role).toBe('manager')
    expect(c.rostered_hours).toBe(3)         // the cancelled one is not hours
    expect(c.handbook_viewed).toBe(true)
    expect(c.contract_signed).toBe(false)
    expect(pack.shifts).toHaveLength(3)
    expect(pack.shifts.filter((s) => s.cancelled)).toHaveLength(1)
    expect(pack.shifts[0].arrived_local).toBe('2026-06-07 09:58')
  })

  it('every read is paged and ordered, and a failed read fails the pack', async () => {
    const tables = DB_TABLES()
    const db = fakeDb(tables)
    await generateWrcPack(db, { organizationId: ORG, from: FROM, to: TO, year: 2026 })
    const tablesRead = [...new Set(db.reads.map((r) => r.table))]
    expect(tablesRead).toEqual(expect.arrayContaining(['locations', 'profile_locations', 'shift_assignments', 'time_off_requests', 'profiles', 'staff_allowances', 'contracts', 'policies', 'policy_versions', 'policy_views']))

    for (const t of ['locations', 'profile_locations', 'shift_assignments', 'profiles', 'staff_allowances', 'contracts', 'policy_views']) {
      const { pack, error } = await generateWrcPack(fakeDb(DB_TABLES(), { fail: t }), { organizationId: ORG, from: FROM, to: TO, year: 2026 })
      expect(pack, t).toBeNull()
      expect(error, t).toMatch(/Failed|down/)
    }
  })

  it('pages past PostgREST\'s 1,000-row cap on the membership read', async () => {
    const tables = DB_TABLES()
    tables.profile_locations = Array.from({ length: 1500 }, (_, i) => ({ id: `m${i}`, profile_id: `q${String(i).padStart(4, '0')}`, location_id: LOC_A, role: 'staff' }))
    tables.profiles = [...tables.profiles, ...tables.profile_locations.map((m) => ({ ...anna, id: m.profile_id, email: `${m.profile_id}@x.ie` }))]
    const db = fakeDb(tables)
    const { pack, error } = await generateWrcPack(db, { organizationId: ORG, from: FROM, to: TO, year: 2026 })
    expect(error).toBeNull()
    // 1,500 members + p1 (worked at A) + p3 (worked at B): nothing cut at the first page.
    expect(pack.staff).toHaveLength(1502)
    // each page is its own builder: two reads, the second from row 1000
    const membershipRanges = db.reads.filter((r) => r.table === 'profile_locations').flatMap((r) => r.ranges)
    expect(membershipRanges).toEqual([[0, 999], [1000, 1999]])
    // profiles are read in id chunks, each paged
    const profileReads = db.reads.filter((r) => r.table === 'profiles')
    expect(profileReads.length).toBe(Math.ceil(1502 / 100))
  })

  it('an organisation with no studios is an empty pack, not an error', async () => {
    const { pack, error } = await generateWrcPack(fakeDb(DB_TABLES()), { organizationId: 'org-none', from: FROM, to: TO, year: 2026 })
    expect(error).toBeNull()
    expect(pack.staff).toEqual([])
    expect(pack.shifts).toEqual([])
  })
})

describe('canDownloadWrcPack', () => {
  const locs = [{ id: LOC_A, organization_id: ORG }, { id: LOC_B, organization_id: ORG }]
  it('master anywhere, org admin of the org, owner at one of its studios', () => {
    expect(canDownloadWrcPack({ isMaster: true }, null)).toBe(true)
    expect(canDownloadWrcPack({ orgAdminOrgIds: [ORG] }, ORG)).toBe(true)
    expect(canDownloadWrcPack({ rolesByLocation: { [LOC_A]: 'owner' }, locations: locs }, ORG)).toBe(true)
  })
  it('a manager, a head coach, an owner elsewhere, or no org: refused', () => {
    expect(canDownloadWrcPack({ rolesByLocation: { [LOC_A]: 'manager' }, locations: locs }, ORG)).toBe(false)
    expect(canDownloadWrcPack({ rolesByLocation: { [LOC_A]: 'owner' }, locations: locs }, 'org-2')).toBe(false)
    expect(canDownloadWrcPack({ orgAdminOrgIds: ['org-2'] }, ORG)).toBe(false)
    expect(canDownloadWrcPack({ rolesByLocation: { [LOC_A]: 'owner' }, locations: locs }, null)).toBe(false)
    expect(canDownloadWrcPack(null, ORG)).toBe(false)
  })
})
