import { describe, it, expect } from 'vitest'
import { clientTrialBlock, trialStudioView } from './trial-studio-view'

const block = { eyebrow: 'e', heading: 'h', cta_label: 'Go', membership_id: 'm1', plan_code: 'p1', un1t_product_id: 'u1', tag: 't', studio_label: '' }
describe('clientTrialBlock', () => {
  it('keeps only the card words and resolves the refusal copy', () => {
    const out = clientTrialBlock(block)
    expect(out).toMatchObject({ eyebrow: 'e', heading: 'h', cta_label: 'Go' })
    for (const k of ['membership_id', 'plan_code', 'un1t_product_id', 'tag', 'studio_label']) expect(out).not.toHaveProperty(k)
    expect(typeof out.trial_used_text).toBe('string')
    expect(typeof out.help_cta_label).toBe('string')
  })
})
describe('trialStudioView', () => {
  const entry = { key: 'hatch', publicPath: 'hatch-street', locationId: 'loc', sellable: true, block, config: { provider: 'un1t_online', priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset' } }
  it('labels from the brand when studio_label is blank and marks the right provider sellable', () => {
    expect(trialStudioView(entry, { companyName: 'UN1T Hatch Street' })).toEqual({
      key: 'hatch', publicPath: 'hatch-street', label: 'UN1T Hatch Street', sellable: true, block: clientTrialBlock(block),
      priceCents: 3900, currency: 'EUR', durationDays: 14, productName: 'Reset',
    })
  })
  it('a Glofox-provider block at hatch is not sellable; no brand falls back to the studio name', () => {
    const v = trialStudioView({ ...entry, config: { ...entry.config, provider: 'glofox' } }, null)
    expect(v.sellable).toBe(false)
    expect(v.label).toBe('Hatch Street')
  })
})
