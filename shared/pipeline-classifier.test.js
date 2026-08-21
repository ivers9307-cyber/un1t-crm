// FUNNEL-M.1 — tests for the funnel taxonomy + stage-split helper that
// shipped with the shared/ move of the classifier. The classifier's own
// behaviour tests stay in src/lib/pipeline-classifier.test.js and keep
// importing through the '@/lib/pipeline-classifier' re-export — which
// also proves the re-export seam works.
import { describe, it, expect } from 'vitest'
import {
  FUNNEL_STAGE_SLUGS,
  OFF_FUNNEL_STAGE_SLUGS,
  splitStagesByFunnel,
  classifyContact,
} from './pipeline-classifier.js'

// Minimal stage-row factory mirroring pipeline_stages columns.
const stage = (slug, { dormant = false, archived = false, order = null } = {}) => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  is_dormant: dormant,
  archived,
  display_order: order,
})

describe('funnel taxonomy constants', () => {
  it('funnel is the 5 journey stages in order', () => {
    expect(FUNNEL_STAGE_SLUGS).toEqual([
      'new_lead', 'first_class', 'second_class', 'trial_done', 'converted',
    ])
  })

  it('off-funnel includes pack_member as a first-class group (FUNNEL.3)', () => {
    expect(OFF_FUNNEL_STAGE_SLUGS).toContain('pack_member')
    expect(OFF_FUNNEL_STAGE_SLUGS).toEqual([
      'member', 'pack_member', 'classpass', 'gympass', 'cold_lead', 'dormant',
    ])
  })

  it('the two lists never overlap', () => {
    const overlap = FUNNEL_STAGE_SLUGS.filter((s) => OFF_FUNNEL_STAGE_SLUGS.includes(s))
    expect(overlap).toEqual([])
  })

  it('covers every slug the classifier can emit (spot checks)', () => {
    const all = new Set([...FUNNEL_STAGE_SLUGS, ...OFF_FUNNEL_STAGE_SLUGS])
    // A fresh lead, a member, a ClassPass user, a pack customer, a
    // cold-dismissed lead, and a null contact (dormant) all land in a
    // known pile.
    const NOW = Date.now()
    const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString()
    expect(all.has(classifyContact({ joined_at: iso(5) }, NOW))).toBe(true)
    expect(all.has(classifyContact({ glofox_membership_status: 'member' }, NOW))).toBe(true)
    expect(all.has(classifyContact({ glofox_membership_status: 'classpass_payg' }, NOW))).toBe(true)
    expect(all.has(classifyContact({ pack_customer_at: iso(10) }, NOW))).toBe(true)
    expect(all.has(classifyContact({ joined_at: iso(5), pipeline_dismissed_at: iso(1) }, NOW))).toBe(true)
    expect(all.has(classifyContact(null, NOW))).toBe(true)
  })
})

describe('splitStagesByFunnel', () => {
  it('partitions on is_dormant, both sides ordered by display_order', () => {
    const rows = [
      stage('converted', { order: 5 }),
      stage('member', { dormant: true, order: 6 }),
      stage('new_lead', { order: 1 }),
      stage('dormant', { dormant: true, order: 11 }),
      stage('first_class', { order: 2 }),
      stage('pack_member', { dormant: true, order: 7 }),
      stage('trial_done', { order: 4 }),
      stage('second_class', { order: 3 }),
      stage('classpass', { dormant: true, order: 8 }),
      stage('gympass', { dormant: true, order: 9 }),
      stage('cold_lead', { dormant: true, order: 10 }),
    ]
    const { funnel, offFunnel } = splitStagesByFunnel(rows)
    expect(funnel.map((s) => s.slug)).toEqual([...FUNNEL_STAGE_SLUGS])
    expect(offFunnel.map((s) => s.slug)).toEqual([...OFF_FUNNEL_STAGE_SLUGS])
  })

  it('drops archived stages (mirrors the web archived=false filter)', () => {
    const rows = [
      stage('new_lead', { order: 1 }),
      stage('old_stage', { order: 2, archived: true }),
      stage('member', { dormant: true, order: 3, archived: true }),
      stage('dormant', { dormant: true, order: 4 }),
    ]
    const { funnel, offFunnel } = splitStagesByFunnel(rows)
    expect(funnel.map((s) => s.slug)).toEqual(['new_lead'])
    expect(offFunnel.map((s) => s.slug)).toEqual(['dormant'])
  })

  it('falls back to taxonomy order when display_order is missing', () => {
    const rows = [
      stage('converted'),
      stage('trial_done'),
      stage('new_lead'),
      stage('cold_lead', { dormant: true }),
      stage('member', { dormant: true }),
    ]
    const { funnel, offFunnel } = splitStagesByFunnel(rows)
    expect(funnel.map((s) => s.slug)).toEqual(['new_lead', 'trial_done', 'converted'])
    expect(offFunnel.map((s) => s.slug)).toEqual(['member', 'cold_lead'])
  })

  it('rows with display_order sort ahead of rows without', () => {
    const rows = [
      stage('mystery_stage'),            // no order, unknown slug
      stage('converted', { order: 2 }),
      stage('new_lead', { order: 1 }),
    ]
    const { funnel } = splitStagesByFunnel(rows)
    expect(funnel.map((s) => s.slug)).toEqual(['new_lead', 'converted', 'mystery_stage'])
  })

  it('is defensive about garbage input', () => {
    expect(splitStagesByFunnel(null)).toEqual({ funnel: [], offFunnel: [], returning: [] })
    expect(splitStagesByFunnel(undefined)).toEqual({ funnel: [], offFunnel: [], returning: [] })
    expect(splitStagesByFunnel('nope')).toEqual({ funnel: [], offFunnel: [], returning: [] })
    expect(splitStagesByFunnel([null, undefined])).toEqual({ funnel: [], offFunnel: [], returning: [] })
  })

  it('does not mutate the input array', () => {
    const rows = [stage('converted', { order: 5 }), stage('new_lead', { order: 1 })]
    const snapshot = rows.map((r) => r.slug)
    splitStagesByFunnel(rows)
    expect(rows.map((r) => r.slug)).toEqual(snapshot)
  })
})
