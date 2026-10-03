// CONTRACTORSPEND.1 — fixtures for the contractor-spend tests. Not a test file
// (vitest collects *.test.js only). Holder ids are 'dan' (a member here) and
// 'gus' (a member of the sibling studio only).

/** A shift_blocks row as the spend read selects it. */
export function spendBlock(id, date, start, end, holders = ['dan'], { kind = 'class', roster = { status: 'published' }, location = 'loc1' } = {}) {
  return {
    id,
    location_id: location,
    template_id: 't',
    block_date: date,
    start_time: start,
    end_time: end,
    rosters: roster,
    shift_templates: { start_time: start, end_time: end, kind },
    shift_assignments: holders.map((h, i) => (typeof h === 'string'
      ? { id: `a-${id}-${i}`, profile_id: h, status: 'scheduled' }
      : { id: `a-${id}-${i}`, status: 'scheduled', ...h })),
  }
}

/**
 * The service-role client, as far as computeMonthlyContractorSpend uses it.
 * `profiles` rows are returned WHOLE, decoy pay columns included, so a reader
 * that priced from profiles instead of profile_compensation would show.
 * Any other table answers an error (a membership read must not happen).
 */
export function fakeSpendDb({ location = { id: 'loc1', monthly_contractor_budget_eur: 100 }, blocks = [], profiles = [], comp = [], fail = {} } = {}) {
  const queries = []
  const from = (name) => {
    const q = { table: name, select: null, eq: {}, gte: {}, lte: {}, in: {}, order: [], range: null }
    queries.push(q)
    const result = () => {
      if (fail[name]) return { data: null, error: { message: `${name} unreadable` } }
      if (name === 'shift_blocks') {
        const rows = blocks
          .filter((b) => q.eq.location_id == null || b.location_id === q.eq.location_id)
          .filter((b) => b.block_date >= q.gte.block_date && b.block_date <= q.lte.block_date)
        return { data: q.range ? rows.slice(q.range[0], q.range[1] + 1) : rows, error: null }
      }
      if (name === 'profiles') return { data: profiles.filter((p) => q.in.id.includes(p.id)), error: null }
      if (name === 'profile_compensation') return { data: comp.filter((c) => q.in.profile_id.includes(c.profile_id)), error: null }
      return { data: null, error: { message: `unexpected table ${name}` } }
    }
    const chain = {
      select(s) { q.select = s; return chain },
      eq(c, v) { q.eq[c] = v; return chain },
      gte(c, v) { q.gte[c] = v; return chain },
      lte(c, v) { q.lte[c] = v; return chain },
      in(c, v) { q.in[c] = v; return chain },
      order(c, o) { q.order.push([c, o?.ascending !== false]); return chain },
      range(a, b) { q.range = [a, b]; return chain },
      single() {
        if (name !== 'locations') throw new Error(`single() on ${name}`)
        return Promise.resolve(fail.locations
          ? { data: null, error: { message: 'locations unreadable' } }
          : { data: location, error: null })
      },
      then(res, rej) { return Promise.resolve(result()).then(res, rej) },
    }
    return chain
  }
  return {
    from,
    queries,
    tables: () => queries.map((q) => q.table),
    selectOf: (table) => queries.find((q) => q.table === table)?.select ?? null,
    blockQueries: () => queries.filter((q) => q.table === 'shift_blocks'),
  }
}

// ── October 2026: the clocks go back on Sunday 25 Oct ────────────────────────
// Dan, EUR 35/h: 1 Oct 2h + 25 Oct 3h + 31 Oct 2h = 7h = EUR 245.
// 30 Sep and 1 Nov must never count.
export const OCT_BLOCKS = [
  spendBlock('sep30', '2026-09-30', '09:00', '11:00'),
  spendBlock('oct01', '2026-10-01', '09:00', '11:00'),
  spendBlock('oct25', '2026-10-25', '09:00', '12:00'),
  spendBlock('oct31', '2026-10-31', '18:00', '20:00'),
  spendBlock('nov01', '2026-11-01', '09:00', '11:00'),
]
export const OCT_PROFILES = [{ id: 'dan', employment_type: 'contractor' }]
export const OCT_COMP = [{ profile_id: 'dan', hourly_rate: 35 }]
export const OCT_PAY = new Map([['dan', { employment_type: 'contractor', hourly_rate: 35, annual_salary: null, contracted_hours_per_week: null }]])
export const OCT_REFERENCE_DATES = ['2026-10-01', '2026-10-25', '2026-10-31']
export const OCT_EXPECTED = { monthStartIso: '2026-10-01', monthEndIso: '2026-10-31', contractorCostEur: 245 }
