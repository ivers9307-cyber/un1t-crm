// ORGCONTACTS.4 — the segment change report (scripts/segment-stage-change-report.mjs):
// for every saved audience of an organisation that filters on
// pipeline_stage_slug, how its membership changes when the field reads the
// stage AT the audience studio (contact_location_audience.studio_stage_slug,
// mig 766) instead of the contact-wide column. Richard reads the report before
// the flip (decision 3). Pure parts tested here; the runner over a fake view.
// Fictional ids only.
import { describe, it, expect } from 'vitest'
import { rewriteStageField, compareAudience, collectAudiences, renderReport, STAGE_FIELD, STUDIO_STAGE_FIELD } from '../scripts/segment-stage-change-report.mjs'
import { makeTenantDb } from './cross-tenant/fixture.js'

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const ORG = 'f0000000-0000-0000-0000-000000000001'
const C_DORMANT_A = '30000000-0000-0000-0000-000000000001' // dormant at A (primary), on B's list with no row at B
const C_MEMBER_B = '30000000-0000-0000-0000-000000000002'  // member at B, a lead at A
const C_LEAD_B = '30000000-0000-0000-0000-000000000003'    // lead at B, dormant contact-wide (primary A)

// contact_location_audience rows: one per (contact, studio list), with the
// contact-wide stage and the studio stage as mig 766 exposes them.
const view = (id, loc, contactWide, studio) => ({ id, audience_location_id: loc, loc_email_marketing: true, loc_whatsapp_marketing: true, pipeline_stage_slug: contactWide, studio_stage_slug: studio })
const WORLD = () => ({
  locations: [{ id: LOC_A, name: 'Studio A', organization_id: ORG }, { id: LOC_B, name: 'Studio B', organization_id: ORG }],
  contact_location_audience: [
    view(C_DORMANT_A, LOC_A, 'dormant', 'dormant'),
    view(C_DORMANT_A, LOC_B, 'dormant', null),
    view(C_MEMBER_B, LOC_B, 'member', 'member'),
    view(C_MEMBER_B, LOC_A, 'member', 'new_lead'),
    view(C_LEAD_B, LOC_B, 'dormant', 'new_lead'),
    view(C_LEAD_B, LOC_A, 'dormant', 'dormant'),
  ],
  contact_segments: [
    { id: 'seg-b-dormant', location_id: LOC_B, name: 'B dormant', filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'dormant' }] } },
    { id: 'seg-b-other', location_id: LOC_B, name: 'B by email', filter: { logic: 'and', filters: [{ field: 'email_status', op: 'eq', value: 'active' }] } },
  ],
  campaigns: [
    { id: 'camp-a-notmember', location_id: LOC_A, name: 'A not members', status: 'draft', audience_filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'neq', value: 'member' }] } },
    { id: 'camp-a-sent', location_id: LOC_A, name: 'A old', status: 'sent', audience_filter: { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] } },
  ],
  whatsapp_broadcasts: [],
  email_sequences: [
    { id: 'seq-b', location_id: LOC_B, name: 'B members', active: true, audience_filter: { logic: 'or', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }, { field: 'pipeline_stage_slug', op: 'is_null', value: '' }] } },
  ],
})

describe('rewriteStageField', () => {
  it('rewrites only pipeline_stage_slug rows, nested logic groups included, and leaves is_null / is_not_null ops intact', () => {
    const filter = {
      logic: 'and',
      filters: [
        { field: 'pipeline_stage_slug', op: 'eq', value: 'dormant' },
        { field: 'email_status', op: 'eq', value: 'active' },
        { logic: 'or', filters: [
          { field: 'pipeline_stage_slug', op: 'is_null', value: '' },
          { field: 'pipeline_stage_slug', op: 'is_not_null', value: '' },
          { field: 'lead_source', op: 'neq', value: 'ad' },
        ] },
      ],
    }
    const out = rewriteStageField(filter)
    expect(out).toEqual({
      logic: 'and',
      filters: [
        { field: STUDIO_STAGE_FIELD, op: 'eq', value: 'dormant' },
        { field: 'email_status', op: 'eq', value: 'active' },
        { logic: 'or', filters: [
          { field: STUDIO_STAGE_FIELD, op: 'is_null', value: '' },
          { field: STUDIO_STAGE_FIELD, op: 'is_not_null', value: '' },
          { field: 'lead_source', op: 'neq', value: 'ad' },
        ] },
      ],
    })
    expect(filter.filters[0].field).toBe(STAGE_FIELD) // the input is not mutated
    expect(STAGE_FIELD).toBe('pipeline_stage_slug')
    expect(STUDIO_STAGE_FIELD).toBe('studio_stage_slug')
  })

  it('a filter with no stage row comes back equal; null stays null', () => {
    const f = { logic: 'and', filters: [{ field: 'email', op: 'contains', value: 'x' }] }
    expect(rewriteStageField(f)).toEqual(f)
    expect(rewriteStageField(null)).toBe(null)
  })
})

describe('compareAudience — before (contact-wide stage) vs after (the stage at the studio)', () => {
  it('Review Focus 4: a contact dormant at A with no row at B LEAVES a B "stage eq dormant" segment, counted as stage-NULL-at-studio', async () => {
    const db = makeTenantDb(WORLD())
    const r = await compareAudience(db, { locationId: LOC_B, filter: WORLD().contact_segments[0].filter, consentColumn: 'loc_email_marketing' })
    expect(r.before.sort()).toEqual([C_DORMANT_A, C_LEAD_B].sort())
    expect(r.after).toEqual([])
    expect(r.joined).toEqual([])
    expect(r.left.sort()).toEqual([C_DORMANT_A, C_LEAD_B].sort())
    expect(r.leftStageNull).toEqual([C_DORMANT_A])
  })

  it('a null-inclusive neq at A: the B member who is a lead at A stays; nothing joins or leaves until a stage differs', async () => {
    const db = makeTenantDb(WORLD())
    const r = await compareAudience(db, { locationId: LOC_A, filter: WORLD().campaigns[0].audience_filter, consentColumn: 'loc_email_marketing' })
    expect(r.before.sort()).toEqual([C_DORMANT_A, C_LEAD_B].sort())
    expect(r.after.sort()).toEqual([C_DORMANT_A, C_LEAD_B, C_MEMBER_B].sort())
    expect(r.joined).toEqual([C_MEMBER_B])
    expect(r.joinedStageNull).toEqual([])
    expect(r.left).toEqual([])
  })
})

describe('collectAudiences + renderReport', () => {
  it('lists every saved audience of the organisation that names the stage field, across the four tables, with its studio', async () => {
    const db = makeTenantDb(WORLD())
    const rows = await collectAudiences(db, ORG)
    expect(rows.map((r) => `${r.kind}:${r.id}@${r.studio}`).sort()).toEqual([
      'campaign:camp-a-notmember@Studio A', 'campaign:camp-a-sent@Studio A', 'segment:seg-b-dormant@Studio B', 'sequence:seq-b@Studio B',
    ].sort())
    expect(rows.find((r) => r.id === 'camp-a-sent').status).toBe('sent')
    expect(rows.find((r) => r.id === 'seq-b').status).toBe('active')
  })

  it('renders a Markdown table with counts only, ids under --verbose', async () => {
    const db = makeTenantDb(WORLD())
    const rows = await collectAudiences(db, ORG)
    const results = []
    for (const a of rows) results.push({ ...a, ...(await compareAudience(db, { locationId: a.location_id, filter: a.filter, consentColumn: a.consentColumn })) })
    const md = renderReport(results, { orgId: ORG, verbose: false })
    expect(md).toContain('| segment | B dormant | Studio B |')
    expect(md).toMatch(/\| segment \| B dormant \| Studio B \| saved \| 2 \| 0 \| 0 \| 2 \| 1 \| 0 \|/)
    expect(md).toMatch(/\| campaign \| A not members \| Studio A \| draft \| 2 \| 3 \| 1 \| 0 \| 0 \| 0 \|/)
    expect(md).not.toContain(C_DORMANT_A)
    const verbose = renderReport(results, { orgId: ORG, verbose: true })
    expect(verbose).toContain(C_DORMANT_A)
  })
})
