// ORGCONTACTS.4 — the stage filter is per studio now (decision 3): the builder says so.
import { describe, it, expect } from 'vitest'
import { FIELD_OPTIONS, STAGE_LABELS, withStudioStages } from './AudienceBuilder.jsx'

describe('AudienceBuilder FIELD_OPTIONS — the stage field', () => {
  it('is labelled as the stage at this studio and offers is_null for "no stage here"', () => {
    const stage = FIELD_OPTIONS.find((o) => o.value === 'pipeline_stage_slug')
    expect(stage.label).toBe('Pipeline stage (at this studio)')
    expect(stage.hint).toMatch(/at this studio/i)
  })
})

describe('withStudioStages', () => {
  const cfg = FIELD_OPTIONS.find((o) => o.value === 'pipeline_stage_slug')

  it('makes a labelled-but-unlisted stage pickable, keeping its existing label', () => {
    expect(cfg.options).not.toContain('paid_trial_day_7')
    const out = withStudioStages(cfg, [{ slug: 'paid_trial_day_7', name: 'Day 7', board_name: 'Paid trial' }])
    expect(out.options).toContain('paid_trial_day_7')
    expect(out.valueLabels.paid_trial_day_7).toBe(STAGE_LABELS.paid_trial_day_7)
  })

  it('labels a stage the map does not know "<board>: <stage>" and skips an existing option', () => {
    const out = withStudioStages(cfg, [{ slug: 'my_stage', name: 'Mine', board_name: 'B' }, { slug: 'new_lead', name: 'X' }])
    expect(out.valueLabels.my_stage).toBe('B: Mine')
    expect(out.options.filter((o) => o === 'new_lead')).toHaveLength(1)
  })
})
