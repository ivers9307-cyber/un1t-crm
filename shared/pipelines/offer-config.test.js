import { describe, it, expect } from 'vitest'
import { parseOfferConfig, stageSlugFor, ENTRY_TYPES } from './offer-config.js'

const KEY = 'reset'
const full = () => ({
  entry: { type: 'trial_purchase', values: [' RESET-14 ', ''], match: 'plan_code' },
  stages: [
    { role: 'new', slug: 'reset_new', name: 'New' },
    { role: 'first_class', slug: 'reset_first_class', name: '1st Class' },
    { role: 'class_n', slug: 'reset_class_3', name: '3rd Class', count: 3 },
    { role: 'checkpoint', slug: 'reset_day_7', name: 'Day 7', day: 7 },
    { role: 'done', slug: 'reset_done', name: 'Done' },
    { role: 'converted', slug: 'reset_converted', name: 'Converted' },
  ],
  duration_days: 21,
  mia_notes: 'Be warm.',
})

describe('parseOfferConfig', () => {
  it('parsesFullConfig', () => {
    const r = parseOfferConfig(full(), { boardKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.config.entry).toEqual({ type: 'trial_purchase', values: ['RESET-14'], match: 'plan_code' })
    expect(r.config.stages.map((s) => s.slug)).toEqual(['reset_new', 'reset_first_class', 'reset_class_3', 'reset_day_7', 'reset_done', 'reset_converted'])
    expect(r.config.duration_days).toBe(21)
    expect(r.config.quiet_days).toBe(60)
    expect(r.config.converted_window_days).toBe(60)
    expect(r.config.mia_notes).toBe('Be warm.')
  })

  it('defaults and lower-cases non-trial values', () => {
    const r = parseOfferConfig({ entry: { type: 'tag', values: ['  VIP '] }, stages: [{ role: 'new', slug: 'reset_new', name: 'New' }] }, { boardKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.config.entry).toEqual({ type: 'tag', values: ['vip'] })
    expect(r.config.duration_days).toBe(14)
    expect(r.config.mia_notes).toBeUndefined()
  })

  it('rejectsBadConfig', () => {
    const bad = (mut) => {
      const c = full(); mut(c)
      const r = parseOfferConfig(c, { boardKey: KEY })
      expect(r.ok).toBe(false)
      return r.errors.join('|')
    }
    expect(bad((c) => c.stages.push({ role: 'new', slug: 'reset_new', name: 'Again' }))).toMatch(/exactly one new/)
    expect(bad((c) => { c.entry.type = 'nonsense' })).toMatch(/entry.type/)
    expect(bad((c) => { c.entry.type = 'un1t_product' })).toMatch(/entry.type/)
    expect(bad((c) => { c.stages[1].slug = 'wrong' })).toMatch(/slug must be reset_first_class/)
    expect(bad((c) => { c.stages[3].day = 0; c.stages[3].slug = 'reset_day_0' })).toMatch(/checkpoint needs/)
    expect(bad((c) => { c.stages.push({ role: 'pile', slug: 'reset_pile', name: 'P' }) })).toMatch(/role must be one of/)
    expect(bad((c) => { c.stages.push({ role: 'done', slug: 'reset_done', name: 'D2' }) })).toMatch(/at most one done/)
    expect(bad((c) => { delete c.entry.match })).toMatch(/entry.match/)
    expect(bad((c) => { c.duration_days = 400 })).toMatch(/duration_days/)
    expect(bad((c) => { c.mia_notes = 'x'.repeat(1001) })).toMatch(/mia_notes/)
    expect(parseOfferConfig(null, { boardKey: KEY }).ok).toBe(false)
  })

  it('exposes the entry types without un1t_product', () => {
    expect(ENTRY_TYPES).toEqual(['trial_purchase', 'corp_promo', 'lead_source', 'glofox_plan', 'tag'])
  })
})

describe('stageSlugFor', () => {
  it('stageSlugs', () => {
    expect(stageSlugFor('b', 'new')).toBe('b_new')
    expect(stageSlugFor('b', 'converted')).toBe('b_converted')
    expect(stageSlugFor('b', 'class_n', { count: 4 })).toBe('b_class_4')
    expect(stageSlugFor('b', 'checkpoint', { day: 10 })).toBe('b_day_10')
  })
})
