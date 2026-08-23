// SAAS-10 — shared fixture for the cross-tenant regression harness.
//
// One canonical two-tenant world (org A with locations A1+A2, org B with
// locations B1+B2, staff at every location, an org-admin of A, a master,
// per-org API keys, and tenant-data rows in EVERY location for every
// table the covered routes read), plus a filter-aware in-memory
// supabase double the route handlers run against.
//
// The double is a fork-and-generalise of src/lib/api-auth.test-helpers.js
// (SAAS-3) merged with the dotted-embed resolution of the SAAS-1 double
// in src/app/api/assistant/chat/route.test.js. It is forked rather than
// extended in place because the SAAS-3 helper has eight existing
// consumers pinned to its minimal semantics; this one adds or()/not()/
// gt/lt, head+count selects, delete, upsert, write recording, and
// PostgREST-faithful single()/update-returning semantics that those
// tests don't want.
//
// THE POINT of the filter-awareness: eq/in/or/gte/lte REALLY filter the
// fixture rows, so a route that forgets its location/org filter RECEIVES
// the other tenant's rows and fails the boundary assertion — a real leak
// guard, not a spy check. Never replace this with canned per-test
// results.

import { hashApiKey } from '@/lib/api-keys'

// ─── ids ─────────────────────────────────────────────────────────────
// Everything that can end up in a Zod `uuidLike` field must be
// uuid-shaped. tid() repeats a short hex tag through a uuid template so
// ids stay mnemonic in failure output ('c0a1…' = contact at A1, etc.).
export function tid(tag) {
  const t = tag.toLowerCase().padEnd(4, '0')
  if (!/^[0-9a-f]{1,4}$/.test(tag.toLowerCase())) throw new Error(`tid tag must be hex: ${tag}`)
  return `${t}${t}-${t}-${t}-${t}-${t}${t}${t}`
}

export const ORG_A = tid('00aa')
export const ORG_B = tid('00bb')
export const LOC_A1 = tid('10a1')
export const LOC_A2 = tid('10a2')
export const LOC_B1 = tid('10b1')
export const LOC_B2 = tid('10b2')

export const C_A1 = tid('c0a1') // contact at A1
export const C_A2 = tid('c0a2')
export const C_B1 = tid('c0b1')
export const C_B2 = tid('c0b2')

export const D_A1 = tid('d0a1') // deal at A1
export const D_A2 = tid('d0a2')
export const D_B1 = tid('d0b1')
export const D_B2 = tid('d0b2')

export const BK_A1 = tid('b0a1') // booking at A1
export const BK_A2 = tid('b0a2')
export const BK_B1 = tid('b0b1')
export const BK_B2 = tid('b0b2')

export const CAM_A1 = tid('caa1') // campaign at A1
export const CAM_A2 = tid('caa2')
export const CAM_B1 = tid('cab1')
export const CAM_B2 = tid('cab2')

export const TASK_A1 = tid('7aa1') // activities row, kind='task'
export const TASK_A2 = tid('7aa2')
export const TASK_B1 = tid('7ab1')
export const TASK_B2 = tid('7ab2')

export const ET_A1 = tid('e7a1') // event type (booking template)
export const ET_A2 = tid('e7a2')
export const ET_B1 = tid('e7b1')
export const ET_B2 = tid('e7b2')

export const STG_A1 = tid('57a1') // pipeline stage
export const STG_A2 = tid('57a2')
export const STG_B1 = tid('57b1')
export const STG_B2 = tid('57b2')

export const TPL_A = tid('7e0a') // contract template, org-scoped
export const TPL_B = tid('7e0b')

export const SHT_A1 = tid('5fa1') // shift template (assistant tools)
export const SHT_B1 = tid('5fb1')

// SHELLY-UI.9 — Shelly connection (one per location, location_id UNIQUE) and
// one adopted relay each, so the /api/shelly surface can be exercised for
// BOTH tenants against the same double.
export const SHC_A1 = tid('5ca1')
export const SHC_B1 = tid('5cb1')
export const SHD_A1 = tid('5da1')
export const SHD_B1 = tid('5db1')

// The credential and its sha256 fingerprint, per location. Both are FAKE and
// both are deliberately distinctive, so a response that carries either shows
// up in a JSON.stringify() assertion rather than having to be spotted by eye.
// The fingerprint is asserted alongside the key on purpose: it is a sha256 OF
// the key, so publishing it turns "is this the account?" into an offline check
// anyone holding a candidate key can run — connections.js treats the two as
// equally secret and so does the harness.
export const SHELLY_KEY_A1 = 'SHELLY-SECRET-KEY-MUST-NEVER-BE-RETURNED-aaa1'
export const SHELLY_KEY_B1 = 'SHELLY-SECRET-KEY-MUST-NEVER-BE-RETURNED-bbb1'
export const SHELLY_FP_A1 = 'a1'.repeat(32)
export const SHELLY_FP_B1 = 'b1'.repeat(32)
export const SHELLY_HOST_A1 = 'shelly-11-eu.shelly.cloud'
export const SHELLY_HOST_B1 = 'shelly-22-eu.shelly.cloud'

export const P_STAFF_A1 = tid('90a1')
export const P_MGR_A1 = tid('91a1')
export const P_OWNER_A1 = tid('92a1')
export const P_STAFF_A2 = tid('90a2')
export const P_STAFF_B1 = tid('90b1')
export const P_OWNER_B1 = tid('92b1')
export const P_STAFF_B2 = tid('90b2')
export const P_ORGADMIN_A = tid('9ada')
export const P_MASTER = tid('9a57')

// Raw bearer tokens. LEGACY_KEY stands in for the shared CRM_API_KEY
// (tests stub the env to it — unscoped BY DESIGN until n8n migrates);
// the unitk_ keys resolve against the api_keys rows by real SHA-256.
export const LEGACY_KEY = 'legacy-shared-crm-key-abcdefabcdefabcdefabcdefabcdefabcdef0123'
export const ORG_A_KEY = 'unitk_' + 'a'.repeat(40)
export const ORG_B_KEY = 'unitk_' + 'b'.repeat(40)

// ─── the world ───────────────────────────────────────────────────────
// Fresh copy per call — updates/deletes mutate it, so tests can assert
// a cross-tenant row is untouched after a blocked mutation.

const locRow = (id, orgId, name) => ({ id, organization_id: orgId, name, slug: name.toLowerCase().replace(/ /g, '-'), active: true })

export function makeWorld() {
  return {
    organizations: [
      { id: ORG_A, name: 'Org A', slug: 'org-a', active: true },
      { id: ORG_B, name: 'Org B', slug: 'org-b', active: true },
    ],
    locations: [
      locRow(LOC_A1, ORG_A, 'A One'),
      locRow(LOC_A2, ORG_A, 'A Two'),
      locRow(LOC_B1, ORG_B, 'B One'),
      locRow(LOC_B2, ORG_B, 'B Two'),
    ],
    api_keys: [
      { id: tid('ea0a'), organization_id: ORG_A, key_hash: hashApiKey(ORG_A_KEY), revoked_at: null, last_used_at: null },
      { id: tid('ea0b'), organization_id: ORG_B, key_hash: hashApiKey(ORG_B_KEY), revoked_at: null, last_used_at: null },
    ],
    profiles: [
      { id: P_STAFF_A1, full_name: 'Staff A-One', email: 'staff.a1@a.com', role: 'staff', active: true, employment_type: null },
      { id: P_MGR_A1, full_name: 'Manager A-One', email: 'mgr.a1@a.com', role: 'manager', active: true, employment_type: null },
      { id: P_OWNER_A1, full_name: 'Owner A-One', email: 'owner.a1@a.com', role: 'owner', active: true, employment_type: null },
      { id: P_STAFF_A2, full_name: 'Staff A-Two', email: 'staff.a2@a.com', role: 'staff', active: true, employment_type: null },
      { id: P_STAFF_B1, full_name: 'Staff B-One', email: 'staff.b1@b.com', role: 'staff', active: true, employment_type: null },
      { id: P_OWNER_B1, full_name: 'Owner B-One', email: 'owner.b1@b.com', role: 'owner', active: true, employment_type: null },
      { id: P_STAFF_B2, full_name: 'Staff B-Two', email: 'staff.b2@b.com', role: 'staff', active: true, employment_type: null },
      { id: P_ORGADMIN_A, full_name: 'Org Admin A', email: 'admin@a.com', role: 'staff', active: true, employment_type: null },
      { id: P_MASTER, full_name: 'The Master', email: 'master@platform.com', role: 'master', active: true, employment_type: null },
    ],
    profile_locations: [
      { profile_id: P_STAFF_A1, location_id: LOC_A1, role: 'staff', is_default: true, permissions: {} },
      { profile_id: P_MGR_A1, location_id: LOC_A1, role: 'manager', is_default: true, permissions: {} },
      { profile_id: P_OWNER_A1, location_id: LOC_A1, role: 'owner', is_default: true, permissions: {} },
      { profile_id: P_STAFF_A2, location_id: LOC_A2, role: 'staff', is_default: true, permissions: {} },
      { profile_id: P_STAFF_B1, location_id: LOC_B1, role: 'staff', is_default: true, permissions: {} },
      { profile_id: P_OWNER_B1, location_id: LOC_B1, role: 'owner', is_default: true, permissions: {} },
      { profile_id: P_STAFF_B2, location_id: LOC_B2, role: 'staff', is_default: true, permissions: {} },
    ],
    profile_organizations: [
      { profile_id: P_ORGADMIN_A, organization_id: ORG_A, role: 'org_admin' },
    ],
    // Every contact name/email contains the shared token "Lead"/"lead."
    // so a single search term matches ALL tenants — an unscoped search
    // would surface the other org and fail the assertion.
    contacts: [
      { id: C_A1, location_id: LOC_A1, name: 'Alice A-One Lead', first_name: 'Alice', last_name: 'A-One', email: 'lead.a1@example.com', phone: '+353870000001', tags: [], glofox_member_id: null, pipeline_stage_slug: 'lead', trial_credits_remaining: 3, is_primary_contact: true, person_group_id: null, created_at: '2026-07-01T00:00:00Z' },
      { id: C_A2, location_id: LOC_A2, name: 'Andy A-Two Lead', first_name: 'Andy', last_name: 'A-Two', email: 'lead.a2@example.com', phone: '+353870000002', tags: [], glofox_member_id: null, pipeline_stage_slug: 'lead', trial_credits_remaining: 3, is_primary_contact: true, person_group_id: null, created_at: '2026-07-02T00:00:00Z' },
      { id: C_B1, location_id: LOC_B1, name: 'Bob B-One Lead', first_name: 'Bob', last_name: 'B-One', email: 'lead.b1@example.com', phone: '+353870000003', tags: [], glofox_member_id: null, pipeline_stage_slug: 'lead', trial_credits_remaining: 3, is_primary_contact: true, person_group_id: null, created_at: '2026-07-03T00:00:00Z' },
      { id: C_B2, location_id: LOC_B2, name: 'Ben B-Two Lead', first_name: 'Ben', last_name: 'B-Two', email: 'lead.b2@example.com', phone: '+353870000004', tags: [], glofox_member_id: null, pipeline_stage_slug: 'lead', trial_credits_remaining: 3, is_primary_contact: true, person_group_id: null, created_at: '2026-07-04T00:00:00Z' },
    ],
    deals: [
      { id: D_A1, title: 'Deal A-One', contact_id: C_A1, location_id: LOC_A1, stage_id: STG_A1, status: 'open', value: 100 },
      { id: D_A2, title: 'Deal A-Two', contact_id: C_A2, location_id: LOC_A2, stage_id: STG_A2, status: 'open', value: 200 },
      { id: D_B1, title: 'Deal B-One', contact_id: C_B1, location_id: LOC_B1, stage_id: STG_B1, status: 'open', value: 300 },
      { id: D_B2, title: 'Deal B-Two', contact_id: C_B2, location_id: LOC_B2, stage_id: STG_B2, status: 'open', value: 400 },
    ],
    pipeline_stages: [
      { id: STG_A1, location_id: LOC_A1, slug: 'lead', name: 'Lead A1', display_order: 1 },
      { id: STG_A2, location_id: LOC_A2, slug: 'lead', name: 'Lead A2', display_order: 1 },
      { id: STG_B1, location_id: LOC_B1, slug: 'lead', name: 'Lead B1', display_order: 1 },
      { id: STG_B2, location_id: LOC_B2, slug: 'lead', name: 'Lead B2', display_order: 1 },
    ],
    bookings: [
      { id: BK_A1, location_id: LOC_A1, contact_id: C_A1, event_type_id: ET_A1, status: 'pending', booking_date: '2026-08-01', start_time: '09:00', notes: null },
      { id: BK_A2, location_id: LOC_A2, contact_id: C_A2, event_type_id: ET_A2, status: 'pending', booking_date: '2026-08-02', start_time: '10:00', notes: null },
      { id: BK_B1, location_id: LOC_B1, contact_id: C_B1, event_type_id: ET_B1, status: 'pending', booking_date: '2026-08-03', start_time: '11:00', notes: null },
      { id: BK_B2, location_id: LOC_B2, contact_id: C_B2, event_type_id: ET_B2, status: 'pending', booking_date: '2026-08-04', start_time: '12:00', notes: null },
    ],
    event_types: [
      { id: ET_A1, location_id: LOC_A1, name: 'Consult A1', slug: 'consult-a1', active: true, created_at: '2026-01-01T00:00:00Z' },
      { id: ET_A2, location_id: LOC_A2, name: 'Consult A2', slug: 'consult-a2', active: true, created_at: '2026-01-02T00:00:00Z' },
      { id: ET_B1, location_id: LOC_B1, name: 'Consult B1', slug: 'consult-b1', active: true, created_at: '2026-01-03T00:00:00Z' },
      { id: ET_B2, location_id: LOC_B2, name: 'Consult B2', slug: 'consult-b2', active: true, created_at: '2026-01-04T00:00:00Z' },
    ],
    campaigns: [
      { id: CAM_A1, location_id: LOC_A1, name: 'Campaign A-One', status: 'draft', subject: 'A1', audience_filter: {}, created_at: '2026-06-01T00:00:00Z' },
      { id: CAM_A2, location_id: LOC_A2, name: 'Campaign A-Two', status: 'draft', subject: 'A2', audience_filter: {}, created_at: '2026-06-02T00:00:00Z' },
      { id: CAM_B1, location_id: LOC_B1, name: 'Campaign B-One', status: 'draft', subject: 'B1', audience_filter: {}, created_at: '2026-06-03T00:00:00Z' },
      { id: CAM_B2, location_id: LOC_B2, name: 'Campaign B-Two', status: 'draft', subject: 'B2', audience_filter: {}, created_at: '2026-06-04T00:00:00Z' },
    ],
    activities: [
      { id: TASK_A1, location_id: LOC_A1, kind: 'task', type: 'task', subject: 'Task A-One', status: 'todo', contact_id: null, assignee_id: null, created_at: '2026-06-01T00:00:00Z' },
      { id: TASK_A2, location_id: LOC_A2, kind: 'task', type: 'task', subject: 'Task A-Two', status: 'todo', contact_id: null, assignee_id: null, created_at: '2026-06-02T00:00:00Z' },
      { id: TASK_B1, location_id: LOC_B1, kind: 'task', type: 'task', subject: 'Task B-One', status: 'todo', contact_id: null, assignee_id: null, created_at: '2026-06-03T00:00:00Z' },
      { id: TASK_B2, location_id: LOC_B2, kind: 'task', type: 'task', subject: 'Task B-Two', status: 'todo', contact_id: null, assignee_id: null, created_at: '2026-06-04T00:00:00Z' },
    ],
    notes: [],
    contract_templates: [
      { id: TPL_A, organization_id: ORG_A, name: 'Org A Contract', description: null, body_markdown: 'ORG A SALARY TERMS', variables_schema: [], employment_type: null, version: 1, active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: TPL_B, organization_id: ORG_B, name: 'Org B Contract', description: null, body_markdown: 'ORG B SALARY TERMS', variables_schema: [], employment_type: null, version: 1, active: true, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    ],
    landing_page_settings: [
      { location_id: LOC_A1, public_path: 'a-one', chooser_label: 'A One Original', chooser_cta_text: null, chooser_image_url: null, publish_state: 'published' },
      { location_id: LOC_A2, public_path: 'a-two', chooser_label: 'A Two Original', chooser_cta_text: null, chooser_image_url: null, publish_state: 'published' },
      { location_id: LOC_B1, public_path: 'b-one', chooser_label: 'B One Original', chooser_cta_text: null, chooser_image_url: null, publish_state: 'published' },
      { location_id: LOC_B2, public_path: 'b-two', chooser_label: 'B Two Original', chooser_cta_text: null, chooser_image_url: null, publish_state: 'published' },
    ],
    chooser_settings: [
      { id: 'default', headline: 'Pick a studio', intro: null, tile_order: [] },
    ],
    shift_templates: [
      { id: SHT_A1, location_id: LOC_A1, name: 'Morning A1', start_time: '09:00:00', end_time: '17:00:00', max_coaches: 10, active: true },
      { id: SHT_B1, location_id: LOC_B1, name: 'Morning B1', start_time: '09:00:00', end_time: '17:00:00', max_coaches: 10, active: true },
    ],
    // SHELLY-UI.9 — one Shelly account per location (mig 562:
    // shelly_connections.location_id UNIQUE), carrying the FULL row including
    // auth_key and auth_key_fingerprint. The double returns whole rows
    // regardless of the column list a route selects, which is the point: the
    // only thing standing between the key and the response is
    // publicConnectionView's allowlist, and that is what the assertions test.
    shelly_connections: [
      {
        id: SHC_A1, location_id: LOC_A1, host: SHELLY_HOST_A1,
        auth_key: SHELLY_KEY_A1, auth_key_fingerprint: SHELLY_FP_A1, key_hint: 'aaa1',
        status: 'connected', last_ok_at: '2026-08-23T09:00:00Z', last_error: null, last_error_at: null,
        linked_by: P_OWNER_A1, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-23T09:00:00Z',
      },
      {
        id: SHC_B1, location_id: LOC_B1, host: SHELLY_HOST_B1,
        auth_key: SHELLY_KEY_B1, auth_key_fingerprint: SHELLY_FP_B1, key_hint: 'bbb1',
        status: 'connected', last_ok_at: '2026-08-23T09:00:00Z', last_error: null, last_error_at: null,
        linked_by: P_OWNER_B1, created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-23T09:00:00Z',
      },
    ],
    // One adopted relay channel each. (device_id, channel) is UNIQUE across
    // the WHOLE estate (mig 562), so the two device_ids differ — a fixture
    // that reused one would not be a state the database can hold.
    shelly_devices: [
      {
        id: SHD_A1, location_id: LOC_A1, device_id: 'aa11bb22cc31', channel: 0,
        name: 'A One Heater', model: 'SNSW-001X16EU', gen: 2, zone: null,
        enabled: true, schedule_mode: 'fixed',
        fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '06:30', off: '21:00' }], class_rule: {},
        override: null, last_applied: null,
        last_state: { online: true, output: false, apower: 0, aenergy_wh: 1200, temperature_c: 21, source: 'timer', at: '2026-08-23T09:00:00Z' },
        last_seen_at: '2026-08-23T09:00:00Z', adopted_by: P_OWNER_A1,
        created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-23T09:00:00Z',
      },
      {
        id: SHD_B1, location_id: LOC_B1, device_id: 'bb11cc22dd31', channel: 0,
        name: 'B One Heater', model: 'SNSW-001X16EU', gen: 2, zone: null,
        enabled: true, schedule_mode: 'fixed',
        fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '07:00', off: '20:00' }], class_rule: {},
        override: null, last_applied: null,
        last_state: { online: true, output: false, apower: 0, aenergy_wh: 900, temperature_c: 20, source: 'timer', at: '2026-08-23T09:00:00Z' },
        last_seen_at: '2026-08-23T09:00:00Z', adopted_by: P_OWNER_B1,
        created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-23T09:00:00Z',
      },
    ],
  }
}

// ─── the in-memory supabase double ───────────────────────────────────

function ilikeToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i')
}

// Split a PostgREST .or() string on top-level commas (commas inside
// parens belong to `in.(a,b)` lists).
function splitOrClauses(str) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of str) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else { cur += ch }
  }
  if (cur) out.push(cur)
  return out
}

// One or() clause → predicate. Supports col.ilike.pat / col.eq.val /
// col.in.(a,b) / col.is.null — the forms the covered routes emit.
function orClausePredicate(clause, colVal) {
  const m = clause.match(/^([^.]+(?:\.[^.]+)*?)\.(ilike|eq|in|is)\.(.*)$/)
  if (!m) return () => false
  const [, col, op, rest] = m
  if (op === 'ilike') { const rx = ilikeToRegExp(rest); return (r) => { const v = colVal(r, col); return v != null && rx.test(String(v)) } }
  if (op === 'eq') return (r) => String(colVal(r, col)) === rest
  if (op === 'is') return (r) => (colVal(r, col) ?? null) === (rest === 'null' ? null : rest === 'true')
  if (op === 'in') {
    const vals = rest.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim()).filter(Boolean)
    return (r) => vals.includes(String(colVal(r, col)))
  }
  return () => false
}

/**
 * Filter-aware chainable supabase-js double over in-memory tables.
 *
 * Reads REALLY apply eq/neq/is/in/gt/gte/lt/lte/ilike/or/not (dotted
 * column paths traverse embedded objects), then order/limit/range, and
 * resolve via then()/single()/maybeSingle() with PostgREST-faithful
 * shapes (single() errors on 0 rows; head+count selects return a count
 * and no rows). insert/update/upsert/delete mutate the fixture arrays
 * in place AND append to db._writes so tests can assert both "the
 * cross-tenant row is untouched" and "no write was even issued".
 *
 * @param {Record<string, object[]>} tables — usually makeWorld()
 */
export function makeTenantDb(tables) {
  const writes = []
  const colVal = (row, col) => col.split('.').reduce((o, k) => (o == null ? o : o[k]), row)

  function from(table) {
    if (!tables[table]) tables[table] = []
    const state = {
      op: 'select', payload: null, upsertOpts: null,
      filters: [], order: [], limit: null, range: null,
      selectOpts: null, sawSelect: false,
    }

    function matchRows() {
      let rows = tables[table].slice()
      for (const f of state.filters) {
        if (f.type === 'eq') rows = rows.filter((r) => colVal(r, f.col) === f.val)
        else if (f.type === 'neq') rows = rows.filter((r) => colVal(r, f.col) !== f.val)
        else if (f.type === 'is') rows = rows.filter((r) => (colVal(r, f.col) ?? null) === f.val)
        else if (f.type === 'in') rows = rows.filter((r) => f.val.includes(colVal(r, f.col)))
        else if (f.type === 'gt') rows = rows.filter((r) => colVal(r, f.col) > f.val)
        else if (f.type === 'gte') rows = rows.filter((r) => colVal(r, f.col) >= f.val)
        else if (f.type === 'lt') rows = rows.filter((r) => colVal(r, f.col) < f.val)
        else if (f.type === 'lte') rows = rows.filter((r) => colVal(r, f.col) <= f.val)
        else if (f.type === 'ilike') { const rx = ilikeToRegExp(f.val); rows = rows.filter((r) => { const v = colVal(r, f.col); return v != null && rx.test(String(v)) }) }
        else if (f.type === 'not') {
          // .not(col, op, val) — negate the op. Covered routes only use
          // .not('col', 'is', null); keep that faithful, fail loud otherwise.
          if (f.op !== 'is') throw new Error(`makeTenantDb: .not() op '${f.op}' not implemented`)
          rows = rows.filter((r) => (colVal(r, f.col) ?? null) !== f.val)
        } else if (f.type === 'or') {
          const preds = splitOrClauses(f.val).map((c) => orClausePredicate(c.trim(), colVal))
          rows = rows.filter((r) => preds.some((p) => p(r)))
        }
      }
      return rows
    }

    function applyModifiers(rows) {
      let out = rows.slice()
      for (const o of state.order) {
        const asc = o.ascending !== false
        out.sort((a, b) => {
          const av = colVal(a, o.col); const bv = colVal(b, o.col)
          if (av === bv) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return (av < bv ? -1 : 1) * (asc ? 1 : -1)
        })
      }
      if (state.range) out = out.slice(state.range[0], state.range[1] + 1)
      if (state.limit != null) out = out.slice(0, state.limit)
      return out
    }

    function settle(mode) {
      // mode: 'many' | 'single' | 'maybe'
      if (state.op === 'insert' || state.op === 'upsert') {
        const payloads = Array.isArray(state.payload) ? state.payload : [state.payload]
        const resultRows = []
        for (const [i, p] of payloads.entries()) {
          if (state.op === 'upsert') {
            const conflictCol = state.upsertOpts?.onConflict || 'id'
            const existing = tables[table].find((r) => r[conflictCol] === p[conflictCol])
            if (existing) { Object.assign(existing, p); resultRows.push(existing); continue }
          }
          const row = { id: p.id ?? `${table}-new-${tables[table].length + i}`, ...p }
          tables[table].push(row)
          resultRows.push(row)
        }
        writes.push({ table, op: state.op, payload: state.payload, opts: state.upsertOpts })
        return { data: mode === 'many' ? resultRows : (resultRows[0] ?? null), error: null }
      }
      if (state.op === 'update') {
        const matched = matchRows()
        for (const row of matched) Object.assign(row, state.payload)
        writes.push({ table, op: 'update', payload: state.payload, filters: state.filters, matchedIds: matched.map((r) => r.id) })
        if (mode === 'single') {
          return matched.length === 1
            ? { data: matched[0], error: null }
            : { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${matched.length}` } }
        }
        return { data: mode === 'maybe' ? (matched[0] ?? null) : matched, error: null }
      }
      if (state.op === 'delete') {
        const matched = matchRows()
        tables[table] = tables[table].filter((r) => !matched.includes(r))
        writes.push({ table, op: 'delete', filters: state.filters, matchedIds: matched.map((r) => r.id) })
        return { data: mode === 'many' ? matched : (matched[0] ?? null), error: null }
      }
      // select
      const rows = applyModifiers(matchRows())
      if (state.selectOpts?.head) {
        return { data: null, error: null, count: state.selectOpts?.count ? rows.length : null }
      }
      if (mode === 'single') {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${rows.length}` } }
      }
      if (mode === 'maybe') return { data: rows[0] ?? null, error: null }
      const res = { data: rows, error: null }
      if (state.selectOpts?.count) res.count = rows.length
      return res
    }

    const b = {}
    const chain = (fn) => (...args) => { fn(...args); return b }
    // PostgREST trap (CLAUDE.md): head/count options are only read on
    // the FIRST .select() after .from() — mimic that exactly.
    b.select = chain((_cols, opts) => { if (!b._selectedOnce) { state.selectOpts = opts || null; b._selectedOnce = true } })
    b.insert = chain((payload) => { state.op = 'insert'; state.payload = payload })
    b.update = chain((payload) => { state.op = 'update'; state.payload = payload })
    b.upsert = chain((payload, opts) => { state.op = 'upsert'; state.payload = payload; state.upsertOpts = opts || null })
    b.delete = chain(() => { state.op = 'delete' })
    b.eq = chain((col, val) => state.filters.push({ type: 'eq', col, val }))
    b.neq = chain((col, val) => state.filters.push({ type: 'neq', col, val }))
    b.is = chain((col, val) => state.filters.push({ type: 'is', col, val }))
    b.in = chain((col, val) => state.filters.push({ type: 'in', col, val }))
    b.gt = chain((col, val) => state.filters.push({ type: 'gt', col, val }))
    b.gte = chain((col, val) => state.filters.push({ type: 'gte', col, val }))
    b.lt = chain((col, val) => state.filters.push({ type: 'lt', col, val }))
    b.lte = chain((col, val) => state.filters.push({ type: 'lte', col, val }))
    b.ilike = chain((col, val) => state.filters.push({ type: 'ilike', col, val }))
    b.or = chain((str) => state.filters.push({ type: 'or', val: str }))
    b.not = chain((col, op, val) => state.filters.push({ type: 'not', col, op, val }))
    b.order = chain((col, opts) => state.order.push({ col, ...(opts || {}) }))
    b.limit = chain((n) => { state.limit = n })
    b.range = chain((lo, hi) => { state.range = [lo, hi] })
    b.single = () => Promise.resolve(settle('single'))
    b.maybeSingle = () => Promise.resolve(settle('maybe'))
    b.then = (onF, onR) => Promise.resolve(settle('many')).then(onF, onR)
    return b
  }

  return {
    from,
    _writes: writes,
    _writesTo(table) { return writes.filter((w) => w.table === table) },
  }
}

// ─── personas ────────────────────────────────────────────────────────
// getCurrentUser()-shaped user objects, hand-built to the exact shape
// src/lib/auth.js returns (locations / rolesByLocation / activeLocation
// / organizationsById / orgAdminOrgIds / isMaster / role / profileRole).
// The org-admin persona mirrors the SAAS-4 expandOrgAdminAccess output:
// every active org-A location with a synthetic 'owner' role.

const ROWS = makeWorld() // static copies for persona construction only
const loc = (id) => ROWS.locations.find((l) => l.id === id)
const org = (id) => ROWS.organizations.find((o) => o.id === id)

function baseUser({ id, name, email, role, profileRole = role, locations, rolesByLocation, orgIds, orgAdminOrgIds = [], activeLocationId }) {
  const locationRows = locations.map(loc)
  const organizationsById = Object.fromEntries(orgIds.map((o) => [o, org(o)]))
  const activeLocation = loc(activeLocationId) || locationRows[0] || null
  return {
    id,
    full_name: name,
    email,
    user: { id, email },
    role,
    profileRole,
    isMaster: profileRole === 'master',
    locations: locationRows,
    activeLocation,
    activeOrganization: activeLocation ? organizationsById[activeLocation.organization_id] || null : null,
    organizationsById,
    orgAdminOrgIds,
    rolesByLocation,
    assignmentsByLocation: Object.fromEntries(Object.entries(rolesByLocation).map(([l, r]) => [l, { role: r, permissions: {}, is_default: false, unifi_door_access: false }])),
    activeAssignment: activeLocation ? { role: rolesByLocation[activeLocation.id] || role, permissions: {}, is_default: false, unifi_door_access: false } : null,
    roleTemplatesByLocation: {},
    activeRoleTemplate: null,
    impersonatingFrom: null,
  }
}

export const users = {
  staffA1: () => baseUser({ id: P_STAFF_A1, name: 'Staff A-One', email: 'staff.a1@a.com', role: 'staff', locations: [LOC_A1], rolesByLocation: { [LOC_A1]: 'staff' }, orgIds: [ORG_A], activeLocationId: LOC_A1 }),
  managerA1: () => baseUser({ id: P_MGR_A1, name: 'Manager A-One', email: 'mgr.a1@a.com', role: 'manager', locations: [LOC_A1], rolesByLocation: { [LOC_A1]: 'manager' }, orgIds: [ORG_A], activeLocationId: LOC_A1 }),
  ownerA1: () => baseUser({ id: P_OWNER_A1, name: 'Owner A-One', email: 'owner.a1@a.com', role: 'owner', locations: [LOC_A1], rolesByLocation: { [LOC_A1]: 'owner' }, orgIds: [ORG_A], activeLocationId: LOC_A1 }),
  ownerB1: () => baseUser({ id: P_OWNER_B1, name: 'Owner B-One', email: 'owner.b1@b.com', role: 'owner', locations: [LOC_B1], rolesByLocation: { [LOC_B1]: 'owner' }, orgIds: [ORG_B], activeLocationId: LOC_B1 }),
  // Org admin of A: no explicit assignments; SAAS-4 expansion grants
  // synthetic 'owner' at every active org-A location.
  orgAdminA: () => baseUser({ id: P_ORGADMIN_A, name: 'Org Admin A', email: 'admin@a.com', role: 'owner', profileRole: 'staff', locations: [LOC_A1, LOC_A2], rolesByLocation: { [LOC_A1]: 'owner', [LOC_A2]: 'owner' }, orgIds: [ORG_A], orgAdminOrgIds: [ORG_A], activeLocationId: LOC_A1 }),
  master: () => baseUser({ id: P_MASTER, name: 'The Master', email: 'master@platform.com', role: 'master', locations: [LOC_A1, LOC_A2, LOC_B1, LOC_B2], rolesByLocation: {}, orgIds: [ORG_A, ORG_B], activeLocationId: LOC_A1 }),
}

/** Same persona, different active location (master browsing tenant B, etc.). */
export function withActiveLocation(user, locationId) {
  const activeLocation = user.locations.find((l) => l.id === locationId) || loc(locationId)
  return { ...user, activeLocation, activeOrganization: user.organizationsById[activeLocation?.organization_id] || null }
}

// ─── request/response helpers ────────────────────────────────────────

export function makeReq(path, { method = 'GET', bearer = null, body = undefined, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers }
  if (bearer) h.Authorization = `Bearer ${bearer}`
  return new Request(`http://localhost${path}`, {
    method,
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** Route detail props — handlers do `await props.params`. */
export const propsOf = (params) => ({ params })

export async function jsonOf(res) {
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { status: res.status, json }
}

export const idsOf = (rows, key = 'id') => (rows || []).map((r) => r[key]).sort()
