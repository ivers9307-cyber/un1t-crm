// PAGES.1 — an in-memory supabase fake and the UN1T fixtures for the
// /api/landing-pages* route tests. The fake runs select / insert / update /
// delete over plain arrays with eq / in / order / range, embeds `locations`
// on a landing_page_studios read (STUDIO_ROW_COLUMNS), refuses a duplicate
// (organization_id, slug) on landing_pages with 23505, and records every
// query so a test can assert what was (or was not) written.

export const ORG = 'c0000000-0000-0000-0000-000000000001'
export const OTHER_ORG = 'c0000000-0000-0000-0000-000000000002'
export const STILL = 'a0000000-0000-0000-0000-000000000001'
export const HATCH = 'a0000000-0000-0000-0000-000000000002'
export const CLOSED = 'a0000000-0000-0000-0000-000000000003'
export const ELSEWHERE = 'a0000000-0000-0000-0000-000000000009'

export const PAGE = {
  stillorgan: 'd0000000-0000-0000-0000-000000000001',
  hatch: 'd0000000-0000-0000-0000-000000000002',
  trial: 'd0000000-0000-0000-0000-000000000003',
  fiftyplus: 'd0000000-0000-0000-0000-000000000004',
  corp: 'd0000000-0000-0000-0000-000000000005',
  other: 'd0000000-0000-0000-0000-000000000009',
}

const page = (over) => ({
  organization_id: ORG, kind: 'campaign', scope: 'one', primary_location_id: STILL,
  offer_type: 'none', blocks: [], chrome: {}, publish_state: 'live', redirect_to: null,
  updated_at: '2026-10-31T00:00:00Z', ...over,
})

export function fixtureTables() {
  return {
    locations: [
      { id: STILL, name: 'UN1T Stillorgan', organization_id: ORG, active: true, membership_source: 'glofox', settings: { glofox: { branch_id: 'b' } } },
      { id: HATCH, name: 'UN1T Hatch Street', organization_id: ORG, active: true, membership_source: 'un1t_online', settings: { un1t_online: { writes_enabled: true } } },
      { id: CLOSED, name: 'UN1T Closed', organization_id: ORG, active: false, membership_source: 'none', settings: {} },
      { id: ELSEWHERE, name: 'CCF Autos', organization_id: OTHER_ORG, active: true, membership_source: 'none', settings: {} },
    ],
    landing_pages: [
      page({ id: PAGE.stillorgan, slug: 'stillorgan', title: 'UN1T Stillorgan', kind: 'studio', offer_type: 'paid_trial',
        blocks: [{ id: 'h1', type: 'hero' }, { id: 'pt1', type: 'paid_trial', heading: 'Try us' }] }),
      page({ id: PAGE.hatch, slug: 'hatch-street', title: 'UN1T Hatch Street', kind: 'studio', primary_location_id: HATCH }),
      page({ id: PAGE.trial, slug: 'trial', title: '14 Day Reset', scope: 'all', primary_location_id: null, offer_type: 'paid_trial',
        blocks: [{ id: 'pt', type: 'paid_trial', heading: 'The Reset' }, { id: 'st', type: 'stats', items: [{ number: '1' }] }, { id: 'rv', type: 'reviews' }] }),
      page({ id: PAGE.fiftyplus, slug: '50plus', title: 'The 50+ Club', offer_type: 'one_class',
        blocks: [{ id: 'cf', type: 'campaign_funnel', heading: '50+' }] }),
      page({ id: PAGE.corp, slug: 'corp', title: 'Corporate promo', primary_location_id: HATCH, offer_type: 'promo_credits',
        blocks: [{ id: 'cp', type: 'corp_promo' }] }),
      page({ id: PAGE.other, organization_id: OTHER_ORG, slug: 'autos', title: 'Autos', primary_location_id: ELSEWHERE }),
    ],
    landing_page_studios: [
      { page_id: PAGE.stillorgan, location_id: STILL, enabled: true, offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900 }, attribution: {}, sort_order: 0 },
      { page_id: PAGE.hatch, location_id: HATCH, enabled: true, offer: {}, attribution: {}, sort_order: 0 },
      { page_id: PAGE.trial, location_id: STILL, enabled: true, offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900, product_name: '14 Day Reset' }, attribution: {}, sort_order: 0 },
      { page_id: PAGE.trial, location_id: HATCH, enabled: true, offer: { un1t_product_id: 'u1' }, attribution: {}, sort_order: 1 },
      { page_id: PAGE.fiftyplus, location_id: STILL, enabled: true, offer: { trial_membership_id: 'tm', trial_plan_code: 'tp', class_keywords: '50+' }, attribution: { tag: 'stillorgan-50plus' }, sort_order: 0 },
      { page_id: PAGE.corp, location_id: HATCH, enabled: true, offer: { promo_key: 'hatch-3-free' }, attribution: {}, sort_order: 0 },
    ],
    landing_page_settings: [],
    un1t_products: [
      { location_id: HATCH, un1t_id: 'u1', status: 'active', type: 'one_time', price_cents: 3900, currency: 'eur', title: 'Hatch trial' },
    ],
  }
}

// The callers. A Stillorgan manager with landing_page there; an org admin of
// UN1T; a Stillorgan coach without landing_page; a master. Each carries the getCurrentUser fields the helpers read.
export const STILL_MANAGER = {
  id: 'e0000000-0000-0000-0000-000000000001', role: 'manager',
  locations: [{ id: STILL, name: 'UN1T Stillorgan', role: 'manager', organization_id: ORG }],
  assignmentsByLocation: { [STILL]: { role: 'manager', permissions: { landing_page: true } } },
  activeLocation: { id: STILL, organization_id: ORG }, activeOrganization: { id: ORG }, orgAdminOrgIds: [],
}
export const ORG_ADMIN = {
  id: 'e0000000-0000-0000-0000-000000000002', role: 'owner',
  locations: [
    { id: STILL, name: 'UN1T Stillorgan', role: 'owner', organization_id: ORG },
    { id: HATCH, name: 'UN1T Hatch Street', role: 'owner', organization_id: ORG },
  ],
  assignmentsByLocation: { [STILL]: { role: 'owner', permissions: {} }, [HATCH]: { role: 'owner', permissions: {} } },
  activeLocation: { id: STILL, organization_id: ORG }, activeOrganization: { id: ORG }, orgAdminOrgIds: [ORG],
}
// A coach at Stillorgan: a studio member without landing_page (role default off).
export const STILL_COACH = {
  id: 'e0000000-0000-0000-0000-000000000004', role: 'head_coach',
  locations: [{ id: STILL, name: 'UN1T Stillorgan', role: 'head_coach', organization_id: ORG }],
  assignmentsByLocation: { [STILL]: { role: 'head_coach', permissions: {} } },
  activeLocation: { id: STILL, organization_id: ORG }, activeOrganization: { id: ORG }, orgAdminOrgIds: [],
}
export const MASTER = {
  id: 'e0000000-0000-0000-0000-000000000003', role: 'master', isMaster: true,
  locations: [], assignmentsByLocation: {}, activeOrganization: { id: ORG }, orgAdminOrgIds: [],
}

let idSeq = 0
const nextId = () => `f0000000-0000-0000-0000-${String(++idSeq).padStart(12, '0')}`

/**
 * failures: { '<table>.<op>': error | (query) => error | null } where op is
 * select | insert | update | delete. A function sees the recorded query.
 */
export function fakeDb({ tables = fixtureTables(), failures = {} } = {}) {
  const state = structuredClone(tables)
  const calls = []

  const embed = (table, row) => {
    if (table !== 'landing_page_studios') return { ...row }
    const loc = state.locations.find((l) => l.id === row.location_id) || null
    return { ...row, locations: loc && { id: loc.id, name: loc.name, membership_source: loc.membership_source, settings: loc.settings } }
  }

  function run(q, mode) {
    const f = failures[`${q.table}.${q.op}`]
    const failed = typeof f === 'function' ? f(q) : f
    if (failed) return { data: null, error: failed }
    const rows = state[q.table] || (state[q.table] = [])
    const match = (r) => q.filters.every((fn) => fn(r))
    let out
    if (q.op === 'insert') {
      const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ ...r }))
      for (const r of list) {
        if (q.table === 'landing_pages') {
          if (rows.some((x) => x.organization_id === r.organization_id && x.slug === r.slug)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "landing_pages_org_slug_key"' } }
          }
          r.id = r.id || nextId()
          r.updated_at = '2026-10-31T12:00:00Z'
        }
      }
      rows.push(...list)
      out = list
    } else if (q.op === 'update') {
      const hit = rows.filter(match)
      if (q.table === 'landing_pages' && q.payload.slug) {
        const clash = rows.find((x) => !hit.includes(x) && hit.some((h) => h.organization_id === x.organization_id) && x.slug === q.payload.slug)
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } }
      }
      for (const r of hit) Object.assign(r, q.payload)
      out = hit
    } else if (q.op === 'delete') {
      out = rows.filter(match)
      state[q.table] = rows.filter((r) => !match(r))
    } else {
      out = rows.filter(match)
      for (const col of q.orders.slice().reverse()) {
        out = out.slice().sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? ''), 'en', { numeric: true }))
      }
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1)
    }
    const data = out.map((r) => embed(q.table, r))
    if (mode === 'maybe') {
      if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } }
      return { data: data[0] || null, error: null }
    }
    if (mode === 'single') {
      if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'not exactly one row' } }
      return { data: data[0], error: null }
    }
    return { data: q.op === 'select' || q.returning ? data : null, error: null }
  }

  return {
    calls,
    state,
    writes: (table) => calls.filter((c) => c.table === table && c.op !== 'select'),
    from(table) {
      const q = { table, op: 'select', filters: [], eqs: [], orders: [], range: null, payload: null, returning: false }
      calls.push(q)
      const b = {
        select() { if (q.op !== 'select') q.returning = true; return b },
        insert(p) { q.op = 'insert'; q.payload = p; return b },
        update(p) { q.op = 'update'; q.payload = p; return b },
        delete() { q.op = 'delete'; return b },
        eq(c, v) { q.eqs.push([c, v]); q.filters.push((r) => r[c] === v); return b },
        in(c, vs) { q.eqs.push([c, vs]); q.filters.push((r) => vs.includes(r[c])); return b },
        order(c) { q.orders.push(c); return b },
        range(lo, hi) { q.range = [lo, hi]; return b },
        limit() { return b },
        maybeSingle: () => Promise.resolve(run(q, 'maybe')),
        single: () => Promise.resolve(run(q, 'single')),
        then: (res, rej) => Promise.resolve(run(q, 'list')).then(res, rej),
      }
      return b
    },
  }
}

export const jsonRequest = (url, method, body) => new Request(`http://localhost${url}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
