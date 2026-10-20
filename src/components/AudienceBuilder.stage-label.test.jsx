// ORGCONTACTS.4 — the stage filter is per studio now (decision 3): the builder says so.
import { describe, it, expect } from 'vitest'
import { FIELD_OPTIONS } from './AudienceBuilder.jsx'

describe('AudienceBuilder FIELD_OPTIONS — the stage field', () => {
  it('is labelled as the stage at this studio and offers is_null for "no stage here"', () => {
    const stage = FIELD_OPTIONS.find((o) => o.value === 'pipeline_stage_slug')
    expect(stage.label).toBe('Pipeline stage (at this studio)')
    expect(stage.hint).toMatch(/at this studio/i)
  })
})
