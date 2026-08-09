// SEQEXIT.1 — the Audience field's MEANING changed underneath operators.
//
// It used to be an entry gate; it is now re-checked before every step and
// a contact who stops matching leaves the sequence. Nothing about the
// field itself looks different, so the change has to be said out loud
// next to it or nobody can infer it.

import { describe, it, expect } from 'vitest'
import { AUDIENCE_CONTINUOUS_HINT } from './SequenceSettings.jsx'

describe('Audience conditions hint copy', () => {
  it('says the conditions are re-checked before every step', () => {
    expect(AUDIENCE_CONTINUOUS_HINT.toLowerCase()).toContain('before every step')
  })

  it('says a contact who stops matching leaves the sequence', () => {
    const copy = AUDIENCE_CONTINUOUS_HINT.toLowerCase()
    expect(copy).toContain('stops matching')
    expect(copy).toContain('leaves')
  })
})
