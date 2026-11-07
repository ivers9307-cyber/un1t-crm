import { describe, it, expect } from 'vitest'
import { parseOfferConfig, stageSlugFor, ENTRY_TYPES, boardKeyFor, BOARD_KEY_RE, moduleForMembershipSource } from './offer-config.js'

const KEY = 'o_reset'
const full = () => ({
  entry: { type: 'trial_purchase', values: [' RESET-14 ', ''], match: 'plan_code' },
  stages: [
    { role: 'new', slug: 'o_reset_new', name: 'New' },
    { role: 'first_class', slug: 'o_reset_first_class', name: '1st Class' },
    { role: 'class_n', slug: 'o_reset_class_3', name: '3rd Class', count: 3 },
    { role: 'checkpoint', slug: 'o_reset_day_7', name: 'Day 7', day: 7 },
    { role: 'done', slug: 'o_reset_done', name: 'Done' },
    { role: 'converted', slug: 'o_reset_converted', name: 'Converted' },
  ],
  duration_days: 21,
  mia_notes: 'Be warm.',
})

describe('parseOfferConfig', () => {
  it('parsesFullConfig', () => {
    const r = parseOfferConfig(full(), { boardKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.config.entry).toEqual({ type: 'trial_purchase', values: ['RESET-14'], match: 'plan_code' })
    expect(r.config.stages.map((s) => s.slug)).toEqual(['o_reset_new', 'o_reset_first_class', 'o_reset_class_3', 'o_reset_day_7', 'o_reset_done', 'o_reset_converted'])
    expect(r.config.duration_days).toBe(21)
    expect(r.config.quiet_days).toBe(60)
    expect(r.config.converted_window_days).toBe(60)
    expect(r.config.mia_notes).toBe('Be warm.')
  })

  it('defaults and lower-cases non-trial values', () => {
    const r = parseOfferConfig({ entry: { type: 'tag', values: ['  VIP '] }, stages: [{ role: 'new', slug: 'o_reset_new', name: 'New' }] }, { boardKey: KEY })
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
    expect(bad((c) => c.stages.push({ role: 'new', slug: 'o_reset_new', name: 'Again' }))).toMatch(/exactly one new/)
    expect(bad((c) => { c.entry.type = 'nonsense' })).toMatch(/entry.type/)
    expect(bad((c) => { c.stages[1].slug = 'wrong' })).toMatch(/slug must be o_reset_first_class/)
    expect(bad((c) => { c.stages[3].day = 0; c.stages[3].slug = 'o_reset_day_0' })).toMatch(/checkpoint needs/)
    expect(bad((c) => { c.stages.push({ role: 'pile', slug: 'o_reset_pile', name: 'P' }) })).toMatch(/role must be one of/)
    expect(bad((c) => { c.stages.push({ role: 'done', slug: 'o_reset_done', name: 'D2' }) })).toMatch(/at most one done/)
    expect(bad((c) => { delete c.entry.match })).toMatch(/entry.match/)
    expect(bad((c) => { c.duration_days = 400 })).toMatch(/duration_days/)
    expect(bad((c) => { c.mia_notes = 'x'.repeat(1001) })).toMatch(/mia_notes/)
    expect(parseOfferConfig(null, { boardKey: KEY }).ok).toBe(false)
  })

  it('refusesRepeatedStageNamesTrimmedAnyCase', () => {
    // pipeline_stages_pipeline_name_unique (mig 597): one name per board.
    const c = full()
    c.stages[4].name = '  day 7 '
    const r = parseOfferConfig(c, { boardKey: KEY })
    expect(r.ok).toBe(false)
    expect(r.errors).toContain('stages[4] repeats the name day 7')
    // Distinct names pass.
    expect(parseOfferConfig(full(), { boardKey: KEY }).ok).toBe(true)
  })

  it('exposes the entry types including un1t_product', () => {
    expect(ENTRY_TYPES).toEqual(['trial_purchase', 'corp_promo', 'lead_source', 'glofox_plan', 'tag', 'un1t_product'])
  })

  const BASE = { stages: [{ role: 'new', slug: 'o_x_new', name: 'New' }] }
  it('un1t_product keeps case and is allowed on offer_un1t', () => {
    const r = parseOfferConfig({ ...BASE, entry: { type: 'un1t_product', values: ['AbC123'] } }, { boardKey: 'o_x', module: 'offer_un1t' })
    expect(r.ok).toBe(true)
    expect(r.config.entry).toEqual({ type: 'un1t_product', values: ['AbC123'] })
  })
  it('refuses un1t_product on an offer board and lead_source on an offer_un1t board', () => {
    expect(parseOfferConfig({ ...BASE, entry: { type: 'un1t_product', values: ['a'] } }, { boardKey: 'o_x', module: 'offer' }).ok).toBe(false)
    const r = parseOfferConfig({ ...BASE, entry: { type: 'lead_source', values: ['meta'] } }, { boardKey: 'o_x', module: 'offer_un1t' })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('does not work at this studio')
  })
  it('moduleForMembershipSource', () => {
    expect(moduleForMembershipSource('un1t_online')).toBe('offer_un1t')
    expect(moduleForMembershipSource('un1t')).toBe('offer_un1t')
    expect(moduleForMembershipSource('glofox')).toBe('offer')
    expect(moduleForMembershipSource('none')).toBe('offer')
  })
})

describe('stageSlugFor', () => {
  it('stageSlugs', () => {
    expect(stageSlugFor('b', 'new')).toBe('b_new')
    expect(stageSlugFor('b', 'converted')).toBe('b_converted')
    expect(stageSlugFor('b', 'class_n', { count: 4 })).toBe('b_class_4')
    expect(stageSlugFor('b', 'checkpoint', { day: 10 })).toBe('b_day_10')
  })

  it('requiresOPrefixedKey', () => {
    expect(parseOfferConfig(full(), { boardKey: 'reset' }).errors).toContain('boardKey must look like o_name')
    expect(parseOfferConfig(full(), { boardKey: 'o_reset' }).ok).toBe(true)
    expect(BOARD_KEY_RE.test('o_' + 'a'.repeat(41))).toBe(false)
    expect(BOARD_KEY_RE.test('o_Reset')).toBe(false)
  })

  it('boardKeyForSlugifiesAndDedupes', () => {
    expect(boardKeyFor('14 Day Reset!', new Set())).toBe('o_14_day_reset')
    expect(boardKeyFor('14 Day Reset', new Set(['o_14_day_reset']))).toBe('o_14_day_reset_2')
    expect(boardKeyFor('14 Day Reset', new Set(['o_14_day_reset', 'o_14_day_reset_2']))).toBe('o_14_day_reset_3')
    expect(boardKeyFor('!!!', new Set())).toBe('o_board')
    const long = boardKeyFor('x'.repeat(80), new Set())
    expect(long).toHaveLength(38)
    expect(BOARD_KEY_RE.test(boardKeyFor('x'.repeat(80), new Set([long])))).toBe(true)
  })

  it('acceptsOfferNameAndSigner', () => {
    const r = parseOfferConfig({ ...full(), offer_name: '  14 Day Reset ', signer: ' Garrett ' }, { boardKey: KEY })
    expect(r.ok).toBe(true)
    expect(r.config).toMatchObject({ offer_name: '14 Day Reset', signer: 'Garrett' })
    expect(parseOfferConfig(full(), { boardKey: KEY }).config).not.toHaveProperty('offer_name')
    expect(parseOfferConfig({ ...full(), offer_name: 'x'.repeat(61) }, { boardKey: KEY }).errors).toContain('offer_name must be 60 characters or fewer')
    expect(parseOfferConfig({ ...full(), signer: 'x'.repeat(41) }, { boardKey: KEY }).errors).toContain('signer must be 40 characters or fewer')
  })
})
