// PIPEBUILD.2e — which stages' cards carry signals: today's slug set for a
// code-built board, the stage's role for a configured one.
import { describe, it, expect } from 'vitest'
import { SIGNAL_SLUGS, stageShowsSignals } from './pipeline-card-signal-slugs.js'

describe('stageShowsSignals', () => {
  it('existingBoardsKeepSignalSet', () => {
    const slugs = [
      ...SIGNAL_SLUGS, 'converted', 'dormant', 'member', 'cold_lead', 'paid_trial_converted',
      'paid_trial_dormant', 'trial', 'whatever',
    ]
    for (const board of [{ board_type: null }, {}, null, undefined]) {
      for (const slug of slugs) {
        // Even a role stored on a code-built board's stage changes nothing.
        for (const stage of [{ slug }, { slug, stage_role: 'checkpoint' }, { slug, is_dormant: true }]) {
          expect(stageShowsSignals({ board, stage })).toBe(SIGNAL_SLUGS.has(slug))
        }
      }
    }
  })

  it('configuredBoardUsesRoles', () => {
    const board = { board_type: 'offer' }
    const at = (stage_role, slug = 'my_stage') => stageShowsSignals({ board, stage: { slug, stage_role } })
    for (const role of ['new', 'first_class', 'class_n', 'checkpoint', 'done']) expect(at(role)).toBe(true)
    for (const role of ['converted', 'pile', 'custom']) expect(at(role)).toBe(false)
    // no stored role: a dormant stage is the pile, anything else custom
    expect(stageShowsSignals({ board, stage: { slug: 'x', is_dormant: true } })).toBe(false)
    expect(stageShowsSignals({ board, stage: { slug: 'x', is_dormant: false } })).toBe(false)
  })
})
