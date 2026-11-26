// SEGGROUPS.1 — one level of filter groups.
import { describe, it, expect } from 'vitest'
import { applyAudienceFilter, stripUnsetFilterRows, isUnsetFilterRow, InvalidAudienceFilterError } from './audience-filter'

function rec() {
  const calls = []
  const q = new Proxy({}, {
    get: (_, name) => (...args) => { calls.push([name, ...args]); return q },
  })
  return { q, calls }
}

const stage = (v) => ({ field: 'pipeline_stage_slug', op: 'eq', value: v })

describe('filter groups (SEGGROUPS.1)', () => {
  it('top AND + OR group: members AND (stage a OR stage b)', () => {
    const { q, calls } = rec()
    applyAudienceFilter(q, { logic: 'and', filters: [
      { field: 'glofox_membership_status', op: 'eq', value: 'member' },
      { group: { logic: 'or', filters: [stage('dormant'), stage('rebook')] } },
    ] })
    expect(calls).toContainEqual(['eq', 'glofox_membership_status', 'member'])
    expect(calls).toContainEqual(['or', 'or(studio_stage_slug.eq.dormant,studio_stage_slug.eq.rebook)'])
  })

  it('top OR + AND group becomes one and() disjunct', () => {
    const { q, calls } = rec()
    applyAudienceFilter(q, { logic: 'or', filters: [
      stage('member'),
      { group: { logic: 'and', filters: [stage('rebook'), { field: 'total_emails_sent', op: 'gt', value: '3' }] } },
    ] })
    expect(calls).toEqual([['or', 'studio_stage_slug.eq.member,and(studio_stage_slug.eq.rebook,total_emails_sent.gt.3)']])
  })

  it('keeps the NULL-inclusive rules inside a group', () => {
    const { q, calls } = rec()
    applyAudienceFilter(q, { logic: 'and', filters: [
      { group: { logic: 'or', filters: [{ field: 'last_attended_at', op: 'days_since_gt', value: 30 }, stage('dormant')] } },
    ] })
    expect(calls[0][1]).toMatch(/^or\(or\(last_attended_at\.lt\..+,last_attended_at\.is\.null\),studio_stage_slug\.eq\.dormant\)$/)
  })

  it('validates rows inside a group exactly like top-level rows', () => {
    const { q } = rec()
    expect(() => applyAudienceFilter(q, { logic: 'and', filters: [
      { group: { logic: 'or', filters: [{ field: 'nope', op: 'eq', value: 1 }] } },
    ] })).toThrow(InvalidAudienceFilterError)
    expect(() => applyAudienceFilter(q, { logic: 'and', filters: [
      { group: { logic: 'or', filters: [{ field: 'last_attended_at', op: 'days_since_gt', value: '' }] } },
    ] })).toThrow(InvalidAudienceFilterError)
  })

  it('refuses virtual fields, nested groups and a bad group logic', () => {
    const { q } = rec()
    const bad = (group) => () => applyAudienceFilter(q, { logic: 'and', filters: [{ group }] })
    expect(bad({ logic: 'or', filters: [{ field: 'tag', op: 'eq', value: 'x' }] })).toThrow(InvalidAudienceFilterError)
    expect(bad({ logic: 'or', filters: [{ group: { logic: 'and', filters: [] } }] })).toThrow(InvalidAudienceFilterError)
    expect(bad({ logic: 'any', filters: [stage('x')] })).toThrow(InvalidAudienceFilterError)
  })

  it('an empty group, or one with only unset rows, adds nothing', () => {
    const { q, calls } = rec()
    applyAudienceFilter(q, { logic: 'and', filters: [{ group: { logic: 'or', filters: [{ field: '' }] } }] })
    expect(calls).toEqual([])
  })

  it('stripUnsetFilterRows strips inside groups and drops empty groups', () => {
    expect(isUnsetFilterRow({ group: { logic: 'or', filters: [] } })).toBe(false)
    expect(stripUnsetFilterRows({ logic: 'and', filters: [
      { group: { logic: 'or', filters: [{ field: '' }, stage('a')] } },
      { group: { logic: 'or', filters: [{ field: '' }] } },
      { field: '' },
    ] })).toEqual({ logic: 'and', filters: [{ group: { logic: 'or', filters: [stage('a')] } }] })
  })
})

import { audienceFilterSchema } from './schemas'
describe('audienceFilterSchema accepts one level of groups (SEGGROUPS.1)', () => {
  it('parses a group row and keeps it', () => {
    const f = { logic: 'and', filters: [stage('a'), { group: { logic: 'or', filters: [stage('b'), stage('c')] } }] }
    expect(audienceFilterSchema.parse(f)).toEqual(f)
  })
  it('rejects a group inside a group', () => {
    const f = { logic: 'and', filters: [{ group: { logic: 'or', filters: [{ group: { logic: 'and', filters: [] } }] } }] }
    expect(audienceFilterSchema.safeParse(f).success).toBe(false)
  })
})
